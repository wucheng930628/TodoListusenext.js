import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runScenario, taskData, boardData } from "./phase2-scenario.mjs";
import { fromFrontend, toFrontend, makeItem, validateData, splitFrontendWorkspace, joinFrontendWorkspace } from "../src/lib/data-model.mjs";
import { createRepository } from "../src/lib/slowly-repository.mjs";
import { localClientOptions } from "../src/lib/local-dynamodb.mjs";

import { MemoryClient } from "./helpers/memory-client.mjs";

test("isolated CRUD scenario, query pagination and existing-data preservation", async () => {
  const db = new MemoryClient();
  const legacy = { id: "existing-test-id", title: "untouched", priority: "high" };
  db.items.set(legacy.id, legacy);
  const result = await runScenario(db, randomUUID());
  assert.ok(result.workspaceId);
  assert.deepEqual(db.items.get(legacy.id), legacy);
  assert.equal(db.calls.some(call => call.type === "ScanCommand"), false);
  assert.ok(db.calls.some(call => call.type === "QueryCommand" && call.input.ExclusiveStartKey));
});

test("frontend model round trips preserve nested fields and explicit defaults", () => {
  const original = taskData();
  assert.deepEqual(toFrontend(makeItem("TASK", fromFrontend("TASK", original), { parent: `SLOWLY#BOARD#${randomUUID()}`, workspaceId: `SLOWLY#WORKSPACE#${randomUUID()}` })), original);
  const board = { ...boardData(), tasks: [original], widgets: [], customSetting: { nested: "保留" } };
  const converted = fromFrontend("BOARD", board);
  assert.equal("tasks" in converted, false);
  assert.equal("widgets" in converted, false);
  assert.deepEqual(converted.customSetting, board.customSetting);
  assert.equal(board.tasks.length, 1);
  assert.equal(fromFrontend("TASK", { id: "old", title: "舊資料", status: "todo" }).priority, "一般");
  const workspace = { activeBoardId: board.id, settings: { theme: "slowly" }, boards: [{ ...board, widgets: [{ id: "note", type: "note", span: 6, height: 260, config: { text: "保留筆記" } }] }, { ...boardData(), tasks: [] }] };
  assert.deepEqual(joinFrontendWorkspace(splitFrontendWorkspace(workspace)), workspace);
  for (const type of ["analytics", "today", "upcoming", "timer", "note"]) {
    const data = { id: "widget", type, span: 12, height: 320, config: { text: "內容", minutes: 25, endsAt: null, remaining: null, taskId: original.id } };
    assert.deepEqual(validateData("WIDGET", data), data);
  }
});

test("explicit migration option preserves completion timestamps, including unknown legacy times", async () => {
  const repo = createRepository(new MemoryClient());
  const ws = await repo.createWorkspace({}); const board = await repo.createBoard(ws.id, boardData());
  for (const completedAt of ["2025-01-01T10:00:00.000Z", null]) {
    const item = await repo.createTask(board.id, { ...taskData(), status: "done", completedAt }, 0, { preserveCompletionTime: true });
    assert.equal(item.data.completedAt, completedAt);
  }
});

test("reject invalid dates, UI enums, missing ownership, oversized or malformed data", () => {
  for (const patch of [{ date: "2026-02-30" }, { date: "2026-99-99" }, { time: "25:00" }, { priority: "high" }, { status: "unknown" }, { subtasks: [{ id: "x", title: "", done: false }] }, { urgent: "true" }]) {
    assert.throws(() => validateData("TASK", { ...taskData(), ...patch }), { code: "VALIDATION" });
  }
  assert.throws(() => makeItem("TASK", taskData()), { code: "VALIDATION" });
  assert.throws(() => makeItem("WORKSPACE", { large: "x".repeat(350000) }), { code: "VALIDATION" });
  assert.throws(() => validateData("BOARD", { ...boardData(), tasks: [] }), { code: "VALIDATION" });
});

test("simultaneous moves enforce WIP atomically and stale writes cannot overwrite", async () => {
  const db = new MemoryClient(); const repo = createRepository(db);
  const ws = await repo.createWorkspace({}); const board = await repo.createBoard(ws.id, boardData());
  const a = await repo.createTask(board.id, taskData()); const b = await repo.createTask(board.id, taskData());
  const results = await Promise.allSettled([repo.setTaskStatus(board.id, a.id, "doing", false, 1), repo.setTaskStatus(board.id, b.id, "doing", false, 1)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.code, "CONFLICT");
  const current = await repo.getBoard(board.id);
  assert.equal(current.doingCount, 1);
  assert.equal((await repo.listTasks(board.id)).filter(item => item.data.status === "doing").length, 1);
});

test("guard production endpoints, invalid ordering and storage failures", async () => {
  for (const endpoint of ["https://dynamodb.ap-northeast-1.amazonaws.com", "http://example.com:9000", "http://127.0.0.1:8000", "http://127.0.0.1:9000/path"]) assert.throws(() => localClientOptions(endpoint));
  assert.equal(localClientOptions("http://127.0.0.1:9000").endpoint, "http://127.0.0.1:9000");
  const db = new MemoryClient(); const repo = createRepository(db);
  await assert.rejects(repo.reorderTasks("anything", []), { code: "VALIDATION" });
  const failed = createRepository({ send: async () => { throw new Error("offline"); } });
  await assert.rejects(failed.createWorkspace({}), { code: "STORAGE" });
});
