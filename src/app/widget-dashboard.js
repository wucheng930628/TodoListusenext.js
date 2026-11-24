"use client";

import { useEffect, useRef, useState } from "react";
import { defaultWidgetLayout, reorderWidgets, widgetCatalog, WidgetContent, WidgetSettings } from "./widgets";
import { widgetConfigForTypeChange } from "../lib/client/main-view-model.mjs";
import "./widget-dashboard.css";
import { apiErrorMessage } from "../lib/client/api-error-message.mjs";

const dragType = "application/x-slowly-widget";

export function fillWidgetRows(widgets, gridWidth) {
  const rows = [];
  let row = [];
  let used = 0;
  for (const widget of widgets) {
    const span = gridWidth <= 700 ? 12 : widget.span;
    if (used + span > 12 && row.length) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push({ ...widget, span });
    used += span;
  }
  if (row.length) rows.push(row);

  const layout = new Map();
  for (const items of rows) {
    const automatic = items.filter(item => !item.manualSize);
    let remainingColumns = 12 - items.filter(item => item.manualSize).reduce((sum, item) => sum + item.span, 0);
    let remainingWeight = automatic.reduce((sum, item) => sum + item.span, 0);
    const fitted = items.map(item => {
      let span = item.span;
      if (!item.manualSize) {
        span = Math.round(item.span / remainingWeight * remainingColumns);
        remainingColumns -= span;
        remainingWeight -= item.span;
      }
      const width = (gridWidth + 14) * span / 12 - 14;
      const minimum = item.type === "analytics" ? (width < 642 ? 380 : 230) : item.type === "timer" ? 260 : 170;
      return { id: item.id, span, manualSize: item.manualSize, height: item.manualSize ? item.height : Math.max(minimum, item.height) };
    });
    const automaticHeight = Math.max(170, ...fitted.filter(item => !item.manualSize).map(item => item.height));
    for (const item of fitted) layout.set(item.id, { span: item.span, height: item.manualSize ? item.height : automaticHeight });
  }
  return layout;
}

export function resizeWidget(span, height, deltaX, deltaY, gridWidth) {
  return {
    span: Math.min(12, Math.max(4, span + Math.round(deltaX / (gridWidth / 12)))),
    height: Math.min(600, Math.max(170, height + deltaY)),
  };
}

function WidgetCard({ widget, fitted, tasks, now, ready, grid, onUpdate, onRemove, onMove, onDrop, onEdit, asyncMode = false, version, noteDraftStore, typeWrites }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const frame = useRef(null);
  const drag = useRef(null);
  const entry = widgetCatalog.find(item => item.type === widget.type);
  const layout = preview || fitted;
  const configurable = ["timer", "today", "upcoming"].includes(widget.type);

  function configure(config, expectedVersion = version) {
    if (asyncMode && !ready) return false;
    return onUpdate(current => ({ ...current, config: { ...current.config, ...config } }), expectedVersion);
  }

  function updateResize(event) {
    if (!drag.current) return;
    const next = resizeWidget(drag.current.span, drag.current.height, event.clientX - drag.current.x, event.clientY - drag.current.y, grid.current.clientWidth);
    setPreview(next);
    return next;
  }

  return <section ref={frame} className="dashboard-widget" style={{ gridColumn: `span ${layout.span}`, height: layout.height }} aria-label={entry.name} onDragOver={event => {
    if (event.dataTransfer.types.includes(dragType)) event.preventDefault();
  }} onDrop={event => { event.stopPropagation(); onDrop(event, widget.id); }}>
    <header className="widget-header">
      <button className="widget-drag" draggable={ready} aria-label={`拖曳排列${entry.name}`} title="拖曳排列小組件" onDragStart={event => {
        event.dataTransfer.setData(dragType, JSON.stringify({ id: widget.id }));
        event.dataTransfer.effectAllowed = "move";
      }}>⠿</button>
      <h3><span>{entry.icon}</span>{entry.name}</h3>
      <div className="widget-controls">
        <button disabled={!ready} aria-label={`將${entry.name}往前移`} title="往前移" onClick={() => onMove(-1)}>‹</button>
        <button disabled={!ready} aria-label={`將${entry.name}往後移`} title="往後移" onClick={() => onMove(1)}>›</button>
        {(configurable || typeWrites) && <button aria-label={`${entry.name}設定`} title="小組件設定" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(value => !value)}>⚙</button>}
        <button disabled={!ready} aria-label={`移除${entry.name}`} title="移除小組件" onClick={onRemove}>×</button>
      </div>
    </header>
    {settingsOpen && <div className="widget-settings">
      {typeWrites && <label>小組件類型<select disabled={!ready} value={widget.type} onChange={event => {
        const type = event.target.value;
        const config = widgetConfigForTypeChange(widget.config);
        if (Object.keys(config).length !== Object.keys(widget.config ?? {}).length &&
          !window.confirm("切換類型會清除目前類型的設定與內容，確定繼續？")) return;
        onUpdate(current => ({ ...current, type, config }), version);
      }}>{widgetCatalog.map(entry => <option key={entry.type} value={entry.type}>{entry.name}</option>)}</select></label>}
      <WidgetSettings widget={widget} onConfigure={configure} readOnly={!ready} />
    </div>}
    <div className="widget-body"><WidgetContent widget={widget} tasks={tasks} now={now} onEdit={onEdit} onConfigure={configure} asyncMode={asyncMode} version={version} readOnly={!ready} noteDraftStore={noteDraftStore} /></div>
    <button className="widget-resize" disabled={!ready} aria-label={`調整${entry.name}大小，可拖曳或使用方向鍵`} title="拖曳調整大小，或使用方向鍵" onPointerDown={event => {
      if (event.button !== 0) return;
      drag.current = { x: event.clientX, y: event.clientY, span: fitted.span, height: frame.current.getBoundingClientRect().height, version };
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={updateResize} onPointerUp={event => {
      const next = updateResize(event);
      if (next) onUpdate(current => ({ ...current, ...next, manualSize: true }), drag.current.version);
      drag.current = null;
      setPreview(null);
    }} onPointerCancel={() => { drag.current = null; setPreview(null); }} onLostPointerCapture={() => { drag.current = null; setPreview(null); }} onKeyDown={event => {
      const steps = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] };
      if (!steps[event.key]) return;
      event.preventDefault();
      const [horizontal, vertical] = steps[event.key];
      const next = resizeWidget(fitted.span, frame.current.getBoundingClientRect().height, horizontal * grid.current.clientWidth / 12, vertical, grid.current.clientWidth);
      onUpdate(current => ({ ...current, ...next, manualSize: true }), version);
    }}>⤡</button>
  </section>;
}

export default function WidgetDashboard({ widgets, tasks, now, ready, onChange, onEdit, asyncMode = false, versions = {}, noteDraftStore, typeWrites = false }) {
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [message, setMessage] = useState("");
  const grid = useRef(null);
  const [gridWidth, setGridWidth] = useState(1200);
  const fitted = fillWidgetRows(widgets, gridWidth);
  function change(update, message = "已儲存。", options) {
    if (asyncMode && !ready) { setMessage("目前唯讀或仍有操作進行。"); return false; }
    try {
      const result = onChange(update, options);
      if (result?.then) return result.then(() => { setMessage(message); return true; }, error => { setMessage(apiErrorMessage(error)); return false; });
      return true;
    } catch (error) { setMessage(apiErrorMessage(error)); return false; }
  }

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setGridWidth(entry.contentRect.width));
    observer.observe(grid.current);
    return () => observer.disconnect();
  }, []);

  function createWidget(type, beforeId) {
    if (!ready || !widgetCatalog.some(item => item.type === type)) return;
    const widget = { id: crypto.randomUUID(), type, ...defaultWidgetLayout(type), config: {} };
    if (asyncMode && beforeId) { setMessage("API 模式新增僅支援加入尾端，請使用加入按鈕。"); return; }
    change(current => {
      const next = [...current];
      const index = next.findIndex(item => item.id === beforeId);
      next.splice(index < 0 ? next.length : index, 0, widget);
      return next;
    });
    if (!asyncMode) setMessage("小組件已加入，可拖曳排序或調整大小。");
  }

  function dropWidget(event, beforeId) {
    if (!ready || !event.dataTransfer.types.includes(dragType)) return;
    event.preventDefault();
    try {
      const data = JSON.parse(event.dataTransfer.getData(dragType));
      if (data.type) createWidget(data.type, beforeId);
      else change(current => reorderWidgets(current, data.id, beforeId));
    } catch { setMessage("請重新拖曳小組件。"); }
  }

  return <section className="widget-dashboard" aria-label="自訂小組件區">
    <div className="dashboard-toolbar"><span>我的小組件 <small>{widgets.length}</small></span><div className="dashboard-actions"><button className="widget-reset" disabled={!ready || !widgets.length || (asyncMode && widgets.length > 1)} aria-label="清空全部小組件" title={asyncMode && widgets.length > 1 ? "API 暫不支援原子清空多個小組件，請逐一移除" : "清空全部小組件"} onClick={() => {
      if (!window.confirm("確定清空目前看板的全部小組件？快速筆記內容與小組件設定也會一併刪除。")) return;
      change(() => [], "全部小組件已清空。");
      if (!asyncMode) setMessage("全部小組件已清空。");
    }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 10a8 8 0 1 0 .25 4" stroke="currentColor" strokeWidth="2.3"/><path d="M20 3v7h-7" stroke="currentColor" strokeWidth="2.3"/></svg></button><button className="secondary" disabled={!ready} aria-expanded={libraryOpen} onClick={() => setLibraryOpen(value => !value)}>{libraryOpen ? "收起選單" : "＋ 新增小組件"}</button></div></div>
    {libraryOpen && <section className="widget-library" aria-label="小組件選單">
      <div className="widget-library-grid">{widgetCatalog.map(entry => <article key={entry.type} className={`widget-library-card ${entry.type}`} draggable={ready} onDragStart={event => {
        event.dataTransfer.setData(dragType, JSON.stringify({ type: entry.type }));
        event.dataTransfer.effectAllowed = "copy";
      }}><div className="widget-preview" aria-hidden="true">{entry.icon}</div><h3>{entry.name}</h3><p>{entry.description}</p><button className="secondary" disabled={!ready} onClick={() => createWidget(entry.type)}>＋ 加入</button></article>)}</div>
    </section>}
    <div className="widget-grid" ref={grid} onDragOver={event => { if (event.dataTransfer.types.includes(dragType)) event.preventDefault(); }} onDrop={event => dropWidget(event)}>
      {widgets.map(widget => <WidgetCard key={widget.id} widget={widget} fitted={fitted.get(widget.id)} tasks={tasks} now={now} ready={ready} grid={grid} onDrop={dropWidget} onEdit={onEdit} asyncMode={asyncMode} version={versions[widget.id]} noteDraftStore={noteDraftStore} typeWrites={typeWrites}
        onUpdate={(update, expectedVersion) => change(current => current.map(item => item.id === widget.id ? update(item) : item), "已儲存。", { widgetId: widget.id, expectedVersion })}
        onRemove={() => {
          if (widget.type === "note" && widget.config.text && !window.confirm("移除這個筆記小組件會一併刪除內容，確定移除？")) return;
          change(current => current.filter(item => item.id !== widget.id), "小組件已移除。", { widgetId: widget.id, expectedVersion: versions[widget.id] });
          if (!asyncMode) setMessage("小組件已移除。");
        }}
        onMove={direction => change(current => {
          const from = current.findIndex(item => item.id === widget.id);
          const to = from + direction;
          if (from < 0 || to < 0 || to >= current.length) return current;
          const next = [...current];
          [next[from], next[to]] = [next[to], next[from]];
          return next;
        })} />)}
      {!widgets.length && <button className="widget-drop-empty" disabled={!ready} onClick={() => setLibraryOpen(true)}>＋ 新增小組件</button>}
    </div>
    <span className={asyncMode ? "widget-message" : "widget-sr-only"} role="status">{message}</span>
  </section>;
}
