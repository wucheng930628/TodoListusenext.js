import test from "node:test";
import assert from "node:assert/strict";
import { evidenceFixture } from "./helpers/evidence-fixture.mjs";
import { formalCutoverEvidence } from "../src/lib/api/formal-evidence.mjs";
import { hash } from "../src/lib/migration/plan-v2.mjs";

test("signed synthetic evidence is verified against live server data without writes", async () => {
  const f = await evidenceFixture(); const before = hash([...f.db.items]); const snapshot = await f.snapshot();
  const result = await f.provider(f.binding, snapshot); assert.equal(result.ready, true); assert.equal(result.planId, f.plan.planId);
  assert.equal(result.backupFingerprint, f.bundle.subject.backupFingerprint); assert.equal(result.sessionVersion, (await f.service.getSession(f.plan.planId)).version);
  assert.equal(hash([...f.db.items]), before);
});

test("unsigned frontend ready flags and altered signatures cannot become authority", async () => {
  const f = await evidenceFixture(); const payload = { ...f.bundle, ready: true, cutoverEnabled: true };
  f.setSigned({ payload, signature: "0".repeat(64) }); const before = f.db.calls.length;
  assert.equal((await f.provider(f.binding)).ready, false); assert.equal(f.db.calls.length, before);
});

test("missing, expired, mock-only or failed browser evidence denies Cutover", async () => {
  const f = await evidenceFixture();
  for (const alter of [bundle => { delete bundle.attestations.browser; }, bundle => { bundle.attestations.browser.expiresAt = 0; },
    bundle => { bundle.attestations.browser.provenance = "mock"; }, bundle => { bundle.attestations.browser.checks.unknownReload = "NOT TESTED"; },
    bundle => { bundle.attestations.approval.approved = false; }, bundle => { bundle.attestations.validation.failed = 1; }]) {
    const bundle = structuredClone(f.bundle); alter(bundle); f.setSigned(f.sign(bundle)); assert.equal((await f.provider(f.binding)).cutoverEnabled, false);
  }
});

test("evidence binds table/workspace/migration/plan/fingerprint/namespace and dry run", async () => {
  const f = await evidenceFixture();
  for (const alter of [bundle => { bundle.tableName = "different-table"; }, bundle => { bundle.subject.workspaceId += "0"; },
    bundle => { bundle.subject.planId = "0".repeat(64); }, bundle => { bundle.subject.backupFingerprint = "0".repeat(64); },
    bundle => { bundle.options.sourceNamespace += "changed"; }, bundle => { bundle.attestations.dryRun.report.cleaned = false; }]) {
    const bundle = structuredClone(f.bundle); alter(bundle); f.setSigned(f.sign(bundle)); assert.equal((await f.provider(f.binding)).ready, false);
  }
});

test("live version/receipt/ownership/lock changes block despite valid signed evidence", async () => {
  for (const alter of [item => { item.version++; }, item => { item.migrationLock = true; }, item => { item.migrationOwner.migrationId = "0".repeat(64); }, item => { item.data.notes = "synthetic changed"; }]) {
    const f = await evidenceFixture(); const item = f.db.items.get(f.plan.operations.find(op => op.type === "TASK").targetId); alter(item);
    assert.equal((await f.provider(f.binding)).cutoverEnabled, false);
  }
});

test("presented stale UI view is rejected; no configured provider leaves formal writes disabled", async () => {
  const f = await evidenceFixture(); const snapshot = await f.snapshot(); snapshot.boards[0].tasks[0].data.title = "stale synthetic view";
  assert.equal((await f.provider(f.binding, snapshot)).ready, false);
  const result = await formalCutoverEvidence(f.binding, snapshot, {}); assert.equal(result.cutoverEnabled, false);
});

test("missing/unconfirmed Receipt or changed Verify/Release certificate stays NOT READY", async () => {
  for (const alter of [f => { const op = f.plan.operations[0]; f.db.items.delete(`SLOWLY#MIGRATION_OPERATION#${f.plan.planId}#${op.operationId}`); },
    f => { const receipt = [...f.db.items.values()].find(item => item.entityType === "MIGRATION_OPERATION"); receipt.state = "PENDING"; },
    f => { f.db.items.get(`SLOWLY#MIGRATION_SESSION#${f.plan.planId}`).verification.workspaceHash = "0".repeat(64); },
    f => { f.db.items.get(`SLOWLY#MIGRATION_SESSION#${f.plan.planId}`).lockState = "HELD"; }]) {
    const f = await evidenceFixture(); alter(f); assert.equal((await f.provider(f.binding)).cutoverEnabled, false);
  }
});
