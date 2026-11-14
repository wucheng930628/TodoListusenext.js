import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSlowlyApi } from "../src/lib/client/slowly-api.mjs";
import { createApi } from "../src/lib/api/handlers.mjs";
import { createRepository } from "../src/lib/slowly-repository.mjs";
import { MemoryClient } from "./helpers/memory-client.mjs";

function fixture() {
  const db = new MemoryClient(); const repo = createRepository(db); const origin = "http://127.0.0.1:3000";
  const handlers = Object.fromEntries(["workspaces", "boards", "tasks", "widgets"].map(resource => [resource, createApi(resource, { getRepository: async () => repo, configuration: () => ({ NODE_ENV: "development", SLOWLY_LOCAL_API: "1" }) })]));
  const calls = [];
  const fetchImpl = async (path, init) => {
    calls.push({ path, method: init.method });
    const url = new URL(path, origin); const [, , resource, encoded] = url.pathname.split("/");
    const id = encoded === undefined ? undefined : decodeURIComponent(encoded);
    const handler = id === "order" ? "orderPatch" : id === undefined ? { GET: "collectionGet", POST: "collectionPost" }[init.method] : { GET: "itemGet", PATCH: "itemPatch", DELETE: "itemDelete" }[init.method];
    return handlers[resource][handler](new Request(url, { ...init, headers: { ...init.headers, host: "127.0.0.1:3000", Origin: origin } }), { params: Promise.resolve({ id }) });
  };
  return { db, repo, calls, fetchImpl, api: createSlowlyApi({ fetchImpl }) };
}

test("adapter → actual handlers → actual repository contract with isolated in-memory data and cleanup", async () => {
  const { db, api } = fixture(); const legacy = { id: "old-test-task", title: "unchanged" }; db.items.set(legacy.id, legacy);
  const created = new Set();
  try {
    const ws = await api.createWorkspace({ data: {} }); created.add(ws.id);
    const list = await api.listWorkspaces({ id: ws.id }); assert.equal(list[0].id, ws.id);
    assert.equal((await api.getWorkspace(ws.id)).version, 1);
    await api.updateWorkspace(ws.id, { version: 1, data: { settings: { theme: "slowly" } } });
    await assert.rejects(api.listWorkspaces(), { status: 501, code: "NOT_SUPPORTED" });
    const board = await api.createBoard({ workspaceId: ws.id, position: 1, data: { id: "front-board", name: "測試", description: "", wipLimit: 1 } }); created.add(board.id);
    assert.equal((await api.listBoards({ workspaceId: ws.id }))[0].id, board.id);
    await api.updateBoard(board.id, { workspaceId: ws.id, version: 1, data: { name: "已更新" } });
    const task = await api.createTask({ boardId: board.id, position: 0, data: { id: "front-task", title: "任務", status: "todo" } }); created.add(task.id);
    assert.equal((await api.getTask(task.id, { boardId: board.id })).id, task.id);
    assert.equal((await api.listTasks({ boardId: board.id }))[0].id, task.id);
    const updatedTask = await api.updateTask(task.id, { boardId: board.id, version: 1, data: { status: "doing" } });
    await assert.rejects(api.updateTask(task.id, { boardId: board.id, version: 1, data: { title: "stale" } }), { status: 409, code: "CONFLICT" });
    const [orderedTask] = await api.reorderTasks({ boardId: board.id, entries: [{ id: task.id, version: updatedTask.version, position: 2 }] });
    const widget = await api.createWidget({ boardId: board.id, data: { id: "front-widget", type: "note", span: 6, height: 260, config: { text: "筆記" } } }); created.add(widget.id);
    assert.equal((await api.getWidget(widget.id)).id, widget.id);
    assert.equal((await api.listWidgets({ boardId: board.id }))[0].id, widget.id);
    const updatedWidget = await api.updateWidget(widget.id, { boardId: board.id, version: 1, data: { span: 12 } });
    const [orderedWidget] = await api.reorderWidgets({ boardId: board.id, entries: [{ id: widget.id, version: updatedWidget.version, position: 3 }] });
    await api.reorderBoards({ workspaceId: ws.id, entries: [{ id: board.id, version: (await api.getBoard(board.id)).version, position: 0 }] });
    await assert.rejects(api.createTask({ boardId: board.id, data: { id: "other", title: "blocked", status: "todo", completedAt: null } }), { status: 400 });
    assert.equal(await api.deleteWidget(widget.id, { boardId: board.id, version: orderedWidget.version }), null);
    assert.equal(await api.deleteTask(task.id, { boardId: board.id, version: orderedTask.version }), null);
    assert.equal(await api.deleteBoard(board.id, { workspaceId: ws.id, version: (await api.getBoard(board.id)).version }), null);
  } finally {
    // Memory only; never deletes any item not returned by our create calls.
    for (const id of created) db.items.delete(id);
  }
  assert.deepEqual([...db.items.values()], [legacy]);
});

test("lost POST response is ambiguous; adapter sends once and current API cannot deduplicate a manual repeat", async () => {
  const { db, fetchImpl, calls } = fixture();
  const api = createSlowlyApi({ fetchImpl: async (...args) => { await fetchImpl(...args); throw new TypeError("response lost after commit"); } });
  const input = { data: { settings: { testRun: randomUUID() } } };
  await assert.rejects(api.createWorkspace(input), { code: "NETWORK_ERROR", status: null, outcome: "not-confirmed" });
  assert.equal(calls.length, 1); assert.equal(db.items.size, 1);
  // Demonstrates the existing API gap in memory only, not a recommended retry.
  await createSlowlyApi({ fetchImpl }).createWorkspace(input);
  assert.equal(db.items.size, 2);
});
