import { createOperationApi } from "@/lib/api/operations.mjs";
import { controlledBinding, controlledEnvironment } from "@/lib/testing/controlled-environment.mjs";
import { isolatedTaskRoute } from "@/lib/api/local-routes.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const get = createOperationApi({ getRepository: async () => controlledBinding()
  ? (await controlledEnvironment()).repository
  : (await import("@/lib/slowly.mjs")).slowly });
export const GET = (request, context) => process.env.SLOWLY_PHASE5_B1_TABLE
  ? isolatedTaskRoute("receipt", request, context) : get(request, context);
