import "server-only";
import { createHmac } from "node:crypto";
import { readWorkspaceView } from "../api/workspace-view.mjs";
import { assertReleaseBinding } from "../api/formal-workspace.mjs";
import { projectMainView } from "../client/main-view-model.mjs";
import { requireValue } from "../data-model.mjs";
import { prepareDryRun } from "./dry-run.mjs";
import { canonical, hash } from "./plan-v2.mjs";

export const evidenceEndpoint = "http://127.0.0.1:9000";
export const viewFingerprint = snapshot => hash([snapshot.workspace, snapshot.boards, snapshot.readiness.migration]);

export async function readReleaseEvidence({ binding, plan, repository, service, readItem }) {
  const session = await service.getSession(binding.migrationId);
  assertReleaseBinding(binding, session);
  const manifestHash = hash(plan.operations.map(({ operationId, key, targetId, fingerprint }) => ({ operationId, key, targetId, fingerprint })));
  requireValue(session.sourceBinding?.backupFingerprint === plan.sourceBinding?.backupFingerprint &&
    session.manifestHash === manifestHash && session.total === plan.operations.length &&
    session.registeredCount === session.total && session.confirmedCount === session.total && session.releasedCount === session.total &&
    session.rolledBackCount === 0 && session.verifiedAt && session.releasedAt &&
    session.verification?.workspaceHash === plan.expectedWorkspaceHash && hash(session.verification.counts) === hash(plan.counts) &&
    /^[a-f0-9]{64}$/.test(session.releaseVerificationHash || ""),
  "Release certificate is incomplete or belongs to a different plan", "RELEASE_EVIDENCE_CONFLICT");

  const versions = [];
  for (const op of plan.operations) {
    const receipt = await service.getOperation(plan.migrationId, op.operationId);
    const item = await readItem(op.targetId);
    requireValue(receipt.state === "CONFIRMED" && receipt.releasedAt && hash(receipt.operation) === hash(op) &&
      item?.entityType === op.type && item.schemaVersion === plan.schemaVersion && item.migrationLock === false &&
      item.migrationOwner?.migrationId === plan.migrationId && item.migrationOwner?.operationId === op.operationId &&
      item.version === receipt.managedVersion && hash(item) === receipt.managedHash &&
      (op.type !== "WORKSPACE" || item.migrationReleaseVersion === 2),
    "Released target differs from its receipt", "RELEASE_EVIDENCE_CONFLICT");
    versions.push({ targetId: op.targetId, version: item.version, receiptVersion: receipt.version, itemHash: receipt.managedHash });
  }

  const view = await readWorkspaceView(repository, binding.workspaceId, { migrationService: service });
  const viewVersions = new Map([view.workspace, ...view.boards.flatMap(({ board, tasks, widgets }) => [board, ...tasks, ...widgets])]
    .map(({ id, version }) => [id, version]));
  requireValue(view.readiness.eligible && view.readiness.migration?.version === session.version &&
    viewVersions.size === versions.length && versions.every(({ targetId, version }) => viewVersions.get(targetId) === version) &&
    hash(projectMainView(view, binding.workspaceId).workspace) === plan.expectedWorkspaceHash &&
    (await service.getSession(binding.migrationId)).version === session.version,
  "Released Workspace View changed or differs from the backup", "RELEASE_EVIDENCE_CONFLICT");
  return { sessionVersion: session.version, state: session.state, lockState: session.lockState, releasedAt: session.releasedAt,
    releaseProtocolVersion: session.releaseProtocolVersion, verificationHash: session.releaseVerificationHash,
    workspaceHash: session.verification.workspaceHash, manifestHash, viewHash: viewFingerprint(view), versions };
}

export async function prepareSignedReleaseEvidence({ backup, options, binding, backupFingerprint, tableName, key, expiresInMs,
  service, repository, readItem, now = Date.now }) {
  requireValue(Buffer.isBuffer(key) && key.length >= 32 && Number.isSafeInteger(expiresInMs) && expiresInMs > 0 && expiresInMs <= 86400000,
    "A server signing key and a bounded lifetime are required");
  const { valid, plan, report } = await prepareDryRun(backup, options);
  requireValue(valid && plan.planId === binding.migrationId && plan.operations[0].targetId === binding.workspaceId &&
    plan.sourceNamespace === binding.sourceNamespace && report.backupFingerprint === backupFingerprint,
  "Backup or Plan differs from the reviewed binding", "EVIDENCE_PLAN_CONFLICT");
  const release = await readReleaseEvidence({ binding, plan, service, repository, readItem });
  const issuedAt = now();
  const payload = { formatVersion: 2, purpose: "release-preparation", endpoint: evidenceEndpoint, tableName, issuedAt,
    expiresAt: issuedAt + expiresInMs, subject: { ...binding, planId: plan.planId, backupFingerprint }, backup, options, release };
  return { payload, signature: createHmac("sha256", key).update(canonical(payload)).digest("hex") };
}
