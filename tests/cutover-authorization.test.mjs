import test from "node:test";
import assert from "node:assert/strict";
import { evidenceFixture } from "./helpers/evidence-fixture.mjs";
import { authorizationFixture, runAuthorizationScenario } from "./helpers/cutover-authorization-scenario.mjs";
import { authorizationEvidenceId } from "../src/lib/migration/cutover-authorization.mjs";

test("formal localhost GET uses exact loopback headers and preserves scope and Evidence enforcement", async () => {
  const a = await authorizationFixture(await evidenceFixture());
  const localhost = { host: "localhost:3000" };
  assert.equal((await a.view(a.preparation, localhost)).formalCutoverEnabled, false);
  assert.equal((await a.view(a.preparation, localhost)).formalRuntimeWritesEnabled, false);
  for (const request of [
    { host: "localhost.evil:3000" }, { host: "localhost:3001" }, { port: "3001" },
    { headers: { origin: "http://127.0.0.1:3000" } }, { headers: { "sec-fetch-site": "same-site" } },
    { headers: { "x-forwarded-host": "127.0.0.1:3000" } }, { headers: { "x-forwarded-for": "192.0.2.1" } },
    { headers: { forwarded: "host=localhost:3000" } }, { method: "POST" }, { formalEnabled: "0" },
    { id: "SLOWLY#WORKSPACE#00000000-0000-0000-0000-000000000000" },
  ]) assert.equal((await a.getView(a.preparation, { ...localhost, ...request })).status, 403);
  assert.equal((await a.getView(a.preparation, { ...localhost, scope: { ...a.binding, migrationId: "0".repeat(64) } })).status, 409);
  assert.equal((await a.getView(a.preparation, { ...localhost, scope: { ...a.binding, sourceNamespace: "wrong-source" } })).status, 409);
  assert.equal((await a.view({ ...a.preparation, signature: "0".repeat(64) }, localhost)).formalCutoverEnabled, false);
  a.setTime(a.preparation.payload.expiresAt);
  assert.equal((await a.view(a.preparation, localhost)).formalCutoverEnabled, false);
});

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
    payload.attestations.requestConsent.browserState[field] = value;
    assert.deepEqual((await a.gate(a.sign(payload))).blockers, ["BROWSER_STATE_CONFIRMATION_REQUIRED"]);
    await assert.rejects(a.lifecycle().transition("request", { ...a.input, signed: a.sign(payload) }), { code: "CUTOVER_EVIDENCE_NOT_READY" });
  }
});

test("browser consent and durable approval expire even when the outer envelope remains valid", async () => {
  const a = await authorizationFixture(await evidenceFixture(), 1800000);
  const store = a.lifecycle();
  const request = await store.transition("request", a.input);
  await store.transition("approve", a.input);
  a.setTime(request.expiresAt);
  assert.ok(a.signed.payload.expiresAt > request.expiresAt);
  await assert.rejects(store.transition("redeem", a.input), { code: "CUTOVER_EVIDENCE_NOT_READY" });
  assert.deepEqual((await a.gate()).blockers, ["ATTESTATION_MISSING_OR_EXPIRED"]);
});

test("Gate A rejects tampering, stale browser state, scope mismatch and live data changes", async () => {
  const f = await evidenceFixture();
  const a = await authorizationFixture(f);
  for (const [change, blocker] of [
    [payload => delete payload.attestations.requestConsent, "ATTESTATION_SCHEMA_CONFLICT"],
    [payload => { payload.attestations.requestConsent.origin = "http://localhost:9876"; }, "BROWSER_STATE_CONFIRMATION_REQUIRED"],
    [payload => { payload.attestations.requestConsent.observedAt -= 900000; }, "BROWSER_STATE_CONFIRMATION_REQUIRED"],
    [payload => { payload.subject.sourceNamespace = "wrong-source"; }, "EVIDENCE_SUBJECT_CONFLICT"],
  ]) {
    const payload = structuredClone(a.signed.payload);
    change(payload);
    assert.deepEqual((await a.gate(a.sign(payload))).blockers, [blocker]);
  }
  assert.deepEqual((await a.gate({ ...a.signed, signature: "0".repeat(64) })).blockers, ["EVIDENCE_SIGNATURE_REQUIRED"]);
  const task = f.db.items.get(f.plan.operations.find(op => op.type === "TASK").targetId);
  task.version++;
  await assert.rejects(a.lifecycle().transition("request", a.input), { code: "CUTOVER_EVIDENCE_NOT_READY" });
  assert.equal(await a.lifecycle().status(a.signed.payload), null);
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
