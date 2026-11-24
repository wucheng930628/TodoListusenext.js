import test from "node:test";
import assert from "node:assert/strict";
import { mainUiFixture } from "./helpers/main-ui-fixture.mjs";
import { workspaceFixture } from "./phase4a-fixtures.mjs";
import { createMainWorkspaceController } from "../src/lib/client/main-workspace-controller.mjs";
import { createMainUiSession } from "../src/lib/client/main-ui-session.mjs";
import { encodeMainPatch, projectMainView } from "../src/lib/client/main-view-model.mjs";
import { readWorkspaceView, createWorkspaceViewApi } from "../src/lib/api/workspace-view.mjs";
import { createSlowlyApi } from "../src/lib/client/slowly-api.mjs";

test("default source, dev/ready/workspace gates, readonly and no storage access", async () => {
  const f = await mainUiFixture(); const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Storage access prohibited"); } });
  try {
    assert.equal(f.controller.getSnapshot().mode, "localStorage"); assert.equal(f.calls.length, 0);
    await assert.rejects(f.controller.activate({ workspaceId: f.workspaceId, apiReady: false }));
    await assert.rejects(createMainWorkspaceController({ api: f.api, development: false }).activate({ workspaceId: f.workspaceId, apiReady: true }));
    await f.activate(); await assert.rejects(f.controller.saveTask({ title: "readonly" }), { code: "WRITES_DISABLED" });
    f.grant(); f.controller.deactivate(); assert.equal(f.controller.getSnapshot().mode, "localStorage");
  } finally { if (original) Object.defineProperty(globalThis, "localStorage", original); else delete globalThis.localStorage; }
});

test("DTO → UI model preserves fields, parent-scoped duplicate frontend IDs, presence and positions", async () => {
  const data = workspaceFixture(); data.extension = { retained: true }; data.boards[0].tasks[0].extension = { nested: [1, 2] };
  delete data.boards[1].widgets; data.boards.push({ ...structuredClone(data.boards[1]), id: "empty", tasks: [], widgets: [] });
  const f = await mainUiFixture({ data }); await f.activate();
  assert.deepEqual(f.controller.getSnapshot().projection.workspace, data);
  const mapping = f.controller.getSnapshot().projection.mapping.filter(row => row.type === "task" && row.frontendId === "task-a");
  assert.equal(mapping.length, 2); assert.notEqual(mapping[0].databaseId, mapping[1].databaseId);
  const snapshot = f.controller.getSnapshot().projection.snapshot; const malformed = structuredClone(snapshot); malformed.boards[0].widgetsPresence = null;
  assert.throws(() => projectMainView(malformed, f.workspaceId), { code: "WIDGET_PRESENCE_REQUIRED" });
});

test("read-only activation and refresh surface HTTP and network errors without changing the existing source", async () => {
  const f = await mainUiFixture(); await f.activate();
  const snapshot = f.controller.getSnapshot().projection.snapshot;
  let status = 403;
  const adapter = createSlowlyApi({ fetchImpl: async (_url, { method, signal }) => {
    assert.equal(method, "GET"); assert.ok(signal instanceof AbortSignal);
    if (!status) throw new TypeError("offline");
    return Response.json(status === 200 ? { data: snapshot } : { error: { code: "TEST_ERROR", message: "Read failed" } }, { status });
  } });
  const controller = createMainWorkspaceController({ api: adapter, development: true, readOnly: true, journal: f.journal });
  await controller.bootstrapRecovery();
  const activation = { workspaceId: f.workspaceId, apiReady: true };
  await assert.rejects(controller.activate(activation), { status: 403 });
  assert.equal(controller.getSnapshot().mode, "localStorage");
  assert.equal(controller.getSnapshot().startupStatus, "ready");
  status = 200; await controller.activate(activation);
  assert.throws(() => controller.authorizeWrites(f.workspaceId), { code: "WRITES_DISABLED" });
  const previous = controller.getSnapshot().projection;
  for (const code of [403, 404, 409, 503, null]) {
    status = code;
    await assert.rejects(controller.refresh(), code ? { status: code } : { code: "NETWORK_ERROR" });
    assert.equal(controller.getSnapshot().mode, "api");
    assert.equal(controller.getSnapshot().status, "error");
    assert.equal(controller.getSnapshot().projection, previous);
  }
});

test("duplicate refresh is coalesced and an aborted snapshot cannot overwrite a newer activation", async () => {
  const f = await mainUiFixture(); await f.activate();
  const snapshot = f.controller.getSnapshot().projection.snapshot;
  let request;
  let calls = 0;
  const controller = createMainWorkspaceController({ development: true, journal: f.journal,
    readView: async (_id, { signal }) => { calls++; return request ? request(signal) : snapshot; } });
  const scope = { workspaceId: f.workspaceId, apiReady: true };
  await controller.activate(scope);
  const old = Promise.withResolvers();
  let oldSignal;
  request = signal => { oldSignal = signal; return old.promise; };
  const first = controller.refresh();
  assert.equal(controller.refresh(), first);
  assert.equal(calls, 2);
  request = undefined;
  await controller.activate(scope);
  assert.equal(oldSignal.aborted, true);
  const current = controller.getSnapshot().projection;
  old.resolve({ ...snapshot, workspace: { ...snapshot.workspace, data: { stale: true } } });
  await first;
  assert.equal(controller.getSnapshot().projection, current);
});

test("Task create/edit/subtasks/notes/priority/status/order/delete round-trip through actual API", async () => {
  const data = workspaceFixture(); data.boards[0].tasks[0].subtasks[0].extension = { preserved: true };
  const f = await mainUiFixture({ data }); await f.activate(); f.grant();
  let row = f.controller.getSnapshot().projection.workspace.boards[0].tasks[0];
  await f.controller.saveTask({ ...row, notes: "  keep whitespace\n", priority: "低", status: "doing", subtasks: row.subtasks.map(item => ({ ...item, done: true })) });
  row = f.controller.getSnapshot().projection.workspace.boards[0].tasks[0];
  assert.equal(row.notes, "  keep whitespace\n"); assert.equal(row.subtasks[0].extension.preserved, true); assert.equal(row.subtasks[0].done, true);
  const created = await f.controller.saveTask({ id: "new-task", title: "New", status: "todo", description: "", tag: "個人", priority: "一般", urgent: false, date: "", time: "", subtasks: [], notes: "" });
  const ids = f.controller.getSnapshot().projection.workspace.boards[0].tasks.map(task => task.id).reverse(); await f.controller.reorderTasks(ids);
  assert.deepEqual(f.controller.getSnapshot().projection.workspace.boards[0].tasks.map(task => task.id), ids);
  await f.controller.saveTask({ ...f.controller.getSnapshot().projection.workspace.boards[0].tasks.find(task => task.id === created.data.id), status: "done" });
  assert.ok(f.controller.getSnapshot().projection.workspace.boards[0].tasks.find(task => task.id === "new-task").completedAt);
  await f.controller.deleteTask("new-task"); assert.equal(f.controller.getSnapshot().projection.workspace.boards[0].tasks.some(task => task.id === "new-task"), false);
});

test("Board create/update/reorder, empty workspace and WIP constraints", async () => {
  const f = await mainUiFixture(); await f.activate(); f.grant();
  const created = await f.controller.saveBoard({ id: "new-board", name: "New", description: "", wipLimit: 2 });
  assert.ok(created.id.startsWith("SLOWLY#BOARD#"));
  f.controller.selectBoard("new-board"); f.grant();
  await f.controller.saveBoard({ ...f.controller.getSnapshot().projection.workspace.boards.find(board => board.id === "new-board"), name: "Updated" });
  const ids = f.controller.getSnapshot().projection.workspace.boards.map(board => board.id).reverse(); await f.controller.reorderBoards(ids);
  assert.deepEqual(f.controller.getSnapshot().projection.workspace.boards.map(board => board.id), ids);
  f.controller.selectBoard("board-a"); f.grant();
  let board = f.controller.getSnapshot().projection.workspace.boards.find(board => board.id === "board-a"); await f.controller.saveBoard({ ...board, wipLimit: 1 });
  board = f.controller.getSnapshot().projection.workspace.boards.find(board => board.id === "board-a"); await f.controller.saveTask({ ...board.tasks[0], status: "doing" });
  await assert.rejects(f.controller.saveTask({ ...board.tasks[1], status: "doing" }), { status: 409, code: "WIP_LIMIT" });
  const empty = await f.repository.createWorkspace({}); await f.controller.activate({ workspaceId: empty.id, apiReady: true }); assert.deepEqual(f.controller.getSnapshot().projection.workspace.boards, []);
});

test("Widget CRUD/order/size/config keeps unknown fields and explicit empty after final delete", async () => {
  const data = workspaceFixture(); data.boards[0].widgets[0].extension = { retained: true }; data.boards[0].widgets[0].config.extension = { retained: true };
  const f = await mainUiFixture({ data }); await f.activate(); f.grant();
  const current = f.controller.getSnapshot().projection.workspace.boards[0].widgets[0];
  await f.controller.saveWidget({ ...current, span: 12, height: 450, manualSize: true, config: { ...current.config, text: "  note  " } });
  const updated = f.controller.getSnapshot().projection.workspace.boards[0].widgets[0]; assert.deepEqual(updated.extension, current.extension); assert.equal(updated.config.extension.retained, true);
  await f.controller.saveWidget({ id: "new-widget", type: "timer", span: 6, height: 260, config: { minutes: 25, endsAt: 1794640000000, taskId: "task-a" } });
  const ids = f.controller.getSnapshot().projection.workspace.boards[0].widgets.map(item => item.id).reverse(); await f.controller.reorderWidgets(ids);
  for (const id of ids) await f.controller.deleteWidget(id);
  assert.deepEqual(f.controller.getSnapshot().projection.workspace.boards[0].widgets, []);
});

test("absent Widgets are untouched by reads and only become present through explicit creation", async () => {
  const data = workspaceFixture(); delete data.boards[1].widgets;
  const f = await mainUiFixture({ data }); await f.activate(); f.controller.selectBoard("board-b"); f.grant();
  assert.equal(Object.hasOwn(f.controller.getSnapshot().projection.workspace.boards[1], "widgets"), false);
  await f.controller.saveWidget({ id: "first", type: "note", span: 6, height: 200, config: {} });
  await f.controller.deleteWidget("first"); await f.controller.refresh();
  assert.deepEqual(f.controller.getSnapshot().projection.workspace.boards[1].widgets, []);
});

test("409 does not adopt a stale draft after refresh, and read failure never activates fallback", async () => {
  const f = await mainUiFixture(); await f.activate(); f.grant();
  const old = createMainUiSession({ ...f.controller.getSnapshot(), controller: f.controller }); const task = old.workspace.boards[0].tasks[0]; const version = old.taskVersion(task.id);
  await f.controller.saveTask({ ...task, title: "server changed" });
  await assert.rejects(f.controller.saveTask({ ...task, title: "stale" }, { expectedVersion: version }), { status: 409 });
  assert.equal(f.controller.getSnapshot().projection.workspace.boards[0].tasks[0].title, "server changed");
  assert.equal(f.controller.getSnapshot().mode, "api");
});

test("before-commit network loss stays UNKNOWN and cannot be bypassed by source toggle", async () => {
  const f = await mainUiFixture(); await f.activate(); f.grant(); const count = f.calls.filter(call => call.method === "POST").length;
  f.failNextWrite("before");
  await assert.rejects(f.controller.saveTask({ id: "ambiguous", title: "Once", status: "todo" }), { code: "NETWORK_ERROR" });
  assert.equal(f.calls.filter(call => call.method === "POST").length, count + 1); assert.equal(f.controller.getSnapshot().uncertainWrite, true);
  assert.throws(() => f.controller.deactivate(), { code: "RECOVERY_REQUIRED" });
  await f.activate(); assert.throws(() => f.grant(), { code: "WRITES_DISABLED" });
});

test("cancelled read and stale Board callbacks cannot overwrite or mutate another scope", async () => {
  const f = await mainUiFixture(); let resolve; let signal;
  const controller = createMainWorkspaceController({ api: f.api, journal: f.journal, development: true, readView: (id, options) => { signal = options.signal; return new Promise(done => { resolve = done; }); } });
  const pending = controller.activate({ workspaceId: f.workspaceId, apiReady: true }); await new Promise(setImmediate); controller.cancel(); assert.equal(signal.aborted, true);
  resolve(await f.api.getWorkspaceView(f.workspaceId)); await pending; assert.equal(controller.getSnapshot().projection, null);
  await f.activate(); f.grant(); const old = createMainUiSession({ ...f.controller.getSnapshot(), controller: f.controller });
  f.controller.selectBoard("board-b"); assert.throws(() => old.selectBoard("board-a"), { code: "STALE_SCOPE" });
});

test("runtime view fails closed on GSI omission, missing presence, legacy origin and non-isolation", async () => {
  const f = await mainUiFixture(); const incomplete = { ...f.repository, listBoards: async () => [] };
  await assert.rejects(readWorkspaceView(incomplete, f.workspaceId, { migrationService: f.service }), { code: "SNAPSHOT_NOT_READY" });
  const api = createWorkspaceViewApi({ getRepository: async () => { throw new Error("must not access DB"); }, configuration: () => ({ NODE_ENV: "development", SLOWLY_LOCAL_API: "1" }) });
  const response = await api(new Request(`http://127.0.0.1:3000/api/workspaces/${f.workspaceId}/view`, { headers: { host: "127.0.0.1:3000" } }), { params: Promise.resolve({ id: f.workspaceId }) }); assert.equal(response.status, 403);
});

test("unknown field edits block rather than discard data, and compound Widget changes are rejected", async () => {
  assert.throws(() => encodeMainPatch("task", { id: "x", extension: 1 }, { id: "x", extension: 2 }), { code: "UNSUPPORTED_FIELD" });
  const f = await mainUiFixture(); await f.activate(); f.grant(); const session = createMainUiSession({ ...f.controller.getSnapshot(), controller: f.controller });
  const before = f.calls.length; await assert.rejects(session.changeWidgets(() => []), { code: "UNSUPPORTED_ATOMIC_ACTION" }); assert.equal(f.calls.length, before);
});

test("rapid Board switch ignores a late whole-workspace response and keeps current selection", async () => {
  const f = await mainUiFixture(); let resolve; let deferred = false; let signal;
  const c = createMainWorkspaceController({ api: f.api, journal: f.journal, development: true, readView: (id, options) => deferred ? new Promise(done => { resolve = done; signal = options.signal; }) : f.api.getWorkspaceView(id, options) });
  await c.activate({ workspaceId: f.workspaceId, apiReady: true }); deferred = true;
  const pending = c.refresh(); c.selectBoard("board-b"); assert.equal(signal.aborted, true);
  const stale = await f.api.getWorkspaceView(f.workspaceId); stale.boards[0].tasks[0].data.title = "late old response";
  resolve(stale); await pending; assert.equal(c.getSnapshot().activeBoardId, "board-b"); assert.notEqual(c.getSnapshot().projection.workspace.boards[0].tasks[0].title, "late old response");
});

test("cancel does not cancel a committed POST; late completion cannot unlock or auto-retry", async () => {
  const f = await mainUiFixture(); let resolve; let input; let signal;
  const api = { ...f.api, createTask: (body, options) => { input = body; signal = options.signal; return new Promise(done => { resolve = done; }); } };
  const c = createMainWorkspaceController({ api, journal: f.journal, development: true }); await c.activate({ workspaceId: f.workspaceId, apiReady: true }); c.authorizeWrites(f.workspaceId);
  const pending = c.saveTask({ id: "late-create", title: "Late", status: "todo" }); await new Promise(setImmediate); c.cancel(); assert.equal(signal.aborted, true);
  resolve(await f.api.createTask(input)); await pending;
  assert.equal(c.getSnapshot().uncertainWrite, true); assert.equal(c.getSnapshot().allowWrites, false);
  await c.refresh(); assert.equal(c.getSnapshot().projection.workspace.boards[0].tasks.some(task => task.id === "late-create"), true);
  assert.throws(() => c.authorizeWrites(f.workspaceId), { code: "WRITES_DISABLED" });
});

test("missing legacy metadata blocks readiness, malformed requests are 400 and internal errors stay private", async () => {
  const f = await mainUiFixture(); const root = f.db.items.get(f.workspaceId); delete root.boardCount;
  let snapshot = await readWorkspaceView(f.repository, f.workspaceId, { migrationService: f.service }); assert.equal(snapshot.readiness.eligible, false);
  root.boardCount = f.data.boards.length;
  const board = f.db.items.get(f.plan.operations.find(operation => operation.type === "BOARD").targetId); delete board.restoreShape.widgetsPresent; delete board.widgetPresence;
  snapshot = await readWorkspaceView(f.repository, f.workspaceId, { migrationService: f.service }); assert.equal(snapshot.readiness.eligible, false);
  const make = repository => createWorkspaceViewApi({ isolation: () => true, configuration: () => ({ NODE_ENV: "development", SLOWLY_LOCAL_API: "1" }), getRepository: repository });
  const request = () => new Request("http://127.0.0.1:3000/api/workspaces/id/view", { headers: { host: "127.0.0.1:3000" } });
  assert.equal((await make(async () => f.repository)(request(), { params: Promise.resolve({ id: "invalid" }) })).status, 400);
  const response = await make(async () => { throw new Error("private-sdk-details"); })(request(), { params: Promise.resolve({ id: f.workspaceId }) });
  assert.equal(response.status, 500); assert.doesNotMatch(await response.text(), /private-sdk-details/);
});

test("note draft blocks source/Board changes until explicitly resolved without changing DTOs", async () => {
  const f = await mainUiFixture(); await f.activate();
  const first = createMainUiSession({ ...f.controller.getSnapshot(), controller: f.controller });
  const value = { text: "unsaved A", version: first.widgetVersions["widget-a"] };
  first.noteDraftStore.write("widget-a", value);
  assert.throws(() => f.controller.selectBoard("board-b"), { code: "UNSAVED_DRAFTS" });
  assert.throws(() => f.controller.deactivate(), { code: "UNSAVED_DRAFTS" });
  assert.equal(first.noteDraftStore.read("widget-a").text, "unsaved A");
  assert.notEqual(first.workspace.boards[0].widgets[0].config.text, "unsaved A");
  first.noteDraftStore.clear("widget-a", value); f.controller.selectBoard("board-b");
  assert.equal(f.controller.getSnapshot().activeBoardId, "board-b");
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
});
