import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as reservePort } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists, waitUntilTableNotExists } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { makeItem } from "../src/lib/data-model.mjs";
import { hash, migrationPlanV2 } from "../src/lib/migration/plan-v2.mjs";
import { captureWorkspaceBackup } from "../src/lib/client/workspace-backup.mjs";
import { sealBackup } from "../src/lib/client/verified-backup.mjs";
import { createSlowlyApi } from "../src/lib/client/slowly-api.mjs";
import { createSafeCreateIntent } from "../src/lib/client/safe-create.mjs";
import { storageFixture } from "../tests/phase4a-fixtures.mjs";

const run = randomUUID().replaceAll("-", "");
const tableName = `Slowly_Phase5B1_${run}`;
const endpoint = "http://127.0.0.1:9000";
const client = new DynamoDBClient({ endpoint, region: "ap-northeast-1", credentials: { accessKeyId: "local", secretAccessKey: "local" }, maxAttempts: 1 });
client.middlewareStack.add(next => async args => {
  assert.equal(args.input.TableName, tableName);
  return next(args);
}, { step: "initialize", name: "phase5b2IsolatedTable" });
const doc = DynamoDBDocumentClient.from(client);
const put = Item => doc.send(new PutCommand({ TableName: tableName, Item }));
const get = async id => (await doc.send(new GetCommand({ TableName: tableName, Key: { id }, ConsistentRead: true }))).Item;
const remove = id => doc.send(new DeleteCommand({ TableName: tableName, Key: { id } }));
const sourceNamespace = `http-fixture-${run}`;
const backup = await sealBackup(captureWorkspaceBackup({ storage: storageFixture({ "slowly-workspace-v2": JSON.stringify({
  activeBoardId: "fixture-board", boards: [{ id: "fixture-board", name: "HTTP fixture", description: "", wipLimit: 1, tasks: [], widgets: [] }],
}), "slowly-board-v1": "[]" }) }), "http://localhost:3000");
const plan = migrationPlanV2(backup, { sourceNamespace, policies: { sourcePolicy: { primary: "slowly-workspace-v2",
  legacy: { source: "slowly-board-v1", action: "exclude", acknowledged: true } } } });
const [rootOp, boardOp] = plan.operations;
const workspaceId = rootOp.targetId;
const boardId = boardOp.targetId;
const migrationId = plan.planId;
const now = new Date().toISOString();
const sourceId = `SLOWLY#MIGRATION_SOURCE#${hash(sourceNamespace)}`;
const released = op => ({ ...makeItem(op.type, op.data, { parent: op.parentId ?? undefined, position: op.position }),
  id: op.targetId, migrationOwner: { migrationId, operationId: op.operationId }, migrationLock: false,
  ...(op.parentId ? { gsi1sk: `${op.type}#${String(op.position).padStart(12, "0")}#${op.targetId}` } : {}) });
const workspace = { ...released(rootOp), boardCount: 1, migrationReleaseVersion: 2 };
const board = { ...released(boardOp), widgetPresence: "present" };
const headers = plan.operations.map(({ operationId, key, targetId, fingerprint }) => ({ operationId, key, targetId, fingerprint }));
const control = (id, entityType, data) => ({ id, entityType, version: 1, schemaVersion: 1, migrationId, ...data });
const session = control(`SLOWLY#MIGRATION_SESSION#${migrationId}`, "MIGRATION_SESSION", {
  version: 35, sourceId, planFormatVersion: 2, targetSchemaVersion: 1, state: "RELEASED", lockState: "RELEASED",
  releaseWorkspaceId: workspaceId, releaseProtocolVersion: 2, releaseVerificationHash: hash("isolated release"),
  verifiedAt: now, releasedAt: now, total: 2, registeredCount: 2, confirmedCount: 2, rolledBackCount: 0, releasedCount: 2,
  sourceIdentity: plan.sourceIdentity, sourceBinding: plan.sourceBinding, policies: plan.policies, sourceRevision: plan.sourceRevision,
  expectedWorkspaceHash: plan.expectedWorkspaceHash, counts: plan.counts, sourceStorageKey: plan.sourceStorageKey,
  sourceStorageVersion: plan.sourceStorageVersion, manifestHash: hash(headers),
});
const grant = control(`SLOWLY#TASK_CREATE_GRANT#${workspaceId}`, "TASK_CREATE_GRANT", { workspaceId, planId: migrationId,
  sourceNamespace, sessionVersion: session.version, releaseHash: session.releaseVerificationHash, state: "ACTIVE", expiresAt: Date.now() + 600000 });

async function seed() {
  const sourceBindingHash = hash(plan.sourceBinding);
  const binding = { planId: migrationId, sourceBindingHash };
  await Promise.all([put(workspace), put(board), put(session), put(grant),
    put(control(sourceId, "MIGRATION_SOURCE", { sourceRevision: plan.sourceRevision, sourceBindingHash })),
    ...plan.operations.flatMap((operation, index) => [
      put(control(`SLOWLY#MIGRATION_MANIFEST#${migrationId}#${String(index).padStart(12, "0")}`, "MIGRATION_MANIFEST", { ...binding, index, header: headers[index] })),
      put(control(`SLOWLY#MIGRATION_OPERATION#${migrationId}#${operation.operationId}`, "MIGRATION_OPERATION", { ...binding, index, operation, state: "CONFIRMED", releasedAt: now })),
    ])]);
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
const close = server => new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
let created = false;
let child;
let proxy;
let proxyPort;
let afterCommit;
let serverLog = "";
let passed = 0;
async function check(name, scenario) {
  await scenario();
  passed++;
  console.log(`PASS ${name}`);
}
async function expect(responsePromise, status, code) {
  const response = await responsePromise;
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  if (code) assert.equal(body.error.code, code);
  return { response, body };
}

try {
  await client.send(new CreateTableCommand({ TableName: tableName, BillingMode: "PAY_PER_REQUEST",
    KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    AttributeDefinitions: ["id", "gsi1pk", "gsi1sk"].map(AttributeName => ({ AttributeName, AttributeType: "S" })),
    GlobalSecondaryIndexes: [{ IndexName: "SlowlyByParent", KeySchema: [{ AttributeName: "gsi1pk", KeyType: "HASH" },
      { AttributeName: "gsi1sk", KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" } }] }));
  created = true;
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
  await seed();
  const portReservation = reservePort();
  const port = await listen(portReservation);
  await close(portReservation);
  assert.notEqual(port, 3000);
  const origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", DYNAMODB_ENDPOINT: endpoint,
      AWS_REGION: "ap-northeast-1", AWS_ACCESS_KEY_ID: "local", AWS_SECRET_ACCESS_KEY: "local",
      SLOWLY_LOCAL_API: "1", SLOWLY_LOCAL_API_ORIGIN: origin, SLOWLY_FORMAL_VIEW_ENABLED: "0",
      SLOWLY_FORMAL_EVIDENCE_FILE: "", SLOWLY_FORMAL_EVIDENCE_KEY_FILE: "", SLOWLY_CONTROLLED_UI_TABLE: "",
      SLOWLY_CONTROLLED_UI_RUN_ID: "", SLOWLY_MAIN_UI_TEST: "",
      SLOWLY_PHASE5_B1_TABLE: tableName, SLOWLY_PHASE5_B1_WORKSPACE: workspaceId,
      SLOWLY_PHASE5_B1_PLAN: migrationId, SLOWLY_PHASE5_B1_SOURCE_NAMESPACE: sourceNamespace,
      SLOWLY_PHASE5_D2_UI: process.argv.includes("--browser-write") ? "1" : "0" },
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { serverLog = (serverLog + chunk).slice(-8000); });
  const view = (id = workspaceId) => fetch(`${origin}/api/workspaces/${encodeURIComponent(id)}/view`, { signal: AbortSignal.timeout(15000) });
  let online = false;
  for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
    try { const poll = await view(); online = poll.status === 200; await poll.body.cancel(); if (online) break; }
    catch { /* The startup probe never mutates data. */ }
    await delay(200);
  }
  assert.ok(online, serverLog);
  const input = { workspaceId, boardId, position: 0, data: { id: "http-task", title: "HTTP integration", status: "doing" } };
  const post = (body = input, key = randomUUID(), from = origin) => fetch(`${origin}/api/tasks`, {
    method: "POST", signal: AbortSignal.timeout(15000), headers: { origin: from, "content-type": "application/json",
      ...(key === null ? {} : { "idempotency-key": key }) }, body: JSON.stringify(body),
  });
  const receiptPath = key => `/api/operations/${key}?${new URLSearchParams({ resource: "tasks", workspaceId, boardId })}`;
  const receipt = key => fetch(origin + receiptPath(key), { signal: AbortSignal.timeout(15000) });
  const taskId = key => `SLOWLY#TASK#${key}`;
  const receiptId = key => `SLOWLY#CRUD_OPERATION#${key}`;
  const absence = async key => { assert.equal(await get(taskId(key)), undefined); assert.equal(await get(receiptId(key)), undefined); };
  await check("400 missing operation key and required fields", async () => {
    await expect(post(input, null), 400, "VALIDATION");
    await expect(post({ ...input, workspaceId: undefined }), 400, "VALIDATION");
    await expect(post({ ...input, position: undefined }), 400, "VALIDATION");
  });
  await check("403 no grant, expired grant, revoked grant and wrong Origin", async () => {
    await remove(grant.id);
    await expect(post(), 403, "FORBIDDEN");
    await put({ ...grant, expiresAt: 1 });
    await expect(post(), 403, "FORBIDDEN");
    await put({ ...grant, state: "REVOKED" });
    await expect(post(), 403, "FORBIDDEN");
    await put(grant);
    await expect(post(input, randomUUID(), "http://localhost:3000"), 403, "FORBIDDEN");
  });
  await check("403 cross-workspace and foreign Board, 404 missing Workspace or Board", async () => {
    const foreignId = `SLOWLY#WORKSPACE#${randomUUID()}`;
    await expect(post({ ...input, workspaceId: foreignId }), 403, "FORBIDDEN");
    await expect(view(foreignId), 403, "FORBIDDEN");
    const foreign = makeItem("BOARD", board.data, { parent: foreignId });
    await put(foreign);
    await expect(post({ ...input, boardId: foreign.id }), 403, "OWNERSHIP");
    await expect(post({ ...input, boardId: `SLOWLY#BOARD#${randomUUID()}` }), 404, "NOT_FOUND");
    await remove(workspaceId);
    await expect(post(), 404, "NOT_FOUND");
    await put(workspace);
  });
  await check("isolated Next.js server blocks the ordinary migration route", async () => {
    await expect(fetch(`${origin}/api/migrations/${migrationId}`, { signal: AbortSignal.timeout(15000) }), 403, "FORBIDDEN");
  });
  await check("409 held Migration Lock", async () => {
    await put({ ...workspace, migrationLock: true });
    await expect(post(), 409, "MIGRATION_LOCKED");
    await put(workspace);
  });
  await check("actual transaction cancellation rolls back Board and Receipt", async () => {
    const key = randomUUID();
    const existing = { ...makeItem("TASK", { ...input.data, description: "", notes: "", urgent: false, priority: "\u4e00\u822c", tag: "fixture",
      date: "", time: "", subtasks: [] }, { parent: boardId, workspaceId }), id: taskId(key) };
    await put(existing);
    await expect(post(input, key), 409, "CONFLICT");
    assert.deepEqual(await get(existing.id), existing);
    assert.equal(await get(receiptId(key)), undefined);
    assert.deepEqual(await get(boardId), board);
    await remove(existing.id);
  });
  await check("500 transaction serialization failure never partially commits", async () => {
    const unincrementable = { ...board, version: Number.MAX_SAFE_INTEGER };
    const key = randomUUID();
    await put(unincrementable);
    await expect(post(input, key), 500, "INTERNAL");
    await absence(key);
    assert.deepEqual(await get(boardId), unincrementable);
    await put(board);
  });
  const key = randomUUID();
  let task;
  await check("201 Create, 200 replay, 409 changed payload and WIP", async () => {
    const first = await expect(post(input, key), 201);
    assert.equal(first.response.headers.get("idempotency-status"), "created");
    assert.equal(first.response.headers.get("operation-id"), key);
    task = first.body.data;
    const replay = await expect(post(input, key), 200);
    assert.equal(replay.response.headers.get("idempotency-status"), "replayed");
    assert.deepEqual(replay.body.data, task);
    await expect(post({ ...input, data: { ...input.data, title: "different" } }, key), 409, "OPERATION_CONFLICT");
    await expect(post(), 409, "WIP_LIMIT");
    assert.equal((await get(boardId)).taskCount, 1);
    assert.equal((await get(boardId)).version, board.version + 1);
  });
  await check("GET receipt and Workspace View agree with durable versions", async () => {
    const found = (await expect(receipt(key), 200)).body.data;
    assert.equal(found.state, "CONFIRMED");
    assert.deepEqual(found.result, task);
    assert.deepEqual((await get(receiptId(key))).result, await get(taskId(key)));
    const snapshot = (await expect(view(), 200)).body.data;
    assert.equal(snapshot.workspace.id, workspaceId);
    assert.equal(snapshot.readiness.eligible, true);
    assert.equal(snapshot.boards.length, 1);
    assert.equal(snapshot.boards[0].board.version, board.version + 1);
    assert.deepEqual(snapshot.boards[0].tasks, [task]);
    console.log(JSON.stringify({ example: { request: { method: "POST", path: "/api/tasks", idempotencyKey: key, body: input },
      response: { status: 201, data: task } } }));
  });
  const api = createSlowlyApi({ fetchImpl: (path, options) => fetch(origin + path, options) });
  await check("404 receipt leaves original intent recoverable", async () => {
    const unknown = createSafeCreateIntent(api, "tasks", input, { operationKey: randomUUID() });
    const miss = await expect(receipt(unknown.operationKey), 404, "OPERATION_NOT_FOUND");
    assert.equal(miss.body.error.state, "NOT_FOUND");
    assert.equal((await unknown.lookup()).state, "NOT_FOUND");
    assert.deepEqual(unknown.exportIntent().input, input);
  });
  await check("real HTTP response withheld after commit, timeout recovered through receipt", async () => {
    afterCommit = Promise.withResolvers();
    proxy = createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const upstream = await fetch(origin + request.url, { method: request.method, body: Buffer.concat(chunks),
          headers: { origin, "content-type": "application/json", "idempotency-key": request.headers["idempotency-key"] },
          signal: AbortSignal.timeout(10000) });
        afterCommit.resolve({ status: upstream.status, body: upstream.status === 204 ? null : await upstream.json() });
        // Deliberately withhold the server reply until the client aborts.
      } catch (error) { afterCommit.reject(error); response.destroy(); }
    });
    proxyPort = await listen(proxy);
    const recoverApi = createSlowlyApi({ fetchImpl: (path, options) => fetch((options.method === "POST" ? `http://127.0.0.1:${proxyPort}` : origin) + path, options) });
    const original = { ...input, position: 1, data: { ...input.data, id: "timeout", status: "todo" } };
    const intent = createSafeCreateIntent(recoverApi, "tasks", original, { operationKey: randomUUID() });
    await assert.rejects(intent.send({ timeoutMs: 1500 }), { code: "TIMEOUT", outcome: "not-confirmed" });
    const committed = await afterCommit.promise;
    assert.equal(committed.status, 201);
    assert.deepEqual(intent.exportIntent().input, original);
    const confirmed = await intent.lookup();
    assert.equal(confirmed.state, "CONFIRMED");
    assert.deepEqual(confirmed.result, committed.body.data);
    assert.throws(() => intent.resend(), { code: "ALREADY_CONFIRMED" });
    assert.equal((await get(boardId)).taskCount, 2);
  });
  await check("concurrent distinct keys observe parent version conflicts without partial writes", async () => {
    let conflicts = 0;
    for (let wave = 0; wave < 3 && !conflicts; wave++) {
      const starting = await get(boardId);
      const keys = Array.from({ length: 14 }, () => randomUUID());
      const rows = await Promise.all(keys.map(async (operationKey, index) => {
        const response = await post({ ...input, data: { ...input.data, id: operationKey, status: "todo" }, position: starting.taskCount + index }, operationKey);
        return { operationKey, status: response.status, body: await response.json() };
      }));
      const successful = rows.filter(row => row.status === 201);
      for (const row of rows.filter(row => row.status !== 201)) {
        assert.equal(row.status, 409);
        assert.equal(row.body.error.code, "CONFLICT");
        await absence(row.operationKey);
        conflicts++;
      }
      assert.equal((await get(boardId)).taskCount, starting.taskCount + successful.length);
      assert.equal((await get(boardId)).version, starting.version + successful.length);
    }
    assert.ok(conflicts > 0, "Expected overlapping requests to exercise the version fence");
    const latest = (await expect(view(), 200)).body.data;
    assert.equal(latest.boards[0].tasks.length, (await get(boardId)).taskCount);
    assert.equal((await get(workspaceId)).version, workspace.version);
  });
  if (process.argv.includes("--task-mutations")) {
    const mutate = (method, fields, operationKey, target = task.id, viaProxy = false) => fetch(
      `${viaProxy ? `http://127.0.0.1:${proxyPort}` : origin}/api/tasks/${encodeURIComponent(target)}`, {
        method, signal: AbortSignal.timeout(viaProxy ? 1500 : 15000),
        headers: { origin, "content-type": "application/json", ...(operationKey ? { "idempotency-key": operationKey } : {}) },
        body: JSON.stringify(fields),
      },
    );
    const base = { workspaceId, boardId, version: task.version };
    const patch = { ...base, data: { status: "done", notes: "Saved through HTTP", date: "2026-11-25" } };
    const grantForMutations = { ...grant, version: 2, taskMutations: ["UPDATE", "DELETE"] };
    const methods = [["PATCH", patch], ["DELETE", base]];
    await check("C1 both methods enforce authorization, required scope, ownership and versions", async () => {
      for (const [method, fields] of methods) await expect(mutate(method, fields), 403, "FORBIDDEN");
      for (const change of [{ state: "REVOKED" }, { expiresAt: 1 }]) {
        await put({ ...grantForMutations, ...change });
        for (const [method, fields] of methods) await expect(mutate(method, fields), 403, "FORBIDDEN");
      }
      await put(grantForMutations);
      for (const [method, fields] of methods) {
        await expect(mutate(method, { ...fields, workspaceId: undefined }), 400, "VALIDATION");
        await expect(mutate(method, { ...fields, workspaceId: `SLOWLY#WORKSPACE#${randomUUID()}` }), 403, "FORBIDDEN");
        await expect(mutate(method, { ...fields, boardId: `SLOWLY#BOARD#${randomUUID()}` }), 403, "OWNERSHIP");
        await expect(mutate(method, { ...fields, version: task.version + 1 }), 409, "CONFLICT");
        await expect(mutate(method, fields, null, `SLOWLY#TASK#${randomUUID()}`), 404, "NOT_FOUND");
      }
      await expect(mutate("PATCH", { ...base, data: { completedAt: now } }), 400, "VALIDATION");
      const target = await get(task.id);
      await put({ ...target, migrationLock: true });
      for (const [method, fields] of methods) await expect(mutate(method, fields), 409, "MIGRATION_LOCKED");
      await put(target);
      const snapshot = (await expect(view(), 200)).body.data;
      const todo = snapshot.boards[0].tasks.find(item => item.data.status === "todo");
      await expect(mutate("PATCH", { ...base, version: todo.version, data: { status: "doing" } }, null, todo.id), 409, "WIP_LIMIT");
    });
    await check("C1 cancelled PATCH and DELETE leave task, parent and operation receipt unchanged", async () => {
      const target = await get(task.id);
      const parent = await get(boardId);
      await put({ ...parent, taskCount: 0, doingCount: 0 });
      await expect(mutate("DELETE", base), 409, "CONFLICT");
      await put(parent);
      for (const [method, fields] of methods) {
        const mutationKey = randomUUID();
        // Exercise the transaction serialization failure before dispatch.
        const brokenParent = { ...parent, version: Number.MAX_SAFE_INTEGER };
        await put(brokenParent);
        await expect(mutate(method, fields, mutationKey), 500, "INTERNAL");
        assert.deepEqual(await get(task.id), target);
        assert.deepEqual(await get(boardId), brokenParent);
        assert.equal(await get(receiptId(mutationKey)), undefined);
        assert.equal((await expect(receipt(mutationKey), 404, "OPERATION_NOT_FOUND")).body.error.state, "NOT_FOUND");
        await put(parent);
      }
    });
    let updated;
    await check("C1 PATCH timeout recovers exact receipt, completedAt and fresh Workspace View", async () => {
      const mutationKey = randomUUID();
      const parent = await get(boardId);
      afterCommit = Promise.withResolvers();
      await assert.rejects(mutate("PATCH", patch, mutationKey, task.id, true), { name: "TimeoutError" });
      const written = await afterCommit.promise;
      assert.equal(written.status, 200);
      updated = written.body.data;
      assert.equal(updated.version, task.version + 1);
      assert.ok(Number.isFinite(Date.parse(updated.data.completedAt)));
      assert.equal(updated.data.notes, patch.data.notes);
      assert.equal(updated.data.date, patch.data.date);
      const saved = (await expect(receipt(mutationKey), 200)).body.data;
      assert.equal(saved.action, "UPDATE");
      assert.equal(saved.state, "CONFIRMED");
      assert.deepEqual(saved.result, updated);
      const replay = await expect(mutate("PATCH", patch, mutationKey), 200);
      assert.equal(replay.response.headers.get("idempotency-status"), "replayed");
      assert.deepEqual(replay.body.data, updated);
      await expect(mutate("PATCH", { ...patch, data: { notes: "Different" } }, mutationKey), 409, "OPERATION_CONFLICT");
      await expect(mutate("PATCH", patch), 409, "CONFLICT");
      assert.equal((await get(boardId)).version, parent.version + 1);
      assert.equal((await get(boardId)).taskCount, parent.taskCount);
      assert.equal((await get(boardId)).doingCount, parent.doingCount - 1);
      const snapshot = (await expect(view(), 200)).body.data;
      assert.deepEqual(snapshot.boards[0].tasks.find(item => item.id === task.id), updated);
      assert.equal(snapshot.workspace.version, workspace.version);
      console.log(JSON.stringify({ method: "PATCH", target: task.id, request: patch, status: 200, result: updated }));
    });
    await check("C1 concurrent stale versions cannot both commit", async () => {
      const parent = await get(boardId);
      const edits = ["first", "second"].map(notes => ({ key: randomUUID(), fields: { ...base, version: updated.version, data: { notes } } }));
      const result = await Promise.all(edits.map(async edit => {
        const response = await mutate("PATCH", edit.fields, edit.key);
        return { ...edit, status: response.status, body: await response.json() };
      }));
      assert.deepEqual(result.map(item => item.status).sort(), [200, 409]);
      const accepted = result.find(item => item.status === 200);
      const rejected = result.find(item => item.status === 409);
      assert.equal(rejected.body.error.code, "CONFLICT");
      assert.equal(await get(receiptId(rejected.key)), undefined);
      assert.equal((await get(boardId)).version, parent.version + 1);
      assert.equal(accepted.body.data.data.completedAt, updated.data.completedAt);
      updated = accepted.body.data;
    });
    await check("C1 DELETE timeout resolves to durable tombstone; replay leaves count unchanged", async () => {
      const mutationKey = randomUUID();
      const fields = { ...base, version: updated.version };
      const parent = await get(boardId);
      afterCommit = Promise.withResolvers();
      await assert.rejects(mutate("DELETE", fields, mutationKey, task.id, true), { name: "TimeoutError" });
      assert.equal((await afterCommit.promise).status, 204);
      const saved = (await expect(receipt(mutationKey), 200)).body.data;
      assert.equal(saved.action, "DELETE");
      assert.equal(saved.state, "CONFIRMED");
      assert.equal(saved.targetId, task.id);
      assert.equal(saved.result, null);
      assert.equal(await get(task.id), undefined);
      const replay = await mutate("DELETE", fields, mutationKey);
      assert.equal(replay.status, 204);
      assert.equal(replay.headers.get("idempotency-status"), "replayed");
      assert.equal(await replay.text(), "");
      await expect(mutate("DELETE", fields), 404, "NOT_FOUND");
      await expect(mutate("PATCH", patch, mutationKey), 409, "OPERATION_CONFLICT");
      assert.equal((await get(boardId)).version, parent.version + 1);
      assert.equal((await get(boardId)).taskCount, parent.taskCount - 1);
      const snapshot = (await expect(view(), 200)).body.data;
      assert.equal(snapshot.boards[0].tasks.some(item => item.id === task.id), false);
      assert.equal(snapshot.boards[0].tasks.length, parent.taskCount - 1);
      console.log(JSON.stringify({ method: "DELETE", target: task.id, request: fields, status: 204 }));
    });
  }
  if (process.argv.includes("--boards")) {
    const sendBoard = (method, suffix, fields, operationKey, viaProxy = false) => fetch(
      `${viaProxy ? `http://127.0.0.1:${proxyPort}` : origin}/api/boards${suffix}`, {
        method, signal: AbortSignal.timeout(viaProxy ? 1500 : 15000), headers: { origin, "content-type": "application/json",
          ...(operationKey ? { "idempotency-key": operationKey } : {}) }, body: JSON.stringify(fields),
      },
    );
    const boardReceipt = operationKey => fetch(`${origin}/api/operations/${operationKey}?${new URLSearchParams({ resource: "boards", workspaceId })}`);
    const byId = id => `/${encodeURIComponent(id)}`;
    const boardInput = { workspaceId, position: 1, data: { id: "c2-board", name: "New Board", description: "", wipLimit: 2 } };
    const boardGrant = { ...grant, version: 3, boardMutations: ["CREATE", "UPDATE", "DELETE", "ORDER"] };
    let createdBoard;
    await check("C2 Board Create authorization, validation and durable atomic replay", async () => {
      await expect(sendBoard("POST", "", boardInput, randomUUID()), 403, "FORBIDDEN");
      for (const state of [{ state: "REVOKED" }, { expiresAt: 1 }]) {
        await put({ ...boardGrant, ...state });
        await expect(sendBoard("POST", "", boardInput, randomUUID()), 403, "FORBIDDEN");
      }
      await put(boardGrant);
      await expect(sendBoard("POST", "", { ...boardInput, position: -1 }, randomUUID()), 400, "VALIDATION");
      await expect(sendBoard("POST", "", boardInput), 400, "VALIDATION");
      await expect(sendBoard("POST", "", { ...boardInput, workspaceId: `SLOWLY#WORKSPACE#${randomUUID()}` }, randomUUID()), 403, "FORBIDDEN");
      await remove(workspaceId);
      await expect(sendBoard("POST", "", boardInput, randomUUID()), 404, "NOT_FOUND");
      await put(workspace);
      const operationKey = randomUUID();
      const before = await get(workspaceId);
      const fresh = await expect(sendBoard("POST", "", boardInput, operationKey), 201);
      createdBoard = fresh.body.data;
      assert.equal(fresh.response.headers.get("idempotency-status"), "created");
      assert.deepEqual((await expect(sendBoard("POST", "", boardInput, operationKey), 200)).body.data, createdBoard);
      await expect(sendBoard("POST", "", { ...boardInput, position: 2 }, operationKey), 409, "OPERATION_CONFLICT");
      const duplicateIdKey = randomUUID();
      await expect(sendBoard("POST", "", boardInput, duplicateIdKey), 409, "CONFLICT");
      assert.equal(await get(receiptId(duplicateIdKey)), undefined);
      assert.deepEqual((await expect(boardReceipt(operationKey), 200)).body.data.result, createdBoard);
      assert.equal((await get(workspaceId)).version, before.version + 1);
      assert.equal((await get(workspaceId)).boardCount, before.boardCount + 1);
      console.log(JSON.stringify({ action: "Board POST", request: boardInput, status: 201, version: createdBoard.version }));
    });
    await check("C2 Board Update preserves children and rejects unauthorized or stale changes", async () => {
      const widget = makeItem("WIDGET", { id: "retained-widget", type: "note", span: 4, height: 180, config: { text: "Keep this" } },
        { parent: boardId, workspaceId });
      const current = { ...await get(boardId), widgetCount: 1 };
      await Promise.all([put(widget), put(current)]);
      const before = (await expect(view(), 200)).body.data;
      const children = before.boards.find(item => item.board.id === boardId);
      assert.equal(children.widgets[0].id, widget.id);
      const fields = { workspaceId, version: current.version, data: { name: "Updated fixture", wipLimit: 3 } };
      await put({ ...boardGrant, boardMutations: ["CREATE"] });
      await expect(sendBoard("PATCH", byId(boardId), fields, randomUUID()), 403, "FORBIDDEN");
      await put(boardGrant);
      await expect(sendBoard("PATCH", byId(boardId), { ...fields, workspaceId: `SLOWLY#WORKSPACE#${randomUUID()}` }, randomUUID()), 403, "FORBIDDEN");
      await expect(sendBoard("PATCH", byId(`SLOWLY#BOARD#${randomUUID()}`), fields, randomUUID()), 404, "NOT_FOUND");
      await expect(sendBoard("PATCH", byId(boardId), { ...fields, data: { widgetCount: 0 } }, randomUUID()), 400, "VALIDATION");
      await put({ ...current, migrationLock: true });
      await expect(sendBoard("PATCH", byId(boardId), fields, randomUUID()), 409, "MIGRATION_LOCKED");
      await put(current);
      const operationKey = randomUUID();
      const { body } = await expect(sendBoard("PATCH", byId(boardId), fields, operationKey), 200);
      assert.equal(body.data.version, current.version + 1);
      assert.equal(body.data.data.wipLimit, 3);
      assert.deepEqual((await expect(boardReceipt(operationKey), 200)).body.data.result, body.data);
      await expect(sendBoard("PATCH", byId(boardId), fields, randomUUID()), 409, "CONFLICT");
      const snapshot = (await expect(view(), 200)).body.data;
      const reread = snapshot.boards.find(item => item.board.id === boardId);
      assert.deepEqual(reread.tasks, children.tasks);
      assert.deepEqual(reread.widgets, children.widgets);
      assert.equal(snapshot.workspace.version, before.workspace.version);
      console.log(JSON.stringify({ action: "Board PATCH", request: fields, status: 200, version: reread.board.version }));
    });
    await check("C2 complete Board order commits as a single versioned operation", async () => {
      const first = await get(boardId);
      const second = await get(createdBoard.id);
      const root = await get(workspaceId);
      const entries = [{ id: second.id, version: second.version, position: 0 }, { id: first.id, version: first.version, position: 1 }];
      const fields = { workspaceId, entries };
      await expect(sendBoard("PATCH", "/order", { ...fields, entries: [entries[0]] }, randomUUID()), 409, "CONFLICT");
      await expect(sendBoard("PATCH", "/order", { ...fields, entries: [entries[0], entries[0]] }, randomUUID()), 400, "VALIDATION");
      await expect(sendBoard("PATCH", "/order", { ...fields, entries: [entries[0], { ...entries[1], position: 0 }] }, randomUUID()), 400, "VALIDATION");
      await expect(sendBoard("PATCH", "/order", { ...fields, entries: [entries[0], { ...entries[1], position: -1 }] }, randomUUID()), 400, "VALIDATION");
      const foreign = makeItem("BOARD", first.data, { parent: `SLOWLY#WORKSPACE#${randomUUID()}` });
      await put(foreign);
      await expect(sendBoard("PATCH", "/order", { ...fields, entries: [entries[0], { id: foreign.id, version: foreign.version, position: 1 }] }, randomUUID()), 403, "OWNERSHIP");
      await expect(sendBoard("PATCH", "/order", { ...fields, entries: [entries[0], { ...entries[1], version: first.version + 1 }] }, randomUUID()), 409, "CONFLICT");
      const oversized = Array.from({ length: 97 }, (_, position) => ({ id: `SLOWLY#BOARD#${randomUUID()}`, version: 1, position }));
      await expect(sendBoard("PATCH", "/order", { ...fields, entries: oversized }, randomUUID()), 400, "VALIDATION");
      const broken = { ...first, version: Number.MAX_SAFE_INTEGER };
      const failedKey = randomUUID();
      await put(broken);
      await expect(sendBoard("PATCH", "/order", { ...fields, entries: [entries[0], { ...entries[1], version: broken.version }] }, failedKey), 500, "INTERNAL");
      assert.equal(await get(receiptId(failedKey)), undefined);
      assert.deepEqual(await get(first.id), broken);
      assert.deepEqual(await get(second.id), second);
      await put(first);
      assert.deepEqual(await get(workspaceId), root);
      assert.deepEqual(await get(first.id), first);
      assert.deepEqual(await get(second.id), second);
      const operationKey = randomUUID();
      const { body } = await expect(sendBoard("PATCH", "/order", fields, operationKey), 200);
      assert.deepEqual((await expect(sendBoard("PATCH", "/order", fields, operationKey), 200)).body.data, body.data);
      const recovered = (await expect(boardReceipt(operationKey), 200)).body.data;
      assert.equal(recovered.action, "ORDER");
      assert.deepEqual(recovered.result, body.data);
      const snapshot = (await expect(view(), 200)).body.data;
      assert.deepEqual(snapshot.boards.map(item => item.board.id), [second.id, first.id]);
      assert.deepEqual(snapshot.boards.map(item => item.board.version), [second.version + 1, first.version + 1]);
      assert.equal(snapshot.workspace.version, root.version + 1);
      assert.equal((await get(workspaceId)).boardCount, root.boardCount);
      console.log(JSON.stringify({ action: "Board ORDER", request: fields, status: 200, positions: body.data.map(item => item.position) }));
    });
    await check("C2 transaction cancellation and non-empty Task/Widget Boards cannot be deleted", async () => {
      const root = await get(workspaceId);
      const occupiedKey = randomUUID();
      const occupied = { ...makeItem("BOARD", boardInput.data, { parent: `SLOWLY#WORKSPACE#${randomUUID()}` }), id: `SLOWLY#BOARD#${occupiedKey}` };
      await put(occupied);
      await expect(sendBoard("POST", "", boardInput, occupiedKey), 409, "CONFLICT");
      assert.equal(await get(receiptId(occupiedKey)), undefined);
      assert.deepEqual(await get(workspaceId), root);
      assert.deepEqual(await get(occupied.id), occupied);
      await remove(occupied.id);
      const first = await get(boardId);
      const second = await get(createdBoard.id);
      await expect(sendBoard("DELETE", byId(first.id), { workspaceId, version: first.version }, randomUUID()), 409, "NOT_EMPTY");
      const widget = makeItem("WIDGET", { id: "fixture-widget", type: "note", span: 4, height: 180, config: {} }, { parent: second.id, workspaceId });
      await put(widget);
      await put({ ...second, widgetCount: 1 });
      await expect(sendBoard("DELETE", byId(second.id), { workspaceId, version: second.version }, randomUUID()), 409, "NOT_EMPTY");
      assert.deepEqual(await get(widget.id), widget);
      await remove(widget.id);
      await put(second);
      assert.deepEqual(await get(workspaceId), root);
    });
    await check("C2 empty Board DELETE timeout recovers Receipt and count changes only once", async () => {
      const before = await get(workspaceId);
      const target = await get(createdBoard.id);
      const fields = { workspaceId, version: target.version };
      await expect(sendBoard("DELETE", byId(target.id), fields), 400, "VALIDATION");
      const operationKey = randomUUID();
      afterCommit = Promise.withResolvers();
      await assert.rejects(sendBoard("DELETE", byId(target.id), fields, operationKey, true), { name: "TimeoutError" });
      assert.equal((await afterCommit.promise).status, 204);
      const confirmed = (await expect(boardReceipt(operationKey), 200)).body.data;
      assert.equal(confirmed.action, "DELETE");
      assert.equal(confirmed.state, "CONFIRMED");
      assert.equal(confirmed.targetId, target.id);
      assert.equal(confirmed.result, null);
      const replay = await sendBoard("DELETE", byId(target.id), fields, operationKey);
      assert.equal(replay.status, 204);
      assert.equal(replay.headers.get("idempotency-status"), "replayed");
      assert.equal(await get(target.id), undefined);
      assert.equal((await get(workspaceId)).boardCount, before.boardCount - 1);
      assert.equal((await get(workspaceId)).version, before.version + 1);
      const snapshot = (await expect(view(), 200)).body.data;
      assert.deepEqual(snapshot.boards.map(item => item.board.id), [boardId]);
      assert.equal(snapshot.boards[0].tasks.length, (await get(boardId)).taskCount);
      console.log(JSON.stringify({ action: "Board DELETE", request: fields, status: 204 }));
    });
  }
  if (process.argv.includes("--widgets")) {
    const sendWidget = (method, suffix, fields, key = randomUUID(), useProxy = false) => fetch(
      `${useProxy ? `http://127.0.0.1:${proxyPort}` : origin}/api/widgets${suffix}`, {
        method, signal: AbortSignal.timeout(useProxy ? 1500 : 15000), headers: { origin, "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(fields),
      },
    );
    const widgetReceipt = key => fetch(`${origin}/api/operations/${key}?${new URLSearchParams({ resource: "widgets", workspaceId, boardId })}`);
    const byId = id => `/${encodeURIComponent(id)}`;
    const scope = { workspaceId, boardId };
    const input = { ...scope, position: 1, data: { id: "widget-c3", type: "note", span: 6, height: 200, config: { text: "original" } } };
    const currentGrant = await get(grant.id);
    const widgetGrant = { ...currentGrant, version: currentGrant.version + 1, widgetMutations: ["CREATE", "UPDATE", "DELETE", "ORDER"] };
    let widget;
    await check("C3 Widget Create validates scope, type/config, dimensions and idempotency", async () => {
      await expect(sendWidget("POST", "", input), 403, "FORBIDDEN");
      await put({ ...widgetGrant, expiresAt: 1 });
      await expect(sendWidget("POST", "", input), 403, "FORBIDDEN");
      await put(widgetGrant);
      for (const fields of [{ type: "invalid" }, { config: { minutes: 25 } }, { config: { text: 1 } }, { span: 3 }, { height: 601 }]) {
        await expect(sendWidget("POST", "", { ...input, data: { ...input.data, ...fields } }), 400, "VALIDATION");
      }
      await expect(sendWidget("POST", "", { ...input, position: -1 }), 400, "VALIDATION");
      await expect(sendWidget("POST", "", { ...input, workspaceId: `SLOWLY#WORKSPACE#${randomUUID()}` }), 403, "FORBIDDEN");
      const foreign = makeItem("BOARD", board.data, { parent: `SLOWLY#WORKSPACE#${randomUUID()}` });
      await put(foreign);
      await expect(sendWidget("POST", "", { ...input, boardId: foreign.id }), 403, "OWNERSHIP");
      await expect(sendWidget("POST", "", { ...input, boardId: `SLOWLY#BOARD#${randomUUID()}` }), 404, "NOT_FOUND");
      const before = await get(boardId);
      const root = await get(workspaceId);
      const createKey = randomUUID();
      await put({ ...makeItem("WIDGET", input.data, { parent: foreign.id, workspaceId: foreign.workspaceId }),
        id: `SLOWLY#WIDGET#${createKey}` });
      await expect(sendWidget("POST", "", input, createKey), 409, "CONFLICT");
      assert.deepEqual(await get(boardId), before);
      assert.equal(await get(receiptId(createKey)), undefined);
      const key = randomUUID();
      const response = await expect(sendWidget("POST", "", input, key), 201);
      widget = response.body.data;
      assert.deepEqual(widget.data, input.data);
      assert.equal(widget.position, input.position);
      assert.deepEqual((await expect(sendWidget("POST", "", input, key), 200)).body.data, widget);
      await expect(sendWidget("POST", "", { ...input, position: 2 }, key), 409, "OPERATION_CONFLICT");
      assert.deepEqual((await expect(widgetReceipt(key), 200)).body.data.result, widget);
      assert.equal((await get(boardId)).version, before.version + 1);
      assert.equal((await get(boardId)).widgetCount, before.widgetCount + 1);
      assert.deepEqual(await get(workspaceId), root);
      console.log(JSON.stringify({ action: "Widget POST", request: input, status: 201, version: widget.version }));
    });
    await check("C3 Widget PATCH preserves extensions and enforces version, ownership and lock", async () => {
      const previous = await get(widget.id);
      await put({ ...previous, data: { ...previous.data, config: { ...previous.data.config, importedSetting: "retain" } } });
      const fields = { ...scope, version: widget.version, data: { span: 8, height: 240, manualSize: true, config: { text: "updated" } } };
      await expect(sendWidget("PATCH", byId(`SLOWLY#WIDGET#${randomUUID()}`), fields), 404, "NOT_FOUND");
      await expect(sendWidget("PATCH", byId(widget.id), { ...fields, boardId: `SLOWLY#BOARD#${randomUUID()}` }), 403, "OWNERSHIP");
      await expect(sendWidget("PATCH", byId(widget.id), { ...fields, data: { type: "timer" } }), 400, "VALIDATION");
      await expect(sendWidget("PATCH", byId(widget.id), { ...fields, data: { type: "timer", config: { minutes: 26 } } }), 400, "VALIDATION");
      await expect(sendWidget("PATCH", byId(widget.id), { ...fields, data: { position: 0 } }), 400, "VALIDATION");
      const saved = await get(widget.id);
      await put({ ...saved, migrationLock: true });
      await expect(sendWidget("PATCH", byId(widget.id), fields), 409, "MIGRATION_LOCKED");
      await put(saved);
      const key = randomUUID();
      const response = await expect(sendWidget("PATCH", byId(widget.id), fields, key), 200);
      assert.equal(response.body.data.version, widget.version + 1);
      assert.deepEqual(response.body.data.data.config, { text: "updated", importedSetting: "retain" });
      assert.equal(response.body.data.data.height, 240);
      await expect(sendWidget("PATCH", byId(widget.id), fields), 409, "CONFLICT");
      assert.deepEqual((await expect(widgetReceipt(key), 200)).body.data.result, response.body.data);
      widget = response.body.data;
      console.log(JSON.stringify({ action: "Widget PATCH", request: fields, status: 200, version: widget.version }));
    });
    await check("C3 complete Widget order is atomic and reloads in Workspace View", async () => {
      const next = { ...input, position: 2, data: { id: "c3-timer", type: "timer", span: 4, height: 180,
        config: { minutes: 25, taskId: "http-task", endsAt: null, remaining: 60 } } };
      const timer = (await expect(sendWidget("POST", "", next), 201)).body.data;
      const start = (await expect(view(), 200)).body.data;
      const originBoard = start.boards.find(row => row.board.id === boardId);
      const entries = [timer, ...originBoard.widgets.filter(item => item.id !== timer.id)].map(({ id, version }, position) => ({ id, version, position }));
      const order = { ...scope, entries };
      await expect(sendWidget("PATCH", "/order", { ...order, entries: entries.slice(1) }), 409, "CONFLICT");
      await expect(sendWidget("PATCH", "/order", { ...order, entries: [entries[0], entries[0]] }), 400, "VALIDATION");
      await expect(sendWidget("PATCH", "/order", { ...order, entries: [entries[0], ...entries.slice(1).map(item => ({ ...item, position: 0 }))] }), 400, "VALIDATION");
      const oversized = Array.from({ length: 96 }, (_, position) => ({ id: `SLOWLY#WIDGET#${randomUUID()}`, version: 1, position }));
      await expect(sendWidget("PATCH", "/order", { ...order, entries: oversized }), 400, "VALIDATION");
      const old = await get(widget.id);
      const broken = { ...old, version: Number.MAX_SAFE_INTEGER };
      const parent = await get(boardId);
      const failedKey = randomUUID();
      await put(broken);
      await expect(sendWidget("PATCH", "/order", { ...order, entries: entries.map(item => item.id === widget.id ? { ...item, version: broken.version } : item) }, failedKey), 500, "INTERNAL");
      assert.deepEqual(await get(boardId), parent);
      assert.equal((await get(timer.id)).version, timer.version);
      assert.equal(await get(receiptId(failedKey)), undefined);
      await put(old);
      const key = randomUUID();
      const ordered = (await expect(sendWidget("PATCH", "/order", order, key), 200)).body.data;
      assert.deepEqual((await expect(sendWidget("PATCH", "/order", order, key), 200)).body.data, ordered);
      assert.deepEqual((await expect(widgetReceipt(key), 200)).body.data.result, ordered);
      assert.deepEqual(ordered.map(item => [item.id, item.position, item.version]), entries.map(item => [item.id, item.position, item.version + 1]));
      const reread = (await expect(view(), 200)).body.data;
      const boardView = reread.boards.find(row => row.board.id === boardId);
      assert.deepEqual(boardView.widgets, ordered);
      assert.deepEqual(boardView.tasks, originBoard.tasks);
      assert.equal(boardView.board.version, originBoard.board.version + 1);
      assert.equal(reread.workspace.version, start.workspace.version);
      widget = ordered.find(item => item.id === widget.id);
      console.log(JSON.stringify({ action: "Widget ORDER", request: order, status: 200 }));
    });
    await check("C3 Widget DELETE timeout recovers a receipt without changing other entities", async () => {
      const parent = await get(boardId);
      const before = (await expect(view(), 200)).body.data;
      const fields = { ...scope, version: widget.version };
      await expect(sendWidget("DELETE", byId(widget.id), { ...fields, version: widget.version - 1 }), 409, "CONFLICT");
      const key = randomUUID();
      afterCommit = Promise.withResolvers();
      await assert.rejects(sendWidget("DELETE", byId(widget.id), fields, key, true), { name: "TimeoutError" });
      assert.equal((await afterCommit.promise).status, 204);
      const durable = (await expect(widgetReceipt(key), 200)).body.data;
      assert.equal(durable.action, "DELETE");
      assert.equal(durable.targetId, widget.id);
      assert.equal(durable.state, "CONFIRMED");
      assert.equal(durable.result, null);
      const replay = await sendWidget("DELETE", byId(widget.id), fields, key);
      assert.equal(replay.status, 204);
      assert.equal(replay.headers.get("idempotency-status"), "replayed");
      assert.equal(await get(widget.id), undefined);
      assert.equal((await get(boardId)).widgetCount, parent.widgetCount - 1);
      assert.equal((await get(boardId)).version, parent.version + 1);
      const snapshot = (await expect(view(), 200)).body.data;
      assert.deepEqual(snapshot.workspace, before.workspace);
      const oldBoard = before.boards.find(row => row.board.id === boardId);
      const newBoard = snapshot.boards.find(row => row.board.id === boardId);
      assert.deepEqual(newBoard.tasks, oldBoard.tasks);
      assert.deepEqual(newBoard.widgets, oldBoard.widgets.filter(item => item.id !== widget.id));
      console.log(JSON.stringify({ action: "Widget DELETE", request: fields, status: 204 }));
    });
  }
  if (process.argv.includes("--workspaces")) {
    const sendWorkspace = (method, fields, key = randomUUID(), target = "", useProxy = false) => fetch(
      `${useProxy ? `http://127.0.0.1:${proxyPort}` : origin}/api/workspaces${target ? `/${encodeURIComponent(target)}` : ""}`, {
        method, signal: AbortSignal.timeout(useProxy ? 1500 : 15000),
        headers: { origin, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(fields),
      });
    const receiptFor = (key, target) => fetch(`${origin}/api/operations/${key}?${new URLSearchParams({
      resource: "workspaces", ...(target ? { workspaceId: target } : { scope: "local-workspace-create-v1" }),
    })}`);
    const currentGrant = await get(grant.id);
    const lifecycleGrant = { ...currentGrant, version: currentGrant.version + 1, workspaceMutations: ["CREATE", "UPDATE", "DELETE"] };
    const fields = { data: { name: "New Workspace", description: "HTTP fixture", settings: { layout: "compact" } } };
    let created;
    await check("C4 authorized Workspace Create initializes an empty view and replays its Receipt", async () => {
      await expect(sendWorkspace("POST", fields), 403, "FORBIDDEN");
      await put({ ...lifecycleGrant, state: "REVOKED" });
      await expect(sendWorkspace("POST", fields), 403, "FORBIDDEN");
      await put({ ...lifecycleGrant, expiresAt: 1 });
      await expect(sendWorkspace("POST", fields), 403, "FORBIDDEN");
      await put(lifecycleGrant);
      await expect(sendWorkspace("POST", {}), 400, "VALIDATION");
      await expect(sendWorkspace("POST", { data: { activeBoardId: board.data.id } }), 400, "VALIDATION");
      await expect(sendWorkspace("POST", { data: { name: "" } }), 400, "VALIDATION");
      await expect(sendWorkspace("POST", { data: { id: workspaceId } }), 400, "VALIDATION");
      const key = randomUUID();
      const response = await expect(sendWorkspace("POST", fields, key), 201);
      created = response.body.data;
      assert.equal(created.id, `SLOWLY#WORKSPACE#${key}`);
      assert.equal((await get(created.id)).boardCount, 0);
      assert.equal(created.data.activeBoardId, undefined);
      assert.deepEqual((await expect(sendWorkspace("POST", fields, key), 200)).body.data, created);
      await expect(sendWorkspace("POST", { data: { ...fields.data, name: "different" } }, key), 409, "OPERATION_CONFLICT");
      assert.deepEqual((await expect(receiptFor(key), 200)).body.data.result, created);
      const empty = (await expect(view(created.id), 200)).body.data;
      assert.deepEqual(empty.workspace, created);
      assert.deepEqual(empty.boards, []);
      assert.equal(empty.readiness.eligible, true);
      console.log(JSON.stringify({ action: "Workspace POST", request: fields, status: 201, version: created.version }));
    });
    await check("C4 Workspace Update validates active Board and preserves the complete hierarchy", async () => {
      const initial = (await expect(view(), 200)).body.data;
      const version = initial.workspace.version;
      const patch = { version, data: { name: "Updated", description: "Description", activeBoardId: board.data.id, settings: { layout: "compact" } } };
      await expect(sendWorkspace("PATCH", { ...patch, data: { activeBoardId: boardId } }, randomUUID(), workspaceId), 400, "VALIDATION");
      await expect(sendWorkspace("PATCH", { ...patch, data: { boardCount: 0 } }, randomUUID(), workspaceId), 400, "VALIDATION");
      await expect(sendWorkspace("PATCH", { ...patch, version: version + 1 }, randomUUID(), workspaceId), 409, "CONFLICT");
      await expect(sendWorkspace("PATCH", patch, randomUUID(), `SLOWLY#WORKSPACE#${randomUUID()}`), 404, "NOT_FOUND");
      const foreign = makeItem("WORKSPACE", {});
      await put(foreign);
      await expect(sendWorkspace("PATCH", patch, randomUUID(), foreign.id), 403, "FORBIDDEN");
      const root = await get(workspaceId);
      await put({ ...root, migrationLock: true });
      await expect(sendWorkspace("PATCH", patch, randomUUID(), workspaceId), 409, "MIGRATION_LOCKED");
      await put(root);
      const key = randomUUID();
      const updated = (await expect(sendWorkspace("PATCH", patch, key, workspaceId), 200)).body.data;
      const receipt = (await expect(receiptFor(key, workspaceId), 200)).body.data;
      assert.equal(receipt.action, "UPDATE");
      assert.deepEqual(receipt.result, updated);
      assert.equal(updated.version, version + 1);
      const live = (await expect(view(), 200)).body.data;
      assert.deepEqual(live.workspace, updated);
      assert.deepEqual(live.boards, initial.boards);
      assert.equal(live.workspace.data.activeBoardId, board.data.id);
      assert.equal((await get(workspaceId)).boardCount, root.boardCount);
      console.log(JSON.stringify({ action: "Workspace PATCH", request: patch, status: 200, version: updated.version }));
    });
    await check("C4 failed transaction and dependent entities do not leave partial changes", async () => {
      const collisionKey = randomUUID();
      const existing = { ...makeItem("WORKSPACE", {}), id: `SLOWLY#WORKSPACE#${collisionKey}` };
      await put(existing);
      await expect(sendWorkspace("POST", fields, collisionKey), 409, "CONFLICT");
      assert.deepEqual(await get(existing.id), existing);
      assert.equal(await get(receiptId(collisionKey)), undefined);
      const parent = await get(workspaceId);
      await expect(sendWorkspace("DELETE", { version: parent.version }, randomUUID(), workspaceId), 409, "NOT_EMPTY");
      assert.deepEqual(await get(workspaceId), parent);
      const orphan = makeItem("TASK", { ...input.data, description: "", notes: "", urgent: false, priority: "\u4e00\u822c", tag: "fixture",
        date: "", time: "", subtasks: [] }, { parent: `SLOWLY#BOARD#${randomUUID()}`, workspaceId: created.id });
      await put(orphan);
      const key = randomUUID();
      await expect(sendWorkspace("DELETE", { version: created.version }, key, created.id), 409, "NOT_EMPTY");
      assert.deepEqual(await get(orphan.id), orphan);
      assert.equal(await get(receiptId(key)), undefined);
      await remove(orphan.id);
    });
    await check("C4 Workspace DELETE timeout confirms an empty-workspace tombstone without cascade", async () => {
      const updateKey = randomUUID();
      created = (await expect(sendWorkspace("PATCH", { version: created.version, data: { name: "Updated empty Workspace" } },
        updateKey, created.id), 200)).body.data;
      const fields = { version: created.version };
      const before = (await expect(view(), 200)).body.data;
      const key = randomUUID();
      afterCommit = Promise.withResolvers();
      await assert.rejects(sendWorkspace("DELETE", fields, key, created.id, true), { name: "TimeoutError" });
      assert.equal((await afterCommit.promise).status, 204);
      const durable = (await expect(receiptFor(key, created.id), 200)).body.data;
      assert.equal(durable.state, "CONFIRMED");
      assert.equal(durable.action, "DELETE");
      assert.equal(durable.targetId, created.id);
      assert.equal(durable.result, null);
      assert.deepEqual((await expect(receiptFor(updateKey, created.id), 200)).body.data.result, created);
      const replay = await sendWorkspace("DELETE", fields, key, created.id);
      assert.equal(replay.status, 204);
      assert.equal(replay.headers.get("idempotency-status"), "replayed");
      await expect(view(created.id), 404, "NOT_FOUND");
      assert.equal(await get(created.id), undefined);
      assert.deepEqual((await expect(view(), 200)).body.data.boards, before.boards);
      console.log(JSON.stringify({ action: "Workspace DELETE", request: fields, status: 204 }));
    });
  }
  if (process.argv.includes("--browser-read") || process.argv.includes("--browser-write")) {
    const { checkChromeRead } = await import("../tests/helpers/chrome-read-acceptance.mjs");
    const { checkChromeWrite } = process.argv.includes("--browser-write") ? await import("../tests/helpers/chrome-write-acceptance.mjs") : {};
    async function setBrowserGrant(enabled) {
      const current = await get(grant.id);
      await put({ ...current, version: current.version + 1,
        taskMutations: enabled ? ["UPDATE", "DELETE", "ORDER"] : [],
        boardMutations: ["CREATE", "UPDATE", "DELETE", "ORDER"], widgetMutations: ["CREATE", "UPDATE", "DELETE", "ORDER"],
        workspaceMutations: ["CREATE"] });
    }
    if (checkChromeWrite) await setBrowserGrant(true);
    const first = (await expect(post({ ...input, position: 0, data: {
      id: "d1-first", title: "D1 first task", status: "todo", date: "2026-11-25", time: "10:30",
    } }), 201)).body.data;
    const second = (await expect(post({ ...input, position: 1000, data: { id: "d1-second", title: "D1 second task", status: "todo" } }), 201)).body.data;
    const fetchWrite = (path, fields) => fetch(origin + path, {
      method: "POST", headers: { origin, "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify(fields),
    });
    const note = (await expect(fetchWrite("/api/widgets", { workspaceId, boardId, position: 1000,
      data: { id: "d1-note", type: "note", span: 6, height: 240, config: { text: "D1 saved note" } } }), 201)).body.data;
    const other = (await expect(fetchWrite("/api/workspaces", { data: { name: "D1 empty Workspace" } }), 201)).body.data;
    const stable = await get(boardId);
    await check("D1 real Chrome source switching, Workspace View, locally seeded data, conflict and reload", async () => {
      const snapshot = (await expect(view(), 200)).body.data;
      const current = snapshot.boards.find(row => row.board.id === boardId);
      assert.deepEqual(current.tasks.find(item => item.id === first.id), first);
      assert.deepEqual(current.tasks.find(item => item.id === second.id), second);
      assert.deepEqual(current.widgets.find(item => item.id === note.id), note);
      const result = await checkChromeRead({ origin, workspaceId, secondWorkspaceId: other.id, expectedBoardName: stable.data.name,
        deniedId: `SLOWLY#WORKSPACE#${randomUUID()}`,
        injectConflict: enabled => put(enabled ? { ...stable, taskCount: stable.taskCount + 1 } : stable),
        writeScenario: checkChromeWrite && (async driver => {
          const options = { origin, workspaceId, view: async () => (await expect(view(), 200)).body.data,
            setGrant: setBrowserGrant,
            changeTaskVersion: async id => { const task = await get(id); await put({ ...task, version: task.version + 1 }); } };
          await checkChromeWrite(driver, options);
          const { checkChromeOrder } = await import("../tests/helpers/chrome-order-acceptance.mjs");
          const extraBoard = (await expect(fetchWrite("/api/boards", { workspaceId, position: 20, data: { id: "d3-board", name: "D3 Board", description: "", wipLimit: 4 } }), 201)).body.data;
          await expect(fetchWrite("/api/widgets", { workspaceId, boardId, position: 2000,
            data: { id: "d3-widget", type: "analytics", span: 6, height: 240, config: {} } }), 201);
          await checkChromeOrder(driver, { ...options, boardId, extraBoardId: extraBoard.id,
            replay: request => fetch(request.url, { method: "PATCH", headers: {
              origin, "content-type": "application/json", "idempotency-key": new Headers(request.headers).get("idempotency-key"),
            }, body: request.postData }),
            assertStored: async rows => {
              for (const row of rows) {
                const stored = await get(row.id);
                assert.equal(stored.version, row.version);
                assert.equal(stored.position, row.position);
                assert.deepEqual(stored.data, row.data);
              }
            } });
          const latest = (await expect(view(), 200)).body.data;
          const current = latest.boards.find(row => row.board.id === boardId);
          assert.equal((await get(workspaceId)).boardCount, latest.boards.length);
          const storedBoard = await get(boardId);
          assert.equal(storedBoard.taskCount, current.tasks.length);
          assert.equal(storedBoard.widgetCount, current.widgets.length);
          assert.equal(storedBoard.doingCount, current.tasks.filter(row => row.data.status === "doing").length);
          const target = current.widgets.find(row => row.data.id === "d3-widget");
          const edits = [260, 280].map(height => fetch(`${origin}/api/widgets/${encodeURIComponent(target.id)}`, {
            method: "PATCH", headers: { origin, "content-type": "application/json", "idempotency-key": randomUUID() },
            body: JSON.stringify({ workspaceId, boardId, version: target.version, data: { height } }),
          }));
          const results = await Promise.all(edits);
          assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
          assert.equal((await get(target.id)).version, target.version + 1);
          assert.equal((await get(boardId)).version, storedBoard.version + 1);
          console.log("PASS D3 Chrome ordering, replay, conflict, offline receipt and reload");
        }),
        lifecycleScenario: process.argv.includes("--browser-lifecycle") && (async driver => {
          await put({ ...(await get(grant.id)), childWorkspaceWrites: true, workspaceMutations: ["CREATE", "UPDATE", "DELETE"] });
          const { checkChromeLifecycle } = await import("../tests/helpers/chrome-workspace-lifecycle.mjs");
          const result = await checkChromeLifecycle(driver, { origin, get });
          console.log(JSON.stringify({ phase5D4: result }));
        }) });
      console.log(JSON.stringify({ chromeAcceptance: result }));
    });
  }
  console.log(`HTTP integration: ${passed}/${passed} scenario groups passed`);
} catch (error) {
  console.error(serverLog);
  console.error(error);
  throw error;
} finally {
  try {
    if (proxy) await close(proxy);
    if (child?.pid && child.exitCode === null) {
      const stopped = once(child, "exit");
      if (process.platform === "win32") {
        const stopTree = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        const [code] = await once(stopTree, "exit");
        if (code !== 0) {
          await Promise.race([stopped, delay(1000)]);
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        }
      } else child.kill("SIGTERM");
      await stopped;
    }
    if (created) {
      await client.send(new DeleteTableCommand({ TableName: tableName }));
      await waitUntilTableNotExists({ client, maxWaitTime: 30 }, { TableName: tableName });
    }
    const cache = resolve(`.next-phase5b2-${run}`);
    if (existsSync(cache)) {
      assert.equal(realpathSync(cache), resolve(realpathSync("."), `.next-phase5b2-${run}`));
      rmSync(cache, { recursive: true, force: true });
    }
    console.log("Cleaned owned server, isolated table and test cache");
  } finally { client.destroy(); }
}
