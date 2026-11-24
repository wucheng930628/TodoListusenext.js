import "server-only";
import { DataError, assertId as assertModelId, fromFrontend, requireValue } from "../data-model.mjs";
import { assertOperationKey } from "../crud-operation.mjs";

const definitions = {
  workspaces: { type: "WORKSPACE", singular: "Workspace", fields: ["activeBoardId", "settings"] },
  boards: { type: "BOARD", singular: "Board", fields: ["id", "name", "description", "wipLimit", "analyticsSize", "settings"] },
  tasks: { type: "TASK", singular: "Task", fields: ["id", "title", "description", "status", "tag", "priority", "urgent", "date", "time", "subtasks", "notes"] },
  widgets: { type: "WIDGET", singular: "Widget", fields: ["id", "type", "span", "height", "manualSize", "config"] },
};
const reserved = new Set(["__proto__", "constructor", "prototype", "entityType", "schemaVersion", "version", "createdAt", "updatedAt", "completedAt", "parentId", "workspaceId", "boardId", "gsi1pk", "gsi1sk", "taskCount", "widgetCount", "doingCount"]);
const widgetConfigFields = new Map([["analytics", []], ["today", ["showCompleted"]], ["upcoming", ["showCompleted"]],
  ["timer", ["minutes", "taskId", "endsAt", "remaining"]], ["note", ["text"]]]);
function validateWidgetConfigType(type, config) {
  const fields = widgetConfigFields.get(type);
  requireValue(fields && Object.keys(config).every(key => fields.includes(key)), "Widget config does not match its type");
}
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Vary": "Origin" };
const codes = { VALIDATION: 400, NOT_FOUND: 404, OWNERSHIP: 403, CONFLICT: 409, OPERATION_CONFLICT: 409, WIP_LIMIT: 409, NOT_EMPTY: 409, FORBIDDEN: 403, NOT_SUPPORTED: 501, MIGRATION_LOCKED: 409 };
const messages = {
  VALIDATION: "Invalid request parameters or data.", NOT_FOUND: "Resource not found.", OWNERSHIP: "Resource does not belong to the specified parent.",
  CONFLICT: "Version conflict. Reload before retrying.", WIP_LIMIT: "WIP limit exceeded.", NOT_EMPTY: "Only empty boards may be deleted.",
  OPERATION_CONFLICT: "Operation key is already bound to another payload or scope.",
  FORBIDDEN: "This API is restricted to explicitly enabled local development.",
  NOT_SUPPORTED: "Workspace enumeration is unsupported. Supply ?id= or use /api/workspaces/{id}.",
  MIGRATION_LOCKED: "This resource is protected by an active migration lock.",
};
function response(data, status = 200) { return Response.json({ data }, { status, headers }); }
function assertId(id, type) {
  assertModelId(id, type);
  requireValue(/#[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id), "Invalid database id");
}
export { assertId as assertApiId };
function object(value) { requireValue(value && Object.getPrototypeOf(value) === Object.prototype, "Expected a plain object"); }
export function keys(value, allowed) { object(value); requireValue(Object.keys(value).every(key => allowed.includes(key)), "Unknown request field"); }
function safeTree(value, depth = 0) {
  requireValue(depth <= 12, "Data nesting exceeds limit");
  if (Array.isArray(value)) { for (const item of value) safeTree(item, depth + 1); return; }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) { requireValue(!reserved.has(key), "Internal fields cannot be supplied"); safeTree(child, depth + 1); }
  }
}
function version(value) { requireValue(Number.isSafeInteger(value) && value >= 1, "Invalid version"); return value; }
function position(value = 0) { requireValue(Number.isSafeInteger(value) && value >= 0 && value <= 999999999999, "Invalid position"); return value; }
export function query(request, allowed) {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) requireValue(allowed.includes(key) && params.getAll(key).length === 1, "Unknown or duplicate query parameter");
  return Object.fromEntries(params);
}
export function guard(request, env, { formalView = false } = {}) {
  const url = new URL(request.url);
  const origin = env.SLOWLY_LOCAL_API_ORIGIN || "http://127.0.0.1:3000";
  const configured = new URL(origin);
  const host = request.headers.get("host");
  // Only the formal Workspace GET may use the original browser storage origin.
  const localhost = formalView && request.method === "GET" && env.SLOWLY_FORMAL_VIEW_ENABLED === "1" &&
    host === configured.host.replace(/^127\.0\.0\.1(?=:|$)/, "localhost");
  const expectedHost = localhost ? host : configured.host;
  const expectedOrigin = localhost ? `http://${expectedHost}` : origin;
  requireValue(env.NODE_ENV === "development" && env.SLOWLY_LOCAL_API === "1" &&
    configured.protocol === "http:" && configured.hostname === "127.0.0.1" && configured.origin === origin &&
    // Next dev may normalize Request.url; the original Host selects the exact origin.
    url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) && url.port === configured.port &&
    host === expectedHost, "Local API disabled", "FORBIDDEN");
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedFor = request.headers.get("x-forwarded-for");
  requireValue(!request.headers.has("forwarded") && (!forwardedHost || forwardedHost === expectedHost) &&
    (!forwardedProto || forwardedProto === "http") && (!forwardedFor || forwardedFor.split(",").every(ip => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip.trim()))), "Proxy requests are not allowed", "FORBIDDEN");
  const suppliedOrigin = request.headers.get("origin");
  requireValue(!["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site")) &&
    (!suppliedOrigin || suppliedOrigin === expectedOrigin), "Cross-origin requests are not allowed", "FORBIDDEN");
  if (!["GET", "HEAD"].includes(request.method)) requireValue(suppliedOrigin === expectedOrigin, "An exact local Origin is required", "FORBIDDEN");
}
export async function body(request, maxBytes = 200000, sizeErrorCode = "VALIDATION") {
  requireValue(request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json", "JSON content type required");
  const length = request.headers.get("content-length");
  requireValue(length === null || /^\d+$/.test(length), "Invalid content length");
  requireValue(length === null || Number(length) <= maxBytes, "Body too large", sizeErrorCode);
  requireValue(request.body, "JSON body required");
  const reader = request.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new DataError(sizeErrorCode, "Body too large"); }
      chunks.push(Buffer.from(value));
    }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8")); object(result); return result;
  } catch (error) {
    if (error instanceof DataError) throw error;
    throw new DataError("VALIDATION", "Malformed JSON");
  } finally { reader.releaseLock(); }
}
function validatePatch(resource, data, creating) {
  const definition = definitions[resource]; keys(data, definition.fields); safeTree(data);
  requireValue(creating || Object.keys(data).length > 0, "Empty patch");
  if (data.id !== undefined) requireValue(typeof data.id === "string" && !data.id.startsWith("SLOWLY#"), "Expected a frontend id, not a database key");
  if (data.subtasks !== undefined) {
    requireValue(Array.isArray(data.subtasks), "Invalid subtasks");
    for (const entry of data.subtasks) keys(entry, ["id", "title", "done"]);
  }
  if (data.analyticsSize !== undefined) {
    keys(data.analyticsSize, ["width", "height"]);
    requireValue(Object.values(data.analyticsSize).every(value => Number.isFinite(value) && value > 0 && value <= 10000), "Invalid analytics size");
  }
  if (data.settings !== undefined) object(data.settings);
  if (data.config !== undefined) keys(data.config, ["text", "minutes", "taskId", "endsAt", "remaining", "showCompleted"]);
}
export function dto(item) {
  return { id: item.id, version: item.version, position: item.position, createdAt: item.createdAt, updatedAt: item.updatedAt,
    ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}), ...(item.boardId ? { boardId: item.boardId } : {}), data: item.data };
}

export function createApi(resource, { getRepository, configuration = () => process.env, authorizeCreate, authorizeMutation } = {}) {
  const definition = definitions[resource]; requireValue(definition, "Unknown resource");
  const { type, singular } = definition;
  const wrap = action => async (request, context = {}) => {
    try {
      const env = configuration();
      guard(request, env);
      requireValue(env.SLOWLY_FORMAL_VIEW_ENABLED !== "1" || ["GET", "HEAD"].includes(request.method),
        "Formal Workspace View has no server-side mutation authority", "FORBIDDEN");
      return await action(request, context);
    }
    catch (error) {
      const code = error instanceof DataError && codes[error.code] ? error.code : "INTERNAL";
      return Response.json({ error: { code, message: messages[code] || "An unexpected server error occurred." } }, { status: codes[code] || 500, headers });
    }
  };
  const idFrom = async context => { const { id } = await context.params; assertId(id, type); return id; };
  async function scopedBoard(repo, boardId, workspaceId) {
    assertId(boardId, "BOARD"); if (workspaceId !== undefined) assertId(workspaceId, "WORKSPACE");
    const board = await repo.getBoard(boardId);
    requireValue(workspaceId === undefined || board.workspaceId === workspaceId, "Workspace mismatch", "OWNERSHIP");
    return board;
  }
  async function assertScope(repo, item, scope, required) {
    if (resource === "boards") {
      if (required || scope.workspaceId !== undefined) assertId(scope.workspaceId, "WORKSPACE");
      requireValue(scope.workspaceId === undefined || item.workspaceId === scope.workspaceId, "Workspace mismatch", "OWNERSHIP");
    } else if (["tasks", "widgets"].includes(resource)) {
      if (required || scope.boardId !== undefined) assertId(scope.boardId, "BOARD");
      if (scope.workspaceId !== undefined) assertId(scope.workspaceId, "WORKSPACE");
      requireValue((scope.boardId === undefined || item.boardId === scope.boardId) && (scope.workspaceId === undefined || item.workspaceId === scope.workspaceId), "Parent mismatch", "OWNERSHIP");
    }
  }
  const scopeKeys = resource === "workspaces" ? [] : resource === "boards" ? ["workspaceId"] : ["boardId", "workspaceId"];
  async function mutation(action, request, id, input, mutate) {
    let authority;
    let key;
    if (authorizeMutation) {
      assertId(input.workspaceId, "WORKSPACE");
      key = request.headers.get("idempotency-key");
      requireValue(!["boards", "widgets"].includes(resource) || action !== "DELETE" || key !== null, "Deletion requires an operation key");
      if (key !== null) assertOperationKey(key);
      authority = await authorizeMutation(input.workspaceId, action);
      requireValue(authority, "Mutation is not authorized", "FORBIDDEN");
    }
    const repo = await getRepository();
    const execute = operation => mutate(repo, authority, operation);
    const result = key ? await repo.mutateOnce(resource, action, id, input, key, execute) : { item: await execute() };
    const resultHeaders = key ? { ...headers, "Operation-Id": key, "Idempotency-Status": result.replayed ? "replayed" : "committed" } : headers;
    return action === "DELETE" ? new Response(null, { status: 204, headers: resultHeaders })
      : Response.json({ data: action === "ORDER" ? result.item.map(dto) : dto(result.item) }, { headers: resultHeaders });
  }
  return {
    collectionGet: wrap(async request => {
      const q = query(request, resource === "workspaces" ? ["id"] : scopeKeys);
      if (resource === "workspaces") {
        if (q.id === undefined) throw new DataError("NOT_SUPPORTED", "Workspace list unsupported");
        assertId(q.id, "WORKSPACE"); return response([dto(await (await getRepository()).getWorkspace(q.id))]);
      }
      let parent;
      if (resource === "boards") { assertId(q.workspaceId, "WORKSPACE"); parent = q.workspaceId; }
      else { assertId(q.boardId, "BOARD"); if (q.workspaceId !== undefined) assertId(q.workspaceId, "WORKSPACE"); parent = q.boardId; }
      const repo = await getRepository();
      if (resource !== "boards") await scopedBoard(repo, parent, q.workspaceId);
      return response((await repo[`list${singular}s`](parent)).map(dto));
    }),
    collectionPost: wrap(async request => {
      query(request, []); const input = await body(request);
      keys(input, ["data", ...(resource === "workspaces" ? [] : ["position", ...scopeKeys])]);
      validatePatch(resource, input.data, true);
      const data = fromFrontend(type, input.data); const order = position(input.position);
      if (resource === "boards") assertId(input.workspaceId, "WORKSPACE");
      if (["tasks", "widgets"].includes(resource)) { assertId(input.boardId, "BOARD"); if (input.workspaceId !== undefined) assertId(input.workspaceId, "WORKSPACE"); }
      const operationKey = request.headers.get("idempotency-key");
      if (operationKey !== null) assertOperationKey(operationKey);
      let authority;
      if (authorizeCreate) {
        requireValue(operationKey !== null && input.position !== undefined, "Create requires an operation key and position");
        assertId(input.workspaceId, "WORKSPACE");
        authority = await authorizeCreate(input.workspaceId);
        requireValue(authority, "Create is not authorized", "FORBIDDEN");
        if (resource === "widgets") validateWidgetConfigType(data.type, data.config);
      }
      const repo = await getRepository(); let item;
      if (operationKey !== null) {
        const result = await repo.createOnce(resource, input, operationKey, authority);
        return Response.json({ data: dto(result.item) }, { status: result.replayed ? 200 : 201,
          headers: { ...headers, "Idempotency-Status": result.replayed ? "replayed" : "created", "Operation-Id": operationKey } });
      }
      if (resource === "workspaces") item = await repo.createWorkspace(data);
      else if (resource === "boards") item = await repo.createBoard(input.workspaceId, data, order);
      else { await scopedBoard(repo, input.boardId, input.workspaceId); item = await repo[`create${singular}`](input.boardId, data, order); }
      return Response.json({ data: dto(item) }, { status: 201, headers: { ...headers, "Idempotency-Status": "unprotected" } });
    }),
    itemGet: wrap(async (request, context) => {
      const id = await idFrom(context); const q = query(request, scopeKeys);
      // Validate scope syntax before any database operation.
      if (q.boardId !== undefined) assertId(q.boardId, "BOARD");
      if (q.workspaceId !== undefined) assertId(q.workspaceId, "WORKSPACE");
      const repo = await getRepository(); const item = await repo[`get${singular}`](id);
      await assertScope(repo, item, q, false); return response(dto(item));
    }),
    itemPatch: wrap(async (request, context) => {
      const id = await idFrom(context); query(request, []); const input = await body(request);
      keys(input, ["data", "version", ...scopeKeys]); version(input.version); validatePatch(resource, input.data, false);
      if (resource === "boards") assertId(input.workspaceId, "WORKSPACE");
      if (["tasks", "widgets"].includes(resource)) assertId(input.boardId, "BOARD");
      if (input.workspaceId !== undefined) assertId(input.workspaceId, "WORKSPACE");
      return mutation("UPDATE", request, id, input, async (repo, authority, operation) => {
        const previous = await repo[`get${singular}`](id);
        await assertScope(repo, previous, input, true);
        const data = { ...previous.data, ...input.data };
        if (resource === "tasks" && input.data.subtasks !== undefined) {
          data.subtasks = input.data.subtasks.map(item => ({ ...previous.data.subtasks.find(old => old.id === item.id), ...item }));
        }
        if (resource === "widgets" && input.data.config !== undefined) {
          // Preserve imported extension fields while keeping existing known-config replacement semantics.
          const known = new Set(["text", "minutes", "taskId", "endsAt", "remaining", "showCompleted"]);
          data.config = { ...Object.fromEntries(Object.entries(previous.data.config || {}).filter(([key]) => !known.has(key))), ...input.data.config };
        }
        if (resource === "widgets" && authority) {
          requireValue(data.type === previous.data.type || input.data.config !== undefined, "Changing widget type requires an explicit config");
          if (input.data.config !== undefined) validateWidgetConfigType(data.type, input.data.config);
        }
        if (resource !== "workspaces") requireValue(data.id === previous.data.id, "Frontend id cannot change");
        let item;
        if (resource === "workspaces") item = await repo.saveWorkspace(id, data, input.version);
        else if (resource === "boards") item = await repo.updateBoard(id, data, input.version, authority, operation);
        else if (resource === "tasks") item = await repo.updateTask(input.boardId, id, data, input.version, authority, operation);
        else item = await repo.updateWidget(input.boardId, id, data, input.version, authority, operation);
        return item;
      });
    }),
    itemDelete: wrap(async (request, context) => {
      requireValue(resource !== "workspaces", "Workspace deletion is unsupported", "NOT_SUPPORTED");
      const id = await idFrom(context); query(request, []); const input = await body(request);
      keys(input, ["version", ...scopeKeys]); version(input.version);
      if (resource === "boards") assertId(input.workspaceId, "WORKSPACE");
      else assertId(input.boardId, "BOARD");
      if (input.workspaceId !== undefined) assertId(input.workspaceId, "WORKSPACE");
      return mutation("DELETE", request, id, input, async (repo, authority, operation) => {
        const item = await repo[`get${singular}`](id);
        await assertScope(repo, item, input, true);
        if (resource === "boards") await repo.deleteBoard(id, input.version, authority, operation);
        else if (resource === "tasks") await repo.deleteTask(input.boardId, id, input.version, authority, operation);
        else await repo.deleteWidget(input.boardId, id, input.version, authority, operation);
        return null;
      });
    }),
    orderPatch: wrap(async request => {
      requireValue(resource !== "workspaces", "Unsupported ordering", "NOT_SUPPORTED");
      query(request, []); const input = await body(request); keys(input, ["entries", ...scopeKeys]);
      requireValue(Array.isArray(input.entries) && input.entries.length > 0 && input.entries.length <= (resource === "boards" ? 99 : 98), "Invalid ordering entries");
      for (const entry of input.entries) { keys(entry, ["id", "version", "position"]); assertId(entry.id, type); version(entry.version); requireValue(entry.position !== undefined, "Position required"); position(entry.position); }
      requireValue(new Set(input.entries.map(entry => entry.id)).size === input.entries.length, "Duplicate order entries");
      const parent = resource === "boards" ? input.workspaceId : input.boardId;
      assertId(parent, resource === "boards" ? "WORKSPACE" : "BOARD");
      if (input.workspaceId !== undefined) assertId(input.workspaceId, "WORKSPACE");
      if (resource === "boards" && authorizeMutation) {
        return mutation("ORDER", request, parent, input, (repo, authority, operation) => repo.reorderBoards(parent, input.entries, authority, operation));
      }
      if (resource === "widgets" && authorizeMutation) {
        return mutation("ORDER", request, parent, input, (repo, authority, operation) => repo.reorderWidgets(parent, input.entries, authority, operation));
      }
      const repo = await getRepository();
      if (resource !== "boards") await scopedBoard(repo, parent, input.workspaceId);
      return response((await repo[`reorder${singular}s`](parent, input.entries)).map(dto));
    }),
  };
}
