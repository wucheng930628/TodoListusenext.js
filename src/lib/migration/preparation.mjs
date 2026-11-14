import "server-only";
import { createHash } from "node:crypto";
import { fromFrontend, splitFrontendWorkspace, assertItemSize } from "../data-model.mjs";
import { validateBackup, readBackupSource } from "../client/workspace-backup.mjs";

export class MigrationError extends Error {
  constructor(code, message) { super(message); this.name = "MigrationError"; this.code = code; }
}
function requireState(ok, message) { if (!ok) throw new MigrationError("INVALID_STATE", message); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
function candidateId(namespace, type, path) {
  const chars = digest([namespace, type, path]).slice(0, 32).split("");
  chars[12] = "8"; chars[16] = ((parseInt(chars[16], 16) & 3) | 8).toString(16);
  const hex = chars.join("");
  return `SLOWLY#${type}#${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
// This is a capability comparison against Phase 3, not another domain schema.
// Domain validation always goes through data-model.mjs; fields are never stripped.
const apiFields = {
  WORKSPACE: ["activeBoardId", "settings"],
  BOARD: ["id", "name", "description", "wipLimit", "analyticsSize", "settings"],
  TASK: ["id", "title", "description", "status", "tag", "priority", "urgent", "date", "time", "subtasks", "notes"],
  WIDGET: ["id", "type", "span", "height", "manualSize", "config"],
};
export const MIGRATION_CAPABILITY_GAPS = Object.freeze([
  "Existing POST endpoints generate random IDs and have no atomic idempotency receipt.",
  "Existing APIs cannot import completedAt or arbitrary preserved fields losslessly.",
  "No server-side migration session, lookup-by-operation or authoritative completion verifier exists.",
]);

/** Server-only pure calculation. Imports no repository, SDK, storage or fetch. */
export function previewMigration(input, { sourceNamespace, legacyBoard } = {}) {
  const backup = validateBackup(input);
  requireState(typeof sourceNamespace === "string" && /^[a-zA-Z0-9._-]{8,128}$/.test(sourceNamespace), "Supply a persistent sourceNamespace (8–128 ASCII letters, digits, '.', '_' or '-').");
  const issues = []; const entities = []; const subtasks = [];
  const issue = (code, path, message, severity = "error") => issues.push({ code, path, message, severity });
  const raw = readBackupSource(backup); let workspace = raw;
  if (backup.selectedSourceKey === "slowly-board-v1") {
    if (!legacyBoard) {
      issue("LEGACY_BOARD_METADATA_REQUIRED", "$", "Legacy tasks have no board metadata. Supply explicitly confirmed legacyBoard settings.");
      return { formatVersion: 1, sourceNamespace, selectedSourceKey: backup.selectedSourceKey, modelValid: false, executable: false, counts: { workspaces: 1, boards: 0, tasks: raw.length, widgets: 0, subtasks: raw.reduce((n, task) => n + (Array.isArray(task?.subtasks) ? task.subtasks.length : 0), 0) }, issues, entities, subtasks, capabilityGaps: [...MIGRATION_CAPABILITY_GAPS] };
    }
    workspace = { activeBoardId: legacyBoard.id, boards: [{ ...structuredClone(legacyBoard), tasks: raw }] };
  }
  const selected = backup.sources.find(source => source.key === backup.selectedSourceKey);
  const sourceRevision = digest([selected.key, selected.raw, legacyBoard ?? null]);
  const workspaceId = candidateId(sourceNamespace, "WORKSPACE", []);
  const counts = { workspaces: 1, boards: workspace.boards.length, tasks: 0, widgets: 0, subtasks: 0 };
  const ids = new Set();
  function unique(items, path, kind) {
    const seen = new Set();
    for (let i = 0; i < items.length; i++) {
      const id = items[i]?.id;
      if (typeof id !== "string" || !id.trim()) issue("INVALID_ID", `${path}[${i}]`, `${kind} needs a nonempty frontend id.`);
      else if (seen.has(id)) issue("DUPLICATE_ID", `${path}[${i}]`, `Duplicate ${kind} id within its parent.`);
      seen.add(id);
    }
  }
  function inspectNumbers(value, path) {
    if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) issue("UNSAFE_NUMBER", path, "Number cannot be represented losslessly; original JSON remains in backup.");
    if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) inspectNumbers(child, `${path}.${key}`);
  }
  inspectNumbers(workspace, "$");
  function add(type, value, path, sourcePath, parentId, boardId, position) {
    try {
      if (value?.schemaVersion !== undefined && value.schemaVersion !== 1) issue("UNSUPPORTED_SCHEMA_VERSION", `${path}.schemaVersion`, "Source schemaVersion is not supported.");
      const data = fromFrontend(type, value);
      const targetId = candidateId(sourceNamespace, type, sourcePath);
      if (ids.has(targetId)) issue("MAPPING_COLLISION", path, "Two source entities map to the same target id.");
      ids.add(targetId);
      const entity = { key: JSON.stringify([type, sourcePath]), type, source: { storageKey: selected.key, path, identity: sourcePath }, targetId, parentId, workspaceId, boardId, position, data };
      if (type === "BOARD") entity.source.widgetsPresent = Object.hasOwn(value, "widgets");
      assertItemSize(entity);
      entity.fingerprint = digest({ type, parentId, workspaceId, boardId, position, data, widgetsPresent: entity.source.widgetsPresent ?? null });
      entities.push(entity);
      if (value.position !== undefined && value.position !== position) issue("POSITION_DIFFERS_FROM_ARRAY", `${path}.position`, "UI order comes from the array; the extra position field is preserved without overriding it.", "warning");
      for (const key of Object.keys(data)) if (!apiFields[type].includes(key)) issue("API_FIELD_UNSUPPORTED", `${path}.${key}`, "Field is preserved but cannot be imported through the current CRUD API.", "blocker");
      if (type !== "WORKSPACE" && data.id.startsWith("SLOWLY#")) issue("API_FRONTEND_ID_UNSUPPORTED", `${path}.id`, "Current API rejects database-style frontend ids.", "blocker");
      return entity;
    } catch (error) { issue("INVALID_SCHEMA", path, error.code === "VALIDATION" ? error.message : "Source entity could not be validated."); return null; }
  }
  add("WORKSPACE", workspace, "$", [], null, null, 0);
  unique(workspace.boards, "$.boards", "Board");
  if (!workspace.boards.length) issue("EMPTY_WORKSPACE", "$.boards", "No boards exist; do not replace the UI with an empty workspace.");
  if (!workspace.boards.some(board => board?.id === workspace.activeBoardId)) issue("ACTIVE_BOARD_MISSING", "$.activeBoardId", "Active board does not reference a source board.");
  for (let b = 0; b < workspace.boards.length; b++) {
    const board = workspace.boards[b]; const path = `$.boards[${b}]`;
    const sourcePath = ["board", board?.id ?? null];
    const boardId = candidateId(sourceNamespace, "BOARD", sourcePath);
    add("BOARD", board, path, sourcePath, workspaceId, null, b);
    if (board?.workspaceId !== undefined && board.workspaceId !== workspace.id) issue("PARENT_MISMATCH", `${path}.workspaceId`, "Explicit workspace relation disagrees with nesting.");
    if (!Array.isArray(board?.tasks)) { issue("TASKS_MISSING", path, "Board tasks must be an array."); continue; }
    counts.tasks += board.tasks.length;
    unique(board.tasks, `${path}.tasks`, "Task");
    if (board.tasks.filter(task => task?.status === "doing").length > board.wipLimit) issue("WIP_EXCEEDED", path, "Existing doing tasks exceed WIP. No limit or task is automatically changed.");
    for (let t = 0; t < board.tasks.length; t++) {
      const task = board.tasks[t]; const taskPath = `${path}.tasks[${t}]`;
      const entity = add("TASK", task, taskPath, [...sourcePath, "task", task?.id ?? null], boardId, boardId, t);
      if (task?.status !== "done" && task?.completedAt != null) issue("COMPLETION_TIME_CONFLICT", `${taskPath}.completedAt`, "A non-done task has a completion timestamp. Repository writes would clear it; resolve explicitly before migration.");
      if (task?.boardId !== undefined && task.boardId !== board.id) issue("PARENT_MISMATCH", `${taskPath}.boardId`, "Explicit task parent disagrees with nesting.");
      if (task?.workspaceId !== undefined && task.workspaceId !== workspace.id) issue("PARENT_MISMATCH", `${taskPath}.workspaceId`, "Explicit task workspace disagrees with nesting.");
      if (Array.isArray(task?.subtasks)) {
        counts.subtasks += task.subtasks.length; unique(task.subtasks, `${taskPath}.subtasks`, "Subtask");
        for (let s = 0; s < task.subtasks.length; s++) {
          if (task.subtasks[s]?.schemaVersion !== undefined && task.subtasks[s].schemaVersion !== 1) issue("UNSUPPORTED_SCHEMA_VERSION", `${taskPath}.subtasks[${s}].schemaVersion`, "Subtask schemaVersion is not supported.");
          subtasks.push({ sourcePath: `${taskPath}.subtasks[${s}]`, targetTaskId: entity?.targetId ?? null, frontendId: task.subtasks[s]?.id, storage: "inline" });
        }
      }
    }
    if (board.widgets === undefined) issue("IMPLICIT_WIDGETS", path, "UI renders a default analytics widget when widgets is absent. Phase 4B must explicitly preserve this distinction.", "warning");
    else if (!Array.isArray(board.widgets)) issue("INVALID_WIDGETS", `${path}.widgets`, "Widgets must be an array.");
    else {
      counts.widgets += board.widgets.length; unique(board.widgets, `${path}.widgets`, "Widget");
      for (let w = 0; w < board.widgets.length; w++) {
        const widget = board.widgets[w]; const widgetPath = `${path}.widgets[${w}]`;
        add("WIDGET", widget, widgetPath, [...sourcePath, "widget", widget?.id ?? null], boardId, boardId, w);
        if (widget?.boardId !== undefined && widget.boardId !== board.id) issue("PARENT_MISMATCH", widgetPath, "Explicit widget parent disagrees with nesting.");
        if (widget?.workspaceId !== undefined && widget.workspaceId !== workspace.id) issue("PARENT_MISMATCH", widgetPath, "Explicit widget workspace disagrees with nesting.");
        if (widget?.config?.taskId && !board.tasks.some(task => task?.id === widget.config.taskId)) issue("DANGLING_TIMER_TASK", widgetPath, "Timer task reference is not in its board; it is preserved, not silently removed.", "warning");
      }
    }
  }
  if (!issues.some(entry => entry.severity === "error")) {
    try { splitFrontendWorkspace(workspace); }
    catch { issue("WORKSPACE_CONVERSION_FAILED", "$", "Shared workspace conversion rejected this snapshot."); }
  }
  const mapped = new Set(entities.map(entity => entity.targetId));
  for (const entity of entities) if (entity.parentId !== null && !mapped.has(entity.parentId)) issue("MISSING_PARENT_MAPPING", entity.source.path, "A parent mapping is missing.");
  return { formatVersion: 1, sourceNamespace, sourceRevision, selectedSourceKey: backup.selectedSourceKey, counts,
    modelValid: !issues.some(entry => entry.severity === "error"), executable: false, issues, entities, subtasks,
    capabilityGaps: [...MIGRATION_CAPABILITY_GAPS], ignoredSources: backup.sources.filter(source => source.key !== selected.key).map(source => source.key) };
}

export function prepareMigration(backup, options) {
  const preview = previewMigration(backup, options);
  if (!preview.modelValid) throw new MigrationError("PREVIEW_INVALID", "Resolve preview errors before preparing a migration plan.");
  const planId = digest([preview.sourceNamespace, preview.sourceRevision, preview.entities.map(entity => [entity.key, entity.fingerprint])]);
  return { format: "slowly-migration-plan", formatVersion: 1, planId, sourceNamespace: preview.sourceNamespace, sourceRevision: preview.sourceRevision,
    counts: preview.counts, operations: preview.entities.map(entity => ({ ...entity, operationId: digest([planId, entity.key]) })),
    executable: false, capabilityGaps: preview.capabilityGaps, issues: preview.issues };
}

function assertPlan(plan) {
  requireState(plan?.format === "slowly-migration-plan" && plan.formatVersion === 1 && Array.isArray(plan.operations), "Invalid migration plan.");
  const expected = digest([plan.sourceNamespace, plan.sourceRevision, plan.operations.map(entity => [entity.key, entity.fingerprint])]);
  requireState(plan.planId === expected, "Plan identity mismatch.");
  const ids = new Set(); const keys = new Set();
  for (const entity of plan.operations) {
    requireState(!ids.has(entity.targetId) && !keys.has(entity.key), "Duplicate operation mapping."); ids.add(entity.targetId); keys.add(entity.key);
    requireState(entity.targetId === candidateId(plan.sourceNamespace, entity.type, entity.source.identity), "Target mapping mismatch.");
    requireState(entity.fingerprint === digest({ type: entity.type, parentId: entity.parentId, workspaceId: entity.workspaceId, boardId: entity.boardId, position: entity.position, data: entity.data, widgetsPresent: entity.source.widgetsPresent ?? null }), "Payload fingerprint mismatch.");
    requireState(entity.operationId === digest([plan.planId, entity.key]), "Operation identity mismatch.");
  }
  for (const entity of plan.operations) requireState(entity.parentId === null || ids.has(entity.parentId), "Missing parent mapping.");
  const workspace = plan.operations.filter(entity => entity.type === "WORKSPACE");
  requireState(workspace.length === 1 && workspace[0].parentId === null, "Plan needs one workspace root.");
  for (const entity of plan.operations) {
    requireState(entity.key === JSON.stringify([entity.type, entity.source.identity]) && entity.workspaceId === workspace[0].targetId, "Source identity or workspace relation mismatch.");
    if (entity.type === "BOARD") requireState(entity.parentId === workspace[0].targetId && entity.boardId === null, "Board relation mismatch.");
    if (["TASK", "WIDGET"].includes(entity.type)) requireState(entity.boardId === entity.parentId && plan.operations.some(parent => parent.type === "BOARD" && parent.targetId === entity.parentId), "Child relation mismatch.");
  }
  requireState(canonical(plan.counts) === canonical(countEntities(plan.operations)), "Plan counts mismatch.");
}
function countEntities(entities) {
  const count = type => entities.filter(entity => entity.type === type).length;
  return { workspaces: count("WORKSPACE"), boards: count("BOARD"), tasks: count("TASK"), widgets: count("WIDGET"),
    subtasks: entities.filter(entity => entity.type === "TASK").reduce((sum, entity) => sum + (Array.isArray(entity.data?.subtasks) ? entity.data.subtasks.length : 0), 0) };
}
export function createMigrationCheckpoint(plan) {
  assertPlan(plan);
  return { format: "slowly-migration-checkpoint", formatVersion: 1, planId: plan.planId,
    entries: plan.operations.map(operation => ({ key: operation.key, targetId: operation.targetId, state: "pending", expectedVersion: null })) };
}
function assertCheckpoint(plan, checkpoint) {
  assertPlan(plan);
  requireState(checkpoint?.format === "slowly-migration-checkpoint" && checkpoint.formatVersion === 1 && checkpoint.planId === plan.planId && checkpoint.entries?.length === plan.operations.length, "Checkpoint belongs to another plan.");
  const keys = new Set();
  for (const entry of checkpoint.entries) {
    const operation = plan.operations.find(operation => operation.key === entry.key);
    requireState(operation && operation.targetId === entry.targetId && !keys.has(entry.key) && ["pending", "in-flight", "unknown", "failed", "confirmed", "conflict"].includes(entry.state), "Invalid checkpoint entry.");
    requireState(entry.state !== "confirmed" || (Number.isSafeInteger(entry.expectedVersion) && entry.expectedVersion >= 1), "Confirmed entry requires a version."); keys.add(entry.key);
  }
}
/** Records an outcome; does not send a request or persist the checkpoint. */
export function recordMigrationOutcome(plan, checkpoint, key, outcome) {
  assertCheckpoint(plan, checkpoint);
  requireState(["in-flight", "unknown", "failed"].includes(outcome.state), "Only reconciliation can confirm a write.");
  const next = structuredClone(checkpoint); const entry = next.entries.find(entry => entry.key === key);
  requireState(entry && !["confirmed", "conflict"].includes(entry.state), "Cannot overwrite confirmed/conflicting progress.");
  const transitions = { pending: ["in-flight"], "in-flight": ["unknown", "failed"], unknown: [], failed: ["in-flight"] };
  requireState(transitions[entry.state]?.includes(outcome.state), "Unsafe progress transition; reconcile unknown writes first.");
  entry.state = outcome.state; entry.errorCode = typeof outcome.errorCode === "string" ? outcome.errorCode : null;
  return next;
}

/** observations are receipts from a FUTURE authoritative migration service.
 * Missing observations never prove absence. Only explicit absent is retryable.
 * This helper is not an executor and never calls today's random-ID POST API.
 */
export function reconcileMigration(plan, checkpoint, observations) {
  assertCheckpoint(plan, checkpoint); requireState(Array.isArray(observations), "Observations must be an array.");
  const seen = new Set(); const next = structuredClone(checkpoint);
  for (const observation of observations) {
    const operation = plan.operations.find(operation => operation.key === observation.key);
    requireState(operation && !seen.has(observation.key), "Unknown or duplicate receipt."); seen.add(observation.key);
    const entry = next.entries.find(entry => entry.key === observation.key);
    if (entry.state === "conflict") continue;
    if (observation.state === "absent") {
      if (entry.state === "confirmed") { entry.state = "conflict"; entry.errorCode = "CONFIRMED_TARGET_MISSING"; }
      else { entry.state = "pending"; entry.expectedVersion = null; entry.errorCode = null; }
      continue;
    }
    if (observation.state !== "present") { if (entry.state !== "confirmed") entry.state = "unknown"; continue; }
    const fingerprint = digest({ type: observation.type, parentId: observation.parentId, workspaceId: observation.workspaceId, boardId: observation.boardId, position: observation.position, data: observation.data, widgetsPresent: observation.source?.widgetsPresent ?? null });
    if (observation.targetId !== operation.targetId || observation.operationId !== operation.operationId || observation.planId !== plan.planId || fingerprint !== operation.fingerprint ||
      !Number.isSafeInteger(observation.version) || observation.version < 1 || (entry.expectedVersion !== null && entry.expectedVersion !== observation.version)) {
      entry.state = "conflict"; entry.errorCode = "TARGET_OR_VERSION_CONFLICT";
    } else { entry.state = "confirmed"; entry.expectedVersion = observation.version; entry.errorCode = null; }
  }
  return next;
}
export function migrationProgress(plan, checkpoint) {
  assertCheckpoint(plan, checkpoint);
  const states = Object.fromEntries(["pending", "in-flight", "unknown", "failed", "confirmed", "conflict"].map(state => [state, checkpoint.entries.filter(entry => entry.state === state).length]));
  return { total: checkpoint.entries.length, states, percent: checkpoint.entries.length ? Math.floor(states.confirmed * 100 / checkpoint.entries.length) : 0,
    receiptComplete: states.confirmed === checkpoint.entries.length,
    executable: false, errors: checkpoint.entries.filter(entry => entry.errorCode).map(({ key, errorCode }) => ({ key, errorCode })) };
}
export function verifyMigration(plan, checkpoint, observations) {
  const reconciled = reconcileMigration(plan, checkpoint, observations);
  const progress = migrationProgress(plan, reconciled);
  const keys = new Set(observations.filter(item => item.state === "present").map(item => item.key));
  const present = observations.filter(item => item.state === "present");
  const observedCounts = countEntities(present);
  const countsMatch = canonical(observedCounts) === canonical(plan.counts);
  const relationsValid = present.every(entity => entity.parentId === null || present.some(parent => parent.targetId === entity.parentId));
  return { valid: progress.receiptComplete && keys.size === plan.operations.length && countsMatch && relationsValid, expectedCounts: plan.counts, observedCounts, countsMatch, relationsValid, progress,
    limitation: "Receipt checks cannot detect extra target items; Phase 4B needs a complete authoritative session manifest." };
}
