import test from "node:test";
import assert from "node:assert/strict";
import { captureWorkspaceBackup } from "../src/lib/client/workspace-backup.mjs";
import { previewMigration, prepareMigration, createMigrationCheckpoint, recordMigrationOutcome, reconcileMigration, migrationProgress, verifyMigration } from "../src/lib/migration/preparation.mjs";
import { workspaceFixture, storageFixture, createdAt, namespace } from "./phase4a-fixtures.mjs";

function backup(data = workspaceFixture(), key = "slowly-workspace-v2") { return captureWorkspaceBackup({ storage: storageFixture({ [key]: JSON.stringify(data) }), createdAt }); }
const prepare = (data = workspaceFixture()) => prepareMigration(backup(data), { sourceNamespace: namespace });
const receipt = (plan, operation, version = 1) => ({ ...structuredClone(operation), state: "present", planId: plan.planId, version });

test("preview reuses shared schema, preserves unknown fields, counts and ordered parent-scoped mappings", () => {
  const data = workspaceFixture(); data.future = { value: "preserve" }; data.boards[0].tasks[0].extra = { nested: true };
  const before = structuredClone(data);
  const result = previewMigration(backup(data), { sourceNamespace: namespace });
  assert.equal(result.modelValid, true); assert.equal(result.executable, false);
  assert.deepEqual(result.counts, { workspaces: 1, boards: 2, tasks: 3, subtasks: 3, widgets: 3 });
  assert.equal(result.entities.length, 9); assert.equal(new Set(result.entities.map(item => item.targetId)).size, 9);
  assert.equal(result.subtasks.length, 3);
  assert.deepEqual(result.entities.find(item => item.type === "WORKSPACE").data.future, data.future);
  assert.deepEqual(result.entities.find(item => item.type === "TASK").data.extra, { nested: true });
  const a = result.entities.filter(item => item.type === "TASK" && item.data.id === "task-a");
  assert.equal(a.length, 2); assert.notEqual(a[0].targetId, a[1].targetId);
  assert.ok(result.issues.some(item => item.code === "API_FIELD_UNSUPPORTED" && item.path.endsWith("completedAt")));
  for (const entity of result.entities) {
    if (entity.parentId) assert.ok(result.entities.some(parent => parent.targetId === entity.parentId));
    assert.match(entity.targetId, /^SLOWLY#(WORKSPACE|BOARD|TASK|WIDGET)#[a-f0-9-]{36}$/);
  }
  assert.deepEqual(result.entities.filter(item => item.type === "BOARD").map(item => item.position), [0, 1]);
  assert.deepEqual(result.entities.filter(item => item.type === "TASK" && item.parentId === a[0].parentId).map(item => item.position), [0, 1]);
  assert.deepEqual(data, before);
});

test("duplicates, invalid schema, parent mismatch, WIP and missing active board block preparation", () => {
  const mutations = [
    data => { data.boards[1].id = data.boards[0].id; },
    data => { data.boards[0].tasks[1].id = data.boards[0].tasks[0].id; },
    data => { data.boards[0].widgets[1].id = data.boards[0].widgets[0].id; },
    data => { data.boards[0].tasks[0].subtasks.push({ ...data.boards[0].tasks[0].subtasks[0] }); },
    data => { data.boards[0].tasks[0].boardId = "wrong-board"; },
    data => { data.boards[0].workspaceId = "wrong-workspace"; },
    data => { data.boards[0].widgets[0].boardId = "wrong-board"; },
    data => { data.boards[0].tasks[0].date = "2026-02-30"; },
    data => { data.boards[0].widgets[0].height = 260.5; },
    data => { data.boards[0].tasks[0].completedAt = "2026-11-01T00:00:00.000Z"; },
    data => { data.activeBoardId = "missing"; },
    data => { data.boards[0].wipLimit = 1; data.boards[0].tasks.forEach(task => { task.status = "doing"; }); },
    data => { data.boards[0].tasks = null; },
    data => { data.boards[0].tasks[0].largeNumber = 9007199254740992; },
  ];
  for (const mutate of mutations) {
    const data = workspaceFixture(); mutate(data);
    const result = previewMigration(backup(data), { sourceNamespace: namespace });
    assert.equal(result.modelValid, false); assert.ok(result.issues.some(item => item.severity === "error"));
    assert.throws(() => prepare(data), { code: "PREVIEW_INVALID" });
  }
});

test("legacy needs explicit settings; empty and invalid backups are not auto-seeded", () => {
  const old = backup(workspaceFixture().boards[0].tasks, "slowly-board-v1");
  assert.equal(previewMigration(old, { sourceNamespace: namespace }).issues[0].code, "LEGACY_BOARD_METADATA_REQUIRED");
  const preview = previewMigration(old, { sourceNamespace: namespace, legacyBoard: { id: "legacy", name: "已確認看板", description: "", wipLimit: 4 } });
  assert.equal(preview.modelValid, true); assert.equal(preview.counts.tasks, 2);
  assert.equal(preview.counts.boards, 1);
  assert.equal(previewMigration(backup({ activeBoardId: "", boards: [] }), { sourceNamespace: namespace }).modelValid, false);
  assert.throws(() => previewMigration({ ...old, formatVersion: 9 }, { sourceNamespace: namespace }), { code: "UNSUPPORTED_VERSION" });
  assert.throws(() => previewMigration(old), { code: "INVALID_STATE" });
});

test("implicit widgets, dangling timer references and extra position values are reported without mutation", () => {
  const data = workspaceFixture(); delete data.boards[1].widgets;
  data.boards[0].widgets[0] = { id: "timer", type: "timer", span: 6, height: 260, config: { taskId: "missing", minutes: 25 } };
  data.boards[0].tasks[0].position = 77;
  const preview = previewMigration(backup(data), { sourceNamespace: namespace });
  assert.equal(preview.modelValid, true);
  for (const code of ["IMPLICIT_WIDGETS", "DANGLING_TIMER_TASK", "POSITION_DIFFERS_FROM_ARRAY"]) assert.ok(preview.issues.some(item => item.code === code));
  assert.equal(preview.entities.find(item => item.type === "BOARD" && item.data.id === "board-b").source.widgetsPresent, false);
  const task = preview.entities.find(item => item.type === "TASK");
  assert.equal(task.position, 0); assert.equal(task.data.position, 77);
});

test("stable mapping survives repeated exports, content edits and reordering; changed source cannot reuse a checkpoint", () => {
  const source = backup(); const a = prepareMigration(source, { sourceNamespace: namespace });
  const b = prepareMigration({ ...source, createdAt: "2026-11-15T02:00:00.000Z" }, { sourceNamespace: namespace });
  assert.deepEqual(a, b);
  const data = workspaceFixture(); data.boards[0].tasks.reverse(); data.boards[0].name = "新名稱";
  const changed = prepare(data);
  const original = new Map(a.operations.map(item => [item.key, item.targetId]));
  for (const item of changed.operations) assert.equal(item.targetId, original.get(item.key));
  assert.notEqual(changed.planId, a.planId);
  assert.throws(() => migrationProgress(changed, createMigrationCheckpoint(a)), { code: "INVALID_STATE" });
  const otherSource = prepareMigration(source, { sourceNamespace: "different-device" });
  assert.notEqual(otherSource.operations[0].targetId, a.operations[0].targetId);
});

// A hypothetical FUTURE atomic migration service, available only inside tests.
// It is intentionally not wired to today's POST APIs or DynamoDB.
class MockMigrationService {
  records = new Map();
  writes = 0;
  createIfAbsent(plan, operation) {
    const existing = this.records.get(operation.targetId);
    if (existing) {
      if (existing.operationId !== operation.operationId || existing.planId !== plan.planId) throw new Error("VERSION_CONFLICT");
      return structuredClone(existing);
    }
    if (operation.parentId) assert.ok(this.records.has(operation.parentId));
    const value = receipt(plan, operation); this.records.set(operation.targetId, value); this.writes++;
    return structuredClone(value);
  }
  observations(plan) { return plan.operations.map(operation => this.records.has(operation.targetId) ? structuredClone(this.records.get(operation.targetId)) : { key: operation.key, state: "absent" }); }
}

test("partial writes and lost network responses recover by receipts; repeated runs do not duplicate mock records", () => {
  const plan = prepare(); const service = new MockMigrationService(); const original = { id: "manual", data: "unchanged" };
  service.records.set("manual", original);
  let checkpoint = createMigrationCheckpoint(plan);
  // Commit succeeds but the response is lost.
  checkpoint = recordMigrationOutcome(plan, checkpoint, plan.operations[0].key, { state: "in-flight" });
  service.createIfAbsent(plan, plan.operations[0]);
  checkpoint = recordMigrationOutcome(plan, checkpoint, plan.operations[0].key, { state: "unknown", errorCode: "NETWORK_ERROR" });
  assert.throws(() => recordMigrationOutcome(plan, checkpoint, plan.operations[0].key, { state: "in-flight" }), { code: "INVALID_STATE" });
  checkpoint = reconcileMigration(plan, checkpoint, service.observations(plan));
  assert.equal(migrationProgress(plan, checkpoint).states.confirmed, 1);
  // Next request provably failed before commit. No data is guessed or overwritten.
  checkpoint = recordMigrationOutcome(plan, checkpoint, plan.operations[1].key, { state: "in-flight" });
  checkpoint = recordMigrationOutcome(plan, checkpoint, plan.operations[1].key, { state: "failed", errorCode: "ATOMIC_REJECTION" });
  checkpoint = reconcileMigration(plan, checkpoint, service.observations(plan));
  for (const operation of plan.operations.slice(1)) service.createIfAbsent(plan, operation);
  checkpoint = reconcileMigration(plan, checkpoint, service.observations(plan));
  for (const operation of plan.operations) service.createIfAbsent(plan, operation);
  const verification = verifyMigration(plan, checkpoint, service.observations(plan));
  assert.equal(verification.valid, true); assert.equal(verification.progress.percent, 100);
  assert.deepEqual(verification.expectedCounts, verification.observedCounts); assert.equal(verification.relationsValid, true);
  assert.equal(verification.progress.executable, false);
  assert.equal(service.writes, plan.operations.length); assert.equal(service.records.size, plan.operations.length + 1);
  assert.deepEqual(service.records.get("manual"), original);
});

test("version conflicts, pre-existing targets and missing parents cannot be silently accepted or overwritten", () => {
  const plan = prepare(); let checkpoint = createMigrationCheckpoint(plan); const operation = plan.operations[0];
  checkpoint = reconcileMigration(plan, checkpoint, [receipt(plan, operation)]);
  const changedVersion = receipt(plan, operation, 2);
  const conflict = reconcileMigration(plan, checkpoint, [changedVersion]);
  assert.equal(migrationProgress(plan, conflict).states.conflict, 1);
  assert.throws(() => recordMigrationOutcome(plan, conflict, operation.key, { state: "in-flight" }), { code: "INVALID_STATE" });
  const existing = { ...receipt(plan, operation), operationId: "someone-else", data: { original: true } };
  const service = new MockMigrationService(); service.records.set(operation.targetId, existing);
  assert.throws(() => service.createIfAbsent(plan, operation));
  assert.deepEqual(service.records.get(operation.targetId), existing);
  const foreign = reconcileMigration(plan, createMigrationCheckpoint(plan), [existing]);
  assert.equal(migrationProgress(plan, foreign).states.conflict, 1);
  const deleted = reconcileMigration(plan, checkpoint, [{ key: operation.key, state: "absent" }]);
  assert.equal(migrationProgress(plan, deleted).states.conflict, 1);
  assert.equal(verifyMigration(plan, checkpoint, []).valid, false);
  assert.throws(() => reconcileMigration(plan, checkpoint, [{ key: "unknown", state: "present" }]), { code: "INVALID_STATE" });
  const tampered = structuredClone(plan); tampered.operations[1].parentId = "wrong";
  assert.throws(() => createMigrationCheckpoint(tampered), { code: "INVALID_STATE" });
});

test("missing or ambiguous receipts never prove absence and payload/position tampering is rejected", () => {
  const plan = prepare(); const operation = plan.operations[0];
  let checkpoint = createMigrationCheckpoint(plan);
  checkpoint = recordMigrationOutcome(plan, checkpoint, operation.key, { state: "in-flight" });
  checkpoint = recordMigrationOutcome(plan, checkpoint, operation.key, { state: "unknown" });
  const unchanged = reconcileMigration(plan, checkpoint, []);
  assert.equal(unchanged.entries[0].state, "unknown");
  const edited = receipt(plan, operation); edited.position = 10;
  assert.equal(reconcileMigration(plan, checkpoint, [edited]).entries[0].state, "conflict");
  const invalidPlan = structuredClone(plan); invalidPlan.operations[0].data.custom = true;
  assert.throws(() => createMigrationCheckpoint(invalidPlan), { code: "INVALID_STATE" });
  const badCounts = structuredClone(plan); badCounts.counts.tasks++;
  assert.throws(() => createMigrationCheckpoint(badCounts), { code: "INVALID_STATE" });
});
