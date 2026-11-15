import "server-only";
import { createHash } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { DataError, requireValue } from "../data-model.mjs";
import { verifyBackupArtifact } from "../client/verified-backup.mjs";
import { readBackupSource } from "../client/workspace-backup.mjs";
import { migrationPlanV2, hash, restoreWorkspace } from "./plan-v2.mjs";
import { createMigrationService } from "./service.mjs";
import { createRepository } from "../slowly-repository.mjs";
import { readWorkspaceView } from "../api/workspace-view.mjs";
import { projectMainView } from "../client/main-view-model.mjs";

const fields = {
  WORKSPACE: ["id", "activeBoardId", "boards", "settings", "schemaVersion"],
  BOARD: ["id", "name", "description", "wipLimit", "tasks", "widgets", "analyticsSize", "settings", "schemaVersion", "workspaceId"],
  TASK: ["id", "title", "description", "status", "tag", "priority", "urgent", "date", "time", "subtasks", "notes", "completedAt", "schemaVersion", "workspaceId", "boardId"],
  WIDGET: ["id", "type", "span", "height", "manualSize", "config", "schemaVersion", "workspaceId", "boardId"],
  SUBTASK: ["id", "title", "done", "schemaVersion"],
  CONFIG: ["text", "minutes", "taskId", "endsAt", "remaining", "showCompleted"],
  SIZE: ["width", "height"],
};
const required = {
  WORKSPACE: ["activeBoardId", "boards"], BOARD: ["id", "name", "description", "wipLimit", "tasks"],
  TASK: ["id", "title", "description", "status", "tag", "priority", "urgent", "date", "time", "subtasks", "notes"],
  WIDGET: ["id", "type", "span", "height", "config"], SUBTASK: ["id", "title", "done"], CONFIG: [], SIZE: ["width", "height"],
};

// JSON.parse has already checked syntax. Token inspection detects duplicate decoded keys.
function hasDuplicateJsonKeys(raw) {
  const tokens = raw.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) || [];
  const stack = [];
  for (const token of tokens) {
    if (token === "{") stack.push({ object: true, expectingKey: true, keys: new Set() });
    else if (token === "[") stack.push({ object: false });
    else if (token === "}" || token === "]") stack.pop();
    else if (stack.at(-1)?.object) {
      const frame = stack.at(-1);
      if (token === ",") frame.expectingKey = true;
      else if (token === ":") frame.expectingKey = false;
      else if (token.startsWith('"') && frame.expectingKey) {
        const key = JSON.parse(token);
        if (frame.keys.has(key)) return true;
        frame.keys.add(key);
      }
    }
  }
  return false;
}

function inspectSource(workspace, issues) {
  function check(type, value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) { issues.push({ code: "INVALID_SOURCE_OBJECT", type, path }); return; }
    const missing = required[type].filter(key => !Object.hasOwn(value, key));
    const unknown = Object.keys(value).filter(key => !fields[type].includes(key));
    if (missing.length) issues.push({ code: "MISSING_SOURCE_FIELDS", type, path, fields: missing });
    if (unknown.length) issues.push({ code: "UNKNOWN_SOURCE_FIELDS", type, path, fieldCount: unknown.length });
    if (type === "BOARD" && value.analyticsSize !== undefined) {
      check("SIZE", value.analyticsSize, `${path}.analyticsSize`);
      if (![value.analyticsSize?.width, value.analyticsSize?.height].every(size => Number.isFinite(size) && size > 0 && size <= 10000)) issues.push({ code: "INVALID_ANALYTICS_SIZE", type, path });
    }
    if (type === "TASK" && Array.isArray(value.subtasks)) value.subtasks.forEach((item, index) => check("SUBTASK", item, `${path}.subtasks[${index}]`));
    if (type === "WIDGET") check("CONFIG", value.config, `${path}.config`);
  }
  check("WORKSPACE", workspace, "$");
  if (!Array.isArray(workspace?.boards)) return;
  workspace.boards.forEach((board, index) => {
    const path = `$.boards[${index}]`; check("BOARD", board, path);
    if (Array.isArray(board?.tasks)) board.tasks.forEach((task, index) => check("TASK", task, `${path}.tasks[${index}]`));
    if (Array.isArray(board?.widgets)) board.widgets.forEach((widget, index) => check("WIDGET", widget, `${path}.widgets[${index}]`));
  });
}

/** Pure preview. The private backup/plan must never be serialized to reports or logs. */
export async function prepareDryRun(artifact, options) {
  const verified = await verifyBackupArtifact(artifact);
  const backup = verified.backup;
  const selected = backup.sources.find(source => source.key === backup.selectedSourceKey);
  const report = { backupFingerprint: verified.fingerprint, sourceSchemaVersions: verified.sourceSchemaVersions,
    sourceCounts: { workspaces: 1, ...selected.summary }, planId: null, blockers: [] };
  if (backup.sources.length !== 1) report.blockers.push({ code: "MULTIPLE_SOURCES_REQUIRE_REVIEW" });
  for (const source of backup.sources) if (hasDuplicateJsonKeys(source.raw)) report.blockers.push({ code: "DUPLICATE_JSON_KEYS" });
  const raw = readBackupSource(backup);
  const legacy = backup.selectedSourceKey === "slowly-board-v1";
  if (legacy && !options?.policies?.legacyBoard) report.blockers.push({ code: "LEGACY_BOARD_METADATA_REQUIRED" });
  const workspace = legacy ? options?.policies?.legacyBoard ? { activeBoardId: options.policies.legacyBoard.id, boards: [{ ...options.policies.legacyBoard, tasks: raw }] } : null : raw;
  if (workspace) inspectSource(workspace, report.blockers);
  let plan;
  try {
    plan = migrationPlanV2(backup, options);
    report.planId = plan.planId; report.sourceCounts = plan.counts;
    for (const issue of plan.issues) if (issue.severity === "error" || issue.severity === "blocker" || issue.code === "DANGLING_TIMER_TASK") report.blockers.push({ code: issue.code });
  } catch (error) {
    report.blockers.push({ code: error instanceof DataError ? error.code : "PREVIEW_INVALID" });
    if (Array.isArray(error.cause)) for (const issue of error.cause) if (issue.severity === "error") report.blockers.push({ code: issue.code });
  }
  return { backup, plan, workspace, report, valid: report.blockers.length === 0 };
}

export function assertDryRunTable(tableName, runId) {
  requireValue(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(runId || "") &&
    tableName === `Slowly_DryRun_${runId.replaceAll("-", "")}` && tableName !== "SlowlyTasks", "A run-owned dry-run table is required", "DRY_RUN_SCOPE");
}
export const dryRunProofId = runId => `SLOWLY#DRY_RUN_CONTROL#${runId}`;
export const dryRunOwnerHash = secret => createHash("sha256").update(secret).digest("hex");
export function boundDryRunClient(db, tableName, runId) {
  assertDryRunTable(tableName, runId);
  return { send(command) {
    const input = command.input;
    const tables = input.TransactItems ? input.TransactItems.map(action => (action.Put || action.Delete || action.ConditionCheck || action.Update).TableName) : [input.TableName];
    requireValue(tables.length > 0 && tables.every(name => name === tableName), "Dry-run table boundary violated", "DRY_RUN_SCOPE");
    return db.send(command);
  } };
}

export async function executeDryRun({ prepared, db, tableName, runId, ownerSecret, checkpoint = async () => {} }) {
  requireValue(prepared.valid === true && prepared.plan?.executable === true, "Preview blocks dry run", "PREVIEW_INVALID");
  const bounded = boundDryRunClient(db, tableName, runId);
  const readItem = async id => (await bounded.send(new GetCommand({ TableName: tableName, Key: { id }, ConsistentRead: true }))).Item;
  const proof = await readItem(dryRunProofId(runId));
  requireValue(proof?.entityType === "DRY_RUN_CONTROL" && proof.runId === runId && proof.ownerHash === dryRunOwnerHash(ownerSecret) &&
    proof.backupFingerprint === prepared.report.backupFingerprint && proof.planId === prepared.plan.planId, "Dry-run ownership proof mismatch", "DRY_RUN_SCOPE");
  const { plan } = prepared;
  let service = createMigrationService(bounded, { tableName, registrationBudget: 1 });
  let session;
  do {
    session = await service.createSession(prepared.backup, { sourceNamespace: plan.sourceNamespace, policies: plan.policies }, plan.planId);
    await checkpoint({ stage: "REGISTERING", registered: session.registeredCount, total: session.total });
  } while (session.state === "PREPARING");
  let recoveredResponses = 0;
  for (const [index, operation] of plan.operations.entries()) {
    const existing = await service.getOperation(plan.migrationId, operation.operationId);
    try { if (existing.state !== "CONFIRMED") await service.execute(plan.migrationId, operation.operationId, operation.fingerprint); }
    catch (error) {
      if (error.code !== "STORAGE") throw error;
      const receipt = await service.getOperation(plan.migrationId, operation.operationId);
      if (receipt.state !== "CONFIRMED") throw error;
      recoveredResponses++;
    }
    await checkpoint({ stage: "MIGRATING", completed: index + 1, total: plan.operations.length });
  }
  session = await service.getSession(plan.migrationId);
  let verification;
  if (session.state !== "RELEASED" && session.state !== "RELEASING") {
    verification = await service.verify(plan.migrationId);
    requireValue(verification.valid, "Verify failed", "INTEGRITY_CONFLICT");
    await checkpoint({ stage: "VERIFIED", completed: session.confirmedCount });
  }
  // Each release step inspects the persisted version and receipt. A restart uses a new service instance.
  let releaseSteps = 0;
  while (session.state !== "RELEASED") {
    session = await service.getSession(plan.migrationId);
    const preview = await service.releasePreview(plan.migrationId, session.version);
    requireValue(preview.eligible, "Release preview is blocked", "RELEASE_BLOCKED");
    session = await service.release(plan.migrationId, session.version, preview.verificationHash, plan.migrationId);
    releaseSteps++;
    await checkpoint({ stage: "RELEASING", completed: session.releasedCount, total: session.total });
  }
  service = createMigrationService(bounded, { tableName });
  session = await service.getSession(plan.migrationId);
  const receipts = [];
  let cursor = 0;
  do { const page = await service.listOperations(plan.migrationId, { cursor, limit: 50 }); receipts.push(...page.items); cursor = page.nextCursor === null ? null : Number(page.nextCursor); } while (cursor !== null);
  const items = await Promise.all(plan.operations.map(operation => readItem(operation.targetId)));
  requireValue(receipts.length === plan.operations.length && receipts.every(receipt => receipt.state === "CONFIRMED" && receipt.releasedAt) &&
    items.every((item, index) => item && item.migrationLock === false && item.migrationOwner?.migrationId === plan.migrationId && item.migrationOwner.operationId === plan.operations[index].operationId &&
      item.version === receipts[index].managedVersion && hash(item) === receipts[index].managedHash), "Receipt or lock integrity mismatch", "INTEGRITY_CONFLICT");
  const restored = restoreWorkspace(items);
  requireValue(hash(restored) === plan.expectedWorkspaceHash, "Source/target data differs", "INTEGRITY_CONFLICT");
  const workspaceId = plan.operations[0].targetId;
  const readFresh = async () => {
    const repository = createRepository(bounded, { tableName });
    const view = await readWorkspaceView(repository, workspaceId, { migrationService: createMigrationService(bounded, { tableName }) });
    requireValue(view.readiness.eligible, "Runtime view is not ready", "INTEGRITY_CONFLICT");
    return projectMainView(view, workspaceId).workspace;
  };
  const projected = await readFresh(); const reloaded = await readFresh();
  requireValue(hash(projected) === hash(prepared.workspace) && hash(reloaded) === hash(projected), "Fresh React view differs from source", "INTEGRITY_CONFLICT");
  const finalPreview = await service.releasePreview(plan.migrationId, session.version);
  requireValue(finalPreview.eligible && session.state === "RELEASED" && session.lockState === "RELEASED" && session.releasedCount === session.total &&
    session.verification?.workspaceHash === plan.expectedWorkspaceHash, "Release certificate mismatch", "INTEGRITY_CONFLICT");
  return { ...prepared.report, dryRunPassed: true, status: "NOT READY", formalCutoverAuthorized: false,
    blockers: [{ code: "FORMAL_MIGRATION_AND_CUTOVER_REQUIRE_SEPARATE_APPROVAL" }],
    targetCounts: session.verification.counts, verifyPassed: true, releasePassed: true, receiptsConfirmed: receipts.length,
    locksRemaining: 0, sourceWorkspaceHash: plan.expectedWorkspaceHash, targetWorkspaceHash: hash(restored),
    mappingHash: hash(plan.operations.map(operation => [operation.key, operation.targetId, operation.parentId, operation.position])),
    differences: [], reloadConsistencyPassed: true, reloadConsistencyScope: "fresh-repository-and-api-view-model", recoveredResponses, releaseSteps };
}
