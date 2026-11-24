import "server-only";
import { DataError, requireValue } from "../data-model.mjs";
import { assertOperationKey, workspaceCreateScope } from "../crud-operation.mjs";
import { guard, query, assertApiId, dto } from "./handlers.mjs";

export function createOperationApi({ getRepository, configuration = () => process.env, authorizeScope }) {
  return async (request, context) => {
    const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: "Origin" };
    try {
      guard(request, configuration());
      const { operationId } = await context.params;
      assertOperationKey(operationId);
      const scope = query(request, ["resource", "workspaceId", "boardId", "scope"]);
      requireValue(["workspaces", "boards", "tasks", "widgets"].includes(scope.resource), "Resource required");
      if (scope.resource === "workspaces") {
        requireValue(scope.scope === workspaceCreateScope && scope.workspaceId === undefined && scope.boardId === undefined, "Workspace create scope required");
      } else {
        assertApiId(scope.workspaceId, "WORKSPACE");
        requireValue(scope.scope === undefined, "Unexpected scope");
        if (["tasks", "widgets"].includes(scope.resource)) assertApiId(scope.boardId, "BOARD");
        else requireValue(scope.boardId === undefined, "Unexpected board");
      }
      if (authorizeScope) await authorizeScope(scope);
      const receipt = await (await getRepository()).getOperation(operationId, scope);
      if (!receipt) return Response.json({ error: { code: "OPERATION_NOT_FOUND", state: "NOT_FOUND", message: "No confirmed receipt is visible. The create outcome remains unknown." } }, { status: 404, headers });
      return Response.json({ data: { operationId, state: "CONFIRMED", resource: receipt.resource, workspaceId: receipt.workspaceId,
        ...(receipt.boardId ? { boardId: receipt.boardId } : {}), targetId: receipt.targetId, createdAt: receipt.createdAt,
        ...(receipt.action === "CREATE" ? {} : { action: receipt.action }),
        result: receipt.action === "DELETE" ? null : dto(receipt.result) } }, { headers });
    } catch (error) {
      const statuses = { VALIDATION: 400, FORBIDDEN: 403, OWNERSHIP: 403, OPERATION_CONFLICT: 409 };
      const code = error instanceof DataError && statuses[error.code] ? error.code : "OPERATION_UNKNOWN";
      const state = code === "OPERATION_CONFLICT" ? "CONFLICT" : "UNKNOWN";
      return Response.json({ error: { code, state, message: code === "OPERATION_CONFLICT" ? "Operation scope does not match." : "Operation result is unavailable." } }, { status: statuses[code] || 500, headers });
    }
  };
}
