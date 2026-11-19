import assert from "node:assert/strict";
import { createElement, StrictMode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MainUi from "../../src/app/main-ui.js";
import WorkspaceBoard from "../../src/app/workspace-board.js";
import { hookHost } from "./react-hook-host.mjs";

const walk = node => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
export async function runMainUiScenario(f, secondWorkspaceId, check) {
  const host = await hookHost(); let tree; const options = { api: f.api, journal: f.journal, development: true };
  const initialCalls = f.calls.length; const initialWrites = f.calls.filter(call => call.method !== "GET").length;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Main API UI touched storage"); } });
  function Probe() { tree = MainUi({ options, isolationEntry: true }); return null; }
  function Strict() { return createElement(StrictMode, null, createElement(Probe)); }
  const find = predicate => { const result = walk(tree).find(predicate); assert.ok(result); return result; };
  const field = name => find(node => node.type === "input" && node.props["aria-label"] === name);
  const session = () => find(node => node.type === WorkspaceBoard).props.apiSession;
  const flush = async () => { for (let i = 0; i < 30; i++) await host.act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); };
  const activate = async id => {
    await host.act(() => field("API Workspace ID").props.onChange({ target: { value: id } }));
    await host.act(() => find(node => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: true } }));
    await host.act(() => find(node => node.type === "form").props.onSubmit({ preventDefault() {} })); await flush();
  };
  const grant = async id => {
    await host.act(() => field("授權寫入 Workspace ID").props.onChange({ target: { value: id } }));
    await host.act(() => walk(tree).filter(node => node.type === "form")[1].props.onSubmit({ preventDefault() {} }));
  };
  try {
    await host.render(Strict);
    await check("MainUi defaults local, StrictMode issues no request, explicit readonly activation", async () => {
      assert.equal(f.calls.length, initialCalls); await activate(f.workspaceId); assert.equal(session().writable, false);
      assert.equal(f.calls.filter(call => call.method !== "GET").length, initialWrites); await grant(f.workspaceId); assert.equal(session().writable, true);
    });
    await check("Main UI Task create, Subtask/Notes/Priority/Status updates and reorder", async () => {
      const board = session().workspace.boards[0]; const task = board.tasks[0];
      await host.act(() => session().saveTask({ ...task, notes: "  API notes\n", priority: "低", subtasks: task.subtasks.map(subtask => ({ ...subtask, done: true })), status: "doing" }, { expectedVersion: session().taskVersion(task.id) }));
      const changed = session().workspace.boards[0].tasks[0]; assert.equal(changed.notes, "  API notes\n"); assert.equal(changed.subtasks[0].extension.retained, true);
      await host.act(() => session().saveTask({ id: "ui-created", title: "UI created", status: "todo" }));
      const ids = session().workspace.boards[0].tasks.map(task => task.id).reverse(); await host.act(() => session().reorderTasks(ids));
      assert.deepEqual(session().workspace.boards[0].tasks.map(task => task.id), ids);
      await host.act(() => session().deleteTask("ui-created"));
    });
    await check("Widget update/resize/config/order and extension fidelity; unsafe reset rejected", async () => {
      const widgets = session().workspace.boards[0].widgets; const widget = widgets.find(widget => widget.type === "note");
      await host.act(() => session().changeWidgets(current => current.map(item => item.id === widget.id ? { ...item, span: 12, height: 420, manualSize: true, config: { ...item.config, text: "saved from UI" } } : item), { widgetId: widget.id, expectedVersion: session().widgetVersions[widget.id] }));
      const current = session().workspace.boards[0].widgets.find(item => item.id === widget.id); assert.equal(current.config.extension.retained, true); assert.equal(current.manualSize, true);
      await host.act(() => session().changeWidgets(current => [...current].reverse()));
      await assert.rejects(session().changeWidgets(() => []), { code: "UNSUPPORTED_ATOMIC_ACTION" });
      assert.match(renderToStaticMarkup(createElement(WorkspaceBoard, { apiSession: session() })), /API 暫不支援原子清空/);
    });
    await check("Board create/update/reorder and absent → present → empty widgets via explicit actions", async () => {
      await host.act(async () => { const created = await session().saveBoard({ name: "UI board", description: "new", wipLimit: 2 }); session().selectBoard(created.data.id); }); await grant(f.workspaceId);
      const board = session().workspace.boards.find(item => item.id === session().workspace.activeBoardId); assert.equal(Object.hasOwn(board, "widgets"), false);
      await host.act(() => session().saveBoard({ ...board, name: "Updated UI board" }, { expectedVersion: session().boardVersion(board.id) }));
      await host.act(() => session().saveWidget({ id: "first-ui-widget", type: "note", span: 6, height: 200, config: { text: "first" } }));
      assert.equal(session().workspace.boards.find(item => item.id === board.id).widgets.length, 1);
      await host.act(() => session().changeWidgets(() => [])); assert.deepEqual(session().workspace.boards.find(item => item.id === board.id).widgets, []);
      const ids = session().workspace.boards.map(board => board.id).reverse(); await host.act(() => session().reorderBoards(ids)); assert.deepEqual(session().workspace.boards.map(board => board.id), ids);
    });
    await check("Workspace switch revokes writes; stale callbacks cannot mutate the new scope", async () => {
      const old = session(); await activate(secondWorkspaceId); assert.equal(session().writable, false);
      assert.throws(() => old.selectBoard(old.workspace.activeBoardId), { code: "STALE_SCOPE" });
      await activate(f.workspaceId); assert.equal(session().writable, false); await grant(f.workspaceId);
    });
    await check("409 preserves confirmed UI; explicit refresh recovers without overwriting", async () => {
      const boardId = session().workspace.boards.find(board => board.tasks.length).id;
      await host.act(() => session().selectBoard(boardId)); await grant(f.workspaceId);
      const task = session().workspace.boards.find(board => board.id === boardId).tasks[0]; const version = session().taskVersion(task.id);
      const view = await f.api.getWorkspaceView(f.workspaceId); const entry = view.boards.find(entry => entry.board.data.id === boardId); const record = entry.tasks.find(row => row.data.id === task.id);
      await f.repository.updateTask(entry.board.id, record.id, { ...record.data, title: "external" }, record.version);
      await host.act(async () => { await assert.rejects(session().saveTask({ ...task, title: "stale" }, { expectedVersion: version }), { status: 409 }); });
      assert.equal(session().writable, false);
      assert.equal(session().workspace.boards.find(board => board.id === boardId).tasks[0].title, task.title);
      await host.act(() => session().refresh()); assert.equal(session().workspace.boards.find(board => board.id === boardId).tasks[0].title, "external");
      assert.equal(session().writable, false);
      await grant(f.workspaceId);
    });
    await check("lost POST response issues once and recovers through its persistent receipt", async () => {
      f.failNextWrite("after"); const before = f.calls.filter(call => call.method === "POST").length;
      await host.act(() => session().saveTask({ id: "uncertain-ui-post", title: "Once only", status: "todo" }));
      assert.equal(f.calls.filter(call => call.method === "POST").length, before + 1); assert.equal(session().writable, false);
      assert.equal(session().workspace.boards.find(board => board.id === session().workspace.activeBoardId).tasks.filter(task => task.id === "uncertain-ui-post").length, 1);
      await host.act(() => find(node => node.type === "button" && node.props.children === "切回 localStorage Mode").props.onClick());
      assert.equal(walk(tree).some(node => node.type === WorkspaceBoard), false);
    });
  } finally { await host.close(); if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor); else delete globalThis.localStorage; }
}
