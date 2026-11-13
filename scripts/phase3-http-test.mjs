import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DeleteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { createLocalDocumentClient, localClientOptions } from "../src/lib/local-dynamodb.mjs";

if (!process.argv.includes("--isolated-local-writes")) throw new Error("Explicit isolated local-write test flag required");
process.env.DYNAMODB_ENDPOINT = "http://127.0.0.1:9000";
const options = localClientOptions();
assert.equal(options.endpoint, "http://127.0.0.1:9000");
const db = createLocalDocumentClient(); const runId = randomUUID();
const folder = resolve(".phase3-test-runs", runId); mkdirSync(folder, { recursive: true });
const reportPath = resolve(folder, "report.json");
const report = { runId, endpoint: options.endpoint, origin: "http://127.0.0.1:3107", requests: [], created: [], cleanup: [] };
const plannedFrontendIds = new Set();
function save() { writeFileSync(reportPath, JSON.stringify(report, null, 2)); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
const hash = item => createHash("sha256").update(JSON.stringify(stable(item))).digest("hex");
async function scan() {
  const items = []; let cursor;
  do {
    const response = await db.send(new ScanCommand({ TableName: "SlowlyTasks", ConsistentRead: true, ExclusiveStartKey: cursor }));
    items.push(...response.Items || []); cursor = response.LastEvaluatedKey;
  } while (cursor);
  return items;
}
function frontendId(name) { const id = `api-${runId}-${name}`; plannedFrontendIds.add(id); report.plannedFrontendIds = [...plannedFrontendIds]; save(); return id; }
function owned(item) {
  return !Object.hasOwn(report.baseline, item.id) && item.id.startsWith(`SLOWLY#${item.entityType}#`) && (
    (["WORKSPACE", "BOARD"].includes(item.entityType) && item.data?.settings?.apiTestRun === runId) ||
    (["TASK", "WIDGET"].includes(item.entityType) && plannedFrontendIds.has(item.data?.id)));
}
let server; let serverLog; let failure;
async function call(method, path, input, expected = 200) {
  const entry = { method, path, expected, state: "requested" }; report.requests.push(entry); save();
  const result = await fetch(`${report.origin}/api/${path}`, { method, headers: { Origin: report.origin, ...(input === undefined ? {} : { "Content-Type": "application/json" }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(20000) });
  const value = result.status === 204 ? null : await result.json(); entry.status = result.status; entry.state = "received"; save();
  assert.equal(result.status, expected, `${method} ${path}: ${JSON.stringify(value)}`);
  if (method === "POST" && result.status === 201) { report.created.push({ id: value.data.id, frontendId: value.data.data.id, path }); save(); }
  return value?.data;
}
const pathId = item => encodeURIComponent(item.id);
async function get(resource, item) { return call("GET", `${resource}/${pathId(item)}`); }
async function list(resource, key, id, count, first) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const items = await call("GET", `${resource}?${key}=${encodeURIComponent(id)}`);
    if (items.length === count && (!first || items[0]?.id === first)) return items;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`GSI query did not converge for ${resource}`);
}
try {
  report.baseline = Object.fromEntries((await scan()).map(item => [item.id, hash(item)])); save();
  // Only this newly spawned loopback process is terminated in finally.
  serverLog = createWriteStream(resolve(folder, "next-dev.log"));
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "3107"], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SLOWLY_API_TEST: "1", SLOWLY_LOCAL_API: "1", SLOWLY_LOCAL_API_ORIGIN: report.origin, DYNAMODB_ENDPOINT: options.endpoint, AWS_REGION: options.region, AWS_ACCESS_KEY_ID: options.credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: options.credentials.secretAccessKey },
  });
  report.serverPid = server.pid; save();
  server.stdout.pipe(serverLog); server.stderr.pipe(serverLog);
  let ready = false; let launchError;
  server.on("error", error => { launchError = error; });
  for (let attempt = 0; attempt < 80; attempt++) {
    if (launchError) throw launchError;
    if (server.exitCode !== null) throw new Error("Test server exited before startup; see next-dev.log");
    try {
      const response = await fetch(`${report.origin}/api/workspaces`, { signal: AbortSignal.timeout(1500) });
      if (response.status === 501) { ready = true; break; }
    } catch { /* wait for compilation */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, "Isolated dev server did not become ready");
  await call("GET", "workspaces", undefined, 501);
  const workspaceData = { settings: { apiTestRun: runId } };
  const ws = await call("POST", "workspaces", { data: workspaceData }, 201);
  const ws2 = await call("POST", "workspaces", { data: workspaceData }, 201);
  await get("workspaces", ws);
  await call("GET", `workspaces?id=${pathId(ws)}`);
  await call("PATCH", `workspaces/${pathId(ws)}`, { version: ws.version, data: { settings: { apiTestRun: runId, updated: true } } });
  await call("PATCH", `workspaces/${pathId(ws)}`, { version: ws.version, data: { settings: workspaceData.settings } }, 409);
  const boardData = name => ({ id: frontendId(name), name: "API 隔離測試", description: "", wipLimit: 1, settings: { apiTestRun: runId } });
  const board = await call("POST", "boards", { workspaceId: ws.id, data: boardData("board-1") }, 201);
  const board2 = await call("POST", "boards", { workspaceId: ws2.id, data: boardData("board-2") }, 201);
  await get("boards", board); await list("boards", "workspaceId", ws.id, 1);
  await call("PATCH", `boards/${pathId(board)}`, { workspaceId: ws.id, version: board.version, data: { name: "更新看板" } });
  await call("PATCH", `boards/${pathId(board)}`, { workspaceId: ws2.id, version: board.version, data: { name: "非法" } }, 403);
  const tasks = [];
  for (let i = 0; i < 2; i++) tasks.push(await call("POST", "tasks", { boardId: board.id, workspaceId: ws.id, position: i, data: { id: frontendId(`task-${i}`), title: "API 任務", status: "todo", subtasks: [{ id: "sub", title: "步驟", done: false }] } }, 201));
  await get("tasks", tasks[0]); await list("tasks", "boardId", board.id, 2);
  tasks[0] = await call("PATCH", `tasks/${pathId(tasks[0])}`, { boardId: board.id, version: tasks[0].version, data: { status: "doing", notes: "更新" } });
  await call("PATCH", `tasks/${pathId(tasks[1])}`, { boardId: board.id, version: tasks[1].version, data: { status: "doing" } }, 409);
  await call("PATCH", `tasks/${pathId(tasks[0])}`, { boardId: board.id, version: 1, data: { title: "過期版本" } }, 409);
  await call("DELETE", `tasks/${pathId(tasks[0])}`, { boardId: board2.id, version: tasks[0].version }, 403);
  await call("POST", "tasks", { boardId: board.id, workspaceId: ws2.id, data: { id: frontendId("rejected"), title: "非法", status: "todo" } }, 403);
  tasks[0] = await call("PATCH", `tasks/${pathId(tasks[0])}`, { boardId: board.id, version: tasks[0].version, data: { status: "done" } });
  assert.ok(tasks[0].data.completedAt);
  const ordered = await call("PATCH", "tasks/order", { boardId: board.id, entries: tasks.map((item, i) => ({ id: item.id, version: item.version, position: 1 - i })) });
  tasks.splice(0, tasks.length, ...ordered);
  await list("tasks", "boardId", board.id, 2, tasks[1].id);
  const widgets = [];
  for (let i = 0; i < 2; i++) widgets.push(await call("POST", "widgets", { boardId: board.id, position: i, data: { id: frontendId(`widget-${i}`), type: "note", span: 6, height: 260, config: { text: "筆記" } } }, 201));
  await get("widgets", widgets[0]); await list("widgets", "boardId", board.id, 2);
  widgets[0] = await call("PATCH", `widgets/${pathId(widgets[0])}`, { boardId: board.id, version: 1, data: { config: { text: "更新" }, span: 12 } });
  const widgetOrder = await call("PATCH", "widgets/order", { boardId: board.id, entries: widgets.map((item, i) => ({ id: item.id, version: item.version, position: 1 - i })) });
  widgets.splice(0, widgets.length, ...widgetOrder);
  const current = await get("boards", board);
  await call("PATCH", "boards/order", { workspaceId: ws.id, entries: [{ id: board.id, version: current.version, position: 3 }] });
  await call("DELETE", `boards/${pathId(board)}`, { workspaceId: ws.id, version: (await get("boards", board)).version }, 409);
  await call("GET", "tasks?boardId=bad", undefined, 400);
  await call("POST", "workspaces", { data: {}, entityType: "TASK" }, 400);
  await call("GET", `tasks/${encodeURIComponent(`SLOWLY#TASK#${randomUUID()}`)}`, undefined, 404);
  for (const [resource, items] of [["widgets", widgets], ["tasks", tasks]]) {
    for (const item of items) { await call("DELETE", `${resource}/${pathId(item)}`, { boardId: board.id, version: item.version }, 204); await call("GET", `${resource}/${pathId(item)}`, undefined, 404); }
  }
  for (const [item, workspaceId] of [[board, ws.id], [board2, ws2.id]]) await call("DELETE", `boards/${pathId(item)}`, { workspaceId, version: (await get("boards", item)).version }, 204);
  report.apiPassed = true; save();
} catch (error) {
  failure = error; report.error = { name: error.name, message: error.message }; save();
} finally {
  try {
    if (report.baseline) {
      for (const item of (await scan()).filter(owned)) {
        const marker = ["WORKSPACE", "BOARD"].includes(item.entityType);
        await db.send(new DeleteCommand({ TableName: "SlowlyTasks", Key: { id: item.id }, ConditionExpression: `#v = :v AND ${marker ? "#d.#s.#r = :run" : "#d.#i = :id"}`, ExpressionAttributeNames: { "#v": "version", "#d": "data", ...(marker ? { "#s": "settings", "#r": "apiTestRun" } : { "#i": "id" }) }, ExpressionAttributeValues: { ":v": item.version, ...(marker ? { ":run": runId } : { ":id": item.data.id }) } }));
        report.cleanup.push({ id: item.id, status: "deleted-with-run-condition" }); save();
      }
      const remaining = await scan();
      const after = Object.fromEntries(remaining.map(item => [item.id, hash(item)]));
      assert.deepEqual(after, report.baseline, "Baseline changed or test data remains; no automatic repair attempted");
      report.final = { baselineItemsUnchanged: remaining.length, testItemsRemaining: remaining.filter(owned).length, created: report.created.length };
    }
  } catch (error) { failure ||= error; report.cleanupError = { name: error.name, message: error.message }; }
  if (server?.pid) {
    if (process.platform === "win32") {
      const stopped = spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      if (stopped.status !== 0 && server.exitCode === null) {
        failure ||= new Error("Failed to stop the isolated test server");
        report.processCleanupError = { pid: server.pid, message: "Failed to stop the isolated test server" };
      }
    }
    else server.kill("SIGTERM");
    server.stdout.destroy(); server.stderr.destroy();
  }
  serverLog?.end(); db.destroy(); report.success = !failure; report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ success: report.success, requests: report.requests.length, final: report.final, error: report.error, cleanupError: report.cleanupError, reportPath }));
}
if (failure) process.exitCode = 1;
