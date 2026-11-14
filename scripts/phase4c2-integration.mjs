import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { CreateTableCommand, DeleteTableCommand, DescribeTableCommand, waitUntilTableExists, waitUntilTableNotExists } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { createLocalClient } from "../src/lib/local-dynamodb.mjs";
import { mainUiFixture } from "../tests/helpers/main-ui-fixture.mjs";
import { workspaceFixture } from "../tests/phase4a-fixtures.mjs";
import { hash } from "../src/lib/migration/plan-v2.mjs";
import { runMainUiScenario } from "../tests/helpers/main-ui-scenario.mjs";

if (!process.argv.includes("--isolated-table")) throw new Error("Explicit --isolated-table required");
process.env.DYNAMODB_ENDPOINT = "http://127.0.0.1:9000";
const runId = randomUUID(); const tableName = `Slowly_Phase4C2_${runId.replaceAll("-", "")}`;
const client = createLocalClient(); const document = DynamoDBDocumentClient.from(client);
mkdirSync(".phase4c2-test-runs", { recursive: true }); const reportPath = `.phase4c2-test-runs/${runId}.json`;
const report = { runId, tableName, endpoint: "http://127.0.0.1:9000", created: false, checks: [], cleaned: false }; const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2)); save();
const db = { send(command) { const input = command.input; const tables = input.TransactItems ? input.TransactItems.map(action => (action.Put || action.Delete || action.Update || action.ConditionCheck).TableName) : [input.TableName]; assert.ok(tables.every(table => table === tableName), "Refusing test operations outside owned table"); return document.send(command); } };
const scan = async name => { const rows = []; let cursor; do { const result = await document.send(new ScanCommand({ TableName: name, ConsistentRead: true, ExclusiveStartKey: cursor })); rows.push(...result.Items || []); cursor = result.LastEvaluatedKey; } while (cursor); return rows.sort((a, b) => a.id.localeCompare(b.id)); };
async function check(name, action) { const row = { name }; report.checks.push(row); save(); try { await action(); row.passed = true; } catch (error) { row.passed = false; throw error; } finally { save(); } }
let before; let child;
try {
  await client.send(new DescribeTableCommand({ TableName: "SlowlyTasks" })); before = hash(await scan("SlowlyTasks"));
  report.createAttempted = true; save();
  await client.send(new CreateTableCommand({ TableName: tableName, BillingMode: "PAY_PER_REQUEST", KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }, { AttributeName: "gsi1pk", AttributeType: "S" }, { AttributeName: "gsi1sk", AttributeType: "S" }], GlobalSecondaryIndexes: [{ IndexName: "SlowlyByParent", KeySchema: [{ AttributeName: "gsi1pk", KeyType: "HASH" }, { AttributeName: "gsi1sk", KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" } }] }));
  report.created = true; save(); await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
  const data = workspaceFixture(); data.settings = { controlledUiTestRun: runId }; data.extension = { untouched: true };
  data.boards[0].widgets[0].type = "analytics"; data.boards[0].widgets[1].config.extension = { retained: true };
  data.boards[0].tasks[0].subtasks[0].extension = { retained: true }; data.boards[0].tasks[0].extension = { retained: true };
  delete data.boards[1].widgets; data.boards.push({ ...structuredClone(data.boards[1]), id: "explicit-empty", tasks: [], widgets: [] });
  const second = workspaceFixture(); second.settings = { controlledUiTestRun: runId }; second.boards[0].name = "第二測試 Workspace";
  const f = await mainUiFixture({ db, tableName, data }); const g = await mainUiFixture({ db, tableName, data: second });
  report.workspaceIds = [f.workspaceId, g.workspaceId]; report.migrationIds = [f.plan.migrationId, g.plan.migrationId]; report.targetIds = [...f.plan.operations, ...g.plan.operations].map(operation => operation.targetId); save();
  await check("DynamoDB API view → frontend model preserves complete source and widget presence", async () => {
    await f.activate(); assert.deepEqual(f.controller.getSnapshot().projection.workspace, data); f.controller.deactivate();
  });
  await runMainUiScenario(f, g.workspaceId, check);
  const foreign = await f.repository.createWorkspace({ settings: { controlledUiTestRun: "another-isolated-run" } }); report.foreignWorkspaceId = foreign.id; save();
  await db.send(new PutCommand({ TableName: tableName, Item: { id: `CONTROLLED_UI_ENV#${runId}`, entityType: "CONTROLLED_UI_TEST", runId, workspaceIds: report.workspaceIds, boardWidgetPresence: {} }, ConditionExpression: "attribute_not_exists(id)" }));
  if (process.argv.includes("--http-smoke") || process.argv.includes("--serve")) {
    const origin = "http://127.0.0.1:3114";
    child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "3114"], { env: { ...process.env, NODE_ENV: "development", SLOWLY_LOCAL_API: "1", SLOWLY_LOCAL_API_ORIGIN: origin, SLOWLY_MAIN_UI_TEST: "1", SLOWLY_CONTROLLED_UI_RUN_ID: runId, SLOWLY_CONTROLLED_UI_TABLE: tableName }, stdio: "inherit", windowsHide: true });
    report.serverPid = child.pid; report.serverStopped = false; save();
    await check("Actual Next routes and main UI remain isolated over HTTP", async () => {
      let response;
      for (let i = 0; i < 120; i++) { try { response = await fetch(`${origin}/dev/main-api`, { signal: AbortSignal.timeout(20000) }); if (response.status === 200) break; } catch { /* Read startup probe only, never retries mutations. */ } await new Promise(resolve => setTimeout(resolve, 250)); }
      assert.equal(response?.status, 200); assert.match(await response.text(), /隔離測試入口尚未啟用 API/);
      const view = await fetch(`${origin}/api/workspaces/${encodeURIComponent(g.workspaceId)}/view`); assert.equal(view.status, 200); assert.equal((await view.json()).data.readiness.eligible, true);
      const denied = await fetch(`${origin}/api/workspaces/${encodeURIComponent(foreign.id)}/view`); assert.equal(denied.status, 403);
      const homepage = await fetch(`${origin}/`); assert.match(await homepage.text(), /我的看板/);
    });
    if (process.argv.includes("--serve")) {
      report.stopFile = `.phase4c2-test-runs/${runId}.stop`; save();
      console.log(`OPEN ${origin}/dev/main-api\nTEST_WORKSPACE ${g.workspaceId}\nSTOP_FILE ${report.stopFile}`);
      let stopRequested = false; const stop = () => { stopRequested = true; }; process.once("SIGINT", stop); process.once("SIGTERM", stop);
      try { for (let i = 0; i < 1800 && !stopRequested && !existsSync(report.stopFile) && child.exitCode === null; i++) await new Promise(resolve => setTimeout(resolve, 500)); }
      finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
    }
  }
} catch (error) { report.error = { name: error.name, code: error.code, message: error.message }; process.exitCode = 1; }
finally {
  if (child && child.exitCode === null) {
    try {
      if (process.platform === "win32") { const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); const [code] = await once(killer, "exit"); assert.equal(code, 0, "Unable to stop owned server; retain table"); }
      else { const exit = once(child, "exit"); child.kill("SIGTERM"); await exit; }
      report.serverStopped = true;
    } catch (error) { report.cleanupError = error.message; process.exitCode = 1; }
  } else if (child) report.serverStopped = true;
  if (report.created && (!child || report.serverStopped)) { assert.equal(tableName, `Slowly_Phase4C2_${runId.replaceAll("-", "")}`); report.itemsBeforeCleanup = (await scan(tableName)).length; await client.send(new DeleteTableCommand({ TableName: tableName })); await waitUntilTableNotExists({ client, maxWaitTime: 30 }, { TableName: tableName }); report.cleaned = true; report.remainingItems = 0; report.remainingLocks = 0; }
  if (before) { report.originalUnchanged = before === hash(await scan("SlowlyTasks")); report.originalTableStatus = (await client.send(new DescribeTableCommand({ TableName: "SlowlyTasks" }))).Table.TableStatus; if (!report.originalUnchanged) process.exitCode = 1; }
  save(); client.destroy(); console.log(JSON.stringify(report, null, 2));
}
