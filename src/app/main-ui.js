"use client";
import { useEffect, useMemo, useState } from "react";
import WorkspaceBoard from "./workspace-board";
import { useMainWorkspace } from "../hooks/use-main-workspace.mjs";
import { createMainUiSession } from "../lib/client/main-ui-session.mjs";
import { captureVerifiedBackup, downloadBackupArtifact } from "../lib/client/verified-backup.mjs";
import { createRecoveryJournal } from "../lib/client/recovery-journal.mjs";

const defaults = { development: process.env.NODE_ENV === "development" };
export default function MainUi({ options = defaults, isolationEntry = false }) {
  const effectiveOptions = useMemo(() => ({ ...options, journal: options.journal || createRecoveryJournal({ namespace: isolationEntry ? "isolated" : "formal" }) }), [options, isolationEntry]);
  const state = useMainWorkspace(effectiveOptions); const { controller } = state;
  const [workspaceId, setWorkspaceId] = useState(""); const [apiReady, setApiReady] = useState(false);
  const [confirmation, setConfirmation] = useState(""); const [message, setMessage] = useState("");
  const [reviewDrafts, setReviewDrafts] = useState(null);
  useEffect(() => () => controller.cancel(), [controller]);
  useEffect(() => { void controller.bootstrapRecovery(); }, [controller]);
  useEffect(() => {
    const protect = event => { if (controller.hasUnsafeNavigation()) { event.preventDefault(); event.returnValue = ""; } };
    if (typeof window === "undefined") return;
    window.addEventListener?.("beforeunload", protect);
    return () => window.removeEventListener?.("beforeunload", protect);
  }, [controller]);
  const attempt = async fn => { setMessage(""); try { await fn(); } catch (error) { setMessage(error.message); } };
  async function backup() {
    try {
      const artifact = await captureVerifiedBackup({ origin: window.location.origin });
      downloadBackupArtifact(artifact);
      setMessage(`備份已交由瀏覽器下載，請自行確認檔案。備份 Payload SHA-256：${artifact.integrity.fingerprint}`);
    } catch (error) { setMessage(error.message); }
  }
  return <>
    {options.development && <section aria-label="資料來源控制" style={{ padding: "8px 20px", borderBottom: "1px solid #dce5d5", background: "#f3f5ee" }}>
      <details><summary>資料來源：{state.mode === "api" ? "API" : "localStorage"}（開發模式）</summary>
        <p>API 需由伺服器明確綁定 Workspace，並通過 Readiness。切換不會自動匯入或合併資料。</p>
        <button type="button" onClick={() => void attempt(async () => { const record = await controller.inspectRecovery(); if (record) { setWorkspaceId(record.workspaceId); setMessage("找到未確認操作，請明確啟用原 Workspace 的唯讀模式以恢復。未恢復前不允許新寫入。"); } else setMessage("沒有未確認操作。請明確選擇 Workspace。"); })}>檢查 Reload 恢復紀錄</button>
        <button type="button" onClick={() => setReviewDrafts(controller.listDrafts())}>檢視未儲存草稿</button>
        {reviewDrafts && <div role="status">{reviewDrafts.length ? reviewDrafts.map(item => <details key={item.key}><summary>未儲存草稿</summary><pre>{JSON.stringify(item.value, null, 2)}</pre><button type="button" onClick={() => { if (window.confirm("已檢視並明確捨棄此草稿？")) { controller.clearDraft(item.key, item.value); setReviewDrafts(controller.listDrafts()); } }}>明確捨棄此草稿</button></details>) : "沒有未儲存草稿"}</div>}
        <button type="button" onClick={backup}>匯出完整本機備份</button>
        <form onSubmit={event => { event.preventDefault(); void attempt(() => controller.activate({ workspaceId, apiReady })); }}>
          <label>Workspace ID<input aria-label="API Workspace ID" value={workspaceId} onChange={event => setWorkspaceId(event.target.value)} placeholder="SLOWLY#WORKSPACE#…" /></label>
          <label><input type="checkbox" checked={apiReady} onChange={event => setApiReady(event.target.checked)} />我已確認 API Ready</label>
          <button type="submit" disabled={state.status === "loading" || state.mutation === "loading"}>啟用唯讀 API Mode</button>
        </form>
        <button type="button" onClick={() => void attempt(async () => { controller.deactivate(); setConfirmation(""); })}>切回 localStorage Mode</button>
        {state.mode === "api" && <>
          <form onSubmit={event => { event.preventDefault(); void attempt(() => controller.authorizeWrites(confirmation)); }}>
            <label>確認 Workspace<input aria-label="授權寫入 Workspace ID" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
            <button type="submit" disabled={state.status !== "success" || state.uncertainWrite || state.mutation === "loading"}>另外授權寫入</button>
          </form>
          <button type="button" disabled={state.mutation === "loading"} onClick={() => void attempt(controller.refresh)}>重新讀取 API 資料</button>
          <button type="button" onClick={controller.cancel}>取消等待</button>
          <span role="status">{state.allowWrites ? "已授權測試寫入" : "唯讀"}</span>
        </>}
      </details>
      {message && <p role="alert">{message}</p>}
      {state.error && <p role="alert">{state.error.status ? `${state.error.status} ` : ""}{state.error.message}</p>}
      {state.mode === "localStorage" && state.startupStatus !== "ready" && <p role="alert">正在核對未確認操作；本機編輯暫停。{state.recoveryWorkspaceId && `請明確選擇 ${state.recoveryWorkspaceId} 以恢復。`}</p>}
      {state.mode === "api" && state.status === "loading" && <p role="status">讀取 API 資料中…</p>}
      {state.uncertainWrite && <p role="alert">寫入結果尚未確認，已暫停後續寫入。請先核對資料，不要重送新增。</p>}
      {state.mode === "api" && state.uncertainWrite && !state.createRecovery && <button type="button" onClick={() => void attempt(async () => { if (window.confirm("已人工核對伺服器的更新／刪除／排序結果？此操作不會重送寫入。")) await controller.resolveUncertain(confirmation); })}>已人工核對未確認結果</button>}
      {state.mode === "api" && state.uncertainWrite && state.createRecovery && <div>
        <details><summary>原始未確認操作內容</summary><pre>{JSON.stringify(controller.recoveryDetails(), null, 2)}</pre></details>
        <p role="status">新增操作 {state.createRecovery.operationKey} · {state.createRecovery.state}{state.createRecovery.receiptState === "NOT_FOUND" ? "（尚未查到 Receipt，結果仍不明）" : ""}</p>
        <button type="button" disabled={state.createRecovery.checking || state.mutation === "loading"} onClick={() => void attempt(controller.recoverCreate)}>查詢新增結果</button>
        <button type="button" disabled={state.createRecovery.checking || state.mutation === "loading" || state.createRecovery.state === "CONFLICT"} onClick={() => {
          if (window.confirm("使用原 Operation Key 與原始內容安全重送這次新增？")) void attempt(() => controller.resendCreate(confirmation));
        }}>以原 Key 與原內容重送</button>
      </div>}
    </section>}
    {state.mode === "localStorage" ? isolationEntry ? <p>隔離測試入口尚未啟用 API；不讀寫本機資料。</p> : <WorkspaceBoard key="local" navigationGuard={controller} localWritesAllowed={state.startupStatus === "ready"} />
      : state.projection ? state.projection.workspace.boards.length ?
        <WorkspaceBoard key={`${state.workspaceId}:${state.activeBoardId}:${state.recoveredCreateRevision}`} apiSession={createMainUiSession(state)} /> :
        <EmptyApiWorkspace state={state} onError={setMessage} /> : <main className="content"><p>{state.status === "error" ? "API 載入失敗，沒有切回本機資料或建立預設看板。" : "正在確認 Workspace 與 Readiness…"}</p></main>}
  </>;
}

function EmptyApiWorkspace({ state, onError }) {
  const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [wipLimit, setWipLimit] = useState(4);
  const draftKey = JSON.stringify([state.workspaceId, "empty-board-form"]);
  const edit = patch => { state.controller.writeDraft(draftKey, { name, description, wipLimit, ...patch }); if (patch.name !== undefined) setName(patch.name); if (patch.description !== undefined) setDescription(patch.description); if (patch.wipLimit !== undefined) setWipLimit(patch.wipLimit); };
  const writable = state.allowWrites && state.status === "success" && state.mutation !== "loading" && !state.uncertainWrite;
  return <main className="content"><h1>目前沒有看板</h1><p>不會自動建立預設資料。</p>
    <form onSubmit={event => { event.preventDefault(); const revision = state.scopeRevision; void state.controller.saveBoard({ name, description, wipLimit: Number(wipLimit) }).then(result => { if (state.controller.getSnapshot().scopeRevision === revision) { state.controller.clearDraft(draftKey); state.controller.selectBoard(result.data.id); } }, error => onError(error.message)); }}>
      <label>看板名稱<input required maxLength={50} value={name} onChange={event => edit({ name: event.target.value })} /></label>
      <label>描述<textarea maxLength={200} value={description} onChange={event => edit({ description: event.target.value })} /></label>
      <label>WIP<input type="number" min={1} max={100} value={wipLimit} onChange={event => edit({ wipLimit: event.target.value })} /></label>
      <button disabled={!writable}>建立看板</button>
    </form>
  </main>;
}
