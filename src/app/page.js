"use client";
import { useEffect, useRef, useState } from "react";
const columns = [{ id: "todo", name: "待處理", en: "REQUESTED" }, { id: "doing", name: "進行中", en: "IN PROGRESS" }, { id: "done", name: "已完成", en: "DONE" }];
const blank = { title: "", description: "", status: "todo", tag: "個人", priority: "一般", urgent: false, date: "" };
const initial = [
    { id: "1", title: "整理本週的靈感與想法", description: "把腦海中的點子記錄下來，為新的一週留一點空間。", tag: "個人", status: "todo" },
    { id: "2", title: "規劃個人作品集", description: "挑選喜歡的作品，整理專案故事與設計過程。", tag: "設計", status: "todo", priority: "高" },
    { id: "3", title: "閱讀 20 頁", description: "每天留一點時間，讀一本喜歡的書。", tag: "生活", status: "todo", priority: "低" },
    { id: "4", title: "打造我的第一個看板", description: "讓每個想法都有位置，讓每一步進展都看得見。", tag: "開發", status: "doing", priority: "高" },
    { id: "5", title: "建立每週運動習慣", description: "從散步 30 分鐘開始，慢慢找回自己的節奏。", tag: "生活", status: "doing" },
    { id: "6", title: "整理工作空間", description: "乾淨的桌面，清楚的思緒。", tag: "個人", status: "done" },
    { id: "7", title: "完成專案環境設定", description: "Next.js + React，一切準備就緒。", tag: "開發", status: "done" },
    { id: "8", title: "確認本週專案時程", description: "優先確認重要里程碑與交付項目。", tag: "工作", status: "todo", urgent: true, priority: "高" }
].map(task => ({ ...blank, ...task }));
export default function Home() {
    const [tasks, setTasks] = useState(initial), [ready, setReady] = useState(false), [query, setQuery] = useState(""), [filter, setFilter] = useState("全部任務"), [draft, setDraft] = useState(null), [notice, setNotice] = useState("");
    const dialog = useRef(null);
    useEffect(() => { try {
        const saved = JSON.parse(localStorage.getItem("slowly-board-v1"));
        if (Array.isArray(saved) && saved.every(t => t && typeof t.id === "string" && typeof t.title === "string" && typeof t.description === "string" && columns.some(c => c.id === t.status)))
            setTasks(saved.map(t => ({ ...blank, ...t })));
    }
    catch {
        setNotice("讀取本機紀錄失敗，目前顯示範例任務。");
    } setReady(true); }, []);
    useEffect(() => { if (ready) {
        try {
            localStorage.setItem("slowly-board-v1", JSON.stringify(tasks));
        }
        catch {
            setNotice("瀏覽器儲存空間無法使用，目前變更僅保留於此頁。");
        }
    } }, [tasks, ready]);
    useEffect(() => { if (draft)
        dialog.current?.showModal();
    else
        dialog.current?.close(); }, [draft]);
    const doing = tasks.filter(t => t.status === "doing").length, done = tasks.filter(t => t.status === "done").length, progress = tasks.length ? Math.round(done / tasks.length * 100) : 0;
    function move(id, status, urgent) { const current = tasks.find(t => t.id === id); if (!current)
        return; if (status === "doing" && current.status !== "doing" && doing >= 4) {
        setNotice("進行中已達 4 項上限，先完成一件任務再繼續吧。");
        return;
    } setTasks(items => items.map(t => t.id === id ? { ...t, status, urgent } : t)); setNotice("任務已移動。"); }
    function save(event) { event.preventDefault(); if (!draft.title.trim())
        return; if (draft.status === "doing" && tasks.find(t => t.id === draft.id)?.status !== "doing" && doing >= 4) {
        setNotice("進行中已達 4 項上限，請選擇其他狀態。");
        return;
    } const task = { ...draft, title: draft.title.trim(), description: draft.description.trim(), id: draft.id || crypto.randomUUID() }; setTasks(items => draft.id ? items.map(t => t.id === draft.id ? task : t) : [...items, task]); setDraft(null); setNotice("任務已儲存。"); }
    function column(c, urgent) { const visible = tasks.filter(t => t.status === c.id && t.urgent === urgent && (filter !== "高優先" || t.priority === "高") && (filter !== "未完成" || t.status !== "done") && `${t.title} ${t.description} ${t.tag}`.toLowerCase().includes(query.toLowerCase())); return <section className={`column ${c.id}`} key={c.id} aria-label={`${urgent ? "優先" : "一般"}${c.name}`} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); move(e.dataTransfer.getData("text/plain"), c.id, urgent); }}>{!urgent && <header className="column-header"><div><i /><h2>{c.name}</h2><b>{tasks.filter(t => t.status === c.id).length}</b>{c.id === "doing" && <small>WIP {doing}/4</small>}</div><span>{c.en}</span></header>}<div className="cards">{visible.map(t => <article className="task-card" key={t.id} draggable onDragStart={e => { e.dataTransfer.setData("text/plain", t.id); e.dataTransfer.effectAllowed = "move"; }}><div className="card-top"><span className={`tag tag-${t.tag}`}>{t.tag}</span><button aria-label={`編輯 ${t.title}`} onClick={() => setDraft({ ...t })}>•••</button></div><button className="task-title" onClick={() => setDraft({ ...t })}>{t.status === "done" && <span className="check">✓ </span>}{t.title}</button><p>{t.description || "為這件任務補充一點細節…"}</p><div className="card-bottom"><span className={t.priority === "高" ? "high" : ""}>⚑ {t.priority}優先</span>{t.date && <time dateTime={t.date}>{t.date.slice(5).replace("-", "/")}</time>}<select aria-label={`移動 ${t.title}`} value={t.status} onChange={e => move(t.id, e.target.value, t.urgent)}>{columns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div></article>)}{!visible.length && <div className="empty">{query || filter !== "全部任務" ? "沒有符合的任務" : "留點空間，給下一個想法"}</div>}</div><button className="add-card" onClick={() => setDraft({ ...blank, status: c.id, urgent })}>＋ 新增任務</button></section>; }
    return <div className="shell"><aside><a href="/" className="brand"><span className="brand-mark">s·</span>slowly.</a><div className="workspace">我的工作空間</div><div className="active-nav">▦ <span>我的看板</span><small>1</small></div><div className="sidebar-note"><span>✳</span><p>一步一步，<br />也能走得很遠。</p><small>● 本機工作空間</small></div><div className="profile"><span>我</span><div>我的空間<small>保持自己的節奏</small></div></div></aside><main><header className="topbar"><div>工作空間 <span>/</span> <strong>我的看板</strong></div><small>● {ready ? "已儲存於此瀏覽器" : "載入中"}</small></header><div className="content"><div className="page-heading"><div><div className="eyebrow">A LITTLE PROGRESS, EVERY DAY</div><h1>我的看板 <span>✳</span></h1><p>把想法化為行動，照自己的步調前進。</p></div><button className="primary" onClick={() => setDraft({ ...blank })}>＋ 新增任務</button></div><section className="overview" aria-label="任務統計"><div className="overview-intro"><span>◷</span><div><strong>每一步，都算數。</strong><p>專注眼前的小事，累積日常的進展。</p></div></div><div className="stat"><strong>{String(tasks.length).padStart(2, "0")}</strong><span>全部任務</span></div><div className="stat"><strong>{String(doing).padStart(2, "0")}</strong><span>進行中</span></div><div className="progress-stat"><div>完成進度 <strong>{progress}%</strong></div><div className="track"><span style={{ width: `${progress}%` }}/></div><small>{done} / {tasks.length} 項任務已完成</small></div></section><div className="toolbar"><div className="tabs">{["全部任務", "未完成", "高優先"].map(f => <button key={f} className={filter === f ? "selected" : ""} onClick={() => setFilter(f)}>{f}{f === "全部任務" && <span>{tasks.length}</span>}</button>)}</div><label className="search"><span>⌕</span><input aria-label="搜尋任務" placeholder="搜尋任務…" value={query} onChange={e => setQuery(e.target.value)}/></label></div><div className="board-grid">{columns.map(c => column(c, false))}</div><div className="swimlane-heading"><div><span>ϟ</span><h2>優先處理</h2><small>EXPEDITE</small></div><p>留給需要先完成的重要任務</p></div><div className="board-grid urgent">{columns.map(c => column(c, true))}</div><footer><span>⠿ 拖曳卡片即可移動任務，也可使用卡片上的狀態選單</span><span>慢慢來，比較快。 ✳</span></footer></div></main>{notice && <div className="toast" role="status">{notice}<button aria-label="關閉通知" onClick={() => setNotice("")}>×</button></div>}<dialog ref={dialog} onCancel={() => setDraft(null)} onClick={e => { if (e.target === dialog.current)
        setDraft(null); }}>{draft && <form onSubmit={save}><div className="modal-heading"><h2>{draft.id ? "編輯任務" : "新的小小目標"}</h2><button type="button" aria-label="關閉" onClick={() => setDraft(null)}>×</button></div><label>任務名稱<input autoFocus required maxLength={100} placeholder="你想完成什麼？" value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })}/></label><label>任務描述<textarea rows={3} maxLength={1000} placeholder="記下細節，讓下一步更清楚…" value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })}/></label><div className="form-row"><label>狀態<select value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value })}>{columns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>分類<select value={draft.tag} onChange={e => setDraft({ ...draft, tag: e.target.value })}>{["個人", "工作", "設計", "開發", "生活"].map(v => <option key={v}>{v}</option>)}</select></label></div><div className="form-row"><label>優先程度<select value={draft.priority} onChange={e => setDraft({ ...draft, priority: e.target.value })}>{["低", "一般", "高"].map(v => <option key={v}>{v}</option>)}</select></label><label>截止日期<input type="date" value={draft.date} onChange={e => setDraft({ ...draft, date: e.target.value })}/></label></div><label className="checkbox"><input type="checkbox" checked={draft.urgent} onChange={e => setDraft({ ...draft, urgent: e.target.checked })}/>放入優先處理泳道</label><div className="modal-actions">{draft.id && <button type="button" className="delete" onClick={() => { if (window.confirm(`確定刪除「${draft.title}」？`)) {
        setTasks(items => items.filter(t => t.id !== draft.id));
        setDraft(null);
        setNotice("任務已刪除。");
    } }}>刪除任務</button>}<button type="button" className="secondary" onClick={() => setDraft(null)}>取消</button><button type="submit" className="primary">儲存任務</button></div></form>}</dialog></div>;
}
