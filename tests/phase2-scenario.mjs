import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRepository } from "../src/lib/slowly-repository.mjs";
import { fromFrontend, toFrontend } from "../src/lib/data-model.mjs";

export const taskData = (id = randomUUID()) => ({ id, title: "測試任務", description: "描述", status: "todo", tag: "個人", priority: "高", urgent: false, date: "2026-11-13", time: "10:30", subtasks: [{ id: "sub-1", title: "步驟", done: false }], notes: "備註", completedAt: null });
export const boardData = (id = randomUUID()) => ({ id, name: "隔離測試看板", description: "", wipLimit: 1, analyticsSize: { width: 600, height: 280 }, settings: { example: true } });

export async function runScenario(db, runId) {
  const repo = createRepository(db);
  const workspace = await repo.createWorkspace({ activeBoardId: "frontend-board", testRun: runId, settings: { example: true } });
  assert.equal((await repo.getWorkspace(workspace.id)).version, 1);
  const saved = await repo.saveWorkspace(workspace.id, { ...workspace.data, activeBoardId: "other" }, 1);
  assert.equal(saved.version, 2);
  await assert.rejects(repo.saveWorkspace(workspace.id, saved.data, 1), { code: "CONFLICT" });
  const board = await repo.createBoard(workspace.id, { ...boardData("frontend-board"), testRun: runId });
  const secondBoard = await repo.createBoard(workspace.id, { ...boardData(), testRun: runId }, 1);
  const task = await repo.createTask(board.id, { ...taskData(), testRun: runId });
  const task2 = await repo.createTask(board.id, { ...taskData(), testRun: runId }, 1);
  assert.deepEqual(toFrontend(task), { ...task.data });
  assert.deepEqual(fromFrontend("TASK", toFrontend(task)), task.data);
  const changed = await repo.updateTask(board.id, task.id, { ...task.data, notes: "修改後", subtasks: [{ ...task.data.subtasks[0], done: true }] }, 1);
  assert.equal(changed.data.subtasks[0].done, true);
  await assert.rejects(repo.updateTask(board.id, task.id, task.data, 1), { code: "CONFLICT" });
  await assert.rejects(repo.deleteTask(secondBoard.id, task.id, changed.version), { code: "OWNERSHIP" });
  const doing = await repo.setTaskStatus(board.id, task.id, "doing", true, changed.version);
  await assert.rejects(repo.setTaskStatus(board.id, task2.id, "doing", false, 1), { code: "WIP_LIMIT" });
  const done = await repo.setTaskStatus(board.id, task.id, "done", true, doing.version);
  assert.ok(done.data.completedAt);
  const doneAgain = await repo.updateTask(board.id, task.id, { ...done.data, title: "完成後修改" }, done.version);
  assert.equal(doneAgain.data.completedAt, done.data.completedAt);
  const reopened = await repo.setTaskStatus(board.id, task.id, "todo", false, doneAgain.version);
  assert.equal(reopened.data.completedAt, null);
  const ordered = await repo.reorderTasks(board.id, [{ id: task2.id, version: 1, position: 0 }, { id: task.id, version: reopened.version, position: 1 }]);
  assert.equal(ordered[0].id, task2.id);
  await assert.rejects(repo.reorderTasks(secondBoard.id, [{ id: task.id, version: ordered[1].version, position: 0 }]), { code: "OWNERSHIP" });
  // GSI reads are eventually consistent; poll only in the isolated integration test.
  async function eventually(read, check) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await read();
      if (check(result)) return result;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail("GSI did not converge within test timeout");
  }
  await eventually(() => repo.listBoards(workspace.id), rows => rows.length === 2);
  const tasks = await eventually(() => repo.listTasks(board.id), rows => rows.length === 2 && rows[0].id === task2.id);
  assert.equal(tasks[1].id, task.id);
  const widgetData = { id: randomUUID(), type: "note", span: 6, height: 260, manualSize: true, config: { text: "筆記" }, testRun: runId };
  const widget = await repo.createWidget(board.id, widgetData);
  assert.deepEqual(toFrontend(await repo.getWidget(widget.id)), widgetData);
  const widget2 = await repo.createWidget(board.id, { ...widgetData, id: randomUUID() }, 1);
  const modifiedWidget = await repo.updateWidget(board.id, widget.id, { ...widgetData, span: 12, config: { text: "更新" } }, 1);
  await assert.rejects(repo.updateWidget(board.id, widget.id, widgetData, 1), { code: "CONFLICT" });
  const widgets = await repo.reorderWidgets(board.id, [{ id: widget2.id, version: 1, position: 0 }, { id: widget.id, version: modifiedWidget.version, position: 1 }]);
  await eventually(() => repo.listWidgets(board.id), rows => rows.length === 2 && rows[0].id === widget2.id);
  const currentBoard = await repo.getBoard(board.id);
  await assert.rejects(repo.deleteBoard(board.id, currentBoard.version), { code: "NOT_EMPTY" });
  const editedBoard = await repo.updateBoard(board.id, { ...currentBoard.data, name: "更新看板" }, currentBoard.version);
  assert.equal(editedBoard.data.name, "更新看板");
  await assert.rejects(repo.updateBoard(board.id, board.data, board.version), { code: "CONFLICT" });
  await repo.reorderBoards(workspace.id, [{ id: board.id, version: editedBoard.version, position: 1 }, { id: secondBoard.id, version: secondBoard.version, position: 0 }]);
  for (const entry of widgets) await repo.deleteWidget(board.id, entry.id, entry.version);
  for (const entry of ordered) await repo.deleteTask(board.id, entry.id, entry.version);
  await assert.rejects(repo.getTask(task.id), { code: "NOT_FOUND" });
  await assert.rejects(repo.getWidget(widget.id), { code: "NOT_FOUND" });
  const empty = await repo.getBoard(board.id);
  assert.deepEqual([empty.taskCount, empty.widgetCount, empty.doingCount], [0, 0, 0]);
  await repo.deleteBoard(board.id, empty.version);
  await repo.deleteBoard(secondBoard.id, (await repo.getBoard(secondBoard.id)).version);
  await assert.rejects(repo.getBoard(board.id), { code: "NOT_FOUND" });
  return { workspaceId: workspace.id, result: "Workspace/Board/Task/Widget CRUD, ordering, WIP, ownership and conflicts passed" };
}
