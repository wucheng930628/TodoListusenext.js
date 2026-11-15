import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { captureWorkspaceBackup } from "../src/lib/client/workspace-backup.mjs";
import { sealBackup, verifyBackupArtifact } from "../src/lib/client/verified-backup.mjs";
import { migrationPlanV2, hash, restoreWorkspace } from "../src/lib/migration/plan-v2.mjs";
import { prepareDryRun } from "../src/lib/migration/dry-run.mjs";
import { createMigrationService } from "../src/lib/migration/service.mjs";
import { createMigrationApi } from "../src/lib/api/migrations.mjs";
import { MemoryClient } from "./helpers/memory-client.mjs";
import { workspaceFixture, storageFixture, createdAt } from "./phase4a-fixtures.mjs";

const sourceNamespace = "synthetic-source-review";
const policy = () => ({ primary: "slowly-workspace-v2", legacy: { source: "slowly-board-v1", action: "exclude", acknowledged: true } });
const options = sourcePolicy => ({ sourceNamespace, policies: { sourcePolicy } });
const sessionKey = id => `SLOWLY#MIGRATION_SESSION#${id}`;
const sha = value => createHash("sha256").update(value).digest("hex");

async function fixture(alter = () => {}) {
  const workspace = workspaceFixture();
  workspace.boards.forEach((board, index) => {
    board.tasks = Array.from({ length: 3 }, (_, n) => ({ ...structuredClone(board.tasks[0]), id: `primary-${index}-${n}`, subtasks: [] }));
    board.widgets = index === 0 ? [board.widgets[0]] : [];
  });
  const legacy = [{ id: "excluded-a", title: "synthetic legacy A", subtasks: [] }, { id: "excluded-b", title: "synthetic legacy B", subtasks: [] }];
  alter(workspace, legacy);
  const storage = storageFixture({ "slowly-workspace-v2": JSON.stringify(workspace), "slowly-board-v1": JSON.stringify(legacy) });
  const backup = captureWorkspaceBackup({ storage, createdAt });
  const artifact = await sealBackup(backup, "http://localhost:3000");
  const input = options(policy());
  const db = new MemoryClient(); const service = createMigrationService(db);
  const plan = () => migrationPlanV2(artifact, input);
  const register = () => { const p = plan(); return service.createSession(artifact, input, p.planId); };
  const apply = async () => { const p = plan(); await register(); for (const op of p.operations) await service.execute(p.planId, op.operationId, op.fingerprint); return p; };
  return { workspace, legacy, storage, backup, artifact, input, db, service, plan, register, apply };
}

test("multiple sources remain blocked in both core and strict preview without a policy", async () => {
  const f = await fixture();
  assert.throws(() => migrationPlanV2(f.backup, { sourceNamespace }), { code: "MULTIPLE_SOURCES_REQUIRE_REVIEW" });
  const preview = await prepareDryRun(f.artifact, { sourceNamespace });
  assert.equal(preview.valid, false); assert.ok(preview.report.blockers.some(issue => issue.code === "MULTIPLE_SOURCES_REQUIRE_REVIEW"));
  assert.equal(f.db.calls.length, 0);
});

test("explicit acknowledged exclusion retains all primary entities and no legacy operations", async () => {
  const f = await fixture(); const preview = await prepareDryRun(f.artifact, f.input);
  assert.equal(preview.valid, true);
  assert.deepEqual(preview.plan.counts, { workspaces: 1, boards: 2, tasks: 6, widgets: 1, subtasks: 0 });
  assert.equal(preview.plan.operations.length, 10);
  assert.deepEqual(preview.plan.operations.filter(op => op.type === "TASK").map(op => op.data.id), f.workspace.boards.flatMap(board => board.tasks.map(task => task.id)));
  assert.ok(preview.plan.operations.every(op => !JSON.stringify(op).includes("excluded-")));
  assert.deepEqual(preview.report.exclusionSummary.excluded, { tasks: 2, subtasks: 0, boards: 0, widgets: 0 });
  assert.deepEqual(preview.report.originalCounts, { workspaces: 1, boards: 2, tasks: 8, widgets: 1, subtasks: 0 });
});

test("missing/false acknowledgement, null policies and unrecognized actions cannot bypass review", async () => {
  const f = await fixture();
  for (const candidate of [null, {}, { ...policy(), legacy: { ...policy().legacy, acknowledged: false } },
    { ...policy(), legacy: { source: "slowly-board-v1", action: "exclude" } },
    { ...policy(), legacy: { ...policy().legacy, action: "ignore" } }]) {
    assert.throws(() => migrationPlanV2(f.artifact, options(candidate)), { code: "SOURCE_POLICY_INVALID" });
    assert.equal((await prepareDryRun(f.artifact, options(candidate))).valid, false);
  }
});

test("policy acknowledgement changes Plan and Operation IDs without changing target mappings", async () => {
  const f = await fixture(); const before = f.plan();
  const changed = policy(); changed.legacy.acknowledgementId = "review-2";
  const after = migrationPlanV2(f.artifact, options(changed));
  assert.notEqual(before.planId, after.planId);
  assert.notEqual(before.operations[0].operationId, after.operations[0].operationId);
  assert.deepEqual(before.operations.map(op => op.targetId), after.operations.map(op => op.targetId));
  assert.equal(hash(before.sourceIdentity), before.planId);
});

test("fingerprint, original raw legacy data and storage remain unchanged after repeated previews", async () => {
  const f = await fixture(); const original = JSON.stringify(f.artifact); const sources = JSON.stringify(f.backup.sources);
  const first = await prepareDryRun(f.artifact, f.input); const second = await prepareDryRun(f.artifact, f.input);
  assert.equal(first.plan.planId, second.plan.planId);
  assert.equal(first.report.backupFingerprint, sha(f.artifact.payload));
  assert.equal((await verifyBackupArtifact(f.artifact)).fingerprint, first.report.backupFingerprint);
  assert.equal(JSON.stringify(f.artifact), original); assert.equal(JSON.stringify(f.backup.sources), sources);
  assert.deepEqual(f.storage.writes, []); assert.equal(f.db.calls.length, 0);
});

test("summary is computed from actual sources; counts cannot be supplied by the caller", async () => {
  const f = await fixture((_, legacy) => { legacy[0].subtasks.push({ id: "legacy-sub", title: "synthetic", done: false }); });
  const summary = f.plan().sourceBinding.exclusionSummary;
  assert.deepEqual(summary.excluded, { tasks: 2, subtasks: 1, boards: 0, widgets: 0 });
  assert.equal(summary.sourceFingerprint, sha(f.backup.sources[1].raw));
  const invalid = policy(); invalid.legacy.excluded = { tasks: 0 };
  assert.throws(() => migrationPlanV2(f.artifact, options(invalid)), { code: "SOURCE_POLICY_INVALID" });
  const forged = structuredClone(f.artifact); const payload = JSON.parse(forged.payload); payload.backup.sources[1].summary.tasks = 0;
  forged.payload = JSON.stringify(payload); forged.integrity.fingerprint = sha(forged.payload);
  assert.throws(() => migrationPlanV2(forged, f.input), { code: "SUMMARY_MISMATCH" });
});

test("unselected source changes invalidate Plan and Operation IDs while selected source revision is unchanged", async () => {
  const f = await fixture(); const p = f.plan();
  const changedBackup = structuredClone(f.backup); changedBackup.sources[1].raw = changedBackup.sources[1].raw.replace("legacy A", "legacy C");
  const artifact = await sealBackup(changedBackup, "http://localhost:3000");
  const changed = migrationPlanV2(artifact, f.input);
  assert.equal(changed.sourceRevision, p.sourceRevision); assert.notEqual(changed.planId, p.planId);
  assert.notEqual(changed.sourceBinding.backupFingerprint, p.sourceBinding.backupFingerprint);
  assert.notEqual(changed.operations[0].operationId, p.operations[0].operationId);
});

test("full envelope and authentic fingerprint are required; inner backups cannot claim exclusion", async () => {
  const f = await fixture();
  assert.throws(() => migrationPlanV2(f.backup, f.input), { code: "SOURCE_POLICY_INVALID" });
  assert.throws(() => migrationPlanV2({ ...f.artifact, payload: `${f.artifact.payload} ` }, f.input), { code: "PREVIEW_INVALID" });
});

test("legacyBoard null and empty restoration objects do not substitute for exclusion", async () => {
  const f = await fixture();
  for (const legacyBoard of [null, {}]) {
    assert.throws(() => migrationPlanV2(f.backup, { sourceNamespace, policies: { legacyBoard } }), { code: "MULTIPLE_SOURCES_REQUIRE_REVIEW" });
    assert.throws(() => migrationPlanV2(f.artifact, { ...f.input, policies: { ...f.input.policies, legacyBoard } }), { code: "SOURCE_POLICY_INVALID" });
  }
});

test("exclusion cannot switch primary source or exclude unrelated keys", async () => {
  const f = await fixture();
  for (const candidate of [{ ...policy(), primary: "slowly-board-v1" }, { ...policy(), legacy: { ...policy().legacy, source: "other-key" } }]) {
    assert.throws(() => migrationPlanV2(f.artifact, options(candidate)), { code: "SOURCE_POLICY_INVALID" });
  }
  const changed = structuredClone(f.backup); changed.selectedSourceKey = "slowly-board-v1";
  assert.throws(() => migrationPlanV2(changed, f.input), { code: "SOURCE_POLICY_INVALID" });
});

test("unsupported schema in primary or excluded legacy still blocks", async () => {
  for (const alter of [(workspace) => { workspace.schemaVersion = 9; }, (_, legacy) => { legacy[0].schemaVersion = 9; },
    (_, legacy) => { legacy[0].subtasks.push({ id: "s", schemaVersion: 9 }); }]) {
    const f = await fixture(alter);
    assert.throws(() => f.plan(), { code: "UNSUPPORTED_SCHEMA" });
    assert.equal((await prepareDryRun(f.artifact, f.input)).valid, false);
  }
});

test("policy does not bypass duplicate IDs, parent mismatch, WIP, missing or unknown fields", async () => {
  for (const alter of [workspace => { workspace.boards[0].tasks[1].id = workspace.boards[0].tasks[0].id; },
    workspace => { workspace.boards[0].tasks[0].boardId = "foreign"; },
    workspace => { workspace.boards[0].wipLimit = 1; workspace.boards[0].tasks.forEach(task => { task.status = "doing"; }); },
    workspace => { delete workspace.boards[0].tasks[0].notes; },
    workspace => { workspace.boards[0].tasks[0].extension = { preserved: true }; }]) {
    const f = await fixture(alter); const preview = await prepareDryRun(f.artifact, f.input);
    assert.equal(preview.valid, false); assert.ok(preview.report.blockers.length > 0); assert.equal(f.db.calls.length, 0);
  }
});

test("Mock Session/Manifest/Receipt persist the same policy binding and resume safely", async () => {
  const f = await fixture(); const p = f.plan(); const s = await f.register();
  assert.deepEqual(s.sourceBinding, p.sourceBinding);
  for (const item of f.db.items.values()) if (["MIGRATION_SOURCE", "MIGRATION_MANIFEST", "MIGRATION_OPERATION"].includes(item.entityType)) {
    assert.equal(item.planId, p.planId); assert.equal(item.sourceBindingHash, hash(p.sourceBinding));
  }
  const restarted = createMigrationService(f.db);
  assert.equal((await restarted.createSession(f.artifact, f.input, p.planId)).migrationId, p.planId);
  const different = policy(); different.legacy.acknowledgementId = "new-review";
  await assert.rejects(restarted.createSession(f.artifact, options(different), p.planId), { code: "PLAN_CONFLICT" });
  const other = migrationPlanV2(f.artifact, options(different));
  await assert.rejects(restarted.createSession(f.artifact, options(different), other.planId), { code: "SOURCE_CONFLICT" });
  await assert.rejects(restarted.getOperation(p.planId, other.operations[0].operationId), { code: "NOT_FOUND" });
});

test("Verify excludes only reviewed legacy tasks and round-trips primary unknown fields", async () => {
  const f = await fixture(workspace => { workspace.boards[0].tasks[0].extension = { lawful: [true, 3] }; });
  const p = await f.apply(); const result = await f.service.verify(p.planId);
  assert.equal(result.valid, true); assert.equal(result.counts.tasks, 6);
  const items = [...f.db.items.values()].filter(item => item.migrationOwner);
  assert.deepEqual(restoreWorkspace(items), f.workspace);
  assert.equal(f.plan().sourceBinding.originalCounts.tasks, 8);
});

test("Verify detects missing primary data despite a valid legacy exclusion", async () => {
  const f = await fixture(); const p = await f.apply();
  f.db.items.delete(p.operations.find(op => op.type === "TASK").targetId);
  await assert.rejects(f.service.verify(p.planId), { code: "INTEGRITY_CONFLICT" });
});

test("source policy tampering invalidates Session before Verify/Release/Rollback", async () => {
  const f = await fixture(); const p = await f.apply(); const s = f.db.items.get(sessionKey(p.planId));
  s.policies.sourcePolicy.legacy.acknowledged = false;
  await assert.rejects(f.service.getSession(p.planId), { code: "INTEGRITY_CONFLICT" });
  await assert.rejects(f.service.verify(p.planId), { code: "INTEGRITY_CONFLICT" });
  await assert.rejects(f.service.releasePreview(p.planId, s.version), { code: "INTEGRITY_CONFLICT" });
  await assert.rejects(f.service.rollbackPreview(p.planId), { code: "INTEGRITY_CONFLICT" });
});

test("receipt and manifest source binding cannot be mixed with another policy", async () => {
  for (const type of ["MIGRATION_OPERATION", "MIGRATION_MANIFEST", "MIGRATION_SOURCE"]) {
    const f = await fixture(); const p = f.plan(); await f.register();
    const item = [...f.db.items.values()].find(item => item.entityType === type); item.sourceBindingHash = "0".repeat(64);
    await assert.rejects(f.service.getOperation(p.planId, p.operations[0].operationId), { code: "INTEGRITY_CONFLICT" });
  }
});

test("Mock rollback removes only actual migrated targets and preserves original/excluded sources and audit", async () => {
  const f = await fixture(); const original = JSON.stringify(f.artifact); const p = await f.apply();
  f.db.items.set("unrelated", { id: "unrelated", data: "untouched" });
  const preview = await f.service.rollbackPreview(p.planId);
  assert.equal(preview.canRollback, true); assert.equal(preview.deletable.length, 10);
  assert.ok(preview.deletable.every(item => p.operations.some(op => op.targetId === item.targetId)));
  for (let i = 0; i <= p.operations.length + 1; i++) {
    const session = await f.service.getSession(p.planId); if (session.state === "ROLLED_BACK") break;
    await f.service.rollback(p.planId, session.version, p.planId);
  }
  assert.equal((await f.service.getSession(p.planId)).state, "ROLLED_BACK");
  assert.ok(f.db.items.has("unrelated")); assert.equal([...f.db.items.values()].filter(item => item.migrationOwner).length, 0);
  assert.equal(JSON.stringify(f.artifact), original); assert.deepEqual(f.storage.writes, []);
  assert.equal((await f.service.getOperation(p.planId, p.operations[0].operationId)).state, "ROLLED_BACK");
});

test("single-source legacy Plan v2 identity remains backward compatible", async () => {
  const f = await fixture(); const backup = structuredClone(f.backup); backup.sources.pop();
  const p = migrationPlanV2(backup, { sourceNamespace });
  const identity = { formatVersion: 2, schemaVersion: 1, sourceNamespace, sourceRevision: p.sourceRevision, policies: p.policies,
    operations: p.operations.map(op => [op.key, op.fingerprint]) };
  assert.equal(p.planId, hash(identity)); assert.equal(p.schemaVersion, 1); assert.equal(p.sourceBinding, undefined);
});

test("Migration API accepts explicit policy and verified envelope without accessing a database for Preview", async () => {
  const f = await fixture(); let calls = 0;
  const api = createMigrationApi({ getService: async () => { calls++; return f.service; }, configuration: () => ({ NODE_ENV: "development", SLOWLY_LOCAL_API: "1" }) });
  const request = data => new Request("http://127.0.0.1:3000/api/migrations/preview", { method: "POST", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" }, body: JSON.stringify(data) });
  const result = await api.preview(request({ backup: f.artifact, ...f.input }));
  assert.equal(result.status, 200); const body = await result.json();
  assert.deepEqual(body.data.sourceBinding.exclusionSummary.excluded, { tasks: 2, subtasks: 0, boards: 0, widgets: 0 });
  assert.equal(body.data.planId, f.plan().planId); assert.equal(calls, 0);
  assert.equal((await api.preview(request({ backup: f.backup, sourceNamespace }))).status, 422);
  const invalid = policy(); invalid.legacy.acknowledged = false;
  assert.equal((await api.preview(request({ backup: f.artifact, ...options(invalid) }))).status, 422);
});
