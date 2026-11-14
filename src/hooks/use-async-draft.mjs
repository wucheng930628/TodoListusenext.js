"use client";
import { useMemo, useSyncExternalStore } from "react";
import { createAsyncDraftController } from "../lib/client/async-draft.mjs";

// Independent preparation hook; no homepage integration and no write effect.
export function useAsyncDraft() {
  const controller = useMemo(() => createAsyncDraftController(), []);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return { ...state, open: controller.open, edit: controller.edit, cancel: controller.cancel, save: controller.save };
}
