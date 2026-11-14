export const namespace = "fixture-device-4a";
export const createdAt = "2026-11-14T02:00:00.000Z";
export function workspaceFixture() {
  const task = id => ({ id, title: `任務 ${id}`, description: "描述", status: "todo", tag: "個人", priority: "高", urgent: false, date: "2026-11-20", time: "10:30", subtasks: [{ id: "sub-1", title: "步驟", done: false }], notes: "備註\n保留", completedAt: null });
  const widget = id => ({ id, type: "note", span: 6, height: 260, manualSize: true, config: { text: "筆記" } });
  return { activeBoardId: "board-a", boards: [
    { id: "board-a", name: "看板 A", description: "", wipLimit: 4, analyticsSize: { width: 600, height: 280 }, tasks: [task("task-a"), task("task-b")], widgets: [widget("widget-a"), widget("widget-b")] },
    { id: "board-b", name: "看板 B", description: "", wipLimit: 4, tasks: [task("task-a")], widgets: [widget("widget-a")] },
  ] };
}
export function storageFixture(entries) {
  const values = new Map(Object.entries(entries)); const reads = []; const writes = [];
  return { reads, writes, values, getItem(key) { reads.push(key); return values.get(key) ?? null; }, setItem(...args) { writes.push(args); throw new Error("Storage writes are forbidden"); }, removeItem() { throw new Error("Storage deletes are forbidden"); }, clear() { throw new Error("Storage clear is forbidden"); } };
}
