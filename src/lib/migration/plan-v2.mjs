import "server-only";
import { createHash } from "node:crypto";
import { DataError, requireValue, validateData, assertItemSize } from "../data-model.mjs";
import { readBackupSource } from "../client/workspace-backup.mjs";
import { resolveMigrationSource } from "./source-policy.mjs";
import { previewMigration } from "./preparation.mjs";

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const hash = value => createHash("sha256").update(canonical(value)).digest("hex");
export const operationFingerprint = operation => hash({ type: operation.type, targetId: operation.targetId, parentId: operation.parentId, workspaceId: operation.workspaceId, boardId: operation.boardId, position: operation.position, data: operation.data, restoreShape: operation.restoreShape, schemaVersion: 1 });
export function migrationPlanV2(input, options = {}) {
  requireValue(options && Object.getPrototypeOf(options) === Object.prototype && Object.keys(options).every(key => ["sourceNamespace", "policies"].includes(key)), "Invalid migration options");
  requireValue(typeof options.sourceNamespace === "string" && /^[a-zA-Z0-9._-]{8,128}$/.test(options.sourceNamespace), "Invalid source namespace");
  requireValue(options.policies === undefined || (options.policies && Object.getPrototypeOf(options.policies) === Object.prototype), "Invalid policies");
  const policies = { widgets: "preserve-implicit", timer: "preserve-absolute", ...options.policies };
  requireValue(policies && Object.keys(policies).every(key => ["legacyBoard", "widgets", "timer", "sourcePolicy"].includes(key)) && policies.widgets === "preserve-implicit" && policies.timer === "preserve-absolute", "Unsupported restoration policy");
  if (policies.legacyBoard !== undefined && policies.legacyBoard !== null) requireValue(Object.getPrototypeOf(policies.legacyBoard) === Object.prototype && Object.keys(policies.legacyBoard).every(key => ["id", "name", "description", "wipLimit", "analyticsSize", "settings", "schemaVersion"].includes(key)), "Legacy board settings cannot supply children");
  const { backup, sourceBinding } = resolveMigrationSource(input, policies.sourcePolicy);
  requireValue(!sourceBinding || policies.legacyBoard === undefined, "Excluded legacy sources cannot supply restoration settings", "SOURCE_POLICY_INVALID");
  const preview = previewMigration(backup, { sourceNamespace: options.sourceNamespace, legacyBoard: policies.legacyBoard });
  if (!preview.modelValid) throw new DataError("PREVIEW_INVALID", "Source schema, relationships or restoration settings are invalid", { cause: preview.issues });
  const raw = readBackupSource(backup);
  const workspace = backup.selectedSourceKey === "slowly-board-v1" ? { activeBoardId: policies.legacyBoard.id, boards: [{ ...policies.legacyBoard, tasks: raw }] } : raw;
  const originals = new Map([[JSON.stringify(["WORKSPACE", []]), workspace]]);
  for (const board of workspace.boards) {
    originals.set(JSON.stringify(["BOARD", ["board", board.id]]), board);
    for (const task of board.tasks) originals.set(JSON.stringify(["TASK", ["board", board.id, "task", task.id]]), task);
    for (const widget of board.widgets || []) originals.set(JSON.stringify(["WIDGET", ["board", board.id, "widget", widget.id]]), widget);
  }
  const operations = preview.entities.map(entity => {
    const original = originals.get(entity.key);
    const omitted = entity.type === "WORKSPACE" ? ["boards"] : entity.type === "BOARD" ? ["tasks", "widgets"] : [];
    const restoreShape = { dataKeys: Object.keys(original).filter(key => !omitted.includes(key)), ...(entity.type === "BOARD" ? { widgetsPresent: Object.hasOwn(original, "widgets") } : {}) };
    const operation = { key: entity.key, type: entity.type, targetId: entity.targetId, parentId: entity.parentId, workspaceId: entity.workspaceId, boardId: entity.boardId, position: entity.position, data: entity.data, restoreShape, schemaVersion: 1 };
    validateData(operation.type, operation.data); assertItemSize(operation);
    operation.fingerprint = operationFingerprint(operation);
    return operation;
  });
  const identity = { formatVersion: 2, schemaVersion: 1, sourceNamespace: options.sourceNamespace, sourceRevision: preview.sourceRevision, policies, operations: operations.map(operation => [operation.key, operation.fingerprint]) };
  // Opt-in source binding revision: old single-source Plan v2 identities remain unchanged.
  if (sourceBinding) Object.assign(identity, { sourceBindingVersion: 1, sourceBinding, expectedWorkspaceHash: hash(workspace), counts: preview.counts, targets: operations.map(operation => operation.targetId) });
  const migrationId = hash(identity);
  for (const operation of operations) operation.operationId = hash([migrationId, operation.key]);
  return { format: "slowly-migration-plan", formatVersion: 2, schemaVersion: 1, migrationId, planId: migrationId, sourceNamespace: options.sourceNamespace,
    sourceRevision: preview.sourceRevision, sourceStorageKey: backup.selectedSourceKey, sourceStorageVersion: backup.sources.find(source => source.key === backup.selectedSourceKey).storageVersion,
    expectedWorkspaceHash: hash(workspace), policies, counts: preview.counts, operations, executable: true,
    ...(sourceBinding ? { sourceBinding, sourceIdentity: identity } : {}),
    issues: preview.issues.filter(issue => !["API_FIELD_UNSUPPORTED", "API_FRONTEND_ID_UNSUPPORTED"].includes(issue.code)) };
}

export function restoreWorkspace(items) {
  const byPosition = list => [...list].sort((a, b) => a.position - b.position);
  const data = item => Object.fromEntries(item.restoreShape.dataKeys.map(key => [key, structuredClone(item.data[key])]));
  const root = items.find(item => item.entityType === "WORKSPACE");
  requireValue(root, "Missing workspace", "INTEGRITY_CONFLICT");
  return { ...data(root), boards: byPosition(items.filter(item => item.entityType === "BOARD")).map(board => ({ ...data(board),
    tasks: byPosition(items.filter(item => item.entityType === "TASK" && item.boardId === board.id)).map(data),
    ...(board.restoreShape.widgetsPresent ? { widgets: byPosition(items.filter(item => item.entityType === "WIDGET" && item.boardId === board.id)).map(data) } : {}),
  })) };
}
