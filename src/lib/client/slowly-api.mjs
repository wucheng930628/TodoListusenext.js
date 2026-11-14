/** Client-safe HTTP adapter. No React, storage, environment or database imports. */
export class SlowlyApiError extends Error {
  constructor(message, { status = null, code = "NETWORK_ERROR", method, path, outcome = "not-confirmed", cause } = {}) {
    super(message, { cause });
    this.name = "SlowlyApiError";
    Object.assign(this, { status, code, method, path, outcome });
  }
}

/**
 * Returns endpoint DTOs (outer id/version and inner data); deletes return null.
 * fetchImpl is injectable. Requests are always relative, same-origin and single-attempt.
 */
export function createSlowlyApi({ fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  const part = value => {
    if (typeof value !== "string" || !value.length) throw new SlowlyApiError("A nonempty string parameter is required.", { code: "INVALID_ARGUMENT", outcome: "not-sent" });
    return encodeURIComponent(value);
  };
  function url(resource, id, query) {
    const entries = Object.entries(query || {}).filter(([, value]) => value !== undefined);
    const suffix = entries.length ? `?${entries.map(([key, value]) => `${part(key)}=${part(value)}`).join("&")}` : "";
    return `/api/${resource}${id === undefined ? "" : `/${part(id)}`}${suffix}`;
  }
  function itemUrl(resource, id, query) {
    if (id === undefined) throw new SlowlyApiError("An item id is required.", { code: "INVALID_ARGUMENT", outcome: "not-sent" });
    return url(resource, id, query);
  }
  async function request(method, path, input, { signal } = {}) {
    let serialized;
    try { if (input !== undefined) serialized = JSON.stringify(input); }
    catch (cause) { throw new SlowlyApiError("Request cannot be serialized as JSON.", { code: "SERIALIZATION_ERROR", method, path, outcome: "not-sent", cause }); }
    let response;
    try {
      response = await fetchImpl(path, {
        method, headers: { Accept: "application/json", ...(serialized === undefined ? {} : { "Content-Type": "application/json" }) },
        credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", signal,
        ...(serialized === undefined ? {} : { body: serialized }),
      });
    } catch (cause) {
      throw new SlowlyApiError(cause?.name === "AbortError" ? "Request aborted; write outcome may be unknown." : "Network request failed; write outcome may be unknown.", { code: cause?.name === "AbortError" ? "ABORTED" : "NETWORK_ERROR", method, path, cause });
    }
    if (response.status === 204 && response.ok) return null;
    let payload;
    try { payload = await response.json(); }
    catch (cause) { throw new SlowlyApiError("Server returned an invalid JSON response.", { status: response.status, code: "INVALID_JSON_RESPONSE", method, path, cause }); }
    if (!response.ok) {
      const error = payload?.error;
      throw new SlowlyApiError(typeof error?.message === "string" ? error.message : `HTTP ${response.status}`, {
        status: response.status, code: typeof error?.code === "string" ? error.code : "HTTP_ERROR", method, path,
        // A 500 or unreadable response does not prove a mutation was rolled back.
        outcome: response.status < 500 ? "rejected" : "not-confirmed",
      });
    }
    if (!payload || typeof payload !== "object" || !Object.hasOwn(payload, "data")) {
      throw new SlowlyApiError("Server response is missing data.", { status: response.status, code: "INVALID_RESPONSE", method, path });
    }
    return payload.data;
  }
  return {
    listWorkspaces: (query = {}, options) => request("GET", url("workspaces", undefined, query), undefined, options),
    createWorkspace: (input, options) => request("POST", url("workspaces"), input, options),
    getWorkspace: (id, options) => request("GET", itemUrl("workspaces", id), undefined, options),
    getWorkspaceView: (id, options) => request("GET", `${itemUrl("workspaces", id)}/view`, undefined, options),
    updateWorkspace: (id, input, options) => request("PATCH", itemUrl("workspaces", id), input, options),
    listBoards: (query, options) => request("GET", url("boards", undefined, query), undefined, options),
    createBoard: (input, options) => request("POST", url("boards"), input, options),
    getBoard: (id, query = {}, options) => request("GET", itemUrl("boards", id, query), undefined, options),
    updateBoard: (id, input, options) => request("PATCH", itemUrl("boards", id), input, options),
    deleteBoard: (id, input, options) => request("DELETE", itemUrl("boards", id), input, options),
    reorderBoards: (input, options) => request("PATCH", "/api/boards/order", input, options),
    listTasks: (query, options) => request("GET", url("tasks", undefined, query), undefined, options),
    createTask: (input, options) => request("POST", url("tasks"), input, options),
    getTask: (id, query = {}, options) => request("GET", itemUrl("tasks", id, query), undefined, options),
    updateTask: (id, input, options) => request("PATCH", itemUrl("tasks", id), input, options),
    deleteTask: (id, input, options) => request("DELETE", itemUrl("tasks", id), input, options),
    reorderTasks: (input, options) => request("PATCH", "/api/tasks/order", input, options),
    listWidgets: (query, options) => request("GET", url("widgets", undefined, query), undefined, options),
    createWidget: (input, options) => request("POST", url("widgets"), input, options),
    getWidget: (id, query = {}, options) => request("GET", itemUrl("widgets", id, query), undefined, options),
    updateWidget: (id, input, options) => request("PATCH", itemUrl("widgets", id), input, options),
    deleteWidget: (id, input, options) => request("DELETE", itemUrl("widgets", id), input, options),
    reorderWidgets: (input, options) => request("PATCH", "/api/widgets/order", input, options),
  };
}
