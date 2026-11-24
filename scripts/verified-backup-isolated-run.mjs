// Explicitly authorized, one-off Local dry run. Never uses application environment credentials.
import { readFileSync, writeFileSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { DynamoDBClient, ListTablesCommand, CreateTableCommand, DescribeTableCommand, DeleteTableCommand, waitUntilTableExists, waitUntilTableNotExists } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { verifyBackupArtifact, sealBackup } from "../src/lib/client/verified-backup.mjs";
import { captureWorkspaceBackup } from "../src/lib/client/workspace-backup.mjs";
import { prepareDryRun, executeDryRun, assertDryRunTable, boundDryRunClient, dryRunProofId, dryRunOwnerHash } from "../src/lib/migration/dry-run.mjs";
import { createMigrationService } from "../src/lib/migration/service.mjs";
import { migrationPlanV2, hash, restoreWorkspace } from "../src/lib/migration/plan-v2.mjs";
import { createRepository } from "../src/lib/slowly-repository.mjs";
import { createApi } from "../src/lib/api/handlers.mjs";
import { createWorkspaceViewApi } from "../src/lib/api/workspace-view.mjs";
import { createSlowlyApi } from "../src/lib/client/slowly-api.mjs";
import { projectMainView } from "../src/lib/client/main-view-model.mjs";
import { workspaceFixture, storageFixture, createdAt } from "../tests/phase4a-fixtures.mjs";

const endpoint = "http://127.0.0.1:9000";
const sha = data => createHash("sha256").update(data).digest("hex");
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const safeCode = error => /^[A-Z_]{1,80}$/.test(error.code || "") ? error.code : "ISOLATED_RUN_FAILED";
const args = process.argv.slice(2);
check(args.length === 5 && args[0] === "--confirm-isolated-real-backup" && isAbsolute(args[1]) && /^[a-f0-9]{64}$/.test(args[2]) && /^[a-f0-9]{64}$/.test(args[3]) && /^[a-zA-Z0-9._-]{8,128}$/.test(args[4]), "EXPLICIT_INPUT_REQUIRED");
const backupPath = realpathSync(args[1]);
const repoRoot = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const pathWithinRepo = relative(repoRoot, backupPath);
check(pathWithinRepo.startsWith("..") || isAbsolute(pathWithinRepo), "BACKUP_MUST_STAY_PRIVATE");
const runId = randomUUID(); const tableName = `Slowly_DryRun_${runId.replaceAll("-", "")}`;
assertDryRunTable(tableName, runId);
const folder = mkdtempSync(join(tmpdir(), "slowly-verified-isolated-"));
const journalPath = join(folder, "journal.json"); const reportPath = join(folder, "report.json");
const ownerSecret = randomBytes(32).toString("hex");
const state = { runId, tableName, endpoint, ownerSecret, created: false, cleanupAuthorized: false, cleaned: false, stage: "PREFLIGHT" };
const report = { runId, tableName, endpoint, reportPath, checks: [], created: false, cleaned: false, formalMigrationAuthorized: false };
const save = () => { writeFileSync(journalPath, JSON.stringify(state, null, 2), { mode: 0o600 }); writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 }); };
const passed = name => { report.checks.push({ name, passed: true }); save(); };
const rejects = async (action, code) => { try { await action(); } catch (error) { check(error.code === code, "UNEXPECTED_REJECTION"); return; } throw Object.assign(new Error(), { code: "EXPECTED_REJECTION_MISSING" }); };
const sourcePolicy = { primary: "slowly-workspace-v2", legacy: { source: "slowly-board-v1", action: "exclude", acknowledged: true } };
let client; let db; let proof; let sourceFileHash;
save();
try {
  const file = readFileSync(backupPath); sourceFileHash = sha(file);
  const artifact = JSON.parse(file.toString("utf8")); const verified = await verifyBackupArtifact(artifact);
  const prepared = await prepareDryRun(artifact, { sourceNamespace: args[4], policies: { sourcePolicy } });
  check(verified.fingerprint === args[2] && prepared.plan?.planId === args[3] && prepared.valid, "REVIEWED_INPUT_MISMATCH");
  check(prepared.plan.operations.length === 10 && hash(prepared.plan.counts) === hash({ workspaces: 1, boards: 2, tasks: 6, widgets: 1, subtasks: 0 }), "UNEXPECTED_BUSINESS_COUNTS");
  check(hash(prepared.plan.sourceBinding.sourcePolicy) === hash(sourcePolicy) && prepared.plan.sourceBinding.exclusionSummary.excluded.tasks === 2, "SOURCE_POLICY_MISMATCH");
  Object.assign(state, { backupFingerprint: verified.fingerprint, planId: prepared.plan.planId });
  Object.assign(report, { backupFingerprint: verified.fingerprint, planId: prepared.plan.planId, sourcePolicy, exclusionSummary: prepared.plan.sourceBinding.exclusionSummary });
  passed("Exact backup SHA-256, reviewed Plan ID, policy and counts");

  client = new DynamoDBClient({ endpoint, region: "ap-northeast-1", credentials: { accessKeyId: "local", secretAccessKey: "local" }, maxAttempts: 1,
    requestHandler: { connectionTimeout: 3000, requestTimeout: 15000 } });
  const configured = await client.config.endpoint();
  check(configured.protocol === "http:" && configured.hostname === "127.0.0.1" && configured.port === 9000, "LOCAL_ENDPOINT_REQUIRED");
  const databaseTables = new Set();
  client.middlewareStack.add((next, context) => async request => {
    if (context.commandName !== "ListTablesCommand") {
      const input = request.input;
      const tables = input.TransactItems ? input.TransactItems.map(action => (action.Get || action.Put || action.Delete || action.ConditionCheck || action.Update).TableName) : [input.TableName];
      check(tables.length > 0 && tables.every(name => name === tableName && name !== "SlowlyTasks"), "DATABASE_SCOPE_VIOLATION");
      tables.forEach(name => databaseTables.add(name));
    }
    return next(request);
  }, { step: "initialize", name: "verifiedRunTableBoundary" });
  const tableNames = async () => {
    const names = []; let cursor;
    do { const page = await client.send(new ListTablesCommand({ ExclusiveStartTableName: cursor })); names.push(...page.TableNames); cursor = page.LastEvaluatedTableName; } while (cursor);
    return names.sort();
  };
  const originalNames = await tableNames(); check(!originalNames.includes(tableName) && originalNames.includes("SlowlyTasks"), "ISOLATION_PREFLIGHT_FAILED");
  try { await client.send(new DescribeTableCommand({ TableName: tableName })); check(false, "TEST_TABLE_ALREADY_EXISTS"); }
  catch (error) { check(error.name === "ResourceNotFoundException", "TEST_TABLE_NOT_FRESH"); }
  check(sha(readFileSync(backupPath)) === sourceFileHash, "BACKUP_CHANGED");
  passed("Local endpoint, explicit dummy credentials, new table absence and scope boundary");
  state.stage = "CREATING"; save();
  await client.send(new CreateTableCommand({ TableName: tableName, BillingMode: "PAY_PER_REQUEST", KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }, { AttributeName: "gsi1pk", AttributeType: "S" }, { AttributeName: "gsi1sk", AttributeType: "S" }],
    GlobalSecondaryIndexes: [{ IndexName: "SlowlyByParent", KeySchema: [{ AttributeName: "gsi1pk", KeyType: "HASH" }, { AttributeName: "gsi1sk", KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" } }] }));
  state.created = true; report.created = true; save();
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
  const description = (await client.send(new DescribeTableCommand({ TableName: tableName }))).Table;
  check(description.TableStatus === "ACTIVE" && description.GlobalSecondaryIndexes?.[0].IndexStatus === "ACTIVE", "INDEX_NOT_READY");
  db = boundDryRunClient(DynamoDBDocumentClient.from(client), tableName, runId);
  const empty = await db.send(new ScanCommand({ TableName: tableName, ConsistentRead: true, Limit: 1, Select: "COUNT" }));
  check(empty.Count === 0 && !empty.LastEvaluatedKey, "TEST_TABLE_NOT_EMPTY");
  proof = { id: dryRunProofId(runId), entityType: "DRY_RUN_CONTROL", runId, ownerHash: dryRunOwnerHash(ownerSecret), backupFingerprint: args[2], planId: args[3] };
  await db.send(new PutCommand({ TableName: tableName, Item: proof, ConditionExpression: "attribute_not_exists(id)" }));
  passed("New ACTIVE table and GSI verified empty before first item write");
  const realReport = await executeDryRun({ prepared, db, tableName, runId, ownerSecret, checkpoint: async progress => { state.stage = progress.stage; state.progress = progress; save(); } });
  check(realReport.dryRunPassed && realReport.verifyPassed && realReport.releasePassed && realReport.differences.length === 0, "REAL_DRY_RUN_FAILED");
  report.migration = realReport; passed("10 business items migrated, persistent receipts, Verify and atomic Release");
  const service = createMigrationService(db, { tableName }); const repository = createRepository(db, { tableName });
  const items = await Promise.all(prepared.plan.operations.map(async op => (await db.send(new GetCommand({ TableName: tableName, Key: { id: op.targetId }, ConsistentRead: true }))).Item));
  const restored = restoreWorkspace(items);
  check(hash(restored) === hash(prepared.workspace), "FULL_FIDELITY_MISMATCH");
  report.fidelity = {
    fullWorkspaceExact: true,
    mappingAndParents: items.every((item, i) => item.id === prepared.plan.operations[i].targetId && item.parentId === (prepared.plan.operations[i].parentId ?? undefined) && hash(item.data.id ?? null) === hash(prepared.plan.operations[i].data.id ?? null)),
    positions: items.every((item, i) => item.position === prepared.plan.operations[i].position),
    schemaVersion: items.every(item => item.schemaVersion === 1),
    taskFieldsAndUnknownFields: hash(restored.boards.map(board => board.tasks)) === hash(prepared.workspace.boards.map(board => board.tasks)),
    widgetPresenceAndAllFields: hash(restored.boards.map(board => ({ present: Object.hasOwn(board, "widgets"), widgets: board.widgets ?? null }))) === hash(prepared.workspace.boards.map(board => ({ present: Object.hasOwn(board, "widgets"), widgets: board.widgets ?? null }))),
    boardAndWorkspaceSettings: true, differences: []
  };
  check(Object.values(report.fidelity).every(value => value !== false), "FIDELITY_CHECK_FAILED");
  const origin = "http://127.0.0.1:3000"; const configuration = () => ({ NODE_ENV: "development", SLOWLY_LOCAL_API: "1" });
  const viewHandler = createWorkspaceViewApi({ getRepository: async () => repository, getMigrationService: async () => service, configuration, isolation: () => true });
  const taskHandlers = createApi("tasks", { getRepository: async () => repository, configuration });
  const api = createSlowlyApi({ fetchImpl: async (path, init) => {
    const url = new URL(path, origin); const segments = url.pathname.split("/").map(decodeURIComponent);
    const request = new Request(url, { ...init, headers: { ...init.headers, host: "127.0.0.1:3000", origin } });
    if (segments[2] === "workspaces" && segments[4] === "view") return viewHandler(request, { params: Promise.resolve({ id: segments[3] }) });
    check(segments[2] === "tasks", "UNEXPECTED_API_ROUTE");
    const handler = segments[3] ? init.method === "PATCH" ? "itemPatch" : "itemGet" : init.method === "POST" ? "collectionPost" : "collectionGet";
    return taskHandlers[handler](request, { params: Promise.resolve({ id: segments[3] }) });
  } });
  const realWorkspaceId = prepared.plan.operations[0].targetId;
  for (let i = 0; i < 2; i++) check(hash(projectMainView(await api.getWorkspaceView(realWorkspaceId), realWorkspaceId).workspace) === hash(prepared.workspace), "API_RELOAD_FIDELITY_MISMATCH");
  report.apiVerificationScope = "Real DynamoDB Local + injected Route Handlers + API Adapter; fresh reads, no browser or public server";
  passed("Repository, Migration Service, Route Handler and API Adapter use identical bounded table; two fresh API view reads preserve all fields");

  // Faults are applied only to an independent synthetic Session, never the real-backup result.
  const synthetic = workspaceFixture(); const syntheticBackup = captureWorkspaceBackup({ storage: storageFixture({ "slowly-workspace-v2": JSON.stringify(synthetic) }), createdAt });
  const syntheticArtifact = await sealBackup(syntheticBackup, origin);
  const syntheticOptions = { sourceNamespace: `synthetic-${runId}` }; const p = migrationPlanV2(syntheticArtifact, syntheticOptions);
  state.syntheticPlanId = p.planId; state.stage = "SYNTHETIC_SAFETY_TESTS"; save();
  let resumed = createMigrationService(db, { tableName, registrationBudget: 1 });
  const partial = await resumed.createSession(syntheticArtifact, syntheticOptions, p.planId);
  check(partial.state === "PREPARING" && partial.registeredCount === 1, "PARTIAL_REGISTRATION_NOT_PERSISTED");
  resumed = createMigrationService(db, { tableName }); await resumed.createSession(syntheticArtifact, syntheticOptions, p.planId);
  const root = p.operations[0]; await resumed.execute(p.planId, root.operationId, root.fingerprint);
  await rejects(() => resumed.verify(p.planId), "SESSION_STATE");
  let session = await resumed.getSession(p.planId); check(!(await resumed.releasePreview(p.planId, session.version)).eligible, "INCOMPLETE_VERIFY_ALLOWED_RELEASE");
  const rollbackPartial = await resumed.rollbackPreview(p.planId); check(rollbackPartial.canRollback && rollbackPartial.deletable.length === 1, "ROLLBACK_PREVIEW_INCORRECT");
  passed("Synthetic partial registration resumes; incomplete Verify blocks Release; rollback preview lists only confirmed target");
  const boardOps = p.operations.filter(op => op.type === "BOARD"); const lost = boardOps[0]; let dropped = false;
  const lostTransport = { async send(command) {
    const result = await db.send(command);
    if (!dropped && command.input.TransactItems?.some(action => action.Put?.Item.id === lost.targetId)) { dropped = true; throw new Error("Synthetic response lost after commit"); }
    return result;
  } };
  await rejects(() => createMigrationService(lostTransport, { tableName }).execute(p.planId, lost.operationId, lost.fingerprint), "STORAGE");
  resumed = createMigrationService(db, { tableName });
  check((await resumed.getOperation(p.planId, lost.operationId)).state === "CONFIRMED", "LOST_RESPONSE_RECEIPT_MISSING");
  check((await resumed.execute(p.planId, lost.operationId, lost.fingerprint)).replayed, "LOST_RESPONSE_REPLAY_FAILED");
  await resumed.execute(p.planId, boardOps[1].operationId, boardOps[1].fingerprint);
  const [a, b] = p.operations.filter(op => op.type === "TASK" && op.boardId === boardOps[0].targetId);
  let raced = false; let parentConflictObserved = false;
  const racingTransport = { async send(command) {
    const actions = command.input.TransactItems;
    if (!raced && actions?.some(action => action.Put?.Item.id === a.targetId)) {
      raced = true; await resumed.execute(p.planId, b.operationId, b.fingerprint);
      try { return await db.send(command); }
      catch (error) {
        const index = actions.findIndex(action => action.Put?.Item.id === boardOps[0].targetId);
        parentConflictObserved = error.name === "TransactionCanceledException" && error.CancellationReasons?.[index]?.Code === "ConditionalCheckFailed";
        throw error;
      }
    }
    return db.send(command);
  } };
  await createMigrationService(racingTransport, { tableName }).execute(p.planId, a.operationId, a.fingerprint);
  check(parentConflictObserved, "PARENT_VERSION_FENCE_NOT_OBSERVED");
  check((await repository.getBoard(boardOps[0].targetId)).taskCount === 2, "CONCURRENT_COUNTER_MISMATCH");
  const beforeReplay = await resumed.getSession(p.planId);
  const replays = await Promise.all(Array.from({ length: 3 }, () => resumed.execute(p.planId, a.operationId, a.fingerprint)));
  check(replays.every(result => result.replayed) && (await resumed.getSession(p.planId)).confirmedCount === beforeReplay.confirmedCount, "REPLAY_DUPLICATED_WRITES");
  await rejects(() => resumed.execute(p.planId, a.operationId, "0".repeat(64)), "IDEMPOTENCY_KEY_REUSE");
  passed("Synthetic lost-response receipt recovery, concurrent parent version rejection/retry, same-operation replay and payload conflict");
  const task = await repository.getTask(a.targetId); const board = await repository.getBoard(boardOps[0].targetId);
  const createData = structuredClone(task.data); createData.id = "blocked-create"; delete createData.completedAt;
  await rejects(() => api.createTask({ boardId: board.id, data: createData }), "MIGRATION_LOCKED");
  await rejects(() => api.updateTask(task.id, { boardId: board.id, version: task.version + 1, data: { notes: "synthetic conflict" } }), "CONFLICT");
  await rejects(() => repository.reorderTasks(board.id, [{ id: task.id, version: task.version, position: 2 }]), "MIGRATION_LOCKED");
  // Interleave a real CRUD write while the Session continues: it must be rejected.
  const other = p.operations.find(op => op.type === "WIDGET" && op.boardId === board.id);
  const concurrentResults = await Promise.allSettled([resumed.execute(p.planId, other.operationId, other.fingerprint), repository.updateTask(board.id, task.id, task.data, task.version)]);
  check(concurrentResults[0].status === "fulfilled" && concurrentResults[1].status === "rejected" && concurrentResults[1].reason.code === "MIGRATION_LOCKED", "CRUD_LOCK_RACE_FAILED");
  passed("API returns 409 for stale version and Migration Lock; concurrent CRUD and reorder remain blocked");
  for (const op of p.operations) { const receipt = await resumed.getOperation(p.planId, op.operationId); if (receipt.state !== "CONFIRMED") await resumed.execute(p.planId, op.operationId, op.fingerprint); }
  check((await resumed.verify(p.planId)).valid, "SYNTHETIC_VERIFY_FAILED");
  const rollback = await resumed.rollbackPreview(p.planId); check(rollback.canRollback && rollback.deletable.length === p.operations.length, "FULL_ROLLBACK_PREVIEW_FAILED");
  for (let i = 0; i < p.operations.length + 3; i++) { session = await resumed.getSession(p.planId); if (session.state === "ROLLED_BACK") break; await resumed.rollback(p.planId, session.version, p.planId); resumed = createMigrationService(db, { tableName }); }
  check((await resumed.getSession(p.planId)).state === "ROLLED_BACK", "SYNTHETIC_ROLLBACK_INCOMPLETE");
  passed("Independent synthetic Session verifies then conditionally rolls back with resume; real migrated result untouched");

  const realSession = await service.getSession(prepared.plan.planId);
  check(realSession.state === "RELEASED" && realSession.lockState === "RELEASED" && realSession.confirmedCount === 10 && realSession.releasedCount === 10, "FINAL_REAL_SESSION_MISMATCH");
  check(!(await service.rollbackPreview(prepared.plan.planId)).canRollback, "RELEASED_ROLLBACK_ALLOWED");
  check(hash(projectMainView(await api.getWorkspaceView(realWorkspaceId), realWorkspaceId).workspace) === hash(prepared.workspace), "REAL_RESULT_CHANGED_DURING_NEGATIVE_TESTS");
  check(sha(readFileSync(backupPath)) === sourceFileHash, "BACKUP_CHANGED");
  const namesBeforeCleanup = await tableNames(); check(hash(namesBeforeCleanup.filter(name => name !== tableName)) === hash(originalNames), "EXISTING_TABLE_NAMES_CHANGED");
  report.finalSession = { state: realSession.state, lockState: realSession.lockState, confirmedCount: realSession.confirmedCount, releasedCount: realSession.releasedCount };
  report.safety = { originalBackupUnchanged: true, localStorageAccessed: false, formalBusinessDataAccessed: false, allDataRequestsBoundToOwnedTable: databaseTables.size === 1 && databaseTables.has(tableName), existingTableNamesUnchanged: true, syntheticSessionState: "ROLLED_BACK", unresolvedLocks: 0 };
  report.dryRunPassed = true; report.formalMigrationReadiness = "Awaiting separate user approval"; report.status = "VERIFIED_BEFORE_CLEANUP";
  state.stage = "VERIFIED_BEFORE_CLEANUP"; save();
  console.log(JSON.stringify({ status: report.status, endpoint, tableName, checksPassed: report.checks.length, businessItems: 10, dataDifferences: 0, reportPath }));
  const currentProof = (await db.send(new GetCommand({ TableName: tableName, Key: { id: proof.id }, ConsistentRead: true }))).Item;
  check(hash(currentProof) === hash(proof) && state.created && !originalNames.includes(tableName), "CLEANUP_OWNERSHIP_UNPROVEN");
  assertDryRunTable(tableName, runId); state.cleanupAuthorized = true; state.stage = "CLEANING"; save();
  await client.send(new DeleteTableCommand({ TableName: tableName })); await waitUntilTableNotExists({ client, maxWaitTime: 30 }, { TableName: tableName });
  check(hash(await tableNames()) === hash(originalNames), "POST_CLEANUP_TABLE_NAMES_CHANGED");
  state.cleaned = true; state.stage = "CLEANED"; report.cleaned = true; report.status = "ISOLATED_DRY_RUN_PASSED"; report.formalTableStillExists = originalNames.includes("SlowlyTasks"); save();
  console.log(JSON.stringify(report));
} catch (error) {
  report.status = "FAILED_RETAINED_FOR_DIAGNOSIS"; report.errorCode = safeCode(error); report.errorType = /^[A-Za-z0-9]+$/.test(error.name || "") ? error.name : "Error";
  state.stage = "FAILED_RETAINED_FOR_DIAGNOSIS"; state.errorCode = report.errorCode; save();
  // No automatic cleanup on failure. Journal contains table ownership proof, never backup contents.
  console.log(JSON.stringify({ status: report.status, code: report.errorCode, errorType: report.errorType, tableName, created: state.created, cleaned: state.cleaned, reportPath, journalPath, passedChecks: report.checks.length }));
  process.exitCode = 1;
} finally { client?.destroy(); }
