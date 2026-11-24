import { reference } from "./main-view-model.mjs";
import { SlowlyApiError } from "./slowly-api.mjs";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = message => { throw new SlowlyApiError(message, { code: "UNSUPPORTED_ATOMIC_ACTION", outcome: "not-sent" }); };
export function createMainUiSession(state) {
  const { controller, scopeRevision } = state;
  const check = () => { if (controller.getSnapshot().scopeRevision !== scopeRevision) throw new SlowlyApiError("此操作屬於較舊的看板，已取消。", { code: "STALE_SCOPE", outcome: "not-sent" }); };
  const board = () => { check(); const current = controller.getSnapshot(); return current.projection.workspace.boards.find(board => board.id === current.activeBoardId); };
  const action = name => (...args) => { check(); return controller[name](...args); };
  const draftKey = id => JSON.stringify([state.workspaceId, state.activeBoardId, id]);
  return {
    workspaceId: state.workspaceId,
    workspace: { ...state.projection.workspace, activeBoardId: state.activeBoardId }, busy: state.status === "loading" || state.mutation === "loading",
    reading: state.status === "loading",
    writable: state.status === "success" && state.allowWrites && state.mutation !== "loading" && !state.uncertainWrite,
    selectBoard: action("selectBoard"), saveTask: action("saveTask"), deleteTask: action("deleteTask"), saveWidget: action("saveWidget"),
    deleteBoard: action("deleteBoard"),
    widgetTypeWrites: state.projection.snapshot.readiness?.capabilities?.isolatedMutationReceipts === true,
    reorderTasks: action("reorderTasks"), reorderBoards: action("reorderBoards"), refresh: action("refresh"),
    async saveBoard(data, options) { check(); const result = await controller.saveBoard(data, options); check(); return result; },
    taskVersion(id) { check(); return reference(state.projection, "task", id, state.activeBoardId).version; },
    latestTaskVersion(id) { check(); return reference(controller.getSnapshot().projection, "task", id, controller.getSnapshot().activeBoardId).version; },
    boardVersion(id) { check(); return reference(state.projection, "board", id).version; },
    widgetVersions: Object.fromEntries(state.projection.mapping.filter(item => item.type === "widget" && item.boardFrontendId === state.activeBoardId).map(item => [item.frontendId, item.version])),
    noteDraftStore: { read: id => controller.readDraft(draftKey(id)), write: (id, value) => controller.writeDraft(draftKey(id), value), clear: (id, expected) => controller.clearDraft(draftKey(id), expected) },
    navigationGuard: controller,
    latestTask(id) { return structuredClone(board().tasks.find(task => task.id === id)); },
    async changeWidgets(update, { widgetId, expectedVersion } = {}) {
      check(); const before = board().widgets;
      if (!Array.isArray(before)) fail("缺省 Widget 清單需先明確建立，不能把顯示用預設值寫回。");
      const after = update(structuredClone(before));
      if (!Array.isArray(after) || new Set(after.map(item => item.id)).size !== after.length) fail("Widget 清單或 ID 不正確。");
      const added = after.filter(item => !before.some(old => old.id === item.id));
      const removed = before.filter(item => !after.some(next => next.id === item.id));
      const changed = after.filter(item => { const old = before.find(old => old.id === item.id); return old && !same(old, item); });
      const key = draftKey(`widget-command:${widgetId || "layout"}`);
      const savedDraft = { kind: "widget-command", before, after, expectedVersion };
      const track = async command => {
        controller.writeDraft(key, savedDraft);
        const result = await command(); controller.clearDraft(key, savedDraft); return result;
      };
      const oldIds = before.map(item => item.id); const newIds = after.map(item => item.id);
      if (added.length === 1 && !removed.length && !changed.length && same(oldIds, newIds.slice(0, -1))) return track(() => controller.saveWidget(added[0]));
      if (removed.length === 1 && !added.length && !changed.length && same(newIds, oldIds.filter(id => id !== removed[0].id))) return track(() => controller.deleteWidget(removed[0].id, { expectedVersion }));
      if (changed.length === 1 && !added.length && !removed.length && same(oldIds, newIds)) return track(() => controller.saveWidget(changed[0], { expectedVersion: widgetId === changed[0].id ? expectedVersion : undefined }));
      if (!added.length && !removed.length && !changed.length) return same(oldIds, newIds) ? null : track(() => controller.reorderWidgets(newIds));
      fail("現有 API 無法原子完成此複合操作；新增請加入尾端，清空多個組件請逐一刪除。");
    },
  };
}
