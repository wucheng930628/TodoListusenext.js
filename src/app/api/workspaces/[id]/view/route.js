import { createWorkspaceViewApi } from "@/lib/api/workspace-view.mjs";
import { controlledBinding, controlledEnvironment } from "@/lib/testing/controlled-environment.mjs";
import { createMigrationService } from "@/lib/migration/service.mjs";
import { createLocalDocumentClient } from "@/lib/local-dynamodb.mjs";
import { formalWorkspaceBinding } from "@/lib/api/formal-workspace.mjs";
import { formalCutoverEvidence } from "@/lib/api/formal-evidence.mjs";
import { isolatedTaskRoute } from "@/lib/api/local-routes.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const get = createWorkspaceViewApi({
  authorizeWorkspace: id => formalWorkspaceBinding(id),
  cutoverReadiness: formalCutoverEvidence,
  isolation: () => Boolean(controlledBinding() && process.env.SLOWLY_MAIN_UI_TEST === "1"),
  getRepository: async () => controlledBinding() ? (await controlledEnvironment()).repository : (await import("@/lib/slowly.mjs")).slowly,
  getMigrationService: async () => createMigrationService(createLocalDocumentClient(), { tableName: controlledBinding()?.tableName || "SlowlyTasks" }),
});
export const GET = (request, context) => process.env.SLOWLY_PHASE5_B1_TABLE
  ? isolatedTaskRoute("view", request, context) : get(request, context);
