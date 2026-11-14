import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useAsyncDraft } from "../src/hooks/use-async-draft.mjs";
import { hookHost } from "./helpers/react-hook-host.mjs";
import { releaseFixture } from "./helpers/release-fixture.mjs";
import { projectWorkspaceForUi } from "../src/lib/client/workspace-projection.mjs";
import { ManagedWorkspacePreview } from "../src/components/managed-workspace-preview.mjs";
import { workspaceFixture } from "./phase4a-fixtures.mjs";
import { createApi } from "../src/lib/api/handlers.mjs";
import { createSlowlyApi } from "../src/lib/client/slowly-api.mjs";
import { useSlowlyWidgets } from "../src/hooks/use-slowly-api.mjs";

test("async form retains 409/network draft, rejects duplicate save, and ignores old Board completion", async () => {
  const host = await hookHost(); let state; let resolve;
  function Probe() { state = useAsyncDraft(); return null; }
  try {
    await host.render(Probe); await host.act(() => state.open("A", { title: "draft", version: 2 }));
    await host.act(async () => { await assert.rejects(state.save(async () => { throw Object.assign(new Error("conflict"), { status: 409 }); })); });
    assert.equal(state.status, "conflict"); assert.equal(state.draft.title, "draft");
    await host.act(async () => { await assert.rejects(state.save(async () => { throw Object.assign(new Error("lost response"), { outcome: "not-confirmed" }); })); });
    assert.equal(state.status, "not-confirmed");
    let pending; await host.act(() => { pending = state.save(() => new Promise(done => { resolve = done; })); });
    await assert.rejects(state.save(async () => {}));
    await host.act(() => state.open("B", { title: "new board", version: 1 }));
    await host.act(async () => { resolve({ version: 3 }); await pending; });
    assert.equal(state.scope, "B"); assert.equal(state.status, "editing"); assert.equal(state.draft.title, "new board");
    await host.act(async () => { await state.save(async () => ({ version: 2 })); }); assert.equal(state.status, "success");
    await host.act(() => { pending = state.save(() => new Promise(done => { resolve = done; })); });
    await host.act(() => state.cancel()); assert.equal(state.status, "not-confirmed");
    await host.act(async () => { resolve({ version: 3 }); await pending; }); assert.equal(state.status, "not-confirmed");
  } finally { await host.close(); }
});

test("localStorage fixture → migration → managed React review preserves widgets and unknown config on PATCH", async () => {
  const data = workspaceFixture(); delete data.boards[1].widgets;
  data.boards.push({ ...structuredClone(data.boards[1]), id: "empty", tasks: [], widgets: [] });
  data.boards[0].widgets[0].config.extension = { text: "keep-unknown" };
  const f = releaseFixture({ data }); await f.apply(); await f.finish();
  const projection = projectWorkspaceForUi(f.plan.operations.map(op => f.db.items.get(op.targetId)));
  assert.deepEqual(projection.workspace, data);
  const html = renderToStaticMarkup(createElement(ManagedWorkspacePreview, { projection }));
  assert.match(html, /Widget 缺省/); assert.match(html, /Widget 空清單/); assert.match(html, /keep-unknown/);
  const origin = "http://127.0.0.1:3000"; const handlers = createApi("widgets", { getRepository: async () => f.repository, configuration: () => ({ NODE_ENV: "development", SLOWLY_LOCAL_API: "1" }) });
  const api = createSlowlyApi({ fetchImpl: async (path, init) => {
    const url = new URL(path, origin); const id = url.pathname.split("/")[3];
    return handlers[id ? "itemPatch" : "collectionGet"](new Request(url, { ...init, headers: { ...init.headers, host: "127.0.0.1:3000", origin } }), { params: Promise.resolve({ id: id && decodeURIComponent(id) }) });
  } });
  const board = f.plan.operations.find(op => op.type === "BOARD").targetId; const root = f.plan.operations[0].targetId;
  const host = await hookHost(); let resource;
  function Probe() { resource = useSlowlyWidgets({ api, mode: "api", apiReady: true, allowWrites: true, workspaceId: root, boardId: board }); return null; }
  try {
    await host.render(Probe); for (let i = 0; i < 10; i++) await host.act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    assert.equal(resource.data[0].data.config.extension.text, "keep-unknown");
    await host.act(() => resource.update(resource.data[0].id, { version: resource.data[0].version, data: { config: { text: "edited" } } }));
    assert.equal(resource.data[0].data.config.extension.text, "keep-unknown"); assert.equal(resource.data[0].data.config.text, "edited");
  } finally { await host.close(); }
});
