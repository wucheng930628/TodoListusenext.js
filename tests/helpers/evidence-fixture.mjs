import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { MemoryClient } from "./memory-client.mjs";
import { workspaceFixture, storageFixture, createdAt } from "../phase4a-fixtures.mjs";
import { captureWorkspaceBackup } from "../../src/lib/client/workspace-backup.mjs";
import { sealBackup } from "../../src/lib/client/verified-backup.mjs";
import { migrationPlanV2, canonical, hash } from "../../src/lib/migration/plan-v2.mjs";
import { createMigrationService } from "../../src/lib/migration/service.mjs";
import { createRepository } from "../../src/lib/slowly-repository.mjs";
import { createTrustedEvidenceProvider, verifyEvidenceSignature, browserChecks } from "../../src/lib/migration/trusted-evidence.mjs";
import { readWorkspaceView } from "../../src/lib/api/workspace-view.mjs";
import { GetCommand } from "@aws-sdk/lib-dynamodb";

// Every signature and attestation here is synthetic test data, never formal evidence.
export async function evidenceFixture({ db = new MemoryClient(), tableName = "isolated-evidence-memory" } = {}) {
  const backup = await sealBackup(captureWorkspaceBackup({ storage: storageFixture({ "slowly-workspace-v2": JSON.stringify(workspaceFixture()), "slowly-board-v1": '[{"id":"excluded-1"},{"id":"excluded-2"}]' }), createdAt }), "http://localhost:3000");
  const options = { sourceNamespace: `evidence-${randomUUID()}`, policies: { sourcePolicy: { primary: "slowly-workspace-v2", legacy: { source: "slowly-board-v1", action: "exclude", acknowledged: true } } } };
  const plan = migrationPlanV2(backup, options); const service = createMigrationService(db, { tableName }); const repository = createRepository(db, { tableName });
  await service.createSession(backup, options, plan.planId);
  for (const op of plan.operations) await service.execute(plan.planId, op.operationId, op.fingerprint);
  await service.verify(plan.planId);
  for (let i = 0; i <= plan.operations.length + 1; i++) { const s = await service.getSession(plan.planId); if (s.state === "RELEASED") break; const p = await service.releasePreview(plan.planId, s.version); await service.release(plan.planId, s.version, p.verificationHash, plan.planId); }
  const time = Date.now(); const subject = { workspaceId: plan.operations[0].targetId, migrationId: plan.planId, planId: plan.planId, backupFingerprint: backup.integrity.fingerprint };
  const attestation = (kind, provenance, fields) => ({ kind, provenance, subject, issuedAt: time, expiresAt: time + 60000, ...fields });
  const dryReport = { cleaned: true, dryRunPassed: true, verifyPassed: true, releasePassed: true, planId: plan.planId, backupFingerprint: subject.backupFingerprint,
    sourceWorkspaceHash: plan.expectedWorkspaceHash, targetWorkspaceHash: plan.expectedWorkspaceHash, mappingHash: hash(plan.operations.map(op => [op.key, op.targetId, op.parentId, op.position])), exclusionSummary: plan.sourceBinding.exclusionSummary, differences: [] };
  const bundle = { formatVersion: 1, tableName, endpoint: "http://127.0.0.1:9000", issuedAt: time, expiresAt: time + 60000, subject, backup, options,
    attestations: {
      browser: attestation("browser", "reviewed-real-browser", { checks: Object.fromEntries(browserChecks.map(name => [name, "PASS"])), artifactHash: hash("synthetic-browser-fixture") }),
      validation: attestation("validation", "trusted-test-runner", { passed: 207, failed: 0, artifactHash: hash("synthetic-validation-fixture") }),
      freeze: attestation("freeze", "operator-source-freeze", { frozen: true }), approval: attestation("approval", "explicit-operator-approval", { approved: true }),
      dryRun: attestation("dryRun", "isolated-dynamodb-local", { report: dryReport }),
    } };
  const key = randomBytes(32); const sign = payload => ({ payload: structuredClone(payload), signature: createHmac("sha256", key).update(canonical(payload)).digest("hex") });
  let signed = sign(bundle);
  const binding = { workspaceId: subject.workspaceId, migrationId: subject.migrationId };
  const readItem = async id => (await db.send(new GetCommand({ TableName: tableName, Key: { id }, ConsistentRead: true }))).Item;
  const provider = createTrustedEvidenceProvider({ loadBundle: async () => signed, verifySignature: (body, signature) => verifyEvidenceSignature(body, signature, key), repository, service, readItem, tableName, endpoint: bundle.endpoint, now: () => time });
  return { db, tableName, plan, service, repository, bundle, binding, sign, provider, setSigned(value) { signed = value; },
    snapshot: () => readWorkspaceView(repository, binding.workspaceId, { migrationService: service }) };
}
