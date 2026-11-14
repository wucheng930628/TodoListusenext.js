import { localMigrationRoutes } from "@/lib/api/migrations.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = localMigrationRoutes().release;
