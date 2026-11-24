import assert from "node:assert/strict";

export async function checkChromeOrder({ send, evaluate, until, activate, requests, responses, text }, { origin, workspaceId, boardId, extraBoardId, view, replay, assertStored, changeTaskVersion }) {
  const selector = value => `document.querySelector(${JSON.stringify(value)})`;
  const idle = `!${text("API 讀取中")} && !${text("API 儲存中")}`;
  const chronological = rows => [...rows].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const board = view => view.boards.find(entry => entry.board.id === boardId);
  async function open() {
    await until(selector(".source-controls details"));
    await until(`!document.querySelector('.source-controls [role=alert]') || ${text(`請明確選擇 ${workspaceId}`)}`);
    await evaluate("document.querySelector('.source-controls details').open = true");
    await activate(workspaceId);
    await until(text("API · 唯讀"));
    await until(idle);
  }
  async function authorize() {
    await evaluate(`(() => {
      const field = document.querySelector('[aria-label="授權寫入 Workspace ID"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ${JSON.stringify(workspaceId)});
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await evaluate(`document.querySelector('[aria-label="授權寫入 Workspace ID"]').form.requestSubmit()`);
    await until(text("API · 已授權寫入"));
  }
  async function drag(from, to) {
    await evaluate(`(() => {
      const transfer = new DataTransfer();
      for (const [name, target] of [['dragstart', ${from}], ['dragover', ${to}], ['drop', ${to}]]) {
        if (!target) throw new Error('Ordering element missing');
        target.dispatchEvent(new DragEvent(name, { bubbles: true, cancelable: true, dataTransfer: transfer }));
      }
    })()`);
  }
  const named = (query, name) => `[...document.querySelectorAll(${JSON.stringify(query)})].find(el=>el.innerText.includes(${JSON.stringify(name)}))`;
  const task = name => `(${named(".task-card", name)})`;
  const taskOrder = `[...document.querySelectorAll('.column.todo .task-title')].map(el=>el.textContent).filter(name=>name.startsWith('D1')).join('|')`;
  await send("Page.navigate", { url: origin + "/dev/main-api?order=1" });
  await until("location.search === '?order=1'");
  await open();
  await authorize();
  const initial = await view();
  const activeName = board(initial).board.data.name;
  await drag(named(".board-link", "D3 Board"), named(".board-link", activeName));
  await until(`document.querySelector('.board-link').innerText.includes('D3 Board') && ${idle}`);
  let latest = await view();
  assert.equal(chronological(latest.boards.map(entry => entry.board))[0].id, extraBoardId);
  assert.equal(latest.workspace.version, initial.workspace.version + 1);

  const beforeTask = board(latest);
  await drag(task("D1 second task"), task("D1 first task"));
  await until(`${taskOrder} === 'D1 second task|D1 first task' && ${idle}`);
  latest = await view();
  assert.equal(board(latest).board.version, beforeTask.board.version + 1);
  assert.equal(chronological(board(latest).tasks).find(row => row.data.id.startsWith("d1-")).data.id, "d1-second");
  const sent = requests.filter(row => row.url.endsWith("/api/tasks/order")).at(-1);
  const repeated = await replay(sent);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.headers.get("idempotency-status"), "replayed");
  assert.deepEqual(board(await view()), board(latest));

  const originalTask = board(latest).tasks.find(row => row.data.id === "d1-first");
  await changeTaskVersion(originalTask.id);
  await drag(task("D1 first task"), task("D1 second task"));
  await until(`${text("API · 唯讀")} && ${idle}`);
  assert.ok(responses.some(row => row.url.endsWith("/api/tasks/order") && row.status === 409));
  assert.equal(await evaluate(taskOrder), "D1 second task|D1 first task");
  await authorize();

  const widgets = ".dashboard-widget";
  const widgetOrder = `[...document.querySelectorAll('.dashboard-widget')].map(el=>el.getAttribute('aria-label')).join('|')`;
  const originalOrder = (await evaluate(widgetOrder)).split("|");
  assert.ok(originalOrder.length >= 2);
  await evaluate(`(() => {
    const network = window.fetch;
    window.fetch = async (url, options) => {
      if (String(url).startsWith('/api/operations/')) {
        document.documentElement.dataset.d3ReceiptMiss = 'true';
        return new Response(JSON.stringify({error:{code:'OPERATION_NOT_FOUND'}}), {status:404});
      }
      const response = await network(url, options);
      if (String(url).endsWith('/api/widgets/order') && response.ok) throw new TypeError('D3 response lost after commit');
      return response;
    };
  })()`);
  const handle = selector(widgets + ":last-child .widget-drag");
  await drag(handle, selector(widgets + ":nth-child(1)"));
  await until(`document.documentElement.dataset.d3ReceiptMiss === 'true' && ${text("寫入結果尚未確認")}`);
  assert.equal(await evaluate(widgetOrder), originalOrder.join("|"));
  const oldDocument = await evaluate("performance.timeOrigin");
  await send("Page.reload");
  await until(`performance.timeOrigin !== ${oldDocument}`);
  await open();
  const movedOrder = [originalOrder.at(-1), ...originalOrder.slice(0, -1)];
  await until(`${widgetOrder} === ${JSON.stringify(movedOrder.join("|"))} && !${text("寫入結果尚未確認")}`);
  assert.equal(requests.filter(row => row.url.endsWith("/api/widgets/order")).length, 1);
  assert.ok(responses.some(row => row.status === 200 && row.url.includes("/api/operations/") && row.url.includes("resource=widgets")));
  latest = await view();
  assert.equal(chronological(board(latest).widgets)[0].data.id, "d3-widget");
  assert.equal(await evaluate(taskOrder), "D1 second task|D1 first task");
  assert.ok(await evaluate(`document.querySelector('.board-link').innerText.includes('D3 Board')`));
  await authorize();
  await evaluate(`(() => {
    const field = ${task("D1 first task")}.querySelector('select');
    field.value = 'done';
    field.dispatchEvent(new Event('change', { bubbles:true }));
  })()`);
  await until(`${selector(".column.done")}?.innerText.includes('D1 first task') && ${idle}`);
  latest = await view();
  assert.equal(board(latest).tasks.find(row => row.id === originalTask.id).data.status, "done");
  await assertStored([latest.workspace, ...latest.boards.flatMap(entry => [entry.board, ...entry.tasks, ...entry.widgets])]);
  const refreshButton = `[...document.querySelectorAll('button')].find(button=>button.textContent==='重新讀取 API 資料')`;
  const network = offline => send("Network.emulateNetworkConditions", { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await network(true);
  try {
    await evaluate(`${refreshButton}.click()`);
    await until(text("無法連線到 API"));
    assert.ok(await evaluate(`${selector(".column.done")}?.innerText.includes('D1 first task')`));
    assert.ok(await evaluate(text("目前顯示上次成功讀取的 API 資料")));
  } finally {
    await network(false);
  }
  await evaluate(`${refreshButton}.click()`);
  await until(`${idle} && !${text("無法連線到 API")}`);
  assert.deepEqual((await view()).boards, latest.boards);
}
