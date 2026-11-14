import test from "node:test";
import assert from "node:assert/strict";
import { captureWorkspaceBackup, exportBackupJson, validateBackup, readBackupSource } from "../src/lib/client/workspace-backup.mjs";
import { workspaceFixture, storageFixture, createdAt } from "./phase4a-fixtures.mjs";

test("explicit backup preserves both original JSON strings, order, unknown fields and all task/widget data", () => {
  const data = workspaceFixture(); data.future = { values: [1, "未來欄位"] }; data.boards[0].tasks[0].custom = { value: true };
  const raw = JSON.stringify(data, null, 3); const old = JSON.stringify(data.boards[0].tasks);
  const storage = storageFixture({ "slowly-workspace-v2": raw, "slowly-board-v1": old, unrelated: "must not be read" });
  const before = [...storage.values];
  const backup = captureWorkspaceBackup({ storage, createdAt });
  assert.equal(backup.selectedSourceKey, "slowly-workspace-v2");
  assert.equal(backup.sources[0].raw, raw); assert.equal(backup.sources[1].raw, old);
  assert.deepEqual(backup.sources[0].summary, { boards: 2, tasks: 3, subtasks: 3, widgets: 3 });
  assert.deepEqual(readBackupSource(exportBackupJson(backup)), data);
  assert.deepEqual(storage.reads, ["slowly-workspace-v2", "slowly-board-v1"]);
  assert.deepEqual([...storage.values], before); assert.equal(storage.writes.length, 0);
});

test("empty storage is missing data; empty collections remain exportable without seeding", () => {
  assert.throws(() => captureWorkspaceBackup({ storage: storageFixture({}) }), { code: "MISSING_DATA" });
  const backup = captureWorkspaceBackup({ storage: storageFixture({ "slowly-workspace-v2": '{"activeBoardId":"","boards":[]}' }), createdAt });
  assert.equal(backup.sources[0].summary.tasks, 0);
  assert.deepEqual(readBackupSource(backup).boards, []);
});

test("legacy storage remains a task array and never receives fabricated board metadata", () => {
  const tasks = workspaceFixture().boards[0].tasks;
  const storage = storageFixture({ "slowly-board-v1": JSON.stringify(tasks) });
  const backup = captureWorkspaceBackup({ storage, createdAt });
  assert.equal(backup.selectedSourceKey, "slowly-board-v1"); assert.equal(backup.sources[0].storageVersion, 1);
  assert.deepEqual(readBackupSource(backup), tasks); assert.equal(storage.writes.length, 0);
});

test("invalid JSON, unsupported versions, missing sources and mismatched summaries are rejected", () => {
  for (const raw of ["", "{", "null", "[]"]) assert.throws(() => captureWorkspaceBackup({ storage: storageFixture({ "slowly-workspace-v2": raw }) }));
  const valid = captureWorkspaceBackup({ storage: storageFixture({ "slowly-workspace-v2": JSON.stringify(workspaceFixture()) }), createdAt });
  assert.throws(() => validateBackup("{"), { code: "INVALID_JSON" });
  assert.throws(() => validateBackup({ ...valid, formatVersion: 9 }), { code: "UNSUPPORTED_VERSION" });
  assert.throws(() => validateBackup({ ...valid, sources: [] }), { code: "MISSING_DATA" });
  const tampered = structuredClone(valid); tampered.sources[0].summary.tasks++;
  assert.throws(() => validateBackup(tampered), { code: "SUMMARY_MISMATCH" });
  const unknown = structuredClone(valid); unknown.sources[0].storageVersion = 99;
  assert.throws(() => validateBackup(unknown), { code: "UNSUPPORTED_VERSION" });
  // A corrupt v2 never silently falls back to legacy data.
  assert.throws(() => captureWorkspaceBackup({ storage: storageFixture({ "slowly-workspace-v2": "{", "slowly-board-v1": "[]" }) }), { code: "INVALID_JSON" });
});

test("storage access failures and suspected credential fields fail closed without leaking values", () => {
  assert.throws(() => captureWorkspaceBackup({ storage: { getItem() { throw new Error("blocked"); } } }), { code: "STORAGE_UNAVAILABLE" });
  const data = workspaceFixture(); data.extra = { AWS_SECRET_ACCESS_KEY: "fixture-sensitive-value" };
  assert.throws(() => captureWorkspaceBackup({ storage: storageFixture({ "slowly-workspace-v2": JSON.stringify(data) }) }), error => error.code === "SENSITIVE_FIELD" && !error.message.includes("fixture-sensitive-value"));
});

test("client imports have no storage, download, network or server-only side effects", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const originalFetch = globalThis.fetch; let touches = 0;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { touches++; throw new Error("No automatic storage reads"); } });
  globalThis.fetch = () => { touches++; throw new Error("No automatic requests"); };
  try {
    await import("../src/lib/client/workspace-backup.mjs?side-effect-test");
    await import("../src/lib/client/slowly-api.mjs?side-effect-test");
    assert.equal(touches, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor); else delete globalThis.localStorage;
  }
});
