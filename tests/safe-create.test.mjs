import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRepository } from "../src/lib/slowly-repository.mjs";
import { createOperationApi } from "../src/lib/api/operations.mjs";
import { createSafeCreateIntent } from "../src/lib/client/safe-create.mjs";
import { MemoryClient } from "./helpers/memory-client.mjs";
import { createRequestFixture, runSafeCreateScenario } from "./helpers/safe-create-scenario.mjs";
import { mainUiFixture } from "./helpers/main-ui-fixture.mjs";
import { createSlowlyApi } from "../src/lib/client/slowly-api.mjs";
import { createMainWorkspaceController } from "../src/lib/client/main-workspace-controller.mjs";
import { createResourceController } from "../src/lib/client/resource-controller.mjs";

test("four-resource safe-create HTTP contract and persistent receipts", async t => {
  await runSafeCreateScenario(createRepository(new MemoryClient()), (name, action) => t.test(name, action));
});

test("parent version conflict atomically rejects both target and receipt", async () => {
  const db = new MemoryClient(); const repo = createRepository(db); const root = await repo.createWorkspace({});
  const key = randomUUID();
  db.beforeTransaction = async () => { db.beforeTransaction = null; db.items.get(root.id).version++; };
  const response = await createRequestFixture(repo).post("boards", { workspaceId: root.id, data: { id: "b", name: "B", description: "", wipLimit: 4 } }, key);
  assert.equal(response.status, 409);
  assert.equal(db.items.has(`SLOWLY#BOARD#${key}`), false); assert.equal(db.items.has(`SLOWLY#CRUD_OPERATION#${key}`), false);
  assert.equal((await repo.getWorkspace(root.id)).boardCount, 0);
});

test("workspace barrier races cannot commit a target or receipt", async () => {
  const f = await mainUiFixture(); const view = await f.api.getWorkspaceView(f.workspaceId); const key = randomUUID();
  f.db.beforeTransaction = async () => { f.db.beforeTransaction = null; f.db.items.get(f.workspaceId).migrationLock = true; };
  const response = await createRequestFixture(f.repository).post("tasks", { workspaceId: f.workspaceId, boardId: view.boards[0].board.id, data: { id: "locked", title: "Lock", status: "todo" } }, key);
  assert.equal(response.status, 409); assert.equal((await response.json()).error.code, "MIGRATION_LOCKED");
  assert.equal(f.db.items.has(`SLOWLY#TASK#${key}`), false); assert.equal(f.db.items.has(`SLOWLY#CRUD_OPERATION#${key}`), false);
});

test("transaction committed but SDK response lost resolves from the same atomic receipt", async () => {
  const db = new MemoryClient(); const repo = createRepository(db); const key = randomUUID();
  db.afterTransaction = async () => { db.afterTransaction = null; throw new Error("SDK response lost"); };
  const response = await createRequestFixture(repo).post("workspaces", { data: {} }, key);
  assert.equal(response.status, 201); assert.equal(db.items.size, 2);
  assert.equal(db.items.get(`SLOWLY#CRUD_OPERATION#${key}`).state, "CONFIRMED");
});

test("receipt API development guard, malformed scope and safe UNKNOWN storage error", async () => {
  const request = () => new Request(`http://127.0.0.1:3000/api/operations/${randomUUID()}?resource=workspaces&scope=local-workspace-create-v1`, { headers: { host: "127.0.0.1:3000" } });
  const context = { params: Promise.resolve({ operationId: randomUUID() }) };
  const getRepository = async () => { throw new Error("secret SDK details"); };
  const forbidden = createOperationApi({ getRepository, configuration: () => ({ NODE_ENV: "production" }) }); assert.equal((await forbidden(request(), context)).status, 403);
  const enabled = createOperationApi({ getRepository, configuration: () => ({ NODE_ENV: "development", SLOWLY_LOCAL_API: "1" }) });
  const result = await enabled(request(), context); assert.equal(result.status, 500); const json = await result.json(); assert.equal(json.error.state, "UNKNOWN"); assert.doesNotMatch(JSON.stringify(json), /secret SDK/);
});

test("lost HTTP create response queries receipt and reloads current server data without another POST", async () => {
  const f = await mainUiFixture(); await f.activate(); f.grant(); f.failNextWrite("after");
  const result = await f.controller.saveTask({ id: "lost", title: "Once", status: "todo" });
  assert.equal(result.data.id, "lost"); assert.equal(f.controller.getSnapshot().uncertainWrite, false);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
  assert.ok(f.calls.some(call => call.path.startsWith("/api/operations/")));
  assert.equal(f.controller.getSnapshot().projection.workspace.boards[0].tasks.filter(task => task.id === "lost").length, 1);
});

test("NOT_FOUND remains UNKNOWN; explicit resend keeps original key/payload across scope toggles", async () => {
  const f = await mainUiFixture(); await f.activate(); f.grant(); f.failNextWrite("before");
  await assert.rejects(f.controller.saveTask({ id: "retry", title: "Original", status: "todo" }));
  const state = f.controller.getSnapshot(); assert.equal(state.uncertainWrite, true); assert.equal(state.createRecovery.receiptState, "NOT_FOUND");
  await assert.rejects(f.controller.saveTask({ id: "other", title: "Unsafe", status: "todo" }), { code: "WRITES_DISABLED" });
  assert.throws(() => f.controller.deactivate(), { code: "RECOVERY_REQUIRED" }); await f.activate(); assert.throws(() => f.grant(), { code: "WRITES_DISABLED" });
  await f.controller.resendCreate(f.workspaceId);
  const posts = f.calls.filter(call => call.method === "POST"); assert.equal(posts.length, 2); assert.equal(posts[0].body, posts[1].body); assert.equal(posts[0].operationKey, posts[1].operationKey);
  assert.equal(f.controller.getSnapshot().uncertainWrite, false); assert.equal(f.controller.getSnapshot().allowWrites, false);
});

test("multiple clicks share a single intent request and preserve the original payload", async () => {
  let resolve; const calls = [];
  const api = { createWorkspace(input, options) { calls.push({ input, options }); return new Promise(done => { resolve = done; }); } };
  const input = { data: { settings: { value: 1 } } }; const intent = createSafeCreateIntent(api, "workspaces", input);
  input.data.settings.value = 2;
  const first = intent.send(); const second = intent.send(); assert.equal(first, second); assert.equal(calls.length, 1); assert.equal(calls[0].input.data.settings.value, 1);
  resolve({ id: "result" }); await first;
  assert.throws(() => intent.send(), { code: "RECOVERY_REQUIRED" });
  assert.notEqual(createSafeCreateIntent(api, "workspaces", input).operationKey, intent.operationKey);
});

test("same key across resources and workspaces rejects without disclosing the original result", async () => {
  const db = new MemoryClient(); const repo = createRepository(db); const http = createRequestFixture(repo);
  const a = await repo.createWorkspace({}); const b = await repo.createWorkspace({}); const key = randomUUID();
  const input = { workspaceId: a.id, data: { id: "a", name: "Private board", description: "", wipLimit: 4 } };
  assert.equal((await http.post("boards", input, key)).status, 201);
  const denied = await http.post("boards", { ...input, workspaceId: b.id }, key); assert.equal(denied.status, 409); assert.doesNotMatch(await denied.text(), /Private board/);
  assert.equal((await http.post("workspaces", { data: {} }, key)).status, 409);
  assert.equal((await http.getOperation(key, { resource: "boards", workspaceId: b.id })).status, 409);
});

test("timeout sends once with original key and remains unconfirmed", async () => {
  let calls = 0;
  const api = createSlowlyApi({ fetchImpl: async (path, init) => {
    calls++; assert.ok(init.headers["Idempotency-Key"]);
    return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  } });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(api.createWorkspace({ data: {} }, { operationKey: randomUUID(), timeoutMs: 5 }), { code: "TIMEOUT", outcome: "not-confirmed" });
    assert.equal(calls, 1);
  } finally { clearTimeout(keepAlive); }
});

test("UNKNOWN lookup failure stays frozen and recovery never restores a deleted target", async () => {
  const f = await mainUiFixture(); let unavailable = true; let removed = false;
  const api = { ...f.api, async getOperation(key, scope, options) {
    if (unavailable) throw new TypeError("Receipt server offline");
    const receipt = await f.api.getOperation(key, scope, options);
    if (!removed && receipt.state === "CONFIRMED") {
      const item = await f.repository.getTask(receipt.targetId);
      await f.repository.deleteTask(item.boardId, item.id, item.version); removed = true;
    }
    return receipt;
  } };
  const c = createMainWorkspaceController({ api, journal: f.journal, development: true }); await c.activate({ workspaceId: f.workspaceId, apiReady: true }); c.authorizeWrites(f.workspaceId);
  f.failNextWrite("after"); await assert.rejects(c.saveTask({ id: "removed-after-create", title: "Once", status: "todo" }));
  assert.equal(c.getSnapshot().uncertainWrite, true);
  unavailable = false; await c.recoverCreate();
  assert.equal(c.getSnapshot().uncertainWrite, false); assert.equal(c.getSnapshot().projection.workspace.boards[0].tasks.some(task => task.id === "removed-after-create"), false);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
});

test("per-resource React controller uses safe-create, retains UNKNOWN and explicitly recovers", async () => {
  const f = await mainUiFixture(); const view = await f.api.getWorkspaceView(f.workspaceId);
  const c = createResourceController("tasks", f.api);
  await c.select({ mode: "api", apiReady: true, allowWrites: true, workspaceId: f.workspaceId, boardId: view.boards[0].board.id });
  f.failNextWrite("before"); await assert.rejects(c.create({ data: { id: "hook-retry", title: "Hook", status: "todo" } }));
  assert.equal(c.getSnapshot().mutation.status, "UNKNOWN");
  await assert.rejects(c.create({ data: {} }), { code: "RECOVERY_REQUIRED" });
  await c.resendCreate(); assert.equal(c.getSnapshot().mutation.status, "success");
  const posts = f.calls.filter(call => call.method === "POST"); assert.equal(posts[0].operationKey, posts[1].operationKey);
  assert.equal(c.getSnapshot().data.filter(task => task.data.id === "hook-retry").length, 1);
});

test("WIP and oversized creates leave no receipt or target", async () => {
  const db = new MemoryClient(); const repo = createRepository(db); const root = await repo.createWorkspace({});
  const board = await repo.createBoard(root.id, { id: "b", name: "B", description: "", wipLimit: 1 });
  const http = createRequestFixture(repo);
  const input = { workspaceId: root.id, boardId: board.id, data: { id: "doing", title: "Doing", status: "doing" } };
  assert.equal((await http.post("tasks", input, randomUUID())).status, 201);
  const key = randomUUID(); const response = await http.post("tasks", input, key); assert.equal(response.status, 409); assert.equal((await response.json()).error.code, "WIP_LIMIT");
  assert.equal(db.items.has(`SLOWLY#CRUD_OPERATION#${key}`), false); assert.equal(db.items.has(`SLOWLY#TASK#${key}`), false);
  const largeKey = randomUUID();
  const oversized = await http.post("workspaces", { data: { settings: { text: "x".repeat(210000) } } }, largeKey);
  assert.equal(oversized.status, 400); assert.equal(db.items.has(`SLOWLY#CRUD_OPERATION#${largeKey}`), false);
});

test("raw payload presence changes conflict even when defaults would produce identical data", async () => {
  const f = await mainUiFixture(); const view = await f.api.getWorkspaceView(f.workspaceId); const http = createRequestFixture(f.repository);
  const input = { workspaceId: f.workspaceId, boardId: view.boards[0].board.id, data: { id: "presence", title: "Presence", status: "todo" } };
  const key = randomUUID(); assert.equal((await http.post("tasks", input, key)).status, 201);
  assert.equal((await http.post("tasks", { ...input, data: { ...input.data, priority: "一般" } }, key)).status, 409);
  const receipt = f.db.items.get(`SLOWLY#CRUD_OPERATION#${key}`);
  assert.equal(Object.hasOwn(receipt, "expiresAt"), false); assert.equal(Object.hasOwn(receipt, "ttl"), false);
});

test("a server that ignores the key cannot enable a supposedly safe resend", async () => {
  let posts = 0;
  const api = createSlowlyApi({ fetchImpl: async (path, init) => {
    if (init.method === "GET") return Response.json({ error: { code: "OPERATION_NOT_FOUND" } }, { status: 404 });
    posts++; return Response.json({ data: { id: "legacy-created" } }, { status: 201 });
  } });
  const intent = createSafeCreateIntent(api, "workspaces", { data: {} });
  await assert.rejects(intent.send(), { code: "UNPROTECTED_CREATE_RESPONSE", outcome: "not-confirmed" });
  assert.equal((await intent.lookup()).state, "NOT_FOUND");
  assert.throws(() => intent.resend(), { code: "IDEMPOTENCY_UNAVAILABLE" }); assert.equal(posts, 1);
});
