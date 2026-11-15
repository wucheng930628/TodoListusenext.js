import "server-only";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { createLocalDocumentClient } from "../local-dynamodb.mjs";
import { createRepository } from "../slowly-repository.mjs";
import { requireValue } from "../data-model.mjs";

export function controlledBinding(env = process.env) {
  const runId = env.SLOWLY_CONTROLLED_UI_RUN_ID;
  const tableName = env.SLOWLY_CONTROLLED_UI_TABLE;
  const phase = env.SLOWLY_MAIN_UI_TEST === "1" ? "Phase4C2" : "Phase4B2";
  if (!runId && !tableName) return null;
  requireValue(env.NODE_ENV === "development" && env.SLOWLY_LOCAL_API === "1" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId || "") && tableName === `Slowly_${phase}_${runId.replaceAll("-", "")}` &&
    (env.DYNAMODB_ENDPOINT || "http://127.0.0.1:9000") === "http://127.0.0.1:9000", "Invalid controlled test binding", "FORBIDDEN");
  return { runId, tableName };
}

// The proof and every resource live in a dedicated table, never SlowlyTasks.
export async function controlledEnvironment() {
  const binding = controlledBinding();
  requireValue(binding, "Controlled environment is not enabled", "FORBIDDEN");
  const client = createLocalDocumentClient();
  const { Item: proof } = await client.send(new GetCommand({ TableName: binding.tableName, Key: { id: `CONTROLLED_UI_ENV#${binding.runId}` }, ConsistentRead: true }));
  requireValue(proof?.entityType === "CONTROLLED_UI_TEST" && proof.runId === binding.runId && Array.isArray(proof.workspaceIds) && proof.workspaceIds.length > 0, "Missing fixture proof", "FORBIDDEN");
  const repository = createRepository(client, { tableName: binding.tableName });
  const workspaces = await Promise.all(proof.workspaceIds.map(id => repository.getWorkspace(id)));
  requireValue(workspaces.every(item => item.data.settings?.controlledUiTestRun === binding.runId), "Invalid fixture ownership", "FORBIDDEN");
  const own = item => { requireValue(proof.workspaceIds.includes(item.entityType === "WORKSPACE" ? item.id : item.workspaceId), "Not a test workspace", "OWNERSHIP"); return item; };
  const protectedRepository = new Proxy(repository, { get(target, name) {
    const fn = target[name];
    if (typeof fn !== "function") return fn;
    return async (...args) => {
      const mainUi = process.env.SLOWLY_MAIN_UI_TEST === "1";
      requireValue(!["createWorkspace", "saveWorkspace", ...(!mainUi ? ["createBoard", "updateBoard", "deleteBoard", "reorderBoards"] : [])].includes(name), "Fixture structure is read-only", "FORBIDDEN");
      if (["createOnce", "getOperation"].includes(name)) {
        const resource = name === "createOnce" ? args[0] : args[1].resource;
        const scope = args[1];
        requireValue(["tasks", "widgets", ...(mainUi ? ["boards"] : [])].includes(resource), "Unsupported controlled create scope", "FORBIDDEN");
        if (name === "createOnce" && resource !== "boards") own(await target.getBoard(scope.boardId));
        else own(await target.getWorkspace(scope.workspaceId));
      }
      else if (["getWorkspace", "listBoards", "createBoard", "reorderBoards"].includes(name)) own(await target.getWorkspace(args[0]));
      else if (["getBoard", "updateBoard", "deleteBoard", "listTasks", "listWidgets", "createTask", "updateTask", "deleteTask", "setTaskStatus", "createWidget", "updateWidget", "deleteWidget", "reorderTasks", "reorderWidgets"].includes(name)) own(await target.getBoard(args[0]));
      else if (name === "getTask") own(await target.getTask(args[0]));
      else if (name === "getWidget") own(await target.getWidget(args[0]));
      else requireValue(false, "Unsupported controlled operation", "FORBIDDEN");
      return fn(...args);
    };
  } });
  return { repository: protectedRepository, config: { runId: binding.runId, allowedWorkspaces: workspaces.map(item => ({ id: item.id, name: item.id })), boardWidgetPresence: proof.boardWidgetPresence || {} } };
}
