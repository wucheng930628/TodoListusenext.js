"use client";

import { useEffect, useRef, useState } from "react";
import "./task-analytics.css";

function localDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function completionUpdate(previousTasks, nextTasks, timestamp) {
  const previousById = new Map(previousTasks.map(task => [task.id, task]));
  return nextTasks.map(task => {
    const previous = previousById.get(task.id);
    const completedAt = task.status === "done"
      ? previous?.status === "done" ? previous.completedAt || null : timestamp
      : null;
    return { ...task, completedAt };
  });
}

export function getAnalytics(tasks, timestamp) {
  const today = new Date(timestamp);
  today.setHours(0, 0, 0, 0);
  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - (weekStart.getDay() + 6) % 7);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const completed = tasks.filter(task => task.status === "done");
  const datedCompleted = completed.filter(task => task.completedAt && Number.isFinite(Date.parse(task.completedAt)) && Date.parse(task.completedAt) <= timestamp);
  const counts = new Map();
  for (const task of datedCompleted) {
    const key = localDay(new Date(task.completedAt));
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setDate(date.getDate() - 6 + index);
    const key = localDay(date);
    return { key, label: `${date.getMonth() + 1}/${date.getDate()}`, count: counts.get(key) || 0 };
  });
  const completedThisWeek = datedCompleted.filter(task => Date.parse(task.completedAt) >= weekStart.getTime());
  const weeklyTasks = tasks.filter(task => {
    const due = task.date ? new Date(`${task.date}T00:00`).getTime() : NaN;
    return (due >= weekStart.getTime() && due < weekEnd.getTime()) || completedThisWeek.some(done => done.id === task.id);
  });
  const weeklyDone = weeklyTasks.filter(task => task.status === "done").length;
  let streak = 0;
  const cursor = new Date(today);
  if (!counts.has(localDay(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (counts.has(localDay(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  const overdue = tasks.filter(task => {
    if (!task.date || task.status === "done") return false;
    const deadline = new Date(`${task.date}T${task.time || "00:00"}`);
    if (!task.time) deadline.setDate(deadline.getDate() + 1);
    return timestamp >= deadline.getTime();
  }).length;
  return {
    days, streak, overdue,
    todayDone: counts.get(localDay(today)) || 0,
    totalDone: completed.length,
    overallRate: tasks.length ? Math.round(completed.length / tasks.length * 100) : 0,
    weeklyRate: weeklyTasks.length ? Math.round(weeklyDone / weeklyTasks.length * 100) : 0,
    weeklyDone,
    weeklyTotal: weeklyTasks.length,
    unknownDates: completed.length - datedCompleted.length,
  };
}

function ProgressRing({ value, label, detail, tone }) {
  return <div className="analytics-ring-card">
    <div className={`analytics-ring ${tone}`} style={{ "--progress": `${value}%` }} role="img" aria-label={`${label} ${value}%`}><span>{value}<small>%</small></span></div>
    <div><h3>{label}</h3><p>{detail}</p></div>
  </div>;
}

export function fitAnalyticsSize(width, height, availableWidth) {
  const fittedWidth = Math.min(Math.max(320, width), availableWidth);
  return { width: fittedWidth, height: Math.min(480, Math.max(fittedWidth < 640 ? 260 : 124, height)) };
}

export default function TaskAnalytics({ tasks, now, size, onResize }) {
  const panel = useRef(null);
  const drag = useRef(null);
  const [dimensions, setDimensions] = useState(size || null);
  const [measuredWidth, setMeasuredWidth] = useState(800);

  useEffect(() => {
    if (!panel.current) return;
    const observer = new ResizeObserver(([entry]) => setMeasuredWidth(entry.contentRect.width));
    observer.observe(panel.current);
    return () => observer.disconnect();
  }, [now === null]);

  function startResize(event) {
    if (event.button !== 0) return;
    const bounds = panel.current.getBoundingClientRect();
    drag.current = { x: event.clientX, y: event.clientY, width: bounds.width, height: bounds.height };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resize(event) {
    if (!drag.current) return;
    const next = fitAnalyticsSize(
      drag.current.width + event.clientX - drag.current.x,
      drag.current.height + event.clientY - drag.current.y,
      panel.current.parentElement.clientWidth,
    );
    setDimensions(next);
    return next;
  }

  function finishResize(event) {
    if (!drag.current) return;
    const next = resize(event);
    drag.current = null;
    onResize(next);
  }

  function resizeWithKeyboard(event) {
    const steps = { ArrowLeft: [-32, 0], ArrowRight: [32, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] };
    const step = steps[event.key];
    if (!step) return;
    event.preventDefault();
    const bounds = panel.current.getBoundingClientRect();
    const next = fitAnalyticsSize(bounds.width + step[0], bounds.height + step[1], panel.current.parentElement.clientWidth);
    setDimensions(next);
    onResize(next);
  }

  if (now === null) return <section className="task-analytics" aria-label="任務完成統計">正在載入統計…</section>;
  const stats = getAnalytics(tasks, now);
  const maximum = Math.max(1, ...stats.days.map(day => day.count));
  const sevenDayTotal = stats.days.reduce((total, day) => total + day.count, 0);
  const compact = measuredWidth < 600;
  const height = Math.max(compact ? 260 : 124, dimensions?.height || 124);
  const scale = Math.min(1.6, Math.max(.9, Math.min(measuredWidth / (compact ? 340 : 800), height / (compact ? 260 : 124))));
  return <section ref={panel} className={`task-analytics${compact ? " compact" : ""}`} style={{ width: dimensions?.width || "100%", height, "--analytics-scale": scale }} aria-label="任務完成統計" title={`本週從週一開始，連續完成天數由今天或昨天往前計算。${stats.unknownDates > 0 ? `另有 ${stats.unknownDates} 項既有完成任務缺少完成日期，計入整體完成率。` : ""}`}>
    <div className="analytics-content">
    <div className="analytics-layout">
      <div className="analytics-chart">
        <div className="analytics-chart-heading"><h3>近 7 天完成數</h3><span>共 <strong>{sevenDayTotal}</strong> 項</span></div>
        <div className="analytics-bars" role="img" aria-label={`近七天完成數，${stats.days.map(day => `${day.label} 完成 ${day.count} 項`).join("，")}`}>
          {stats.days.map((day, index) => <div className="analytics-bar-column" key={day.key}>
            <span className="analytics-bar-count">{day.count}</span>
            <div className="analytics-bar-track"><div className={index === 6 ? "analytics-bar today" : "analytics-bar"} style={{ height: `${day.count / maximum * 100}%` }} /></div>
            <time dateTime={day.key}>{index === 6 ? "今天" : day.label}</time>
          </div>)}
        </div>
      </div>
      <div className="analytics-rings">
        <ProgressRing value={stats.overallRate} label="整體完成率" detail={`${stats.totalDone} / ${tasks.length} 項已完成`} tone="green" />
        <ProgressRing value={stats.weeklyRate} label="本週完成率" detail={`${stats.weeklyDone} / ${stats.weeklyTotal} 項本週到期或完成`} tone="purple" />
      </div>
    </div>
    <div className="analytics-metrics">
      <div><span className="analytics-metric-icon">✓</span><div><span>今天完成</span><strong>{stats.todayDone}<small>項</small></strong></div></div>
      <div><span className="analytics-metric-icon overdue-icon">◷</span><div><span>逾期任務</span><strong>{stats.overdue}<small>項</small></strong></div></div>
      <div><span className="analytics-metric-icon streak-icon">ϟ</span><div><span>連續完成</span><strong>{stats.streak}<small>天</small></strong></div></div>
    </div>
    </div>
    <button className="analytics-resize" aria-label="調整統計大小，可拖曳或使用方向鍵" title="拖曳調整大小，或使用方向鍵" onPointerDown={startResize} onPointerMove={resize} onPointerUp={finishResize} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} onKeyDown={resizeWithKeyboard}>⤡</button>
  </section>;
}
