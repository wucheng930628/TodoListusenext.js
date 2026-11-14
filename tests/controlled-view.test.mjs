import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControlledApiBoard, ResourceEditor } from "../src/app/dev/api-board/view.mjs";
import { hookHost } from "./helpers/react-hook-host.mjs";

test("isolated UI initially renders explicit readiness and readonly controls without fetching or storage", () => {
  const output = renderToStaticMarkup(createElement(ControlledApiBoard, { config: { runId: "test", allowedWorkspaces: [{ id: "test-workspace", name: "Test" }], boardWidgetPresence: {} } }));
  assert.match(output, /localStorage/); assert.match(output, /API Ready/); assert.match(output, /唯讀/);
  assert.match(output, /切回 localStorage Mode/); assert.doesNotMatch(output, /授權本次測試寫入/);
});

test("actual React editor events preserve drafts after 409; clear only after confirmed success", async () => {
  const host = await hookHost(); let tree; let failure = true; let operation; let sent;
  const resource = { success: true, data: [], async create(input) { sent = input; if (failure) throw Object.assign(new Error("conflict"), { status: 409 }); return input; } };
  const run = fn => { operation = fn().catch(() => {}); return operation; };
  function Probe() { tree = ResourceEditor({ label: "任務", kind: "task", resource, disabled: false, run }); return null; }
  const form = () => tree.props.children.find(child => child?.type === "form");
  try {
    await host.render(Probe);
    await host.act(() => form().props.children[0].props.onChange({ target: { value: "Keep draft" } }));
    await host.act(async () => { form().props.onSubmit({ preventDefault() {} }); await operation; });
    assert.equal(form().props.children[0].props.value, "Keep draft"); assert.equal(sent.data.title, "Keep draft");
    failure = false;
    await host.act(async () => { form().props.onSubmit({ preventDefault() {} }); await operation; });
    assert.equal(form().props.children[0].props.value, "");
  } finally { await host.close(); }
});
