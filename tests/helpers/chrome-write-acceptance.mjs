import assert from "node:assert/strict";

export async function checkChromeWrite({ send, evaluate, until, activate, requests, responses, text }, { origin, workspaceId, view, setGrant, changeTaskVersion }) {
  const selector = value => `document.querySelector(${JSON.stringify(value)})`;
  async function click(value) {
    const element = selector(value);
    await until(`${element} && !${element}.disabled`);
    await evaluate(`${element}.click()`);
  }
  async function input(target, value) {
    const element = selector(target);
    await until(element);
    if (await evaluate(`${element}.tagName === 'TEXTAREA'`)) {
      await evaluate(`${element}.focus(); ${element}.select();`);
      await send("Input.insertText", { text: value });
      return;
    }
    await evaluate(`(() => {
      const field = ${element};
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value').set.call(field, ${JSON.stringify(value)});
      field.dispatchEvent(new Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    })()`);
  }
  async function authorize() {
    const field = '[aria-label="授權寫入 Workspace ID"]';
    await input(field, workspaceId);
    await evaluate(`${selector(field)}.form.requestSubmit()`);
    await until(text("API · 已授權寫入"));
  }
  async function open() {
    await until(selector(".source-controls details"));
    await until("!document.querySelector('.source-controls [role=alert]')");
    await evaluate("document.querySelector('.source-controls details').open = true; window.confirm = () => true;");
    await activate(workspaceId);
    await until(text("API · 唯讀"));
  }
  async function reload() {
    const oldDocument = await evaluate("performance.timeOrigin");
    await send("Page.reload");
    await until(`performance.timeOrigin !== ${oldDocument}`);
    await open();
  }
  const name = "D2 isolated Board";
  const fetchBoard = async () => (await view()).boards.find(row => row.board.data.name === name);
  async function selectBoard() {
    await until(`!${text("API 讀取中")} && !${text("API 儲存中")}`);
    await evaluate(`[...document.querySelectorAll('.board-link')].find(el => el.innerText.includes(${JSON.stringify(name)})).click()`);
    await until(`document.querySelector('h1')?.textContent === ${JSON.stringify(name)}`);
  }
  const taskTitle = ".task-panel-title input";
  const newTask = ".heading-actions button.primary";
  const boardDialog = "dialog[open]";
  const boardSubmit = boardDialog + " button[type=submit]";
  await setGrant(true);
  await send("Page.navigate", { url: origin + "/dev/main-api" });
  await open();
  await authorize();
  await click(".new-board");
  await input(boardDialog + " input", name);
  await click(boardSubmit);
  await until(`${text(name)} && !${selector(boardDialog)}`);
  await selectBoard();
  await authorize();
  await click(".board-settings-button");
  await input(boardDialog + " textarea", "D2 Board description");
  await input(boardDialog + " input[type=number]", "9");
  await click(boardSubmit);
  await until(`${text("D2 Board description")} && !${selector(boardDialog)}`);
  assert.equal((await fetchBoard()).board.data.wipLimit, 9);
  await click(newTask);
  await input(taskTitle, "D2 Task");
  await evaluate(`${selector(taskTitle)}.form.requestSubmit(); ${selector(taskTitle)}.form.requestSubmit();`);
  await until(`${text("D2 Task")} && !${selector(taskTitle)}`);
  assert.equal((await fetchBoard()).tasks.length, 1);
  await click(".task-title");
  await input(taskTitle, "D2 completed Task");
  await input(".task-panel select", "done");
  await input('.task-panel input[type="date"]', "2026-11-30");
  await input(".task-panel textarea[maxlength='5000']", "D2 Task notes");
  await evaluate(`(() => {
    const transport = window.fetch;
    window.fetch = async (...args) => {
      const response = await transport(...args);
      if (args[1]?.method === 'PATCH') { window.fetch = transport; throw new TypeError('D2 simulated lost response after HTTP commit'); }
      return response;
    };
  })()`);
  await evaluate(`${selector(taskTitle)}.form.requestSubmit()`);
  await until(`${text("D2 completed Task")} && !${selector(taskTitle)}`);
  const task = (await fetchBoard()).tasks[0];
  assert.equal(task.data.status, "done");
  assert.equal(task.data.date, "2026-11-30");
  assert.equal(task.data.notes, "D2 Task notes", requests.filter(item => item.method === "PATCH" && item.url.includes("/api/tasks/")).at(-1)?.postData);
  assert.ok(task.data.completedAt);
  assert.ok(requests.some(request => request.method === "GET" && request.url.includes("/api/operations/")));
  await authorize();
  await click(".task-title");
  await input(taskTitle, "D2 draft preserved on conflict");
  await changeTaskVersion(task.id);
  await evaluate(`${selector(taskTitle)}.form.requestSubmit()`);
  await until(`${selector(".task-panel [role=alert]")} && ${text("API · 唯讀")}`);
  assert.equal(await evaluate(`${selector(taskTitle)}.value`), "D2 draft preserved on conflict");
  assert.ok(responses.some(response => response.url.includes("/api/tasks/") && response.status === 409));
  await click('.task-panel [aria-label="關閉任務面板"]');
  await authorize();
  await click(".task-title");
  await input(taskTitle, "D2 forbidden draft");
  await setGrant(false);
  await evaluate(`${selector(taskTitle)}.form.requestSubmit()`);
  await until(selector(".task-panel [role=alert]"));
  assert.ok(responses.some(response => response.url.includes("/api/tasks/") && response.status === 403));
  assert.equal((await fetchBoard()).tasks[0].data.title, "D2 completed Task");
  assert.equal(await evaluate(`${selector(taskTitle)}.value`), "D2 forbidden draft");
  await click('.task-panel [aria-label="關閉任務面板"]');
  await until(`!${selector(taskTitle)}`);
  await setGrant(true);
  await reload();
  await selectBoard();
  await authorize();
  await click(".board-settings-button");
  await click(boardDialog + " .modal-actions button:first-child");
  await until(text("無法刪除"));
  assert.equal((await fetchBoard()).tasks.length, 1);
  await click(boardDialog + " .modal-heading button");
  await click(".task-title");
  await click(".task-panel .delete-button");
  await until(`!${selector(".task-title")}`);
  assert.equal((await fetchBoard()).tasks.length, 0);
  if (!Object.hasOwn((await fetchBoard()).board.data, "widgets") && await evaluate(text("建立統計小組件"))) {
    await evaluate(`[...document.querySelectorAll('button')].find(el=>el.textContent==='建立統計小組件').click()`);
    await until(selector(".dashboard-widget"));
  }
  await click(".dashboard-actions button.secondary");
  await click(".widget-library-card.note button");
  const note = ".dashboard-widget textarea";
  await until(`${selector(note)} && !${selector(note)}.readOnly`);
  await input(note, "D2 saved note");
  await until(`document.querySelector('.dashboard-widget:has(textarea) [role=status]')?.textContent === '未儲存草稿'`);
  await evaluate(`${selector(note)}.blur()`);
  await until(`!document.querySelector('.dashboard-widget:has(textarea) [role=status]') && !${selector(note)}.readOnly`);
  assert.ok((await fetchBoard()).widgets.some(widget => widget.data.config.text === "D2 saved note"));
  await click(".dashboard-widget:has(textarea) button[title='小組件設定']");
  await input(".dashboard-widget:has(textarea) .widget-settings select", "analytics");
  await until("!document.querySelector('.dashboard-widget textarea')");
  const widgets = (await fetchBoard()).widgets;
  assert.ok(widgets.length && widgets.every(widget => widget.data.type === "analytics"));
  const resize = selector(".dashboard-widget .widget-resize");
  await until(`${resize} && !${resize}.disabled`);
  const height = await evaluate(`${resize}.closest('.dashboard-widget').style.height`);
  await evaluate(`${resize}.dispatchEvent(new KeyboardEvent("keydown", {key:"ArrowDown", bubbles:true}))`);
  await until(`${resize}.closest('.dashboard-widget').style.height !== ${JSON.stringify(height)} && !${resize}.disabled`);
  const resized = (await fetchBoard()).widgets;
  assert.ok(resized.some(widget => widget.data.manualSize && widgets.some(before => before.id === widget.id && before.data.height !== widget.data.height)));
  await reload();
  await selectBoard();
  await authorize();
  await until(text("D2 Board description"));
  assert.equal(await evaluate("document.querySelectorAll('.dashboard-widget').length"), widgets.length);
  assert.deepEqual((await fetchBoard()).widgets, resized);
  for (let index = 0; index < widgets.length; index++) {
    await click(".dashboard-widget button[title='移除小組件']");
    await until(`document.querySelectorAll('.dashboard-widget').length === ${widgets.length - index - 1}`);
  }
  await click(".board-settings-button");
  await click(boardDialog + " .modal-actions button:first-child");
  await until(`!${text(name)}`);
  assert.equal(await fetchBoard(), undefined);
  for (const resource of ["boards", "tasks", "widgets"]) {
    const changes = requests.filter(request => request.url.includes(`/api/${resource}`) && request.method !== "GET");
    assert.deepEqual([...new Set(changes.map(request => request.method))].sort(), ["DELETE", "PATCH", "POST"]);
    assert.ok(changes.every(request => Object.entries(request.headers).some(([key, value]) => key.toLowerCase() === "idempotency-key" && /^[a-f0-9-]{36}$/i.test(value))));
  }
  assert.equal(requests.filter(request => request.url.endsWith("/api/tasks") && request.method === "POST").length, 1);
  assert.ok(responses.some(response => response.url.includes("/api/operations/") && response.status === 200));
}
