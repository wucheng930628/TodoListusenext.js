import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { sealBackup } from "../src/lib/client/verified-backup.mjs";
import { captureWorkspaceBackup } from "../src/lib/client/workspace-backup.mjs";
import { workspaceFixture, storageFixture, createdAt } from "./phase4a-fixtures.mjs";

function run(args) {
  const child = spawnSync(process.execPath, ["--conditions=react-server", "scripts/migration-dry-run.mjs", ...args], { encoding: "utf8", windowsHide: true, timeout: 120000 });
  assert.equal(child.error, undefined);
  const lines = child.stdout.trim().split(/\r?\n/);
  return { exit: child.status, report: JSON.parse(lines.at(-1)), stderr: child.stderr, pid: child.pid };
}

test("CLI rejects unconfirmed backup paths and any workspace state path without opening a database", () => {
  assert.equal(run(["--backup", "unselected-private-file.json"]).report.code, "BACKUP_CONFIRMATION_REQUIRED");
  assert.equal(run(["--synthetic", "--state", join(process.cwd(), "must-not-create-state.json")]).report.code, "PRIVATE_PATH_REQUIRED");
  assert.equal(existsSync("must-not-create-state.json"), false);
});

test("real DynamoDB Local synthetic dry run verifies fidelity, lost response and own-table cleanup", t => {
  const folder = mkdtempSync(join(tmpdir(), "slowly-dry-run-tests-")); const state = join(folder, "state.json");
  let result;
  try {
    result = run(["--synthetic", "--state", state, "--exercise-response-loss"]);
    assert.equal(result.exit, 0); assert.equal(result.report.dryRunPassed, true); assert.equal(result.report.recoveredResponses, 1);
    assert.equal(result.report.cleaned, true); assert.equal(result.report.status, "NOT READY");
    assert.deepEqual(result.report.sourceCounts, result.report.targetCounts); assert.deepEqual(result.report.differences, []);
    assert.equal(result.report.reloadConsistencyPassed, true); assert.equal(result.report.locksRemaining, 0);
    t.diagnostic(JSON.stringify(result.report));
  } finally {
    if (existsSync(state)) { const saved = JSON.parse(readFileSync(state, "utf8")); if (saved.created && !saved.cleaned) run(["--cleanup", "--state", state, "--confirm-cleanup", saved.runId]); }
  }
});

for (const stage of ["MIGRATING", "RELEASING"]) test(`real process interruption during ${stage} resumes from private state and receipts`, t => {
  const folder = mkdtempSync(join(tmpdir(), "slowly-dry-run-tests-")); const state = join(folder, "state.json");
  try {
    const first = run(["--synthetic", "--state", state, "--stop-after", `${stage}:1`]);
    assert.equal(first.exit, 1); assert.equal(first.report.code, "DRY_RUN_INTERRUPTED"); assert.equal(first.report.cleaned, false);
    const before = JSON.parse(readFileSync(state, "utf8"));
    // A crashed process can leave its lock. The exact exited child PID is safe to inspect.
    writeFileSync(`${state}.lock`, JSON.stringify({ pid: first.pid, runId: before.runId }));
    const resumed = run(["--synthetic", "--state", state, "--resume"]);
    assert.equal(resumed.exit, 0); assert.equal(resumed.report.dryRunPassed, true); assert.equal(resumed.report.cleaned, true);
    assert.equal(resumed.report.planId, before.planId); assert.equal(resumed.report.backupFingerprint, before.backupFingerprint);
    assert.equal(resumed.report.receiptsConfirmed, 9); t.diagnostic(JSON.stringify(resumed.report));
  } finally {
    if (existsSync(state)) { const saved = JSON.parse(readFileSync(state, "utf8")); if (saved.created && !saved.cleaned) run(["--cleanup", "--state", state, "--confirm-cleanup", saved.runId]); }
  }
});

test("explicit private-file backup path verifies fingerprint, previews without a table, and exercises real CLI input with synthetic content", async t => {
  const folder = mkdtempSync(join(tmpdir(), "slowly-dry-run-tests-"));
  const path = join(folder, "synthetic-backup.json"); const state = join(folder, "state.json");
  const artifact = await sealBackup(captureWorkspaceBackup({ storage: storageFixture({ "slowly-workspace-v2": JSON.stringify(workspaceFixture()) }), createdAt }), "http://localhost:3000");
  writeFileSync(path, JSON.stringify(artifact));
  const base = ["--backup", path, "--confirm-backup", artifact.integrity.fingerprint, "--state", state];
  try {
    const wrong = run(["--backup", path, "--confirm-backup", "0".repeat(64), "--state", state, "--confirm-dry-run"]);
    assert.equal(wrong.report.code, "BACKUP_CONFIRMATION_REQUIRED"); assert.equal(existsSync(state), false);
    const preview = run([...base, "--preview-only"]); assert.equal(preview.exit, 0); assert.equal(preview.report.previewPassed, true); assert.equal(preview.report.tableCreated, false);
    assert.equal(existsSync(state), false);
    const result = run([...base, "--confirm-dry-run"]); assert.equal(result.exit, 0); assert.equal(result.report.dryRunPassed, true); assert.equal(result.report.cleaned, true);
    assert.equal(readFileSync(path, "utf8"), JSON.stringify(artifact));
    assert.doesNotMatch(JSON.stringify(result.report), /任務 task|備註|看板 A/);
    t.diagnostic(JSON.stringify({ evidenceSource: "generated synthetic backup file", ...result.report }));
  } finally {
    if (existsSync(state)) { const saved = JSON.parse(readFileSync(state, "utf8")); if (saved.created && !saved.cleaned) run(["--cleanup", "--state", state, "--confirm-cleanup", saved.runId]); }
  }
});

test("changing the backup fingerprint after interruption rejects resume before new database writes", async () => {
  const folder = mkdtempSync(join(tmpdir(), "slowly-dry-run-tests-")); const state = join(folder, "state.json");
  try {
    const first = run(["--synthetic", "--state", state, "--stop-after", "MIGRATING:1"]); assert.equal(first.report.code, "DRY_RUN_INTERRUPTED");
    const saved = JSON.parse(readFileSync(state, "utf8")); saved.createdAt = "2026-11-15T00:00:00.000Z";
    writeFileSync(state, JSON.stringify(saved));
    const result = run(["--synthetic", "--state", state, "--resume"]); assert.equal(result.exit, 1); assert.equal(result.report.code, "STATE_CONFLICT");
  } finally {
    if (existsSync(state)) { const saved = JSON.parse(readFileSync(state, "utf8")); if (saved.created && !saved.cleaned) assert.equal(run(["--cleanup", "--state", state, "--confirm-cleanup", saved.runId]).exit, 0); }
  }
});
