"use client";
import { useEffect, useRef, useState } from "react";
import TaskCalendar from "./task-calendar";
import TaskPanel from "./task-panel";
import { completionUpdate } from "./task-analytics";
import WidgetDashboard from "./widget-dashboard";
import { boardWidgets } from "./widgets";
import { readLocalPrimary } from "../lib/client/local-primary.mjs";
const columns = [{ id: "todo", name: "待處理", en: "REQUESTED" }, { id: "doing", name: "進行中", en: "IN PROGRESS" }, { id: "done", name: "已完成", en: "DONE" }];
const blank = { title: "", description: "", status: "todo", tag: "個人", priority: "一般", urgent: false, date: "", time: "", subtasks: [], notes: "" };
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
function isTask(task) {
    return task && typeof task.id === "string" && typeof task.title === "string" &&
        typeof task.description === "string" && columns.some(column => column.id === task.status);
}

function isOverdue(task, now) {
    if (!task.date || task.status === "done" || now === null) return false;

    const deadline = new Date(`${task.date}T${task.time || "00:00"}`);
    if (!task.time) deadline.setDate(deadline.getDate() + 1);
    return now >= deadline.getTime();
}

function TaskDeadline({ task, now }) {
    if (!task.date) return null;

    const overdue = isOverdue(task, now);
    const dateTime = task.time ? `${task.date}T${task.time}` : task.date;
    return (
        <time
            className={overdue ? "deadline overdue" : "deadline"}
            dateTime={dateTime}
            title={`截止 ${task.date}${task.time ? ` ${task.time}` : "（當天結束）"}`}
        >
            {overdue && <span>已逾期 </span>}
            {task.date.slice(5).replace("-", "/")}{task.time && ` ${task.time}`}
        </time>
    );
}

export default function WorkspaceBoard({ apiSession = null, navigationGuard = apiSession?.navigationGuard, localWritesAllowed = true }) {
    const apiMode = Boolean(apiSession);
    const [localWorkspace, restoreLocalWorkspace] = useState({
        activeBoardId: "default",
        boards: [{ id: "default", name: "我的看板", description: "把想法化為行動，照自己的步調前進。", wipLimit: 4, tasks: initial }],
    });
    const workspace = apiSession?.workspace || localWorkspace;
    const [localDirty, setLocalDirty] = useState(false);
    function setWorkspace(update) { if (!localWritesAllowed) return; setLocalDirty(true); restoreLocalWorkspace(update); }
    const [localReady, setReady] = useState(false);
    const ready = apiMode ? apiSession.writable : localReady && localWritesAllowed;
    const [now, setNow] = useState(null);
    const [query, setQuery] = useState("");
    const [view, setView] = useState("list");
    const [filter, setFilter] = useState("全部任務");
    const [draft, storeTaskDraft] = useState(null);
    const editorKey = JSON.stringify([apiSession?.workspaceId || "local", workspace.activeBoardId, "task-panel"]);
    function setDraft(value) { if (value) navigationGuard?.writeDraft(editorKey, value); else navigationGuard?.clearDraft(editorKey); storeTaskDraft(value); }
    const [draftVersion, setDraftVersion] = useState(undefined);
    const [boardDraft, storeBoardDraft] = useState(null);
    const boardEditorKey = JSON.stringify(["board-editor", workspace.activeBoardId]);
    function setBoardDraft(value) { if (value) navigationGuard?.writeDraft(boardEditorKey, value); else navigationGuard?.clearDraft(boardEditorKey); storeBoardDraft(value); }
    function closeTaskDraft() { if (!navigationGuard || window.confirm("明確捨棄此任務草稿並關閉？")) setDraft(null); }
    function closeBoardDraft() { if (apiSession?.busy) return; if (!navigationGuard || window.confirm("明確捨棄此看板草稿並關閉？")) setBoardDraft(null); }
    const [boardVersion, setBoardVersion] = useState(undefined);
    const [boardError, setBoardError] = useState("");
    const [notification, setNotification] = useState(null);
    const notice = notification?.message || "";
    const boardDialog = useRef(null);
    const board = workspace.boards.find(item => item.id === workspace.activeBoardId) || workspace.boards[0];
    const tasks = board.tasks;

    useEffect(() => {
        const updateClock = () => setNow(Date.now());
        updateClock();
        const timer = setInterval(updateClock, 1000);
        return () => clearInterval(timer);
    }, []);

    function setNotice(message) {
        setNotification(message ? { message } : null);
    }

    useEffect(() => {
        if (!notification) return;

        const timer = setTimeout(() => setNotification(null), 3000);
        return () => clearTimeout(timer);
    }, [notification]);

    function setTasks(update) {
        setWorkspace(current => ({
            ...current,
            boards: current.boards.map(item => item.id === board.id ? { ...item, tasks: completionUpdate(item.tasks, update(item.tasks), new Date().toISOString()) } : item),
        }));
    }

    useEffect(() => {
        if (apiMode) return;
        try {
            const { raw: saved, legacyBlocked } = readLocalPrimary(localStorage);
            if (saved) {
                const value = JSON.parse(saved);
                if (!Array.isArray(value.boards) || !value.boards.length || !value.boards.every(item =>
                    item && typeof item.id === "string" && typeof item.name === "string" &&
                    typeof item.description === "string" && Number.isInteger(item.wipLimit) && item.wipLimit >= 1 &&
                    Array.isArray(item.tasks) && item.tasks.every(isTask)
                ) || new Set(value.boards.map(item => item.id)).size !== value.boards.length) {
                    throw new Error("Invalid workspace");
                }
                restoreLocalWorkspace({
                    ...value,
                    activeBoardId: value.boards.some(item => item.id === value.activeBoardId) ? value.activeBoardId : value.boards[0].id,
                    boards: value.boards.map(item => ({
                        ...item,
                        // Restore default text saved by the earlier encoding error.
                        name: item.id === "default" && item.name === "????" ? "我的看板" : item.name,
                        description: item.id === "default" && item.description === "?????????????????"
                            ? "把想法化為行動，照自己的步調前進。"
                            : item.description,
                        tasks: item.tasks.map(task => ({ ...blank, ...task })),
                    })),
                });
            } else if (legacyBlocked) {
                setNotice("Primary 資料缺失；Legacy 原始資料保留，已阻擋自動匯入。請使用備份檢查流程。");
                return;
            }
            setReady(true);
        } catch {
            setNotice("讀取本機紀錄失敗，請重新整理後再試。原有紀錄仍保留在瀏覽器。");
        }
    }, [apiMode]);

    useEffect(() => {
        if (apiMode) return;
        if (!ready || !localDirty) return;
        try {
            localStorage.setItem("slowly-workspace-v2", JSON.stringify(workspace));
        } catch {
            setNotice("瀏覽器儲存空間無法使用，目前變更僅保留於此頁。");
        }
    }, [workspace, ready, apiMode, localDirty]);

    useEffect(() => {
        if (boardDraft) boardDialog.current?.showModal();
        else boardDialog.current?.close();
    }, [boardDraft]);

    function selectBoard(id) {
        try { navigationGuard?.guardSwitch(); } catch (error) { setNotice(error.message); return; }
        if (apiMode) { setQuery(""); setFilter("全部任務"); setDraft(null); setNotice(""); apiSession.selectBoard(id); return; }
        setWorkspace(current => ({ ...current, activeBoardId: id }));
        setQuery("");
        setFilter("全部任務");
        setDraft(null);
        setNotice("");
    }
    function openTask(value) {
        if (!apiMode && !ready) { setNotice("請先完成本機來源與操作恢復檢查。"); return; }
        if (draft) { setNotice("請先儲存或明確關閉目前草稿。"); return; }
        if (apiMode) setDraftVersion(value.id ? apiSession.taskVersion(value.id) : undefined);
        setDraft(apiMode ? structuredClone(value) : value);
    }
    async function reloadTask() {
        if (!window.confirm("重新讀取將以伺服器資料取代目前草稿，確定繼續？")) return;
        await apiSession.refresh();
        setDraft(apiSession.latestTask(draft.id)); setDraftVersion(apiSession.latestTaskVersion(draft.id));
    }
    function dropBoard(event, beforeId) {
        if (!apiMode || !ready) return;
        event.preventDefault();
        const id = event.dataTransfer.getData("application/x-slowly-board");
        if (!id || id === beforeId) return;
        const ids = workspace.boards.map(board => board.id).filter(value => value !== id);
        ids.splice(ids.indexOf(beforeId), 0, id);
        void apiSession.reorderBoards(ids).catch(error => setNotice(error.message));
    }
    function dropTask(event, before) {
        if (!apiMode || !ready) return;
        event.preventDefault(); event.stopPropagation();
        const id = event.dataTransfer.getData("text/plain");
        const moving = tasks.find(task => task.id === id);
        if (!moving || id === before.id) return;
        if (moving.status !== before.status || moving.urgent !== before.urgent) { setNotice("請先移到相同狀態，再拖曳排列。"); return; }
        const ids = tasks.map(task => task.id).filter(value => value !== id);
        ids.splice(ids.indexOf(before.id), 0, id);
        void apiSession.reorderTasks(ids).catch(error => setNotice(error.message));
    }

    function openBoardSettings(value = { name: "", description: "", wipLimit: 4 }) {
        setBoardError("");
        setBoardDraft({ ...value });
        if (apiMode) setBoardVersion(value.id ? apiSession.boardVersion(value.id) : undefined);
    }

    async function removeBoard() {
        const existing = workspace.boards.find(item => item.id === boardDraft.id);
        if (existing?.tasks.length || existing?.widgets?.length) {
            setBoardError("看板仍有任務或小組件，無法刪除。");
            return;
        }
        if (!window.confirm("確定刪除此看板？")) return;
        try {
            await apiSession.deleteBoard(boardDraft.id, { expectedVersion: boardVersion });
            setBoardDraft(null);
        } catch (error) { setBoardError(error.message); }
    }

    function saveBoard(event) {
        event.preventDefault();
        if (apiMode) {
            setBoardError("");
            void apiSession.saveBoard({ ...boardDraft, wipLimit: Number(boardDraft.wipLimit) }, { expectedVersion: boardVersion }).then(() => { setBoardDraft(null); setNotice("看板已儲存。"); }, error => setBoardError(error.message));
            return;
        }
        const name = boardDraft.name.trim();
        const wipLimit = Number(boardDraft.wipLimit);
        if (!name) {
            setBoardError("請輸入看板名稱。");
            return;
        }
        if (!Number.isInteger(wipLimit) || wipLimit < 1 || wipLimit > 100) {
            setBoardError("進行中上限請填入 1 至 100 的整數。");
            return;
        }
        const existing = workspace.boards.find(item => item.id === boardDraft.id);
        if (existing && existing.tasks.filter(task => task.status === "doing").length > wipLimit) {
            setBoardError("上限需大於或等於目前進行中的任務數量。");
            return;
        }
        const settings = { name, description: boardDraft.description.trim(), wipLimit };
        const id = boardDraft.id || crypto.randomUUID();
        setWorkspace(current => ({
            ...current,
            activeBoardId: id,
            boards: existing
                ? current.boards.map(item => item.id === id ? { ...item, ...settings } : item)
                : [...current.boards, { id, ...settings, tasks: [] }],
        }));
        setQuery("");
        setFilter("全部任務");
        setBoardDraft(null);
        setNotice(existing ? "看板設定已儲存。" : "新看板已建立。");
    }
    const doing = tasks.filter(t => t.status === "doing").length;
    function move(id, status, urgent) {
        if (apiMode) { void apiSession.saveTask({ ...tasks.find(task => task.id === id), status, urgent }, { expectedVersion: apiSession.taskVersion(id) }).then(() => setNotice("任務已移動。"), error => setNotice(error.message)); return; }
        const current = tasks.find(t => t.id === id); if (!current)
        return; if (status === "doing" && current.status !== "doing" && doing >= board.wipLimit) {
        setNotice(`進行中已達 ${board.wipLimit} 項上限，先完成一件任務再繼續吧。`);
        return;
    } setTasks(items => items.map(t => t.id === id ? { ...t, status, urgent } : t)); setNotice("任務已移動。"); }
    function save(event) {
        event.preventDefault();
        if (apiMode) return apiSession.saveTask(draft, { expectedVersion: draftVersion }).then(() => { setDraft(null); setNotice("任務已儲存。"); });
        if (!draft.title.trim()) return "請輸入任務名稱。";
        if (draft.status === "doing" && tasks.find(task => task.id === draft.id)?.status !== "doing" && doing >= board.wipLimit) {
            return `進行中已達 ${board.wipLimit} 項上限，請選擇其他狀態。`;
        }
        const subtasks = (draft.subtasks || []).map(item => ({ ...item, title: item.title.trim() }));
        if (subtasks.some(item => !item.title)) {
            return "請填寫子任務名稱或移除空白子任務。";
        }
        const task = {
            ...draft,
            title: draft.title.trim(),
            description: draft.description.trim(),
            notes: (draft.notes || "").trim(),
            subtasks,
            time: draft.date ? draft.time || "" : "",
            id: draft.id || crypto.randomUUID(),
        };
        setTasks(items => draft.id ? items.map(item => item.id === draft.id ? task : item) : [...items, task]);
        setDraft(null);
        setNotice("任務已儲存。");
    }

    function deleteTask() {
        if (!window.confirm(`確定刪除「${draft.title}」？`)) return;
        if (apiMode) return apiSession.deleteTask(draft.id, { expectedVersion: draftVersion }).then(() => { setDraft(null); setNotice("任務已刪除。"); });
        setTasks(items => items.filter(task => task.id !== draft.id));
        setDraft(null);
        setNotice("任務已刪除。");
    }
    const filteredTasks = tasks.filter(t => (filter !== "高優先" || t.priority === "高") && (filter !== "未完成" || t.status !== "done") && `${t.title} ${t.description} ${t.tag}`.toLowerCase().includes(query.toLowerCase()));
    function column(c, urgent) { const visible = filteredTasks.filter(t => t.status === c.id && t.urgent === urgent); return <section className={`column ${c.id}`} key={c.id} aria-label={`${urgent ? "優先" : "一般"}${c.name}`} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); move(e.dataTransfer.getData("text/plain"), c.id, urgent); }}>{!urgent && <header className="column-header"><div><i /><h2>{c.name}</h2><b>{tasks.filter(t => t.status === c.id).length}</b>{c.id === "doing" && <small>WIP {doing}/{board.wipLimit}</small>}</div></header>}<div className="cards">{visible.map(t => <article className="task-card" key={t.id} draggable={!apiMode || ready} onDragOver={event => { if (apiMode && ready) event.preventDefault(); }} onDrop={event => dropTask(event, t)} onClick={event => { if (!event.target.closest("button, select, input, textarea, a")) openTask({ ...t }); }} onDragStart={e => { e.dataTransfer.setData("text/plain", t.id); e.dataTransfer.effectAllowed = "move"; }}><div className="card-top"><span className={`tag tag-${t.tag}`}>{t.tag}</span><button aria-label={`編輯 ${t.title}`} onClick={() => openTask({ ...t })}>•••</button></div><button className="task-title" onClick={() => openTask({ ...t })}>{t.status === "done" && <span className="check">✓ </span>}{t.title}</button><div className="card-bottom"><span className={t.priority === "高" ? "high" : ""}>⚑ {t.priority}優先</span><TaskDeadline task={t} now={now} />{t.subtasks?.length > 0 && <span className="card-subtasks" aria-label={`子任務完成 ${t.subtasks.filter(item => item.done).length} / ${t.subtasks.length}`}>☑ {t.subtasks.filter(item => item.done).length}/{t.subtasks.length}</span>}<select disabled={apiMode && !ready} aria-label={`移動 ${t.title}`} value={t.status} onChange={e => move(t.id, e.target.value, t.urgent)}>{columns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div></article>)}{!visible.length && <div className="empty">{query || filter !== "全部任務" ? "沒有符合的任務" : "尚無任務"}</div>}</div><button className="add-card" disabled={!ready} onClick={() => openTask({ ...blank, status: c.id, urgent })}>＋ 新增任務</button></section>; }
    return <div className="shell"><aside><a href="/" className="brand"><span className="brand-mark">s·</span>slowly.</a><div className="workspace">我的工作空間</div><nav className="board-nav" aria-label="看板清單">{workspace.boards.map(item => <button key={item.id} draggable={apiMode && ready} onDragStart={event => { if (apiMode) event.dataTransfer.setData("application/x-slowly-board", item.id); }} onDragOver={event => { if (apiMode && ready) event.preventDefault(); }} onDrop={event => dropBoard(event, item.id)} className={item.id === board.id ? "board-link active-nav" : "board-link"} aria-current={item.id === board.id ? "page" : undefined} onClick={() => selectBoard(item.id)}><span aria-hidden="true">▦</span><span className="board-name">{item.name}</span><small>{item.tasks.length}</small></button>)}</nav><button className="new-board" disabled={!ready} onClick={() => openBoardSettings()}>＋ 新增看板</button><div className="profile"><span>我</span><div>我的空間</div></div></aside><main><header className="topbar"><div>工作空間 <span>/</span> <strong>{board.name}</strong></div><div className="topbar-info"><time className="current-time" aria-label="現在時間" dateTime={now === null ? undefined : new Date(now).toISOString()}>{now === null ? "載入時間…" : new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(now)}</time><small>● {apiMode ? (apiSession.reading ? "API 讀取中" : apiSession.busy ? "API 儲存中" : ready ? "API · 已授權寫入" : "API · 唯讀") : ready ? "已儲存於此瀏覽器" : "載入中"}</small></div></header><div className="content"><div className="page-heading"><div><h1>{board.name}</h1>{board.description && board.description !== "把想法化為行動，照自己的步調前進。" && <p>{board.description}</p>}</div><div className="heading-actions"><button className="board-settings-button" disabled={!ready} aria-label="看板設定" title="看板設定" onClick={() => openBoardSettings(board)}><span aria-hidden="true">⚙</span></button><button className="primary" disabled={!ready} onClick={() => openTask({ ...blank })}>＋ 新增任務</button></div></div><div className="mobile-boards"><select aria-label="切換看板" value={board.id} onChange={event => selectBoard(event.target.value)}>{workspace.boards.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button className="secondary" disabled={!ready} onClick={() => openBoardSettings()}>＋ 新增看板</button></div><WidgetDashboard key={board.id} widgets={boardWidgets(board)} tasks={tasks} now={now} asyncMode={apiMode} versions={apiSession?.widgetVersions} noteDraftStore={apiSession?.noteDraftStore} typeWrites={apiSession?.widgetTypeWrites} ready={ready && (!apiMode || Array.isArray(board.widgets))} onEdit={openTask} onChange={apiMode ? apiSession.changeWidgets : update => setWorkspace(current => ({ ...current, boards: current.boards.map(item => item.id === board.id ? { ...item, widgets: update(boardWidgets(item)) } : item) }))} />{apiMode && !Object.hasOwn(board, "widgets") && <div role="status"><p>此看板的 Widget 為缺省；下方統計只作檢視，不會自動建立資料。</p><button className="secondary" disabled={!ready} onClick={() => { void apiSession.saveWidget({ id: crypto.randomUUID(), type: "analytics", span: 12, height: 320, config: {} }).catch(error => setNotice(error.message)); }}>建立統計小組件</button></div>}<div className="view-switch" role="group" aria-label="任務檢視方式">{[{ id: "list", label: "清單" }, { id: "week", label: "週曆" }, { id: "month", label: "月曆" }].map(item => <button key={item.id} className={view === item.id ? "selected" : ""} aria-pressed={view === item.id} onClick={() => setView(item.id)}>{item.label}</button>)}</div><div className="toolbar"><div className="tabs">{["全部任務", "未完成", "高優先"].map(f => <button key={f} className={filter === f ? "selected" : ""} onClick={() => setFilter(f)}>{f}{f === "全部任務" && <span>{tasks.length}</span>}</button>)}</div><label className="search"><span>⌕</span><input aria-label="搜尋任務" placeholder="搜尋任務…" value={query} onChange={e => setQuery(e.target.value)}/></label></div>{view === "list" ? <><div className="board-grid">{columns.map(c => column(c, false))}</div><div className="swimlane-heading"><div><span>ϟ</span><h2>優先處理</h2></div></div><div className="board-grid urgent">{columns.map(c => column(c, true))}</div></> : <TaskCalendar tasks={filteredTasks} view={view} now={now} ready={ready} onEdit={openTask} onCreate={(date, time = "") => openTask({ ...blank, date, time })} />}</div></main>{notice && <div className="toast" role="status">{notice}<button aria-label="關閉通知" onClick={() => setNotice("")}>×</button></div>}{draft && <TaskPanel key={draft.id || "new"} task={draft} asyncMode={apiMode} readOnly={apiMode && !ready} onReloadLatest={apiMode && draft.id ? reloadTask : undefined} columns={columns} onChange={setDraft} onSave={save} onClose={closeTaskDraft} onDelete={deleteTask} />}<dialog ref={boardDialog} onCancel={event => { event.preventDefault(); closeBoardDraft(); }} onClick={event => { if (event.target === boardDialog.current) closeBoardDraft(); }}>{boardDraft && <form onSubmit={saveBoard}><div className="modal-heading"><h2>{boardDraft.id ? "看板設定" : "新增看板"}</h2><button type="button" aria-label="關閉看板設定" disabled={apiSession?.busy} onClick={closeBoardDraft}>×</button></div><label>看板名稱<input autoFocus disabled={apiSession?.busy} required maxLength={50} placeholder="例如：工作計畫、日常生活" value={boardDraft.name} onChange={event => setBoardDraft({ ...boardDraft, name: event.target.value })} /></label><label>看板描述<textarea disabled={apiSession?.busy} rows={3} maxLength={200} placeholder="看板描述（選填）" value={boardDraft.description} onChange={event => setBoardDraft({ ...boardDraft, description: event.target.value })} /></label><label>進行中任務上限（WIP）<input type="number" disabled={apiSession?.busy} required min={1} max={100} step={1} value={boardDraft.wipLimit} onChange={event => setBoardDraft({ ...boardDraft, wipLimit: event.target.value })} /></label>{boardError && <p className="form-error" role="alert">{boardError}</p>}<div className="modal-actions">{apiMode && boardDraft.id && <button type="button" className="secondary" disabled={!ready} onClick={removeBoard}>刪除看板</button>}<button type="button" className="secondary" disabled={apiSession?.busy} onClick={closeBoardDraft}>取消</button><button type="submit" className="primary" disabled={!ready}>{boardDraft.id ? "儲存設定" : "建立看板"}</button></div></form>}</dialog></div>;
}
