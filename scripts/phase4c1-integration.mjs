import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { CreateTableCommand, DeleteTableCommand, DescribeTableCommand, waitUntilTableExists, waitUntilTableNotExists } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createLocalClient } from "../src/lib/local-dynamodb.mjs";
import { releaseFixture } from "../tests/helpers/release-fixture.mjs";
import { workspaceFixture } from "../tests/phase4a-fixtures.mjs";
import { hash } from "../src/lib/migration/plan-v2.mjs";
import { checkCutoverReadiness } from "../src/lib/migration/cutover-readiness.mjs";
import { projectWorkspaceForUi } from "../src/lib/client/workspace-projection.mjs";
import { createMigrationApi } from "../src/lib/api/migrations.mjs";
import { createMigrationService } from "../src/lib/migration/service.mjs";
import { createApi } from "../src/lib/api/handlers.mjs";
import { createSlowlyApi } from "../src/lib/client/slowly-api.mjs";
import { createRepository } from "../src/lib/slowly-repository.mjs";
import { exportBackupJson, validateBackup } from "../src/lib/client/workspace-backup.mjs";
import { hookHost } from "../tests/helpers/react-hook-host.mjs";
import { useSlowlyWidgets } from "../src/hooks/use-slowly-api.mjs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ManagedWorkspacePreview } from "../src/components/managed-workspace-preview.mjs";

if (!process.argv.includes("--isolated-table")) throw new Error("Explicit --isolated-table required");
process.env.DYNAMODB_ENDPOINT = "http://127.0.0.1:9000";
const runId = randomUUID(); const tableName = `Slowly_Phase4C1_${runId.replaceAll("-", "")}`;
const client = createLocalClient(); const document = DynamoDBDocumentClient.from(client);
mkdirSync(".phase4c1-test-runs", { recursive: true });
const report = { runId, tableName, endpoint: "http://127.0.0.1:9000", created: false, checks: [], cleaned: false };
const path = `.phase4c1-test-runs/${runId}.json`; const save = () => writeFileSync(path, JSON.stringify(report, null, 2)); save();
let beforeTransaction; let afterTransaction; let original; let host; let transactions = 0;
const db = { async send(command) {
  const input = command.input; const names = input.TransactItems ? input.TransactItems.map(action => (action.Get || action.Put || action.Delete || action.ConditionCheck || action.Update).TableName) : [input.TableName];
  assert.ok(names.every(name => name === tableName), "No test operation may target another table");
  if (command instanceof TransactWriteCommand) { transactions++; if (beforeTransaction) await beforeTransaction(input); }
  const response = await document.send(command);
  if (command instanceof TransactWriteCommand && afterTransaction) await afterTransaction(input);
  return response;
} };
const readItem = async id => (await db.send(new GetCommand({ TableName: tableName, Key: { id }, ConsistentRead: true }))).Item;
async function scan(name) { const rows = []; let cursor; do { const page = await document.send(new ScanCommand({ TableName: name, ConsistentRead: true, ExclusiveStartKey: cursor })); rows.push(...page.Items || []); cursor = page.LastEvaluatedKey; } while (cursor); return rows.sort((a, b) => a.id.localeCompare(b.id)); }
async function check(name, action) { const item = { name }; report.checks.push(item); save(); try { await action(); item.passed = true; } catch (error) { item.passed = false; throw error; } finally { save(); } }
try {
  await client.send(new DescribeTableCommand({ TableName: "SlowlyTasks" })); original = hash(await scan("SlowlyTasks"));
  report.createAttempted = true; save();
  await client.send(new CreateTableCommand({ TableName: tableName, BillingMode: "PAY_PER_REQUEST", KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }, { AttributeName: "gsi1pk", AttributeType: "S" }, { AttributeName: "gsi1sk", AttributeType: "S" }], GlobalSecondaryIndexes: [{ IndexName: "SlowlyByParent", KeySchema: [{ AttributeName: "gsi1pk", KeyType: "HASH" }, { AttributeName: "gsi1sk", KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" } }] }));
  report.created = true; save(); await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
  const data = workspaceFixture(); delete data.boards[1].widgets; data.boards.push({ ...structuredClone(data.boards[1]), id: "empty-board", tasks: [], widgets: [] });
  Object.assign(data.boards[0].widgets[0], { type: "timer", span: 12, height: 480, manualSize: true, extension: { nested: true }, config: { endsAt: 1794640000000, taskId: "task-a", minutes: 25, extension: { note: "preserve-me" } } });
  data.boards[0].tasks[0].status = "done"; data.boards[0].tasks[0].completedAt = "2026-11-12T01:02:03.456Z";
  const f = releaseFixture({ db, tableName, data }); report.migrationId = f.plan.migrationId; report.targetIds = f.plan.operations.map(op => op.targetId); save();
  const backupPath = `.phase4c1-test-runs/${runId}.backup.json`; writeFileSync(backupPath, exportBackupJson(f.backup));
  await check("Isolated migration, receipts and Verify", () => f.apply());
  let preview; let initial;
  await check("Release Preview is read-only and validates full snapshot", async () => {
    initial = await f.service.getSession(f.plan.migrationId); const count = transactions; const snapshot = hash(await scan(tableName));
    preview = await f.service.releasePreview(f.plan.migrationId, initial.version); assert.equal(preview.eligible, true); assert.equal(transactions, count); assert.equal(hash(await scan(tableName)), snapshot);
  });
  const origin = "http://127.0.0.1:3000"; const configuration = () => ({ NODE_ENV: "development", SLOWLY_LOCAL_API: "1" });
  const migrationApi = createMigrationApi({ getService: async () => f.service, configuration });
  const releaseRequest = (version, digest = preview.verificationHash) => migrationApi.release(new Request(`${origin}/api/migrations/${f.plan.migrationId}/release`, { method: "POST", headers: { host: "127.0.0.1:3000", origin, "content-type": "application/json" }, body: JSON.stringify({ expectedSessionVersion: version, expectedVerificationHash: digest, confirmation: f.plan.migrationId }) }), { params: Promise.resolve({ migrationId: f.plan.migrationId }) });
  await check("Release API starts 202, mismatch is 409, replay does not advance", async () => {
    assert.equal((await releaseRequest(initial.version, "0".repeat(64))).status, 409);
    assert.equal((await releaseRequest(initial.version)).status, 202); assert.equal((await releaseRequest(initial.version)).status, 202);
    assert.equal((await f.service.getSession(f.plan.migrationId)).releasedCount, 0);
  });
  await check("Committed release response loss recovers after service restart", async () => {
    const session = await f.service.getSession(f.plan.migrationId);
    afterTransaction = () => { afterTransaction = null; throw new Error("response lost after commit"); };
    await assert.rejects(f.step()); const restarted = createMigrationService(db, { tableName });
    assert.equal((await restarted.release(f.plan.migrationId, session.version, preview.verificationHash, f.plan.migrationId)).releasedCount, 1);
  });
  await check("Concurrent release cannot increment cursor twice", async () => {
    const session = await f.service.getSession(f.plan.migrationId);
    const results = await Promise.all([releaseRequest(session.version), releaseRequest(session.version)]);
    assert.ok(results.every(response => [202, 409].includes(response.status))); assert.equal((await f.service.getSession(f.plan.migrationId)).releasedCount, 2);
  });
  while ((await f.service.getSession(f.plan.migrationId)).releasedCount < f.plan.operations.length - 1) await f.step();
  await check("Partially unlocked Board, Task, Widget still blocked by Workspace barrier", async () => {
    const board = await f.repository.getBoard(f.plan.operations.find(op => op.type === "BOARD").targetId);
    const task = await f.repository.getTask(f.plan.operations.find(op => op.type === "TASK").targetId);
    const widget = await f.repository.getWidget(f.plan.operations.find(op => op.type === "WIDGET").targetId);
    assert.equal(board.migrationLock, false); assert.equal((await readItem(f.plan.operations[0].targetId)).migrationLock, true);
    for (const action of [() => f.repository.updateBoard(board.id, board.data, board.version), () => f.repository.updateTask(board.id, task.id, task.data, task.version), () => f.repository.deleteWidget(board.id, widget.id, widget.version), () => f.repository.reorderTasks(board.id, [{ id: task.id, version: task.version, position: 0 }])]) await assert.rejects(action(), { code: "MIGRATION_LOCKED" });
  });
  await check("Final atomic release, 200 replay and irreversible Rollback prohibition", async () => {
    assert.equal((await f.step()).lockState, "RELEASED"); assert.equal((await releaseRequest(initial.version)).status, 200);
    assert.equal((await f.service.rollbackPreview(f.plan.migrationId)).canRollback, false);
  });
  await check("Source → DynamoDB → React UI preserves Widget and Task data", async () => {
    const projection = projectWorkspaceForUi(await Promise.all(f.plan.operations.map(op => readItem(op.targetId))));
    assert.deepEqual(projection.workspace, data); const markup = renderToStaticMarkup(createElement(ManagedWorkspacePreview, { projection }));
    assert.match(markup, /preserve-me/); assert.match(markup, /Widget 缺省/); assert.match(markup, /Widget 空清單/);
  });
  const widgetHandlers = createApi("widgets", { getRepository: async () => f.repository, configuration });
  const widgetApi = createSlowlyApi({ fetchImpl: async (path, init) => { const url = new URL(path, origin); const id = url.pathname.split("/")[3]; const handler = id === "order" ? "orderPatch" : id ? init.method === "DELETE" ? "itemDelete" : "itemPatch" : init.method === "POST" ? "collectionPost" : "collectionGet"; return widgetHandlers[handler](new Request(url, { ...init, headers: { ...init.headers, host: "127.0.0.1:3000", origin } }), { params: Promise.resolve({ id: id && decodeURIComponent(id) }) }); } });
  let reactWriteVerified = false;
  await check("Readiness React write probe uses another explicitly created test Workspace", async () => {
    const root = await f.repository.createWorkspace({ settings: { isolatedRun: runId } }); const board = await f.repository.createBoard(root.id, { id: "readiness-probe", name: "Readiness", description: "", wipLimit: 4 });
    report.extraTestIds = [root.id, board.id]; save(); let resource;
    function Probe() { resource = useSlowlyWidgets({ api: widgetApi, mode: "api", workspaceId: root.id, boardId: board.id, apiReady: true, allowWrites: true }); return null; }
    host = await hookHost(); await host.render(Probe);
    for (let i = 0; i < 100 && !resource.success; i++) await host.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.equal(resource.success, true); let item;
    await host.act(async () => { item = await resource.create({ data: { id: "probe-note", type: "note", span: 6, height: 200, config: { text: "create" } } }); });
    report.extraTestIds.push(item.id); save();
    await host.act(async () => { item = await resource.update(item.id, { version: item.version, data: { config: { text: "update" } } }); });
    assert.equal(resource.data[0].data.config.text, "update");
    await host.act(async () => { [item] = await resource.reorder([{ id: item.id, version: item.version, position: 1 }]); });
    await host.act(() => resource.remove(item.id, { version: item.version })); assert.deepEqual(resource.data, []);
    reactWriteVerified = true; await host.close(); host = null;
  });
  let widgetResource; const boardId = f.plan.operations.find(op => op.type === "BOARD").targetId;
  function WidgetProbe() { widgetResource = useSlowlyWidgets({ api: widgetApi, mode: "api", workspaceId: f.plan.operations[0].targetId, boardId, apiReady: true, allowWrites: true }); return null; }
  await check("React API reads managed data and retains frontend/database mapping", async () => {
    host = await hookHost(); await host.render(WidgetProbe);
    for (let i = 0; i < 100 && !widgetResource.success; i++) await host.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.equal(widgetResource.success, true); assert.equal(widgetResource.idMapping[0].frontendId, data.boards[0].widgets[0].id);
  });
  await check("Readiness validates backup artifact, release, mapping and locks but blocks homepage", async () => {
    const readiness = await checkCutoverReadiness({ ...f, migrationId: f.plan.migrationId, readItem, probes: {
      dynamodbLocal: async () => (await client.send(new DescribeTableCommand({ TableName: tableName }))).Table.TableStatus === "ACTIVE",
      apiRepositoryTests: async () => report.checks.filter(item => item.passed).length >= 7,
      reactApiTests: async () => reactWriteVerified && widgetResource.success && widgetResource.idMapping[0].frontendId === data.boards[0].widgets[0].id,
      backupArtifactVerified: async () => hash(validateBackup(JSON.parse(readFileSync(backupPath, "utf8")))) === hash(f.backup),
    } });
    assert.equal(readiness.prerequisitesPassed, true); assert.equal(readiness.ready, false); report.readiness = readiness;
  });
  await check("Real React API state preserves config extensions on versioned Widget PATCH", async () => {
    const widget = widgetResource.data[0];
    await host.act(() => widgetResource.update(widget.id, { version: widget.version, data: { config: { minutes: 45 } } }));
    assert.equal(widgetResource.data[0].data.config.extension.note, "preserve-me");
    await host.close(); host = null;
  });
  await check("Workspace lock acquired between preflight and commit rejects entire transaction", async () => {
    const repo = createRepository(db, { tableName }); const root = await repo.createWorkspace({ settings: { isolatedRun: runId } }); const board = await repo.createBoard(root.id, { id: "race", name: "Race", description: "", wipLimit: 4 });
    beforeTransaction = async input => {
      if (!input.TransactItems.some(action => action.ConditionCheck?.Key.id === root.id)) return;
      beforeTransaction = null; await db.send(new UpdateCommand({ TableName: tableName, Key: { id: root.id }, UpdateExpression: "SET migrationLock = :locked", ExpressionAttributeValues: { ":locked": true } }));
    };
    await assert.rejects(repo.createWidget(board.id, { id: "race-widget", type: "note", span: 6, height: 200, config: {} }), { code: "MIGRATION_LOCKED" });
    assert.deepEqual(await repo.listWidgets(board.id), []);
  });
} catch (error) { report.error = { name: error.name, code: error.code, message: error.message }; process.exitCode = 1; }
finally {
  if (host) await host.close();
  if (report.created) {
    assert.equal(tableName, `Slowly_Phase4C1_${runId.replaceAll("-", "")}`);
    report.itemsBeforeCleanup = (await scan(tableName)).length;
    await client.send(new DeleteTableCommand({ TableName: tableName })); await waitUntilTableNotExists({ client, maxWaitTime: 30 }, { TableName: tableName }); report.cleaned = true; report.remainingItems = 0; report.remainingLocks = 0;
  }
  if (original) { report.originalUnchanged = hash(await scan("SlowlyTasks")) === original; report.originalTableStatus = (await client.send(new DescribeTableCommand({ TableName: "SlowlyTasks" }))).Table.TableStatus; if (!report.originalUnchanged) process.exitCode = 1; }
  save(); client.destroy(); console.log(JSON.stringify(report, null, 2));
}
