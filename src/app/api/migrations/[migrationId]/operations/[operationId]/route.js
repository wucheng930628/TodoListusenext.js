import { localMigrationRoutes } from "@/lib/api/migrations.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handlers = localMigrationRoutes();
export const GET = handlers.operation;
export const PUT = handlers.execute;
