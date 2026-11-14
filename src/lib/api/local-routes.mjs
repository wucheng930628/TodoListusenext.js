import "server-only";
import { createApi } from "./handlers.mjs";

export function localRoutes(resource) {
  return createApi(resource, { getRepository: async () => {
    const { controlledBinding, controlledEnvironment } = await import("../testing/controlled-environment.mjs");
    if (controlledBinding()) return (await controlledEnvironment()).repository;
    return (await import("../slowly.mjs")).slowly;
  } });
}
