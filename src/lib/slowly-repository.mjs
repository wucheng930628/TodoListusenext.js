import "server-only";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { DataError, INDEX_NAME, assertId, assertItemSize, fromFrontend, makeItem, requireValue, validateData } from "./data-model.mjs";
import { assertOperationKey, createOperation, assertSameOperation, createReceipt, createMutationOperation, workspaceCreateScope } from "./crud-operation.mjs";

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
    if (previous) requireValue(previous.migrationLock !== true, "Migration lock is held", "MIGRATION_LOCKED");
    const migratedRoot = previous?.entityType === "WORKSPACE" && Object.hasOwn(previous, "migrationOwner");
    if (migratedRoot) requireValue(previous.migrationReleaseVersion === 2, "Workspace release protocol is not certified", "MIGRATION_LOCKED");
    return { Put: { TableName: tableName, Item: item, ConditionExpression: previous ? `#v = :v AND #t = :t AND (attribute_not_exists(#lock) OR #lock = :unlocked)${migratedRoot ? " AND #release = :protocol" : ""}` : "attribute_not_exists(id)", ...(previous ? { ExpressionAttributeNames: { "#v": "version", "#t": "entityType", "#lock": "migrationLock", ...(migratedRoot ? { "#release": "migrationReleaseVersion" } : {}) }, ExpressionAttributeValues: { ":v": previous.version, ":t": previous.entityType, ":unlocked": false, ...(migratedRoot ? { ":protocol": 2 } : {}) } } : {}) } };
  }
  function remove(item) {
    requireValue(item.migrationLock !== true, "Migration lock is held", "MIGRATION_LOCKED");
    return { Delete: { TableName: tableName, Key: { id: item.id }, ConditionExpression: "#v = :v AND #t = :t AND (attribute_not_exists(#lock) OR #lock = :unlocked)", ExpressionAttributeNames: { "#v": "version", "#t": "entityType", "#lock": "migrationLock" }, ExpressionAttributeValues: { ":v": item.version, ":t": item.entityType, ":unlocked": false } } };
  }
  async function commit(actions, authority) {
    const roots = new Set(actions.filter(action => action.Put).map(action => action.Put.Item.entityType === "WORKSPACE" ? action.Put.Item.id : action.Put.Item.workspaceId).filter(Boolean));
    requireValue(roots.size <= 1, "A write cannot span workspaces");
    for (const workspaceId of roots) {
      if (actions.some(action => action.Put?.Item.id === workspaceId)) continue; // Existing root Put already checks lock atomically.
      const workspace = await get("WORKSPACE", workspaceId);
      requireValue(workspace.migrationLock !== true, "Workspace migration barrier is held", "MIGRATION_LOCKED");
      requireValue(!Object.hasOwn(workspace, "migrationOwner") || workspace.migrationReleaseVersion === 2, "Workspace release protocol is not certified", "MIGRATION_LOCKED");
      actions.push({ ConditionCheck: { TableName: tableName, Key: { id: workspaceId },
        ConditionExpression: "#t = :t AND #s = :s AND (attribute_not_exists(#lock) OR #lock = :unlocked) AND (attribute_not_exists(#owner) OR #release = :protocol)" +
          (authority ? " AND #version = :version" : ""),
        ExpressionAttributeNames: { "#t": "entityType", "#s": "schemaVersion", "#lock": "migrationLock", "#owner": "migrationOwner", "#release": "migrationReleaseVersion", ...(authority ? { "#version": "version" } : {}) },
        ExpressionAttributeValues: { ":t": "WORKSPACE", ":s": 1, ":unlocked": false, ":protocol": 2, ...(authority ? { ":version": authority.workspaceVersion } : {}) } } });
    }
    if (authority) actions.push(...authority.transactionChecks());
    requireValue(actions.length <= 100 && Buffer.byteLength(JSON.stringify(actions)) < 3500000, "Transaction too large");
    try { await db.send(new TransactWriteCommand({ TransactItems: actions })); }
    catch (error) {
      if (["ConditionalCheckFailedException", "TransactionConflictException"].includes(error.name) || (error.name === "TransactionCanceledException" && error.CancellationReasons?.some(reason => ["ConditionalCheckFailed", "TransactionConflict"].includes(reason.Code)))) {
        for (const action of actions) {
          const id = action.Put?.Item.id || action.Delete?.Key.id || action.ConditionCheck?.Key.id;
          const current = await db.send(new GetCommand({ TableName: tableName, Key: { id }, ConsistentRead: true }));
          if (current.Item?.migrationLock === true || (current.Item?.entityType === "WORKSPACE" && Object.hasOwn(current.Item, "migrationOwner") && current.Item.migrationReleaseVersion !== 2)) throw new DataError("MIGRATION_LOCKED", "Migration lock is held", { cause: error });
        }
        throw new DataError("CONFLICT", "Concurrent change; reload before retrying", { cause: error });
      }
      throw new DataError("STORAGE", "DynamoDB operation failed", { cause: error });
    }
  }
  function revised(item, changes) { return { ...item, ...changes, version: item.version + 1, updatedAt: clock() }; }
  async function readReceipt(key) {
    assertOperationKey(key);
    const result = await db.send(new GetCommand({ TableName: tableName, Key: { id: `SLOWLY#CRUD_OPERATION#${key}` }, ConsistentRead: true }));
    return result.Item;
  }
  async function commitCreate(item, actions, operation, authority) {
    if (operation) {
      item.id = operation.targetId;
      if (item.parentId) item.gsi1sk = `${item.entityType}#${String(item.position).padStart(12, "0")}#${item.id}`;
      actions.push(put(createReceipt(operation, item, clock())));
    }
    await commit(actions, authority);
    return item;
  }
  async function createOnce(resource, input, key, authority) {
    if (authority) requireValue(["tasks", "boards", "widgets"].includes(resource) && input.workspaceId === authority.workspaceId, "Authorization scope differs", "FORBIDDEN");
    const operation = createOperation(resource, input, key);
    const data = fromFrontend(operation.type, input.data);
    const replay = receipt => {
      assertSameOperation(receipt, operation);
      return { item: structuredClone(receipt.result), replayed: receipt.attemptId !== operation.attemptId };
    };
    const previous = await readReceipt(key);
    if (previous) return replay(previous);
    try {
      let item;
      if (resource === "workspaces") item = await createWorkspace(data, operation);
      else if (resource === "boards") item = await createBoard(input.workspaceId, data, input.position, operation, authority);
      else {
        const board = await get("BOARD", input.boardId);
        requireValue(input.workspaceId === undefined || input.workspaceId === board.workspaceId, "Workspace mismatch", "OWNERSHIP");
        item = await childChange(operation.type, input.boardId, null, data, null, input.position, false, operation, authority);
      }
      return { item, replayed: false };
    } catch (cause) {
      // Even a lost transaction response can have committed. Only a durable receipt proves success.
      const confirmed = await readReceipt(key);
      if (confirmed) return replay(confirmed);
      throw cause;
    }
  }
  async function getOperation(key, scope) {
    assertOperationKey(key);
    const receipt = await readReceipt(key);
    if (!receipt) return null;
    const workspaceCreate = scope.resource === "workspaces";
    requireValue(receipt.entityType === "CRUD_OPERATION" && receipt.schemaVersion === 1 && receipt.state === "CONFIRMED" &&
      receipt.resource === scope.resource && (workspaceCreate
        ? scope.scope === workspaceCreateScope && receipt.parentScope === workspaceCreateScope
        : receipt.workspaceId === scope.workspaceId && (scope.resource === "boards" || receipt.boardId === scope.boardId)),
    "Operation scope does not match", "OPERATION_CONFLICT");
    return receipt;
  }
  async function mutateOnce(resource, action, id, input, key, mutate) {
    const operation = createMutationOperation(resource, action, id, input, key);
    const replay = receipt => {
      assertSameOperation(receipt, operation);
      return { item: receipt.result, replayed: receipt.attemptId !== operation.attemptId };
    };
    const previous = await readReceipt(key);
    if (previous) return replay(previous);
    try { return { item: await mutate(operation), replayed: false }; }
    catch (cause) {
      const confirmed = await readReceipt(key);
      if (confirmed) return replay(confirmed);
      throw cause;
    }
  }
  async function list(type, parent) {
    await get(type === "BOARD" ? "WORKSPACE" : "BOARD", parent);
    const items = []; let cursor;
    do {
      const response = await db.send(new QueryCommand({ TableName: tableName, IndexName: INDEX_NAME, KeyConditionExpression: "gsi1pk = :parent AND begins_with(gsi1sk, :type)", ExpressionAttributeValues: { ":parent": parent, ":type": `${type}#` }, ExclusiveStartKey: cursor }));
      items.push(...(response.Items || [])); cursor = response.LastEvaluatedKey;
    } while (cursor);
    return items.filter(item => item.entityType === type && item.parentId === parent).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  }
  async function createWorkspace(data, operation) {
    const item = { ...makeItem("WORKSPACE", data, { now: clock() }), viewOrigin: "api", boardCount: 0 };
    return commitCreate(item, [put(item)], operation);
  }
  async function saveWorkspace(id, data, version) {
    const previous = await get("WORKSPACE", id); expected(previous, version);
    const item = revised(previous, { data: validateData("WORKSPACE", data) });
    await commit([put(item, previous)]); return item;
  }
  async function createBoard(workspaceId, data, position = 0, operation, authority) {
    const parent = await get("WORKSPACE", workspaceId);
    requireValue(Number.isSafeInteger(parent.boardCount) && parent.boardCount >= 0, "Workspace count metadata requires review");
    if (authority) {
      expected(parent, authority.workspaceVersion);
      const siblings = await list("BOARD", workspaceId);
      requireValue(siblings.length === parent.boardCount && !siblings.some(board => board.data.id === data.id),
        "Workspace Board membership or frontend ID conflicts", "CONFLICT");
    }
    const item = { ...makeItem("BOARD", data, { parent: workspaceId, position, now: clock() }), widgetPresence: "absent" };
    return commitCreate(item, [put(item), put(revised(parent, { boardCount: parent.boardCount + 1 }), parent)], operation, authority);
  }
  async function updateBoard(id, data, version, authority, operation) {
    const previous = await get("BOARD", id); expected(previous, version);
    if (authority) requireValue(previous.workspaceId === authority.workspaceId, "Workspace mismatch", "OWNERSHIP");
    const validated = validateData("BOARD", data);
    requireValue(validated.id === previous.data.id, "Frontend id is immutable");
    requireValue(validated.wipLimit >= previous.doingCount, "WIP limit is below current task count", "WIP_LIMIT");
    const item = revised(previous, { data: validated });
    const actions = [put(item, previous)];
    if (operation) actions.push(put(createReceipt(operation, item, clock())));
    await commit(actions, authority); return item;
  }
  async function deleteBoard(id, version, authority, operation) {
    const board = await get("BOARD", id); expected(board, version);
    if (authority) requireValue(board.workspaceId === authority.workspaceId, "Workspace mismatch", "OWNERSHIP");
    requireValue(board.migrationLock !== true, "Migration lock is held", "MIGRATION_LOCKED");
    requireValue(board.taskCount === 0 && board.widgetCount === 0, "Only empty boards may be deleted", "NOT_EMPTY");
    const parent = await get("WORKSPACE", board.workspaceId);
    if (authority) {
      expected(parent, authority.workspaceVersion);
      const [tasks, widgets] = await Promise.all([list("TASK", id), list("WIDGET", id)]);
      requireValue(!tasks.length && !widgets.length, "Only empty boards may be deleted", "NOT_EMPTY");
    }
    requireValue(Number.isSafeInteger(parent.boardCount) && parent.boardCount > 0, "Workspace count metadata requires review");
    const data = { ...parent.data };
    if (authority && data.activeBoardId === board.data.id) delete data.activeBoardId;
    const actions = [remove(board), put(revised(parent, { boardCount: parent.boardCount - 1, data }), parent)];
    if (operation) actions.push(put(createReceipt(operation, board, clock())));
    await commit(actions, authority);
  }
  async function childChange(type, boardId, id, data, version, position, preserveCompletionTime = false, operation, authority) {
    const board = await get("BOARD", boardId);
    if (authority) requireValue(board.workspaceId === authority.workspaceId, "Workspace mismatch", "OWNERSHIP");
    const previous = id ? await get(type, id) : null;
    if (previous) { expected(previous, version); requireValue(previous.boardId === boardId && previous.workspaceId === board.workspaceId, "Entity belongs to a different board", "OWNERSHIP"); }
    const deleting = data === null;
    requireValue(!deleting || previous, "Delete requires an existing entity");
    if (authority && previous) {
      requireValue(board.migrationLock !== true && previous.migrationLock !== true, "Migration lock is held", "MIGRATION_LOCKED");
      if (type === "TASK") requireValue(Number.isSafeInteger(board.taskCount) && board.taskCount > 0 && Number.isSafeInteger(board.doingCount) &&
        board.doingCount >= Number(previous.data.status === "doing") && board.doingCount <= board.taskCount,
      "Board task counters are inconsistent", "CONFLICT");
    }
    if (authority && type === "WIDGET") {
      requireValue(Number.isSafeInteger(board.widgetCount) && board.widgetCount >= Number(Boolean(previous)),
        "Board widget count is inconsistent", "CONFLICT");
      if (!previous) {
        const siblings = await list("WIDGET", boardId);
        requireValue(siblings.length === board.widgetCount && !siblings.some(widget => widget.data.id === data.id),
          "Board Widget membership or frontend ID conflicts", "CONFLICT");
      }
    }
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
    const nextBoard = revised(board, { [countKey]: board[countKey] + (previous ? deleting ? -1 : 0 : 1), doingCount, ...(type === "WIDGET" ? { widgetPresence: "present" } : {}) });
    const actions = [deleting ? remove(previous) : put(item, previous), put(nextBoard, board)];
    if (operation?.action === "CREATE") await commitCreate(item, actions, operation, authority);
    else {
      if (operation) actions.push(put(createReceipt(operation, item ?? previous, clock())));
      await commit(actions, authority);
    }
    return item ?? null;
  }
  async function reorder(type, parentId, entries, authority, operation) {
    requireValue(["BOARD", "TASK", "WIDGET"].includes(type), "Unsupported order type");
    requireValue(Array.isArray(entries) && entries.length > 0 && entries.length <= (type === "BOARD" ? 99 : 98) && new Set(entries.map(entry => entry.id)).size === entries.length, "Order exceeds atomic capacity (boards: 99; children: 98)");
    const parent = await get(type === "BOARD" ? "WORKSPACE" : "BOARD", parentId);
    if (authority) {
      requireValue(type === "BOARD" ? parentId === authority.workspaceId : type === "WIDGET" && parent.workspaceId === authority.workspaceId,
        "Workspace mismatch", "OWNERSHIP");
      if (type === "BOARD") expected(parent, authority.workspaceVersion);
      const maxEntries = (type === "BOARD" ? 97 : 96) - Number(Boolean(operation));
      requireValue(entries.length <= maxEntries && new Set(entries.map(entry => entry.position)).size === entries.length,
        "Invalid or over-capacity order");
      requireValue(entries.length === (type === "BOARD" ? parent.boardCount : parent.widgetCount), "Order must include every item", "CONFLICT");
    }
    const items = await Promise.all(entries.map(async entry => {
      const old = await get(type, entry.id); expected(old, entry.version);
      requireValue(old.parentId === parentId, "Entity belongs to a different parent", "OWNERSHIP");
      if (authority && type === "WIDGET") requireValue(old.boardId === parentId && old.workspaceId === authority.workspaceId, "Widget scope differs", "OWNERSHIP");
      requireValue(Number.isSafeInteger(entry.position) && entry.position >= 0 && entry.position <= 999999999999, "Invalid position");
      return { old, item: revised(old, { position: entry.position, gsi1sk: `${type}#${String(entry.position).padStart(12, "0")}#${old.id}` }) };
    }));
    if (authority) {
      const indexed = await list(type, parentId);
      const submitted = new Set(entries.map(entry => entry.id));
      requireValue(indexed.length === entries.length && indexed.every(board => submitted.has(board.id)),
        "Order membership changed; refresh before ordering", "CONFLICT");
    }
    const result = items.map(({ item }) => item);
    const actions = [...items.map(({ old, item }) => put(item, old)), put(revised(parent, {}), parent)];
    if (operation) actions.push(put(createReceipt(operation, parent, clock(), result)));
    await commit(actions, authority);
    return result;
  }
  return {
    createOnce, getOperation, mutateOnce,
    createWorkspace, getWorkspace: id => get("WORKSPACE", id), saveWorkspace,
    createBoard, getBoard: id => get("BOARD", id), updateBoard, deleteBoard,
    listBoards: id => list("BOARD", id), listTasks: id => list("TASK", id), listWidgets: id => list("WIDGET", id),
    getTask: id => get("TASK", id), getWidget: id => get("WIDGET", id),
    createTask: (boardId, data, position, { preserveCompletionTime = false } = {}) => childChange("TASK", boardId, null, data, null, position, preserveCompletionTime),
    updateTask: (boardId, id, data, version, authority, operation) => childChange("TASK", boardId, id, data, version, undefined, false, operation, authority),
    deleteTask: (boardId, id, version, authority, operation) => childChange("TASK", boardId, id, null, version, undefined, false, operation, authority),
    async setTaskStatus(boardId, id, status, urgent, version) {
      const task = await get("TASK", id);
      return childChange("TASK", boardId, id, { ...task.data, status, urgent }, version);
    },
    createWidget: (boardId, data, position) => childChange("WIDGET", boardId, null, data, null, position),
    updateWidget: (boardId, id, data, version, authority, operation) => childChange("WIDGET", boardId, id, data, version, undefined, false, operation, authority),
    deleteWidget: (boardId, id, version, authority, operation) => childChange("WIDGET", boardId, id, null, version, undefined, false, operation, authority),
    reorderBoards: (id, entries, authority, operation) => reorder("BOARD", id, entries, authority, operation),
    reorderTasks: (id, entries) => reorder("TASK", id, entries),
    reorderWidgets: (id, entries, authority, operation) => reorder("WIDGET", id, entries, authority, operation),
  };
}
