import test from "node:test";
import assert from "node:assert/strict";
import { releaseFixture } from "./helpers/release-fixture.mjs";
import { hash } from "../src/lib/migration/plan-v2.mjs";
import { createMigrationService } from "../src/lib/migration/service.mjs";
import { createMigrationApi } from "../src/lib/api/migrations.mjs";
import { createRepository } from "../src/lib/slowly-repository.mjs";
import { MemoryClient } from "./helpers/memory-client.mjs";
import { checkCutoverReadiness, assertCutoverReady } from "../src/lib/migration/cutover-readiness.mjs";
import { projectWorkspaceForUi } from "../src/lib/client/workspace-projection.mjs";
import { workspaceFixture } from "./phase4a-fixtures.mjs";

test("release-preview is read-only; API validates versions, hashes, Origin and completion", async () => {
  const f = releaseFixture(); await f.apply(); const session = await f.service.getSession(f.plan.migrationId);
  const before = hash([...f.db.items]); const preview = await f.service.releasePreview(f.plan.migrationId, session.version);
  assert.equal(hash([...f.db.items]), before); assert.equal(preview.eligible, true);
  const api = createMigrationApi({ getService: async () => f.service, configuration: () => ({ NODE_ENV: "development", SLOWLY_LOCAL_API: "1" }) });
  const call = async (name, body, origin = "http://127.0.0.1:3000") => api[name](new Request(`http://127.0.0.1:3000/api/migrations/${f.plan.migrationId}/${name}`, { method: "POST", headers: { host: "127.0.0.1:3000", origin, "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ migrationId: f.plan.migrationId }) });
  assert.equal((await call("release", {})).status, 400);
  assert.equal((await call("releasePreview", { expectedSessionVersion: session.version - 1 })).status, 409);
  assert.equal((await call("releasePreview", { expectedSessionVersion: session.version }, "http://external.test")).status, 403);
  assert.equal((await call("release", { expectedSessionVersion: session.version, expectedVerificationHash: "0".repeat(64), confirmation: f.plan.migrationId })).status, 409);
  assert.equal((await call("releasePreview", { expectedSessionVersion: session.version })).status, 200);
  const body = { expectedSessionVersion: session.version, expectedVerificationHash: preview.verificationHash, confirmation: f.plan.migrationId };
  assert.equal((await call("release", body)).status, 202);
  await f.finish(); assert.equal((await call("release", body)).status, 200);
});

test("workspace barrier blocks every CRUD after children are unlocked, until final transaction", async () => {
  const data = workspaceFixture(); data.boards.push({ id: "empty", name: "Empty", description: "", wipLimit: 4, tasks: [], widgets: [] });
  const f = releaseFixture({ data }); await f.apply(); await f.step();
  for (let i = 0; i < f.plan.operations.length - 1; i++) await f.step();
  const session = await f.service.getSession(f.plan.migrationId); assert.equal(session.state, "RELEASING");
  const root = await f.repository.getWorkspace(f.plan.operations[0].targetId); assert.equal(root.migrationLock, true);
  const task = await f.repository.getTask(f.plan.operations.find(op => op.type === "TASK").targetId);
  const board = await f.repository.getBoard(task.boardId); assert.equal(board.migrationLock, false);
  const widget = await f.repository.getWidget(f.plan.operations.find(op => op.type === "WIDGET").targetId);
  const empty = await f.repository.getBoard(f.plan.operations.find(op => op.type === "BOARD" && op.data.id === "empty").targetId);
  const actions = [
    () => f.repository.saveWorkspace(root.id, root.data, root.version),
    () => f.repository.createBoard(root.id, { id: "new", name: "new", description: "", wipLimit: 4 }),
    () => f.repository.updateBoard(board.id, board.data, board.version),
    () => f.repository.deleteBoard(empty.id, empty.version),
    () => f.repository.createTask(board.id, { ...task.data, id: "new" }),
    () => f.repository.updateTask(board.id, task.id, task.data, task.version),
    () => f.repository.deleteTask(board.id, task.id, task.version),
    () => f.repository.setTaskStatus(board.id, task.id, "done", false, task.version),
    () => f.repository.createWidget(board.id, { ...widget.data, id: "new" }),
    () => f.repository.updateWidget(widget.boardId, widget.id, widget.data, widget.version),
    () => f.repository.deleteWidget(widget.boardId, widget.id, widget.version),
    () => f.repository.reorderBoards(root.id, [{ id: board.id, version: board.version, position: 1 }]),
    () => f.repository.reorderTasks(board.id, [{ id: task.id, version: task.version, position: 1 }]),
    () => f.repository.reorderWidgets(widget.boardId, [{ id: widget.id, version: widget.version, position: 1 }]),
  ];
  for (const action of actions) await assert.rejects(action(), { code: "MIGRATION_LOCKED" });
  await assert.rejects(f.service.rollback(f.plan.migrationId, session.version, f.plan.migrationId), { code: "SESSION_STATE" });
  const released = await f.step(); assert.equal(released.lockState, "RELEASED");
  await f.repository.updateTask(board.id, task.id, { ...task.data, title: "Allowed" }, task.version);
  assert.equal((await f.service.rollbackPreview(f.plan.migrationId)).canRollback, false);
});

test("release target ownership changed at commit cannot be unlocked", async () => {
  const f = releaseFixture(); await f.apply(); await f.step();
  const targetId = f.plan.operations.at(-1).targetId;
  f.db.beforeTransaction = input => {
    if (!input.TransactItems.some(action => action.Put?.Item.id === targetId)) return;
    f.db.beforeTransaction = null; f.db.items.get(targetId).migrationOwner.migrationId = "foreign";
  };
  await assert.rejects(f.step(), { code: "CONFLICT" });
  assert.equal(f.db.items.get(targetId).migrationLock, true);
  const session = await f.service.getSession(f.plan.migrationId); assert.equal(session.releasedCount, 0);
  assert.equal((await f.service.releasePreview(f.plan.migrationId, session.version)).eligible, false);
});

test("barrier acquired after CRUD preflight is checked in the write transaction", async () => {
  const db = new MemoryClient(); const repo = createRepository(db); const root = await repo.createWorkspace({});
  const board = await repo.createBoard(root.id, { id: "board", name: "Board", description: "", wipLimit: 4 });
  db.beforeTransaction = input => { assert.ok(input.TransactItems.some(action => action.ConditionCheck?.Key.id === root.id)); db.beforeTransaction = null; db.items.get(root.id).migrationLock = true; };
  await assert.rejects(repo.createWidget(board.id, { id: "widget", type: "note", span: 6, height: 200, config: {} }), { code: "MIGRATION_LOCKED" });
  assert.equal((await repo.listWidgets(board.id)).length, 0);
});

test("legacy unlocked migration Workspace cannot bypass the new barrier protocol", async () => {
  const f = releaseFixture(); await f.apply(); await f.finish();
  const root = f.db.items.get(f.plan.operations[0].targetId); delete root.migrationReleaseVersion;
  const board = await f.repository.getBoard(f.plan.operations.find(op => op.type === "BOARD").targetId);
  await assert.rejects(f.repository.createWidget(board.id, { id: "legacy", type: "note", span: 6, height: 200, config: {} }), { code: "MIGRATION_LOCKED" });
  await assert.rejects(f.repository.saveWorkspace(root.id, root.data, root.version), { code: "MIGRATION_LOCKED" });
  const session = await f.service.getSession(f.plan.migrationId);
  assert.equal((await f.service.releasePreview(f.plan.migrationId, session.version)).eligible, false);
});

test("lost release response, restart and concurrent retries cannot double-unlock", async () => {
  const f = releaseFixture(); await f.apply(); await f.step();
  const s = await f.service.getSession(f.plan.migrationId); const preview = await f.service.releasePreview(f.plan.migrationId, s.version);
  f.db.afterTransaction = () => { f.db.afterTransaction = null; throw new Error("response lost"); };
  await assert.rejects(f.service.release(f.plan.migrationId, s.version, preview.verificationHash, f.plan.migrationId));
  const restarted = createMigrationService(f.db, { tableName: f.tableName });
  const resumed = await restarted.release(f.plan.migrationId, s.version, preview.verificationHash, f.plan.migrationId); assert.equal(resumed.releasedCount, 1);
  const outcomes = await Promise.allSettled([f.step(), f.step()]); assert.ok(outcomes.some(item => item.status === "fulfilled"));
  assert.equal((await f.service.getSession(f.plan.migrationId)).releasedCount, 2);
  await f.finish(); const done = await f.service.getSession(f.plan.migrationId);
  assert.equal((await restarted.release(f.plan.migrationId, s.version, preview.verificationHash, f.plan.migrationId)).version, done.version);
});

for (const scenario of ["ownership", "receipt", "legacy-release", "unverified"]) {
  test(`release blocks ${scenario} without modifying or unlocking targets`, async () => {
    const f = releaseFixture(); await f.apply(); const id = f.plan.migrationId;
    const session = f.db.items.get(`SLOWLY#MIGRATION_SESSION#${id}`);
    if (scenario === "ownership") f.db.items.get(f.plan.operations.at(-1).targetId).migrationOwner.migrationId = "foreign";
    if (scenario === "receipt") f.db.items.get(`SLOWLY#MIGRATION_OPERATION#${id}#${f.plan.operations.at(-1).operationId}`).state = "PENDING";
    if (scenario === "legacy-release") { session.state = "RELEASED"; session.lockState = "RELEASING"; }
    if (scenario === "unverified") { session.state = "RUNNING"; delete session.verification; }
    const before = hash([...f.db.items]); const preview = await f.service.releasePreview(id, session.version);
    assert.equal(preview.eligible, false); assert.equal(hash([...f.db.items]), before);
  });
}

test("readiness repeats without writes, verifies source/mapping, and always gates formal UI", async () => {
  const f = releaseFixture(); await f.apply(); await f.finish();
  const input = { ...f, migrationId: f.plan.migrationId, readItem: async id => structuredClone(f.db.items.get(id)), probes: Object.fromEntries(["dynamodbLocal", "apiRepositoryTests", "reactApiTests", "backupArtifactVerified"].map(name => [name, async () => true])) };
  const before = hash([...f.db.items]); const report = await checkCutoverReadiness(input); assert.equal(report.prerequisitesPassed, true); assert.equal(report.ready, false); assert.throws(() => assertCutoverReady(report));
  assert.equal((await checkCutoverReadiness(input)).prerequisitesPassed, true); assert.equal(hash([...f.db.items]), before);
  const item = f.db.items.get(f.plan.operations.at(-1).targetId); item.migrationLock = true;
  assert.equal((await checkCutoverReadiness(input)).prerequisitesPassed, false);
  assert.equal((await checkCutoverReadiness({ ...input, probes: {} })).prerequisitesPassed, false);
  const invalidBackup = await checkCutoverReadiness({ ...input, backup: {} }); assert.ok(invalidBackup.blockers.includes("backupAndPreview"));
});

test("managed projection preserves widget omission, empty list, timer, order, sizing and extensions", async () => {
  const data = workspaceFixture(); delete data.boards[1].widgets;
  data.boards.push({ ...structuredClone(data.boards[1]), id: "empty", tasks: [], widgets: [] });
  Object.assign(data.boards[0].widgets[0], { type: "timer", extension: { nested: [1, 2] }, span: 12, height: 400, manualSize: true, config: { taskId: "task-a", endsAt: 1794640000000, minutes: 25, extension: { x: true } } });
  data.boards[0].widgets.reverse();
  const f = releaseFixture({ data }); await f.apply(); await f.finish();
  const items = f.plan.operations.map(op => f.db.items.get(op.targetId)); const projection = projectWorkspaceForUi(items);
  assert.deepEqual(projection.workspace, data); assert.equal(projection.widgetPresence[f.plan.operations.find(op => op.type === "BOARD" && op.data.id === "board-b").targetId], "absent");
  assert.throws(() => projectWorkspaceForUi([...items, items[0]]));
});
