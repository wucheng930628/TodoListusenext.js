import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MemoryClient } from "./helpers/memory-client.mjs";
import { workspaceFixture, storageFixture, createdAt } from "./phase4a-fixtures.mjs";
import { captureWorkspaceBackup } from "../src/lib/client/workspace-backup.mjs";
import { createMigrationService } from "../src/lib/migration/service.mjs";
import { createMigrationApi } from "../src/lib/api/migrations.mjs";
import { createRepository } from "../src/lib/slowly-repository.mjs";
import { createApi } from "../src/lib/api/handlers.mjs";
import { hash } from "../src/lib/migration/plan-v2.mjs";

const origin = "http://127.0.0.1:3000";
const development = { NODE_ENV: "development", SLOWLY_LOCAL_API: "1" };
function fixture(configuration = development) {
  const db = new MemoryClient(); const service = createMigrationService(db); let serviceCalls = 0;
  const api = createMigrationApi({ getService: async () => { serviceCalls++; return service; }, configuration: () => configuration });
  const backup = captureWorkspaceBackup({ storage: storageFixture({ "slowly-workspace-v2": JSON.stringify(workspaceFixture()) }), createdAt });
  const input = { backup, sourceNamespace: `api-${randomUUID()}` };
  async function call(handler, { method = "POST", migrationId, operationId, input: data, query = "", raw, headers = {} } = {}) {
    const request = new Request(`${origin}/api/migrations${migrationId ? `/${migrationId}` : ""}${query}`, {
      method, headers: { host: "127.0.0.1:3000", origin, ...(data === undefined && raw === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(data === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(data) }),
    });
    const response = await api[handler](request, { params: Promise.resolve({ migrationId, operationId }) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  async function register() {
    const preview = await call("preview", { input }); assert.equal(preview.status, 200);
    const created = await call("create", { input: { ...input, expectedPlanId: preview.body.data.planId } }); assert.equal(created.status, 201);
    return { preview: preview.body.data, session: created.body.data };
  }
  return { db, service, api, call, input, register, serviceCalls: () => serviceCalls };
}

test("all nine migration endpoints use the real service/repository model, status codes and safe audit cleanup", async () => {
  const f = fixture(); const original = { id: "manual-before-api", title: "unchanged" }; f.db.items.set(original.id, original);
  const beforePreview = hash([...f.db.items]);
  const preview = await f.call("preview", { input: f.input });
  assert.equal(preview.status, 200); assert.equal(f.serviceCalls(), 0); assert.equal(hash([...f.db.items]), beforePreview);
  const plan = preview.body.data; const id = plan.migrationId;
  const created = await f.call("create", { input: { ...f.input, expectedPlanId: plan.planId } });
  assert.equal(created.status, 201); assert.equal(created.body.data.state, "READY");
  assert.equal((await f.call("create", { input: { ...f.input, expectedPlanId: plan.planId } })).status, 200);
  assert.equal((await f.call("get", { method: "GET", migrationId: id })).status, 200);
  const page = await f.call("list", { method: "GET", migrationId: id, query: "?limit=2" });
  assert.equal(page.status, 200); assert.equal(page.body.data.items.length, 2); assert.equal(page.body.data.nextCursor, "2");
  for (const op of plan.operations) {
    const pending = await f.call("operation", { method: "GET", migrationId: id, operationId: op.operationId }); assert.equal(pending.body.data.state, "PENDING");
    assert.equal("operation" in pending.body.data, false);
    const applied = await f.call("execute", { method: "PUT", migrationId: id, operationId: op.operationId, input: { expectedPayloadFingerprint: op.fingerprint } });
    assert.equal(applied.status, 201); assert.equal(applied.body.data.state, "CONFIRMED");
    const repeated = await f.call("execute", { method: "PUT", migrationId: id, operationId: op.operationId, input: { expectedPayloadFingerprint: op.fingerprint } });
    assert.equal(repeated.status, 200); assert.equal(repeated.body.data.replayed, true);
  }
  const verified = await f.call("verify", { migrationId: id, input: {} });
  assert.equal(verified.status, 200); assert.equal(verified.body.data.valid, true);
  const rollbackPreview = await f.call("rollbackPreview", { migrationId: id, input: {} });
  assert.equal(rollbackPreview.body.data.canRollback, true);
  for (let attempt = 0; attempt <= plan.operations.length; attempt++) {
    const session = (await f.call("get", { method: "GET", migrationId: id })).body.data;
    const result = await f.call("rollback", { migrationId: id, input: { expectedSessionVersion: session.version, confirmation: id } });
    assert.equal(result.status, 200);
  }
  assert.equal((await f.service.getSession(id)).state, "ROLLED_BACK");
  assert.deepEqual(f.db.items.get(original.id), original);
  assert.equal([...f.db.items.values()].filter(item => ["WORKSPACE", "BOARD", "TASK", "WIDGET"].includes(item.entityType)).length, 0);
  assert.equal(f.db.calls.some(call => call.type === "ScanCommand"), false);
});

test("HTTP response loss is resolved through server receipt and replay", async () => {
  const f = fixture(); const { preview } = await f.register(); const op = preview.operations[0];
  await assert.rejects((async () => {
    const result = await f.call("execute", { method: "PUT", migrationId: preview.migrationId, operationId: op.operationId, input: { expectedPayloadFingerprint: op.fingerprint } });
    assert.equal(result.status, 201); throw new Error("simulated HTTP response lost");
  })());
  const read = await f.call("operation", { method: "GET", migrationId: preview.migrationId, operationId: op.operationId });
  assert.equal(read.body.data.state, "CONFIRMED");
  const replay = await f.call("execute", { method: "PUT", migrationId: preview.migrationId, operationId: op.operationId, input: { expectedPayloadFingerprint: op.fingerprint } });
  assert.equal(replay.status, 200); assert.equal(replay.body.data.replayed, true);
  assert.equal((await f.service.getSession(preview.migrationId)).confirmedCount, 1);
});

test("migration lock uses existing CRUD error envelope and leaves ordinary DTO contract unchanged", async () => {
  const f = fixture(); const { preview } = await f.register();
  const op = preview.operations[0]; await f.service.execute(preview.migrationId, op.operationId, op.fingerprint);
  const workspaceApi = createApi("workspaces", { getRepository: async () => createRepository(f.db), configuration: () => development });
  const result = await workspaceApi.itemPatch(new Request(`${origin}/api/workspaces/${encodeURIComponent(op.targetId)}`, {
    method: "PATCH", headers: { host: "127.0.0.1:3000", origin, "content-type": "application/json" }, body: JSON.stringify({ version: 1, data: { settings: {} } }),
  }), { params: Promise.resolve({ id: op.targetId }) });
  assert.equal(result.status, 409); assert.equal((await result.json()).error.code, "MIGRATION_LOCKED");
});

test("server rejects forged fields, fingerprints, plan IDs, malformed data, schema versions and body size", async () => {
  const f = fixture();
  for (const input of [{ ...f.input, manifest: [] }, { ...f.input, TableName: "other" }, { ...f.input, sourceNamespace: "short" }, { ...f.input, policies: { timer: "reset" } }]) assert.equal((await f.call("preview", { input })).status, 400);
  for (const raw of ["{", "[]", "null"]) assert.equal((await f.call("preview", { raw })).status, 400);
  const invalidSchema = structuredClone(f.input); const data = JSON.parse(invalidSchema.backup.sources[0].raw); data.schemaVersion = 99;
  invalidSchema.backup.sources[0].raw = JSON.stringify(data);
  const invalid = await f.call("preview", { input: invalidSchema }); assert.equal(invalid.status, 422);
  assert.ok(invalid.body.error.issues.some(issue => issue.code === "UNSUPPORTED_SCHEMA_VERSION"));
  const big = await f.call("preview", { raw: JSON.stringify({ extra: "x".repeat(2097152) }) }); assert.equal(big.status, 413);
  assert.equal((await f.call("get", { method: "GET", migrationId: "invalid" })).status, 400);
  assert.equal((await f.call("get", { method: "GET", migrationId: "0".repeat(64) })).status, 404);
  assert.equal((await f.call("create", { input: { ...f.input, expectedPlanId: "0".repeat(64) } })).status, 409);
  const { preview } = await f.register(); const id = preview.migrationId; const op = preview.operations[0];
  const before = hash([...f.db.items]);
  const mismatch = await f.call("execute", { method: "PUT", migrationId: id, operationId: op.operationId, input: { expectedPayloadFingerprint: "0".repeat(64) } });
  assert.equal(mismatch.status, 409); assert.equal(mismatch.body.error.code, "IDEMPOTENCY_KEY_REUSE");
  assert.equal(hash([...f.db.items]), before);
  assert.equal((await f.call("execute", { method: "PUT", migrationId: id, operationId: op.operationId, input: { expectedPayloadFingerprint: op.fingerprint, targetId: "arbitrary" } })).status, 400);
  assert.equal((await f.call("list", { method: "GET", migrationId: id, query: "?cursor=garbage" })).status, 400);
  assert.equal((await f.call("rollback", { migrationId: id, input: { expectedSessionVersion: 1, confirmation: "wrong" } })).status, 400);
});

test("cross-session references are denied and local-only/Origin checks run before data access", async () => {
  const f = fixture(); const { preview } = await f.register();
  const otherInput = { ...f.input, sourceNamespace: `other-${randomUUID()}` };
  const otherPlan = (await f.call("preview", { input: otherInput })).body.data;
  await f.call("create", { input: { ...otherInput, expectedPlanId: otherPlan.planId } });
  const cross = await f.call("execute", { method: "PUT", migrationId: preview.migrationId, operationId: otherPlan.operations[0].operationId, input: { expectedPayloadFingerprint: otherPlan.operations[0].fingerprint } });
  assert.equal(cross.status, 404);
  const production = fixture({ NODE_ENV: "production", SLOWLY_LOCAL_API: "1" });
  assert.equal((await production.call("create", { input: production.input })).status, 403); assert.equal(production.serviceCalls(), 0);
  for (const headers of [{ host: "evil.example" }, { origin: "http://evil.example" }, { "x-forwarded-for": "203.0.113.2" }, { "sec-fetch-site": "cross-site" }]) assert.equal((await f.call("preview", { input: f.input, headers })).status, 403);
});

test("database outage never leaks SDK error details or fabricates a receipt", async () => {
  const f = fixture(); const { preview } = await f.register();
  f.db.beforeTransaction = () => { throw new Error("sensitive SDK diagnostic"); };
  const op = preview.operations[0];
  const result = await f.call("execute", { method: "PUT", migrationId: preview.migrationId, operationId: op.operationId, input: { expectedPayloadFingerprint: op.fingerprint } });
  assert.equal(result.status, 500); assert.equal(result.body.error.code, "INTERNAL");
  assert.equal(JSON.stringify(result.body).includes("sensitive SDK diagnostic"), false);
  assert.equal((await f.service.getOperation(preview.migrationId, op.operationId)).state, "PENDING");
});
