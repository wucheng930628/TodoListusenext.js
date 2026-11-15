import test from "node:test";
import assert from "node:assert/strict";
import { createElement, StrictMode, useSyncExternalStore } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Home from "../src/app/page.js";
import MainUi from "../src/app/main-ui.js";
import WorkspaceBoard from "../src/app/workspace-board.js";
import TaskPanel from "../src/app/task-panel.js";
import { AsyncWidgetNote } from "../src/components/async-widget-note.mjs";
import { createMainUiSession } from "../src/lib/client/main-ui-session.mjs";
import { mainUiFixture } from "./helpers/main-ui-fixture.mjs";
import { workspaceFixture } from "./phase4a-fixtures.mjs";
import { hookHost } from "./helpers/react-hook-host.mjs";

function elements(node, predicate) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(item => elements(item, predicate));
  return [...(predicate(node) ? [node] : []), ...elements(node.props?.children, predicate)];
}
const element = (node, predicate) => { const found = elements(node, predicate)[0]; assert.ok(found, "Expected UI element"); return found; };
const flush = async host => { for (let i = 0; i < 15; i++) await host.act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); };

test("homepage SSR defaults to the original local board and does not read storage", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage"); Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("SSR storage access"); } });
  try { const markup = renderToStaticMarkup(createElement(Home)); assert.match(markup, /我的看板/); assert.match(markup, /slowly\./); assert.doesNotMatch(markup, /API · 已授權寫入/); }
  finally { if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor); else delete globalThis.localStorage; }
});

test("StrictMode TaskPanel double-submit creates once and useAsyncDraft recovers a lost response", async () => {
  const f = await mainUiFixture(); await f.activate(); f.grant(); f.failNextWrite("after");
  const host = await hookHost(); let tree; let calls = 0;
  const task = { id: "strict-safe", title: "Strict once", status: "todo", priority: "一般", tag: "個人", urgent: false, date: "", time: "", description: "", subtasks: [], notes: "" };
  function Probe() {
    tree = TaskPanel({ task, columns: [{ id: "todo", name: "待處理" }], asyncMode: true, onChange() {}, onClose() {},
      onSave: async () => { calls++; await f.controller.saveTask(task); } });
    tree.props.ref.current = { showModal() {}, close() {} };
    return null;
  }
  function Strict() { return createElement(StrictMode, null, createElement(Probe)); }
  try {
    await host.render(Strict); assert.equal(f.calls.filter(call => call.method === "POST").length, 0);
    await host.act(async () => {
      const form = element(tree, node => node.type === "form");
      const first = form.props.onSubmit({ preventDefault() {} });
      const second = form.props.onSubmit({ preventDefault() {} });
      await Promise.all([first, second]);
    });
    assert.equal(calls, 1); assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
    assert.equal(f.controller.getSnapshot().uncertainWrite, false);
    assert.equal(f.controller.getSnapshot().projection.workspace.boards[0].tasks.filter(item => item.id === task.id).length, 1);
  } finally { await host.close(); }
});

test("MainUi explicit UNKNOWN resend changes the board mount key after confirmation", async () => {
  const f = await mainUiFixture(); const host = await hookHost(); let tree;
  const options = { api: f.api, development: true };
  function Probe() { tree = MainUi({ options, isolationEntry: true }); return null; }
  const input = name => element(tree, node => node.type === "input" && node.props["aria-label"] === name);
  const board = () => element(tree, node => node.type === WorkspaceBoard);
  try {
    await host.render(Probe);
    await host.act(() => input("API Workspace ID").props.onChange({ target: { value: f.workspaceId } }));
    await host.act(() => element(tree, node => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: true } }));
    await host.act(() => elements(tree, node => node.type === "form")[0].props.onSubmit({ preventDefault() {} })); await flush(host);
    await host.act(() => input("授權寫入 Workspace ID").props.onChange({ target: { value: f.workspaceId } }));
    await host.act(() => elements(tree, node => node.type === "form")[1].props.onSubmit({ preventDefault() {} }));
    const originalKey = board().key;
    f.failNextWrite("before");
    await host.act(async () => { await assert.rejects(board().props.apiSession.saveTask({ title: "Unsure form", status: "todo" })); });
    assert.equal(board().key, originalKey); assert.equal(board().props.apiSession.writable, false);
    globalThis.window.confirm = () => true;
    await host.act(() => element(tree, node => node.type === "button" && node.props.children === "以原 Key 與原內容重送").props.onClick()); await flush(host);
    assert.notEqual(board().key, originalKey); assert.equal(board().props.apiSession.writable, false);
    assert.equal(board().props.apiSession.workspace.boards[0].tasks.filter(task => task.title === "Unsure form").length, 1);
    const posts = f.calls.filter(call => call.method === "POST"); assert.equal(posts.length, 2); assert.equal(posts[0].operationKey, posts[1].operationKey);
  } finally { await host.close(); }
});

test("real MainUi source controls activate only on user events; StrictMode writes zero and explicit disable works", async () => {
  const f = await mainUiFixture(); const host = await hookHost(); let tree;
  const options = { api: f.api, development: true };
  function Probe() { tree = MainUi({ options, isolationEntry: true }); return null; }
  function Strict() { return createElement(StrictMode, null, createElement(Probe)); }
  try {
    await host.render(Strict); assert.equal(f.calls.length, 0);
    const field = label => element(tree, item => item.type === "input" && item.props["aria-label"] === label);
    await host.act(() => field("API Workspace ID").props.onChange({ target: { value: f.workspaceId } }));
    await host.act(() => element(tree, item => item.type === "input" && item.props.type === "checkbox").props.onChange({ target: { checked: true } }));
    await host.act(() => element(tree, item => item.type === "form").props.onSubmit({ preventDefault() {} })); await flush(host);
    assert.ok(element(tree, item => item.type === WorkspaceBoard).props.apiSession); assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
    await host.act(() => field("授權寫入 Workspace ID").props.onChange({ target: { value: f.workspaceId } }));
    const forms = elements(tree, item => item.type === "form"); await host.act(() => forms[1].props.onSubmit({ preventDefault() {} }));
    assert.equal(element(tree, item => item.type === WorkspaceBoard).props.apiSession.writable, true);
    await host.act(() => element(tree, item => item.type === "button" && item.props.children === "切回 localStorage Mode").props.onClick());
    assert.equal(elements(tree, item => item.type === WorkspaceBoard).length, 0);
  } finally { await host.close(); }
});

test("shared actual board renders API data, preserves analytics, and never runs localStorage effects", async () => {
  const data = workspaceFixture(); data.boards[0].widgets[0].type = "analytics";
  const f = await mainUiFixture({ data }); await f.activate(); const host = await hookHost(); let tree;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage"); Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("API storage access"); } });
  function Probe() { const state = useSyncExternalStore(f.controller.subscribe, f.controller.getSnapshot); tree = WorkspaceBoard({ apiSession: createMainUiSession({ ...state, controller: f.controller }) }); return null; }
  try {
    await host.render(Probe); const title = element(tree, item => item.type === "button" && item.props.className === "task-title");
    await host.act(() => title.props.onClick()); const panel = element(tree, item => item.type === TaskPanel); assert.equal(panel.props.readOnly, true); assert.equal(panel.props.task.notes, "備註\n保留");
    assert.match(renderToStaticMarkup(createElement(WorkspaceBoard, { apiSession: createMainUiSession({ ...f.controller.getSnapshot(), controller: f.controller }) })), /任務完成統計/);
  } finally { await host.close(); if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor); else delete globalThis.localStorage; }
});

test("actual TaskPanel handles one async submission, pending state and 409 without closing or losing draft", async () => {
  const f = await mainUiFixture(); const task = f.data.boards[0].tasks[0]; const host = await hookHost(); let tree; let resolve; let calls = 0;
  const props = { task, columns: [{ id: "todo", name: "待處理" }], onChange() {}, onClose() {}, onDelete() {}, asyncMode: true,
    onSave() { calls++; return new Promise(done => { resolve = done; }); } };
  function Probe(input) { tree = TaskPanel(input); tree.props.ref.current = { showModal() {}, close() {} }; return null; }
  try {
    await host.render(Probe, props); const form = element(tree, item => item.type === "form");
    await host.act(() => { form.props.onSubmit({ preventDefault() {} }); form.props.onSubmit({ preventDefault() {} }); });
    assert.equal(calls, 1); assert.equal(element(tree, item => item.type === "form").props["aria-busy"], true);
    await host.act(async () => { resolve(); }); await flush(host);
    await host.render(Probe, { ...props, onSave: async () => { throw Object.assign(new Error("conflict"), { status: 409 }); } });
    await host.act(() => element(tree, item => item.type === "form").props.onSubmit({ preventDefault() {} })); await flush(host);
    assert.match(element(tree, item => item.props?.role === "alert").props.children, /草稿已保留/);
    assert.equal(element(tree, item => item.type === "input" && item.props.maxLength === 100).props.value, task.title);
  } finally { await host.close(); }
});

test("actual Widget note edits remain local until blur and failed commit keeps text and version", async () => {
  const host = await hookHost(); let tree; let calls = 0; let submittedVersion;
  function Probe() { tree = AsyncWidgetNote({ widget: { config: { text: "old" } }, version: 3, readOnly: false, onConfigure: async (_patch, version) => { calls++; submittedVersion = version; return false; } }); return null; }
  try {
    await host.render(Probe); await host.act(() => element(tree, item => item.type === "textarea").props.onChange({ target: { value: "draft" } })); assert.equal(calls, 0);
    await host.act(() => element(tree, item => item.type === "textarea").props.onBlur()); await flush(host);
    assert.equal(calls, 1); assert.equal(submittedVersion, 3); assert.equal(element(tree, item => item.type === "textarea").props.value, "draft");
    assert.ok(element(tree, item => item.props?.role === "alert"));
  } finally { await host.close(); }
});
