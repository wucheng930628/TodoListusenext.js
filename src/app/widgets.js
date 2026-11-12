"use client";

import TaskAnalytics from "./task-analytics";

export const widgetCatalog = [
  { type: "analytics", name: "任務完成統計", icon: "▥", description: "完成趨勢、完成率與連續完成天數" },
  { type: "today", name: "今日待辦", icon: "☀", description: "集中查看今天到期的任務" },
  { type: "upcoming", name: "即將到期", icon: "◷", description: "查看未來 7 天的截止安排" },
  { type: "timer", name: "番茄鐘", icon: "◴", description: "選擇任務，開始一段專注時間" },
  { type: "note", name: "快速筆記", icon: "▤", description: "隨手記下這個看板的想法" },
];

export function defaultWidgetLayout(type) {
  return { span: 6, height: type === "analytics" ? 320 : 260 };
}

export function boardWidgets(board) {
  if (Array.isArray(board.widgets)) {
    return board.widgets.filter(widget => widget && typeof widget.id === "string" && widgetCatalog.some(item => item.type === widget.type)).map(widget => ({
      ...widget,
      span: Number.isFinite(widget.span) ? Math.max(4, Math.min(12, widget.span)) : 6,
      height: Number.isFinite(widget.height) ? Math.max(170, Math.min(600, widget.height)) : 280,
      config: widget.config || {},
    }));
  }
  return [{ id: "default-analytics", type: "analytics", span: 12, height: Math.min(600, Math.max(170, (board.analyticsSize?.height || 124) + 44)), config: {} }];
}

export function reorderWidgets(widgets, draggedId, beforeId) {
  const moving = widgets.find(widget => widget.id === draggedId);
  if (!moving || draggedId === beforeId) return widgets;
  const remaining = widgets.filter(widget => widget.id !== draggedId);
  const index = remaining.findIndex(widget => widget.id === beforeId);
  remaining.splice(index === -1 ? remaining.length : index, 0, moving);
  return remaining;
}

export function scheduledTasks(tasks, now, type, showCompleted = false) {
  if (now === null) return [];
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + (type === "today" ? 1 : 7));
  return tasks.filter(task => {
    const date = task.date ? new Date(`${task.date}T00:00`).getTime() : NaN;
    return (showCompleted || task.status !== "done") && date >= today.getTime() && date < end.getTime();
  }).sort((a, b) => a.date.localeCompare(b.date) || (a.time || "24:00").localeCompare(b.time || "24:00"));
}

function TaskListWidget({ widget, tasks, now, onEdit }) {
  const visible = scheduledTasks(tasks, now, widget.type, widget.config.showCompleted);
  return <div className="widget-task-list">
    {visible.length ? visible.map(task => <button key={task.id} onClick={() => onEdit({ ...task })} className={`widget-task ${task.status}`}>
      <span className="widget-task-dot" />
      <span>{task.title}<small>{task.date.slice(5).replace("-", "/")}{task.time && ` ${task.time}`}{task.urgent && "・優先處理"}</small></span>
      <span className="widget-task-status">{{ todo: "待處理", doing: "進行中", done: "已完成" }[task.status]}</span>
    </button>) : <p className="widget-empty">{widget.type === "today" ? "今天沒有待辦任務" : "未來 7 天沒有到期任務"}</p>}
  </div>;
}

export function remainingSeconds(config, now) {
  if (config.endsAt && now !== null) return Math.max(0, Math.ceil((config.endsAt - now) / 1000));
  return config.remaining ?? (config.minutes || 25) * 60;
}

function TimerWidget({ widget, tasks, now, onConfigure }) {
  const config = widget.config;
  const remaining = remainingSeconds(config, now);
  const running = Boolean(config.endsAt) && remaining > 0;
  const completed = Boolean(config.endsAt) && remaining === 0;
  const availableTasks = tasks.filter(task => task.status !== "done" || task.id === config.taskId);
  return <div className="timer-widget">
    <select aria-label="專注任務" value={availableTasks.some(task => task.id === config.taskId) ? config.taskId : ""} onChange={event => onConfigure({ taskId: event.target.value })}>
      <option value="">選擇專注任務（選填）</option>
      {availableTasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
    </select>
    <div className="timer-digits" role="timer" aria-label="專注剩餘時間">{String(Math.floor(remaining / 60)).padStart(2, "0")}<span>:</span>{String(remaining % 60).padStart(2, "0")}</div>
    <p className="timer-status" role="status">{completed ? "專注完成" : running ? "專注中" : "尚未開始"}</p>
    <div className="timer-actions"><button className="primary" disabled={now === null} onClick={() => onConfigure(running
      ? { endsAt: null, remaining }
      : { endsAt: now + (remaining || (config.minutes || 25) * 60) * 1000, remaining: null })}>{running ? "暫停" : "開始專注"}</button>
      <button className="secondary" onClick={() => onConfigure({ endsAt: null, remaining: null })}>重設</button></div>
  </div>;
}

export function WidgetSettings({ widget, onConfigure }) {
  if (widget.type === "timer") return <label className="widget-setting">每次專注分鐘數<select value={widget.config.minutes || 25} onChange={event => onConfigure({ minutes: Number(event.target.value), endsAt: null, remaining: null })}>{[15, 25, 45, 60].map(minutes => <option key={minutes} value={minutes}>{minutes} 分鐘</option>)}</select></label>;
  if (widget.type === "today" || widget.type === "upcoming") return <label className="widget-setting check-setting"><input type="checkbox" checked={Boolean(widget.config.showCompleted)} onChange={event => onConfigure({ showCompleted: event.target.checked })} />包含已完成任務</label>;
  return null;
}

export function WidgetContent({ widget, tasks, now, onEdit, onConfigure }) {
  switch (widget.type) {
    case "analytics": return <TaskAnalytics tasks={tasks} now={now} embedded />;
    case "today":
    case "upcoming": return <TaskListWidget widget={widget} tasks={tasks} now={now} onEdit={onEdit} />;
    case "timer": return <TimerWidget widget={widget} tasks={tasks} now={now} onConfigure={onConfigure} />;
    case "note": return <textarea className="widget-note" aria-label="快速筆記內容" maxLength={10000} placeholder="輸入筆記…" value={widget.config.text || ""} onChange={event => onConfigure({ text: event.target.value })} />;
    default: return null;
  }
}
