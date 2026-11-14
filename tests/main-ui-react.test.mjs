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
