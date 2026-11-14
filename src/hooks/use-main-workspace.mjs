"use client";
import { useMemo, useSyncExternalStore } from "react";
import { createMainWorkspaceController } from "../lib/client/main-workspace-controller.mjs";

export function useMainWorkspace(options) {
  const controller = useMemo(() => createMainWorkspaceController(options), [options]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  return { ...state, controller };
}
