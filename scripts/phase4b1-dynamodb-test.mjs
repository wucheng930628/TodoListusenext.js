import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CreateTableCommand, DeleteTableCommand, DescribeTableCommand, waitUntilTableExists, waitUntilTableNotExists } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createLocalClient, localClientOptions } from "../src/lib/local-dynamodb.mjs";
import { createMigrationService } from "../src/lib/migration/service.mjs";
import { createRepository } from "../src/lib/slowly-repository.mjs";
import { migrationPlanV2, hash, restoreWorkspace } from "../src/lib/migration/plan-v2.mjs";
import { createMigrationApi } from "../src/lib/api/migrations.mjs";
import { captureWorkspaceBackup } from "../src/lib/client/workspace-backup.mjs";
import { workspaceFixture, storageFixture, createdAt } from "../tests/phase4a-fixtures.mjs";

if (!process.argv.includes("--isolated-table")) throw new Error("Explicit --isolated-table is required");
process.env.DYNAMODB_ENDPOINT = "http://127.0.0.1:9000";
assert.equal(localClientOptions().endpoint, "http://127.0.0.1:9000");
const runId = randomUUID(); const tableName = `Slowly_Phase4B1_${runId.replaceAll("-", "")}`;
assert.ok(tableName.startsWith("Slowly_Phase4B1_") && tableName !== "SlowlyTasks");
const client = createLocalClient(); const document = DynamoDBDocumentClient.from(client);
const directory = resolve(".phase4b1-test-runs"); mkdirSync(directory, { recursive: true });
const reportPath = resolve(directory, `${runId}.json`);
const report = { runId, endpoint: "http://127.0.0.1:9000", testTable: tableName, created: false, cases: [], migrations: [], startedAt: new Date().toISOString() };
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2));
save(); let failure; let beforeTransaction; let afterTransaction;
const db = { async send(command) {
  const input = command.input;
  const names = input.TransactItems ? input.TransactItems.map(item => (item.Put || item.Delete || item.Update || item.ConditionCheck).TableName) : [input.TableName];
  assert.ok(names.every(name => name === tableName), "Refusing any write/test operation outside the dedicated table");
  if (command instanceof TransactWriteCommand && beforeTransaction) await beforeTransaction(input);
  const response = await document.send(command);
  if (command instanceof TransactWriteCommand && afterTransaction) await afterTransaction(input);
  return response;
} };
async function scan(name) {
  assert.ok(name === "SlowlyTasks" || name === tableName);
  const items = []; let cursor;
  do { const result = await document.send(new ScanCommand({ TableName: name, ConsistentRead: true, ExclusiveStartKey: cursor })); items.push(...result.Items || []); cursor = result.LastEvaluatedKey; } while (cursor);
  return items;
}
const snapshot = items => Object.fromEntries(items.map(item => [item.id, hash(item)]));
const get = async id => (await db.send(new GetCommand({ TableName: tableName, Key: { id }, ConsistentRead: true }))).Item;
async function check(name, action) {
  const item = { name, startedAt: new Date().toISOString() }; report.cases.push(item); save();
  try { await action(); item.passed = true; }
  catch (error) { item.passed = false; item.error = { name: error.name, code: error.code, message: error.message, causeName: error.cause?.name, causeMessage: error.cause?.message }; throw error; }
  finally { save(); }
}
function fixture(label, data = workspaceFixture(), registrationBudget = 32) {
  const options = { sourceNamespace: `integration-${runId}-${label}` };
  const backup = captureWorkspaceBackup({ storage: storageFixture({ "slowly-workspace-v2": JSON.stringify(data) }), createdAt });
  const plan = migrationPlanV2(backup, options); const service = createMigrationService(db, { tableName, registrationBudget });
  report.migrations.push({ label, migrationId: plan.migrationId, targetIds: plan.operations.map(op => op.targetId) }); save();
  const api = createMigrationApi({ getService: async () => service, configuration: () => ({ NODE_ENV: "development", SLOWLY_LOCAL_API: "1" }) });
  async function call(handler, operationId, input, method = "POST") {
    const response = await api[handler](new Request(`http://127.0.0.1:3000/api/migrations/${plan.migrationId}`, { method, headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", ...(input ? { "content-type": "application/json" } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) }), { params: Promise.resolve({ migrationId: plan.migrationId, operationId }) });
    return { status: response.status, body: await response.json() };
  }
  async function register() { for (let i = 0; i < plan.operations.length + 2; i++) { const session = await service.createSession(backup, options, plan.planId); if (session.state !== "PREPARING") return session; } assert.fail("registration did not finish"); }
  return { data, options, backup, plan, service, call, register };
}
try {
  const original = (await client.send(new DescribeTableCommand({ TableName: "SlowlyTasks" }))).Table;
  assert.equal(original.TableStatus, "ACTIVE"); report.originalBefore = snapshot(await scan("SlowlyTasks"));
  try { await client.send(new DescribeTableCommand({ TableName: tableName })); throw new Error("Test table already exists; refusing to use it"); }
  catch (error) { if (error.name !== "ResourceNotFoundException") throw error; }
  save();
  await client.send(new CreateTableCommand({ TableName: tableName, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }, { AttributeName: "gsi1pk", AttributeType: "S" }, { AttributeName: "gsi1sk", AttributeType: "S" }], KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], GlobalSecondaryIndexes: [{ IndexName: "SlowlyByParent", KeySchema: [{ AttributeName: "gsi1pk", KeyType: "HASH" }, { AttributeName: "gsi1sk", KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" } }] }));
  report.created = true; save();
  await waitUntilTableExists({ client, maxWaitTime: 30, minDelay: 1, maxDelay: 2 }, { TableName: tableName });
  const source = workspaceFixture(); source.boards[0].tasks[0].status = "done"; source.boards[0].tasks[0].completedAt = "2024-02-03T04:05:06.000Z";
  source.boards[0].tasks[0].unknown = { keep: [1, "保留"] }; delete source.boards[1].widgets;
  source.boards[0].widgets[0] = { id: "timer", type: "timer", span: 6, height: 260, config: { endsAt: 1760000000000, minutes: 25, remaining: null, taskId: "task-a" } };
  const happy = fixture("happy", source, 2); const repo = createRepository(db, { tableName });
  await check("Session and manifest registration survive partial preparation", async () => {
    const first = await happy.service.createSession(happy.backup, happy.options, happy.plan.planId); assert.equal(first.state, "PREPARING");
    await happy.register(); assert.equal((await happy.service.getSession(happy.plan.migrationId)).state, "READY");
  });
  const root = happy.plan.operations[0];
  await check("Receipt persists atomically with target", async () => {
    await happy.service.execute(happy.plan.migrationId, root.operationId, root.fingerprint);
    const restarted = createMigrationService(db, { tableName });
    assert.equal((await restarted.getOperation(happy.plan.migrationId, root.operationId)).state, "CONFIRMED"); assert.ok(await get(root.targetId));
  });
  await check("DynamoDB transaction rejection rolls back every action", async () => {
    const sentinel = { id: `sentinel-${runId}`, value: "keep" };
    await db.send(new PutCommand({ TableName: tableName, Item: sentinel, ConditionExpression: "attribute_not_exists(id)" }));
    const attemptedId = `not-committed-${runId}`;
    await assert.rejects(db.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: tableName, Item: { id: attemptedId }, ConditionExpression: "attribute_not_exists(id)" } },
      { Put: { TableName: tableName, Item: { ...sentinel, value: "must not overwrite" }, ConditionExpression: "attribute_not_exists(id)" } },
    ] })), error => error.name === "TransactionCanceledException");
    assert.equal(await get(attemptedId), undefined); assert.deepEqual(await get(sentinel.id), sentinel);
  });
  await check("Repeated operation never double-writes or double-counts", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => happy.service.execute(happy.plan.migrationId, root.operationId, root.fingerprint)));
    assert.ok(results.every(result => result.replayed)); assert.equal((await happy.service.getSession(happy.plan.migrationId)).confirmedCount, 1);
  });
  await check("Payload fingerprint mismatch returns HTTP 409", async () => { assert.equal((await happy.call("execute", root.operationId, { expectedPayloadFingerprint: "0".repeat(64) }, "PUT")).status, 409); });
  const board = happy.plan.operations.find(op => op.type === "BOARD");
  await check("HTTP response loss recovers using server receipt", async () => {
    afterTransaction = input => { if (input.TransactItems.some(action => action.Put?.Item.id === board.targetId)) { afterTransaction = null; throw new Error("simulated response loss after real commit"); } };
    assert.equal((await happy.call("execute", board.operationId, { expectedPayloadFingerprint: board.fingerprint }, "PUT")).status, 500);
    assert.equal((await happy.call("operation", board.operationId, null, "GET")).body.data.state, "CONFIRMED");
    assert.equal((await happy.call("execute", board.operationId, { expectedPayloadFingerprint: board.fingerprint }, "PUT")).status, 200);
  });
  await check("Concurrent sibling operations serialize parent versions correctly", async () => {
    const children = happy.plan.operations.filter(op => op.parentId === board.targetId);
    await Promise.all(children.map(op => happy.service.execute(happy.plan.migrationId, op.operationId, op.fingerprint)));
    const parent = await get(board.targetId); assert.equal(parent.taskCount, 2); assert.equal(parent.widgetCount, 2);
  });
  await check("External parent version conflict refuses child creation", async () => {
    const f = fixture("parent-conflict"); await f.register();
    for (const op of f.plan.operations.slice(0, 2)) await f.service.execute(f.plan.migrationId, op.operationId, op.fingerprint);
    const parent = f.plan.operations.find(op => op.type === "BOARD"); const raw = await get(parent.targetId);
    await db.send(new PutCommand({ TableName: tableName, Item: { ...raw, version: raw.version + 1 }, ConditionExpression: "#v = :v", ExpressionAttributeNames: { "#v": "version" }, ExpressionAttributeValues: { ":v": raw.version } }));
    const task = f.plan.operations.find(op => op.type === "TASK");
    await assert.rejects(f.service.execute(f.plan.migrationId, task.operationId, task.fingerprint), { code: "INTEGRITY_CONFLICT" }); assert.equal(await get(task.targetId), undefined);
  });
  await check("Migration lock rejects CRUD, including a lock acquired just before commit", async () => {
    const current = await repo.getBoard(board.targetId);
    await assert.rejects(repo.updateBoard(current.id, current.data, current.version), { code: "MIGRATION_LOCKED" });
    const ws = await repo.createWorkspace({}); const unlocked = await repo.createBoard(ws.id, { id: `race-${runId}`, name: "before", description: "", wipLimit: 4 });
    beforeTransaction = async input => {
      if (input.TransactItems.some(action => action.Put?.Item.id === unlocked.id)) {
        beforeTransaction = null;
        await db.send(new UpdateCommand({ TableName: tableName, Key: { id: unlocked.id }, UpdateExpression: "SET migrationLock = :locked", ExpressionAttributeValues: { ":locked": true } }));
      }
    };
    await assert.rejects(repo.updateBoard(unlocked.id, { ...unlocked.data, name: "must not save" }, unlocked.version), { code: "MIGRATION_LOCKED" });
    assert.equal((await get(unlocked.id)).data.name, "before");
  });
  await check("Migration Verify validates complete manifest and counts", async () => {
    for (const op of happy.plan.operations) if ((await happy.service.getOperation(happy.plan.migrationId, op.operationId)).state !== "CONFIRMED") await happy.service.execute(happy.plan.migrationId, op.operationId, op.fingerprint);
    assert.equal((await happy.service.verify(happy.plan.migrationId)).valid, true);
  });
  await check("Full data fidelity round trip through real DynamoDB", async () => {
    assert.deepEqual(restoreWorkspace(await Promise.all(happy.plan.operations.map(op => get(op.targetId)))), source);
  });
  await check("Rollback Preview is read-only", async () => {
    const before = snapshot(await scan(tableName)); const preview = await happy.service.rollbackPreview(happy.plan.migrationId);
    assert.equal(preview.canRollback, true); assert.deepEqual(snapshot(await scan(tableName)), before);
  });
  await check("Conditional Rollback removes one owned item with receipt and counters", async () => {
    const session = await happy.service.getSession(happy.plan.migrationId);
    const next = await happy.service.rollback(happy.plan.migrationId, session.version, happy.plan.migrationId); assert.equal(next.rolledBackCount, 1);
  });
  await check("Partial rollback response loss resumes safely", async () => {
    afterTransaction = input => { if (input.TransactItems.some(action => action.Delete)) { afterTransaction = null; throw new Error("simulated lost rollback response"); } };
    const session = await happy.service.getSession(happy.plan.migrationId);
    await assert.rejects(happy.service.rollback(happy.plan.migrationId, session.version, happy.plan.migrationId), { code: "STORAGE" });
    const restarted = createMigrationService(db, { tableName });
    for (let i = 0; i < happy.plan.operations.length + 2; i++) {
      const current = await restarted.getSession(happy.plan.migrationId); if (current.state === "ROLLED_BACK") break;
      await restarted.rollback(happy.plan.migrationId, current.version, happy.plan.migrationId);
    }
    assert.equal((await restarted.getSession(happy.plan.migrationId)).state, "ROLLED_BACK");
    for (const op of happy.plan.operations) assert.equal(await get(op.targetId), undefined);
  });
} catch (error) { failure = error; report.error = { name: error.name, code: error.code, message: error.message, causeName: error.cause?.name, causeMessage: error.cause?.message }; }
finally {
  beforeTransaction = null; afterTransaction = null;
  if (report.created) {
    try {
      report.itemsBeforeCleanup = (await scan(tableName)).length;
      report.locksBeforeCleanup = (await scan(tableName)).filter(item => item.migrationLock === true).length; save();
      assert.equal(tableName, report.testTable); assert.notEqual(tableName, "SlowlyTasks");
      await client.send(new DeleteTableCommand({ TableName: tableName }));
      await waitUntilTableNotExists({ client, maxWaitTime: 30, minDelay: 1, maxDelay: 2 }, { TableName: tableName });
      report.testTableDeleted = true; report.testItemsRemaining = 0; report.testLocksRemaining = 0;
    } catch (error) { failure ||= error; report.cleanupError = { name: error.name, message: error.message }; }
  }
  if (report.originalBefore) {
    try { assert.deepEqual(snapshot(await scan("SlowlyTasks")), report.originalBefore); report.originalUnchanged = true; report.originalTableStatus = (await client.send(new DescribeTableCommand({ TableName: "SlowlyTasks" }))).Table.TableStatus; }
    catch (error) { failure ||= error; report.originalVerificationError = { name: error.name, message: error.message }; }
  }
  report.success = !failure; report.finishedAt = new Date().toISOString(); save(); client.destroy();
  console.log(JSON.stringify({ ...report, originalBefore: report.originalBefore ? { itemCount: Object.keys(report.originalBefore).length } : undefined, migrations: undefined, reportPath }));
}
if (failure) process.exitCode = 1;
