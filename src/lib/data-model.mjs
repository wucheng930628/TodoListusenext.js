import "server-only";
import { randomUUID } from "node:crypto";

export class DataError extends Error {
  constructor(code, message, options) { super(message, options); this.name = "DataError"; this.code = code; }
}
export function requireValue(condition, message, code = "VALIDATION") {
  if (!condition) throw new DataError(code, message);
}
export const INDEX_NAME = "SlowlyByParent";
export const TYPES = ["WORKSPACE", "BOARD", "TASK", "WIDGET"];
export function assertId(id, type) {
  requireValue(typeof id === "string" && new RegExp(`^SLOWLY#${type}#[a-f0-9-]{36}$`).test(id), `Invalid ${type} id`);
}
function text(value, max, required = false) {
  return typeof value === "string" && value.length <= max && (!required || value.trim().length > 0);
}
function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function json(value) {
  requireValue(value !== undefined && (value === null || ["string", "boolean"].includes(typeof value) ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every(item => { json(item); return true; })) ||
    (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(item => { json(item); return true; }))), "Only finite JSON data is supported");
}
export function validateData(type, data) {
  requireValue(data && Object.getPrototypeOf(data) === Object.prototype, "Expected an object");
  json(data);
  if (type !== "WORKSPACE") requireValue(text(data.id, 200, true), "A frontend id is required");
  if (type === "WORKSPACE") {
    requireValue(!("boards" in data), "Save workspace metadata separately from boards");
    requireValue(data.activeBoardId === undefined || text(data.activeBoardId, 200), "Invalid activeBoardId");
  }
  if (type === "BOARD") {
    requireValue(!("tasks" in data) && !("widgets" in data), "Save board children separately");
    requireValue(text(data.name, 50, true) && text(data.description, 200), "Invalid board text");
    requireValue(integer(data.wipLimit, 1, 100), "Invalid WIP limit");
  }
  if (type === "TASK") {
    requireValue(text(data.title, 100, true) && text(data.description, 1000) && text(data.notes, 5000), "Invalid task text");
    requireValue(["todo", "doing", "done"].includes(data.status), "Invalid status");
    requireValue(["低", "一般", "高"].includes(data.priority) && text(data.tag, 100, true), "Invalid priority or tag");
    requireValue(typeof data.urgent === "boolean", "Invalid urgent flag");
    requireValue(data.date === "" || validDate(data.date), "Invalid date");
    requireValue(data.time === "" || (Boolean(data.date) && typeof data.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(data.time)), "Invalid time");
    requireValue(data.completedAt == null || (typeof data.completedAt === "string" && Number.isFinite(Date.parse(data.completedAt))), "Invalid completedAt");
    requireValue(Array.isArray(data.subtasks) && data.subtasks.every(item => item && text(item.id, 200, true) && text(item.title, 150, true) && typeof item.done === "boolean") && new Set(data.subtasks.map(item => item.id)).size === data.subtasks.length, "Invalid subtasks");
  }
  if (type === "WIDGET") {
    requireValue(["analytics", "today", "upcoming", "timer", "note"].includes(data.type), "Invalid widget type");
    requireValue(integer(data.span, 4, 12) && integer(data.height, 170, 600), "Invalid widget size");
    requireValue(data.manualSize === undefined || typeof data.manualSize === "boolean", "Invalid manualSize");
    requireValue(data.config && Object.getPrototypeOf(data.config) === Object.prototype, "Invalid widget config");
    const c = data.config;
    requireValue(c.text === undefined || text(c.text, 10000), "Invalid note");
    requireValue(c.showCompleted === undefined || typeof c.showCompleted === "boolean", "Invalid showCompleted");
    requireValue(c.minutes === undefined || [15, 25, 45, 60].includes(c.minutes), "Invalid timer minutes");
    requireValue(c.taskId === undefined || text(c.taskId, 200), "Invalid timer taskId");
    for (const key of ["remaining", "endsAt"]) requireValue(c[key] == null || integer(c[key], 0, Number.MAX_SAFE_INTEGER), `Invalid timer ${key}`);
  }
  return structuredClone(data);
}
export function fromFrontend(type, value) {
  const data = structuredClone(value);
  if (type === "WORKSPACE") delete data.boards;
  if (type === "BOARD") { delete data.tasks; delete data.widgets; }
  if (type === "TASK") Object.assign(data, { description: "", tag: "個人", priority: "一般", urgent: false, date: "", time: "", subtasks: [], notes: "", ...data });
  return validateData(type, data);
}
export function toFrontend(item) { return structuredClone(item.data); }
// Pure conversion only; never reads localStorage or writes to DynamoDB.
export function splitFrontendWorkspace(value) {
  requireValue(value && Array.isArray(value.boards), "Workspace boards are required");
  requireValue(new Set(value.boards.map(board => board.id)).size === value.boards.length, "Duplicate board ids");
  return {
    workspace: fromFrontend("WORKSPACE", value),
    boards: value.boards.map((board, position) => {
      requireValue(Array.isArray(board.tasks), "Board tasks are required");
      requireValue(new Set(board.tasks.map(task => task.id)).size === board.tasks.length, "Duplicate task ids within board");
      requireValue(board.widgets === undefined || Array.isArray(board.widgets), "Invalid widgets");
      if (board.widgets) requireValue(new Set(board.widgets.map(widget => widget.id)).size === board.widgets.length, "Duplicate widget ids within board");
      return {
        position, data: fromFrontend("BOARD", board),
        tasks: board.tasks.map((task, position) => ({ position, data: fromFrontend("TASK", task) })),
        ...(board.widgets === undefined ? {} : { widgets: board.widgets.map((widget, position) => ({ position, data: fromFrontend("WIDGET", widget) })) }),
      };
    }),
  };
}
export function joinFrontendWorkspace(snapshot) {
  const sorted = rows => [...rows].sort((a, b) => a.position - b.position);
  return {
    ...structuredClone(snapshot.workspace),
    boards: sorted(snapshot.boards).map(board => ({
      ...structuredClone(board.data), tasks: sorted(board.tasks).map(task => structuredClone(task.data)),
      ...(board.widgets === undefined ? {} : { widgets: sorted(board.widgets).map(widget => structuredClone(widget.data)) }),
    })),
  };
}
export function makeItem(type, data, { parent, workspaceId, position = 0, now = new Date().toISOString() } = {}) {
  requireValue(TYPES.includes(type), "Unknown entity type");
  requireValue(integer(position, 0, 999999999999), "Invalid position");
  if (type === "BOARD") assertId(parent, "WORKSPACE");
  if (["TASK", "WIDGET"].includes(type)) { assertId(parent, "BOARD"); assertId(workspaceId, "WORKSPACE"); }
  const item = { id: `SLOWLY#${type}#${randomUUID()}`, entityType: type, schemaVersion: 1, version: 1, createdAt: now, updatedAt: now, position, data: validateData(type, data) };
  if (type === "BOARD") Object.assign(item, { workspaceId: parent, taskCount: 0, widgetCount: 0, doingCount: 0 });
  if (["TASK", "WIDGET"].includes(type)) Object.assign(item, { boardId: parent, workspaceId });
  if (parent) Object.assign(item, { parentId: parent, gsi1pk: parent, gsi1sk: `${type}#${String(position).padStart(12, "0")}#${item.id}` });
  assertItemSize(item);
  return item;
}
export function assertItemSize(item) {
  // Conservative budget leaves space for DynamoDB attribute-name/type overhead.
  requireValue(Buffer.byteLength(JSON.stringify(item), "utf8") < 350000, "Item exceeds the supported size budget");
}
