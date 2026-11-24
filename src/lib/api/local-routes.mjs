import "server-only";
import { createApi } from "./handlers.mjs";
import { requireValue } from "../data-model.mjs";
import { createLocalDocumentClient } from "../local-dynamodb.mjs";
import { isolatedTaskCreateRoutes } from "./isolated-task-create.mjs";
import { controlledBinding, controlledEnvironment } from "../testing/controlled-environment.mjs";

export function localRoutes(resource) {
  const handlers = createApi(resource, { getRepository: async () => {
    requireValue(!process.env.SLOWLY_PHASE5_B1_TABLE, "Only isolated operations are enabled", "FORBIDDEN");
    if (controlledBinding()) return (await controlledEnvironment()).repository;
    return (await import("../slowly.mjs")).slowly;
  } });
  if (!["tasks", "boards", "widgets", "workspaces"].includes(resource)) return handlers;
  const isolatedWrite = (action, controlledHandler) => async (request, context) => {
    if (process.env.SLOWLY_PHASE5_B1_TABLE) return isolatedTaskRoute(action, request, context);
    if (process.env.SLOWLY_CONTROLLED_UI_TABLE || process.env.SLOWLY_CONTROLLED_UI_RUN_ID) return controlledHandler(request, context);
    return Response.json({ error: { code: "FORBIDDEN", message: "Write requires an isolated authorization scope." } },
      { status: 403, headers: { "Cache-Control": "no-store" } });
  };
  if (resource === "workspaces") return { ...handlers,
    collectionPost: (request, context) => process.env.SLOWLY_PHASE5_B1_TABLE ? isolatedTaskRoute("workspacePost", request, context) : handlers.collectionPost(request, context),
    itemPatch: (request, context) => process.env.SLOWLY_PHASE5_B1_TABLE ? isolatedTaskRoute("workspacePatch", request, context) : handlers.itemPatch(request, context),
    itemDelete: (request, context) => process.env.SLOWLY_PHASE5_B1_TABLE ? isolatedTaskRoute("workspaceDelete", request, context) : handlers.itemDelete(request, context) };
  if (resource === "boards") return { ...handlers, collectionPost: isolatedWrite("boardPost", handlers.collectionPost),
    itemPatch: isolatedWrite("boardPatch", handlers.itemPatch), itemDelete: isolatedWrite("boardDelete", handlers.itemDelete),
    orderPatch: isolatedWrite("boardOrder", handlers.orderPatch) };
  if (resource === "widgets") return { ...handlers, collectionPost: isolatedWrite("widgetPost", handlers.collectionPost),
    itemPatch: isolatedWrite("widgetPatch", handlers.itemPatch), itemDelete: isolatedWrite("widgetDelete", handlers.itemDelete),
    orderPatch: isolatedWrite("widgetOrder", handlers.orderPatch) };
  return { ...handlers, collectionPost: isolatedWrite("post", handlers.collectionPost),
    itemPatch: isolatedWrite("patch", handlers.itemPatch), itemDelete: isolatedWrite("delete", handlers.itemDelete) };
}

export async function isolatedTaskRoute(action, request, context) {
  const db = createLocalDocumentClient();
  try { return await isolatedTaskCreateRoutes({ db })[action](request, context); }
  finally { db.destroy(); }
}
