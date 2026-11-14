/** Form-only state. API writes are provided by existing versioned resource actions. */
export function createAsyncDraftController() {
  let state = { scope: null, draft: null, status: "idle", error: null }; let epoch = 0; let edits = 0; let pending = false;
  const listeners = new Set();
  const publish = patch => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => state, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    open(scope, draft) { epoch++; edits++; publish({ scope, draft: structuredClone(draft), status: "editing", error: null }); },
    edit(draft) { edits++; publish({ draft: structuredClone(draft) }); },
    cancel() { epoch++; publish({ status: pending ? "not-confirmed" : "editing", error: null }); },
    async save(write) {
      if (pending || !state.draft) throw new Error("A draft and no pending write are required");
      pending = true; const current = epoch; const revision = edits; const draft = structuredClone(state.draft);
      publish({ status: "saving", error: null });
      try {
        const result = await write(draft);
        if (epoch === current) publish({ status: edits === revision ? "success" : "editing", error: null });
        return result;
      } catch (error) {
        if (epoch === current) publish({ status: error.status === 409 ? "conflict" : error.outcome === "not-confirmed" ? "not-confirmed" : "error", error });
        throw error;
      } finally { pending = false; }
    },
  };
}
