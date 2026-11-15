import test from "node:test";
import assert from "node:assert/strict";
import { createElement, StrictMode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import WorkspaceBackupTool from "../src/components/workspace-backup-tool.js";
import { sealBackup } from "../src/lib/client/verified-backup.mjs";
import { captureWorkspaceBackup } from "../src/lib/client/workspace-backup.mjs";
import { workspaceFixture, storageFixture, createdAt } from "./phase4a-fixtures.mjs";
import { hookHost } from "./helpers/react-hook-host.mjs";

function nodes(node) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}

test("backup SSR and StrictMode mount perform zero storage reads or downloads", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("unexpected storage read"); } });
  const host = await hookHost(); let tree; let captures = 0; let downloads = 0;
  const props = { capture: async () => { captures++; }, download: () => { downloads++; } };
  function Probe() { tree = WorkspaceBackupTool(props); return null; }
  function Strict() { return createElement(StrictMode, null, createElement(Probe)); }
  try {
    assert.match(renderToStaticMarkup(createElement(WorkspaceBackupTool)), /本機資料備份/);
    await host.render(Strict);
    const button = nodes(tree).find(node => node.type === "button"); assert.equal(button.props.disabled, true);
    await host.act(() => button.props.onClick()); assert.equal(captures, 0); assert.equal(downloads, 0);
  } finally {
    await host.close();
    if (previous) Object.defineProperty(globalThis, "localStorage", previous); else delete globalThis.localStorage;
  }
});

test("explicit consent exports verified artifact and explicit file selection verifies locally", async () => {
  const artifact = await sealBackup(captureWorkspaceBackup({ storage: storageFixture({ "slowly-workspace-v2": JSON.stringify(workspaceFixture()) }), createdAt }), "http://localhost:3000");
  const host = await hookHost(); let tree; let captures = 0; let downloads = 0;
  const find = predicate => { const value = nodes(tree).find(predicate); assert.ok(value); return value; };
  function Probe() { tree = WorkspaceBackupTool({ capture: async () => { captures++; return artifact; }, download: value => { downloads++; assert.deepEqual(value, artifact); } }); return null; }
  try {
    globalThis.window.location = { origin: "http://localhost:3000" };
    await host.render(Probe);
    await host.act(() => find(node => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: true } }));
    await host.act(() => find(node => node.type === "button").props.onClick());
    assert.equal(captures, 1); assert.equal(downloads, 1);
    assert.match(renderToStaticMarkup(tree), new RegExp(artifact.integrity.fingerprint));
    const event = { target: { files: [{ text: async () => JSON.stringify(artifact) }], value: "chosen.json" } };
    await host.act(() => find(node => node.type === "input" && node.props.type === "file").props.onChange(event));
    assert.equal(event.target.value, ""); assert.equal(captures, 1); assert.equal(downloads, 1);
    assert.match(renderToStaticMarkup(tree), /檔案 Fingerprint 與原始 JSON 往返驗證通過/);
  } finally { await host.close(); }
});
