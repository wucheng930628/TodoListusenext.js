import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { requireValue, assertItemSize } from "./data-model.mjs";

export const workspaceCreateScope = "local-workspace-create-v1";
const types = { workspaces: "WORKSPACE", boards: "BOARD", tasks: "TASK", widgets: "WIDGET" };

export function assertOperationKey(key) {
  requireValue(typeof key === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(key), "Expected a lowercase UUID v4 operation key");
  return key;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function createOperation(resource, input, key) {
  assertOperationKey(key);
  const type = types[resource];
  requireValue(type, "Unsupported create resource");
  const parentScope = resource === "workspaces" ? workspaceCreateScope : resource === "boards" ? input.workspaceId : input.boardId;
  requireValue(typeof parentScope === "string", "Create parent scope required");
  const fingerprint = createHash("sha256").update(canonical({ protocol: 1, action: "CREATE", resource, parentScope, input })).digest("hex");
  return { id: `SLOWLY#CRUD_OPERATION#${key}`, operationId: key, attemptId: randomUUID(), action: "CREATE", resource, type, parentScope, fingerprint, targetId: `SLOWLY#${type}#${key}` };
}

export function assertSameOperation(receipt, operation) {
  requireValue(receipt.entityType === "CRUD_OPERATION" && receipt.schemaVersion === 1 && receipt.state === "CONFIRMED" &&
    receipt.action === operation.action && receipt.resource === operation.resource && receipt.parentScope === operation.parentScope && receipt.fingerprint === operation.fingerprint,
  "Operation key already belongs to another request", "OPERATION_CONFLICT");
}

export function createMutationOperation(resource, action, targetId, input, key) {
  assertOperationKey(key);
  requireValue(resource === "tasks" && ["UPDATE", "DELETE"].includes(action) ||
    ["boards", "widgets"].includes(resource) && ["UPDATE", "DELETE", "ORDER"].includes(action), "Unsupported mutation");
  // Keep the existing Task fingerprint for previously stored receipts.
  const fingerprint = createHash("sha256").update(canonical({ protocol: 1, action, targetId, input,
    ...(resource !== "tasks" ? { resource } : {}) })).digest("hex");
  return { id: `SLOWLY#CRUD_OPERATION#${key}`, operationId: key, attemptId: randomUUID(), action,
    resource, type: types[resource], parentScope: resource === "boards" ? input.workspaceId : input.boardId, fingerprint, targetId };
}

export function createReceipt(operation, target, now, result = operation.action === "DELETE" ? null : target) {
  const receipt = { ...operation, entityType: "CRUD_OPERATION", schemaVersion: 1, state: "CONFIRMED", createdAt: now,
    workspaceId: target.entityType === "WORKSPACE" ? target.id : target.workspaceId,
    ...(target.boardId ? { boardId: target.boardId } : operation.resource === "widgets" && operation.action === "ORDER" ? { boardId: target.id } : {}), result };
  assertItemSize(receipt);
  return receipt;
}
