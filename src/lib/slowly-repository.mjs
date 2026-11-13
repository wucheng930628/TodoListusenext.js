import "server-only";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { DataError, INDEX_NAME, assertId, assertItemSize, makeItem, requireValue, validateData } from "./data-model.mjs";

// No SDK client is constructed here: tests inject an isolated document-client double.
export function createRepository(db, { tableName = "SlowlyTasks", clock = () => new Date().toISOString() } = {}) {
  const get = async (type, id) => {
    assertId(id, type);
    const { Item: item } = await db.send(new GetCommand({ TableName: tableName, Key: { id }, ConsistentRead: true }));
    requireValue(item?.entityType === type && item.schemaVersion === 1, `${type} not found or unsupported`, "NOT_FOUND");
    return item;
  };
  function expected(item, version) { requireValue(Number.isSafeInteger(version) && version === item.version, "Version conflict; reload before retrying", "CONFLICT"); }
  function put(item, previous) {
    assertItemSize(item);
    return { Put: { TableName: tableName, Item: item, ConditionExpression: previous ? "#v = :v AND #t = :t" : "attribute_not_exists(id)", ...(previous ? { ExpressionAttributeNames: { "#v": "version", "#t": "entityType" }, ExpressionAttributeValues: { ":v": previous.version, ":t": previous.entityType } } : {}) } };
  }
  function remove(item) { return { Delete: { TableName: tableName, Key: { id: item.id }, ConditionExpression: "#v = :v AND #t = :t", ExpressionAttributeNames: { "#v": "version", "#t": "entityType" }, ExpressionAttributeValues: { ":v": item.version, ":t": item.entityType } } }; }
  async function commit(actions) {
    requireValue(actions.length <= 100 && Buffer.byteLength(JSON.stringify(actions)) < 3500000, "Transaction too large");
    try { await db.send(new TransactWriteCommand({ TransactItems: actions })); }
    catch (error) {
      if (["ConditionalCheckFailedException", "TransactionConflictException"].includes(error.name) || (error.name === "TransactionCanceledException" && error.CancellationReasons?.some(reason => ["ConditionalCheckFailed", "TransactionConflict"].includes(reason.Code)))) throw new DataError("CONFLICT", "Concurrent change; reload before retrying", { cause: error });
      throw new DataError("STORAGE", "DynamoDB operation failed", { cause: error });
    }
  }
  function revised(item, changes) { return { ...item, ...changes, version: item.version + 1, updatedAt: clock() }; }
  async function list(type, parent) {
    await get(type === "BOARD" ? "WORKSPACE" : "BOARD", parent);
    const items = []; let cursor;
    do {
      const response = await db.send(new QueryCommand({ TableName: tableName, IndexName: INDEX_NAME, KeyConditionExpression: "gsi1pk = :parent AND begins_with(gsi1sk, :type)", ExpressionAttributeValues: { ":parent": parent, ":type": `${type}#` }, ExclusiveStartKey: cursor }));
      items.push(...(response.Items || [])); cursor = response.LastEvaluatedKey;
    } while (cursor);
    return items.filter(item => item.entityType === type && item.parentId === parent).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  }
  async function createWorkspace(data) {
    const item = makeItem("WORKSPACE", data, { now: clock() });
    await commit([put(item)]); return item;
  }
  async function saveWorkspace(id, data, version) {
    const previous = await get("WORKSPACE", id); expected(previous, version);
    const item = revised(previous, { data: validateData("WORKSPACE", data) });
    await commit([put(item, previous)]); return item;
  }
  async function createBoard(workspaceId, data, position = 0) {
    const parent = await get("WORKSPACE", workspaceId);
    const item = makeItem("BOARD", data, { parent: workspaceId, position, now: clock() });
    await commit([put(item), put(revised(parent, {}), parent)]); return item;
  }
  async function updateBoard(id, data, version) {
    const previous = await get("BOARD", id); expected(previous, version);
    const validated = validateData("BOARD", data);
    requireValue(validated.id === previous.data.id, "Frontend id is immutable");
    requireValue(validated.wipLimit >= previous.doingCount, "WIP limit is below current task count", "WIP_LIMIT");
    const item = revised(previous, { data: validated }); await commit([put(item, previous)]); return item;
  }
  async function deleteBoard(id, version) {
    const board = await get("BOARD", id); expected(board, version);
    requireValue(board.taskCount === 0 && board.widgetCount === 0, "Only empty boards may be deleted", "NOT_EMPTY");
    const parent = await get("WORKSPACE", board.workspaceId);
    await commit([remove(board), put(revised(parent, {}), parent)]);
  }
  async function childChange(type, boardId, id, data, version, position, preserveCompletionTime = false) {
    const board = await get("BOARD", boardId);
    const previous = id ? await get(type, id) : null;
    if (previous) { expected(previous, version); requireValue(previous.boardId === boardId && previous.workspaceId === board.workspaceId, "Entity belongs to a different board", "OWNERSHIP"); }
    const deleting = data === null;
    requireValue(!deleting || previous, "Delete requires an existing entity");
    let item;
    if (!deleting) {
      const validated = validateData(type, data);
      if (previous) requireValue(validated.id === previous.data.id, "Frontend id is immutable");
      if (type === "TASK") validated.completedAt = validated.status === "done"
        ? previous?.data.status === "done" ? previous.data.completedAt || null
          : !previous && preserveCompletionTime ? validated.completedAt ?? null : clock()
        : null;
      item = previous ? revised(previous, { data: validated }) : makeItem(type, validated, { parent: boardId, workspaceId: board.workspaceId, position: position ?? 0, now: clock() });
    }
    const countKey = type === "TASK" ? "taskCount" : "widgetCount";
    const doingCount = board.doingCount + (type === "TASK" ? Number(item?.data.status === "doing") - Number(previous?.data.status === "doing") : 0);
    requireValue(doingCount <= board.data.wipLimit && doingCount >= 0, "WIP limit exceeded", "WIP_LIMIT");
    const nextBoard = revised(board, { [countKey]: board[countKey] + (previous ? deleting ? -1 : 0 : 1), doingCount });
    await commit([deleting ? remove(previous) : put(item, previous), put(nextBoard, board)]);
    return item ?? null;
  }
  async function reorder(type, parentId, entries) {
    requireValue(["BOARD", "TASK", "WIDGET"].includes(type), "Unsupported order type");
    requireValue(Array.isArray(entries) && entries.length > 0 && entries.length <= 99 && new Set(entries.map(entry => entry.id)).size === entries.length, "Supply 1–99 unique order entries");
    const parent = await get(type === "BOARD" ? "WORKSPACE" : "BOARD", parentId);
    const items = await Promise.all(entries.map(async entry => {
      const old = await get(type, entry.id); expected(old, entry.version);
      requireValue(old.parentId === parentId, "Entity belongs to a different parent", "OWNERSHIP");
      requireValue(Number.isSafeInteger(entry.position) && entry.position >= 0 && entry.position <= 999999999999, "Invalid position");
      return { old, item: revised(old, { position: entry.position, gsi1sk: `${type}#${String(entry.position).padStart(12, "0")}#${old.id}` }) };
    }));
    await commit([...items.map(({ old, item }) => put(item, old)), put(revised(parent, {}), parent)]);
    return items.map(({ item }) => item);
  }
  return {
    createWorkspace, getWorkspace: id => get("WORKSPACE", id), saveWorkspace,
    createBoard, getBoard: id => get("BOARD", id), updateBoard, deleteBoard,
    listBoards: id => list("BOARD", id), listTasks: id => list("TASK", id), listWidgets: id => list("WIDGET", id),
    getTask: id => get("TASK", id), getWidget: id => get("WIDGET", id),
    createTask: (boardId, data, position, { preserveCompletionTime = false } = {}) => childChange("TASK", boardId, null, data, null, position, preserveCompletionTime),
    updateTask: (boardId, id, data, version) => childChange("TASK", boardId, id, data, version),
    deleteTask: (boardId, id, version) => childChange("TASK", boardId, id, null, version),
    async setTaskStatus(boardId, id, status, urgent, version) {
      const task = await get("TASK", id);
      return childChange("TASK", boardId, id, { ...task.data, status, urgent }, version);
    },
    createWidget: (boardId, data, position) => childChange("WIDGET", boardId, null, data, null, position),
    updateWidget: (boardId, id, data, version) => childChange("WIDGET", boardId, id, data, version),
    deleteWidget: (boardId, id, version) => childChange("WIDGET", boardId, id, null, version),
    reorderBoards: (id, entries) => reorder("BOARD", id, entries),
    reorderTasks: (id, entries) => reorder("TASK", id, entries),
    reorderWidgets: (id, entries) => reorder("WIDGET", id, entries),
  };
}
