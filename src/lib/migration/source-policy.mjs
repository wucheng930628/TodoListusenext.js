import "server-only";
import { createHash } from "node:crypto";
import { requireValue } from "../data-model.mjs";
import { validateBackup } from "../client/workspace-backup.mjs";
import { parseBackupArtifact } from "../client/verified-backup.mjs";

const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, fields) => plain(value) && Object.keys(value).every(key => fields.includes(key));

/** No I/O. A source policy always requires the complete, authenticated backup envelope. */
export function resolveMigrationSource(input, policy) {
  const envelope = (typeof input === "string" ? JSON.parse(input) : input)?.format === "slowly-verified-backup";
  const verified = envelope ? parseBackupArtifact(input) : null;
  if (verified) requireValue(sha256(verified.payload) === verified.fingerprint, "Backup fingerprint mismatch", "PREVIEW_INVALID");
  const backup = verified?.backup ?? validateBackup(input);
  if (policy === undefined) {
    requireValue(backup.sources.length === 1, "Multiple sources require an explicit reviewed policy", "MULTIPLE_SOURCES_REQUIRE_REVIEW");
    return { backup };
  }
  requireValue(verified, "Source exclusion requires the complete verified backup", "SOURCE_POLICY_INVALID");
  requireValue(exact(policy, ["primary", "legacy"]) && policy.primary === "slowly-workspace-v2" &&
    exact(policy.legacy, ["source", "action", "acknowledged", "acknowledgementId"]) &&
    policy.legacy.source === "slowly-board-v1" && policy.legacy.action === "exclude" && policy.legacy.acknowledged === true &&
    (policy.legacy.acknowledgementId === undefined || (typeof policy.legacy.acknowledgementId === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(policy.legacy.acknowledgementId))),
  "Explicit acknowledged legacy exclusion is required", "SOURCE_POLICY_INVALID");
  requireValue(backup.selectedSourceKey === policy.primary && backup.sources.length === 2 &&
    backup.sources.some(source => source.key === policy.legacy.source), "Source policy does not match the backup", "SOURCE_POLICY_INVALID");
  // Even excluded data remains subject to backup integrity and schema compatibility checks.
  const checkSchema = value => {
    if (!value || typeof value !== "object") return;
    requireValue(!Object.hasOwn(value, "schemaVersion") || value.schemaVersion === 1, "Unsupported source schema", "UNSUPPORTED_SCHEMA");
    for (const child of Object.values(value)) checkSchema(child);
  };
  for (const source of backup.sources) checkSchema(JSON.parse(source.raw));
  const legacySource = backup.sources.find(source => source.key === policy.legacy.source);
  const legacy = JSON.parse(legacySource.raw);
  requireValue(legacy.every(task => plain(task) && typeof task.id === "string" && task.id.length > 0 &&
    (task.subtasks === undefined || (Array.isArray(task.subtasks) && task.subtasks.every(plain)))), "Invalid excluded legacy data", "SOURCE_POLICY_INVALID");
  const excluded = { tasks: legacy.length, subtasks: legacy.reduce((sum, task) => sum + (task.subtasks?.length ?? 0), 0), boards: 0, widgets: 0 };
  const exclusionSummary = { source: legacySource.key, action: "exclude", excluded, acknowledged: true, sourceFingerprint: sha256(legacySource.raw) };
  const sourceBinding = { version: 1, backupFingerprint: verified.fingerprint, sourcePolicy: structuredClone(policy),
    sourceSchemaVersions: verified.sourceSchemaVersions,
    sources: backup.sources.map(source => ({ source: source.key, storageVersion: source.storageVersion, fingerprint: sha256(source.raw) })),
    originalCounts: { workspaces: 1, ...Object.fromEntries(["boards", "tasks", "subtasks", "widgets"].map(key => [key, backup.sources.reduce((sum, source) => sum + source.summary[key], 0)])) },
    exclusionSummary };
  return { backup, sourceBinding };
}
