import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { controlledBinding, controlledEnvironment } from "../../../lib/testing/controlled-environment.mjs";
import { guard } from "../../../lib/api/handlers.mjs";
import BrowserAcceptance from "./suite";
export const dynamic = "force-dynamic";
export default async function Page() {
  const binding = controlledBinding();
  if (!binding || process.env.SLOWLY_MAIN_UI_TEST !== "1" || process.env.SLOWLY_BROWSER_ACCEPTANCE_RUN_ID !== binding.runId) notFound();
  guard(new Request(`${process.env.SLOWLY_LOCAL_API_ORIGIN}/dev/browser-acceptance`, { headers: await headers() }), process.env);
  const environment = await controlledEnvironment();
  return <BrowserAcceptance runId={binding.runId} workspaceIds={environment.config.allowedWorkspaces.map(item => item.id)} />;
}
