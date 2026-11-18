import "server-only";
import { requireValue } from "../data-model.mjs";
import { hash } from "../migration/plan-v2.mjs";

export function assertReleaseBinding(binding, session) {
  requireValue(session?.migrationId === binding.migrationId && session.releaseWorkspaceId === binding.workspaceId &&
    session.state === "RELEASED" && session.lockState === "RELEASED" && session.releaseProtocolVersion === 2 &&
    session.sourceIdentity?.sourceNamespace === binding.sourceNamespace &&
    session.sourceId === `SLOWLY#MIGRATION_SOURCE#${hash(binding.sourceNamespace)}`,
  "Released Workspace does not match the configured source", "MIGRATION_NOT_READY");
}

// Server-only opt-in. No browser parameter can select a table or authorize a Workspace.
export function formalWorkspaceBinding(workspaceId, env = process.env) {
  requireValue(env.NODE_ENV === "development" && env.SLOWLY_LOCAL_API === "1" && env.SLOWLY_FORMAL_VIEW_ENABLED === "1" &&
    !env.SLOWLY_CONTROLLED_UI_TABLE && !env.SLOWLY_CONTROLLED_UI_RUN_ID && !env.SLOWLY_MAIN_UI_TEST &&
    (env.DYNAMODB_ENDPOINT || "http://127.0.0.1:9000") === "http://127.0.0.1:9000" &&
    /^SLOWLY#WORKSPACE#[a-f0-9-]{36}$/.test(env.SLOWLY_FORMAL_VIEW_WORKSPACE || "") &&
    /^[a-f0-9]{64}$/.test(env.SLOWLY_FORMAL_VIEW_PLAN || "") &&
    /^[a-zA-Z0-9._-]{8,128}$/.test(env.SLOWLY_FORMAL_VIEW_SOURCE_NAMESPACE || "") && workspaceId === env.SLOWLY_FORMAL_VIEW_WORKSPACE,
  "Formal Workspace view is disabled or outside the approved scope", "FORBIDDEN");
  return { workspaceId, migrationId: env.SLOWLY_FORMAL_VIEW_PLAN, sourceNamespace: env.SLOWLY_FORMAL_VIEW_SOURCE_NAMESPACE };
}
