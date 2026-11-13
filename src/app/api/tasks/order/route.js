import { localRoutes } from "@/lib/api/local-routes.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handlers = localRoutes("tasks");
export const PATCH = handlers.orderPatch;
