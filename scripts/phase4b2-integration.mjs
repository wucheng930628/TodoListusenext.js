import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { CreateTableCommand, DeleteTableCommand, DescribeTableCommand, waitUntilTableExists, waitUntilTableNotExists } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { createLocalClient } from "../src/lib/local-dynamodb.mjs";
import { createRepository } from "../src/lib/slowly-repository.mjs";
import { controlledEnvironment } from "../src/lib/testing/controlled-environment.mjs";
import { localRoutes } from "../src/lib/api/local-routes.mjs";
import { createSlowlyApi } from "../src/lib/client/slowly-api.mjs";
import { providerHarness } from "../tests/helpers/controlled-provider-host.mjs";

if (!process.argv.includes("--isolated-table")) throw new Error("Explicit --isolated-table required");
const runId = randomUUID(); const tableName = `Slowly_Phase4B2_${runId.replaceAll("-", "")}`;
Object.assign(process.env, { NODE_ENV: "development", SLOWLY_LOCAL_API: "1", DYNAMODB_ENDPOINT: "http://127.0.0.1:9000", SLOWLY_CONTROLLED_UI_RUN_ID: runId, SLOWLY_CONTROLLED_UI_TABLE: tableName });
const client = createLocalClient(); const db = DynamoDBDocumentClient.from(client);
const report = { runId, tableName, endpoint: process.env.DYNAMODB_ENDPOINT, created: false, cleaned: false, checks: [] };
mkdirSync(".phase4b2-test-runs", { recursive: true });
const save = () => writeFileSync(`.phase4b2-test-runs/${runId}.json`, JSON.stringify(report, null, 2)); save();
const scan = async name => { const items = []; let cursor; do { const result = await db.send(new ScanCommand({ TableName: name, ConsistentRead: true, ExclusiveStartKey: cursor })); items.push(...result.Items); cursor = result.LastEvaluatedKey; } while (cursor); return items; };
const fingerprint = items => createHash("sha256").update(JSON.stringify(items.sort((a, b) => a.id.localeCompare(b.id)))).digest("hex");
const check = async (name, action) => { await action(); report.checks.push(name); save(); };
let harness; let before;
try {
  await client.send(new DescribeTableCommand({ TableName: "SlowlyTasks" })); before = fingerprint(await scan("SlowlyTasks"));
  await client.send(new CreateTableCommand({ TableName: tableName, KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }, { AttributeName: "gsi1pk", AttributeType: "S" }, { AttributeName: "gsi1sk", AttributeType: "S" }], BillingMode: "PAY_PER_REQUEST", GlobalSecondaryIndexes: [{ IndexName: "SlowlyByParent", KeySchema: [{ AttributeName: "gsi1pk", KeyType: "HASH" }, { AttributeName: "gsi1sk", KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" } }] }));
  report.created = true; save(); await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
  const repo = createRepository(db, { tableName });
  const ws = await repo.createWorkspace({ settings: { controlledUiTestRun: runId } });
  const ws2 = await repo.createWorkspace({ settings: { controlledUiTestRun: runId } });
  const a = await repo.createBoard(ws.id, { id: "board-a", name: "Present", description: "", wipLimit: 4 });
  const b = await repo.createBoard(ws.id, { id: "board-b", name: "Absent", description: "", wipLimit: 4 }, 1);
  const c = await repo.createBoard(ws2.id, { id: "board-c", name: "Empty", description: "", wipLimit: 4 });
  const foreign = await repo.createWorkspace({ settings: { controlledUiTestRun: "another-run" } });
  report.workspaceIds = [ws.id, ws2.id]; save();
  await db.send(new PutCommand({ TableName: tableName, Item: { id: `CONTROLLED_UI_ENV#${runId}`, entityType: "CONTROLLED_UI_TEST", runId, workspaceIds: report.workspaceIds, boardWidgetPresence: { [a.id]: "present", [b.id]: "absent", [c.id]: "present" } }, ConditionExpression: "attribute_not_exists(id)" }));
  const { config } = await controlledEnvironment();
  const handlers = Object.fromEntries(["workspaces", "boards", "tasks", "widgets"].map(name => [name, localRoutes(name)]));
  const origin = process.env.SLOWLY_LOCAL_API_ORIGIN || "http://127.0.0.1:3000";
  const api = createSlowlyApi({ fetchImpl: async (path, init) => {
    const url = new URL(path, origin); const [, , resource, encoded] = url.pathname.split("/"); const id = encoded && decodeURIComponent(encoded);
    const key = id === "order" ? "orderPatch" : !id ? { GET: "collectionGet", POST: "collectionPost" }[init.method] : { GET: "itemGet", PATCH: "itemPatch", DELETE: "itemDelete" }[init.method];
    return handlers[resource][key](new Request(url, { ...init, headers: { ...init.headers, host: new URL(origin).host, origin } }), { params: Promise.resolve({ id }) });
  } });
  await check("Server rejects non-fixture Workspace", () => assert.rejects(api.getWorkspace(foreign.id), { status: 403 }));
  harness = await providerHarness(api, config);
  await check("localStorage default, explicit ready and readonly", async () => {
    assert.equal(harness.state.selection.mode, "localStorage"); await harness.action(s => s.connect(ws.id, true)); await harness.flush();
    assert.equal(harness.state.boardId, a.id); await assert.rejects(harness.state.tasks.create({ data: {} }), { code: "API_WRITES_DISABLED" });
    await harness.action(s => s.authorizeWrites(ws.id)); await harness.flush();
  });
  let task; let widget;
  await check("React task create/read/update/order + database transaction", async () => {
    task = await harness.action(s => s.tasks.create({ data: { id: "test-task", title: "Created", status: "todo" } }));
    assert.equal((await repo.getTask(task.id)).data.title, "Created");
    task = await harness.action(s => s.tasks.update(task.id, { version: task.version, data: { title: "Updated" } }));
    [task] = await harness.action(s => s.tasks.reorder([{ id: task.id, version: task.version, position: 2 }]));
    assert.equal(harness.state.tasks.data[0].position, 2);
  });
  await check("409 retains confirmed state and explicit refresh recovers", async () => {
    await assert.rejects(harness.action(s => s.tasks.update(task.id, { version: 1, data: { title: "stale" } })), { status: 409 });
    assert.equal(harness.state.tasks.data[0].data.title, "Updated"); await harness.action(s => s.tasks.refresh());
  });
  await check("Widget create/read/update/delete", async () => {
    widget = await harness.action(s => s.widgets.create({ data: { id: "test-widget", type: "note", span: 6, height: 200, config: { text: "Created" } } }));
    widget = await harness.action(s => s.widgets.update(widget.id, { version: widget.version, data: { config: { text: "Updated" } } }));
    assert.equal((await repo.getWidget(widget.id)).data.config.text, "Updated");
    await harness.action(s => s.widgets.remove(widget.id, { version: widget.version })); assert.deepEqual(harness.state.widgets.data, []);
  });
  await check("Task delete, Board/Workspace switching and widget presence", async () => {
    await harness.action(s => s.tasks.remove(task.id, { version: task.version }));
    await harness.action(s => s.selectBoard(b.id)); await harness.flush(); assert.equal(harness.state.widgetPresence, "absent"); assert.equal(harness.state.selection.allowWrites, false);
    await harness.action(s => s.connect(ws2.id, true)); await harness.flush(); assert.equal(harness.state.widgetPresence, "present"); assert.deepEqual(harness.state.widgets.data, []);
    await harness.action(s => s.disconnect());
  });
  if (process.argv.includes("--serve") || process.argv.includes("--http-smoke")) {
    await harness.host.close(); harness = null;
    // Explicit CLI action creates only the fixture above; Next startup never seeds data.
    const origin = "http://127.0.0.1:3113";
    const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "3113"], { env: { ...process.env, SLOWLY_LOCAL_API_ORIGIN: origin }, stdio: "inherit", windowsHide: true });
    report.serverPid = child.pid; save();
    report.serverStopped = false; save();
    console.log(`Open ${origin}/dev/api-board ; Ctrl+C stops the owned server and cleans only ${tableName}`);
    let stopPromise;
    const stop = () => stopPromise ||= new Promise((resolve, reject) => {
      if (process.platform !== "win32") { child.kill("SIGTERM"); resolve(); return; }
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", reject); killer.on("exit", code => code === 0 ? resolve() : reject(new Error(`Unable to stop owned server PID ${child.pid}; cleanup withheld`)));
    });
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try {
      if (process.argv.includes("--http-smoke")) {
        await check("Next isolated page renders default readonly console via real HTTP", async () => {
          let response;
          for (let n = 0; n < 120; n++) {
            try { response = await fetch(`${origin}/dev/api-board`, { signal: AbortSignal.timeout(15000) }); if (response.status === 200) break; } catch { /* server startup only; no writes are retried */ }
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          assert.equal(response?.status, 200); assert.match(await response.text(), /API 隔離測試/);
          const denied = await fetch(`${origin}/api/workspaces/${encodeURIComponent(foreign.id)}`);
          assert.equal(denied.status, 403);
          const migrationDenied = await fetch(`${origin}/api/migrations/preview`, { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: "{}" });
          assert.equal(migrationDenied.status, 403);
        });
      } else { const [code] = await once(child, "exit"); if (code && code !== 130) report.serverExitCode = code; }
    }
    finally {
      process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
      if (child.exitCode === null) await stop(); else if (stopPromise) await stopPromise;
      report.serverStopped = true;
    }
  }
} catch (error) { report.error = { name: error.name, message: error.message }; process.exitCode = 1; }
finally {
  if (harness) await harness.host.close();
  if (report.created && (!report.serverPid || report.serverStopped)) {
    assert.equal(tableName, `Slowly_Phase4B2_${runId.replaceAll("-", "")}`);
    await client.send(new DeleteTableCommand({ TableName: tableName })); await waitUntilTableNotExists({ client, maxWaitTime: 30 }, { TableName: tableName }); report.cleaned = true;
  }
  if (report.created && !report.cleaned) report.cleanupRequired = "Stop only serverPid and its owned children, then delete only testTable after verifying runId.";
  if (before) { report.originalUnchanged = before === fingerprint(await scan("SlowlyTasks")); if (!report.originalUnchanged) process.exitCode = 1; }
  save(); client.destroy(); console.log(JSON.stringify(report, null, 2));
}
