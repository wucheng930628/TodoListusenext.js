import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { guard } from "../../../lib/api/handlers.mjs";
import { controlledBinding } from "../../../lib/testing/controlled-environment.mjs";
import MainUi from "../../main-ui";
export const dynamic = "force-dynamic";
export default async function Page() {
  if (!controlledBinding() || process.env.SLOWLY_MAIN_UI_TEST !== "1") notFound();
  guard(new Request(`${process.env.SLOWLY_LOCAL_API_ORIGIN}/dev/main-api`, { headers: await headers() }), process.env);
  return <MainUi isolationEntry />;
}
