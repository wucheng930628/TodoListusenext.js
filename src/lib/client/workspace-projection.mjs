/** Pre-cutover managed snapshot → UI model. No SDK, storage or network access. */
export function projectWorkspaceForUi(items) {
  const fail = message => { throw new Error(`Invalid managed projection: ${message}`); };
  if (!Array.isArray(items) || !items.length || new Set(items.map(item => item.id)).size !== items.length) fail("duplicate/missing items");
  const roots = items.filter(item => item.entityType === "WORKSPACE");
  if (roots.length !== 1) fail("one workspace required");
  const root = roots[0]; const boards = items.filter(item => item.entityType === "BOARD");
  const boardIds = new Set(boards.map(item => item.id));
  for (const item of items) {
    if (!["WORKSPACE", "BOARD", "TASK", "WIDGET"].includes(item.entityType) || item.schemaVersion !== 1 || !Number.isSafeInteger(item.version) || item.version < 1 || !Number.isSafeInteger(item.position) || item.position < 0 || !item.data || !Array.isArray(item.restoreShape?.dataKeys)) fail("schema");
    if (item !== root && item.workspaceId !== root.id) fail("workspace ownership");
    if (item.entityType === "BOARD" && (item.parentId !== root.id || typeof item.restoreShape.widgetsPresent !== "boolean")) fail("board metadata");
    if (["TASK", "WIDGET"].includes(item.entityType) && (!boardIds.has(item.boardId) || item.parentId !== item.boardId)) fail("parent-child");
    if (item.restoreShape.dataKeys.some(key => !Object.hasOwn(item.data, key))) fail("missing source fields");
  }
  const sorted = rows => [...rows].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const source = item => Object.fromEntries(item.restoreShape.dataKeys.map(key => [key, structuredClone(item.data[key])]));
  const unique = rows => { if (new Set(rows.map(item => item.data.id)).size !== rows.length || new Set(rows.map(item => item.position)).size !== rows.length) fail("duplicate frontend IDs or positions"); };
  unique(boards);
  const workspace = { ...source(root), boards: sorted(boards).map(board => {
    const tasks = items.filter(item => item.entityType === "TASK" && item.boardId === board.id);
    const widgets = items.filter(item => item.entityType === "WIDGET" && item.boardId === board.id);
    unique(tasks); unique(widgets);
    if (!board.restoreShape.widgetsPresent && widgets.length) fail("implicit widgets cannot have persisted children");
    return { ...source(board), tasks: sorted(tasks).map(source), ...(board.restoreShape.widgetsPresent ? { widgets: sorted(widgets).map(source) } : {}) };
  }) };
  return { workspace, idMapping: items.map(item => ({ entityType: item.entityType, databaseId: item.id, frontendId: item.data.id ?? null, workspaceId: item.workspaceId ?? root.id, boardId: item.boardId ?? null, version: item.version, position: item.position })),
    widgetPresence: Object.fromEntries(boards.map(board => [board.id, board.restoreShape.widgetsPresent ? "present" : "absent"])) };
}
