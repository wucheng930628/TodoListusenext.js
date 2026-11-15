"use client";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createSlowlyApi, SlowlyApiError } from "../lib/client/slowly-api.mjs";
import { createResourceController, resourceScopeKey } from "../lib/client/resource-controller.mjs";

const defaultApi = createSlowlyApi(); // No request at module import.
function useResource(resource, { api = defaultApi, mode = "localStorage", workspaceId = null, boardId = null, apiReady = false, allowWrites = false } = {}) {
  const controller = useMemo(() => createResourceController(resource, api), [resource, api]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  const key = resourceScopeKey({ mode, workspaceId, boardId, apiReady, allowWrites });
  useEffect(() => {
    // Error is stored in the controller; avoid unhandled rejections for reads.
    void controller.select({ mode, workspaceId, boardId, apiReady, allowWrites }).catch(() => {});
    return () => controller.cancel();
  }, [controller, mode, workspaceId, boardId, apiReady, allowWrites]);
  const actions = useMemo(() => Object.fromEntries(["refresh", "cancel", "create", "update", "remove", "reorder", "recoverCreate", "resendCreate"].map(name => [name, (...args) => {
    if (controller.getSnapshot().scopeKey !== key) throw new SlowlyApiError("This callback belongs to an older resource scope.", { code: "STALE_SCOPE", outcome: "not-sent" });
    return controller[name](...args);
  }])), [controller, key]);
  const visible = state.scopeKey === key ? state : { ...controller.getServerSnapshot(), data: resource === "workspace" ? null : [] };
  return { ...visible, loading: visible.status === "loading", success: visible.status === "success", ...actions };
}
export const useSlowlyWorkspace = options => useResource("workspace", options);
export const useSlowlyBoards = options => useResource("boards", options);
export const useSlowlyTasks = options => useResource("tasks", options);
export const useSlowlyWidgets = options => useResource("widgets", options);
