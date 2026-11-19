import test from "node:test";
import assert from "node:assert/strict";
import { evidenceFixture } from "./helpers/evidence-fixture.mjs";
import { authorizationFixture, runAuthorizationScenario } from "./helpers/cutover-authorization-scenario.mjs";
import { authorizationEvidenceId } from "../src/lib/migration/cutover-authorization.mjs";

test("approval, isolated concurrent redemption, fresh provider lookup and revocation", async () => {
  await runAuthorizationScenario(await evidenceFixture());
});

test("authorization rejects expired evidence and another workspace, plan or evidence", async () => {
  const a = await authorizationFixture(await evidenceFixture());
  const store = a.lifecycle();
  await store.transition("request", a.input);
  await store.transition("approve", a.input);
  await assert.rejects(store.transition("redeem", { ...a.input, binding: { ...a.binding, workspaceId: "other" } }), { code: "CUTOVER_AUTHORIZATION_SCOPE" });
  const wrongPlan = structuredClone(a.signed.payload);
  wrongPlan.subject.planId = "0".repeat(64);
  await assert.rejects(store.transition("redeem", { ...a.input, signed: a.sign(wrongPlan) }), { code: "CUTOVER_AUTHORIZATION_SCOPE" });
  const different = structuredClone(a.signed.payload);
  different.attestations.validation.artifactHash = "a".repeat(64);
  await assert.rejects(store.transition("redeem", { ...a.input, signed: a.sign(different), confirmation: authorizationEvidenceId(different) }), { code: "CUTOVER_AUTHORIZATION_STATE" });
  a.setTime(a.signed.payload.expiresAt);
  await assert.rejects(store.transition("redeem", a.input), { code: "CUTOVER_EVIDENCE_NOT_READY" });
  assert.equal((await a.gate()).ready, false);
});

test("operator evidence must confirm quiescent browser state and matching backup", async () => {
  const a = await authorizationFixture(await evidenceFixture());
  for (const [field, value] of [["pendingWrite", true], ["unknownOperation", true], ["unsavedDrafts", true], ["recoveryJournalClear", false], ["sourceMatchesBackup", false]]) {
    const payload = structuredClone(a.signed.payload);
    payload.attestations.approval.browserState[field] = value;
    assert.deepEqual((await a.gate(a.sign(payload))).blockers, ["BROWSER_STATE_CONFIRMATION_REQUIRED"]);
    await assert.rejects(a.lifecycle().transition("request", { ...a.input, signed: a.sign(payload) }), { code: "CUTOVER_EVIDENCE_NOT_READY" });
  }
});

test("durable approval expires independently of the still-valid signed evidence", async () => {
  const a = await authorizationFixture(await evidenceFixture(), 1800000);
  const store = a.lifecycle();
  const request = await store.transition("request", a.input);
  await store.transition("approve", a.input);
  a.setTime(request.expiresAt);
  assert.ok(a.signed.payload.expiresAt > request.expiresAt);
  await assert.rejects(store.transition("redeem", a.input), { code: "CUTOVER_AUTHORIZATION_EXPIRED" });
  assert.deepEqual((await a.gate()).blockers, ["CUTOVER_REDEMPTION_REQUIRED"]);
});

test("releasing or changed session cannot redeem and a session race rejects atomically", async () => {
  const f = await evidenceFixture();
  const a = await authorizationFixture(f);
  const store = a.lifecycle();
  await store.transition("request", a.input);
  await store.transition("approve", a.input);
  const session = f.db.items.get(`SLOWLY#MIGRATION_SESSION#${f.plan.planId}`);
  session.state = "RELEASING";
  await assert.rejects(store.transition("redeem", a.input), { code: "CUTOVER_EVIDENCE_NOT_READY" });
  session.state = "RELEASED";
  session.version++;
  await assert.rejects(store.transition("redeem", a.input), { code: "CUTOVER_EVIDENCE_NOT_READY" });
  session.version--;
  f.db.beforeTransaction = async () => { session.version++; };
  await assert.rejects(store.transition("redeem", a.input), { code: "CONFLICT" });
  assert.equal((await a.gate()).cutoverEnabled, false);
});
