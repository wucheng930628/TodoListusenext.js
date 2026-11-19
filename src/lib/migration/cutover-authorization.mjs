import "server-only";
import { requireValue } from "../data-model.mjs";
import { assertReleaseBinding } from "../api/formal-workspace.mjs";
import { migrationStore } from "./store.mjs";
import { hash } from "./plan-v2.mjs";

export const authorizationEvidenceId = payload => hash(payload);
const recordType = "CUTOVER_AUTHORIZATION";
const recordKey = evidenceId => `SLOWLY#CUTOVER_AUTHORIZATION#${evidenceId}`;

// This service is only callable by a trusted server process. No public request
// can supply a verifier, choose a table, or attest to operator confirmation.
export function createCutoverAuthorization({ db, tableName, service, verify, now = Date.now }) {
  const store = migrationStore(db, tableName);

  async function status(payload) {
    const evidenceId = authorizationEvidenceId(payload);
    const row = await store.get(recordKey(evidenceId));
    if (row?.entityType !== recordType || row.evidenceId !== evidenceId || hash(row.subject) !== hash(payload.subject)) return null;
    return row;
  }

  async function transition(action, { binding, signed, confirmation }) {
    requireValue(["request", "approve", "redeem", "revoke"].includes(action), "Unknown authorization action");
    const payload = signed?.payload;
    requireValue(payload?.formatVersion === 2 && payload.purpose === "cutover-request" && payload.tableName === tableName &&
      payload.subject?.workspaceId === binding.workspaceId && payload.subject.migrationId === binding.migrationId &&
      payload.subject.planId === binding.migrationId && payload.subject.sourceNamespace === binding.sourceNamespace,
    "Authorization scope differs", "CUTOVER_AUTHORIZATION_SCOPE");
    const evidenceId = authorizationEvidenceId(payload);
    const id = recordKey(evidenceId);
    if (action !== "request") requireValue(confirmation === evidenceId, "Confirm the exact evidence digest", "CUTOVER_CONFIRMATION_REQUIRED");
    const prior = await store.get(id);
    if (action === "revoke") {
      requireValue(prior?.entityType === recordType && prior.state !== "REVOKED" && prior.evidenceId === evidenceId &&
        hash(prior.subject) === hash(payload.subject), "No matching authorization to revoke", "CUTOVER_AUTHORIZATION_STATE");
      const revoked = { ...prior, state: "REVOKED", version: prior.version + 1, revokedAt: now() };
      await store.transact([store.put(revoked, prior)]);
      return revoked;
    }

    const expected = { request: undefined, approve: "REQUESTED", redeem: "APPROVED" }[action];
    const matchingRequest = row => row?.state === "REQUESTED" && row.entityType === recordType &&
      row.evidenceId === evidenceId && hash(row.subject) === hash(payload.subject) &&
      row.sessionVersion === payload.release?.sessionVersion && row.releaseHash === payload.release?.verificationHash && row.expiresAt > now();
    const duplicate = action === "request" && matchingRequest(prior);
    requireValue(duplicate || (prior?.state === expected && (action === "request" ? !prior : prior.entityType === recordType &&
      prior.evidenceId === evidenceId && hash(prior.subject) === hash(payload.subject))),
    "Authorization transition is unavailable or already used", "CUTOVER_AUTHORIZATION_STATE");
    const verified = await verify(binding, signed);
    const time = now();
    requireValue(verified.requestEligible === true && verified.evidenceVerified === true &&
      verified.evidenceExpiresAt > time && verified.sessionVersion === payload.release?.sessionVersion,
    "Trusted evidence could not be revalidated", "CUTOVER_EVIDENCE_NOT_READY");
    const session = await service.getSession(binding.migrationId);
    assertReleaseBinding(binding, session);
    requireValue(session.version === verified.sessionVersion && session.releaseVerificationHash === payload.release.verificationHash &&
      session.sourceBinding?.backupFingerprint === payload.subject.backupFingerprint,
    "Release changed", "CUTOVER_AUTHORIZATION_SCOPE");
    const expiresAt = prior?.expiresAt ?? Math.min(verified.evidenceExpiresAt, time + 900000);
    requireValue(now() < expiresAt && now() < verified.evidenceExpiresAt && (!prior || prior.sessionVersion === session.version),
      "Authorization expired or session changed", "CUTOVER_AUTHORIZATION_EXPIRED");
    if (duplicate) return prior;
    const next = { id, entityType: recordType, evidenceId, subject: payload.subject, sessionVersion: session.version,
      releaseHash: session.releaseVerificationHash, expiresAt, version: (prior?.version ?? 0) + 1, ...{
        request: { state: "REQUESTED", requestedAt: time },
        approve: { state: "APPROVED", requestedAt: prior?.requestedAt, approvedAt: time },
        redeem: { state: "REDEEMED", requestedAt: prior?.requestedAt, approvedAt: prior?.approvedAt, redeemedAt: time },
      }[action] };
    // Compare immutable Release authority in the same transaction as the
    // authorization CAS. A concurrent transition cannot consume it twice.
    const { id: sessionId, entityType, version, state, lockState, releaseWorkspaceId, releaseVerificationHash } = session;
    try {
      await store.transact([store.check({ id: sessionId, entityType, version, state, lockState, releaseWorkspaceId, releaseVerificationHash }),
        store.put(next, prior)]);
    } catch (error) {
      if (action !== "request" || error.code !== "CONFLICT") throw error;
      const existing = await status(payload);
      const current = await service.getSession(binding.migrationId);
      if (!matchingRequest(existing) || current.version !== version || current.state !== state || current.lockState !== lockState ||
        current.releaseVerificationHash !== releaseVerificationHash) throw error;
      return existing;
    }
    return next;
  }

  async function redeemedUntil(payload, observedAt) {
    const row = await status(payload);
    return row?.state === "REDEEMED" && row.sessionVersion === payload.release?.sessionVersion &&
      row.releaseHash === payload.release?.verificationHash && Number.isSafeInteger(row.redeemedAt) &&
      (observedAt === undefined || row.redeemedAt <= observedAt) && Number.isSafeInteger(row.expiresAt) && row.expiresAt > now()
      ? row.expiresAt : null;
  }

  return { transition, redeemedUntil, status };
}
