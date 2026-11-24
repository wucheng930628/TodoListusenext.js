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
      SLOWLY_PHASE5_B1_PLAN: migrationId, SLOWLY_PHASE5_B1_SOURCE_NAMESPACE: sourceNamespace },
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
    const after = Promise.withResolvers();
    proxy = createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const upstream = await fetch(`${origin}/api/tasks`, { method: "POST", body: Buffer.concat(chunks),
          headers: { origin, "content-type": "application/json", "idempotency-key": request.headers["idempotency-key"] },
          signal: AbortSignal.timeout(10000) });
        after.resolve({ status: upstream.status, body: await upstream.json() });
        // Deliberately withhold the server reply until the client aborts.
      } catch (error) { after.reject(error); response.destroy(); }
    });
    const proxyPort = await listen(proxy);
    const recoverApi = createSlowlyApi({ fetchImpl: (path, options) => fetch((options.method === "POST" ? `http://127.0.0.1:${proxyPort}` : origin) + path, options) });
    const original = { ...input, position: 1, data: { ...input.data, id: "timeout", status: "todo" } };
    const intent = createSafeCreateIntent(recoverApi, "tasks", original, { operationKey: randomUUID() });
    await assert.rejects(intent.send({ timeoutMs: 1500 }), { code: "TIMEOUT", outcome: "not-confirmed" });
    const committed = await after.promise;
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
  console.log(`HTTP integration: ${passed}/${passed} scenario groups passed`);
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  try {
    if (proxy) await close(proxy);
    if (child?.pid && child.exitCode === null) {
      const stopped = once(child, "exit");
      if (process.platform === "win32") {
        const stopTree = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        const [code] = await once(stopTree, "exit");
        assert.equal(code, 0, "Unable to stop owned Next.js process");
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
