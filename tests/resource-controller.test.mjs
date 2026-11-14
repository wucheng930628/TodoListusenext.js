import test from "node:test";
import assert from "node:assert/strict";
import { createResourceController } from "../src/lib/client/resource-controller.mjs";
import { createSlowlyApi } from "../src/lib/client/slowly-api.mjs";
import { resolveDataSource } from "../src/lib/client/data-source.mjs";

const ready = { mode: "api", apiReady: true, allowWrites: true, workspaceId: "ws", boardId: "A" };
const dto = (id, boardId = "A", version = 1) => ({ id, version, position: 0, workspaceId: "ws", boardId, data: { id: "same-frontend-id", title: id } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test("data source is explicit, defaults to localStorage and has no capability-driven auto switch", () => {
  assert.equal(resolveDataSource().mode, "localStorage");
  assert.equal(resolveDataSource({ workspaceId: "ws", apiReady: true, allowWrites: true }).readApi, false);
  assert.equal(resolveDataSource({ mode: "api", apiReady: true }).status, "migration-required");
  assert.equal(resolveDataSource({ mode: "api", workspaceId: "ws" }).migrationRequired, true);
  assert.equal(resolveDataSource({ mode: "api", workspaceId: "ws", apiReady: true }).writeApi, false);
  assert.throws(() => resolveDataSource({ mode: "auto" }));
  assert.throws(() => resolveDataSource({ apiReady: "true" }));
});

test("duplicate frontend IDs keep separate database mappings and observer cleanup works", async () => {
  const api = createSlowlyApi({ fetchImpl: async () => Response.json({ data: [dto("db-1"), dto("db-2")] }) });
  const store = createResourceController("tasks", api); let updates = 0;
  const unsubscribe = store.subscribe(() => updates++); const initial = store.getServerSnapshot();
  await store.select(ready); assert.equal(store.getSnapshot().idMapping.length, 2);
  assert.equal(store.getSnapshot().idMapping[0].frontendId, store.getSnapshot().idMapping[1].frontendId);
  assert.notEqual(store.getSnapshot().idMapping[0].databaseId, store.getSnapshot().idMapping[1].databaseId);
  assert.equal(store.getServerSnapshot(), initial);
  unsubscribe(); const before = updates; store.cancel(); assert.equal(updates, before);
});

test("response scope, duplicate database IDs and invalid DTOs fail closed", async () => {
  for (const data of [[dto("wrong", "B")], [dto("same"), dto("same")], [{ ...dto("bad"), version: 0 }], null]) {
    const store = createResourceController("tasks", createSlowlyApi({ fetchImpl: async () => Response.json({ data }) }));
    await assert.rejects(store.select(ready)); assert.equal(store.getSnapshot().status, "error"); assert.deepEqual(store.getSnapshot().data, []);
  }
});

test("an older read cannot overwrite a successful mutation, and DELETE 204 updates mapping", async () => {
  const oldRead = deferred(); let reads = 0;
  const api = createSlowlyApi({ fetchImpl: async (path, init) => {
    if (init.method === "GET") { reads++; return reads === 1 ? Response.json({ data: [dto("db")] }) : oldRead.promise; }
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ data: { ...dto("db", "A", 2), data: { id: "same-frontend-id", title: "new" } } });
  } });
  const store = createResourceController("tasks", api); await store.select(ready);
  const reading = store.refresh(); await store.update("db", { version: 1, data: { title: "new" } });
  oldRead.resolve(Response.json({ data: [dto("db")] })); await reading;
  assert.equal(store.getSnapshot().data[0].data.title, "new");
  assert.equal(await store.remove("db", { version: 2 }), null); assert.deepEqual(store.getSnapshot().idMapping, []);
});

test("writes are single-attempt/single-flight and cannot override the selected parent scope", async () => {
  const writing = deferred(); let attempts = 0;
  const api = createSlowlyApi({ fetchImpl: async (path, init) => { if (init.method === "GET") return Response.json({ data: [] }); attempts++; return writing.promise; } });
  const store = createResourceController("tasks", api); await store.select(ready);
  await assert.rejects(store.create({ boardId: "B", data: {} }), { code: "SCOPE_MISMATCH" });
  assert.equal(attempts, 0);
  const pending = store.create({ data: { id: "front", title: "new" } });
  await assert.rejects(store.create({ data: {} }), { code: "MUTATION_IN_PROGRESS" });
  await assert.rejects(store.refresh(), { code: "MUTATION_IN_PROGRESS" });
  writing.resolve(Response.json({ error: { code: "INTERNAL", message: "failed" } }, { status: 500 }));
  await assert.rejects(pending, { status: 500 }); assert.equal(attempts, 1);
  assert.equal(store.getSnapshot().mutation.outcome, "not-confirmed");
});

test("switching scope cancels old mutation, reads the new Board and ignores late write response", async () => {
  const writing = deferred(); let writeSignal;
  const api = createSlowlyApi({ fetchImpl: async (path, init) => {
    if (init.method === "GET") { const boardId = new URL(path, "http://local").searchParams.get("boardId"); return Response.json({ data: [dto(boardId, boardId)] }); }
    writeSignal = init.signal; return writing.promise;
  } });
  const store = createResourceController("tasks", api); await store.select(ready);
  const pending = store.update("A", { version: 1, data: { title: "old" } });
  await store.select({ ...ready, boardId: "B" }); assert.equal(writeSignal.aborted, true); assert.equal(store.getSnapshot().data[0].id, "B");
  writing.resolve(Response.json({ data: dto("late", "A", 2) })); await pending;
  assert.equal(store.getSnapshot().data[0].id, "B");
});

test("missing scope and invalid configuration do not issue requests or touch storage", async () => {
  let calls = 0; const store = createResourceController("widgets", createSlowlyApi({ fetchImpl: async () => { calls++; throw new Error("must not fetch"); } }));
  await store.select({ ...ready, boardId: null }); assert.equal(store.getSnapshot().status, "scope-required");
  await assert.rejects(store.select({ ...ready, mode: "auto" })); assert.equal(store.getSnapshot().status, "error"); assert.equal(calls, 0);
});

test("failed initial reads cannot be treated as a complete collection by a mutation", async () => {
  let attempts = 0;
  const store = createResourceController("tasks", createSlowlyApi({ fetchImpl: async () => { attempts++; return Response.json({ error: { code: "INTERNAL", message: "offline" } }, { status: 500 }); } }));
  await assert.rejects(store.select(ready), { status: 500 });
  await assert.rejects(store.create({ data: { title: "new" } }), { code: "READ_REQUIRED", outcome: "not-sent" });
  assert.equal(attempts, 1); assert.equal(store.getSnapshot().loaded, false);
});
