/** Explicit UI preparation policy; never inspects storage, environment or DB. */
export function resolveDataSource({ mode = "localStorage", workspaceId = null, apiReady = false, allowWrites = false } = {}) {
  if (!["localStorage", "api"].includes(mode)) throw new TypeError("Unknown data source mode");
  if (typeof apiReady !== "boolean" || typeof allowWrites !== "boolean") throw new TypeError("Readiness and write permission must be explicit booleans");
  if (mode === "localStorage") return { mode, status: "local-storage", readApi: false, writeApi: false, migrationRequired: false };
  if (typeof workspaceId !== "string" || !workspaceId || !apiReady) return { mode, status: "migration-required", readApi: false, writeApi: false, migrationRequired: true };
  return { mode, status: "api-ready", readApi: true, writeApi: allowWrites, migrationRequired: false };
}
