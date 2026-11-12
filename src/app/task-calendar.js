"use client";

import { useEffect, useRef, useState } from "react";
import "./task-calendar.css";

const weekdays = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"];
const hourHeight = 72;
const eventHeight = 48;
const hours = Array.from({ length: 24 }, (_, hour) => hour);

export function positionTasks(tasks) {
  const positioned = tasks.map(task => {
    const [hour, minute] = task.time.split(":").map(Number);
    return { task, top: Math.min((hour + minute / 60) * hourHeight, 24 * hourHeight - eventHeight) };
  }).sort((a, b) => a.top - b.top || a.task.title.localeCompare(b.task.title));
  let cluster = [];
  let laneEnds = [];
  let clusterEnd = -1;

  function finishCluster() {
    for (const event of cluster) event.lanes = laneEnds.length;
    cluster = [];
    laneEnds = [];
  }

  for (const event of positioned) {
    if (event.top >= clusterEnd) finishCluster();
    let lane = laneEnds.findIndex(end => end <= event.top);
    if (lane === -1) lane = laneEnds.length;
    event.lane = lane;
    laneEnds[lane] = event.top + eventHeight;
    clusterEnd = Math.max(...laneEnds);
    cluster.push(event);
  }
  finishCluster();
  return positioned;
}

export function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function calendarDays(anchor, view) {
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), view === "month" ? 1 : anchor.getDate());
  start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  return Array.from({ length: view === "month" ? 42 : 7 }, (_, index) => {
    const day = new Date(start);
    day.setDate(day.getDate() + index);
    return day;
  });
}

export function shiftCalendar(anchor, view, direction) {
  const next = new Date(anchor);
  if (view === "month") {
    next.setDate(1);
    next.setMonth(next.getMonth() + direction);
  } else {
    next.setDate(next.getDate() + direction * 7);
  }
  return next;
}

export default function TaskCalendar({ tasks, view, now, ready, onCreate, onEdit }) {
  const [selectedDate, setSelectedDate] = useState(null);
  const timeline = useRef(null);
  const initializedScroll = useRef(false);

  useEffect(() => {
    if (view === "week" && now !== null && timeline.current && !initializedScroll.current) {
      timeline.current.scrollTop = 8 * hourHeight;
      initializedScroll.current = true;
    }
    if (view !== "week") initializedScroll.current = false;
  }, [view, now]);
  if (now === null) return <p className="calendar-loading">正在載入行事曆…</p>;

  const today = new Date(now);
  const anchor = selectedDate || today;
  const days = calendarDays(anchor, view);
  const todayKey = dateKey(today);
  const unscheduled = tasks.filter(task => !task.date);
  const title = view === "month"
    ? `${anchor.getFullYear()} 年 ${anchor.getMonth() + 1} 月`
    : `${dateKey(days[0]).replaceAll("-", "/")} — ${dateKey(days[6]).replaceAll("-", "/")}`;

  function taskButton(task, position) {
    const status = { todo: "待處理", doing: "進行中", done: "已完成" }[task.status];
    return (
      <button
        key={task.id}
        className={`calendar-task ${task.status}`}
        style={position ? {
          position: "absolute",
          top: position.top,
          height: eventHeight,
          left: `calc(${position.lane / position.lanes * 100}% + 3px)`,
          width: `calc(${100 / position.lanes}% - 6px)`,
        } : undefined}
        onClick={() => onEdit({ ...task })}
        title={`${task.title}・${status}${task.urgent ? "・優先處理" : ""}`}
      >
        <span className="calendar-task-time">{task.date ? task.time || "當日截止" : "設定日期"}</span>
        <span className="calendar-task-title">{task.urgent && "ϟ "}{task.title}</span>
        <span className="calendar-task-status">{status}</span>
      </button>
    );
  }

  return (
    <section className={`calendar calendar-${view}`} aria-label={view === "month" ? "任務月曆" : "任務週曆"}>
      <div className="calendar-toolbar">
        <h2 aria-live="polite">{title}</h2>
        <div className="calendar-controls">
          <button className="secondary" onClick={() => setSelectedDate(shiftCalendar(anchor, view, -1))} aria-label={view === "month" ? "上一個月" : "上一週"}>‹</button>
          <button className="secondary" onClick={() => setSelectedDate(new Date(now))}>今天</button>
          <button className="secondary" onClick={() => setSelectedDate(shiftCalendar(anchor, view, 1))} aria-label={view === "month" ? "下一個月" : "下一週"}>›</button>
          <input type="date" aria-label="跳至日期" value={dateKey(anchor)} onChange={event => {
            if (event.target.value) setSelectedDate(new Date(`${event.target.value}T00:00`));
          }} />
        </div>
      </div>
      <p className="calendar-hint">{view === "week" ? "任務依截止時間定位。點選時間格新增任務，點選卡片編輯。" : "依截止日期排列，點選日期新增任務，點選任務可編輯時間。"}</p>
      {view === "week" ? <div className="timeline-scroll" ref={timeline}>
        <div className="timeline-grid">
          <div className="timeline-header">
            <div className="timeline-corner">時間</div>
            {days.map((day, index) => <div key={dateKey(day)} className={`timeline-day-header${dateKey(day) === todayKey ? " current-day" : ""}`}>
              <span>{weekdays[index]}</span><strong>{day.getDate()}</strong><small>{day.getMonth() + 1} 月</small>
            </div>)}
          </div>
          <div className="timeline-dateless">
            <div className="timeline-corner">未設時間</div>
            {days.map(day => <div key={dateKey(day)} className="timeline-date-tasks">
              {tasks.filter(task => task.date === dateKey(day) && !task.time).map(task => taskButton(task))}
            </div>)}
          </div>
          <div className="timeline-body">
            <div className="timeline-hours">{hours.map(hour => <span key={hour} style={{ top: hour * hourHeight }}>{String(hour).padStart(2, "0")}:00</span>)}</div>
            {days.map(day => {
              const key = dateKey(day);
              const events = positionTasks(tasks.filter(task => task.date === key && task.time));
              return <div key={key} className={`timeline-day${key === todayKey ? " current-day" : ""}`} aria-label={key}>
                {hours.map(hour => <button key={hour} className="timeline-slot" disabled={!ready} style={{ top: hour * hourHeight, height: hourHeight }} aria-label={`${key} ${String(hour).padStart(2, "0")}:00 新增任務`} onClick={() => onCreate(key, `${String(hour).padStart(2, "0")}:00`)} />)}
                {events.map(event => taskButton(event.task, event))}
                {key === todayKey && <div className="timeline-now" style={{ top: (today.getHours() + today.getMinutes() / 60) * hourHeight }} aria-label="現在時間指示線" />}
              </div>;
            })}
          </div>
        </div>
      </div> : <div className="calendar-scroll">
        <div className="calendar-grid">
          {weekdays.map(day => <div key={day} className="calendar-weekday">{day}</div>)}
          {days.map(day => {
            const key = dateKey(day);
            const dailyTasks = tasks.filter(task => task.date === key).sort((a, b) => (a.time || "24:00").localeCompare(b.time || "24:00") || a.title.localeCompare(b.title));
            const outside = view === "month" && day.getMonth() !== anchor.getMonth();
            return (
              <section key={key} className={`calendar-day${outside ? " outside-month" : ""}${key === todayKey ? " is-today" : ""}`} aria-label={key}>
                <button className="calendar-date" disabled={!ready} onClick={() => onCreate(key)} aria-label={`${key} 新增任務`} aria-current={key === todayKey ? "date" : undefined}>
                  <time dateTime={key}>{view === "week" ? `${day.getMonth() + 1}/${day.getDate()}` : day.getDate()}</time>
                  <span aria-hidden="true">＋</span>
                </button>
                <div className="calendar-day-tasks">{dailyTasks.map(task => taskButton(task))}</div>
                {view === "week" && !dailyTasks.length && <p className="calendar-day-empty">尚無任務</p>}
              </section>
            );
          })}
        </div>
      </div>}
      <section className="unscheduled-tasks" aria-label="未排程任務">
        <h3>未排程任務 <span>{unscheduled.length}</span></h3>
        {unscheduled.length ? <div className="unscheduled-grid">{unscheduled.map(task => taskButton(task))}</div> : <p>目前沒有未設定日期的任務。</p>}
      </section>
    </section>
  );
}
