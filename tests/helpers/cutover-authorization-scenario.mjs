import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { authorizationEvidenceId, createCutoverAuthorization } from "../../src/lib/migration/cutover-authorization.mjs";
import { prepareSignedReleaseEvidence } from "../../src/lib/migration/release-evidence.mjs";
import { canonical } from "../../src/lib/migration/plan-v2.mjs";
import { createTrustedEvidenceProvider, verifyEvidenceSignature } from "../../src/lib/migration/trusted-evidence.mjs";
import { createWorkspaceViewApi } from "../../src/lib/api/workspace-view.mjs";

// The key and all attestations are isolated fixture data, never formal authority.
export async function authorizationFixture(f, lifetimeMs = 60000) {
  const key = randomBytes(32);
  const binding = { ...f.binding, sourceNamespace: f.plan.sourceNamespace };
  const readItem = async id => (await f.db.send(new GetCommand({ TableName: f.tableName, Key: { id }, ConsistentRead: true }))).Item;
  let time = f.bundle.issuedAt;
  const deps = { db: f.db, service: f.service, repository: f.repository, tableName: f.tableName, endpoint: f.bundle.endpoint,
    now: () => time, formalAuthorization: true, readItem, verifySignature: (body, signature) => verifyEvidenceSignature(body, signature, key) };
  const preparation = await prepareSignedReleaseEvidence({ ...deps, key, binding, backup: f.bundle.backup,
    options: f.bundle.options, backupFingerprint: f.bundle.subject.backupFingerprint, expiresInMs: lifetimeMs });
  const subject = preparation.payload.subject;
  const attestations = Object.fromEntries(Object.entries(f.bundle.attestations)
    .map(([kind, attestation]) => [kind, { ...attestation, subject, expiresAt: time + lifetimeMs }]));
  delete attestations.approval;
  const origin = JSON.parse(preparation.payload.backup.payload).sourceInfo.origin;
  const chrome = { origin, observedAt: time, frozen: true, issuedAt: time, expiresAt: time + Math.min(lifetimeMs, 900000),
    browserState: { pendingWrite: false, unknownOperation: false, unsavedDrafts: false, recoveryJournalClear: true, sourceMatchesBackup: true } };
  attestations.requestConsent = { ...chrome, subject, kind: "requestConsent", provenance: "explicit-operator-request", requestApproved: true };
  const sign = payload => ({ payload, signature: createHmac("sha256", key).update(canonical(payload)).digest("hex") });
  const signed = sign({ ...preparation.payload, purpose: "cutover-request", attestations });
  const execution = sign({ ...signed.payload, purpose: "cutover-execution", attestations: { ...attestations,
    approval: { ...chrome, subject, kind: "approval", provenance: "explicit-operator-execution", approved: true,
      requestEvidenceId: authorizationEvidenceId(signed.payload), sessionVersion: signed.payload.release.sessionVersion } } });
  const verify = (scope, envelope) => createTrustedEvidenceProvider({ ...deps, loadBundle: async () => envelope })(scope);
  const lifecycle = () => createCutoverAuthorization({ ...deps, verify });
  const provider = (bundle = signed) => createTrustedEvidenceProvider({ ...deps, loadBundle: async () => bundle, redeemedUntil: lifecycle().redeemedUntil });
  const gate = bundle => provider(bundle)(binding);
  const view = async bundle => {
    const get = createWorkspaceViewApi({ configuration: () => ({ NODE_ENV: "development", SLOWLY_LOCAL_API: "1" }),
      authorizeWorkspace: () => binding, getRepository: () => f.repository, getMigrationService: () => f.service, cutoverReadiness: provider(bundle) });
    const response = await get(new Request(`http://127.0.0.1:3000/api/workspaces/${encodeURIComponent(binding.workspaceId)}/view`,
      { headers: { host: "127.0.0.1:3000" } }), { params: { id: binding.workspaceId } });
    assert.equal(response.status, 200);
    return (await response.json()).data.readiness.capabilities;
  };
  return { signed, execution, sign, binding, lifecycle, gate, view, preparation, setTime: value => { time = value; },
    input: { binding, signed, confirmation: authorizationEvidenceId(signed.payload) } };
}

export async function runAuthorizationScenario(f) {
  const a = await authorizationFixture(f);
  const store = a.lifecycle();
  assert.deepEqual((await a.gate(a.preparation)).blockers, ["CUTOVER_APPROVAL_REQUIRED"]);
  assert.equal((await a.gate()).requestEligible, true);
  const requests = await Promise.all([store.transition("request", a.input), a.lifecycle().transition("request", a.input)]);
  assert.equal(requests[0].state, "REQUESTED");
  assert.deepEqual(requests[0], requests[1]);
  assert.equal((await a.gate(a.execution)).cutoverEnabled, false);
  await assert.rejects(store.transition("redeem", a.input), { code: "CUTOVER_AUTHORIZATION_STATE" });
  assert.equal((await a.gate()).ready, false);
  await assert.rejects(store.transition("approve", { ...a.input, confirmation: "" }), { code: "CUTOVER_CONFIRMATION_REQUIRED" });
  assert.equal((await store.transition("approve", a.input)).state, "APPROVED");
  assert.equal((await a.gate()).ready, false);
  assert.equal((await a.view()).formalCutoverEnabled, false);
  assert.equal((await a.gate(a.execution)).cutoverEnabled, false);
  a.setTime(a.signed.payload.issuedAt + 1);
  const racing = await Promise.allSettled([store.transition("redeem", a.input), a.lifecycle().transition("redeem", a.input)]);
  assert.equal(racing.filter(r => r.status === "fulfilled" && r.value.state === "REDEEMED").length, 1);
  assert.ok(racing.some(r => r.status === "rejected" && ["CONFLICT", "CUTOVER_AUTHORIZATION_STATE"].includes(r.reason.code)));
  assert.equal((await a.gate()).cutoverEnabled, false);
  assert.equal((await a.gate(a.execution)).cutoverEnabled, false); // Observation predates redemption.
  const executionPayload = structuredClone(a.execution.payload);
  executionPayload.attestations.approval.observedAt++;
  executionPayload.attestations.approval.issuedAt++;
  const execution = a.sign(executionPayload);
  assert.equal((await a.gate(execution)).cutoverEnabled, true);
  const wrongExecution = structuredClone(executionPayload);
  wrongExecution.attestations.approval.requestEvidenceId = "0".repeat(64);
  assert.deepEqual((await a.gate(a.sign(wrongExecution))).blockers, ["CUTOVER_EXECUTION_CONFIRMATION_REQUIRED"]);
  assert.equal((await a.view(execution)).formalCutoverEnabled, true);
  await assert.rejects(store.transition("redeem", a.input), { code: "CUTOVER_AUTHORIZATION_STATE" });
  assert.equal((await store.transition("revoke", a.input)).state, "REVOKED");
  assert.equal((await a.gate(execution)).cutoverEnabled, false);
  await assert.rejects(store.transition("request", a.input), { code: "CUTOVER_AUTHORIZATION_STATE" });
}
