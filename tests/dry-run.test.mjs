import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { captureWorkspaceBackup } from "../src/lib/client/workspace-backup.mjs";
import { captureVerifiedBackup, sealBackup, verifyBackupArtifact } from "../src/lib/client/verified-backup.mjs";
import { prepareDryRun, executeDryRun, boundDryRunClient, dryRunProofId, dryRunOwnerHash } from "../src/lib/migration/dry-run.mjs";
import { MemoryClient } from "./helpers/memory-client.mjs";
import { workspaceFixture, storageFixture, createdAt } from "./phase4a-fixtures.mjs";

const origin = "http://localhost:3000";
const backupFor = data => captureWorkspaceBackup({ storage: storageFixture({ "slowly-workspace-v2": JSON.stringify(data) }), createdAt });
async function fixture(data = workspaceFixture()) {
  const runId = randomUUID(); const tableName = `Slowly_DryRun_${runId.replaceAll("-", "")}`; const ownerSecret = "a".repeat(64);
  const artifact = await sealBackup(backupFor(data), origin);
  const prepared = await prepareDryRun(artifact, { sourceNamespace: `dryrun-${runId}` });
  const db = new MemoryClient();
  db.items.set(dryRunProofId(runId), { id: dryRunProofId(runId), entityType: "DRY_RUN_CONTROL", runId, ownerHash: dryRunOwnerHash(ownerSecret), backupFingerprint: prepared.report.backupFingerprint, planId: prepared.report.planId });
  return { runId, tableName, ownerSecret, prepared, db };
}

test("explicit backup keeps exact source strings and SHA-256 verifies bytes without storage writes", async () => {
  const data = workspaceFixture(); data.extension = { nested: ["space  ", { custom: true }] };
  const raw = ` ${JSON.stringify(data, null, 2)}\n`;
  const storage = storageFixture({ "slowly-workspace-v2": raw, "slowly-board-v1": "[]" });
  const artifact = await captureVerifiedBackup({ storage, origin, createdAt });
  assert.equal(artifact.integrity.fingerprint, createHash("sha256").update(artifact.payload).digest("hex"));
  const verified = await verifyBackupArtifact(JSON.stringify(artifact));
  assert.equal(verified.backup.sources[0].raw, raw); assert.deepEqual(JSON.parse(verified.backup.sources[0].raw).extension, data.extension);
  assert.equal(verified.sourceSchemaVersions[0].declaredSchemaVersion, null);
  assert.deepEqual(storage.writes, []); assert.deepEqual(storage.reads, ["slowly-workspace-v2", "slowly-board-v1", "slowly-workspace-v2", "slowly-board-v1"]);
});

test("tampered payload, metadata, unsupported envelope and invalid sources are rejected", async () => {
  const artifact = await sealBackup(backupFor(workspaceFixture()), origin);
  await assert.rejects(verifyBackupArtifact({ ...artifact, payload: `${artifact.payload} ` }), { code: "FINGERPRINT_MISMATCH" });
  await assert.rejects(verifyBackupArtifact({ ...artifact, formatVersion: 9 }), { code: "UNSUPPORTED_VERSION" });
  await assert.rejects(verifyBackupArtifact("invalid json"), { code: "INVALID_JSON" });
  await assert.rejects(sealBackup(backupFor(workspaceFixture()), "http://user:pass@localhost:3000"), { code: "INVALID_SOURCE" });
  const payload = JSON.parse(artifact.payload); payload.sourceSchemaVersions[0].storageVersion = 42;
  const changed = JSON.stringify(payload);
  await assert.rejects(verifyBackupArtifact({ ...artifact, payload: changed, integrity: { algorithm: "SHA-256", fingerprint: createHash("sha256").update(changed).digest("hex") } }), { code: "SOURCE_MISMATCH" });
  await assert.rejects(captureVerifiedBackup({ storage: storageFixture({}), origin }), { code: "MISSING_DATA" });
});

test("changing source during capture blocks export; source schema values cannot leak through reports", async () => {
  const storage = storageFixture({ "slowly-workspace-v2": JSON.stringify(workspaceFixture()) }); let reads = 0;
  const changing = { getItem(key) { reads++; return reads > 2 ? null : storage.getItem(key); } };
  await assert.rejects(captureVerifiedBackup({ storage: changing, origin }), { code: "SOURCE_CHANGED" });
  const data = workspaceFixture(); data.schemaVersion = { privateText: "must-not-appear" };
  const artifact = await sealBackup(backupFor(data), origin); const prepared = await prepareDryRun(artifact, { sourceNamespace: "dryrun-test-namespace" });
  assert.equal(prepared.valid, false); assert.doesNotMatch(JSON.stringify(prepared.report), /must-not-appear|privateText/);
});

test("strict preview blocks unknown/missing/schema/duplicate/WIP/parent/timer issues before database access", async t => {
  const cases = [
    ["unknown", data => { data.boards[0].tasks[0].extension = { untouched: true }; }, "UNKNOWN_SOURCE_FIELDS"],
    ["missing", data => { delete data.boards[0].tasks[0].notes; }, "MISSING_SOURCE_FIELDS"],
    ["schema", data => { data.boards[0].schemaVersion = 9; }, "UNSUPPORTED_SCHEMA_VERSION"],
    ["id", data => { data.boards[0].tasks[1].id = data.boards[0].tasks[0].id; }, "DUPLICATE_ID"],
    ["parent", data => { data.boards[0].tasks[0].boardId = "foreign"; }, "PARENT_MISMATCH"],
    ["wip", data => { data.boards[0].wipLimit = 1; data.boards[0].tasks.forEach(task => { task.status = "doing"; }); }, "WIP_EXCEEDED"],
    ["timer", data => { data.boards[0].widgets[0].config.taskId = "missing"; }, "DANGLING_TIMER_TASK"],
  ];
  for (const [name, alter, expected] of cases) await t.test(name, async () => {
    const data = workspaceFixture(); alter(data); const f = await fixture(data);
    assert.equal(f.prepared.valid, false); assert.ok(f.prepared.report.blockers.some(issue => issue.code === expected));
    await assert.rejects(executeDryRun(f), { code: "PREVIEW_INVALID" }); assert.equal(f.db.calls.length, 0);
  });
});

test("duplicate raw JSON keys, unselected sources and legacy metadata require review", async () => {
  const raw = JSON.stringify(workspaceFixture()).replace('"activeBoardId":"board-a"', '"activeBoardId":"lost","activeBoardId":"board-a"');
  const duplicate = captureWorkspaceBackup({ storage: storageFixture({ "slowly-workspace-v2": raw }), createdAt });
  const options = { sourceNamespace: "dryrun-test-namespace" };
  let result = await prepareDryRun(await sealBackup(duplicate, origin), options);
  assert.ok(result.report.blockers.some(issue => issue.code === "DUPLICATE_JSON_KEYS"));
  const both = captureWorkspaceBackup({ storage: storageFixture({ "slowly-workspace-v2": JSON.stringify(workspaceFixture()), "slowly-board-v1": "[]" }), createdAt });
  result = await prepareDryRun(await sealBackup(both, origin), options); assert.equal(result.valid, false);
  const legacy = captureWorkspaceBackup({ storage: storageFixture({ "slowly-board-v1": JSON.stringify(workspaceFixture().boards[0].tasks) }), createdAt });
  result = await prepareDryRun(await sealBackup(legacy, origin), options); assert.ok(result.report.blockers.some(issue => issue.code === "LEGACY_BOARD_METADATA_REQUIRED"));
  result = await prepareDryRun(await sealBackup(legacy, origin), { ...options, policies: { legacyBoard: { id: "legacy", name: "Confirmed", description: "", wipLimit: 4 } } }); assert.equal(result.valid, true);
});

test("full dry run preserves task fields, completion time, timer, widget presence, ordering and fresh projection", async () => {
  const data = workspaceFixture(); data.settings = { custom: { retained: true } };
  data.boards[0].tasks[0].status = "done"; data.boards[0].tasks[0].completedAt = "2026-11-12T01:02:03.456Z";
  data.boards[0].widgets[0] = { ...data.boards[0].widgets[0], type: "timer", config: { minutes: 25, endsAt: 1794640000000, remaining: 10, taskId: "task-a" } };
  delete data.boards[1].widgets; data.boards.push({ id: "empty", name: "Empty", description: "", wipLimit: 4, tasks: [], widgets: [] });
  const f = await fixture(data); const report = await executeDryRun(f);
  assert.equal(report.dryRunPassed, true); assert.deepEqual(report.sourceCounts, report.targetCounts); assert.equal(report.verifyPassed, true); assert.equal(report.releasePassed, true);
  assert.deepEqual(report.differences, []); assert.equal(report.reloadConsistencyPassed, true); assert.equal(report.status, "NOT READY");
  assert.equal(report.sourceWorkspaceHash, report.targetWorkspaceHash); assert.equal(report.locksRemaining, 0);
  assert.doesNotMatch(JSON.stringify(report), /任務 task|備註|retained|1794640000000/);
});

for (const stage of ["REGISTERING", "MIGRATING", "RELEASING"]) test(`${stage} interruption resumes against persisted session and receipts`, async () => {
  const f = await fixture(); let interrupted = false;
  await assert.rejects(executeDryRun({ ...f, checkpoint: async progress => {
    if (!interrupted && progress.stage === stage && (progress.completed ?? progress.registered) === 1) { interrupted = true; throw Object.assign(new Error("stop"), { code: "DRY_RUN_INTERRUPTED" }); }
  } }), { code: "DRY_RUN_INTERRUPTED" });
  const report = await executeDryRun(f); assert.equal(report.dryRunPassed, true); assert.equal(report.receiptsConfirmed, f.prepared.plan.operations.length);
  const again = await executeDryRun(f); assert.equal(again.targetWorkspaceHash, report.targetWorkspaceHash);
});

test("lost response reads confirmed receipt; protected table names and foreign proofs cannot execute", async () => {
  const f = await fixture();
  f.db.afterTransaction = async input => { if (input.TransactItems.some(action => action.Put?.Item.migrationOwner)) { f.db.afterTransaction = null; throw new Error("response lost"); } };
  const report = await executeDryRun(f); assert.equal(report.recoveredResponses, 1);
  assert.throws(() => boundDryRunClient(f.db, "SlowlyTasks", f.runId), { code: "DRY_RUN_SCOPE" });
  const bounded = boundDryRunClient(f.db, f.tableName, f.runId);
  assert.throws(() => bounded.send(new GetCommand({ TableName: "SlowlyTasks", Key: { id: "anything" } })), { code: "DRY_RUN_SCOPE" });
  await assert.rejects(executeDryRun({ ...f, ownerSecret: "wrong" }), { code: "DRY_RUN_SCOPE" });
});

test("external target edits block Verify without adopting or overwriting them", async () => {
  const f = await fixture();
  await assert.rejects(executeDryRun({ ...f, checkpoint: async progress => {
    if (progress.stage === "MIGRATING" && progress.completed === f.prepared.plan.operations.length) {
      const task = [...f.db.items.values()].find(item => item.entityType === "TASK"); task.data.notes = "external edit";
    }
  } }), { code: "INTEGRITY_CONFLICT" });
  assert.ok([...f.db.items.values()].some(item => item.data?.notes === "external edit"));
});
