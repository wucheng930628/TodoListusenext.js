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
    const tables = command.input.TransactItems?.map(action => (action.Put || action.Delete || action.ConditionCheck)?.TableName) ?? [command.input.TableName];
    requireValue(["GetCommand", "QueryCommand", "ScanCommand", "TransactWriteCommand"].includes(command.constructor.name) &&
      tables.length > 0 && tables.every(name => name === tableName), "Outside isolated Task Create storage", "FORBIDDEN");
    return db.send(command);
  } };
  const store = migrationStore(restricted, tableName);
  const getRepository = () => createRepository(restricted, { tableName });
  async function authorizeWrite(requestedWorkspace, action = "CREATE", resource = "tasks", operationKey) {
    const workspaceLifecycle = resource === "workspaces";
    const descendant = requestedWorkspace !== workspaceId;
    requireValue(env.NODE_ENV === "development" && env.SLOWLY_LOCAL_API === "1" &&
      env.SLOWLY_FORMAL_VIEW_ENABLED !== "1" && !env.SLOWLY_CONTROLLED_UI_TABLE && !env.SLOWLY_CONTROLLED_UI_RUN_ID &&
      !env.SLOWLY_MAIN_UI_TEST && env.DYNAMODB_ENDPOINT === "http://127.0.0.1:9000" &&
      /^Slowly_Phase5B1_[a-f0-9]{32}$/.test(tableName || "") &&
      /^[a-f0-9]{64}$/.test(migrationId || "") &&
      /^[a-zA-Z0-9._-]{8,128}$/.test(sourceNamespace || ""),
    "Task Create scope is unavailable", "FORBIDDEN");
    const grant = await store.get(`SLOWLY#TASK_CREATE_GRANT#${workspaceId}`);
    function requireActiveGrant() {
      requireValue(grant?.entityType === "TASK_CREATE_GRANT" && grant.state === "ACTIVE" &&
        grant.workspaceId === workspaceId && grant.migrationId === migrationId && grant.planId === migrationId &&
        grant.sourceNamespace === sourceNamespace && Number.isSafeInteger(grant.version) &&
        Number.isSafeInteger(grant.expiresAt) && grant.expiresAt > now() &&
        (!descendant || workspaceLifecycle || grant.childWorkspaceWrites === true) &&
        (workspaceLifecycle ? Array.isArray(grant.workspaceMutations) && (action === null ? grant.workspaceMutations.length > 0 : grant.workspaceMutations.includes(action))
          : resource === "widgets" ? Array.isArray(grant.widgetMutations) && (action === null ? grant.widgetMutations.length > 0 : grant.widgetMutations.includes(action))
          : resource === "boards" ? Array.isArray(grant.boardMutations) && (action === null ? grant.boardMutations.length > 0 : grant.boardMutations.includes(action))
          : action === "CREATE" || Array.isArray(grant.taskMutations) && grant.taskMutations.includes(action)),
      "Workspace write grant is unavailable", "FORBIDDEN");
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
    let target = workspace;
    if (descendant) {
      target = await store.get(requestedWorkspace);
      if (!target) {
        const receipt = operationKey && await store.get(`SLOWLY#CRUD_OPERATION#${operationKey}`);
        requireValue(workspaceLifecycle && receipt?.entityType === "CRUD_OPERATION" && receipt.state === "CONFIRMED" && receipt.resource === "workspaces" &&
          ["UPDATE", "DELETE"].includes(receipt.action) && (action === null || receipt.action === action) &&
          receipt.targetId === requestedWorkspace && receipt.workspaceGrantId === grant.id, "Workspace not found", "NOT_FOUND");
      } else {
        requireValue(target.entityType === "WORKSPACE" && target.workspaceGrantId === grant.id, "Workspace scope differs", "FORBIDDEN");
        requireValue(target.migrationLock !== true, "Migration lock is held", "MIGRATION_LOCKED");
      }
    }
    const { id, entityType, version, state, lockState, releaseVerificationHash } = session;
    return { workspaceId: requestedWorkspace, workspaceVersion: target?.version, workspaceGrantId: grant.id, transactionChecks() {
      requireActiveGrant();
      const checks = [store.check(grant), store.check({ id, entityType, version, state, lockState, releaseVerificationHash })];
      if (descendant || workspaceLifecycle && action === "CREATE") {
        checks.push(store.check({ id: workspace.id, entityType: workspace.entityType, version: workspace.version,
          ...(Object.hasOwn(workspace, "migrationLock") ? { migrationLock: workspace.migrationLock } : {}) }));
      }
      return checks;
    } };
  }
  const tasks = createApi("tasks", { configuration, getRepository, authorizeCreate: authorizeWrite, authorizeMutation: authorizeWrite });
  const boards = createApi("boards", { configuration, getRepository,
    authorizeCreate: id => authorizeWrite(id, "CREATE", "boards"),
    authorizeMutation: (id, action) => authorizeWrite(id, action, "boards") });
  const widgets = createApi("widgets", { configuration, getRepository,
    authorizeCreate: id => authorizeWrite(id, "CREATE", "widgets"),
    authorizeMutation: (id, action) => authorizeWrite(id, action, "widgets") });
  const workspaces = createApi("workspaces", { configuration, getRepository,
    authorizeCreate: () => authorizeWrite(workspaceId, "CREATE", "workspaces"),
    authorizeMutation: (id, action, key) => authorizeWrite(id, action, "workspaces", key) });
  return {
    post: tasks.collectionPost, patch: tasks.itemPatch, delete: tasks.itemDelete, taskOrder: tasks.orderPatch,
    boardPost: boards.collectionPost, boardPatch: boards.itemPatch, boardDelete: boards.itemDelete, boardOrder: boards.orderPatch,
    widgetPost: widgets.collectionPost, widgetPatch: widgets.itemPatch, widgetDelete: widgets.itemDelete, widgetOrder: widgets.orderPatch,
    workspacePost: workspaces.collectionPost, workspacePatch: workspaces.itemPatch, workspaceDelete: workspaces.itemDelete,
    view: createWorkspaceViewApi({ configuration, getRepository, isolation: () => true,
      authorizeRead: id => id === workspaceId ? authorizeWrite(id) : authorizeWrite(id, null, "workspaces"),
      isolatedCapabilities: env.SLOWLY_PHASE5_D2_UI === "1" ? { isolatedMutationReceipts: true } : undefined,
      getMigrationService: () => createMigrationService(restricted, { tableName }) }),
    receipt: createOperationApi({ configuration, getRepository, async authorizeScope(scope, key) {
      if (scope.resource === "workspaces") {
        const authority = await authorizeWrite(scope.workspaceId ?? workspaceId, null, "workspaces", key);
        return scope.workspaceId === workspaceId ? {} : { workspaceGrantId: authority.workspaceGrantId };
      }
      await authorizeWrite(scope.workspaceId, scope.resource === "tasks" ? "CREATE" : null, scope.resource);
    } }),
  };
}
