import test from "node:test";
import assert from "node:assert/strict";
import WorkspaceBoard from "../src/app/workspace-board.js";
import TaskPanel from "../src/app/task-panel.js";
import { hookHost } from "./helpers/react-hook-host.mjs";
import { workspaceFixture, storageFixture } from "./phase4a-fixtures.mjs";

function findAll(node, check) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(item => findAll(item, check));
  return [...(check(node) ? [node] : []), ...findAll(node.props?.children, check)];
}

test("actual local UI never imports excluded Legacy or writes on mount", async () => {
  const storage = storageFixture({ "slowly-board-v1": JSON.stringify([{ id: "excluded", title: "Legacy" }]) });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage"); Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  const host = await hookHost(); let tree;
  function Probe() { tree = WorkspaceBoard({}); return null; }
  try {
    await host.render(Probe);
    assert.deepEqual(storage.writes, []); assert.equal(storage.values.has("slowly-workspace-v2"), false);
    assert.ok(findAll(tree, node => node.type === "div" && node.props.role === "status").some(node => [node.props.children].flat().some(child => typeof child === "string" && child.includes("Legacy"))));
  } finally { await host.close(); if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor); else delete globalThis.localStorage; }
});

test("actual Task Panel draft blocks Board navigation and preserves typed notes without storage writes", async () => {
  const storage = storageFixture({ "slowly-workspace-v2": JSON.stringify(workspaceFixture()) });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage"); Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  const drafts = new Map(); const guard = { writeDraft: (key, value) => drafts.set(key, value), clearDraft: key => drafts.delete(key), guardSwitch() { if (drafts.size) throw new Error("UNSAVED_DRAFTS"); } };
  const host = await hookHost(); let tree;
  function Probe() { tree = WorkspaceBoard({ navigationGuard: guard }); return null; }
  try {
    await host.render(Probe); assert.deepEqual(storage.writes, []);
    const first = findAll(tree, node => node.type === "button" && node.props.className === "task-title")[0];
    await host.act(() => first.props.onClick());
    const panel = () => findAll(tree, node => node.type === TaskPanel)[0];
    await host.act(() => panel().props.onChange({ ...panel().props.task, notes: "Keep typed notes" }));
    const otherBoard = findAll(tree, node => node.type === "button" && node.props.className?.startsWith("board-link"))[1];
    await host.act(() => otherBoard.props.onClick());
    assert.equal(panel().props.task.notes, "Keep typed notes"); assert.equal(drafts.size, 1); assert.deepEqual(storage.writes, []);
  } finally { await host.close(); if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor); else delete globalThis.localStorage; }
});
