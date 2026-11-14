"use client";
import { createElement as h, useState } from "react";

export function AsyncWidgetNote({ widget, version, readOnly, onConfigure, draftStore }) {
  const [draft, setDraft] = useState(() => draftStore?.read(widget.id) || null); const [saving, setSaving] = useState(false); const [failed, setFailed] = useState(false);
  function discard(expected) { draftStore?.clear(widget.id, expected); setDraft(null); }
  async function commit() {
    if (!draft || readOnly || saving) return;
    if (draft.text === (widget.config.text || "")) { discard(draft); return; }
    setSaving(true); setFailed(false);
    try { const confirmed = await onConfigure({ text: draft.text }, draft.version); if (confirmed === false) setFailed(true); else discard(draft); }
    catch { setFailed(true); }
    finally { setSaving(false); }
  }
  return h("div", { style: { height: "100%", display: "flex", flexDirection: "column" } },
    h("textarea", { className: "widget-note", style: { flex: 1, minHeight: 0 }, "aria-label": "快速筆記內容", maxLength: 10000, placeholder: "輸入筆記…", value: draft?.text ?? widget.config.text ?? "", readOnly: readOnly || saving,
      onChange: event => { const next = { text: event.target.value, version: draft?.version ?? version }; draftStore?.write(widget.id, next); setDraft(next); }, onBlur: commit }),
    draft && h("small", { role: "status" }, saving ? "儲存中…" : "未儲存草稿"),
    failed && h("div", { role: "alert" }, "筆記尚未儲存，草稿已保留。", h("button", { type: "button", onClick: () => { if (window.confirm("以最新伺服器筆記取代草稿？")) { discard(); setFailed(false); } } }, "採用最新筆記")));
}
