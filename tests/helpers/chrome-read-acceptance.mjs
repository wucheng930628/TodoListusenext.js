import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function checkChromeRead({ origin, workspaceId, secondWorkspaceId, deniedId, injectConflict, writeScenario, expectedBoardName }) {
  const binary = [process.env.SLOWLY_CHROME_BIN, ...[process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
    .filter(Boolean).map(root => join(root, "Google", "Chrome", "Application", "chrome.exe"))].find(path => path && existsSync(path));
  assert.ok(binary, "Chrome binary missing; set SLOWLY_CHROME_BIN");
  const temporaryRoot = realpathSync(tmpdir());
  const profile = mkdtempSync(join(temporaryRoot, "slowly-d1-chrome-"));
  const browser = spawn(binary, ["--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`,
    "--no-first-run", "--disable-background-networking", "--window-size=1440,1000"],
  { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true });
  const pending = new Map();
  const requests = [];
  const responses = [];
  let seq = 0;
  let buffer = "";
  let sessionId;
  browser.stdio[4].setEncoding("utf8").on("data", chunk => {
    buffer += chunk;
    const messages = buffer.split("\0"); buffer = messages.pop();
    for (const raw of messages) {
      const message = JSON.parse(raw);
      if (message.method === "Network.requestWillBeSent") requests.push(message.params.request);
      if (message.method === "Network.responseReceived") responses.push(message.params.response);
      const finish = pending.get(message.id);
      if (finish) finish(message);
    }
  });
  function send(method, params = {}, session = sessionId) {
    const id = ++seq;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => { pending.delete(id); fail(new Error(`Chrome command timed out: ${method}`)); }, 15000);
      pending.set(id, message => {
        clearTimeout(timer); pending.delete(id);
        if (message.error) fail(new Error(message.error.message));
        else done(message.result);
      });
      browser.stdio[3].write(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }) + "\0");
    });
  }
  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "Browser evaluation failed");
    return result.result.value;
  };
  async function until(expression) {
    for (let attempt = 0; attempt < 110; attempt++) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await delay(150);
    }
    const alerts = await evaluate("[...document.querySelectorAll('[role=alert]')].map(item => item.textContent)");
    throw new Error(`Browser assertion timed out: ${expression}; alerts: ${JSON.stringify(alerts)}`);
  }
  const activate = async workspace => {
    await evaluate(`(() => {
    const field = document.querySelector('[aria-label="API Workspace ID"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ${JSON.stringify(workspace)});
    field.dispatchEvent(new Event('input', {bubbles:true}));
    const ready = field.form.querySelector('[type="checkbox"]');
    if (!ready.checked) ready.click();
    })()`);
    await evaluate(`document.querySelector('[aria-label="API Workspace ID"]').form.requestSubmit()`);
  };
  const text = value => `document.body?.innerText.includes(${JSON.stringify(value)})`;
  try {
    const version = await send("Browser.getVersion");
    assert.match(version.product, /Chrome/);
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    ({ sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }));
    await send("Page.enable");
    await send("Network.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", { source: `
      if (location.origin === ${JSON.stringify(origin)} && !sessionStorage.getItem("d1-fixture")) {
        localStorage.setItem("slowly-workspace-v2", JSON.stringify({activeBoardId:"local-d1",boards:[
          {id:"local-d1",name:"D1 Local Board",description:"",wipLimit:4,tasks:[],widgets:[]}
        ]}));
        sessionStorage.setItem("d1-fixture","1");
      }
    ` });
    await send("Page.navigate", { url: origin });
    await until(text("D1 Local Board"));
    await until("!document.querySelector('.source-controls [role=alert]')");
    const initialStorage = await evaluate("localStorage.getItem('slowly-workspace-v2')");
    await evaluate("document.querySelector('.source-controls details').open = true");
    await activate(workspaceId);
    await until(text("API · 唯讀"));
    await until(text("D1 first task"));
    assert.equal(await evaluate(`document.querySelector('h1').textContent`), expectedBoardName);
    assert.equal(await evaluate(`[...document.querySelectorAll('.task-card')].map(el=>el.innerText).filter(t=>t.includes('D1')).map(t=>t.includes('first')?'first':'second').join(',')`), "first,second");
    assert.ok(await evaluate(`[...document.querySelectorAll('.column.todo .task-card')].some(el=>el.innerText.includes('D1 first task'))`));
    assert.ok(await evaluate(`document.querySelector('time[datetime="2026-11-25T10:30"]') !== null`));
    assert.ok(await evaluate(`[...document.querySelectorAll('textarea')].some(el=>el.value==='D1 saved note' && el.readOnly)`));
    assert.ok(await evaluate(`!document.querySelector('[aria-label="授權寫入 Workspace ID"]')`));
    await activate(deniedId);
    await until("Array.from(document.querySelectorAll('[role=alert]')).some(el=>el.textContent.includes('404'))");
    assert.ok(await evaluate(text("D1 first task")));
    await injectConflict(true);
    await evaluate(`[...document.querySelectorAll('button')].find(el=>el.textContent==='重新讀取 API 資料').click()`);
    await until("Array.from(document.querySelectorAll('[role=alert]')).some(el=>el.textContent.includes('409'))");
    assert.ok(await evaluate(text("D1 first task")));
    assert.ok(await evaluate(text("目前顯示上次成功讀取的 API 資料")));
    await injectConflict(false);
    await activate(secondWorkspaceId);
    await until(text("目前沒有看板"));
    assert.ok(!(await evaluate(text("D1 first task"))));
    await send("Page.reload");
    await until(text("D1 Local Board"));
    assert.equal(await evaluate("localStorage.getItem('slowly-workspace-v2')"), initialStorage);
    assert.ok(responses.some(response => response.url.includes(encodeURIComponent(workspaceId)) && response.status === 200));
    assert.ok(responses.some(response => response.url.includes(encodeURIComponent(secondWorkspaceId)) && response.status === 200));
    const apiRequests = requests.filter(request => request.url.startsWith(origin + "/api/"));
    assert.ok(apiRequests.length >= 4 && apiRequests.every(request => request.method === "GET"));
    if (writeScenario) {
      await writeScenario({ send, evaluate, until, activate, requests, responses, text });
      assert.equal(await evaluate("localStorage.getItem('slowly-workspace-v2')"), initialStorage);
    }
    return { browser: version.product, apiGetCount: apiRequests.length };
  } finally {
    try { await injectConflict(false); await send("Browser.close", {}, null); }
    catch { browser.kill(); }
    if (browser.exitCode === null && browser.signalCode === null) await once(browser, "exit");
    if (existsSync(profile)) {
      assert.equal(dirname(realpathSync(profile)), temporaryRoot);
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    }
  }
}
