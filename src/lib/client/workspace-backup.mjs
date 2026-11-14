export const STORAGE_KEYS = Object.freeze(["slowly-workspace-v2", "slowly-board-v1"]);
export class BackupError extends Error {
  constructor(code, message, sourceKey) { super(message); this.name = "BackupError"; this.code = code; this.sourceKey = sourceKey; }
}
function check(ok, code, message, key) { if (!ok) throw new BackupError(code, message, key); }
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

// No environment or unrelated storage is inspected. Suspected credential fields
// are rejected instead of silently redacting and producing a lossy backup.
function inspect(value, depth = 0) {
  check(depth <= 64, "INVALID_DATA", "Backup nesting is too deep.");
  if (typeof value === "number") check(Number.isFinite(value), "INVALID_DATA", "Non-finite numbers are not supported.");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    check(!/^(apikey|accesskeyid|accesstoken|refreshtoken|bearertoken|sessiontoken|awssessiontoken|token|password|secret|secretkey|secretaccesskey|awsaccesskeyid|awssecretaccesskey|authorization|credentials|privatekey|clientsecret)$/.test(normalized), "SENSITIVE_FIELD", "A suspected credential field must be reviewed before export.");
    inspect(child, depth + 1);
  }
}
function parseJson(text, key) {
  check(typeof text === "string", "INVALID_JSON", "Expected JSON text.", key);
  try { return JSON.parse(text); }
  catch { throw new BackupError("INVALID_JSON", "Invalid JSON; original storage was not changed.", key); }
}
function sourceData(source) {
  const value = parseJson(source.raw, source.key); inspect(value);
  if (source.key === STORAGE_KEYS[0]) check(isObject(value) && Array.isArray(value.boards), "INVALID_FORMAT", "Workspace must contain a boards array.", source.key);
  else check(Array.isArray(value), "INVALID_FORMAT", "Legacy storage must contain a task array.", source.key);
  return value;
}
function summarize(key, data) {
  const boards = key === STORAGE_KEYS[0] ? data.boards : [];
  const tasks = key === STORAGE_KEYS[1] ? data : boards.flatMap(board => Array.isArray(board?.tasks) ? board.tasks : []);
  return { boards: boards.length, tasks: tasks.length, subtasks: tasks.reduce((sum, task) => sum + (Array.isArray(task?.subtasks) ? task.subtasks.length : 0), 0), widgets: boards.reduce((sum, board) => sum + (Array.isArray(board?.widgets) ? board.widgets.length : 0), 0) };
}
export function validateBackup(value) {
  const backup = typeof value === "string" ? parseJson(value) : value;
  check(isObject(backup) && backup.format === "slowly-workspace-backup", "INVALID_FORMAT", "Not a slowly. backup.");
  check(backup.formatVersion === 1, "UNSUPPORTED_VERSION", "Unsupported backup version.");
  check(typeof backup.createdAt === "string" && Number.isFinite(Date.parse(backup.createdAt)), "INVALID_FORMAT", "Invalid backup timestamp.");
  check(Array.isArray(backup.sources) && backup.sources.length > 0 && backup.sources.length <= 2, "MISSING_DATA", "Backup sources are missing.");
  check(new Set(backup.sources.map(source => source?.key)).size === backup.sources.length, "INVALID_FORMAT", "Duplicate storage sources.");
  check(backup.sources.some(source => source?.key === backup.selectedSourceKey), "INVALID_FORMAT", "Selected source is missing.");
  for (const source of backup.sources) {
    check(isObject(source) && STORAGE_KEYS.includes(source.key), "UNSUPPORTED_VERSION", "Unsupported storage key.");
    check(source.storageVersion === (source.key === STORAGE_KEYS[0] ? 2 : 1), "UNSUPPORTED_VERSION", "Unsupported storage version.", source.key);
    const data = sourceData(source); const summary = summarize(source.key, data);
    check(isObject(source.summary) && Object.keys(summary).every(key => source.summary[key] === summary[key]) && Object.keys(source.summary).length === Object.keys(summary).length, "SUMMARY_MISMATCH", "Backup summary does not match its data.", source.key);
  }
  inspect(backup);
  return structuredClone(backup);
}
/** Explicit invocation only; getItem is the only storage method ever called. */
export function captureWorkspaceBackup({ storage, createdAt = new Date().toISOString() } = {}) {
  let sourceStorage;
  try { sourceStorage = storage ?? globalThis.localStorage; }
  catch { throw new BackupError("STORAGE_UNAVAILABLE", "Storage cannot be accessed."); }
  check(sourceStorage && typeof sourceStorage.getItem === "function", "STORAGE_UNAVAILABLE", "Storage cannot be accessed.");
  const sources = [];
  for (const key of STORAGE_KEYS) {
    let raw;
    try { raw = sourceStorage.getItem(key); }
    catch { throw new BackupError("STORAGE_UNAVAILABLE", "Storage read failed.", key); }
    if (raw === null) continue;
    const source = { key, storageVersion: key === STORAGE_KEYS[0] ? 2 : 1, raw };
    source.summary = summarize(key, sourceData(source)); sources.push(source);
  }
  check(sources.length > 0, "MISSING_DATA", "No slowly. storage data was found.");
  const selectedSourceKey = sources.find(source => source.key === STORAGE_KEYS[0])?.key ?? STORAGE_KEYS[1];
  return validateBackup({ format: "slowly-workspace-backup", formatVersion: 1, createdAt, selectedSourceKey, sources });
}
export function exportBackupJson(backup) { return JSON.stringify(validateBackup(backup), null, 2); }
export function readBackupSource(backup) {
  const validated = validateBackup(backup);
  return sourceData(validated.sources.find(source => source.key === validated.selectedSourceKey));
}
