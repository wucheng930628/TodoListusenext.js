import "server-only";
import { DataError, requireValue } from "../data-model.mjs";
import { guard, query, keys, body } from "./handlers.mjs";
import { migrationPlanV2 } from "../migration/plan-v2.mjs";
import { BackupError } from "../client/workspace-backup.mjs";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: "Origin" };
const statuses = { VALIDATION: 400, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, PLAN_CONFLICT: 409, SOURCE_CONFLICT: 409,
  INTEGRITY_CONFLICT: 409, IDEMPOTENCY_KEY_REUSE: 409, SESSION_STATE: 409, DEPENDENCY_CONFLICT: 409, TARGET_CONFLICT: 409,
  WIP_LIMIT: 409, ROLLBACK_CONFLICT: 409, PREVIEW_INVALID: 422, UNSUPPORTED_SCHEMA: 422, PAYLOAD_TOO_LARGE: 413 };
const hashId = value => requireValue(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "Invalid migration identifier");
const json = (data, status = 200) => Response.json({ data }, { status, headers });
function sessionDto(session) {
  return { migrationId: session.migrationId, state: session.state, version: session.version, lockState: session.lockState,
    planFormatVersion: session.planFormatVersion, targetSchemaVersion: session.targetSchemaVersion, sourceRevision: session.sourceRevision,
    total: session.total, registeredCount: session.registeredCount, confirmedCount: session.confirmedCount, rolledBackCount: session.rolledBackCount, releasedCount: session.releasedCount,
    counts: session.counts, createdAt: session.createdAt, updatedAt: session.updatedAt, ...(session.lastError ? { lastError: session.lastError } : {}) };
}
function operationDto(receipt) {
  return { migrationId: receipt.migrationId, operationId: receipt.operation.operationId, targetId: receipt.operation.targetId, type: receipt.operation.type,
    state: receipt.state, fingerprint: receipt.operation.fingerprint, managedVersion: receipt.managedVersion ?? null, writeVersion: receipt.writeVersion ?? null,
    confirmedAt: receipt.confirmedAt ?? null, rolledBackAt: receipt.rolledBackAt ?? null, ...(receipt.lastError ? { lastError: receipt.lastError } : {}) };
}
export function createMigrationApi({ getService, configuration = () => process.env } = {}) {
  const wrap = action => async (request, context = {}) => {
    try { guard(request, configuration()); return await action(request, context); }
    catch (error) {
      const code = error instanceof BackupError ? "PREVIEW_INVALID" : error instanceof DataError && statuses[error.code] ? error.code : "INTERNAL";
      const issues = code === "PREVIEW_INVALID" && Array.isArray(error.cause) ? error.cause : undefined;
      return Response.json({ error: { code, message: code === "INTERNAL" ? "An unexpected server error occurred." : code === "FORBIDDEN" ? "This API is restricted to local development." : code === "PREVIEW_INVALID" ? "Source schema, data or restoration settings are invalid." : error.message,
        ...(issues ? { issues } : {}) } }, { status: statuses[code] || 500, headers });
    }
  };
  async function read(request, allowed) {
    query(request, []);
    const length = request.headers.get("content-length");
    if (length && /^\d+$/.test(length) && Number(length) > 2097152) throw new DataError("PAYLOAD_TOO_LARGE", "Migration request exceeds 2 MiB");
    const input = await body(request, 2097152, "PAYLOAD_TOO_LARGE"); keys(input, allowed); return input;
  }
  async function ids(context, operation = false) {
    const params = await context.params; hashId(params.migrationId);
    if (operation) hashId(params.operationId);
    return params;
  }
  function options(input) {
    requireValue(typeof input.sourceNamespace === "string", "Source namespace required");
    if (input.policies !== undefined) keys(input.policies, ["legacyBoard", "widgets", "timer"]);
    return { sourceNamespace: input.sourceNamespace, policies: input.policies };
  }
  return {
    preview: wrap(async request => {
      const input = await read(request, ["backup", "sourceNamespace", "policies"]);
      const plan = migrationPlanV2(input.backup, options(input));
      return json({ planId: plan.planId, migrationId: plan.migrationId, formatVersion: 2, counts: plan.counts, sourceRevision: plan.sourceRevision, issues: plan.issues,
        operations: plan.operations.map(operation => ({ operationId: operation.operationId, type: operation.type, targetId: operation.targetId, fingerprint: operation.fingerprint, parentId: operation.parentId })) });
    }),
    create: wrap(async request => {
      const input = await read(request, ["backup", "sourceNamespace", "policies", "expectedPlanId"]); hashId(input.expectedPlanId);
      const reviewed = migrationPlanV2(input.backup, options(input));
      requireValue(reviewed.planId === input.expectedPlanId, "Reviewed plan changed", "PLAN_CONFLICT");
      const service = await getService(); let existing;
      try { existing = await service.getSession(input.expectedPlanId); } catch (error) { if (error.code !== "NOT_FOUND") throw error; }
      const session = await service.createSession(input.backup, options(input), input.expectedPlanId);
      return json(sessionDto(session), existing ? 200 : 201);
    }),
    get: wrap(async (request, context) => { query(request, []); const { migrationId } = await ids(context); return json(sessionDto(await (await getService()).getSession(migrationId))); }),
    list: wrap(async (request, context) => {
      const q = query(request, ["cursor", "limit"]); const { migrationId } = await ids(context);
      for (const value of Object.values(q)) requireValue(/^\d+$/.test(value), "Invalid page parameter");
      const page = await (await getService()).listOperations(migrationId, { cursor: Number(q.cursor ?? 0), limit: Number(q.limit ?? 25) });
      return json({ items: page.items.map(operationDto), nextCursor: page.nextCursor });
    }),
    operation: wrap(async (request, context) => { query(request, []); const { migrationId, operationId } = await ids(context, true); return json(operationDto(await (await getService()).getOperation(migrationId, operationId))); }),
    execute: wrap(async (request, context) => {
      const { migrationId, operationId } = await ids(context, true); const input = await read(request, ["expectedPayloadFingerprint"]); hashId(input.expectedPayloadFingerprint);
      const result = await (await getService()).execute(migrationId, operationId, input.expectedPayloadFingerprint);
      return json({ ...operationDto(result.receipt), replayed: result.replayed }, result.replayed ? 200 : 201);
    }),
    verify: wrap(async (request, context) => {
      const { migrationId } = await ids(context); await read(request, []);
      const result = await (await getService()).verify(migrationId);
      return json({ session: sessionDto(result.session), valid: result.valid, counts: result.counts, workspaceHash: result.workspaceHash });
    }),
    rollbackPreview: wrap(async (request, context) => { const { migrationId } = await ids(context); await read(request, []); return json(await (await getService()).rollbackPreview(migrationId)); }),
    rollback: wrap(async (request, context) => {
      const { migrationId } = await ids(context); const input = await read(request, ["expectedSessionVersion", "confirmation"]);
      requireValue(Number.isSafeInteger(input.expectedSessionVersion) && input.expectedSessionVersion >= 1 && input.confirmation === migrationId, "Explicit rollback version and confirmation required");
      return json(sessionDto(await (await getService()).rollback(migrationId, input.expectedSessionVersion, input.confirmation)));
    }),
  };
}
export const localMigrationRoutes = () => createMigrationApi({
  // A controlled UI server must never route a migration to the ordinary table.
  configuration: () => process.env.SLOWLY_CONTROLLED_UI_RUN_ID || process.env.SLOWLY_CONTROLLED_UI_TABLE
    ? { ...process.env, SLOWLY_LOCAL_API: "0" } : process.env,
  getService: async () => (await import("../migration/index.mjs")).migrations,
});
