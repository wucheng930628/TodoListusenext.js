import { BackupError, STORAGE_KEYS, captureWorkspaceBackup, exportBackupJson, validateBackup } from "./workspace-backup.mjs";

const fail = (code, message) => { throw new BackupError(code, message); };
export function backupSchemaVersions(backup) {
  return backup.sources.map(source => {
    const data = JSON.parse(source.raw);
    const present = Object.hasOwn(data, "schemaVersion");
    const declared = present && Number.isSafeInteger(data.schemaVersion) ? data.schemaVersion : present ? "UNSUPPORTED" : null;
    return { storageKey: source.key, storageVersion: source.storageVersion,
      declaredSchemaVersion: declared };
  });
}

function sourceInfo(origin) {
  let url;
  try { url = new URL(origin); } catch { fail("INVALID_SOURCE", "來源網址格式不正確。"); }
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.origin !== origin) {
    fail("INVALID_SOURCE", "請在原本的本機 slowly. 網址建立備份。");
  }
  return { application: "slowly.", storage: "localStorage", origin };
}

async function sha256(text) {
  if (!globalThis.crypto?.subtle) fail("CRYPTO_UNAVAILABLE", "此環境無法計算 SHA-256。");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Pure calculation. The exact payload string, including original storage JSON, is hashed. */
export async function sealBackup(backup, origin) {
  const validated = validateBackup(exportBackupJson(backup));
  const payload = JSON.stringify({ format: "slowly-verified-backup-payload", formatVersion: 1,
    sourceInfo: sourceInfo(origin), sourceSchemaVersions: backupSchemaVersions(validated), backup: validated });
  const artifact = { format: "slowly-verified-backup", formatVersion: 1, payload,
    integrity: { algorithm: "SHA-256", fingerprint: await sha256(payload) } };
  await verifyBackupArtifact(JSON.stringify(artifact));
  return artifact;
}

/** Call only from an explicit user action. No effect or import reads browser storage. */
export async function captureVerifiedBackup({ storage, origin, createdAt } = {}) {
  const backup = captureWorkspaceBackup({ storage, createdAt });
  const sourceStorage = storage ?? globalThis.localStorage;
  for (const key of STORAGE_KEYS) {
    if (sourceStorage.getItem(key) !== (backup.sources.find(source => source.key === key)?.raw ?? null)) fail("SOURCE_CHANGED", "備份期間資料已變更，請暫停編輯後重新操作。");
  }
  return sealBackup(backup, origin);
}

// Structural parsing is shared with the synchronous server-side SHA-256 verifier.
// Callers must verify the exact payload bytes before trusting the returned metadata.
export function parseBackupArtifact(input) {
  let artifact;
  try { artifact = typeof input === "string" ? JSON.parse(input) : structuredClone(input); }
  catch { fail("INVALID_JSON", "備份檔不是有效 JSON。"); }
  if (artifact?.format !== "slowly-verified-backup" || artifact.formatVersion !== 1 || typeof artifact.payload !== "string" ||
    Object.keys(artifact).some(key => !["format", "formatVersion", "payload", "integrity"].includes(key))) fail("UNSUPPORTED_VERSION", "備份格式或版本不支援。");
  if (!artifact.integrity || Object.keys(artifact.integrity).some(key => !["algorithm", "fingerprint"].includes(key)) ||
    artifact.integrity.algorithm !== "SHA-256" || !/^[a-f0-9]{64}$/.test(artifact.integrity.fingerprint || "")) fail("FINGERPRINT_MISMATCH", "備份 Fingerprint 不符，請停止使用此檔案。");
  let payload;
  try { payload = JSON.parse(artifact.payload); } catch { fail("INVALID_JSON", "備份內容不是有效 JSON。"); }
  if (payload?.format !== "slowly-verified-backup-payload" || payload.formatVersion !== 1 ||
    Object.keys(payload).some(key => !["format", "formatVersion", "sourceInfo", "sourceSchemaVersions", "backup"].includes(key))) fail("UNSUPPORTED_VERSION", "備份內容版本不支援。");
  const backup = validateBackup(payload.backup);
  if (JSON.stringify(payload.sourceInfo) !== JSON.stringify(sourceInfo(payload.sourceInfo?.origin)) ||
    JSON.stringify(payload.sourceSchemaVersions) !== JSON.stringify(backupSchemaVersions(backup))) fail("SOURCE_MISMATCH", "來源或版本資訊與備份不一致。");
  const roundTrip = validateBackup(exportBackupJson(backup));
  if (backup.sources.some((source, index) => roundTrip.sources[index].raw !== source.raw)) fail("ROUND_TRIP_FAILED", "原始 JSON 往返驗證失敗。");
  return { backup, fingerprint: artifact.integrity.fingerprint, sourceInfo: payload.sourceInfo, sourceSchemaVersions: payload.sourceSchemaVersions, payload: artifact.payload };
}

export async function verifyBackupArtifact(input) {
  const parsed = parseBackupArtifact(input);
  if (await sha256(parsed.payload) !== parsed.fingerprint) fail("FINGERPRINT_MISMATCH", "備份 Fingerprint 不符，請停止使用此檔案。");
  const { payload: _payload, ...verified } = parsed;
  return verified;
}

export function downloadBackupArtifact(artifact) {
  const text = JSON.stringify(artifact, null, 2);
  const url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `slowly-backup-${Date.now()}-${artifact.integrity.fingerprint.slice(0, 12)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
