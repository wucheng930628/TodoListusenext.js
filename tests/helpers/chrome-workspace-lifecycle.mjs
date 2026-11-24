import assert from "node:assert/strict";

export async function checkChromeLifecycle({ send, evaluate, until, activate, requests, responses, text }, { origin, get, restart }) {
  const firstRequest = requests.length;
  const firstResponse = responses.length;
  const path = (resource, id) => `/api/${resource}/${encodeURIComponent(id)}`;
  const view = id => path("workspaces", id) + "/view";
  const heading = name => `document.querySelector('h1')?.textContent === ${JSON.stringify(name)}`;
  async function http(method, url, input, status) {
    const result = await evaluate(`(async () => {
      const response = await fetch(${JSON.stringify(url)}, ${method === "GET" ? "{}" : `{
        method: ${JSON.stringify(method)}, body: ${JSON.stringify(JSON.stringify(input))},
        headers: {'Content-Type':'application/json', 'Idempotency-Key':crypto.randomUUID()}
      }`});
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    })()`);
    assert.equal(result.status, status, JSON.stringify(result.body));
    return result.body?.data;
  }
  const read = id => http("GET", view(id), null, 200);
  const create = (resource, input) => http("POST", `/api/${resource}`, input, 201);
  const update = (resource, item, scope, data) => http("PATCH", path(resource, item.id), { ...scope, version: item.version, data }, 200);
  const remove = (resource, item, scope) => http("DELETE", path(resource, item.id), { ...scope, version: item.version }, 204);
  const storage = () => evaluate(`['slowly-workspace-v2','slowly-board-v1'].map(key=>localStorage.getItem(key))`);
  async function open(url) {
    const previous = await evaluate("performance.timeOrigin");
    await send("Page.navigate", { url });
    await until(`performance.timeOrigin !== ${previous} && !!document.querySelector('.source-controls details')`);
    await until("!document.querySelector('.source-controls [role=alert]')");
    await evaluate("document.querySelector('.source-controls details').open = true");
  }

  await open(origin);
  await until(heading("D1 Local Board"));
  const beforeStorage = await storage();
  const beforeLocal = requests.length;
  await evaluate("document.querySelector('.heading-actions .primary').click()");
  await until("!!document.querySelector('.task-panel-title input')");
  await evaluate("document.querySelector('.task-panel-title input').focus()");
  await send("Input.insertText", { text: "D4 local-only task" });
  await evaluate("document.querySelector('.task-panel form').requestSubmit()");
  await until(text("D4 local-only task"));
  await until("localStorage.getItem('slowly-workspace-v2').includes('D4 local-only task')");
  assert.ok(!requests.slice(beforeLocal).some(request => request.url.includes("/api/")));
  const savedLocal = await storage();
  assert.equal(savedLocal[1], beforeStorage[1]);

  const a = await create("workspaces", { data: { name: "D4 Workspace A" } });
  const b = await create("workspaces", { data: { name: "D4 Workspace B" } });
  async function seed(workspaceId, label) {
    const boardSpec = name => ({ id: name, name, description: "", wipLimit: 4 });
    const first = await create("boards", { workspaceId, position: 0, data: boardSpec(`D4 ${label} first board`) });
    const second = await create("boards", { workspaceId, position: 1, data: boardSpec(`D4 ${label} active board`) });
    const scope = { workspaceId, boardId: second.id };
    for (const position of [0, 1]) {
      await create("tasks", { ...scope, position, data: { id: `task-${position}`, title: `D4 ${label} task ${position}`, status: "todo" } });
      await create("widgets", { ...scope, position, data: { id: `widget-${position}`, type: "note", span: 6, height: 240, config: { text: `D4 ${label} note ${position}` } } });
    }
    const snapshot = await read(workspaceId);
    await update("workspaces", snapshot.workspace, {}, { activeBoardId: second.data.id, settings: { layout: "compact" } });
    return { first, second, scope };
  }
  const left = await seed(a.id, "A");
  const right = await seed(b.id, "B");
  await http("POST", "/api/tasks", { workspaceId: a.id, boardId: right.second.id,
    position: 3, data: { id: "foreign-task", title: "Foreign task", status: "todo" } }, 403);
  const main = (snapshot, boardId) => snapshot.boards.find(entry => entry.board.id === boardId);
  let initial = await read(a.id);
  const leftBoard = main(initial, left.second.id);
  await update("boards", leftBoard.board, { workspaceId: a.id }, { description: "D4 Board description", wipLimit: 5 });
  await update("tasks", leftBoard.tasks[0], left.scope, { date: "2026-12-01" });
  await update("widgets", leftBoard.widgets[0], left.scope, { config: { text: "D4 A updated note" } });
  for (const [resource, scope] of [["boards", { workspaceId: a.id }], ["tasks", left.scope], ["widgets", left.scope]]) {
    initial = await read(a.id);
    const rows = resource === "boards" ? initial.boards.map(entry => entry.board) : main(initial, left.second.id)[resource];
    const entries = [...rows].reverse().map(({ id, version }, position) => ({ id, version, position }));
    await http("PATCH", `/api/${resource}/order`, { ...scope, entries }, 200);
  }

  await activate(a.id);
  await until(heading(left.second.data.name));
  await until(text("API · 唯讀"));
  assert.ok(!(await evaluate(text("D4 local-only task"))));
  assert.ok(await evaluate(text("D4 A task 0")));
  assert.ok(await evaluate("[...document.querySelectorAll('.dashboard-widget textarea')].some(el=>el.value==='D4 A updated note' && el.readOnly)"));
  await evaluate(`(() => {
    const native = window.fetch;
    window.fetch = async (url, options) => {
      if (url !== ${JSON.stringify(view(a.id))}) return native(url, options);
      window.fetch = native;
      const response = await native(url, {...options,signal:undefined});
      await new Promise(resolve => { window.releaseD4 = resolve; });
      return response;
    };
  })()`);
  await evaluate("[...document.querySelectorAll('button')].find(el=>el.textContent==='重新讀取 API 資料').click()");
  await until("typeof window.releaseD4 === 'function'");
  assert.ok(await evaluate("!document.querySelector('[aria-label=\"API Workspace ID\"]').form.querySelector('button[type=submit]').disabled"));
  await activate(b.id);
  await until(heading(right.second.data.name));
  await evaluate("window.releaseD4(); new Promise(resolve=>setTimeout(resolve,200))");
  assert.ok(await evaluate(heading(right.second.data.name)));
  assert.ok(await evaluate(text("D4 B task 0")));
  assert.ok(!(await evaluate(text("D4 A task"))));
  assert.ok(!(await evaluate(text("D4 A first board"))));
  assert.ok(await evaluate("[...document.querySelectorAll('.dashboard-widget textarea')].every(el=>el.value.startsWith('D4 B note'))"));
  await activate(a.id);
  await until(heading(left.second.data.name));
  const persisted = await read(a.id);

  async function reload() {
    await open(origin);
    await until(heading("D1 Local Board"));
    assert.deepEqual(await storage(), savedLocal);
    await activate(a.id);
    await until(heading(left.second.data.name));
  }
  await reload();
  const reloaded = await read(a.id);
  assert.deepEqual(reloaded.workspace, persisted.workspace);
  assert.deepEqual(reloaded.boards, persisted.boards);
  await open(origin + "/dev/main-api");
  await activate(a.id);
  await until(heading(left.second.data.name));
  await until(text("API · 唯讀"));
  assert.ok(await evaluate("document.querySelector('.heading-actions .primary').disabled"));
  await evaluate(`(() => {
    const field = document.querySelector('[aria-label="授權寫入 Workspace ID"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ${JSON.stringify(a.id)});
    field.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await evaluate("document.querySelector('[aria-label=\"授權寫入 Workspace ID\"]').form.requestSubmit()");
  await until(text("API · 已授權寫入"));
  async function drag(from, to, expectedFirst, url) {
    const start = requests.length;
    await evaluate(`(() => {
      const dataTransfer = new DataTransfer();
      for (const [type, selector] of [['dragstart', ${JSON.stringify(from)}], ['dragover', ${JSON.stringify(to)}], ['drop', ${JSON.stringify(to)}]]) {
        document.querySelector(selector).dispatchEvent(new DragEvent(type, {bubbles:true,cancelable:true,dataTransfer}));
      }
    })()`);
    await until(`(${expectedFirst}) && ${text("API · 已授權寫入")}`);
    assert.ok(requests.slice(start).some(request => request.method === "PATCH" && request.url.endsWith(url)));
  }
  await drag(".board-link:nth-child(2)", ".board-link:first-child",
    "document.querySelector('.board-link').innerText.includes('D4 A first board')", "/api/boards/order");
  await drag(".column.todo .task-card:nth-child(2)", ".column.todo .task-card:first-child",
    "document.querySelector('.column.todo .task-card').innerText.includes('D4 A task 0')", "/api/tasks/order");
  await drag(".dashboard-widget:nth-child(2) .widget-drag", ".dashboard-widget:first-child",
    "document.querySelector('.dashboard-widget textarea').value==='D4 A updated note'", "/api/widgets/order");
  await evaluate("document.querySelector('[aria-label=\"編輯 D4 A task 1\"]').click()");
  await until("!!document.querySelector('.task-panel input[type=date]')");
  await evaluate(`(() => {
    const field = document.querySelector('.task-panel input[type=date]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, '2026-12-02');
    field.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await evaluate("const d4Status = document.querySelector('.task-panel select'); d4Status.value = 'done'; d4Status.dispatchEvent(new Event('change',{bubbles:true}))");
  await evaluate("document.querySelector('.task-panel form').requestSubmit()");
  await until("!document.querySelector('.task-panel') && !!document.querySelector('time[datetime=\"2026-12-02\"]')");
  await reload();
  await until("!!document.querySelector('time[datetime=\"2026-12-02\"]')");
  const last = await read(a.id);
  for (const snapshot of [last, await read(b.id)]) {
    assert.equal((await get(snapshot.workspace.id)).boardCount, snapshot.boards.length);
    for (const { board, tasks, widgets } of snapshot.boards) {
      const stored = await get(board.id);
      assert.equal(stored.taskCount, tasks.length);
      assert.equal(stored.widgetCount, widgets.length);
      assert.equal(stored.doingCount, tasks.filter(item => item.data.status === "doing").length);
    }
    for (const item of [snapshot.workspace, ...snapshot.boards.flatMap(entry => [entry.board, ...entry.tasks, ...entry.widgets])]) {
      const stored = await get(item.id);
      for (const key of ["data", "version", "position", "workspaceId", "boardId"]) assert.deepEqual(stored[key], item[key]);
    }
  }
  assert.equal(main(last, left.second.id).tasks.length, 2);
  assert.ok(main(last, left.second.id).tasks.find(task => task.data.id === "task-1").data.completedAt);
  assert.ok(await evaluate("document.querySelector('.board-link').innerText.includes('D4 A first board')"));
  assert.ok(await evaluate("document.querySelector('.dashboard-widget textarea').value==='D4 A updated note'"));
  assert.deepEqual(await storage(), savedLocal);
  if (restart) {
    const beforeRestart = [last, await read(b.id)];
    const ids = beforeRestart.flatMap(snapshot => [snapshot.workspace.id,
      ...snapshot.boards.flatMap(({ board, tasks, widgets }) => [board.id, ...tasks.map(row => row.id), ...widgets.map(row => row.id)])]);
    const records = await Promise.all(ids.map(get));
    await restart();
    assert.deepEqual(await Promise.all(ids.map(get)), records);
    await reload();
    for (const before of beforeRestart) {
      const after = await read(before.workspace.id);
      assert.deepEqual(after.workspace, before.workspace);
      assert.deepEqual(after.boards, before.boards);
    }
    await until("!!document.querySelector('time[datetime=\"2026-12-02\"]')");
  }

  for (const workspace of [a, b]) {
    const snapshot = await read(workspace.id);
    for (const entry of snapshot.boards) {
      const scope = { workspaceId: workspace.id, boardId: entry.board.id };
      for (const task of entry.tasks) await remove("tasks", task, scope);
      for (const widget of entry.widgets) await remove("widgets", widget, scope);
      const latest = main(await read(workspace.id), entry.board.id);
      await remove("boards", latest.board, { workspaceId: workspace.id });
      assert.equal(await get(entry.board.id), undefined);
      for (const item of [...entry.tasks, ...entry.widgets]) assert.equal(await get(item.id), undefined);
    }
    await remove("workspaces", (await read(workspace.id)).workspace, {});
    await http("GET", view(workspace.id), null, 404);
    assert.equal(await get(workspace.id), undefined);
  }
  const writes = requests.slice(firstRequest).filter(request => ["POST", "PATCH", "DELETE"].includes(request.method) && request.url.includes("/api/"));
  const successful = new Map(responses.slice(firstResponse).filter(response => response.status >= 200 && response.status < 300)
    .map(response => [new Headers(response.headers).get("operation-id"), response]));
  let receipts = 0;
  for (const request of writes) {
    const key = new Headers(request.headers).get("idempotency-key");
    assert.ok(key);
    if (JSON.parse(request.postData).data?.id === "foreign-task") {
      assert.equal(await get(`SLOWLY#CRUD_OPERATION#${key}`), undefined);
      continue;
    }
    assert.ok(successful.has(key), `Missing HTTP confirmation for ${request.method} ${request.url}`);
    const receipt = await get(`SLOWLY#CRUD_OPERATION#${key}`);
    const resource = new URL(request.url).pathname.split("/")[2];
    const action = request.url.endsWith("/order") ? "ORDER" : { POST: "CREATE", PATCH: "UPDATE", DELETE: "DELETE" }[request.method];
    assert.equal(receipt.state, "CONFIRMED");
    assert.equal(receipt.resource, resource);
    assert.equal(receipt.action, action);
    if (action === "DELETE") assert.equal(receipt.result, null);
    else if (action === "ORDER") assert.ok(receipt.result.every(row => Number.isSafeInteger(row.version)));
    else assert.ok(receipt.result.version >= 1);
    receipts++;
  }
  return { workspaces: 2, boards: 4, tasks: 4, widgets: 4, reloads: restart ? 3 : 2, receipts,
    serverRestarted: Boolean(restart), lateResponseIgnored: true, isolatedSources: true, cleanup: true };
}
