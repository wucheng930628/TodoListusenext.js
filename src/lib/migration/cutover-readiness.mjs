import "server-only";
import { migrationPlanV2, hash } from "./plan-v2.mjs";
import { projectWorkspaceForUi } from "../client/workspace-projection.mjs";
import { projectMainView } from "../client/main-view-model.mjs";

// Server/CLI-only preflight. Probes are supplied by the trusted test runner, never an HTTP request.
// It neither executes migration/release nor enables the homepage.
export async function checkCutoverReadiness({ backup, options, migrationId, service, repository, readItem, probes = {}, authorization = null, now = () => Date.now() }) {
  const checks = []; const add = async (name, fn) => {
    try { const result = await fn(); if (result !== true) throw new Error("Evidence incomplete"); checks.push({ name, passed: true }); }
    catch (error) { checks.push({ name, passed: false, code: error.code || "CHECK_FAILED" }); }
  };
  for (const name of ["dynamodbLocal", "apiRepositoryTests", "reactApiTests", "backupArtifactVerified"]) await add(name, async () => typeof probes[name] === "function" && await probes[name]());
  let plan; let session; let receipts; let projection;
  await add("backupAndPreview", async () => { plan = migrationPlanV2(backup, options); return plan.migrationId === migrationId && plan.executable && !plan.issues.some(issue => issue.severity === "error"); });
  await add("sessionReceiptsRelease", async () => {
    session = await service.getSession(migrationId); receipts = []; let cursor = 0;
    do { const page = await service.listOperations(migrationId, { cursor, limit: 50 }); receipts.push(...page.items); cursor = page.nextCursor === null ? null : Number(page.nextCursor); } while (cursor !== null);
    return session.state === "RELEASED" && session.lockState === "RELEASED" && session.releaseProtocolVersion === 2 && session.registeredCount === session.total && session.confirmedCount === session.total && session.releasedCount === session.total && session.rolledBackCount === 0 && receipts.length === session.total && receipts.every(receipt => receipt.state === "CONFIRMED" && receipt.releasedAt) && session.verification?.workspaceHash === plan?.expectedWorkspaceHash;
  });
  await add("mappingFidelityAndLocks", async () => {
    if (!plan || !session || !receipts || receipts.length !== plan.operations.length) return false;
    const items = await Promise.all(receipts.map(receipt => readItem(receipt.operation.targetId)));
    if (!items.every((item, index) => item && item.migrationLock === false && item.version === receipts[index].managedVersion && hash(item) === receipts[index].managedHash && item.migrationOwner?.migrationId === migrationId && item.migrationOwner?.operationId === receipts[index].operation.operationId)) return false;
    projection = projectWorkspaceForUi(items);
    return items.find(item => item.entityType === "WORKSPACE")?.migrationReleaseVersion === 2 && hash(projection.workspace) === plan.expectedWorkspaceHash && hash(receipts.map(receipt => receipt.operation.targetId)) === hash(plan.operations.map(operation => operation.targetId));
  });
  await add("noUnmanagedChildren", async () => {
    if (!projection || !receipts) return false;
    const root = receipts.find(receipt => receipt.operation.type === "WORKSPACE").operation.targetId;
    const boards = await repository.listBoards(root); const actual = [root, ...boards.map(board => board.id)];
    for (const board of boards) actual.push(...(await repository.listTasks(board.id)).map(item => item.id), ...(await repository.listWidgets(board.id)).map(item => item.id));
    return hash(actual.sort()) === hash(receipts.map(receipt => receipt.operation.targetId).sort());
  });
  // Legacy callers retain the meaning of technical prerequisites; formal checks below are mandatory.
  const prerequisitesPassed = checks.every(check => check.passed);
  await add("boundDryRunEvidence", async () => {
    if (!plan?.sourceBinding || typeof probes.isolatedDryRun !== "function") return false;
    const report = await probes.isolatedDryRun(); const run = report?.migration || report;
    return report?.cleaned === true && run?.dryRunPassed === true && run.verifyPassed === true && run.releasePassed === true &&
      run.planId === plan.planId && run.backupFingerprint === plan.sourceBinding.backupFingerprint && run.sourceWorkspaceHash === plan.expectedWorkspaceHash && run.targetWorkspaceHash === plan.expectedWorkspaceHash &&
      run.mappingHash === hash(plan.operations.map(operation => [operation.key, operation.targetId, operation.parentId, operation.position])) &&
      hash(run.exclusionSummary) === hash(plan.sourceBinding.exclusionSummary) && Array.isArray(run.differences) && run.differences.length === 0;
  });
  await add("formalWorkspaceView", async () => {
    if (!plan || typeof probes.formalWorkspaceView !== "function") return false;
    const snapshot = await probes.formalWorkspaceView(); const root = plan.operations[0].targetId;
    return snapshot?.workspace?.id === root && snapshot.readiness?.eligible === true && snapshot.readiness.migration?.migrationId === migrationId &&
      snapshot.readiness.migration.state === "RELEASED" && hash(projectMainView(snapshot, root).workspace) === plan.expectedWorkspaceHash;
  });
  for (const name of ["sourceFrozen", "draftSafety", "pendingWriteSafety", "unknownRecovery", "reloadRecovery", "legacyProtection"]) {
    await add(name, async () => typeof probes[name] === "function" && await probes[name]());
  }
  await add("explicitCutoverAuthorization", async () => authorization?.enabled === true && authorization.workspaceId === plan?.operations[0]?.targetId &&
    authorization.migrationId === migrationId && authorization.backupFingerprint === plan?.sourceBinding?.backupFingerprint &&
    Number.isSafeInteger(authorization.expiresAt) && authorization.expiresAt > now() && authorization.expiresAt <= now() + 86400000);
  const ready = checks.every(check => check.passed);
  return { checkedAt: new Date(now()).toISOString(), migrationId, prerequisitesPassed, ready, cutoverEnabled: ready,
    workspaceId: plan?.operations[0]?.targetId ?? null, expiresAt: ready ? Math.min(authorization.expiresAt, now() + 30000) : null,
    blockers: checks.filter(check => !check.passed).map(check => check.name), checks,
    scope: "specified migration/workspace only", sourceRevision: plan?.sourceRevision ?? null, sessionVersion: session?.version ?? null };
}
export function assertCutoverReady(report) {
  if (report?.ready !== true || report?.cutoverEnabled !== true) throw new Error("Cutover blocked: readiness and explicit implementation approval are required");
}
