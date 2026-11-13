import { localRoutes } from "@/lib/api/local-routes.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handlers = localRoutes("widgets");
export const GET = handlers.collectionGet;
export const POST = handlers.collectionPost;
