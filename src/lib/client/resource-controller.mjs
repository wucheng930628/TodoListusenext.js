import { createSlowlyApi, SlowlyApiError } from "./slowly-api.mjs";
import { resolveDataSource } from "./data-source.mjs";
import { createSafeCreateIntent } from "./safe-create.mjs";

const resources = { workspace: "Workspace", boards: "Board", tasks: "Task", widgets: "Widget" };
const idleMutation = () => ({ status: "idle", error: null, result: null });
export const resourceScopeKey = ({ mode = "localStorage", workspaceId = null, boardId = null, apiReady = false, allowWrites = false } = {}) => JSON.stringify([mode, workspaceId, boardId, apiReady, allowWrites]);

/** Framework-independent, per-hook store. It never reads/writes localStorage. */
export function createResourceController(resource, api = createSlowlyApi()) {
  if (!resources[resource]) throw new TypeError("Unknown resource");
  const empty = () => resource === "workspace" ? null : [];
  let snapshot = { scopeKey: null, status: "idle", loaded: false, data: empty(), error: null, idMapping: [], source: resolveDataSource(), mutation: idleMutation(), createRecovery: null };
  const initial = snapshot; const listeners = new Set();
  let config = {}; let generation = 0; let readSequence = 0; let readAbort; let writeAbort; let writeActive = false; let writeGeneration = -1;
  let createIntent;
  const publish = changes => { snapshot = { ...snapshot, ...changes }; for (const listener of listeners) listener(); };
  const mapping = data => (resource === "workspace" ? data ? [data] : [] : data).map(dto => ({ databaseId: dto.id, frontendId: dto.data.id ?? null, version: dto.version, position: dto.position, workspaceId: dto.workspaceId ?? dto.id, boardId: dto.boardId ?? null }));
  function validateDto(dto, scope) {
    if (!dto || typeof dto.id !== "string" || !dto.data || typeof dto.data !== "object" || Array.isArray(dto.data) || !Number.isSafeInteger(dto.version) || dto.version < 1 || !Number.isSafeInteger(dto.position) || dto.position < 0 ||
      (resource === "workspace" ? dto.id !== scope.workspaceId : dto.workspaceId !== scope.workspaceId) ||
      (["tasks", "widgets"].includes(resource) && dto.boardId !== scope.boardId)) {
      throw new SlowlyApiError("API returned data for an invalid resource scope.", { status: 200, code: "SCOPE_MISMATCH" });
    }
  }
  function validate(data, scope) {
    if (resource === "workspace") validateDto(data, scope);
    else {
      if (!Array.isArray(data)) throw new SlowlyApiError("Expected a resource list.", { status: 200, code: "INVALID_RESPONSE" });
      for (const dto of data) validateDto(dto, scope);
      if (new Set(data.map(dto => dto.id)).size !== data.length) throw new SlowlyApiError("Duplicate database IDs in response.", { status: 200, code: "INVALID_RESPONSE" });
    }
    return data;
  }
  async function refresh() {
    const source = resolveDataSource(config);
    if (!source.readApi) return null;
    if (["tasks", "widgets"].includes(resource) && !config.boardId) return null;
    if (writeActive && writeGeneration === generation) throw new SlowlyApiError("Wait for the active mutation before refreshing.", { code: "MUTATION_IN_PROGRESS", outcome: "not-sent" });
    readAbort?.abort(); readAbort = new AbortController();
    const controller = readAbort; const scope = { ...config }; const epoch = generation; const sequence = ++readSequence;
    publish({ status: "loading", error: null });
    try {
      const options = { signal: controller.signal };
      const data = resource === "workspace" ? await api.getWorkspace(scope.workspaceId, options)
        : resource === "boards" ? await api.listBoards({ workspaceId: scope.workspaceId }, options)
          : await api[`list${resources[resource]}s`]({ workspaceId: scope.workspaceId, boardId: scope.boardId }, options);
      if (epoch !== generation || sequence !== readSequence || controller.signal.aborted) return null;
      validate(data, scope); publish({ data, idMapping: mapping(data), status: "success", loaded: true, error: null }); return data;
    } catch (error) {
      if (epoch !== generation || sequence !== readSequence || controller.signal.aborted) return null;
      publish({ status: "error", error }); throw error;
    }
  }
  function cancel() {
    generation++; readSequence++; readAbort?.abort(); writeAbort?.abort();
    publish({ status: snapshot.loaded ? "success" : "idle", error: null,
      ...(writeActive ? { mutation: { status: "cancelled", error: null, result: null, outcome: "not-confirmed" },
        ...(createIntent ? { createRecovery: { operationKey: createIntent.operationKey, scope: createIntent.scope, state: "UNKNOWN" } } : {}) } : {}) });
  }
  async function select(next) {
    cancel(); config = { ...next }; let source;
    try { source = resolveDataSource(config); }
    catch (error) { publish({ scopeKey: resourceScopeKey(config), data: empty(), idMapping: [], loaded: false, status: "error", error }); throw error; }
    const missingBoard = ["tasks", "widgets"].includes(resource) && !config.boardId;
    publish({ scopeKey: resourceScopeKey(config), data: empty(), idMapping: [], loaded: false, error: null, mutation: idleMutation(), source,
      status: !source.readApi ? source.status : missingBoard ? "scope-required" : "idle" });
    if (!source.readApi || missingBoard) return null;
    // Board changes may cancel an old write whose outcome is still unknown.
    // Reads for the new scope may proceed; writes remain single-flight.
    return refresh();
  }
  async function mutate(action, id, input) {
    const source = resolveDataSource(config);
    if (!source.writeApi || (["tasks", "widgets"].includes(resource) && !config.boardId)) throw new SlowlyApiError("API writes require explicit source readiness and allowWrites.", { code: "API_WRITES_DISABLED", outcome: "not-sent" });
    if (!snapshot.loaded) throw new SlowlyApiError("Load this resource successfully before writing.", { code: "READ_REQUIRED", outcome: "not-sent" });
    if (writeActive) throw new SlowlyApiError("Another write is still in flight.", { code: "MUTATION_IN_PROGRESS", outcome: "not-sent" });
    if (createIntent) throw new SlowlyApiError("Resolve the unknown create before writing.", { code: "RECOVERY_REQUIRED", outcome: "not-sent" });
    if (resource === "workspace" && action !== "update") throw new SlowlyApiError("Workspace setup is an explicit separate operation.", { code: "UNSUPPORTED_OPERATION", outcome: "not-sent" });
    if ((resource === "workspace" && id !== config.workspaceId) || (input?.workspaceId !== undefined && input.workspaceId !== config.workspaceId) || (input?.boardId !== undefined && input.boardId !== config.boardId)) throw new SlowlyApiError("Mutation scope does not match the selected resource.", { code: "SCOPE_MISMATCH", outcome: "not-sent" });
    const scope = { ...config }; const epoch = generation;
    readSequence++; readAbort?.abort(); writeAbort = new AbortController(); const controller = writeAbort; writeActive = true; writeGeneration = epoch;
    publish({ status: snapshot.status === "loading" ? "idle" : snapshot.status, mutation: { status: "loading", error: null, result: null } });
    try {
      const options = { signal: controller.signal }; const singular = resources[resource];
      const parent = resource === "workspace" ? {} : { workspaceId: scope.workspaceId, ...(["tasks", "widgets"].includes(resource) ? { boardId: scope.boardId } : {}) };
      // Scope is supplied by this controller, not caller-overridable input.
      const body = { ...input, ...parent };
      if (action === "create") {
        createIntent = createSafeCreateIntent(api, resource, body);
        publish({ createRecovery: { operationKey: createIntent.operationKey, scope: createIntent.scope, state: "PENDING" } });
      }
      const result = action === "create" ? await createIntent.send(options)
        : action === "update" ? await api[`update${singular}`](resource === "workspace" ? scope.workspaceId : id, body, options)
          : action === "delete" ? await api[`delete${singular}`](id, body, options)
            : await api[`reorder${singular}s`](body, options);
      if (epoch === generation && !controller.signal.aborted) {
        let data;
        if (resource === "workspace") data = validate(result, scope);
        else if (action === "delete") data = snapshot.data.filter(item => item.id !== id);
        else {
          const changes = action === "reorder" ? result : [result]; validate(changes, scope);
          const byId = new Map(snapshot.data.map(item => [item.id, item]));
          for (const item of changes) byId.set(item.id, item);
          data = [...byId.values()].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
        }
        publish({ data, idMapping: mapping(data), status: "success", error: null, mutation: { status: "success", error: null, result } });
        if (action === "create") { createIntent = null; publish({ createRecovery: null }); }
      }
      return result;
    } catch (error) {
      if (epoch === generation && !controller.signal.aborted) publish({ mutation: { status: "error", error, result: null, outcome: error.outcome ?? "not-confirmed" } });
      if (action === "create" && epoch === generation && !controller.signal.aborted) {
        const uncertain = error.outcome !== "rejected" && error.outcome !== "not-sent" || ["CONFLICT", "MIGRATION_LOCKED"].includes(error.code);
        if (!uncertain) { createIntent = null; publish({ createRecovery: null }); }
        else {
          publish({ createRecovery: { operationKey: createIntent.operationKey, scope: createIntent.scope, state: "UNKNOWN" } });
          writeActive = false;
          try { const receipt = await recoverCreate(); if (receipt?.state === "CONFIRMED") return receipt.result; }
          catch { /* Retain the original intent for explicit recovery. */ }
        }
      }
      throw error;
    } finally { writeActive = false; }
  }
  async function recoverCreate() {
    if (!createIntent || writeActive || config.workspaceId !== createIntent.scope.workspaceId ||
      (["tasks", "widgets"].includes(resource) && config.boardId !== createIntent.scope.boardId) || !resolveDataSource(config).readApi) {
      throw new SlowlyApiError("Return to the original API scope to recover this create.", { code: "RECOVERY_REQUIRED", outcome: "not-sent" });
    }
    const intent = createIntent;
    const epoch = generation;
    let receipt;
    try { receipt = await intent.lookup(); }
    catch (error) {
      if (epoch === generation) publish({ createRecovery: { operationKey: intent.operationKey, scope: intent.scope, state: error.code === "OPERATION_CONFLICT" ? "CONFLICT" : "UNKNOWN" }, mutation: { status: "UNKNOWN", error, result: null, outcome: "not-confirmed" } });
      throw error;
    }
    if (epoch !== generation) return null;
    if (receipt.state === "CONFIRMED") {
      await refresh();
      if (epoch !== generation) return null;
      createIntent = null;
      publish({ createRecovery: { operationKey: intent.operationKey, scope: intent.scope, state: "CONFIRMED" }, mutation: { status: "success", error: null, result: receipt.result, operationKey: intent.operationKey } });
    } else publish({ createRecovery: { operationKey: intent.operationKey, scope: intent.scope, state: "UNKNOWN", receiptState: "NOT_FOUND" }, mutation: { status: "UNKNOWN", error: null, result: null, outcome: "not-confirmed", operationKey: intent.operationKey, receiptState: "NOT_FOUND" } });
    return receipt;
  }
  async function resendCreate() {
    const receipt = await recoverCreate();
    if (!receipt || receipt.state === "CONFIRMED") return receipt;
    if (!resolveDataSource(config).writeApi) throw new SlowlyApiError("Explicit API write permission required.", { code: "API_WRITES_DISABLED", outcome: "not-sent" });
    writeActive = true;
    try { await createIntent.resend(); }
    catch (error) { publish({ mutation: { status: "UNKNOWN", error, result: null } }); }
    finally { writeActive = false; }
    return recoverCreate();
  }
  return {
    getSnapshot: () => snapshot, getServerSnapshot: () => initial,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    select, refresh, cancel, recoverCreate, resendCreate,
    create: input => mutate("create", null, input), update: (id, input) => mutate("update", id, input),
    remove: (id, input) => mutate("delete", id, input), reorder: entries => mutate("reorder", null, { entries }),
  };
}
