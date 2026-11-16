import { SlowlyApiError } from "./slowly-api.mjs";

const names = { workspaces: "Workspace", boards: "Board", tasks: "Task", widgets: "Widget" };

// An intent lives in page memory. Every send uses the frozen original payload and key.
export function createSafeCreateIntent(api, resource, input, { operationKey = crypto.randomUUID() } = {}) {
  const original = structuredClone(input);
  const name = names[resource];
  if (!name) throw new SlowlyApiError("Unsupported create resource.", { code: "INVALID_ARGUMENT", outcome: "not-sent" });
  const scope = resource === "workspaces" ? { resource, scope: "local-workspace-create-v1" }
    : { resource, workspaceId: original.workspaceId, ...(resource === "boards" ? {} : { boardId: original.boardId }) };
  let inFlight;
  let sent = false;
  let confirmed = false;
  let resendSupported = true;
  function send(options = {}) {
    if (inFlight) return inFlight;
    if (sent) throw new SlowlyApiError("Query the receipt and explicitly resend the original intent.", { code: "RECOVERY_REQUIRED", outcome: "not-sent" });
    sent = true;
    inFlight = api[`create${name}`](structuredClone(original), { ...options, operationKey })
      .catch(error => { if (error.code === "UNPROTECTED_CREATE_RESPONSE") resendSupported = false; throw error; })
      .finally(() => { inFlight = null; });
    return inFlight;
  }
  return {
    operationKey, resource, scope: structuredClone(scope),
    exportIntent: () => ({ operationKey, resource, input: structuredClone(original) }),
    send,
    async lookup(options) {
      const result = await api.getOperation(operationKey, scope, { timeoutMs: 30000, ...options });
      if (result.state === "CONFIRMED") {
        if (result.operationId !== operationKey || result.resource !== resource || !result.targetId || result.result?.id !== result.targetId ||
          (resource !== "workspaces" && result.workspaceId !== original.workspaceId) ||
          (["tasks", "widgets"].includes(resource) && result.boardId !== original.boardId)) {
          throw new SlowlyApiError("Receipt scope or result does not match.", { code: "INVALID_RECEIPT" });
        }
        confirmed = true;
      } else if (result.state !== "NOT_FOUND") throw new SlowlyApiError("Receipt result is unknown.", { code: "INVALID_RECEIPT" });
      return result;
    },
    resend(options) {
      if (!resendSupported) throw new SlowlyApiError("This server did not confirm safe-create support. Resending is disabled.", { code: "IDEMPOTENCY_UNAVAILABLE", outcome: "not-sent" });
      if (confirmed) throw new SlowlyApiError("Create is already confirmed. Reload current data.", { code: "ALREADY_CONFIRMED", outcome: "not-sent" });
      if (inFlight) return inFlight;
      sent = false;
      return send(options);
    },
  };
}
