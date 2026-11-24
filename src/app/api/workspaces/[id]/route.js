import { localRoutes } from "@/lib/api/local-routes.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handlers = localRoutes("workspaces");
export const GET = handlers.itemGet;
export const PATCH = handlers.itemPatch;
export const DELETE = handlers.itemDelete;
