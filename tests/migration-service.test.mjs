import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MemoryClient } from "./helpers/memory-client.mjs";
import { workspaceFixture, storageFixture, createdAt } from "./phase4a-fixtures.mjs";
import { captureWorkspaceBackup } from "../src/lib/client/workspace-backup.mjs";
import { migrationPlanV2, hash, restoreWorkspace } from "../src/lib/migration/plan-v2.mjs";
import { createMigrationService } from "../src/lib/migration/service.mjs";
import { createRepository } from "../src/lib/slowly-repository.mjs";
import { prepareMigration, createMigrationCheckpoint } from "../src/lib/migration/preparation.mjs";

export function migrationFixture(data = workspaceFixture(), configuration = {}) {
  const db = new MemoryClient(); const options = { sourceNamespace: `test-${randomUUID()}` };
  const backup = captureWorkspaceBackup({ storage: storageFixture({ "slowly-workspace-v2": JSON.stringify(data) }), createdAt });
  const plan = migrationPlanV2(backup, options);
  const service = createMigrationService(db, configuration); const repository = createRepository(db);
  async function register() {
    for (let i = 0; i <= plan.operations.length + 1; i++) {
      const session = await service.createSession(backup, options, plan.planId);
      if (session.state !== "PREPARING") return session;
    }
    assert.fail("Registration did not finish");
  }
  async function apply() { await register(); for (const op of plan.operations) await service.execute(plan.migrationId, op.operationId, op.fingerprint); }
  async function undo() {
    for (let i = 0; i < plan.operations.length + 3; i++) {
      const session = await service.getSession(plan.migrationId);
      if (session.state === "ROLLED_BACK") return session;
      await service.rollback(plan.migrationId, session.version, plan.migrationId);
    }
    assert.fail("Rollback did not finish");
  }
  return { db, data, options, backup, plan, service, repository, register, apply, undo };
}

test("atomic receipt and target writes; duplicate operations and parallel submissions count exactly once", async () => {
  const f = migrationFixture(); await f.register();
  const root = f.plan.operations[0];
  const results = await Promise.all(Array.from({ length: 5 }, () => f.service.execute(f.plan.migrationId, root.operationId, root.fingerprint)));
  assert.equal(results.filter(result => !result.replayed).length, 1);
  const board = f.plan.operations.find(op => op.type === "BOARD"); await f.service.execute(f.plan.migrationId, board.operationId, board.fingerprint);
  const siblings = f.plan.operations.filter(op => op.parentId === board.targetId);
  await Promise.all(siblings.map(op => f.service.execute(f.plan.migrationId, op.operationId, op.fingerprint)));
  const parent = await f.repository.getBoard(board.targetId);
  assert.deepEqual([parent.taskCount, parent.widgetCount], [2, 2]);
  assert.equal((await f.service.getSession(f.plan.migrationId)).confirmedCount, 2 + siblings.length);
  for (const call of f.db.calls.filter(call => call.type === "TransactWriteCommand")) {
    const items = call.input.TransactItems;
    assert.ok(items.length <= 100); assert.ok(Buffer.byteLength(JSON.stringify(items)) < 3500000);
    for (const action of items.filter(action => action.Put?.Item.migrationOwner)) {
      assert.ok(items.some(other => other.Put?.Item.entityType === "MIGRATION_OPERATION" && other.Put.Item.state === "CONFIRMED"));
    }
  }
});

test("same operation with different payload fingerprint is rejected without poisoning the original receipt", async () => {
  const f = migrationFixture(); await f.register(); const op = f.plan.operations[0];
  const before = hash([...f.db.items]);
  await assert.rejects(f.service.execute(f.plan.migrationId, op.operationId, "0".repeat(64)), { code: "IDEMPOTENCY_KEY_REUSE" });
  assert.equal(hash([...f.db.items]), before);
  await f.service.execute(f.plan.migrationId, op.operationId, op.fingerprint);
  const after = hash([...f.db.items]);
  await assert.rejects(f.service.execute(f.plan.migrationId, op.operationId, "f".repeat(64)), { code: "IDEMPOTENCY_KEY_REUSE" });
  assert.equal(hash([...f.db.items]), after);
});

test("response lost after commit resumes from persisted receipt and never double-counts", async () => {
  const f = migrationFixture(); await f.register(); const op = f.plan.operations[0];
  f.db.afterTransaction = input => {
    if (input.TransactItems.some(action => action.Put?.Item.id === op.targetId)) { f.db.afterTransaction = null; throw new Error("response lost"); }
  };
  await assert.rejects(f.service.execute(f.plan.migrationId, op.operationId, op.fingerprint), { code: "STORAGE" });
  const restarted = createMigrationService(f.db);
  assert.equal((await restarted.getOperation(f.plan.migrationId, op.operationId)).state, "CONFIRMED");
  assert.equal((await restarted.execute(f.plan.migrationId, op.operationId, op.fingerprint)).replayed, true);
  assert.equal((await restarted.getSession(f.plan.migrationId)).confirmedCount, 1);
  assert.equal(f.db.items.get(op.targetId).migrationLock, true);
});

test("partial manifest registration and partial execution resume without client checkpoint", async () => {
  const f = migrationFixture(undefined, { registrationBudget: 2 });
  const first = await f.service.createSession(f.backup, f.options, f.plan.planId);
  assert.equal(first.state, "PREPARING"); assert.equal(first.registeredCount, 2);
  const restarted = createMigrationService(f.db);
  assert.equal((await restarted.createSession(f.backup, f.options, f.plan.planId)).state, "READY");
  await f.service.execute(f.plan.migrationId, f.plan.operations[0].operationId, f.plan.operations[0].fingerprint);
  for (const op of f.plan.operations.slice(1)) await restarted.execute(f.plan.migrationId, op.operationId, op.fingerprint);
  assert.equal((await restarted.verify(f.plan.migrationId)).valid, true);
  const page = await restarted.listOperations(f.plan.migrationId, { cursor: 0, limit: 2 });
  assert.equal(page.items.length, 2); assert.equal(page.nextCursor, "2");
});

test("Plan v2 preserves completedAt, absent fields/widgets, timer absolute time, extras and order", async () => {
  const data = workspaceFixture(); data.schemaVersion = 1; data.extra = { object: ["保留", 12] };
  data.boards[0].tasks[0].status = "done"; data.boards[0].tasks[0].completedAt = "2024-01-02T03:04:05.000Z";
  data.boards[0].tasks[0].unknown = { nested: true }; delete data.boards[0].tasks[1].notes;
  delete data.boards[1].widgets;
  data.boards[0].widgets[0] = { id: "timer", type: "timer", span: 6, height: 260, config: { taskId: "task-a", minutes: 25, endsAt: 1760000000000, remaining: null, custom: "kept" } };
  const f = migrationFixture(data); await f.apply();
  const result = await f.service.verify(f.plan.migrationId);
  assert.equal(result.valid, true);
  const items = f.plan.operations.map(op => f.db.items.get(op.targetId));
  assert.deepEqual(restoreWorkspace(items), data);
  assert.equal(Object.hasOwn(restoreWorkspace(items).boards[1], "widgets"), false);
  assert.equal(items.find(item => item.entityType === "TASK" && item.data.status === "done").data.completedAt, data.boards[0].tasks[0].completedAt);
  assert.equal((await f.service.getSession(f.plan.migrationId)).lockState, "HELD");
});

test("unsupported schemas, legacy settings and Widget presence tampering are blocked", async () => {
  const data = workspaceFixture(); data.schemaVersion = 99;
  assert.throws(() => migrationFixture(data), { code: "PREVIEW_INVALID" });
  const f = migrationFixture();
  const oldPlan = prepareMigration(f.backup, { sourceNamespace: f.options.sourceNamespace });
  oldPlan.operations.find(op => op.type === "BOARD").source.widgetsPresent = false;
  assert.throws(() => createMigrationCheckpoint(oldPlan), { code: "INVALID_STATE" });
  const legacy = captureWorkspaceBackup({ storage: storageFixture({ "slowly-board-v1": JSON.stringify(data.boards[0].tasks) }), createdAt });
  assert.throws(() => migrationPlanV2(legacy, f.options), { code: "PREVIEW_INVALID" });
  const accepted = migrationPlanV2(legacy, { ...f.options, policies: { legacyBoard: { id: "old", name: "確認的看板", description: "", wipLimit: 4 } } });
  assert.equal(accepted.counts.tasks, 2);
  await f.register();
  const op = f.plan.operations.find(op => op.type === "BOARD");
  const receipt = [...f.db.items.values()].find(item => item.entityType === "MIGRATION_OPERATION" && item.operation.operationId === op.operationId);
  receipt.operation.restoreShape.widgetsPresent = false;
  await assert.rejects(f.service.getOperation(f.plan.migrationId, op.operationId), { code: "INTEGRITY_CONFLICT" });
});

test("CRUD locks all writes and reserves workspace barrier capacity in child ordering", async () => {
  const f = migrationFixture(); await f.apply();
  const ws = f.plan.operations[0]; const boardOp = f.plan.operations.find(op => op.type === "BOARD");
  const board = await f.repository.getBoard(boardOp.targetId);
  const task = await f.repository.getTask(f.plan.operations.find(op => op.type === "TASK").targetId);
  const widget = await f.repository.getWidget(f.plan.operations.find(op => op.type === "WIDGET").targetId);
  const workspace = await f.repository.getWorkspace(ws.targetId);
  const tests = [
    () => f.repository.saveWorkspace(ws.targetId, workspace.data, workspace.version),
    () => f.repository.createBoard(ws.targetId, { id: "new", name: "new", description: "", wipLimit: 4 }),
    () => f.repository.updateBoard(board.id, board.data, board.version),
    () => f.repository.createTask(board.id, { ...task.data, id: "new" }),
    () => f.repository.updateTask(board.id, task.id, task.data, task.version),
    () => f.repository.deleteTask(board.id, task.id, task.version),
    () => f.repository.setTaskStatus(board.id, task.id, "done", false, task.version),
    () => f.repository.createWidget(board.id, { ...widget.data, id: "new" }),
    () => f.repository.updateWidget(board.id, widget.id, widget.data, widget.version),
    () => f.repository.deleteWidget(board.id, widget.id, widget.version),
    () => f.repository.reorderBoards(ws.targetId, [{ id: board.id, version: board.version, position: 1 }]),
    () => f.repository.reorderTasks(board.id, [{ id: task.id, version: task.version, position: 1 }]),
    () => f.repository.reorderWidgets(board.id, [{ id: widget.id, version: widget.version, position: 1 }]),
  ];
  const before = hash([...f.db.items]);
  for (const operation of tests) await assert.rejects(operation(), { code: "MIGRATION_LOCKED" });
  await assert.rejects(f.repository.deleteBoard(board.id, board.version));
  assert.equal(hash([...f.db.items]), before);
  const db = new MemoryClient(); const repo = createRepository(db);
  const root = await repo.createWorkspace({}); const b = await repo.createBoard(root.id, { id: "sort", name: "sort", description: "", wipLimit: 4 });
  const widgets = [];
  for (let i = 0; i < 99; i++) widgets.push(await repo.createWidget(b.id, { id: `w-${i}`, type: "note", span: 6, height: 260, config: {} }, i));
  await assert.rejects(repo.reorderWidgets(b.id, widgets.map((widget, index) => ({ id: widget.id, version: widget.version, position: 98 - index }))), { code: "VALIDATION" });
  await repo.reorderWidgets(b.id, widgets.slice(0, 98).map((widget, index) => ({ id: widget.id, version: widget.version, position: 97 - index })));
  assert.equal(db.calls.at(-1).input.TransactItems.length, 100);
});

test("a lock acquired after CRUD read is checked at commit (TOCTOU); entire transaction fails", async () => {
  const db = new MemoryClient(); const repo = createRepository(db);
  const root = await repo.createWorkspace({}); const board = await repo.createBoard(root.id, { id: "b", name: "before", description: "", wipLimit: 4 });
  db.beforeTransaction = input => {
    if (input.TransactItems.some(action => action.Put?.Item.id === board.id)) { db.beforeTransaction = null; db.items.get(board.id).migrationLock = true; }
  };
  await assert.rejects(repo.updateBoard(board.id, { ...board.data, name: "must not save" }, board.version), { code: "MIGRATION_LOCKED" });
  assert.equal(db.items.get(board.id).data.name, "before"); assert.equal(db.items.get(board.id).version, board.version);
});

test("parent version changes and foreign targets stop execution without overwriting", async () => {
  const f = migrationFixture(); await f.register();
  for (const op of f.plan.operations.slice(0, 2)) await f.service.execute(f.plan.migrationId, op.operationId, op.fingerprint);
  const board = f.plan.operations.find(op => op.type === "BOARD"); f.db.items.get(board.targetId).version++;
  const task = f.plan.operations.find(op => op.type === "TASK");
  await assert.rejects(f.service.execute(f.plan.migrationId, task.operationId, task.fingerprint), { code: "INTEGRITY_CONFLICT" });
  assert.equal(f.db.items.has(task.targetId), false); assert.equal((await f.service.getSession(f.plan.migrationId)).state, "CONFLICT");
  const foreign = migrationFixture(); await foreign.register(); const root = foreign.plan.operations[0];
  const manual = { id: root.targetId, entityType: "WORKSPACE", data: { title: "manual" }, schemaVersion: 1, version: 5 };
  foreign.db.items.set(root.targetId, structuredClone(manual));
  await assert.rejects(foreign.service.execute(foreign.plan.migrationId, root.operationId, root.fingerprint), { code: "TARGET_CONFLICT" });
  assert.deepEqual(foreign.db.items.get(root.targetId), manual);
  assert.equal((await foreign.service.rollbackPreview(foreign.plan.migrationId)).canRollback, false);
});

test("source binding, cross-session operation IDs and changed backups cannot contaminate a session", async () => {
  const f = migrationFixture(); await f.register();
  const changed = workspaceFixture(); changed.boards[0].name = "changed";
  const changedBackup = captureWorkspaceBackup({ storage: storageFixture({ "slowly-workspace-v2": JSON.stringify(changed) }), createdAt });
  const nextPlan = migrationPlanV2(changedBackup, f.options);
  await assert.rejects(f.service.createSession(changedBackup, f.options, f.plan.planId), { code: "PLAN_CONFLICT" });
  await assert.rejects(f.service.createSession(changedBackup, f.options, nextPlan.planId), { code: "SOURCE_CONFLICT" });
  const otherOptions = { sourceNamespace: `other-${randomUUID()}` }; const otherPlan = migrationPlanV2(f.backup, otherOptions);
  await f.service.createSession(f.backup, otherOptions, otherPlan.planId);
  await assert.rejects(f.service.execute(f.plan.migrationId, otherPlan.operations[0].operationId, otherPlan.operations[0].fingerprint), { code: "NOT_FOUND" });
  assert.equal(f.db.items.has(otherPlan.operations[0].targetId), false);
});

test("verify detects changed content and schema, retains locks and records conflicts", async () => {
  const f = migrationFixture(); await f.apply();
  const item = f.db.items.get(f.plan.operations.find(op => op.type === "TASK").targetId); item.data.notes = "external change";
  await assert.rejects(f.service.verify(f.plan.migrationId), { code: "INTEGRITY_CONFLICT" });
  assert.equal((await f.service.getSession(f.plan.migrationId)).state, "CONFLICT"); assert.equal(item.migrationLock, true);
  const g = migrationFixture(); await g.apply();
  g.db.items.get(g.plan.operations[0].targetId).schemaVersion = 99;
  await assert.rejects(g.service.verify(g.plan.migrationId), { code: "INTEGRITY_CONFLICT" });
});

test("rollback preview is read-only; partial rollback and lost response resume; audit records and old items remain", async () => {
  const f = migrationFixture(); const manual = { id: "manual", title: "keep" }; f.db.items.set(manual.id, manual); await f.apply();
  const before = hash([...f.db.items]); const preview = await f.service.rollbackPreview(f.plan.migrationId);
  assert.equal(preview.canRollback, true); assert.equal(preview.deletable.length, f.plan.operations.length); assert.equal(hash([...f.db.items]), before);
  f.db.afterTransaction = input => { if (input.TransactItems.some(action => action.Delete)) { f.db.afterTransaction = null; throw new Error("rollback reply lost"); } };
  await assert.rejects(f.service.rollback(f.plan.migrationId, preview.sessionVersion, f.plan.migrationId), { code: "STORAGE" });
  assert.equal((await f.service.getSession(f.plan.migrationId)).rolledBackCount, 1);
  const final = await f.undo(); assert.equal(final.state, "ROLLED_BACK"); assert.equal(final.lockState, "CLOSED");
  for (const op of f.plan.operations) assert.equal(f.db.items.has(op.targetId), false);
  assert.deepEqual(f.db.items.get(manual.id), manual);
  assert.ok([...f.db.items.values()].some(item => item.entityType === "MIGRATION_OPERATION" && item.state === "ROLLED_BACK"));
  assert.ok([...f.db.items.values()].some(item => item.entityType === "MIGRATION_SOURCE"));
  await assert.rejects(f.service.execute(f.plan.migrationId, f.plan.operations[0].operationId, f.plan.operations[0].fingerprint), { code: "SESSION_STATE" });
});

test("external edits refuse rollback, including same-version edits and ownership changes", async () => {
  for (const edit of [item => { item.version++; }, item => { item.data.notes = "external"; }, item => { item.migrationOwner.migrationId = "someone-else"; }]) {
    const f = migrationFixture(); await f.apply(); const target = f.plan.operations.find(op => op.type === "TASK");
    edit(f.db.items.get(target.targetId)); const original = hash(f.db.items.get(target.targetId));
    const preview = await f.service.rollbackPreview(f.plan.migrationId); assert.equal(preview.canRollback, false);
    await assert.rejects(f.service.rollback(f.plan.migrationId, preview.sessionVersion, f.plan.migrationId), { code: "ROLLBACK_CONFLICT" });
    assert.equal(hash(f.db.items.get(target.targetId)), original);
    assert.ok((await f.service.getSession(f.plan.migrationId)).lastError);
    assert.equal((await f.service.getSession(f.plan.migrationId)).state, "ROLLBACK_CONFLICT");
    assert.equal((await f.service.getSession(f.plan.migrationId)).lastError.operationId, target.operationId);
  }
});

test("rollback detects an ownership/data race at delete time and never deletes the changed target", async () => {
  const f = migrationFixture(); await f.apply();
  let changedId;
  f.db.beforeTransaction = input => {
    const deletion = input.TransactItems.find(action => action.Delete);
    if (deletion) { f.db.beforeTransaction = null; changedId = deletion.Delete.Key.id; f.db.items.get(changedId).data.external = true; }
  };
  const preview = await f.service.rollbackPreview(f.plan.migrationId);
  await assert.rejects(f.service.rollback(f.plan.migrationId, preview.sessionVersion, f.plan.migrationId), { code: "CONFLICT" });
  assert.equal(f.db.items.get(changedId).data.external, true);
  assert.equal((await f.service.getSession(f.plan.migrationId)).rolledBackCount, 0);
  assert.equal((await f.service.getSession(f.plan.migrationId)).state, "ROLLBACK_CONFLICT");
});

test("release is explicit, resumable and irreversible; verified alone never unlocks CRUD", async () => {
  const f = migrationFixture(); await f.apply(); await f.service.verify(f.plan.migrationId);
  for (let i = 0; i <= f.plan.operations.length; i++) {
    const session = await f.service.getSession(f.plan.migrationId);
    const preview = await f.service.releasePreview(f.plan.migrationId, session.version);
    await f.service.release(f.plan.migrationId, session.version, preview.verificationHash, f.plan.migrationId);
  }
  const session = await f.service.getSession(f.plan.migrationId); assert.equal(session.lockState, "RELEASED");
  assert.equal((await f.service.rollbackPreview(f.plan.migrationId)).canRollback, false);
  await assert.rejects(f.service.rollback(f.plan.migrationId, session.version, f.plan.migrationId), { code: "SESSION_STATE" });
  const op = f.plan.operations.find(op => op.type === "TASK"); const task = await f.repository.getTask(op.targetId);
  await f.repository.updateTask(task.boardId, task.id, { ...task.data, title: "now editable" }, task.version);
});

test("definitive transaction rejection persists FAILED, while a timeout never fabricates failure", async () => {
  const f = migrationFixture(); await f.register(); const op = f.plan.operations[0];
  f.db.beforeTransaction = input => {
    if (input.TransactItems.some(action => action.Put?.Item.id === op.targetId)) { f.db.beforeTransaction = null; throw Object.assign(new Error("invalid transaction"), { name: "ValidationException" }); }
  };
  await assert.rejects(f.service.execute(f.plan.migrationId, op.operationId, op.fingerprint), { code: "FAILED_WRITE" });
  assert.equal((await f.service.getOperation(f.plan.migrationId, op.operationId)).state, "FAILED");
  assert.equal((await f.service.getSession(f.plan.migrationId)).lockState, "HELD");
  assert.equal(f.db.items.has(op.targetId), false);
  await f.service.execute(f.plan.migrationId, op.operationId, op.fingerprint);
  assert.equal((await f.service.getOperation(f.plan.migrationId, op.operationId)).state, "CONFIRMED");
});

test("concurrent registration creates one source/session/manifest, and concurrent rollback cannot double-delete", async () => {
  const f = migrationFixture();
  const sessions = await Promise.all(Array.from({ length: 4 }, () => f.service.createSession(f.backup, f.options, f.plan.planId)));
  assert.ok(sessions.every(session => session.migrationId === f.plan.migrationId));
  assert.equal([...f.db.items.values()].filter(item => item.entityType === "MIGRATION_SESSION").length, 1);
  assert.equal([...f.db.items.values()].filter(item => item.entityType === "MIGRATION_OPERATION").length, f.plan.operations.length);
  await f.apply(); const session = await f.service.getSession(f.plan.migrationId);
  await Promise.allSettled(Array.from({ length: 4 }, () => f.service.rollback(f.plan.migrationId, session.version, f.plan.migrationId)));
  const current = await f.service.getSession(f.plan.migrationId);
  const rolled = [...f.db.items.values()].filter(item => item.entityType === "MIGRATION_OPERATION" && item.state === "ROLLED_BACK").length;
  assert.equal(current.rolledBackCount, rolled);
  assert.ok(rolled >= 1); await f.undo();
});

test("invalid inline schemas/parents and transaction oversize block before any binding or user writes", async () => {
  for (const mutate of [data => { data.boards[0].tasks[0].subtasks[0].schemaVersion = 2; }, data => { data.boards[0].tasks[0].workspaceId = "other"; }, data => { data.boards[0].widgets[0].workspaceId = "other"; }, data => { data.boards[0].wipLimit = 1; data.boards[0].tasks.forEach(task => { task.status = "doing"; }); }]) {
    const data = workspaceFixture(); mutate(data); assert.throws(() => migrationFixture(data), { code: "PREVIEW_INVALID" });
  }
  const f = migrationFixture(); const data = workspaceFixture(); data.boards[0].tasks[0].extra = "x".repeat(350000);
  const backup = captureWorkspaceBackup({ storage: storageFixture({ "slowly-workspace-v2": JSON.stringify(data) }), createdAt });
  await assert.rejects(f.service.createSession(backup, f.options, "0".repeat(64)));
  assert.equal(f.db.items.size, 0);
});
