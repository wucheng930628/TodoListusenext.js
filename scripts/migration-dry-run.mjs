import { readFileSync, writeFileSync, renameSync, realpathSync, existsSync, mkdtempSync, unlinkSync, openSync, closeSync } from "node:fs";
import { dirname, basename, resolve, relative, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID, randomBytes } from "node:crypto";
import { CreateTableCommand, DeleteTableCommand, DescribeTableCommand, waitUntilTableExists, waitUntilTableNotExists } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DataError, requireValue } from "../src/lib/data-model.mjs";
import { sealBackup } from "../src/lib/client/verified-backup.mjs";
import { captureWorkspaceBackup } from "../src/lib/client/workspace-backup.mjs";
import { prepareDryRun, executeDryRun, assertDryRunTable, boundDryRunClient, dryRunProofId, dryRunOwnerHash } from "../src/lib/migration/dry-run.mjs";

const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
const inside = (parent, child) => { const path = relative(parent, child); return path === "" || (!path.startsWith("..") && !isAbsolute(path)); };
const safeCode = error => /^[A-Z_]{1,64}$/.test(error?.code || "") ? error.code : "DRY_RUN_FAILED";

function privatePath(input, existing = false) {
  requireValue(typeof input === "string" && isAbsolute(input), "Absolute private file path required", "PRIVATE_PATH_REQUIRED");
  const path = existing ? realpathSync(input) : join(realpathSync(dirname(input)), basename(input));
  requireValue(!inside(workspaceRoot, path), "Private files must stay outside the workspace", "PRIVATE_PATH_REQUIRED");
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    requireValue(!existsSync(join(parent, ".git")), "Private files cannot be inside a Git worktree", "PRIVATE_PATH_REQUIRED");
    if (parent === dirname(parent)) break;
  }
  return path;
}

function argumentsFrom(argv) {
  const booleans = new Set(["--synthetic", "--resume", "--cleanup", "--confirm-dry-run", "--preview-only", "--exercise-response-loss"]);
  const values = new Set(["--backup", "--confirm-backup", "--state", "--confirm-cleanup", "--stop-after", "--legacy-board", "--source-policy"]);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    requireValue(!Object.hasOwn(args, name) && (booleans.has(name) || values.has(name)), "Unknown or duplicate option");
    args[name] = booleans.has(name) ? true : argv[++i];
    requireValue(args[name] !== undefined && args[name] !== "", "Option value required");
  }
  return args;
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2));
  const synthetic = args["--synthetic"] === true;
  requireValue(!synthetic || (!args["--backup"] && !args["--confirm-backup"] && !args["--legacy-board"] && !args["--source-policy"]), "Synthetic and real backup inputs cannot be mixed");
  requireValue(synthetic || args["--cleanup"] || (args["--backup"] && /^[a-f0-9]{64}$/.test(args["--confirm-backup"] || "")), "An explicitly selected backup and fingerprint are required", "BACKUP_CONFIRMATION_REQUIRED");
  requireValue(synthetic || args["--cleanup"] || args["--preview-only"] || args["--confirm-dry-run"], "Dry-run write confirmation required", "DRY_RUN_CONFIRMATION_REQUIRED");
  requireValue(synthetic || (!args["--stop-after"] && !args["--exercise-response-loss"]), "Fault injection is synthetic-only");
  requireValue(!args["--stop-after"] || /^(REGISTERING|MIGRATING|RELEASING):[1-9]\d*$/.test(args["--stop-after"]), "Invalid interruption checkpoint");
  requireValue(!args["--stop-after"] || args["--state"], "Interruption tests require an explicit state path");
  const statePath = args["--state"] ? privatePath(args["--state"], existsSync(args["--state"]))
    : synthetic ? join(mkdtempSync(join(tmpdir(), "slowly-dry-run-")), "state.json") : null;
  requireValue(statePath, "A private state file is required", "PRIVATE_PATH_REQUIRED");
  const resuming = args["--resume"] || args["--cleanup"];
  requireValue(resuming ? existsSync(statePath) : !existsSync(statePath), "Use an existing state only with explicit resume", "STATE_CONFLICT");
  let state = resuming ? JSON.parse(readFileSync(statePath, "utf8")) : {
    format: "slowly-dry-run-state", formatVersion: 1, runId: randomUUID(), ownerSecret: randomBytes(32).toString("hex"),
    createdAt: new Date().toISOString(), synthetic, created: false, cleaned: false, stage: "PREVIEW",
  };
  state.tableName ??= `Slowly_DryRun_${state.runId.replaceAll("-", "")}`;
  requireValue(state.format === "slowly-dry-run-state" && state.formatVersion === 1 && /^[a-f0-9]{64}$/.test(state.ownerSecret || "") &&
    state.cleaned === false && (args["--cleanup"] || state.synthetic === synthetic), "Invalid or closed state", "STATE_CONFLICT");
  assertDryRunTable(state.tableName, state.runId);
  const lockPath = `${statePath}.lock`;
  if (existsSync(lockPath) && resuming) {
    const prior = JSON.parse(readFileSync(lockPath, "utf8"));
    requireValue(prior.runId === state.runId && Number.isSafeInteger(prior.pid) && prior.pid > 0, "Lock ownership needs review", "STATE_CONFLICT");
    let alive = true;
    try { process.kill(prior.pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; }
    requireValue(!alive, "Another run may still be active", "STATE_CONFLICT");
    unlinkSync(lockPath);
  }
  const lock = openSync(lockPath, "wx"); closeSync(lock);
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, runId: state.runId }));
  let stateWritten = Boolean(resuming);
  const save = () => {
    if (!stateWritten) {
      writeFileSync(statePath, JSON.stringify(state, null, 2), { flag: "wx", mode: 0o600 });
      stateWritten = true;
      return;
    }
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2), { flag: "wx", mode: 0o600 });
    renameSync(temporary, statePath);
  };
  let client;
  let prepared;
  try {
    if (!args["--cleanup"]) {
      let artifact;
      if (synthetic) {
        const { workspaceFixture, storageFixture } = await import("../tests/phase4a-fixtures.mjs");
        const source = workspaceFixture();
        source.boards[0].tasks[0].status = "done"; source.boards[0].tasks[0].completedAt = "2026-11-12T01:02:03.456Z";
        source.boards[0].widgets[0] = { ...source.boards[0].widgets[0], type: "timer", config: { minutes: 25, remaining: 23, endsAt: 1794640000000, taskId: "task-a" } };
        delete source.boards[1].widgets;
        source.boards.push({ id: "empty-board", name: "Empty", description: "", wipLimit: 4, tasks: [], widgets: [] });
        const backup = captureWorkspaceBackup({ storage: storageFixture({ "slowly-workspace-v2": JSON.stringify(source) }), createdAt: state.createdAt });
        artifact = await sealBackup(backup, "http://127.0.0.1:3000");
      } else {
        const backupPath = privatePath(args["--backup"], true);
        requireValue(backupPath !== statePath && backupPath !== lockPath, "Backup and state must be separate files");
        artifact = readFileSync(backupPath, "utf8");
      }
      let policies;
      if (args["--legacy-board"]) policies = { legacyBoard: JSON.parse(readFileSync(privatePath(args["--legacy-board"], true), "utf8")) };
      if (args["--source-policy"]) policies = { ...policies, sourcePolicy: JSON.parse(readFileSync(privatePath(args["--source-policy"], true), "utf8")) };
      prepared = await prepareDryRun(artifact, { sourceNamespace: `dryrun-${state.runId}`, ...(policies ? { policies } : {}) });
      requireValue(synthetic || prepared.report.backupFingerprint === args["--confirm-backup"], "Fingerprint confirmation does not match", "BACKUP_CONFIRMATION_REQUIRED");
      if (resuming) requireValue(state.backupFingerprint === prepared.report.backupFingerprint && state.planId === prepared.report.planId, "Source changed since the interrupted run", "STATE_CONFLICT");
      if (!prepared.valid || args["--preview-only"]) {
        console.log(JSON.stringify({ ...prepared.report, status: "NOT READY", dryRunPassed: false, previewPassed: prepared.valid, tableCreated: state.created }));
        if (!prepared.valid) process.exitCode = 1;
        return;
      }
      Object.assign(state, { backupFingerprint: prepared.report.backupFingerprint, planId: prepared.plan.planId, stage: "PREPARED" });
      save();
    }
    // Dedicated local client uses dummy credentials. Existing table/environment selection is never consulted.
    client = new DynamoDBClient({ endpoint: "http://127.0.0.1:9000", region: "ap-northeast-1", credentials: { accessKeyId: "local", secretAccessKey: "local" }, maxAttempts: 2 });
    client.middlewareStack.add(next => async request => {
      const input = request.input;
      const tables = input.TransactItems ? input.TransactItems.map(action => (action.Put || action.Delete || action.ConditionCheck || action.Update).TableName) : [input.TableName];
      requireValue(tables.length > 0 && tables.every(name => name === state.tableName), "Database request outside owned dry-run table", "DRY_RUN_SCOPE");
      return next(request);
    }, { step: "initialize", name: "dryRunTableBoundary" });
    const document = DynamoDBDocumentClient.from(client);
    const db = boundDryRunClient(document, state.tableName, state.runId);
    const readProof = async () => (await db.send(new GetCommand({ TableName: state.tableName, Key: { id: dryRunProofId(state.runId) }, ConsistentRead: true }))).Item;
    const assertOwnership = async () => {
      const proof = await readProof();
      requireValue(state.created === true && proof?.entityType === "DRY_RUN_CONTROL" && proof.runId === state.runId &&
        proof.ownerHash === dryRunOwnerHash(state.ownerSecret) && proof.backupFingerprint === state.backupFingerprint && proof.planId === state.planId,
      "Cannot prove ownership of test table", "DRY_RUN_SCOPE");
    };
    const cleanup = async () => {
      assertDryRunTable(state.tableName, state.runId);
      if (state.stage === "CLEANING" && state.cleanupProofChecked === true) {
        try { await client.send(new DescribeTableCommand({ TableName: state.tableName })); }
        catch (error) {
          if (error.name !== "ResourceNotFoundException") throw error;
          state.cleaned = true; state.stage = "CLEANED"; save(); return;
        }
      }
      await assertOwnership();
      state.stage = "CLEANING"; state.cleanupProofChecked = true; save();
      await client.send(new DeleteTableCommand({ TableName: state.tableName }));
      await waitUntilTableNotExists({ client, maxWaitTime: 30 }, { TableName: state.tableName });
      state.cleaned = true; state.stage = "CLEANED"; save();
    };
    if (args["--cleanup"]) {
      requireValue(args["--confirm-cleanup"] === state.runId, "Exact run ID cleanup confirmation required");
      await cleanup();
      console.log(JSON.stringify({ runId: state.runId, tableName: state.tableName, cleaned: true }));
      return;
    }
    if (!resuming) {
      state.stage = "CREATING"; save();
      await client.send(new CreateTableCommand({ TableName: state.tableName, BillingMode: "PAY_PER_REQUEST", KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }, { AttributeName: "gsi1pk", AttributeType: "S" }, { AttributeName: "gsi1sk", AttributeType: "S" }],
        GlobalSecondaryIndexes: [{ IndexName: "SlowlyByParent", KeySchema: [{ AttributeName: "gsi1pk", KeyType: "HASH" }, { AttributeName: "gsi1sk", KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" } }] }));
      state.created = true; save();
      await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: state.tableName });
      await db.send(new PutCommand({ TableName: state.tableName, Item: { id: dryRunProofId(state.runId), entityType: "DRY_RUN_CONTROL", runId: state.runId,
        ownerHash: dryRunOwnerHash(state.ownerSecret), backupFingerprint: state.backupFingerprint, planId: state.planId }, ConditionExpression: "attribute_not_exists(id)" }));
    }
    await assertOwnership();
    let injectLoss = args["--exercise-response-loss"] === true;
    const transport = { async send(command) {
      const result = await db.send(command);
      if (injectLoss && command.input.TransactItems?.some(action => action.Put?.Item.migrationOwner)) {
        injectLoss = false; throw new Error("Synthetic response loss after commit");
      }
      return result;
    } };
    const report = await executeDryRun({ prepared, db: transport, tableName: state.tableName, runId: state.runId, ownerSecret: state.ownerSecret,
      checkpoint: async progress => {
        state.stage = progress.stage; state.progress = progress;
        if (progress.stage === "VERIFIED") state.verifyPassed = true;
        save();
        if (args["--stop-after"] === `${progress.stage}:${progress.completed ?? progress.registered}`) throw new DataError("DRY_RUN_INTERRUPTED", "Synthetic interruption");
      } });
    if (synthetic) report.blockers.push({ code: "REAL_BACKUP_DRY_RUN_PENDING" });
    report.resumed = Boolean(resuming);
    if (state.errorCode) { state.previousErrorCode = state.errorCode; delete state.errorCode; }
    state.report = report; save(); await cleanup();
    console.log(JSON.stringify({ runId: state.runId, tableName: state.tableName, synthetic, inputMode: synthetic ? "generated-test-data" : "user-selected-file", ...report, cleaned: state.cleaned }));
  } catch (error) {
    state.errorCode = safeCode(error); state.status = "NOT READY";
    const report = { ...prepared?.report, runId: state.runId, tableName: state.tableName, status: "NOT READY", dryRunPassed: false,
      formalCutoverAuthorized: false, code: state.errorCode, blockers: [...prepared?.report.blockers || [], { code: state.errorCode }],
      verifyPassed: state.verifyPassed ?? null, releasePassed: state.report?.releasePassed ?? null, targetCounts: state.report?.targetCounts ?? null,
      differences: state.errorCode === "INTEGRITY_CONFLICT" ? [{ code: "DATA_OR_OWNERSHIP_MISMATCH" }] : [],
      tableCreated: state.created, cleaned: state.cleaned, resumable: state.created === true && !state.cleaned };
    state.report = report;
    if (existsSync(statePath)) save();
    console.log(JSON.stringify(report));
    process.exitCode = 1;
  } finally { client?.destroy(); unlinkSync(lockPath); }
}

main().catch(error => { console.log(JSON.stringify({ status: "NOT READY", code: safeCode(error) })); process.exitCode = 1; });
