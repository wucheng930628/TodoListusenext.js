import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists, waitUntilTableNotExists } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { isolatedTaskCreateRoutes } from "../src/lib/api/isolated-task-create.mjs";
import { localRoutes } from "../src/lib/api/local-routes.mjs";
import { createRepository } from "../src/lib/slowly-repository.mjs";
import { makeItem } from "../src/lib/data-model.mjs";
import { hash } from "../src/lib/migration/plan-v2.mjs";

const tableName = `Slowly_Phase5B1_${randomUUID().replaceAll("-", "")}`;
const endpoint = "http://127.0.0.1:9000";
const client = new DynamoDBClient({ endpoint, region: "ap-northeast-1", credentials: { accessKeyId: "local", secretAccessKey: "local" }, maxAttempts: 1 });
client.middlewareStack.add(next => async args => {
  const input = args.input;
  const tables = input.TransactItems?.map(action => (action.Put || action.ConditionCheck).TableName) ?? [input.TableName];
  assert.ok(tables.length > 0 && tables.every(name => name === tableName));
  return next(args);
}, { step: "initialize", name: "phase5b1Only" });
const document = DynamoDBDocumentClient.from(client);
const put = Item => document.send(new PutCommand({ TableName: tableName, Item }));
const get = async id => (await document.send(new GetCommand({ TableName: tableName, Key: { id }, ConsistentRead: true }))).Item;
const scan = async () => (await document.send(new ScanCommand({ TableName: tableName, ConsistentRead: true }))).Items;
const workspace = { ...makeItem("WORKSPACE", {}), boardCount: 1, migrationReleaseVersion: 2, migrationLock: false };
const board = makeItem("BOARD", { id: "fixture-board", name: "Fixture", description: "", wipLimit: 1 }, { parent: workspace.id });
const migrationId = hash(tableName);
const sourceNamespace = `fixture-${randomUUID()}`;
workspace.migrationOwner = { migrationId };
const session = { id: `SLOWLY#MIGRATION_SESSION#${migrationId}`, entityType: "MIGRATION_SESSION", migrationId,
  releaseWorkspaceId: workspace.id, state: "RELEASED", lockState: "RELEASED", releaseProtocolVersion: 2,
  total: 2, confirmedCount: 2, releasedCount: 2, rolledBackCount: 0, verifiedAt: new Date().toISOString(), releasedAt: new Date().toISOString(),
  version: 35, sourceIdentity: { sourceNamespace }, sourceId: `SLOWLY#MIGRATION_SOURCE#${hash(sourceNamespace)}`, releaseVerificationHash: hash("fixture") };
const grant = { id: `SLOWLY#TASK_CREATE_GRANT#${workspace.id}`, entityType: "TASK_CREATE_GRANT", state: "ACTIVE", version: 1,
  workspaceId: workspace.id, migrationId, planId: migrationId, sourceNamespace, sessionVersion: 35,
  releaseHash: session.releaseVerificationHash, expiresAt: Date.now() + 600000 };
const env = { NODE_ENV: "development", SLOWLY_LOCAL_API: "1", DYNAMODB_ENDPOINT: endpoint,
  SLOWLY_PHASE5_B1_TABLE: tableName, SLOWLY_PHASE5_B1_WORKSPACE: workspace.id,
  SLOWLY_PHASE5_B1_PLAN: migrationId, SLOWLY_PHASE5_B1_SOURCE_NAMESPACE: sourceNamespace };
const input = { workspaceId: workspace.id, boardId: board.id, position: 0, data: { id: "fixture-task", title: "Fixture", status: "doing" } };
const request = (body = input, key = randomUUID()) => new Request("http://127.0.0.1:3000/api/tasks", {
  method: "POST", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json",
    ...(key === null ? {} : { "idempotency-key": key }) }, body: JSON.stringify(body),
});
let beforeTransaction;
let loseResponse = false;
const routes = (configuration = env) => isolatedTaskCreateRoutes({ configuration: () => configuration, db: { async send(command) {
  if (command.constructor.name === "TransactWriteCommand" && beforeTransaction) {
    const inject = beforeTransaction;
    beforeTransaction = undefined;
    await inject();
  }
  const result = await document.send(command);
  if (command.constructor.name === "TransactWriteCommand" && loseResponse) {
    loseResponse = false;
    throw new Error("simulated response loss after commit");
  }
  return result;
} } });
const handler = configuration => routes(configuration).post;
async function expect(promise, status, code) {
  const response = await promise;
  assert.equal(response.status, status);
  const body = await response.json();
  if (code) assert.equal(body.error.code, code);
  return body.data;
}

let created = false;
try {
  await client.send(new CreateTableCommand({ TableName: tableName, BillingMode: "PAY_PER_REQUEST",
    KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    AttributeDefinitions: ["id", "gsi1pk", "gsi1sk"].map(AttributeName => ({ AttributeName, AttributeType: "S" })),
    GlobalSecondaryIndexes: [{ IndexName: "SlowlyByParent", KeySchema: [{ AttributeName: "gsi1pk", KeyType: "HASH" },
      { AttributeName: "gsi1sk", KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" } }] }));
  created = true;
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
  await Promise.all([put(workspace), put(board), put(session)]);
  const send = handler();
  await expect(send(request(input, null)), 400, "VALIDATION");
  await expect(send(request({ ...input, data: { ...input.data, title: "" } })), 400, "VALIDATION");
  await expect(send(request()), 403, "FORBIDDEN");
  await put({ ...grant, expiresAt: 1 });
  await expect(send(request()), 403, "FORBIDDEN");
  await put({ ...grant, state: "REVOKED" });
  await expect(send(request()), 403, "FORBIDDEN");
  await put(grant);
  await expect(handler({ ...env, SLOWLY_FORMAL_VIEW_ENABLED: "1" })(request()), 403, "FORBIDDEN");
  await expect(handler({ ...env, SLOWLY_PHASE5_B1_TABLE: "SlowlyTasks" })(request()), 403, "FORBIDDEN");
  await expect(handler({ ...env, SLOWLY_PHASE5_B1_PLAN: hash("another plan") })(request()), 403, "FORBIDDEN");
  await expect(send(request({ ...input, workspaceId: `SLOWLY#WORKSPACE#${randomUUID()}` })), 403, "FORBIDDEN");
  await expect(send(request({ ...input, boardId: `SLOWLY#BOARD#${randomUUID()}` })), 404, "NOT_FOUND");
  const foreignBoard = makeItem("BOARD", board.data, { parent: `SLOWLY#WORKSPACE#${randomUUID()}` });
  await put(foreignBoard);
  await expect(send(request({ ...input, boardId: foreignBoard.id })), 403, "OWNERSHIP");
  await put({ ...board, migrationLock: true });
  await expect(send(request()), 409, "MIGRATION_LOCKED");
  await put(board);
  for (const changed of [workspace, board, grant, session]) {
    const key = randomUUID();
    beforeTransaction = () => put({ ...changed, version: changed.version + 1, ...(changed === grant ? { state: "REVOKED" } : {}) });
    await expect(send(request(input, key)), 409, "CONFLICT");
    assert.equal(await get(`SLOWLY#TASK#${key}`), undefined);
    assert.equal(await get(`SLOWLY#CRUD_OPERATION#${key}`), undefined);
    assert.equal((await get(board.id)).taskCount, 0);
    await put(changed);
  }
  const failKey = randomUUID();
  beforeTransaction = () => { throw new Error("simulated unavailable transaction"); };
  await expect(send(request(input, failKey)), 500, "INTERNAL");
  assert.equal(await get(`SLOWLY#TASK#${failKey}`), undefined);
  assert.equal(await get(`SLOWLY#CRUD_OPERATION#${failKey}`), undefined);
  assert.equal((await get(board.id)).taskCount, 0);
  Object.assign(process.env, env);
  const post = localRoutes("tasks").collectionPost;
  const key = randomUUID();
  const results = await Promise.all([post(request(input, key)), post(request(input, key))]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
  const task = (await results[0].json()).data;
  assert.equal(task.id, `SLOWLY#TASK#${key}`);
  assert.equal((await results[1].json()).data.id, task.id);
  await expect(send(request({ ...input, data: { ...input.data, title: "different" } }, key)), 409, "OPERATION_CONFLICT");
  await expect(send(request()), 409, "WIP_LIMIT");
  const reloaded = createRepository(document, { tableName });
  const durable = await reloaded.getTask(task.id);
  const receipt = await reloaded.getOperation(key, { resource: "tasks", workspaceId: workspace.id, boardId: board.id });
  assert.deepEqual(receipt.result, durable);
  assert.equal((await reloaded.getBoard(board.id)).version, board.version + 1);
  assert.equal((await reloaded.getBoard(board.id)).taskCount, 1);
  assert.equal((await reloaded.getBoard(board.id)).doingCount, 1);
  assert.equal((await scan()).filter(item => item.entityType === "TASK").length, 1);
  const lostKey = randomUUID();
  const lostInput = { ...input, data: { ...input.data, id: "lost-response", status: "todo" } };
  loseResponse = true;
  await expect(send(request(lostInput, lostKey)), 201);
  await expect(send(request(lostInput, lostKey)), 200);
  const receiptUrl = `http://127.0.0.1:3000/api/operations/${lostKey}?resource=tasks&workspaceId=${encodeURIComponent(workspace.id)}&boardId=${encodeURIComponent(board.id)}`;
  const recovered = await expect(routes().receipt(new Request(receiptUrl, { headers: { host: "127.0.0.1:3000" } }),
    { params: { operationId: lostKey } }), 200);
  assert.equal(recovered.state, "CONFIRMED");
  assert.equal(recovered.targetId, `SLOWLY#TASK#${lostKey}`);
  assert.equal((await reloaded.getBoard(board.id)).taskCount, 2);
  console.log("Phase 5-B-1 isolated authorization, scope, locks, concurrent replay, transaction rollback, persisted receipt and reload passed");
} finally {
  try {
    if (created) {
      await client.send(new DeleteTableCommand({ TableName: tableName }));
      await waitUntilTableNotExists({ client, maxWaitTime: 30 }, { TableName: tableName });
      console.log(`Cleaned isolated table ${tableName}`);
    }
  } finally { client.destroy(); }
}
