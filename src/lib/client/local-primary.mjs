// Read only after the user opens the local UI. Never restores Legacy or writes storage.
export function readLocalPrimary(storage) {
  const raw = storage.getItem("slowly-workspace-v2");
  if (raw !== null) return { raw, legacyBlocked: false };
  return { raw: null, legacyBlocked: storage.getItem("slowly-board-v1") !== null };
}
