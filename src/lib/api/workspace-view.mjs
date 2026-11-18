import "server-only";
import { DataError, requireValue, assertId, validateData } from "../data-model.mjs";
import { guard, query, assertApiId } from "./handlers.mjs";
import { projectMainView } from "../client/main-view-model.mjs";
import { assertReleaseBinding } from "./formal-workspace.mjs";

function dto(item) { return { id: item.id, version: item.version, position: item.position, createdAt: item.createdAt, updatedAt: item.updatedAt, ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}), ...(item.boardId ? { boardId: item.boardId } : {}), data: structuredClone(item.data) }; }

// Parent-version fences plus strong base-table reads. GSI omissions never become empty state.
export async function readWorkspaceView(repository, workspaceId, { migrationService } = {}) {
  assertId(workspaceId, "WORKSPACE");
  const root = await repository.getWorkspace(workspaceId); const boards = await repository.listBoards(workspaceId); const blockers = []; const rows = [root];
  if (!Number.isSafeInteger(root.boardCount)) blockers.push({ code: "WORKSPACE_COUNT_REQUIRED" });
  else requireValue(root.boardCount === boards.length, "Workspace GSI is catching up", "SNAPSHOT_NOT_READY");
  const entries = await Promise.all(boards.map(async indexed => {
    const board = await repository.getBoard(indexed.id);
    requireValue(board.workspaceId === workspaceId, "Foreign board", "OWNERSHIP");
    const readChildren = async (type, list) => Promise.all((await list(board.id)).map(async item => {
      let child;
      try { child = await repository[`get${type}`](item.id); } catch (error) { if (error.code === "NOT_FOUND") throw new DataError("SNAPSHOT_NOT_READY", "GSI is catching up"); throw error; }
      requireValue(child.workspaceId === workspaceId && child.boardId === board.id, "Foreign child", "OWNERSHIP"); return child;
    }));
    const [tasks, widgets] = await Promise.all([readChildren("Task", repository.listTasks), readChildren("Widget", repository.listWidgets)]);
    requireValue(tasks.length === board.taskCount && widgets.length === board.widgetCount && tasks.filter(task => task.data.status === "doing").length === board.doingCount && board.doingCount <= board.data.wipLimit, "Board counts differ; refresh required", "SNAPSHOT_NOT_READY");
    rows.push(board, ...tasks, ...widgets);
    const widgetsPresence = board.widgetPresence ?? (typeof board.restoreShape?.widgetsPresent === "boolean" ? board.restoreShape.widgetsPresent ? "present" : "absent" : null);
    if (!widgetsPresence || (widgetsPresence === "absent" && widgets.length)) blockers.push({ code: "WIDGET_PRESENCE_REQUIRED", boardId: board.id });
    const checked = await repository.getBoard(board.id); requireValue(checked.version === board.version, "Board changed during read", "SNAPSHOT_NOT_READY");
    return { board: dto(board), tasks: tasks.map(dto), widgets: widgets.map(dto), widgetsPresence };
  }));
  for (const row of rows) {
    try { validateData(row.entityType, row.data); } catch (error) { throw new DataError("INTEGRITY_CONFLICT", "Stored data needs review", { cause: error }); }
    if (row.migrationLock === true) blockers.push({ code: "MIGRATION_LOCKED", id: row.id });
  }
  let migration = null;
  if (root.migrationOwner) {
    requireValue(migrationService, "Migration authority required", "MIGRATION_NOT_READY");
    const session = await migrationService.getSession(root.migrationOwner.migrationId);
    migration = { migrationId: session.migrationId, state: session.state, lockState: session.lockState, version: session.version };
    if (root.migrationReleaseVersion !== 2 || session.state !== "RELEASED" || session.lockState !== "RELEASED" || session.releaseWorkspaceId !== root.id || session.releasedCount !== session.total || session.confirmedCount !== session.total || session.rolledBackCount !== 0) blockers.push({ code: "MIGRATION_NOT_READY" });
    for (const row of rows.filter(row => row.migrationOwner)) {
      requireValue(row.migrationOwner.migrationId === session.migrationId, "Foreign migration owner", "OWNERSHIP");
      const receipt = await migrationService.getOperation(session.migrationId, row.migrationOwner.operationId);
      requireValue(receipt.operation.targetId === row.id && receipt.state === "CONFIRMED" && receipt.releasedAt, "Unreleased receipt", "MIGRATION_NOT_READY");
    }
  } else {
    if (root.viewOrigin !== "api") blockers.push({ code: "WORKSPACE_ORIGIN_REQUIRED" });
    if (rows.some(row => row.migrationOwner)) blockers.push({ code: "MIGRATION_NOT_READY" });
  }
  // All final reads start only after the entire first collection has completed.
  const finalBoards = await Promise.all(entries.map(entry => repository.getBoard(entry.board.id)));
  requireValue(finalBoards.every((board, index) => board.version === entries[index].board.version), "Board changed during snapshot collection", "SNAPSHOT_NOT_READY");
  const after = await repository.getWorkspace(workspaceId); requireValue(after.version === root.version, "Workspace changed during read", "SNAPSHOT_NOT_READY");
  const snapshot = { workspace: dto(root), boards: entries, readiness: { workspaceId, apiReady: true, eligible: blockers.length === 0, blockers, checkedAt: new Date().toISOString(), phase: "api-runtime", migration,
    capabilities: { widgetPresenceWrites: true, subtaskExtensions: true } } };
  if (!blockers.length) {
    try { projectMainView(snapshot, workspaceId); } catch (error) { throw new DataError("INTEGRITY_CONFLICT", "Stored projection needs review", { cause: error }); }
  }
  return snapshot;
}

export function createWorkspaceViewApi({ getRepository, getMigrationService, configuration = () => process.env, isolation = () => false, authorizeWorkspace, cutoverReadiness }) {
  return async (request, context) => {
    try {
      guard(request, configuration()); query(request, []); const { id } = await context.params;
      assertApiId(id, "WORKSPACE");
      const binding = isolation() === true ? null : authorizeWorkspace?.(id);
      requireValue(isolation() === true || binding?.workspaceId === id, "Workspace view is not authorized", "FORBIDDEN");
      const migrationService = getMigrationService ? await getMigrationService() : undefined;
      let boundSession;
      if (binding?.sourceNamespace) {
        requireValue(migrationService, "Missing migration authority", "MIGRATION_NOT_READY");
        try { boundSession = await migrationService.getSession(binding.migrationId); }
        catch (error) { if (error.code === "NOT_FOUND") throw new DataError("MIGRATION_NOT_READY", "Bound migration is unavailable"); throw error; }
        assertReleaseBinding(binding, boundSession);
      }
      const snapshot = await readWorkspaceView(await getRepository(), id, { migrationService });
      if (binding) {
        requireValue(snapshot.readiness.migration?.migrationId === binding.migrationId && snapshot.readiness.migration.state === "RELEASED" && snapshot.readiness.migration.lockState === "RELEASED", "Approved migration is not released", "MIGRATION_NOT_READY");
        if (boundSession) requireValue(snapshot.readiness.migration.version === boundSession.version, "Bound migration changed", "MIGRATION_NOT_READY");
        // Staging reads are allowed for readiness probes; formal UI writes remain separately gated.
        const gate = cutoverReadiness ? await cutoverReadiness(binding, snapshot) : null;
        const enabled = gate?.ready === true && gate.cutoverEnabled === true && gate.migrationId === binding.migrationId && gate.workspaceId === id &&
          gate.sessionVersion === snapshot.readiness.migration.version && Number.isFinite(gate.expiresAt) && gate.expiresAt > Date.now();
        Object.assign(snapshot.readiness.capabilities, { formalCutoverRequired: true, formalCutoverEnabled: enabled, formalCutoverExpiresAt: enabled ? gate.expiresAt : null });
      }
      return Response.json({ data: snapshot }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    } catch (error) {
      const statuses = { VALIDATION: 400, OWNERSHIP: 403, FORBIDDEN: 403, NOT_FOUND: 404, SNAPSHOT_NOT_READY: 409, MIGRATION_NOT_READY: 409, INTEGRITY_CONFLICT: 409 };
      const code = error instanceof DataError && statuses[error.code] ? error.code : "INTERNAL";
      return Response.json({ error: { code, message: code === "INTERNAL" ? "An unexpected server error occurred." : "Workspace view is unavailable or not ready. Refresh after resolving blockers." } }, { status: statuses[code] || 500, headers: { "Cache-Control": "no-store" } });
    }
  };
}
