import { createOperationApi } from "@/lib/api/operations.mjs";
import { controlledBinding, controlledEnvironment } from "@/lib/testing/controlled-environment.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createOperationApi({ getRepository: async () => controlledBinding()
  ? (await controlledEnvironment()).repository
  : (await import("@/lib/slowly.mjs")).slowly });
