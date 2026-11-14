import "server-only";
import { DataError, requireValue, assertItemSize } from "../data-model.mjs";
import { migrationStore } from "./store.mjs";
import { migrationPlanV2, hash, operationFingerprint, restoreWorkspace } from "./plan-v2.mjs";

const sessionKey = id => `SLOWLY#MIGRATION_SESSION#${id}`;
const operationKey = (id, op) => `SLOWLY#MIGRATION_OPERATION#${id}#${op}`;
const manifestKey = (id, index) => `SLOWLY#MIGRATION_MANIFEST#${id}#${String(index).padStart(12, "0")}`;
const validHash = value => requireValue(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "Invalid migration identifier");
const header = op => ({ operationId: op.operationId, key: op.key, targetId: op.targetId, fingerprint: op.fingerprint });

export function createMigrationService(db, { tableName = "SlowlyTasks", clock = () => new Date().toISOString(), registrationBudget = 32 } = {}) {
  const store = migrationStore(db, tableName);
  const revise = (item, changes) => ({ ...item, ...changes, version: item.version + 1, updatedAt: clock() });
  const control = (id, entityType, fields, now = clock()) => ({ id, entityType, schemaVersion: 1, version: 1, createdAt: now, updatedAt: now, ...fields });
  async function getControl(id, entityType) {
    const item = await store.get(id);
    requireValue(item?.entityType === entityType, "Migration resource not found", "NOT_FOUND");
    requireValue(item.schemaVersion === 1 && Number.isSafeInteger(item.version) && item.version >= 1, "Unsupported control schema", "UNSUPPORTED_SCHEMA");
    return item;
  }
  async function getSession(id) {
    validHash(id); const session = await getControl(sessionKey(id), "MIGRATION_SESSION");
    requireValue(session.planFormatVersion === 2 && session.targetSchemaVersion === 1, "Unsupported session schema", "UNSUPPORTED_SCHEMA");
    requireValue([session.total, session.registeredCount, session.confirmedCount, session.rolledBackCount, session.releasedCount].every(value => Number.isSafeInteger(value) && value >= 0) && session.total >= 1 && session.registeredCount <= session.total && session.confirmedCount <= session.registeredCount && session.rolledBackCount <= session.confirmedCount && session.releasedCount <= session.confirmedCount, "Invalid session counters", "INTEGRITY_CONFLICT");
    requireValue(session.migrationId === id && ["PREPARING", "READY", "RUNNING", "VERIFYING", "VERIFIED", "RELEASING", "CONFLICT", "FAILED", "ROLLING_BACK", "ROLLBACK_CONFLICT", "ROLLED_BACK", "RELEASED"].includes(session.state) && ["HELD", "CLOSED", "RELEASING", "RELEASED"].includes(session.lockState), "Invalid session state", "INTEGRITY_CONFLICT");
    return session;
  }
  async function getOperation(id, op) {
    validHash(op); await getSession(id);
    const receipt = await getControl(operationKey(id, op), "MIGRATION_OPERATION");
    requireValue(receipt.migrationId === id && receipt.operation.operationId === op && operationFingerprint(receipt.operation) === receipt.operation.fingerprint && hash([id, receipt.operation.key]) === op, "Operation integrity mismatch", "INTEGRITY_CONFLICT");
    const manifest = await getControl(manifestKey(id, receipt.index), "MIGRATION_MANIFEST");
    requireValue(manifest.migrationId === id && hash(manifest.header) === hash(header(receipt.operation)), "Manifest mismatch", "INTEGRITY_CONFLICT");
    return receipt;
  }
  async function allOperations(session) {
    const operations = [];
    for (let index = 0; index < session.registeredCount; index++) {
      const manifest = await getControl(manifestKey(session.migrationId, index), "MIGRATION_MANIFEST");
      requireValue(manifest.index === index && manifest.migrationId === session.migrationId, "Manifest ownership mismatch", "INTEGRITY_CONFLICT");
      const receipt = await getOperation(session.migrationId, manifest.header.operationId);
      requireValue(receipt.index === index, "Manifest order mismatch", "INTEGRITY_CONFLICT"); operations.push(receipt);
    }
    if (session.registeredCount === session.total) requireValue(hash(operations.map(receipt => header(receipt.operation))) === session.manifestHash, "Manifest digest mismatch", "INTEGRITY_CONFLICT");
    return operations;
  }
  function target(operation, session) {
    const item = { id: operation.targetId, entityType: operation.type, schemaVersion: 1, version: 1, createdAt: session.createdAt, updatedAt: session.createdAt,
      position: operation.position, data: structuredClone(operation.data), restoreShape: structuredClone(operation.restoreShape), migrationLock: true,
      migrationOwner: { migrationId: session.migrationId, operationId: operation.operationId } };
    if (operation.parentId) Object.assign(item, { parentId: operation.parentId, workspaceId: operation.workspaceId, gsi1pk: operation.parentId, gsi1sk: `${operation.type}#${String(operation.position).padStart(12, "0")}#${item.id}` });
    if (operation.boardId) item.boardId = operation.boardId;
    if (operation.type === "BOARD") Object.assign(item, { taskCount: 0, widgetCount: 0, doingCount: 0 });
    if (operation.type === "WORKSPACE") item.boardCount = 0;
    assertItemSize(item); return item;
  }
  async function ownedTarget(receipt, locked = true) {
    const item = await store.get(receipt.operation.targetId);
    requireValue(item && item.schemaVersion === 1 && item.migrationLock === locked && item.migrationOwner?.migrationId === receipt.migrationId && item.migrationOwner?.operationId === receipt.operation.operationId && item.version === receipt.managedVersion && hash(item) === receipt.managedHash, "Target ownership, content or version changed", "INTEGRITY_CONFLICT");
    return item;
  }
  async function createSession(backup, options, expectedPlanId) {
    const plan = migrationPlanV2(backup, options);
    requireValue(expectedPlanId === plan.planId, "Reviewed plan changed", "PLAN_CONFLICT");
    const id = plan.migrationId;
    const sourceId = `SLOWLY#MIGRATION_SOURCE#${hash(plan.sourceNamespace)}`;
    let session = await store.get(sessionKey(id));
    if (!session) {
      const now = clock();
      const source = control(sourceId, "MIGRATION_SOURCE", { migrationId: id, sourceRevision: plan.sourceRevision, sourceNamespaceHash: hash(plan.sourceNamespace) }, now);
      session = control(sessionKey(id), "MIGRATION_SESSION", { migrationId: id, state: "PREPARING", planFormatVersion: 2, targetSchemaVersion: 1,
        sourceId, sourceRevision: plan.sourceRevision, sourceStorageKey: plan.sourceStorageKey, sourceStorageVersion: plan.sourceStorageVersion,
        policies: plan.policies, expectedWorkspaceHash: plan.expectedWorkspaceHash, counts: plan.counts, manifestHash: hash(plan.operations.map(header)),
        total: plan.operations.length, registeredCount: 0, confirmedCount: 0, rolledBackCount: 0, releasedCount: 0, lockState: "HELD" }, now);
      // Preflight every item before binding a source, not after partial writes.
      for (const [index, operation] of plan.operations.entries()) {
        assertItemSize(control(operationKey(id, operation.operationId), "MIGRATION_OPERATION", { migrationId: id, index, state: "PENDING", operation }, now));
        target(operation, session);
      }
      const existingSource = await store.get(sourceId);
      requireValue(!existingSource || existingSource.migrationId === id, "Source already belongs to another migration", "SOURCE_CONFLICT");
      try { await store.transact([store.put(session), store.put(source)]); }
      catch (error) { if (error.code !== "CONFLICT") throw error; session = await getSession(id); }
    }
    session = await getSession(id);
    const source = await getControl(sourceId, "MIGRATION_SOURCE");
    requireValue(source.migrationId === id && source.sourceRevision === plan.sourceRevision && session.sourceId === sourceId && session.manifestHash === hash(plan.operations.map(header)), "Session source mismatch", "SOURCE_CONFLICT");
    for (let attempt = 0; attempt < registrationBudget && session.state === "PREPARING" && session.registeredCount < session.total; attempt++) {
      const index = session.registeredCount; const operation = plan.operations[index];
      const manifest = control(manifestKey(id, index), "MIGRATION_MANIFEST", { migrationId: id, index, header: header(operation) }, session.createdAt);
      const receipt = control(operationKey(id, operation.operationId), "MIGRATION_OPERATION", { migrationId: id, index, state: "PENDING", operation }, session.createdAt);
      try { await store.transact([store.put(manifest), store.put(receipt), store.put(revise(session, { registeredCount: index + 1 }), session)]); }
      catch (error) { if (error.code !== "CONFLICT") throw error; }
      session = await getSession(id);
    }
    if (session.state === "PREPARING" && session.registeredCount === session.total) {
      await allOperations(session);
      try { await store.transact([store.put(revise(session, { state: "READY" }), session)]); }
      catch (error) { if (error.code !== "CONFLICT") throw error; }
    }
    return getSession(id);
  }
  async function recordConflict(session, receipt, code) {
    const state = code === "FAILED_WRITE" ? "FAILED" : code === "ROLLBACK_CONFLICT" || session.state === "ROLLING_BACK" || session.state === "ROLLBACK_CONFLICT" ? "ROLLBACK_CONFLICT" : "CONFLICT";
    const changes = { lastError: { code, at: clock(), operationId: receipt?.operation.operationId ?? null }, state };
    const actions = [store.put(revise(session, changes), session)];
    if (receipt) actions.push(store.put(revise(receipt, { lastError: changes.lastError, ...(["PENDING", "FAILED"].includes(receipt.state) ? { state: state === "FAILED" ? "FAILED" : "CONFLICT" } : {}) }), receipt));
    try { await store.transact(actions); } catch { /* Never overwrite concurrent committed state to record an error. */ }
  }
  async function parentChanges(receipt, session, delta) {
    if (!receipt.operation.parentId) return [];
    const parent = await store.get(receipt.operation.parentId);
    requireValue(parent?.migrationOwner?.migrationId === session.migrationId, "Parent belongs to another session", "INTEGRITY_CONFLICT");
    const parentReceipt = await getOperation(session.migrationId, parent.migrationOwner.operationId);
    requireValue(parentReceipt.state === "CONFIRMED" && parentReceipt.operation.targetId === receipt.operation.parentId &&
      ((receipt.operation.type === "BOARD" && parent.entityType === "WORKSPACE") || (["TASK", "WIDGET"].includes(receipt.operation.type) && parent.entityType === "BOARD")), "Parent is not confirmed", "DEPENDENCY_CONFLICT");
    await ownedTarget(parentReceipt);
    const changes = {};
    if (receipt.operation.type === "BOARD") {
      requireValue(Number.isSafeInteger(parent.boardCount) && parent.boardCount + delta >= 0, "Workspace count metadata requires review", "INTEGRITY_CONFLICT");
      changes.boardCount = parent.boardCount + delta;
    }
    if (["TASK", "WIDGET"].includes(receipt.operation.type)) {
      const key = receipt.operation.type === "TASK" ? "taskCount" : "widgetCount";
      changes[key] = parent[key] + delta;
      changes.doingCount = parent.doingCount + (receipt.operation.type === "TASK" && receipt.operation.data.status === "doing" ? delta : 0);
      requireValue(changes[key] >= 0 && changes.doingCount >= 0 && changes.doingCount <= parent.data.wipLimit, "WIP or parent count conflict", "WIP_LIMIT");
    }
    const next = revise(parent, changes);
    return [store.put(next, parent, true), store.put(revise(parentReceipt, { managedVersion: next.version, managedHash: hash(next) }), parentReceipt)];
  }
  async function execute(id, opId, fingerprint) {
    validHash(fingerprint);
    for (let attempt = 0; attempt < 16; attempt++) {
      const session = await getSession(id); const receipt = await getOperation(id, opId);
      requireValue(fingerprint === receipt.operation.fingerprint, "Operation payload changed", "IDEMPOTENCY_KEY_REUSE");
      requireValue(["READY", "RUNNING", "VERIFIED", "FAILED"].includes(session.state) && session.lockState === "HELD", "Session does not accept execution", "SESSION_STATE");
      if (receipt.state === "CONFIRMED") return { receipt, replayed: true };
      requireValue(["READY", "RUNNING", "FAILED"].includes(session.state) && ["PENDING", "FAILED"].includes(receipt.state), "Operation cannot execute", "SESSION_STATE");
      try {
        if (await store.get(receipt.operation.targetId)) {
          const latest = await getOperation(id, opId);
          if (latest.state === "CONFIRMED") return { receipt: latest, replayed: true };
          throw new DataError("TARGET_CONFLICT", "Target already exists; it will not be adopted");
        }
        const item = target(receipt.operation, session);
        const nextReceipt = revise(receipt, { state: "CONFIRMED", confirmedAt: clock(), managedVersion: item.version, managedHash: hash(item), writeVersion: 1 });
        const parents = await parentChanges(receipt, session, 1);
        await store.transact([store.put(item), store.put(nextReceipt, receipt), ...parents, store.put(revise(session, { state: "RUNNING", confirmedCount: session.confirmedCount + 1 }), session)]);
        return { receipt: nextReceipt, replayed: false };
      } catch (error) {
        if (error.code === "CONFLICT") continue;
        if (["TARGET_CONFLICT", "INTEGRITY_CONFLICT", "WIP_LIMIT", "FAILED_WRITE"].includes(error.code)) await recordConflict(session, receipt, error.code);
        throw error;
      }
    }
    throw new DataError("CONFLICT", "Concurrent migration activity; query receipts before retrying");
  }
  async function verify(id) {
    let session = await getSession(id);
    requireValue(["RUNNING", "VERIFYING", "VERIFIED"].includes(session.state) && session.confirmedCount === session.total && session.lockState === "HELD", "Migration is not complete", "SESSION_STATE");
    if (session.state !== "VERIFYING" && session.state !== "VERIFIED") {
      await store.transact([store.put(revise(session, { state: "VERIFYING" }), session)]); session = await getSession(id);
    }
    let checkingReceipt = null;
    try {
      const receipts = await allOperations(session); const items = [];
      for (const receipt of receipts) {
        checkingReceipt = receipt;
        requireValue(receipt.state === "CONFIRMED", "Unconfirmed manifest operation", "INTEGRITY_CONFLICT");
        items.push(await ownedTarget(receipt));
      }
      checkingReceipt = null;
      const workspace = restoreWorkspace(items);
      requireValue(hash(workspace) === session.expectedWorkspaceHash, "Restored source fingerprint differs", "INTEGRITY_CONFLICT");
      const counts = { workspaces: items.filter(item => item.entityType === "WORKSPACE").length, boards: workspace.boards.length,
        tasks: workspace.boards.reduce((n, board) => n + board.tasks.length, 0), widgets: workspace.boards.reduce((n, board) => n + (board.widgets?.length || 0), 0),
        subtasks: workspace.boards.reduce((n, board) => n + board.tasks.reduce((n, task) => n + (task.subtasks?.length || 0), 0), 0) };
      requireValue(hash(counts) === hash(session.counts), "Source counts differ", "INTEGRITY_CONFLICT");
      for (const board of items.filter(item => item.entityType === "BOARD")) {
        const children = items.filter(item => item.boardId === board.id);
        requireValue(board.taskCount === children.filter(item => item.entityType === "TASK").length && board.widgetCount === children.filter(item => item.entityType === "WIDGET").length && board.doingCount === children.filter(item => item.entityType === "TASK" && item.data.status === "doing").length && board.doingCount <= board.data.wipLimit, "Board counters differ", "INTEGRITY_CONFLICT");
      }
      if (session.state !== "VERIFIED") await store.transact([store.put(revise(session, { state: "VERIFIED", verifiedAt: clock(), verification: { workspaceHash: hash(workspace), counts } }), session)]);
      return { session: await getSession(id), counts, workspaceHash: hash(workspace), valid: true };
    } catch (error) { if (error.code !== "CONFLICT" && error.code !== "STORAGE") await recordConflict(session, checkingReceipt, error.code || "INTEGRITY_CONFLICT"); throw error; }
  }
  async function rollbackPreview(id) {
    const session = await getSession(id);
    if (session.lockState !== "HELD") return { sessionVersion: session.version, canRollback: false, conflicts: [{ code: "SESSION_RELEASED" }], deletable: [] };
    if (session.state === "VERIFYING") return { sessionVersion: session.version, canRollback: false, conflicts: [{ code: "SESSION_STATE" }], deletable: [] };
    const receipts = await allOperations(session); const conflicts = []; const deletable = [];
    for (const receipt of receipts) {
      if (receipt.state === "CONFIRMED") {
        try { await ownedTarget(receipt); deletable.push({ operationId: receipt.operation.operationId, targetId: receipt.operation.targetId, version: receipt.managedVersion }); }
        catch (error) { conflicts.push({ operationId: receipt.operation.operationId, code: error.code }); }
      } else if (["PENDING", "FAILED", "CONFLICT"].includes(receipt.state) && await store.get(receipt.operation.targetId)) conflicts.push({ operationId: receipt.operation.operationId, code: "UNRECEIPTED_TARGET" });
    }
    return { sessionVersion: session.version, canRollback: conflicts.length === 0, conflicts, deletable: deletable.reverse() };
  }
  async function rollback(id, expectedVersion, confirmation) {
    let session = await getSession(id);
    requireValue(confirmation === id, "Explicit rollback confirmation required");
    if (session.state === "ROLLED_BACK") return session;
    requireValue(Number.isSafeInteger(expectedVersion) && expectedVersion === session.version, "Rollback preview is stale", "CONFLICT");
    requireValue(session.lockState === "HELD" && !["RELEASED", "VERIFYING"].includes(session.state), "Rollback is not safe", "SESSION_STATE");
    const preview = await rollbackPreview(id);
    if (!preview.canRollback) {
      const first = preview.conflicts.find(conflict => conflict.operationId);
      const conflictedReceipt = first ? await getOperation(id, first.operationId) : null;
      await recordConflict(session, conflictedReceipt, "ROLLBACK_CONFLICT");
      throw new DataError("ROLLBACK_CONFLICT", "Resolve target conflicts; nothing will be force-deleted");
    }
    if (session.state !== "ROLLING_BACK") {
      await store.transact([store.put(revise(session, { state: "ROLLING_BACK" }), session)]); session = await getSession(id);
    }
    const receipts = await allOperations(session);
    const receipt = [...receipts].reverse().find(item => item.state === "CONFIRMED");
    if (!receipt) {
      requireValue(session.confirmedCount === session.rolledBackCount, "Rollback count mismatch", "INTEGRITY_CONFLICT");
      await store.transact([store.put(revise(session, { state: "ROLLED_BACK", lockState: "CLOSED", rolledBackAt: clock() }), session)]);
      return getSession(id);
    }
    try {
      const item = await ownedTarget(receipt);
      if (item.entityType === "BOARD") requireValue(item.taskCount === 0 && item.widgetCount === 0, "Board still has children", "INTEGRITY_CONFLICT");
      const parents = await parentChanges(receipt, session, -1);
      await store.transact([store.remove(item), store.put(revise(receipt, { state: "ROLLED_BACK", rolledBackAt: clock() }), receipt), ...parents,
        store.put(revise(session, { rolledBackCount: session.rolledBackCount + 1 }), session)]);
      return getSession(id);
    } catch (error) {
      if (error.code === "CONFLICT") {
        const latestSession = await getSession(id); const latestReceipt = await getOperation(id, receipt.operation.operationId);
        if (latestReceipt.state === "ROLLED_BACK") return latestSession;
        try { await ownedTarget(latestReceipt); }
        catch (integrity) { if (integrity.code === "INTEGRITY_CONFLICT") await recordConflict(latestSession, latestReceipt, "ROLLBACK_CONFLICT"); }
      } else if (error.code !== "STORAGE") await recordConflict(session, receipt, error.code || "ROLLBACK_CONFLICT");
      throw error;
    }
  }
  // Read-only authority for release and cutover. No verify/error-recording writes.
  async function inspectRelease(session) {
    requireValue(session.registeredCount === session.total && session.confirmedCount === session.total && session.rolledBackCount === 0 && session.verification?.workspaceHash === session.expectedWorkspaceHash && session.verifiedAt, "Verify and complete all operations first", "RELEASE_BLOCKED");
    const receipts = await allOperations(session); const ordered = [...receipts].reverse(); const items = [];
    for (const [index, receipt] of ordered.entries()) {
      const released = index < session.releasedCount;
      requireValue(receipt.state === "CONFIRMED" && Boolean(receipt.releasedAt) === released, "Receipt release cursor differs", "INTEGRITY_CONFLICT");
      items.push(await ownedTarget(receipt, !released));
    }
    const roots = items.filter(item => item.entityType === "WORKSPACE");
    requireValue(roots.length === 1 && ordered.at(-1).operation.targetId === roots[0].id, "Workspace must be released last", "INTEGRITY_CONFLICT");
    requireValue(items.every(item => item === roots[0] || item.workspaceId === roots[0].id), "Cross-workspace target", "INTEGRITY_CONFLICT");
    const workspace = restoreWorkspace(items);
    const counts = { workspaces: 1, boards: workspace.boards.length, tasks: workspace.boards.reduce((n, board) => n + board.tasks.length, 0), widgets: workspace.boards.reduce((n, board) => n + (board.widgets?.length || 0), 0), subtasks: workspace.boards.reduce((n, board) => n + board.tasks.reduce((n, task) => n + (task.subtasks?.length || 0), 0), 0) };
    requireValue(hash(workspace) === session.expectedWorkspaceHash && hash(counts) === hash(session.counts) && hash(counts) === hash(session.verification.counts), "Verified source or counts changed", "INTEGRITY_CONFLICT");
    for (const board of items.filter(item => item.entityType === "BOARD")) {
      const children = items.filter(item => item.boardId === board.id);
      requireValue(board.taskCount === children.filter(item => item.entityType === "TASK").length && board.widgetCount === children.filter(item => item.entityType === "WIDGET").length && board.doingCount === children.filter(item => item.entityType === "TASK" && item.data.status === "doing").length && board.doingCount <= board.data.wipLimit, "Board counters changed", "INTEGRITY_CONFLICT");
    }
    return { ordered, items, root: roots[0], workspace };
  }
  async function releasePreview(id, expectedVersion) {
    const session = await getSession(id);
    requireValue(Number.isSafeInteger(expectedVersion) && expectedVersion === session.version, "Release preview version conflict", "CONFLICT");
    const result = { migrationId: id, sessionVersion: session.version, eligible: false, blockers: [], verificationHash: null,
      confirmedCount: session.confirmedCount, totalCount: session.total, releasedCount: session.releasedCount, lockState: session.lockState, nextAction: null };
    try {
      if (session.state === "RELEASED" && session.lockState === "RELEASED" && session.releaseProtocolVersion === 2 && session.releasedCount === session.total) {
        const root = await store.get(session.releaseWorkspaceId);
        requireValue(root?.entityType === "WORKSPACE" && root.schemaVersion === 1 && root.migrationLock === false && root.migrationReleaseVersion === 2 && root.migrationOwner?.migrationId === id, "Released workspace certificate is missing", "INTEGRITY_CONFLICT");
        return { ...result, eligible: true, verificationHash: session.releaseVerificationHash };
      }
      requireValue((session.state === "VERIFIED" && session.lockState === "HELD" && session.releasedCount === 0) || (session.state === "RELEASING" && session.lockState === "RELEASING" && session.releaseProtocolVersion === 2), "Session is not safely releasable (legacy partial releases require review)", "RELEASE_BLOCKED");
      const inspected = await inspectRelease(session);
      result.verificationHash = session.releaseVerificationHash || hash({ migrationId: id, manifestHash: session.manifestHash, sourceRevision: session.sourceRevision, targets: inspected.ordered.map(receipt => [receipt.operation.targetId, receipt.managedVersion, receipt.managedHash]) });
      result.eligible = true; result.nextAction = session.state === "RELEASING" ? "resume-release" : "start-release";
    } catch (error) { if (!(error instanceof DataError) || error.code === "STORAGE") throw error; result.blockers.push({ code: error.code }); }
    return result;
  }
  async function release(id, expectedVersion, expectedVerificationHash, confirmation) {
    validHash(expectedVerificationHash); requireValue(confirmation === id, "Explicit release confirmation required");
    const session = await getSession(id);
    // A lost response may be replayed with an earlier version, but never advances twice.
    if (session.releaseProtocolVersion === 2 && session.releaseVerificationHash === expectedVerificationHash && Number.isSafeInteger(expectedVersion) && expectedVersion >= session.releaseRequestVersion && expectedVersion < session.version && ["RELEASING", "RELEASED"].includes(session.state)) return session;
    const preview = await releasePreview(id, expectedVersion);
    requireValue(preview.eligible, "Release is blocked; inspect release-preview", "RELEASE_BLOCKED");
    requireValue(preview.verificationHash === expectedVerificationHash, "Release verification changed", "VERIFICATION_STALE");
    if (session.state === "RELEASED") return session;
    const { ordered, root } = await inspectRelease(session);
    if (session.state === "VERIFIED") {
      // Root snapshot + session CAS serializes against rollback and root changes.
      await store.transact([store.check(root), store.put(revise(session, { state: "RELEASING", lockState: "RELEASING", releaseProtocolVersion: 2, releaseWorkspaceId: root.id, releaseRequestVersion: expectedVersion, releaseVerificationHash: expectedVerificationHash, releaseStartedAt: clock() }), session)]);
      return getSession(id);
    }
    const receipt = ordered[session.releasedCount]; const item = await ownedTarget(receipt);
    const releasedCount = session.releasedCount + 1; const final = releasedCount === session.total;
    const unlocked = revise(item, { migrationLock: false, ...(final ? { migrationReleaseVersion: 2 } : {}) });
    requireValue(!final || item.id === root.id, "Only final transaction can release workspace barrier", "INTEGRITY_CONFLICT");
    await store.transact([store.put(unlocked, item, true), store.put(revise(receipt, { managedVersion: unlocked.version, managedHash: hash(unlocked), releasedAt: clock() }), receipt),
      ...(!final ? [store.check(root)] : []), store.put(revise(session, { releasedCount, ...(final ? { state: "RELEASED", lockState: "RELEASED", releasedAt: clock() } : {}) }), session)]);
    return getSession(id);
  }
  async function listOperations(id, { cursor = 0, limit = 25 } = {}) {
    const session = await getSession(id);
    requireValue(Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= session.registeredCount && Number.isSafeInteger(limit) && limit >= 1 && limit <= 50, "Invalid operations page");
    const items = [];
    for (let index = cursor; index < Math.min(session.registeredCount, cursor + limit); index++) {
      const manifest = await getControl(manifestKey(id, index), "MIGRATION_MANIFEST"); items.push(await getOperation(id, manifest.header.operationId));
    }
    return { items, nextCursor: cursor + items.length < session.registeredCount ? String(cursor + items.length) : null };
  }
  return { createSession, getSession, getOperation, listOperations, execute, verify, rollbackPreview, rollback, releasePreview, release };
}
