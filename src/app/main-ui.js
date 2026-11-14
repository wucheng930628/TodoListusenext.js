"use client";
import { useEffect, useState } from "react";
import WorkspaceBoard from "./workspace-board";
import { useMainWorkspace } from "../hooks/use-main-workspace.mjs";
import { createMainUiSession } from "../lib/client/main-ui-session.mjs";
import { captureWorkspaceBackup, exportBackupJson } from "../lib/client/workspace-backup.mjs";

const defaults = { development: process.env.NODE_ENV === "development" };
export default function MainUi({ options = defaults, isolationEntry = false }) {
  const state = useMainWorkspace(options); const { controller } = state;
  const [workspaceId, setWorkspaceId] = useState(""); const [apiReady, setApiReady] = useState(false);
  const [confirmation, setConfirmation] = useState(""); const [message, setMessage] = useState("");
  useEffect(() => () => controller.cancel(), [controller]);
  const attempt = async fn => { setMessage(""); try { await fn(); } catch (error) { setMessage(error.message); } };
  function backup() {
    try {
      const json = exportBackupJson(captureWorkspaceBackup());
      const url = URL.createObjectURL(new Blob([json], { type: "application/json;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url; link.download = `slowly-backup-${Date.now()}.json`; link.click(); URL.revokeObjectURL(url);
      setMessage("備份已匯出；原本的本機資料沒有變更。");
    } catch (error) { setMessage(error.message); }
  }
  return <>
    {options.development && <section aria-label="資料來源控制" style={{ padding: "8px 20px", borderBottom: "1px solid #dce5d5", background: "#f3f5ee" }}>
      <details><summary>資料來源：{state.mode === "api" ? "API" : "localStorage"}（開發模式）</summary>
        <p>API 僅使用獨立測試環境。切換前可先匯出本機備份，不會自動匯入或合併資料。</p>
        <button type="button" onClick={backup}>匯出完整本機備份</button>
        <form onSubmit={event => { event.preventDefault(); void attempt(() => controller.activate({ workspaceId, apiReady })); }}>
          <label>Workspace ID<input aria-label="API Workspace ID" value={workspaceId} onChange={event => setWorkspaceId(event.target.value)} placeholder="SLOWLY#WORKSPACE#…" /></label>
          <label><input type="checkbox" checked={apiReady} onChange={event => setApiReady(event.target.checked)} />我已確認 API Ready</label>
          <button type="submit" disabled={state.status === "loading" || state.mutation === "loading"}>啟用唯讀 API Mode</button>
        </form>
        <button type="button" onClick={() => { if (state.mutation === "loading" && !window.confirm("伺服器可能仍在寫入，切換後請勿重送。仍要離開？")) return; controller.deactivate(); setConfirmation(""); }}>切回 localStorage Mode</button>
        {state.mode === "api" && <>
          <form onSubmit={event => { event.preventDefault(); void attempt(() => controller.authorizeWrites(confirmation)); }}>
            <label>確認測試 Workspace<input aria-label="授權寫入 Workspace ID" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
            <button type="submit" disabled={state.status !== "success" || state.uncertainWrite || state.mutation === "loading"}>另外授權寫入</button>
          </form>
          <button type="button" disabled={state.mutation === "loading"} onClick={() => void attempt(controller.refresh)}>重新讀取 API 資料</button>
          <button type="button" onClick={controller.cancel}>取消等待</button>
          <span role="status">{state.allowWrites ? "已授權測試寫入" : "唯讀"}</span>
        </>}
      </details>
      {message && <p role="alert">{message}</p>}
      {state.error && <p role="alert">{state.error.status ? `${state.error.status} ` : ""}{state.error.message}</p>}
      {state.mode === "api" && state.status === "loading" && <p role="status">讀取 API 資料中…</p>}
      {state.uncertainWrite && <p role="alert">寫入結果尚未確認，已暫停後續寫入。請先核對資料，不要重送新增。</p>}
    </section>}
    {state.mode === "localStorage" ? isolationEntry ? <p>隔離測試入口尚未啟用 API；不讀寫本機資料。</p> : <WorkspaceBoard key="local" />
      : state.projection ? state.projection.workspace.boards.length ?
        <WorkspaceBoard key={`${state.workspaceId}:${state.activeBoardId}`} apiSession={createMainUiSession(state)} /> :
        <EmptyApiWorkspace state={state} onError={setMessage} /> : <main className="content"><p>{state.status === "error" ? "API 載入失敗，沒有切回本機資料或建立預設看板。" : "正在確認 Workspace 與 Readiness…"}</p></main>}
  </>;
}

function EmptyApiWorkspace({ state, onError }) {
  const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [wipLimit, setWipLimit] = useState(4);
  const writable = state.allowWrites && state.status === "success" && state.mutation !== "loading" && !state.uncertainWrite;
  return <main className="content"><h1>目前沒有看板</h1><p>不會自動建立預設資料。</p>
    <form onSubmit={event => { event.preventDefault(); const revision = state.scopeRevision; void state.controller.saveBoard({ name, description, wipLimit: Number(wipLimit) }).then(result => { if (state.controller.getSnapshot().scopeRevision === revision) state.controller.selectBoard(result.data.id); }, error => onError(error.message)); }}>
      <label>看板名稱<input required maxLength={50} value={name} onChange={event => setName(event.target.value)} /></label>
      <label>描述<textarea maxLength={200} value={description} onChange={event => setDescription(event.target.value)} /></label>
      <label>WIP<input type="number" min={1} max={100} value={wipLimit} onChange={event => setWipLimit(event.target.value)} /></label>
      <button disabled={!writable}>建立看板</button>
    </form>
  </main>;
}
