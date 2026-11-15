import { notFound } from "next/navigation";
import { headers } from "next/headers";
import WorkspaceBackupTool from "../../../components/workspace-backup-tool";

export const dynamic = "force-dynamic";
export default async function Page() {
  const host = (await headers()).get("host") || "";
  if (process.env.NODE_ENV !== "development" || !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) notFound();
  return <WorkspaceBackupTool />;
}
