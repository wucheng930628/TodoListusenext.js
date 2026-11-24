import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { guard } from "../../../lib/api/handlers.mjs";
import { controlledBinding } from "../../../lib/testing/controlled-environment.mjs";
import MainUi from "../../main-ui";
export const dynamic = "force-dynamic";
export default async function Page() {
  const writeFixture = process.env.SLOWLY_PHASE5_D2_UI === "1" && process.env.SLOWLY_FORMAL_VIEW_ENABLED !== "1" &&
    !process.env.SLOWLY_CONTROLLED_UI_TABLE && !process.env.SLOWLY_CONTROLLED_UI_RUN_ID &&
    /^Slowly_Phase5B1_[a-f0-9]{32}$/.test(process.env.SLOWLY_PHASE5_B1_TABLE || "") &&
    process.env.DYNAMODB_ENDPOINT === "http://127.0.0.1:9000";
  if (!writeFixture && (!controlledBinding() || process.env.SLOWLY_MAIN_UI_TEST !== "1")) notFound();
  guard(new Request(`${process.env.SLOWLY_LOCAL_API_ORIGIN}/dev/main-api`, { headers: await headers() }), process.env);
  return <MainUi isolationEntry isolatedWriteFixture={writeFixture} />;
}
