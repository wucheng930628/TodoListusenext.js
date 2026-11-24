"use client";

import { useEffect, useRef, useState } from "react";
import { useAsyncDraft } from "../hooks/use-async-draft.mjs";
import "./task-panel.css";
import { apiErrorMessage } from "../lib/client/api-error-message.mjs";

export default function TaskPanel({ task, columns, onChange, onSave, onClose, onDelete, asyncMode = false, readOnly = false, onReloadLatest }) {
  const panel = useRef(null);
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [error, setError] = useState("");
  const flow = useAsyncDraft();
  const [submitGate] = useState(() => {
    let pending = false;
    return { start() { if (pending) return false; pending = true; return true; }, finish() { pending = false; } };
  });
  const saving = asyncMode && flow.status === "saving";
  async function runAsync(action) {
    if (saving || readOnly || !submitGate.start()) { setError("目前唯讀或仍在儲存中。"); return; }
    setError(""); flow.open(task.id || "new", task);
    try { await flow.save(async () => { const message = await action(); if (typeof message === "string" && message) throw new Error(message); }); }
    catch (error) { setError(`${apiErrorMessage(error)} 草稿已保留。`); }
    finally { submitGate.finish(); }
  }
  const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
  const completedCount = subtasks.filter(item => item.done).length;

  useEffect(() => {
    const element = panel.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element.showModal();
    return () => {
      element.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  function update(field, value) {
    onChange({ ...task, [field]: value });
  }

  function addSubtask() {
    const title = subtaskTitle.trim();
    if (!title) return;
    update("subtasks", [...subtasks, { id: crypto.randomUUID(), title, done: false }]);
    setSubtaskTitle("");
  }

  return <dialog ref={panel} className="task-panel" aria-labelledby="task-panel-heading" onCancel={event => {
    event.preventDefault();
    if (!saving) onClose();
  }} onClick={event => { if (!saving && event.target === panel.current) onClose(); }}>
    <form aria-busy={saving} onSubmit={event => { event.preventDefault(); if (asyncMode) return runAsync(() => onSave(event)); setError(onSave(event) || ""); }}>
      <header className="task-panel-header"><h2 id="task-panel-heading">{task.id ? "任務詳情" : "新增任務"}</h2><button type="button" className="close-button" aria-label="關閉任務面板" disabled={saving} onClick={onClose}>×</button></header>
      <fieldset className="task-panel-content" disabled={asyncMode && (readOnly || saving)} style={{ border: 0, margin: 0, minWidth: 0 }}>
        <label className="task-panel-title">任務名稱<input autoFocus required maxLength={100} placeholder="輸入任務名稱" value={task.title} onChange={event => update("title", event.target.value)} /></label>
        <div className="form-row"><label>狀態<select value={task.status} onChange={event => update("status", event.target.value)}>{columns.map(column => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label><label>優先級<select value={task.priority} onChange={event => update("priority", event.target.value)}>{["低", "一般", "高"].map(priority => <option key={priority}>{priority}</option>)}</select></label></div>
        <div className="form-row"><label>截止日期<input type="date" value={task.date} onChange={event => onChange({ ...task, date: event.target.value, time: event.target.value ? task.time || "" : "" })} /></label><label>截止時間（選填）<input type="time" step={60} disabled={!task.date} value={task.time || ""} onChange={event => update("time", event.target.value)} /></label></div>
        <label>分類<select value={task.tag} onChange={event => update("tag", event.target.value)}>{["個人", "工作", "設計", "開發", "生活"].map(tag => <option key={tag}>{tag}</option>)}</select></label>
        <label className="checkbox"><input type="checkbox" checked={task.urgent} onChange={event => update("urgent", event.target.checked)} />優先處理</label>
        <label>任務描述<textarea rows={4} maxLength={1000} placeholder="任務描述（選填）" value={task.description} onChange={event => update("description", event.target.value)} /></label>
        <section className="subtasks-section" aria-labelledby="subtasks-heading">
          <div className="subtasks-heading"><h3 id="subtasks-heading">子任務</h3><span>{completedCount} / {subtasks.length}</span></div>
          {subtasks.length > 0 && <progress value={completedCount} max={subtasks.length} aria-label="子任務完成進度" />}
          <div className="subtasks-list">{subtasks.map(item => <div className={`subtask-row${item.done ? " done" : ""}`} key={item.id}>
            <input type="checkbox" aria-label={`完成子任務 ${item.title}`} checked={item.done} onChange={event => update("subtasks", subtasks.map(subtask => subtask.id === item.id ? { ...subtask, done: event.target.checked } : subtask))} />
            <input aria-label="子任務名稱" required maxLength={150} value={item.title} onChange={event => update("subtasks", subtasks.map(subtask => subtask.id === item.id ? { ...subtask, title: event.target.value } : subtask))} />
            <button type="button" aria-label={`刪除子任務 ${item.title}`} onClick={() => update("subtasks", subtasks.filter(subtask => subtask.id !== item.id))}>×</button>
          </div>)}</div>
          <div className="subtask-add"><input aria-label="新增子任務名稱" maxLength={150} placeholder="新增子任務" value={subtaskTitle} onChange={event => setSubtaskTitle(event.target.value)} onKeyDown={event => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              addSubtask();
            }
          }} /><button type="button" className="secondary" disabled={!subtaskTitle.trim()} onClick={addSubtask}>＋ 加入</button></div>
        </section>
        <label>備註<textarea rows={4} maxLength={5000} placeholder="輸入備註（選填）" value={task.notes || ""} onChange={event => update("notes", event.target.value)} /></label>
      </fieldset>
      {error && <p className="task-panel-error" role="alert">{error}</p>}
      {onReloadLatest && <button type="button" disabled={saving} className="secondary" onClick={() => { void onReloadLatest().catch(error => setError(apiErrorMessage(error))); }}>重新讀取並採用最新任務</button>}
      <footer className="task-panel-actions">{task.id && <button type="button" className="delete-button" disabled={saving || readOnly} onClick={() => { if (asyncMode) void runAsync(onDelete); else onDelete(); }}>刪除任務</button>}<button type="button" className="secondary" disabled={saving} onClick={onClose}>取消</button><button type="submit" className="primary" disabled={saving || readOnly}>{saving ? "儲存中…" : "儲存任務"}</button></footer>
    </form>
  </dialog>;
}
