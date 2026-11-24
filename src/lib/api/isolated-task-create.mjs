import "server-only";
import { DataError, requireValue } from "../data-model.mjs";
import { createRepository } from "../slowly-repository.mjs";
import { migrationStore } from "../migration/store.mjs";
import { assertReleaseBinding } from "./formal-workspace.mjs";
import { createApi } from "./handlers.mjs";
import { createOperationApi } from "./operations.mjs";
import { createWorkspaceViewApi } from "./workspace-view.mjs";
import { createMigrationService } from "../migration/service.mjs";

export function isolatedTaskCreateRoutes({ db, configuration = () => process.env, now = Date.now }) {
  const env = configuration();
  const tableName = env.SLOWLY_PHASE5_B1_TABLE;
  const workspaceId = env.SLOWLY_PHASE5_B1_WORKSPACE;
  const migrationId = env.SLOWLY_PHASE5_B1_PLAN;
  const sourceNamespace = env.SLOWLY_PHASE5_B1_SOURCE_NAMESPACE;
  const restricted = { send(command) {
    const tables = command.input.TransactItems?.map(action => (action.Put || action.ConditionCheck)?.TableName) ?? [command.input.TableName];
    requireValue(["GetCommand", "QueryCommand", "TransactWriteCommand"].includes(command.constructor.name) &&
      tables.length > 0 && tables.every(name => name === tableName), "Outside isolated Task Create storage", "FORBIDDEN");
    return db.send(command);
  } };
  const store = migrationStore(restricted, tableName);
  const getRepository = () => createRepository(restricted, { tableName });
  async function authorizeTaskCreate(requestedWorkspace) {
    requireValue(env.NODE_ENV === "development" && env.SLOWLY_LOCAL_API === "1" &&
      env.SLOWLY_FORMAL_VIEW_ENABLED !== "1" && !env.SLOWLY_CONTROLLED_UI_TABLE && !env.SLOWLY_CONTROLLED_UI_RUN_ID &&
      !env.SLOWLY_MAIN_UI_TEST && env.DYNAMODB_ENDPOINT === "http://127.0.0.1:9000" &&
      /^Slowly_Phase5B1_[a-f0-9]{32}$/.test(tableName || "") &&
      requestedWorkspace === workspaceId && /^[a-f0-9]{64}$/.test(migrationId || "") &&
      /^[a-zA-Z0-9._-]{8,128}$/.test(sourceNamespace || ""),
    "Task Create scope is unavailable", "FORBIDDEN");
    const grant = await store.get(`SLOWLY#TASK_CREATE_GRANT#${workspaceId}`);
    function requireActiveGrant() {
      requireValue(grant?.entityType === "TASK_CREATE_GRANT" && grant.state === "ACTIVE" &&
        grant.workspaceId === workspaceId && grant.migrationId === migrationId && grant.planId === migrationId &&
        grant.sourceNamespace === sourceNamespace && Number.isSafeInteger(grant.version) &&
        Number.isSafeInteger(grant.expiresAt) && grant.expiresAt > now(), "Task Create grant is unavailable", "FORBIDDEN");
    }
    requireActiveGrant();
    const workspace = await store.get(workspaceId);
    requireValue(workspace?.entityType === "WORKSPACE" && workspace.schemaVersion === 1, "Workspace not found", "NOT_FOUND");
    const session = await store.get(`SLOWLY#MIGRATION_SESSION#${migrationId}`);
    requireValue(workspace.migrationLock !== true && session?.lockState !== "HELD", "Migration lock is held", "MIGRATION_LOCKED");
    try { assertReleaseBinding({ workspaceId, migrationId, sourceNamespace }, session); }
    catch { throw new DataError("FORBIDDEN", "Release binding differs"); }
    requireValue(workspace.migrationOwner?.migrationId === migrationId && workspace.migrationReleaseVersion === 2 &&
      session.version === grant.sessionVersion && session.verifiedAt && session.releasedAt &&
      Number.isSafeInteger(session.total) && session.total > 0 && session.confirmedCount === session.total &&
      session.releasedCount === session.total && session.rolledBackCount === 0 && /^[a-f0-9]{64}$/.test(grant.releaseHash || "") &&
      session.releaseVerificationHash === grant.releaseHash, "Task Create release differs", "FORBIDDEN");
    requireActiveGrant();
    const { id, entityType, version, state, lockState, releaseVerificationHash } = session;
    return { workspaceId, workspaceVersion: workspace.version, transactionChecks() {
      requireActiveGrant();
      return [store.check(grant), store.check({ id, entityType, version, state, lockState, releaseVerificationHash })];
    } };
  }
  return {
    post: createApi("tasks", { configuration, getRepository, authorizeTaskCreate }).collectionPost,
    view: createWorkspaceViewApi({ configuration, getRepository, isolation: () => true,
      authorizeRead: authorizeTaskCreate, getMigrationService: () => createMigrationService(restricted, { tableName }) }),
    receipt: createOperationApi({ configuration, getRepository, async authorizeScope(scope) {
      requireValue(scope.resource === "tasks", "Only Task receipts are authorized", "FORBIDDEN");
      await authorizeTaskCreate(scope.workspaceId);
    } }),
  };
}
