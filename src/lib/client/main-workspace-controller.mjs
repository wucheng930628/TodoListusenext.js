import { createSlowlyApi, SlowlyApiError } from "./slowly-api.mjs";
import { projectMainView, reference, encodeMainPatch, encodeMainCreate } from "./main-view-model.mjs";
import { createSafeCreateIntent } from "./safe-create.mjs";

const error = (code, message) => new SlowlyApiError(message, { code, outcome: "not-sent" });
export function createMainWorkspaceController({ api = createSlowlyApi(), readView = api.getWorkspaceView, development = process.env.NODE_ENV === "development" } = {}) {
  let state = { mode: "localStorage", status: "idle", workspaceId: null, activeBoardId: null, projection: null, allowWrites: false, mutation: "idle", error: null, uncertainWrite: false, operation: null, createRecovery: null, recoveredCreateRevision: 0, scopeRevision: 0 };
  const initial = state; const listeners = new Set(); let epoch = 0; let readAbort; let writeAbort; let pending = false;
  const drafts = new Map(); // Page-memory only; never mixed into DTOs or localStorage.
  let createIntent;
  const publish = patch => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  const currentBoard = () => state.projection?.workspace.boards.find(board => board.id === state.activeBoardId);
  function cancel() {
    epoch++; readAbort?.abort(); writeAbort?.abort();
    publish({ ...(pending ? { uncertainWrite: true, mutation: "not-confirmed", allowWrites: false,
      ...(createIntent ? { createRecovery: { operationKey: createIntent.operationKey, state: "UNKNOWN", checking: false } } : {}) } : {}), status: state.projection ? "success" : "idle" });
  }
  async function refresh() {
    if (state.mode !== "api") return;
    if (pending) throw error("MUTATION_IN_PROGRESS", "請等待目前的寫入結果。");
    readAbort?.abort(); readAbort = new AbortController(); const signal = readAbort.signal; const current = ++epoch; const workspaceId = state.workspaceId;
    publish({ status: "loading", error: null });
    try {
      if (typeof readView !== "function") throw error("VIEW_API_APPROVAL_REQUIRED", "需要批准權威資料投影與 Readiness API，現在不能安全啟用。");
      const snapshot = await readView(workspaceId, { signal });
      if (current !== epoch || signal.aborted) return;
      if (!snapshot || snapshot.readiness?.workspaceId !== workspaceId || snapshot.readiness.apiReady !== true || snapshot.readiness.eligible !== true) {
        const reasons = { WORKSPACE_COUNT_REQUIRED: "Workspace 缺少完整計數資料，需人工確認", WIDGET_PRESENCE_REQUIRED: "Widget 缺省資訊不完整，不能推測", WORKSPACE_ORIGIN_REQUIRED: "Workspace 來源尚未確認", MIGRATION_NOT_READY: "Migration 尚未完整 Release", MIGRATION_LOCKED: "Migration 鎖定尚未解除" };
        const detail = snapshot?.readiness?.blockers?.map(item => reasons[item.code] || item.code).join("；");
        throw error("READINESS_REQUIRED", `API Ready／Readiness 未通過，保持停用。${detail || ""}`);
      }
      const projection = projectMainView(snapshot, workspaceId);
      const activeBoardId = projection.workspace.boards.some(board => board.id === state.activeBoardId) ? state.activeBoardId
        : projection.workspace.boards.some(board => board.id === projection.workspace.activeBoardId) ? projection.workspace.activeBoardId : projection.workspace.boards[0]?.id || null;
      publish({ projection, activeBoardId, status: "success", error: null });
    } catch (cause) { if (current !== epoch || signal.aborted) return; publish({ status: "error", error: cause, allowWrites: false }); throw cause; }
  }
  function authorizeWrites(confirmation) {
    if (state.mode !== "api" || state.status !== "success" || state.uncertainWrite || confirmation !== state.workspaceId) throw error("WRITES_DISABLED", "請先讀取指定 Workspace，確認後另外授權寫入。");
    publish({ allowWrites: true });
  }
  function requireWritable() {
    if (state.mode !== "api" || state.status !== "success" || !state.allowWrites || state.uncertainWrite || pending) throw error("WRITES_DISABLED", "唯讀、結果不明或仍有操作進行，不能寫入。");
  }
  async function recoverCreate() {
    if (!createIntent || pending || state.mode !== "api" || state.workspaceId !== createIntent.scope.workspaceId) throw error("RECOVERY_REQUIRED", "請切回原 Workspace，再查詢新增結果。");
    const intent = createIntent;
    const current = ++epoch;
    publish({ createRecovery: { operationKey: intent.operationKey, state: "UNKNOWN", checking: true }, allowWrites: false });
    try {
      const receipt = await intent.lookup();
      if (current !== epoch) return null;
      if (receipt.state === "CONFIRMED") {
        // Refresh current server state, including later edits or deletion. Never merge the original create DTO.
        await refresh();
        if (createIntent !== intent || state.mode !== "api" || state.workspaceId !== intent.scope.workspaceId || state.status !== "success") return null;
        createIntent = null;
        publish({ uncertainWrite: false, mutation: "success", error: null, recoveredCreateRevision: state.recoveredCreateRevision + 1,
          createRecovery: { operationKey: intent.operationKey, state: "CONFIRMED", checking: false } });
        return receipt;
      }
      publish({ createRecovery: { operationKey: intent.operationKey, state: "UNKNOWN", receiptState: "NOT_FOUND", checking: false } });
      return receipt;
    } catch (cause) {
      if (state.mode === "api" && state.workspaceId === intent.scope.workspaceId && createIntent === intent) publish({ createRecovery: { operationKey: intent.operationKey, state: cause.code === "OPERATION_CONFLICT" ? "CONFLICT" : "UNKNOWN", checking: false }, error: cause });
      throw cause;
    }
  }
  async function resendCreate(confirmation) {
    if (!createIntent || pending || state.createRecovery?.checking || state.createRecovery?.state === "CONFLICT" || confirmation !== state.workspaceId || state.mode !== "api" || state.workspaceId !== createIntent.scope.workspaceId) throw error("RECOVERY_REQUIRED", "請確認原 Workspace 與新增操作。");
    const receipt = await recoverCreate();
    if (!receipt || receipt.state === "CONFIRMED") return receipt;
    const intent = createIntent;
    pending = true;
    publish({ mutation: "loading" });
    try { await intent.resend(); }
    catch (cause) { publish({ error: cause }); }
    finally { pending = false; publish({ mutation: "not-confirmed", uncertainWrite: true }); }
    return recoverCreate();
  }
  async function mutate(action, kind, invoke, merge, intent) {
    requireWritable();
    const projection = state.projection; const workspaceId = state.workspaceId; const boardId = state.activeBoardId; const current = ++epoch;
    readAbort?.abort(); writeAbort = new AbortController(); const signal = writeAbort.signal; pending = true;
    if (intent) createIntent = intent;
    publish({ mutation: "loading", error: null, operation: { action, kind } }); let result; let acknowledged = false;
    try {
      result = await invoke({ api, projection, workspaceId, boardId, signal });
      acknowledged = true;
      if (current !== epoch || signal.aborted) return result;
      const snapshot = structuredClone(projection.snapshot); merge(snapshot, result);
      publish({ projection: projectMainView(snapshot, workspaceId), mutation: "success", error: null });
      if (intent) createIntent = null;
    } catch (cause) {
      if (current === epoch && !signal.aborted) {
        const uncertain = acknowledged || cause.outcome === "not-confirmed" || !cause.code || (action === "create" && ["CONFLICT", "MIGRATION_LOCKED"].includes(cause.code));
        if (intent && !uncertain) createIntent = null;
        const authorityChanged = cause.code === "MIGRATION_LOCKED" || [403, 404].includes(cause.status);
        publish({ mutation: uncertain ? "not-confirmed" : "error", error: cause, uncertainWrite: uncertain,
          ...(intent && uncertain ? { createRecovery: { operationKey: intent.operationKey, state: "UNKNOWN", checking: false } } : {}),
          ...(uncertain || authorityChanged ? { allowWrites: false } : {}), ...(authorityChanged ? { status: "error" } : {}) });
        if (intent && uncertain) {
          pending = false;
          try { const receipt = await recoverCreate(); if (receipt?.state === "CONFIRMED") return receipt.result; }
          catch { /* UNKNOWN remains visible until an explicit receipt query succeeds. */ }
        }
      }
      throw cause;
    } finally { pending = false; }
    // Refresh parent versions and authority after acknowledged writes; never retry the write.
    if (current === epoch && !signal.aborted) {
      try { await refresh(); }
      catch { /* Confirmed write remains success; UI separately shows refresh error and disables further writes. */ }
    }
    return result;
  }
  const entryFor = (snapshot, boardId) => snapshot.boards.find(entry => entry.board.id === boardId);
  function entity(type, frontendId, boardFrontendId = state.activeBoardId) {
    const ref = reference(state.projection, type, frontendId, type === "board" ? undefined : boardFrontendId);
    const record = type === "board" ? state.projection.snapshot.boards.find(entry => entry.board.id === ref.databaseId).board
      : entryFor(state.projection.snapshot, ref.boardId)[type === "task" ? "tasks" : "widgets"].find(item => item.id === ref.databaseId);
    return { ref, record };
  }
  async function saveEntity(type, data, { expectedVersion } = {}) {
    requireWritable();
    const existing = type === "board" ? state.projection?.workspace.boards.find(item => item.id === data.id) : currentBoard()?.[type === "task" ? "tasks" : "widgets"]?.find(item => item.id === data.id);
    const name = type[0].toUpperCase() + type.slice(1); let ref; let payload;
    if (existing) {
      ({ ref } = entity(type, data.id));
      if (expectedVersion !== undefined && expectedVersion !== ref.version) throw new SlowlyApiError("草稿版本已過時，請先比對最新資料。", { status: 409, code: "CONFLICT", outcome: "not-sent" });
      payload = encodeMainPatch(type, existing, data, { subtaskExtensions: state.projection.snapshot.readiness?.capabilities?.subtaskExtensions === true });
      if (!Object.keys(payload).length) return null;
    } else payload = encodeMainCreate(type, { ...data, id: data.id || crypto.randomUUID() });
    const board = type === "board" ? null : reference(state.projection, "board", state.activeBoardId);
    if (type === "widget" && !existing && !Object.hasOwn(currentBoard(), "widgets") && state.projection.snapshot.readiness?.capabilities?.widgetPresenceWrites !== true) throw error("WIDGET_PRESENCE_REQUIRED", "現有 API 尚不能安全建立缺省 Widget 清單。");
    const rows = type === "board" ? state.projection.snapshot.boards.map(entry => entry.board) : entryFor(state.projection.snapshot, board.databaseId)[type === "task" ? "tasks" : "widgets"];
    const position = Math.max(-1, ...rows.map(row => row.position)) + 1;
    const createInput = { workspaceId: state.workspaceId, ...(board ? { boardId: board.databaseId } : {}), data: payload, position };
    const intent = existing ? null : createSafeCreateIntent(api, `${type}s`, createInput);
    return mutate(existing ? "update" : "create", type, ({ api, workspaceId, signal }) => {
      const input = { workspaceId, ...(board ? { boardId: board.databaseId } : {}), data: payload, ...(existing ? { version: ref.version } : { position }) };
      return existing ? api[`update${name}`](ref.databaseId, input, { signal }) : intent.send({ signal });
    }, (snapshot, result) => {
      if (type === "board") { const entry = entryFor(snapshot, result.id); if (entry) entry.board = result; else snapshot.boards.push({ board: result, tasks: [], widgets: [], widgetsPresence: "absent" }); }
      else { const entry = entryFor(snapshot, board.databaseId); const key = type === "task" ? "tasks" : "widgets"; entry[key] = [...entry[key].filter(item => item.id !== result.id), result]; if (type === "widget") entry.widgetsPresence = "present"; }
    }, intent);
  }
  async function removeEntity(type, frontendId, { expectedVersion } = {}) {
    requireWritable();
    const { ref } = entity(type, frontendId); const name = type[0].toUpperCase() + type.slice(1);
    if (expectedVersion !== undefined && expectedVersion !== ref.version) throw new SlowlyApiError("刪除草稿版本已過時。", { status: 409, code: "CONFLICT", outcome: "not-sent" });
    return mutate("delete", type, ({ api, workspaceId, signal }) => api[`delete${name}`](ref.databaseId, { workspaceId, ...(ref.boardId ? { boardId: ref.boardId } : {}), version: ref.version }, { signal }), snapshot => {
      if (type === "board") snapshot.boards = snapshot.boards.filter(entry => entry.board.id !== ref.databaseId);
      else { const entry = entryFor(snapshot, ref.boardId); const key = type === "task" ? "tasks" : "widgets"; entry[key] = entry[key].filter(item => item.id !== ref.databaseId); }
    });
  }
  async function reorder(type, frontendIds) {
    requireWritable();
    const rows = type === "board" ? state.projection.workspace.boards : currentBoard()[type === "task" ? "tasks" : "widgets"] || [];
    if (frontendIds.length !== rows.length || new Set(frontendIds).size !== rows.length || frontendIds.some(id => !rows.some(row => row.id === id)) || frontendIds.length > (type === "board" ? 99 : 98)) throw error("ORDER_UNSUPPORTED", "排序必須包含完整清單；看板最多 99 筆，任務／Widget 最多 98 筆。");
    if (!frontendIds.length) return;
    const entries = frontendIds.map((id, position) => { const { ref } = entity(type, id); return { id: ref.databaseId, version: ref.version, position }; });
    const board = type === "board" ? null : reference(state.projection, "board", state.activeBoardId);
    const name = type[0].toUpperCase() + type.slice(1);
    return mutate("reorder", type, ({ api, workspaceId, signal }) => api[`reorder${name}s`]({ workspaceId, ...(board ? { boardId: board.databaseId } : {}), entries }, { signal }), (snapshot, result) => {
      for (const record of result) { if (type === "board") entryFor(snapshot, record.id).board = record; else { const entry = entryFor(snapshot, board.databaseId); const key = type === "task" ? "tasks" : "widgets"; entry[key] = entry[key].map(item => item.id === record.id ? record : item); } }
    });
  }
  return {
    getSnapshot: () => state, getServerSnapshot: () => initial, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, refresh, authorizeWrites, cancel, recoverCreate, resendCreate,
    readDraft: key => structuredClone(drafts.get(key) ?? null),
    writeDraft(key, value) { drafts.set(key, structuredClone(value)); },
    clearDraft(key, expected) { if (expected === undefined || JSON.stringify(drafts.get(key)) === JSON.stringify(expected)) drafts.delete(key); },
    async activate({ workspaceId, apiReady }) {
      if (!development || apiReady !== true || !/^SLOWLY#WORKSPACE#[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(workspaceId || "")) throw error("API_MODE_DISABLED", "僅限開發環境，需明確指定 Workspace 與 API Ready。");
      cancel(); publish({ ...initial, mode: "api", workspaceId, uncertainWrite: state.uncertainWrite, createRecovery: state.createRecovery, scopeRevision: state.scopeRevision + 1 }); return refresh();
    },
    deactivate() { cancel(); publish({ ...initial, uncertainWrite: state.uncertainWrite, createRecovery: state.createRecovery, scopeRevision: state.scopeRevision + 1 }); },
    selectBoard(frontendId) {
      if (!state.projection?.workspace.boards.some(board => board.id === frontendId)) throw error("BOARD_NOT_FOUND", "看板不存在。");
      cancel(); publish({ activeBoardId: frontendId, allowWrites: false, scopeRevision: state.scopeRevision + 1 });
    },
    saveTask: (data, options) => saveEntity("task", data, options), saveBoard: (data, options) => saveEntity("board", data, options), saveWidget: (data, options) => saveEntity("widget", data, options),
    deleteTask: (id, options) => removeEntity("task", id, options), deleteWidget: (id, options) => removeEntity("widget", id, options), deleteBoard: (id, options) => removeEntity("board", id, options),
    reorderTasks: ids => reorder("task", ids), reorderBoards: ids => reorder("board", ids), reorderWidgets: ids => reorder("widget", ids),
  };
}
