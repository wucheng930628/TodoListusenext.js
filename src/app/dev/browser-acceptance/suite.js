"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import MainUi from "../../main-ui";
import WorkspaceBoard from "../../workspace-board";
import { createSlowlyApi } from "../../../lib/client/slowly-api.mjs";
import { createRecoveryJournal } from "../../../lib/client/recovery-journal.mjs";

// Real browser / real React / isolated API tests. Results are NOT Cutover authorization.
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const demand = (ok, code) => { if (!ok) throw new Error(code); };
async function until(predicate) { for (let i = 0; i < 200; i++) { const value = predicate(); if (value) return value; await pause(50); } throw new Error("BROWSER_WAIT_TIMEOUT"); }
function metadata(runId, value) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`slowly-browser-acceptance-${runId}`, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onerror = () => reject(new Error("TEST_METADATA_UNAVAILABLE"));
    request.onsuccess = () => {
      const db = request.result; const tx = db.transaction("state", value ? "readwrite" : "readonly"); const store = tx.objectStore("state");
      const read = value ? store.put(value, "progress") : store.get("progress"); let result;
      read.onsuccess = () => { result = read.result; };
      tx.oncomplete = () => { db.close(); resolve(value || result); }; tx.onerror = () => { db.close(); reject(new Error("TEST_METADATA_FAILED")); };
    };
  });
}
function createAcceptanceTransport() {
  const faults = {};
  const api = createSlowlyApi({ fetchImpl: async (path, init) => {
    if (path.startsWith("/api/operations/") && faults.receiptOffline) throw new TypeError("Synthetic receipt network failure");
    const response = await fetch(path, init);
    if (path === "/api/tasks" && init.method === "POST" && faults.loseCreate) {
      await new Promise(resolve => { faults.release = resolve; });
      faults.loseCreate = false; throw new TypeError("Synthetic lost browser response after server commit");
    }
    return response;
  } });
  return { api, armLoss() { faults.loseCreate = true; faults.receiptOffline = true; }, hasHeldRequest: () => Boolean(faults.release), releaseHeldRequest() { faults.release(); } };
}
export default function BrowserAcceptance({ runId, workspaceIds }) {
  const root = useRef(null); const [report, setReport] = useState(null); const [busy, setBusy] = useState(false); const [legacy, setLegacy] = useState(false);
  const transport = useMemo(() => createAcceptanceTransport(), []); const api = transport.api;
  const options = useMemo(() => ({ api, development: true }), [api]);
  useEffect(() => { void metadata(runId).then(value => setReport(value || { phase: "start", checks: {}, status: "NOT TESTED" })); }, [runId]);
  const elements = () => root.current;
  const button = text => [...elements().querySelectorAll("button")].find(node => node.textContent.trim() === text || node.getAttribute("aria-label") === text);
  const input = label => elements().querySelector(`input[aria-label="${label}"]`);
  const type = async (node, value) => {
    demand(node, "INPUT_NOT_FOUND");
    const prototype = node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true })); await pause(100);
  };
  const click = async node => { demand(node && !node.disabled, "BUTTON_NOT_READY"); node.click(); await pause(150); };
  const activate = async id => {
    await type(input("API Workspace ID"), id);
    const checkbox = elements().querySelector('input[type="checkbox"]'); if (!checkbox.checked) await click(checkbox);
    await click(button("啟用唯讀 API Mode")); await until(() => elements().querySelector(".board-nav"));
  };
  const grant = async id => { await type(input("授權寫入 Workspace ID"), id); await click(button("另外授權寫入")); await until(() => !button("＋ 新增任務")?.disabled); };
  async function run() {
    setBusy(true); const current = await metadata(runId) || { phase: "start", checks: {} }; const checks = current.checks;
    const pass = name => { checks[name] = "PASS"; setReport({ ...current, checks: { ...checks }, status: "RUNNING" }); };
    const serverApi = createSlowlyApi(); const journal = createRecoveryJournal({ namespace: "isolated" });
    try {
      demand(location.hostname === "127.0.0.1" && location.port !== "3000", "ISOLATED_ORIGIN_REQUIRED");
      const id = workspaceIds.at(-1);
      if (current.phase === "start") {
        demand(localStorage.length === 0, "FRESH_PRIVATE_BROWSER_REQUIRED");
        await activate(id); await grant(id);
        transport.armLoss();
        await click(button("＋ 新增任務"));
        await until(() => elements().querySelector("dialog.task-panel[open]"));
        await type(elements().querySelector('dialog.task-panel input[placeholder="輸入任務名稱"]'), "Browser UNKNOWN create");
        await click([...elements().querySelectorAll("dialog.task-panel button")].find(node => node.textContent === "儲存任務"));
        await until(transport.hasHeldRequest);
        const saved = await journal.load(); demand(saved?.action === "create" && saved.intent.input.data.title === "Browser UNKNOWN create", "PENDING_NOT_DURABLE"); pass("indexedDbPending");
        await click(button("切回 localStorage Mode"));
        demand(elements().textContent.includes("仍有操作進行"), "PENDING_SOURCE_SWITCH_NOT_BLOCKED");
        demand(button("啟用唯讀 API Mode").disabled, "PENDING_WORKSPACE_SWITCH_NOT_BLOCKED"); pass("pendingSwitch");
        transport.releaseHeldRequest(); await until(() => elements().textContent.includes("寫入結果尚未確認"));
        current.phase = "reload"; current.operationKey = saved.token; current.originalPayload = saved.intent.input; current.workspaceId = id;
        current.status = "RELOAD REQUIRED"; await metadata(runId, current); setReport({ ...current }); return;
      }
      demand(current.phase === "reload", "UNEXPECTED_TEST_PHASE");
      const saved = await journal.load(); demand(saved?.token === current.operationKey && JSON.stringify(saved.intent.input) === JSON.stringify(current.originalPayload), "RELOAD_LOST_OR_CHANGED_INTENT"); pass("unknownReload");
      const scope = { resource: "tasks", workspaceId: id, boardId: saved.intent.input.boardId };
      const receipt = await serverApi.getOperation(saved.token, scope); demand(receipt.state === "CONFIRMED", "RECEIPT_NOT_CONFIRMED");
      const fresh = await serverApi.getTask(receipt.targetId, { boardId: scope.boardId });
      await serverApi.updateTask(receipt.targetId, { workspaceId: id, boardId: scope.boardId, version: fresh.version, data: { title: "Browser confirmed latest" } });
      await activate(id); await until(() => !elements().textContent.includes("寫入結果尚未確認"));
      demand(await journal.load() === null, "CONFIRMED_INTENT_NOT_CLEARED");
      demand([...elements().querySelectorAll(".task-title")].filter(node => node.textContent.includes("Browser confirmed latest")).length === 1, "CONFIRMED_DID_NOT_REFRESH_LATEST"); pass("confirmedRefresh");
      await grant(id);
      await click([...elements().querySelectorAll(".task-title")].find(node => node.textContent.includes("Browser confirmed latest")));
      const titleInput = () => elements().querySelector('dialog.task-panel input[placeholder="輸入任務名稱"]');
      await type(titleInput(), "Browser unsaved task draft");
      [...elements().querySelectorAll(".board-nav .board-link")][1].click(); await pause(150);
      demand(titleInput()?.value === "Browser unsaved task draft", "TASK_DRAFT_LOST");
      const view = await serverApi.getWorkspaceView(id); const task = view.boards.flatMap(entry => entry.tasks).find(row => row.id === receipt.targetId);
      await serverApi.updateTask(task.id, { workspaceId: id, boardId: task.boardId, version: task.version, data: { notes: "Synthetic external conflict" } });
      await click([...elements().querySelectorAll("dialog.task-panel button")].find(node => node.textContent === "儲存任務"));
      await until(() => elements().querySelector(".task-panel-error")?.textContent.includes("衝突"));
      demand(titleInput().value === "Browser unsaved task draft", "CONFLICT_DRAFT_LOST"); pass("conflict409");
      await click(elements().querySelector('dialog.task-panel button[aria-label="關閉任務面板"]'));
      await until(() => !elements().querySelector("dialog.task-panel"));
      await click(button("看板設定")); await until(() => elements().querySelector("dialog[open] textarea"));
      await type(elements().querySelector("dialog[open] textarea"), "Browser unsaved board draft");
      await activate(workspaceIds[0]);
      demand(elements().querySelector("dialog[open] textarea")?.value === "Browser unsaved board draft", "BOARD_DRAFT_LOST");
      await click(button("關閉看板設定")); await until(() => !elements().querySelector("dialog[open]"));
      // Failed scope switch keeps original Workspace and write authority; the note stays a draft.
      const note = elements().querySelector("textarea.widget-note"); demand(note, "NOTE_WIDGET_REQUIRED");
      await type(note, "Browser unsaved widget draft");
      await activate(workspaceIds[0]); demand(elements().querySelector("textarea.widget-note")?.value === "Browser unsaved widget draft", "WIDGET_DRAFT_LOST");
      pass("draftProtection");
      await click(button("檢視未儲存草稿"));
      const draftButtons = [...elements().querySelectorAll("button")].filter(node => node.textContent === "明確捨棄此草稿");
      demand(draftButtons.length > 0, "DRAFT_REVIEW_EMPTY");
      for (const discard of draftButtons) await click(discard);
      demand(elements().textContent.includes("沒有未儲存草稿"), "DRAFT_DISCARD_NOT_CONFIRMED");
      await click(button("切回 localStorage Mode"));
      demand(elements().textContent.includes("隔離測試入口尚未啟用 API"), "API_MODE_NOT_DISABLED");
      demand(localStorage.length === 0, "API_POLLUTED_LOCAL_STORAGE"); pass("sourceIsolation");
      const raw = JSON.stringify([{ id: "synthetic-excluded-legacy", title: "Synthetic excluded task" }]);
      localStorage.setItem("slowly-board-v1", raw); setLegacy(true);
      await until(() => document.querySelector('[data-legacy-probe="true"]')?.textContent.includes("Primary 資料缺失"));
      demand(localStorage.getItem("slowly-workspace-v2") === null && localStorage.getItem("slowly-board-v1") === raw, "LEGACY_WAS_IMPORTED_OR_CHANGED"); pass("legacyProtection");
      current.phase = "done"; current.status = "PASS"; current.realBrowser = true; current.note = "Synthetic isolated browser data only; unsigned test result, not Cutover authorization.";
      delete current.originalPayload; await metadata(runId, current); setReport({ ...current });
    } catch (error) { current.status = "FAIL"; current.error = /^[A-Z_]+$/.test(error.message || "") ? error.message : "BROWSER_TEST_FAILED"; await metadata(runId, current); setReport({ ...current }); }
    finally { setBusy(false); }
  }
  return <main><section style={{ padding: 20, background: "#eef4ee" }}><h1>Isolated Browser Acceptance</h1><p>Run: {runId}</p><p>只使用本次測試 Workspace；結果不授權正式 Cutover。</p>
    <button disabled={busy || !report || report.phase === "done"} onClick={() => void run()}>{report?.phase === "reload" ? "繼續 Reload 驗收" : "執行隔離瀏覽器驗收"}</button>
    <p role="status">{report?.status || "Loading"}</p>{report?.status === "RELOAD REQUIRED" && <p>請使用瀏覽器重新整理，再按「繼續 Reload 驗收」。只在本次隔離視窗確認離開。</p>}
    <pre aria-label="Browser acceptance result">{JSON.stringify(report && { ...report, originalPayload: undefined }, null, 2)}</pre></section>
    <div ref={root}><MainUi options={options} isolationEntry /></div>
    {legacy && <div data-legacy-probe="true"><WorkspaceBoard localWritesAllowed={false} /></div>}
  </main>;
}
