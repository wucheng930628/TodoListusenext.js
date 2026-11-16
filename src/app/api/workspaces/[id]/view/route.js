import { createWorkspaceViewApi } from "@/lib/api/workspace-view.mjs";
import { controlledBinding, controlledEnvironment } from "@/lib/testing/controlled-environment.mjs";
import { createMigrationService } from "@/lib/migration/service.mjs";
import { createLocalDocumentClient } from "@/lib/local-dynamodb.mjs";
import { formalWorkspaceBinding } from "@/lib/api/formal-workspace.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createWorkspaceViewApi({
  authorizeWorkspace: id => formalWorkspaceBinding(id),
  isolation: () => Boolean(controlledBinding() && process.env.SLOWLY_MAIN_UI_TEST === "1"),
  getRepository: async () => controlledBinding() ? (await controlledEnvironment()).repository : (await import("@/lib/slowly.mjs")).slowly,
  getMigrationService: async () => createMigrationService(createLocalDocumentClient(), { tableName: controlledBinding()?.tableName || "SlowlyTasks" }),
});
