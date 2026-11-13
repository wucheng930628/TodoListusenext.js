import "server-only";
import { createApi } from "./handlers.mjs";

export function localRoutes(resource) {
  return createApi(resource, { getRepository: async () => (await import("../slowly.mjs")).slowly });
}
