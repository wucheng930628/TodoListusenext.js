import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApi } from "../../src/lib/api/handlers.mjs";
import { createOperationApi } from "../../src/lib/api/operations.mjs";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { createRepository } from "../../src/lib/slowly-repository.mjs";

export function createRequestFixture(repository) {
  const configuration = () => ({ NODE_ENV: "development", SLOWLY_LOCAL_API: "1" });
  const handlers = Object.fromEntries(["workspaces", "boards", "tasks", "widgets"].map(resource => [resource, createApi(resource, { getRepository: async () => repository, configuration })]));
  const operations = createOperationApi({ getRepository: async () => repository, configuration });
  const request = (path, method, input, key) => new Request(`http://127.0.0.1:3000/api/${path}`, {
    method, headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  return {
    post: (resource, input, key) => handlers[resource].collectionPost(request(resource, "POST", input, key)),
    getOperation(key, scope) {
      return operations(request(`operations/${key}?${new URLSearchParams(scope)}`, "GET"), { params: Promise.resolve({ operationId: key }) });
    },
  };
}

// Shared between memory unit tests and an explicitly owned DynamoDB Local table.
export async function runSafeCreateScenario(repository, check) {
  const http = createRequestFixture(repository);
  const workspace = await repository.createWorkspace({});
  const boardData = { id: "safe-board", name: "Safe Create", description: "", wipLimit: 100 };
  const board = await repository.createBoard(workspace.id, boardData);
  const other = await repository.createBoard(workspace.id, { ...boardData, id: "other-board" });
  const inputs = {
    workspaces: { data: { settings: { isolated: true } } },
    boards: { workspaceId: workspace.id, data: boardData },
    tasks: { workspaceId: workspace.id, boardId: board.id, data: { id: "safe-task", title: "Safe", status: "todo" } },
    widgets: { workspaceId: workspace.id, boardId: board.id, data: { id: "safe-widget", type: "note", span: 6, height: 200, config: {} } },
  };
  for (const [resource, input] of Object.entries(inputs)) {
    await check(`${resource}: first 201, canonical replay 200, persisted receipt, payload/scope conflict`, async () => {
      const key = randomUUID();
      const created = await http.post(resource, input, key);
      assert.equal(created.status, 201); const result = (await created.json()).data;
      const replay = await http.post(resource, Object.fromEntries(Object.entries(input).reverse()), key);
      assert.equal(replay.status, 200); assert.deepEqual((await replay.json()).data, result);
      const fresh = createRequestFixture(repository);
      const scope = resource === "workspaces" ? { resource, scope: "local-workspace-create-v1" }
        : { resource, workspaceId: workspace.id, ...(input.boardId ? { boardId: board.id } : {}) };
      const receipt = await fresh.getOperation(key, scope); assert.equal(receipt.status, 200);
      assert.equal((await receipt.json()).data.targetId, result.id);
      const changed = structuredClone(input);
      if (resource === "workspaces") changed.data.settings = { changed: true };
      else changed.position = 50;
      assert.equal((await http.post(resource, changed, key)).status, 409);
      assert.equal((await http.getOperation(key, { ...scope, resource: "boards", workspaceId: workspace.id })).status, resource === "boards" ? 200 : 400);
      if (input.boardId) {
        assert.equal((await http.post(resource, { ...input, boardId: other.id }, key)).status, 409);
        const denied = await http.getOperation(key, { ...scope, boardId: other.id }); assert.equal(denied.status, 409); assert.doesNotMatch(await denied.text(), /safe-task|safe-widget/);
      }
    });
  }
  await check("concurrent same-key create increments parent exactly once", async () => {
    const key = randomUUID(); const input = { ...inputs.tasks, data: { ...inputs.tasks.data, id: "parallel" } };
    const before = await repository.getBoard(board.id);
    const responses = await Promise.all(Array.from({ length: 5 }, () => http.post("tasks", input, key)));
    // DynamoDB can report a transient conflict while the winning transaction is still in flight.
    assert.ok(responses.every(result => [200, 201, 409].includes(result.status)));
    assert.equal(responses.filter(result => result.status === 201).length, 1);
    const replay = await http.post("tasks", input, key); assert.equal(replay.status, 200);
    const after = await repository.getBoard(board.id);
    assert.equal(after.taskCount, before.taskCount + 1); assert.equal(after.version, before.version + 1);
  });
  await check("replay after target update or deletion returns original receipt without resurrection", async () => {
    const key = randomUUID(); const input = { ...inputs.tasks, data: { ...inputs.tasks.data, id: "deleted-later" } };
    const result = (await (await http.post("tasks", input, key)).json()).data;
    const old = await repository.getTask(result.id);
    const updated = await repository.updateTask(board.id, old.id, { ...old.data, title: "Newer" }, old.version);
    assert.deepEqual((await (await http.post("tasks", input, key)).json()).data, result);
    assert.equal((await repository.getTask(old.id)).data.title, "Newer");
    await repository.deleteTask(board.id, old.id, updated.version);
    assert.equal((await http.post("tasks", input, key)).status, 200);
    await assert.rejects(repository.getTask(old.id), { code: "NOT_FOUND" });
    assert.equal((await http.getOperation(key, { resource: "tasks", workspaceId: workspace.id, boardId: board.id })).status, 200);
  });
  await check("legacy no-key POST stays 201 and explicitly reports unprotected", async () => {
    const result = await http.post("tasks", inputs.tasks); assert.equal(result.status, 201);
    assert.equal(result.headers.get("idempotency-status"), "unprotected");
  });
  await check("key validation and receipt not-found/unknown semantics", async () => {
    assert.equal((await http.post("tasks", inputs.tasks, "invalid-key")).status, 400);
    const response = await http.getOperation(randomUUID(), { resource: "tasks", workspaceId: workspace.id, boardId: board.id });
    assert.equal(response.status, 404); assert.equal((await response.json()).error.state, "NOT_FOUND");
  });
}

export async function runSafeCreateTransactionRaces(db, tableName, check) {
  let beforeCommit;
  let afterCommit;
  const intercepted = { async send(command) {
    if (command.constructor.name !== "TransactWriteCommand") return db.send(command);
    const before = beforeCommit; beforeCommit = null;
    if (before) await before();
    const result = await db.send(command);
    const after = afterCommit; afterCommit = null;
    if (after) await after();
    return result;
  } };
  const repo = createRepository(intercepted, { tableName });
  const http = createRequestFixture(repo);
  const root = await repo.createWorkspace({});
  const data = { id: "race-board", name: "Race", description: "", wipLimit: 4 };
  const absent = async key => {
    for (const id of [`SLOWLY#BOARD#${key}`, `SLOWLY#CRUD_OPERATION#${key}`]) {
      const result = await db.send(new GetCommand({ TableName: tableName, Key: { id }, ConsistentRead: true })); assert.equal(result.Item, undefined);
    }
  };
  await check("actual parent-version race rejects target and receipt atomically", async () => {
    const key = randomUUID();
    beforeCommit = async () => { const current = await repo.getWorkspace(root.id); await repo.saveWorkspace(root.id, current.data, current.version); };
    assert.equal((await http.post("boards", { workspaceId: root.id, data }, key)).status, 409);
    await absent(key); assert.equal((await repo.getWorkspace(root.id)).boardCount, 0);
  });
  await check("workspace lock racing the transaction rejects both writes", async () => {
    const key = randomUUID();
    beforeCommit = async () => {
      const current = await repo.getWorkspace(root.id);
      await db.send(new PutCommand({ TableName: tableName, Item: { ...current, migrationLock: true }, ConditionExpression: "#v = :v", ExpressionAttributeNames: { "#v": "version" }, ExpressionAttributeValues: { ":v": current.version } }));
    };
    const result = await http.post("boards", { workspaceId: root.id, data }, key);
    assert.equal(result.status, 409); assert.equal((await result.json()).error.code, "MIGRATION_LOCKED"); await absent(key);
    const current = await repo.getWorkspace(root.id);
    await db.send(new PutCommand({ TableName: tableName, Item: { ...current, migrationLock: false }, ConditionExpression: "#lock = :held", ExpressionAttributeNames: { "#lock": "migrationLock" }, ExpressionAttributeValues: { ":held": true } }));
  });
  await check("lost real transaction response is recovered by durable receipt", async () => {
    const key = randomUUID(); afterCommit = async () => { throw new Error("simulated SDK response loss after commit"); };
    const result = await http.post("boards", { workspaceId: root.id, data }, key);
    assert.equal(result.status, 201); const item = (await result.json()).data;
    assert.equal(item.id, `SLOWLY#BOARD#${key}`); assert.equal((await repo.getWorkspace(root.id)).boardCount, 1);
  });
}
