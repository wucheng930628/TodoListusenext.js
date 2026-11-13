import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApi } from "../src/lib/api/handlers.mjs";
import { createRepository } from "../src/lib/slowly-repository.mjs";
import { MemoryClient } from "./helpers/memory-client.mjs";
import { taskData, boardData } from "./phase2-scenario.mjs";

const origin = "http://127.0.0.1:3000";
const env = { NODE_ENV: "development", SLOWLY_LOCAL_API: "1" };
function fixture(options = {}) {
  const db = new MemoryClient(); const repo = createRepository(db);
  const api = Object.fromEntries(["workspaces", "boards", "tasks", "widgets"].map(type => [type, createApi(type, { getRepository: options.getRepository || (async () => repo), configuration: () => options.environment || env })]));
  async function call(resource, handler, { method = "GET", id, data, search = "", headers = {}, raw } = {}) {
    const request = new Request(`${origin}/api/${resource}${id ? `/${encodeURIComponent(id)}` : ""}${search}`, {
      method, headers: { host: "127.0.0.1:3000", origin, ...(data !== undefined || raw !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(data !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(data) } : {}),
    });
    const response = await api[resource][handler](request, { params: Promise.resolve({ id }) });
    return { status: response.status, body: response.status === 204 ? null : await response.json(), headers: response.headers };
  }
  return { db, repo, call };
}
async function seed(call) {
  const workspace = (await call("workspaces", "collectionPost", { method: "POST", data: { data: {} } })).body.data;
  const otherWorkspace = (await call("workspaces", "collectionPost", { method: "POST", data: { data: {} } })).body.data;
  const board = (await call("boards", "collectionPost", { method: "POST", data: { workspaceId: workspace.id, data: boardData() } })).body.data;
  const otherBoard = (await call("boards", "collectionPost", { method: "POST", data: { workspaceId: otherWorkspace.id, data: boardData() } })).body.data;
  return { workspace, otherWorkspace, board, otherBoard };
}

test("Workspace POST/GET/PATCH and explicit collection lookup return documented statuses", async () => {
  const { call } = fixture();
  assert.equal((await call("workspaces", "collectionGet")).status, 501);
  assert.equal((await call("workspaces", "collectionGet", { search: "?id=" })).status, 400);
  const created = await call("workspaces", "collectionPost", { method: "POST", data: { data: { settings: { theme: "slowly" } } } });
  assert.equal(created.status, 201); const item = created.body.data;
  assert.equal((await call("workspaces", "itemGet", { id: item.id })).body.data.id, item.id);
  const list = await call("workspaces", "collectionGet", { search: `?id=${encodeURIComponent(item.id)}` });
  assert.equal(list.status, 200); assert.equal(list.body.data.length, 1);
  const updated = await call("workspaces", "itemPatch", { method: "PATCH", id: item.id, data: { version: 1, data: { settings: { theme: "new" } } } });
  assert.equal(updated.status, 200); assert.equal(updated.body.data.version, 2);
  assert.equal((await call("workspaces", "itemPatch", { method: "PATCH", id: item.id, data: { version: 1, data: { settings: {} } } })).status, 409);
  assert.equal("gsi1pk" in updated.body.data, false); assert.equal("entityType" in updated.body.data, false);
});

test("Board, Task, Widget CRUD, lists, no orphan deletion and existing-data protection", async () => {
  const { db, call } = fixture(); const legacy = { id: "manual-item", title: "unchanged" }; db.items.set(legacy.id, legacy);
  const { workspace, board } = await seed(call);
  assert.equal((await call("boards", "collectionGet", { search: `?workspaceId=${encodeURIComponent(workspace.id)}` })).body.data.length, 1);
  let currentBoard = (await call("boards", "itemGet", { id: board.id })).body.data;
  const edited = await call("boards", "itemPatch", { method: "PATCH", id: board.id, data: { workspaceId: workspace.id, version: currentBoard.version, data: { name: "新名稱" } } });
  assert.equal(edited.status, 200);
  const created = [];
  for (const resource of ["tasks", "widgets"]) {
    const data = resource === "tasks" ? (() => { const data = taskData(); delete data.completedAt; return data; })() : { id: "note", type: "note", span: 6, height: 260, config: { text: "筆記" } };
    const result = await call(resource, "collectionPost", { method: "POST", data: { boardId: board.id, workspaceId: workspace.id, data } });
    assert.equal(result.status, 201); const item = result.body.data;
    assert.equal((await call(resource, "itemGet", { id: item.id })).status, 200);
    assert.equal((await call(resource, "collectionGet", { search: `?boardId=${encodeURIComponent(board.id)}` })).body.data.length, 1);
    const update = await call(resource, "itemPatch", { method: "PATCH", id: item.id, data: { boardId: board.id, version: 1, data: resource === "tasks" ? { notes: "更新" } : { config: { text: "更新" } } } });
    assert.equal(update.status, 200); created.push({ resource, item: update.body.data });
  }
  currentBoard = (await call("boards", "itemGet", { id: board.id })).body.data;
  const blocked = await call("boards", "itemDelete", { method: "DELETE", id: board.id, data: { workspaceId: workspace.id, version: currentBoard.version } });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error.code, "NOT_EMPTY");
  for (const { resource, item } of created) {
    assert.equal((await call(resource, "itemDelete", { method: "DELETE", id: item.id, data: { boardId: board.id, version: item.version } })).status, 204);
    assert.equal((await call(resource, "itemGet", { id: item.id })).status, 404);
  }
  currentBoard = (await call("boards", "itemGet", { id: board.id })).body.data;
  assert.equal((await call("boards", "itemDelete", { method: "DELETE", id: board.id, data: { workspaceId: workspace.id, version: currentBoard.version } })).status, 204);
  assert.deepEqual(db.items.get(legacy.id), legacy);
  assert.equal(db.calls.some(call => call.type === "ScanCommand"), false);
});

test("invalid JSON, fields, IDs, duplicate queries, body limits and version syntax return 400", async () => {
  const { call, db } = fixture();
  for (const input of ["{", "null", "[]"]) assert.equal((await call("tasks", "collectionPost", { method: "POST", raw: input })).status, 400);
  for (const search of ["", "?boardId=bad", "?boardId=a&boardId=b", "?entityType=TASK"]) assert.equal((await call("tasks", "collectionGet", { search })).status, 400);
  for (const forbidden of ["entityType", "id", "gsi1pk", "version", "parentId"]) {
    assert.equal((await call("workspaces", "collectionPost", { method: "POST", data: { data: {}, [forbidden]: "injected" } })).status, 400);
  }
  for (const data of [{ entityType: "TASK" }, { settings: { gsi1pk: "injected" } }, { settings: JSON.parse('{"__proto__":{}}') }]) assert.equal((await call("workspaces", "collectionPost", { method: "POST", data: { data } })).status, 400);
  assert.equal((await call("workspaces", "collectionPost", { method: "POST", raw: JSON.stringify({ data: { settings: { text: "x".repeat(200001) } } }) })).status, 400);
  assert.equal((await call("workspaces", "collectionPost", { method: "POST", data: { data: {} }, headers: { "content-type": "text/plain" } })).status, 400);
  assert.equal((await call("tasks", "itemGet", { id: "bad" })).status, 400);
  assert.equal((await call("tasks", "itemGet", { id: `SLOWLY#TASK#${"-".repeat(36)}` })).status, 400);
  assert.equal(db.calls.length, 0);
  const { board } = await seed(call);
  assert.equal((await call("tasks", "collectionPost", { method: "POST", data: { boardId: board.id, data: { ...taskData(), priority: "high" } } })).status, 400);
  assert.equal((await call("boards", "itemPatch", { method: "PATCH", id: board.id, data: { version: "1", data: { name: "x" } } })).status, 400);
  assert.equal((await call("workspaces", "itemGet", { id: `SLOWLY#WORKSPACE#${randomUUID()}` })).status, 404);
});

test("WIP, stale versions, cross-board and cross-workspace operations are rejected", async () => {
  const { call } = fixture(); const { board, otherBoard, workspace, otherWorkspace } = await seed(call);
  const data = taskData(); delete data.completedAt;
  const a = (await call("tasks", "collectionPost", { method: "POST", data: { boardId: board.id, data } })).body.data;
  const b = (await call("tasks", "collectionPost", { method: "POST", data: { boardId: board.id, data: { ...data, id: "second" } } })).body.data;
  assert.equal((await call("tasks", "itemPatch", { method: "PATCH", id: a.id, data: { boardId: board.id, version: 1, data: { status: "doing" } } })).status, 200);
  const limit = await call("tasks", "itemPatch", { method: "PATCH", id: b.id, data: { boardId: board.id, version: 1, data: { status: "doing" } } });
  assert.equal(limit.status, 409); assert.equal(limit.body.error.code, "WIP_LIMIT");
  assert.equal((await call("tasks", "itemPatch", { method: "PATCH", id: a.id, data: { boardId: board.id, version: 1, data: { notes: "stale" } } })).status, 409);
  for (const handler of ["itemPatch", "itemDelete"]) assert.equal((await call("tasks", handler, { method: handler === "itemPatch" ? "PATCH" : "DELETE", id: a.id, data: { boardId: otherBoard.id, version: 2, ...(handler === "itemPatch" ? { data: { title: "illegal" } } : {}) } })).status, 403);
  assert.equal((await call("boards", "itemPatch", { method: "PATCH", id: board.id, data: { workspaceId: otherWorkspace.id, version: 1, data: { name: "illegal" } } })).status, 403);
  assert.equal((await call("tasks", "collectionPost", { method: "POST", data: { boardId: board.id, workspaceId: otherWorkspace.id, data } })).status, 403);
  assert.equal((await call("tasks", "collectionGet", { search: `?boardId=${encodeURIComponent(board.id)}&workspaceId=${encodeURIComponent(otherWorkspace.id)}` })).status, 403);
  assert.equal((await call("boards", "itemGet", { id: board.id, search: `?workspaceId=${encodeURIComponent(workspace.id)}` })).status, 200);
});

test("ordering endpoints validate entries, versions and parent boundaries", async () => {
  const { call } = fixture(); const { board, otherBoard, workspace } = await seed(call);
  for (const resource of ["tasks", "widgets"]) {
    const data = resource === "tasks" ? { id: "t", title: "任務", status: "todo" } : { id: "w", type: "note", span: 6, height: 260, config: {} };
    const item = (await call(resource, "collectionPost", { method: "POST", data: { boardId: board.id, data } })).body.data;
    const request = { boardId: board.id, entries: [{ id: item.id, version: 1, position: 10 }] };
    assert.equal((await call(resource, "orderPatch", { method: "PATCH", data: request })).status, 200);
    assert.equal((await call(resource, "orderPatch", { method: "PATCH", data: request })).status, 409);
    assert.equal((await call(resource, "orderPatch", { method: "PATCH", data: { boardId: otherBoard.id, entries: [{ id: item.id, version: 2, position: 0 }] } })).status, 403);
    assert.equal((await call(resource, "orderPatch", { method: "PATCH", data: { ...request, entries: [] } })).status, 400);
  }
  const current = (await call("boards", "itemGet", { id: board.id })).body.data;
  assert.equal((await call("boards", "orderPatch", { method: "PATCH", data: { workspaceId: workspace.id, entries: [{ id: board.id, version: current.version, position: 4 }] } })).status, 200);
});

test("production, disabled API, remote hosts, CSRF and proxy requests cannot reach repository", async () => {
  let calls = 0; const getRepository = async () => { calls++; throw new Error("must not run"); };
  for (const environment of [{ NODE_ENV: "production", SLOWLY_LOCAL_API: "1" }, { NODE_ENV: "development" }, { NODE_ENV: "test", SLOWLY_LOCAL_API: "1" }]) {
    assert.equal((await fixture({ environment, getRepository }).call("workspaces", "collectionPost", { method: "POST", data: { data: {} } })).status, 403);
  }
  const { call } = fixture({ getRepository });
  for (const headers of [{ host: "evil.example" }, { origin: "http://evil.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }, { "x-forwarded-for": "203.0.113.1" }, { "x-forwarded-host": "evil.example" }, { forwarded: "host=evil.example" }]) assert.equal((await call("workspaces", "collectionPost", { method: "POST", data: { data: {} }, headers })).status, 403);
  assert.equal(calls, 0);
  const handler = createApi("workspaces", { getRepository, configuration: () => env });
  const normalized = await handler.collectionGet(new Request("http://localhost:3000/api/workspaces", { headers: { host: "127.0.0.1:3000" } }));
  assert.equal(normalized.status, 501);
  const remote = await handler.collectionGet(new Request("http://evil.example:3000/api/workspaces", { headers: { host: "127.0.0.1:3000" } }));
  assert.equal(remote.status, 403);
  const missingOrigin = await handler.collectionPost(new Request(`${origin}/api/workspaces`, { method: "POST", headers: { host: "127.0.0.1:3000", "content-type": "application/json" }, body: '{"data":{}}' }));
  assert.equal(missingOrigin.status, 403);
  assert.equal(calls, 0);
});

test("DynamoDB failures return generic 500 without leaking credentials or SDK internals", async () => {
  const secret = "simulated-sensitive-error";
  const { call } = fixture({ getRepository: async () => createRepository({ send: async () => { throw new Error(secret); } }) });
  for (const [handler, options] of [["collectionPost", { method: "POST", data: { data: {} } }], ["itemGet", { id: `SLOWLY#WORKSPACE#${randomUUID()}` }]]) {
    const result = await call("workspaces", handler, options);
    assert.equal(result.status, 500); assert.equal(JSON.stringify(result.body).includes(secret), false);
    assert.equal(result.body.error.code, "INTERNAL"); assert.equal(result.headers.get("cache-control"), "no-store");
  }
});
