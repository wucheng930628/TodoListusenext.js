import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { canonical, hash } from "./plan-v2.mjs";
import { prepareDryRun } from "./dry-run.mjs";
import { checkCutoverReadiness } from "./cutover-readiness.mjs";
import { readWorkspaceView } from "../api/workspace-view.mjs";
import { readReleaseEvidence, viewFingerprint } from "./release-evidence.mjs";

export const browserChecks = Object.freeze(["indexedDbPending", "unknownReload", "confirmedRefresh", "draftProtection", "pendingSwitch", "conflict409", "legacyProtection", "sourceIsolation"]);
const deny = code => { throw Object.assign(new Error("Trusted cutover evidence is unavailable or inconsistent."), { code }); };
const subjectMatches = (a, b) => a && hash(a) === hash(b);

// Only the server owns this key. Neither signatures nor browser assertions replace live DB checks.
export function verifyEvidenceSignature(payload, signature, key) {
  if (!Buffer.isBuffer(key) || key.length < 32 || !/^[a-f0-9]{64}$/.test(signature || "")) return false;
  const expected = createHmac("sha256", key).update(canonical(payload)).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

/** No write operations. All dependencies are server-owned; no Request Body is accepted. */
export function createTrustedEvidenceProvider({ loadBundle, repository, service, readItem, verifySignature,
  requireBrowserState = false, redeemedUntil, now = () => Date.now(), endpoint, tableName }) {
  return async (binding, presentedSnapshot) => {
    const blocked = code => ({ ready: false, cutoverEnabled: false, workspaceId: binding.workspaceId, migrationId: binding.migrationId,
      planId: binding.migrationId, expiresAt: null, blockers: [code] });
    try {
      if (endpoint !== "http://127.0.0.1:9000" || !tableName || typeof loadBundle !== "function" || typeof verifySignature !== "function") return blocked("EVIDENCE_CONFIGURATION_REQUIRED");
      const signed = await loadBundle(binding);
      if (!signed || !(await verifySignature(signed.payload, signed.signature))) return blocked("EVIDENCE_SIGNATURE_REQUIRED");
      const bundle = signed.payload;
      if (![1, 2].includes(bundle?.formatVersion) || (binding.sourceNamespace && bundle.formatVersion !== 2) ||
        bundle.tableName !== tableName || bundle.endpoint !== endpoint || bundle.issuedAt > now() ||
        !Number.isSafeInteger(bundle.issuedAt) || !Number.isSafeInteger(bundle.expiresAt) || bundle.expiresAt <= now() || bundle.expiresAt > bundle.issuedAt + 86400000) return blocked("EVIDENCE_EXPIRED_OR_SCOPE");
      const subject = bundle.subject;
      if (!subject || subject.workspaceId !== binding.workspaceId || subject.migrationId !== binding.migrationId || subject.planId !== binding.migrationId || !/^[a-f0-9]{64}$/.test(subject.backupFingerprint || "")) return blocked("EVIDENCE_SUBJECT_CONFLICT");
      const prepared = await prepareDryRun(bundle.backup, bundle.options);
      const plan = prepared.plan;
      if (!prepared.valid || plan?.planId !== subject.planId || plan.operations[0].targetId !== subject.workspaceId || prepared.report.backupFingerprint !== subject.backupFingerprint) return blocked("EVIDENCE_PLAN_CONFLICT");
      if (bundle.formatVersion === 2) {
        if (binding.sourceNamespace !== plan.sourceNamespace || subject.sourceNamespace !== binding.sourceNamespace) return blocked("EVIDENCE_SUBJECT_CONFLICT");
        const release = await readReleaseEvidence({ binding, plan, repository, service, readItem });
        if (!bundle.release || hash(bundle.release) !== hash(release) ||
          (presentedSnapshot && (!presentedSnapshot.readiness?.eligible || viewFingerprint(presentedSnapshot) !== release.viewHash))) return blocked("LIVE_RELEASE_EVIDENCE_CONFLICT");
        if (now() >= bundle.expiresAt) return blocked("EVIDENCE_EXPIRED_DURING_CHECK");
        if (bundle.purpose === "release-preparation") return { ...blocked("CUTOVER_APPROVAL_REQUIRED"), evidenceVerified: true,
          sessionVersion: release.sessionVersion, backupFingerprint: subject.backupFingerprint, evidenceExpiresAt: bundle.expiresAt };
        if (bundle.purpose !== "cutover") return blocked("EVIDENCE_PURPOSE_CONFLICT");
      }
      const attestations = bundle.attestations;
      if (!attestations || Object.keys(attestations).sort().join(",") !== "approval,browser,dryRun,freeze,validation") return blocked("ATTESTATION_SCHEMA_CONFLICT");
      const validate = (kind, provenance) => {
        const item = attestations?.[kind];
        if (!item || item.kind !== kind || item.provenance !== provenance || !subjectMatches(item.subject, subject) ||
          !Number.isSafeInteger(item.issuedAt) || !Number.isSafeInteger(item.expiresAt) || item.issuedAt > now() || item.expiresAt <= now() ||
          item.expiresAt > bundle.expiresAt || item.issuedAt < bundle.issuedAt) deny("ATTESTATION_MISSING_OR_EXPIRED");
        return item;
      };
      const browser = validate("browser", "reviewed-real-browser");
      if (browserChecks.some(name => browser.checks?.[name] !== "PASS") || !/^[a-f0-9]{64}$/.test(browser.artifactHash || "")) return blocked("BROWSER_ACCEPTANCE_INCOMPLETE");
      const validation = validate("validation", "trusted-test-runner");
      if (!Number.isSafeInteger(validation.passed) || validation.passed < 1 || validation.failed !== 0 || !/^[a-f0-9]{64}$/.test(validation.artifactHash || "")) return blocked("VALIDATION_EVIDENCE_REQUIRED");
      const freeze = validate("freeze", "operator-source-freeze");
      if (freeze.frozen !== true) return blocked("SOURCE_NOT_FROZEN");
      const approval = validate("approval", "explicit-operator-approval");
      if (approval.approved !== true) return blocked("CUTOVER_APPROVAL_REQUIRED");
      if (requireBrowserState && (approval.browserState?.pendingWrite !== false || approval.browserState.unknownOperation !== false ||
        approval.browserState.unsavedDrafts !== false || approval.browserState.recoveryJournalClear !== true ||
        approval.browserState.sourceMatchesBackup !== true)) return blocked("BROWSER_STATE_CONFIRMATION_REQUIRED");
      const dryRun = validate("dryRun", "isolated-dynamodb-local");
      const run = dryRun.report?.migration || dryRun.report;
      if (dryRun.report?.cleaned !== true || run?.planId !== subject.planId || run.backupFingerprint !== subject.backupFingerprint) return blocked("DRY_RUN_EVIDENCE_CONFLICT");

      const before = await service.getSession(subject.migrationId);
      if ((bundle.formatVersion === 2 && before.version !== bundle.release.sessionVersion) ||
        before.sourceBinding?.backupFingerprint !== subject.backupFingerprint || hash(before.sourceBinding?.sourcePolicy) !== hash(plan.policies.sourcePolicy) ||
        before.manifestHash !== hash(plan.operations.map(op => ({ operationId: op.operationId, key: op.key, targetId: op.targetId, fingerprint: op.fingerprint })))) return blocked("LIVE_SESSION_BINDING_CONFLICT");
      const currentView = await readWorkspaceView(repository, subject.workspaceId, { migrationService: service });
      if (!currentView.readiness.eligible || (bundle.formatVersion === 2 && viewFingerprint(currentView) !== bundle.release.viewHash) || (presentedSnapshot &&
        (!presentedSnapshot.readiness.eligible || viewFingerprint(presentedSnapshot) !== viewFingerprint(currentView)))) return blocked("VIEW_CHANGED_OR_INCOMPLETE");
      const probes = {
        dynamodbLocal: async () => endpoint === "http://127.0.0.1:9000",
        apiRepositoryTests: async () => validation.failed === 0,
        reactApiTests: async () => validation.failed === 0 && browserChecks.every(name => browser.checks[name] === "PASS"),
        backupArtifactVerified: async () => prepared.valid,
        isolatedDryRun: async () => dryRun.report,
        formalWorkspaceView: async () => currentView,
        sourceFrozen: async () => freeze.frozen === true,
        draftSafety: async () => browser.checks.draftProtection === "PASS",
        pendingWriteSafety: async () => browser.checks.pendingSwitch === "PASS",
        unknownRecovery: async () => browser.checks.indexedDbPending === "PASS" && browser.checks.unknownReload === "PASS",
        reloadRecovery: async () => browser.checks.confirmedRefresh === "PASS",
        legacyProtection: async () => browser.checks.legacyProtection === "PASS" && plan.policies.sourcePolicy.legacy.action === "exclude",
      };
      const report = await checkCutoverReadiness({ backup: bundle.backup, options: bundle.options, migrationId: subject.migrationId, service, repository, readItem, probes, now,
        authorization: { enabled: approval.approved === true, workspaceId: subject.workspaceId, migrationId: subject.migrationId, backupFingerprint: subject.backupFingerprint, expiresAt: approval.expiresAt } });
      const after = await service.getSession(subject.migrationId);
      const finalView = await readWorkspaceView(repository, subject.workspaceId, { migrationService: service });
      if (before.version !== after.version || !finalView.readiness.eligible ||
        viewFingerprint(currentView) !== viewFingerprint(finalView)) return blocked("EVIDENCE_CHANGED_DURING_CHECK");
      const evidenceExpiresAt = Math.min(bundle.expiresAt, ...Object.values(attestations).map(item => item.expiresAt));
      const redemptionExpiry = report.ready && redeemedUntil ? await redeemedUntil(bundle) : evidenceExpiresAt;
      const expiresAt = report.ready ? Math.min(report.expiresAt, evidenceExpiresAt, redemptionExpiry ?? 0) : null;
      const completedAt = now();
      if (report.ready && redeemedUntil && !(redemptionExpiry > completedAt)) return { ...blocked("CUTOVER_REDEMPTION_REQUIRED"),
        evidenceVerified: true, sessionVersion: after.version, evidenceExpiresAt };
      if (completedAt >= bundle.expiresAt || Object.values(attestations).some(item => completedAt >= item.expiresAt) || (report.ready && completedAt >= expiresAt)) return blocked("EVIDENCE_EXPIRED_DURING_CHECK");
      return { ...report, planId: subject.planId, backupFingerprint: subject.backupFingerprint, sessionVersion: after.version,
        expiresAt, evidenceExpiresAt, evidenceVerified: report.ready };
    } catch (error) { return blocked(/^[A-Z_]{1,80}$/.test(error.code || "") ? error.code : "EVIDENCE_VERIFICATION_FAILED"); }
  };
}
