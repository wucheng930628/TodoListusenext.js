import test from "node:test";
import assert from "node:assert/strict";
import { hookHost } from "./helpers/react-hook-host.mjs";
import { useSlowlyWorkspace, useSlowlyBoards, useSlowlyTasks, useSlowlyWidgets } from "../src/hooks/use-slowly-api.mjs";
import { createSlowlyApi } from "../src/lib/client/slowly-api.mjs";

const ready = { mode: "api", apiReady: true, workspaceId: "workspace-db", boardId: "board-a" };
const dto = (id, boardId = "board-a", version = 1) => ({ id, version, position: 0, workspaceId: "workspace-db", boardId, data: { id: `front-${id}`, title: id } });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test("actual React state follows adapter Loading → Success and retains frontend/database ID mapping", async () => {
  const host = await hookHost(); const request = deferred(); let state; let options;
  const api = createSlowlyApi({ fetchImpl: (path, init) => { options = init; return request.promise; } });
  function Probe(props) { state = useSlowlyTasks(props); return null; }
  try {
    await host.render(Probe, { ...ready, api }); assert.equal(state.loading, true); assert.equal(options.signal.aborted, false);
    await host.act(async () => request.resolve(Response.json({ data: [dto("db-a")] })));
    assert.equal(state.success, true); assert.equal(state.data[0].id, "db-a");
    assert.equal(state.idMapping[0].frontendId, "front-db-a"); assert.equal(state.idMapping[0].databaseId, "db-a");
  } finally { await host.close(); }
});

test("default localStorage mode and unconfirmed API mode never request or migrate", async () => {
  const host = await hookHost(); let state; let calls = 0;
  const api = createSlowlyApi({ fetchImpl: async () => { calls++; throw new Error("must not fetch"); } });
  function Probe(props) { state = useSlowlyTasks(props); return null; }
  try {
    await host.render(Probe, { api, workspaceId: "workspace-db", boardId: "board-a", apiReady: true, allowWrites: true });
    assert.equal(state.status, "local-storage"); assert.equal(calls, 0);
    await host.render(Probe, { api, mode: "api", workspaceId: "workspace-db", boardId: "board-a" });
    assert.equal(state.status, "migration-required"); assert.equal(calls, 0);
    await assert.rejects(state.create({ data: {} }), { code: "API_WRITES_DISABLED" });
  } finally { await host.close(); }
});

test("rapid Board switching aborts A and prevents late A responses or stale callbacks overwriting B", async () => {
  const host = await hookHost(); const a = deferred(); const b = deferred(); let state; let signalA;
  const api = createSlowlyApi({ fetchImpl: (path, init) => { if (new URL(path, "http://local").searchParams.get("boardId") === "board-a") { signalA = init.signal; return a.promise; } return b.promise; } });
  function Probe(props) { state = useSlowlyTasks(props); return null; }
  try {
    await host.render(Probe, { ...ready, api }); const oldRefresh = state.refresh;
    await host.render(Probe, { ...ready, api, boardId: "board-b" });
    assert.equal(signalA.aborted, true); assert.deepEqual(state.data, []);
    await host.act(async () => b.resolve(Response.json({ data: [dto("B", "board-b")] })));
    assert.equal(state.data[0].id, "B");
    await host.act(async () => a.resolve(Response.json({ data: [dto("A")] })));
    assert.equal(state.data[0].id, "B");
    assert.throws(() => oldRefresh(), { code: "STALE_SCOPE" });
  } finally { await host.close(); }
});

test("explicit cancellation and unmount invalidate requests even if transport ignores AbortSignal", async () => {
  const host = await hookHost(); const request = deferred(); let state; let signal;
  const api = createSlowlyApi({ fetchImpl: (path, init) => { signal = init.signal; return request.promise; } });
  function Probe(props) { state = useSlowlyWidgets(props); return null; }
  try {
    await host.render(Probe, { ...ready, api });
    await host.act(async () => state.cancel()); assert.equal(signal.aborted, true); assert.equal(state.status, "idle");
    await host.act(async () => request.resolve(Response.json({ data: [dto("late")] })));
    assert.deepEqual(state.data, []); assert.equal(state.error, null);
  } finally { await host.close(); }
});

for (const [status, code] of [[400, "VALIDATION"], [403, "OWNERSHIP"], [404, "NOT_FOUND"], [409, "CONFLICT"], [500, "INTERNAL"], [null, "NETWORK_ERROR"]]) {
  test(`hook exposes ${status ?? "network"} ${code} without automatic retries`, async () => {
    const host = await hookHost(); let state; let calls = 0;
    const api = createSlowlyApi({ fetchImpl: async () => { calls++; if (status === null) throw new TypeError("offline"); return Response.json({ error: { code, message: "expected error" } }, { status }); } });
    function Probe(props) { state = useSlowlyTasks(props); return null; }
    try {
      await host.render(Probe, { ...ready, api });
      assert.equal(state.status, "error"); assert.equal(state.error.status, status); assert.equal(state.error.code, code); assert.equal(calls, 1);
    } finally { await host.close(); }
  });
}

test("mutation state uses versioned requests, merges success and preserves data on 409 with one attempt", async () => {
  const host = await hookHost(); let state; let attempts = 0; let fail = false; const pending = deferred();
  const api = createSlowlyApi({ fetchImpl: async (path, init) => {
    if (init.method === "GET") return Response.json({ data: [dto("db-a")] });
    attempts++; const input = JSON.parse(init.body); assert.equal(input.version, 1); assert.equal(input.boardId, "board-a");
    if (fail) return Response.json({ error: { code: "CONFLICT", message: "reload" } }, { status: 409 });
    return pending.promise;
  } });
  function Probe(props) { state = useSlowlyTasks(props); return null; }
  try {
    await host.render(Probe, { ...ready, api, allowWrites: true });
    let writing; await host.act(async () => { writing = state.update("db-a", { version: 1, data: { title: "updated" } }); });
    assert.equal(state.mutation.status, "loading");
    await host.act(async () => { pending.resolve(Response.json({ data: { ...dto("db-a", "board-a", 2), data: { id: "front-db-a", title: "updated" } } })); await writing; });
    assert.equal(state.mutation.status, "success"); assert.equal(state.idMapping[0].version, 2);
    fail = true;
    await host.act(async () => { await assert.rejects(state.update("db-a", { version: 1, data: { title: "stale" } }), { status: 409 }); });
    assert.equal(state.mutation.status, "error"); assert.equal(state.data[0].data.title, "updated"); assert.equal(attempts, 2);
  } finally { await host.close(); }
});

test("Workspace and Boards hooks use their actual adapter contracts", async () => {
  for (const [hook, resource] of [[useSlowlyWorkspace, "workspaces"], [useSlowlyBoards, "boards"]]) {
    const host = await hookHost(); let state; let seen;
    const api = createSlowlyApi({ fetchImpl: async path => { seen = path; return Response.json({ data: resource === "workspaces" ? { id: "workspace-db", version: 1, position: 0, data: { activeBoardId: "front-board" } } : [{ ...dto("board-db"), boardId: undefined }] }); } });
    function Probe(props) { state = hook(props); return null; }
    try { await host.render(Probe, { ...ready, api }); assert.equal(state.success, true); assert.ok(seen.startsWith(`/api/${resource}`)); }
    finally { await host.close(); }
  }
});

test("unmount aborts the pending adapter request and late completion does not update React", async () => {
  const host = await hookHost(); const pending = deferred(); let signal; let renders = 0;
  const api = createSlowlyApi({ fetchImpl: (path, init) => { signal = init.signal; return pending.promise; } });
  function Probe(props) { useSlowlyTasks(props); renders++; return null; }
  await host.render(Probe, { ...ready, api });
  await host.close(); const before = renders; assert.equal(signal.aborted, true);
  pending.resolve(Response.json({ data: [dto("late")] }));
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(renders, before);
});
