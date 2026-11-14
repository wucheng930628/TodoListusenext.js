import test from "node:test";
import assert from "node:assert/strict";
import { providerHarness } from "./helpers/controlled-provider-host.mjs";
import { createSlowlyApi } from "../src/lib/client/slowly-api.mjs";
import { createApi } from "../src/lib/api/handlers.mjs";
import { createRepository } from "../src/lib/slowly-repository.mjs";
import { MemoryClient } from "./helpers/memory-client.mjs";
import { controlledBinding } from "../src/lib/testing/controlled-environment.mjs";

test("controlled table binding is explicit, development-only and fails closed", () => {
  assert.equal(controlledBinding({}), null);
  assert.throws(() => controlledBinding({ SLOWLY_CONTROLLED_UI_TABLE: "SlowlyTasks" }));
  assert.throws(() => controlledBinding({ NODE_ENV: "production", SLOWLY_CONTROLLED_UI_RUN_ID: "a".repeat(36), SLOWLY_CONTROLLED_UI_TABLE: "SlowlyTasks" }));
});

test("Provider rapid Board switch cancels old requests and rejects late responses", async () => {
  const pending = []; const dto = (id, boardId) => ({ id, workspaceId: "ws", boardId, version: 1, position: 0, data: { id, title: id } });
  const api = {
    async getWorkspace() { return { id: "ws", version: 1, position: 0, data: { settings: { controlledUiTestRun: "run" } } }; },
    async listBoards() { return [dto("a"), dto("b")]; },
    listTasks(query, { signal }) { return new Promise(resolve => pending.push({ boardId: query.boardId, signal, resolve })); },
    async listWidgets() { return []; },
  };
  const harness = await providerHarness(api, { runId: "run", allowedWorkspaces: [{ id: "ws" }], boardWidgetPresence: {} });
  try {
    await harness.action(s => s.connect("ws", true)); await harness.flush();
    const a = pending.find(item => item.boardId === "a"); assert.ok(a);
    await harness.action(s => s.selectBoard("b")); await harness.flush(); assert.equal(a.signal.aborted, true);
    await harness.action(() => pending.find(item => item.boardId === "b").resolve([dto("new", "b")]));
    await harness.action(() => a.resolve([dto("old", "a")]));
    assert.equal(harness.state.tasks.data[0].id, "new");
    await harness.action(s => s.tasks.cancel()); await harness.action(s => s.disconnect());
  } finally { await harness.host.close(); }
});

test("Workspace marker mismatch blocks dependent queries and write grants", async () => {
  let calls = 0;
  const api = { async getWorkspace() { return { id: "ws", version: 1, position: 0, data: { settings: { controlledUiTestRun: "other" } } }; }, async listBoards() { calls++; return []; } };
  const harness = await providerHarness(api, { runId: "run", allowedWorkspaces: [{ id: "ws" }], boardWidgetPresence: {} });
  try {
    await harness.action(s => s.connect("ws", true)); await harness.flush(); assert.equal(harness.state.owned, false); assert.equal(calls, 0);
    assert.throws(() => harness.state.authorizeWrites("ws"));
  } finally { await harness.host.close(); }
});

test("StrictMode Provider → adapter → handlers → repository CRUD, isolation and recovery", async () => {
  const repo = createRepository(new MemoryClient()); const runId = "isolated-unit";
  const ws = await repo.createWorkspace({ settings: { controlledUiTestRun: runId } });
  const ws2 = await repo.createWorkspace({ settings: { controlledUiTestRun: runId } });
  const a = await repo.createBoard(ws.id, { id: "a", name: "A", description: "", wipLimit: 4 });
  const b = await repo.createBoard(ws.id, { id: "b", name: "B", description: "", wipLimit: 4 }, 1);
  const c = await repo.createBoard(ws2.id, { id: "c", name: "C", description: "", wipLimit: 4 });
  const handlers = Object.fromEntries(["workspaces", "boards", "tasks", "widgets"].map(name => [name, createApi(name, { getRepository: async () => repo, configuration: () => ({ NODE_ENV: "development", SLOWLY_LOCAL_API: "1" }) })]));
  const calls = []; let networkFailure = false;
  const api = createSlowlyApi({ fetchImpl: async (path, init) => {
    calls.push(init.method); if (networkFailure) throw new TypeError("offline");
    const url = new URL(path, "http://127.0.0.1:3000"); const [, , name, encoded] = url.pathname.split("/"); const id = encoded && decodeURIComponent(encoded);
    const key = id === "order" ? "orderPatch" : !id ? { GET: "collectionGet", POST: "collectionPost" }[init.method] : { GET: "itemGet", PATCH: "itemPatch", DELETE: "itemDelete" }[init.method];
    return handlers[name][key](new Request(url, { ...init, headers: { ...init.headers, host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } }), { params: Promise.resolve({ id }) });
  } });
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Storage must never be touched"); } });
  const harness = await providerHarness(api, { runId, allowedWorkspaces: [ws, ws2], boardWidgetPresence: { [a.id]: "present", [b.id]: "absent", [c.id]: "present" } });
  const { action, flush } = harness;
  try {
    assert.equal(harness.state.selection.mode, "localStorage"); assert.equal(calls.length, 0);
    assert.throws(() => harness.state.connect("unknown", true)); assert.throws(() => harness.state.connect(ws.id, false));
    await action(s => s.connect(ws.id, true)); await flush(); assert.equal(harness.state.boardId, a.id); assert.equal(harness.state.tasks.success, true);
    await assert.rejects(harness.state.tasks.create({ data: {} }), { code: "API_WRITES_DISABLED" });
    assert.equal(calls.filter(method => method !== "GET").length, 0);
    await action(s => s.authorizeWrites(ws.id)); await flush();
    const task = await action(s => s.tasks.create({ data: { id: "front-task", title: "Test", status: "todo" } }));
    assert.equal(harness.state.tasks.idMapping[0].frontendId, "front-task");
    await action(s => s.tasks.update(task.id, { version: task.version, data: { title: "Updated" } }));
    await assert.rejects(action(s => s.tasks.update(task.id, { version: task.version, data: { title: "Conflict" } })), { status: 409 });
    assert.equal(harness.state.tasks.mutation.status, "error"); assert.equal(harness.state.tasks.data[0].data.title, "Updated");
    await action(s => s.tasks.refresh());
    await action(s => s.tasks.reorder(s.tasks.data.map((item, position) => ({ id: item.id, version: item.version, position }))));
    const widget = await action(s => s.widgets.create({ data: { id: "front-widget", type: "note", span: 6, height: 200, config: { text: "note" } } }));
    const changed = await action(s => s.widgets.update(widget.id, { version: widget.version, data: { config: { text: "changed" } } }));
    await action(s => s.widgets.remove(changed.id, { version: changed.version })); assert.deepEqual(harness.state.widgets.data, []);
    networkFailure = true;
    await assert.rejects(action(s => s.tasks.update(s.tasks.data[0].id, { version: s.tasks.data[0].version, data: { title: "offline" } })), { code: "NETWORK_ERROR" });
    assert.equal(harness.state.selection.mode, "api"); networkFailure = false;
    await action(s => s.tasks.refresh()); await action(s => s.tasks.remove(s.tasks.data[0].id, { version: s.tasks.data[0].version }));
    await action(s => s.selectBoard(b.id)); await flush(); assert.equal(harness.state.widgetPresence, "absent"); assert.equal(harness.state.selection.allowWrites, false);
    await action(s => s.connect(ws2.id, true)); await flush(); assert.equal(harness.state.boardId, c.id); assert.equal(harness.state.widgetPresence, "present");
    await action(s => s.tasks.cancel()); await action(s => s.disconnect()); assert.equal(harness.state.selection.mode, "localStorage");
    assert.equal(calls.filter(method => method === "POST").length, 2, "StrictMode did not repeat writes");
  } finally { await harness.host.close(); if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage); else delete globalThis.localStorage; }
});
