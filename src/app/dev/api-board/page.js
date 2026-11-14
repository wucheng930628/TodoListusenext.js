import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { guard } from "../../../lib/api/handlers.mjs";
import { controlledBinding, controlledEnvironment } from "../../../lib/testing/controlled-environment.mjs";
import { ControlledApiBoard } from "./view.mjs";

export const dynamic = "force-dynamic";
export default async function Page() {
  if (!controlledBinding()) notFound();
  const incoming = await headers();
  const origin = process.env.SLOWLY_LOCAL_API_ORIGIN || "http://127.0.0.1:3000";
  guard(new Request(`${origin}/dev/api-board`, { headers: incoming }), process.env);
  const { config } = await controlledEnvironment();
  return <ControlledApiBoard config={config} />;
}
