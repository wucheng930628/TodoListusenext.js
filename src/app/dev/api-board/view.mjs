"use client";
import { createElement as h, useState, useEffect } from "react";
import { ControlledApiProvider, useControlledApi } from "../../../hooks/controlled-api-provider.mjs";

function createOperationGate() {
  let generation = 0;
  return { begin: () => ++generation, current: token => token === generation, invalidate: () => { generation++; } };
}

export function ControlledApiBoard({ config }) {
  return h(ControlledApiProvider, { config }, h(Console, { config }));
}
function Console({ config }) {
  const state = useControlledApi();
  const [workspaceId, setWorkspaceId] = useState(config.allowedWorkspaces[0]?.id || "");
  const [ready, setReady] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const attempt = fn => { try { fn(); setError(""); } catch (error) { setError(error.message); } };
  const resources = [state.workspace, state.boards, state.tasks, state.widgets];
  return h("main", { style: { maxWidth: 1100, margin: "40px auto", padding: 24, lineHeight: 1.8 } },
    h("h1", null, "slowly. API 隔離測試"),
    h("p", null, "預設 localStorage 模式；此入口不讀寫瀏覽器資料。API 操作僅限獨立測試表。"),
    h("a", { href: "/" }, "返回原本的看板"),
    h("form", { onSubmit: event => { event.preventDefault(); attempt(() => state.connect(workspaceId, ready)); } },
      h("select", { "aria-label": "測試 Workspace", value: workspaceId, onChange: event => { setWorkspaceId(event.target.value); setConfirmation(""); } }, config.allowedWorkspaces.map(item => h("option", { key: item.id, value: item.id }, item.name))),
      h("label", null, h("input", { type: "checkbox", checked: ready, onChange: event => setReady(event.target.checked) }), "我已確認 API Ready"),
      h("button", { type: "submit" }, "啟用唯讀 API Mode")),
    h("button", { onClick: () => { state.disconnect(); setConfirmation(""); } }, "切回 localStorage Mode"),
    h("p", null, `模式：${state.selection.mode}；${state.selection.allowWrites ? "已授權測試寫入" : "唯讀"}`),
    error && h("p", { role: "alert" }, error),
    resources.map((resource, index) => h("div", { key: index }, resource.loading && h("p", { role: "status" }, "讀取中…"), resource.error && h("p", { role: "alert" }, `${resource.error.status || "Network"} ${resource.error.code}: ${resource.error.message}`))),
    state.workspace.success && !state.owned && h("p", { role: "alert" }, "測試 Workspace 歸屬驗證失敗，已阻擋。"),
    state.owned && h("section", null,
      h("label", null, "目前 Workspace ID：", h("code", null, state.selection.workspaceId)),
      h("form", { onSubmit: event => { event.preventDefault(); attempt(() => state.authorizeWrites(confirmation)); } },
        h("input", { "aria-label": "確認寫入 Workspace ID", value: confirmation, onChange: event => setConfirmation(event.target.value), placeholder: "輸入目前 Workspace ID 以授權寫入" }),
        h("button", null, "授權本次測試寫入")),
      state.boards.success && !state.boards.data.length && h("p", null, "沒有看板；不會自動建立。"),
      h("select", { "aria-label": "看板", value: state.boardId || "", onChange: event => { attempt(() => state.selectBoard(event.target.value)); setConfirmation(""); } }, state.boards.data.map(board => h("option", { key: board.id, value: board.id }, board.data.name))),
      state.boardId && h(BoardEditor, { key: `${state.selection.workspaceId}:${state.boardId}` })));
}
function BoardEditor() {
  const state = useControlledApi();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [gate] = useState(createOperationGate);
  useEffect(() => () => gate.invalidate(), [gate]);
  const run = async fn => {
    const current = gate.begin();
    setBusy(true); setMessage("");
    try { await fn(); if (gate.current(current)) setMessage("伺服器已確認成功。"); }
    catch (error) { if (gate.current(current)) setMessage(`${error.status || "Network"} ${error.code || "ERROR"}: ${error.message}；未確認的寫入請先重新讀取，不要直接重送。`); }
    finally { setBusy(false); }
  };
  const disabled = !state.selection.allowWrites || busy;
  return h("section", null,
    h("p", { role: "status" }, message),
    h("button", { disabled: busy, onClick: () => run(() => Promise.all([state.tasks.refresh(), state.widgets.refresh()])) }, "重新讀取"),
    h("button", { onClick: () => { gate.invalidate(); state.tasks.cancel(); state.widgets.cancel(); setMessage("已取消等待；不代表伺服器取消寫入。請重新讀取確認結果。"); } }, "取消等待"),
    h(ResourceEditor, { label: "任務", resource: state.tasks, disabled, run, kind: "task" }),
    h("p", null, `Widget 來源狀態：${state.widgetPresence}`),
    state.widgetPresence === "present" ? h(ResourceEditor, { label: "Widget", resource: state.widgets, disabled, run, kind: "widget" }) :
      h("p", null, state.widgets.data.length ? "來源狀態與資料不一致，阻擋 Widget 操作。" : "Widget 缺省或未知，不推測還原內容。"));
}
export function ResourceEditor({ label, resource, disabled, run, kind }) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(null);
  const submit = () => run(async () => {
    if (!draft.trim()) throw new Error("請輸入內容。");
    if (editing) await resource.update(editing.id, { version: editing.version, data: kind === "task" ? { title: draft } : { config: { ...editing.data.config, text: draft } } });
    else await resource.create({ position: Math.max(-1, ...resource.data.map(item => item.position)) + 1, data: kind === "task" ?
      { id: crypto.randomUUID(), title: draft, description: "", status: "todo", tag: "個人", priority: "一般", urgent: false, date: "", time: "", subtasks: [], notes: "" } :
      { id: crypto.randomUUID(), type: "note", span: 6, height: 200, config: { text: draft } } });
    setDraft(""); setEditing(null);
  });
  const moveUp = index => run(() => {
    const ordered = [...resource.data]; [ordered[index - 1], ordered[index]] = [ordered[index], ordered[index - 1]];
    return resource.reorder(ordered.map((item, position) => ({ id: item.id, version: item.version, position })));
  });
  return h("section", null, h("h2", null, label),
    resource.success && !resource.data.length && h("p", null, "目前沒有資料。"),
    h("form", { onSubmit: event => { event.preventDefault(); void submit(); } },
      h("input", { "aria-label": `${label}內容`, value: draft, onChange: event => setDraft(event.target.value) }),
      h("button", { disabled: disabled || !resource.success }, editing ? "儲存修改" : "新增"),
      editing && h("button", { type: "button", onClick: () => { setEditing(null); setDraft(""); } }, "取消編輯")),
    resource.data.map((item, index) => h("article", { key: item.id, style: { border: "1px solid #ccc", padding: 12, margin: "12px 0" } },
      h("strong", null, kind === "task" ? item.data.title : item.data.config?.text),
      h("p", null, `Frontend ID: ${item.data.id} / DB ID: ${item.id} / version ${item.version}`),
      h("button", { disabled, onClick: () => { setEditing(item); setDraft(kind === "task" ? item.data.title : item.data.config?.text || ""); } }, "編輯"),
      h("button", { disabled, onClick: () => { if (window.confirm(`刪除測試${label}？`)) void run(() => resource.remove(item.id, { version: item.version })); } }, "刪除"),
      h("button", { disabled: disabled || index === 0, onClick: () => void moveUp(index) }, "上移"))));
}
