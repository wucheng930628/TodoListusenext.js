import { releaseFixture } from "./release-fixture.mjs";
import { workspaceFixture } from "../phase4a-fixtures.mjs";
import { createApi } from "../../src/lib/api/handlers.mjs";
import { createWorkspaceViewApi } from "../../src/lib/api/workspace-view.mjs";
import { createSlowlyApi } from "../../src/lib/client/slowly-api.mjs";
import { createMainWorkspaceController } from "../../src/lib/client/main-workspace-controller.mjs";

export async function mainUiFixture(options = {}) {
  const f = releaseFixture({ ...options, data: options.data || workspaceFixture() }); await f.apply(); await f.finish();
  const configuration = () => ({ NODE_ENV: "development", SLOWLY_LOCAL_API: "1" });
  const handlers = Object.fromEntries(["workspaces", "boards", "tasks", "widgets"].map(resource => [resource, createApi(resource, { getRepository: async () => f.repository, configuration })]));
  const view = createWorkspaceViewApi({ getRepository: async () => f.repository, getMigrationService: async () => f.service, isolation: () => true, configuration });
  const calls = []; let failure = null;
  const fetchImpl = async (path, init) => {
    calls.push({ path, method: init.method });
    if (failure === "before" && init.method !== "GET") { failure = null; throw new TypeError("offline"); }
    const url = new URL(path, "http://127.0.0.1:3000"); const [, , resource, encoded, child] = url.pathname.split("/"); const id = encoded && decodeURIComponent(encoded);
    const request = new Request(url, { ...init, headers: { ...init.headers, host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } }); const context = { params: Promise.resolve({ id }) };
    const name = id === "order" ? "orderPatch" : !id ? { GET: "collectionGet", POST: "collectionPost" }[init.method] : { GET: "itemGet", PATCH: "itemPatch", DELETE: "itemDelete" }[init.method];
    const response = await (child === "view" ? view(request, context) : handlers[resource][name](request, context));
    if (failure === "after" && init.method !== "GET") { failure = null; throw new TypeError("response lost"); }
    return response;
  };
  const api = createSlowlyApi({ fetchImpl }); const controller = createMainWorkspaceController({ api, development: true }); const workspaceId = f.plan.operations[0].targetId;
  return { ...f, api, controller, workspaceId, fetchImpl, calls, failNextWrite(mode = "before") { failure = mode; },
    async activate() { await controller.activate({ workspaceId, apiReady: true }); },
    grant() { controller.authorizeWrites(workspaceId); },
  };
}
