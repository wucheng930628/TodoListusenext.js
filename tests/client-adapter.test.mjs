import test from "node:test";
import assert from "node:assert/strict";
import { createSlowlyApi, SlowlyApiError } from "../src/lib/client/slowly-api.mjs";

test("adapter covers every current endpoint and preserves the DTO envelope and write body", async () => {
  const id = "SLOWLY#TASK#id /中文?&";
  const input = { boardId: "SLOWLY#BOARD#parent", version: 3, position: 2, data: { title: "保留" } };
  const calls = [];
  const api = createSlowlyApi({ fetchImpl: async (path, init) => { calls.push({ path, init }); return init.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ data: { id, version: 4, data: { title: "保留" } } }); } });
  const cases = [
    ["listWorkspaces", [{ id }], "GET", "/api/workspaces"], ["createWorkspace", [input], "POST", "/api/workspaces"], ["getWorkspace", [id], "GET", `/api/workspaces/${encodeURIComponent(id)}`], ["updateWorkspace", [id, input], "PATCH", `/api/workspaces/${encodeURIComponent(id)}`],
  ];
  for (const resource of ["Board", "Task", "Widget"]) {
    const name = resource.toLowerCase() + "s";
    cases.push([`list${resource}s`, [{ boardId: id, workspaceId: undefined }], "GET", `/api/${name}`], [`create${resource}`, [input], "POST", `/api/${name}`], [`get${resource}`, [id, { boardId: id }], "GET", `/api/${name}/${encodeURIComponent(id)}`], [`update${resource}`, [id, input], "PATCH", `/api/${name}/${encodeURIComponent(id)}`], [`delete${resource}`, [id, input], "DELETE", `/api/${name}/${encodeURIComponent(id)}`], [`reorder${resource}s`, [input], "PATCH", `/api/${name}/order`]);
  }
  for (const [method, args, verb, expectedPath] of cases) {
    const result = await api[method](...args); const call = calls.at(-1);
    assert.equal(call.init.method, verb); assert.equal(call.path.split("?")[0], expectedPath);
    assert.equal(call.init.redirect, "error"); assert.equal(call.init.credentials, "same-origin");
    if (verb !== "GET") assert.deepEqual(JSON.parse(call.init.body), input);
    if (verb === "DELETE") assert.equal(result, null); else assert.equal(result.version, 4);
  }
  assert.equal(calls.length, 22);
  assert.equal(new URL(calls[0].path, "http://local").searchParams.get("id"), id);
  assert.ok(calls[0].path.includes(encodeURIComponent(id)));
  await api.listTasks({ boardId: id, workspaceId: "space#with&=" });
  assert.equal(new URL(calls.at(-1).path, "http://local").searchParams.get("workspaceId"), "space#with&=");
});

for (const [status, code] of [[400, "VALIDATION"], [403, "OWNERSHIP"], [404, "NOT_FOUND"], [409, "CONFLICT"], [409, "WIP_LIMIT"], [500, "INTERNAL"], [501, "NOT_SUPPORTED"]]) {
  test(`adapter preserves HTTP ${status} ${code} and does not retry mutations`, async () => {
    let calls = 0;
    const api = createSlowlyApi({ fetchImpl: async () => { calls++; return Response.json({ error: { code, message: "specific message" } }, { status }); } });
    await assert.rejects(api.createTask({ data: {} }), error => error instanceof SlowlyApiError && error.status === status && error.code === code && error.message === "specific message");
    assert.equal(calls, 1);
  });
}

test("network, abort, invalid JSON, missing data, serialization and signal handling", async () => {
  for (const name of ["TypeError", "AbortError"]) {
    let attempts = 0;
    const api = createSlowlyApi({ fetchImpl: async () => { attempts++; throw Object.assign(new Error("network"), { name }); } });
    await assert.rejects(api.updateTask("id", { version: 1 }), error => error.status === null && error.code === (name === "AbortError" ? "ABORTED" : "NETWORK_ERROR") && error.outcome === "not-confirmed");
    assert.equal(attempts, 1);
  }
  for (const status of [200, 404, 500]) {
    const api = createSlowlyApi({ fetchImpl: async () => new Response("<html>error</html>", { status }) });
    await assert.rejects(api.listWorkspaces(), error => error.status === status && error.code === "INVALID_JSON_RESPONSE");
  }
  await assert.rejects(createSlowlyApi({ fetchImpl: async () => Response.json({}) }).listWorkspaces(), { code: "INVALID_RESPONSE", status: 200 });
  let calls = 0; const signal = new AbortController().signal;
  const api = createSlowlyApi({ fetchImpl: async (path, init) => { calls++; assert.equal(init.signal, signal); return Response.json({ data: [] }); } });
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(api.createTask(cyclic), { code: "SERIALIZATION_ERROR", outcome: "not-sent" });
  await api.listWorkspaces({}, { signal }); assert.equal(calls, 1);
  assert.throws(() => api.getTask(""), { code: "INVALID_ARGUMENT" });
  assert.throws(() => api.getTask(), { code: "INVALID_ARGUMENT" });
});
