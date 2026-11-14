import { localMigrationRoutes } from "@/lib/api/migrations.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handlers = localMigrationRoutes();
export const POST = handlers.verify;
