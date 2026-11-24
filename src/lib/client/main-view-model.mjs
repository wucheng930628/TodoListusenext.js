import { SlowlyApiError } from "./slowly-api.mjs";

const fields = {
  task: ["title", "description", "status", "tag", "priority", "urgent", "date", "time", "subtasks", "notes"],
  board: ["name", "description", "wipLimit", "analyticsSize", "settings"],
  widget: ["type", "span", "height", "manualSize", "config"],
};
const configFields = ["text", "minutes", "taskId", "endsAt", "remaining", "showCompleted"];
export function widgetConfigForTypeChange(config) {
  return Object.fromEntries(Object.entries(config ?? {}).filter(([key]) => !configFields.includes(key)));
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code, message) => { throw new SlowlyApiError(message, { code, outcome: "not-sent" }); };
const sorted = rows => [...rows].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
function dto(item, type, workspaceId, boardId) {
  if (!item || !new RegExp(`^SLOWLY#${type}#[a-f0-9-]{36}$`).test(item.id) || !Number.isSafeInteger(item.version) || item.version < 1 || !Number.isSafeInteger(item.position) || item.position < 0 || !item.data || Object.getPrototypeOf(item.data) !== Object.prototype ||
    (type !== "WORKSPACE" && (typeof item.data.id !== "string" || !item.data.id || item.workspaceId !== workspaceId)) || (boardId && item.boardId !== boardId)) fail("INVALID_VIEW", "API 資料歸屬或版本不正確。");
}
function unique(rows) {
  if (!Array.isArray(rows) || rows.some(item => !item?.data || typeof item.data.id !== "string")) fail("INVALID_VIEW", "API 清單或前端 ID 格式不正確。");
  if (!Array.isArray(rows) || new Set(rows.map(item => item.id)).size !== rows.length || new Set(rows.map(item => item.data.id)).size !== rows.length) fail("DUPLICATE_ID", "同一父項中的 ID 重複，無法安全顯示。");
}

// Input authority is supplied by the server/test harness, never inferred from empty lists.
export function projectMainView(snapshot, workspaceId) {
  dto(snapshot?.workspace, "WORKSPACE");
  if (snapshot.workspace.id !== workspaceId || !Array.isArray(snapshot.boards)) fail("SCOPE_MISMATCH", "Workspace 不一致。");
  const records = []; const mapping = [];
  const add = (record, type, boardFrontendId = null) => {
    records.push(record); mapping.push({ type, frontendId: record.data.id ?? null, databaseId: record.id, workspaceId, boardId: record.boardId ?? null, boardFrontendId, version: record.version, position: record.position });
    return structuredClone(record.data);
  };
  const root = add(snapshot.workspace, "workspace");
  unique(snapshot.boards.map(entry => entry.board));
  const boards = sorted(snapshot.boards.map(entry => entry.board)).map(board => {
    const entry = snapshot.boards.find(entry => entry.board.id === board.id);
    dto(board, "BOARD", workspaceId); unique(entry.tasks); unique(entry.widgets);
    if (!["present", "absent"].includes(entry.widgetsPresence) || (entry.widgetsPresence === "absent" && entry.widgets.length)) fail("WIDGET_PRESENCE_REQUIRED", "缺少權威 Widget 狀態或與資料衝突，不能推測。");
    const data = add(board, "board");
    const children = (rows, type) => sorted(rows).map(item => { dto(item, type.toUpperCase(), workspaceId, board.id); return add(item, type, board.data.id); });
    return { ...data, tasks: children(entry.tasks, "task"), ...(entry.widgetsPresence === "present" ? { widgets: children(entry.widgets, "widget") } : {}) };
  });
  if (new Set(records.map(item => item.id)).size !== records.length) fail("DUPLICATE_ID", "資料庫 ID 重複。");
  return { workspace: { ...root, boards }, mapping, snapshot: structuredClone(snapshot) };
}

export function reference(projection, type, frontendId, boardFrontendId) {
  const matches = projection.mapping.filter(item => item.type === type && item.frontendId === frontendId && (!boardFrontendId || item.boardFrontendId === boardFrontendId));
  if (matches.length !== 1) fail("ID_MAPPING_REQUIRED", "找不到唯一的資料庫 ID 對應。");
  return matches[0];
}

// Only changed, supported fields are sent. Unchanged extensions remain on the server.
export function encodeMainPatch(type, before, after, { subtaskExtensions = false } = {}) {
  if (before.id !== after.id) fail("IMMUTABLE_ID", "不能修改前端 ID。");
  const patch = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (equal(before[key], after[key])) continue;
    if (!fields[type]?.includes(key) || after[key] === undefined) fail("UNSUPPORTED_FIELD", `現有 API 無法安全修改欄位：${key}`);
    patch[key] = structuredClone(after[key]);
  }
  if (patch.subtasks) {
    patch.subtasks = patch.subtasks.map(item => {
      const previous = before.subtasks.find(old => old.id === item.id);
      const extras = Object.keys(item).filter(key => !["id", "title", "done"].includes(key));
      const oldExtras = Object.keys(previous || {}).filter(key => !["id", "title", "done"].includes(key));
      if ([...extras, ...oldExtras].some(key => !equal(item[key], previous?.[key])) || (!subtaskExtensions && (extras.length || oldExtras.length))) fail("SUBTASK_EXTENSION_UNSUPPORTED", "此子任務含未知來源欄位，需後端依 ID 保留後才可修改。");
      return { id: item.id, title: item.title, done: item.done };
    });
  }
  if (type === "widget" && patch.type) patch.config ??= after.config ?? {};
  if (patch.config) {
    const extras = new Set([...Object.keys(before.config || {}), ...Object.keys(after.config)].filter(key => !configFields.includes(key)));
    for (const key of extras) if (!equal(before.config?.[key], after.config[key])) fail("UNSUPPORTED_FIELD", "不能透過既有 API 修改未知 Widget config。");
    patch.config = Object.fromEntries(Object.entries(after.config).filter(([key]) => configFields.includes(key)));
  }
  return patch;
}

export function encodeMainCreate(type, data) {
  const allowed = ["id", ...(fields[type] || [])];
  if (Object.keys(data).some(key => !allowed.includes(key))) fail("UNSUPPORTED_FIELD", "新增資料包含 API 不支援的欄位。");
  return structuredClone(data);
}
