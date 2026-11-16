import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mainUiFixture } from "./helpers/main-ui-fixture.mjs";
import { MemoryClient } from "./helpers/memory-client.mjs";
import { workspaceFixture, storageFixture, createdAt } from "./phase4a-fixtures.mjs";
import { createMainWorkspaceController } from "../src/lib/client/main-workspace-controller.mjs";
import { createRecoveryJournal, createMemoryRecoveryJournal } from "../src/lib/client/recovery-journal.mjs";
import { readLocalPrimary } from "../src/lib/client/local-primary.mjs";
import { formalWorkspaceBinding } from "../src/lib/api/formal-workspace.mjs";
import { createWorkspaceViewApi, readWorkspaceView } from "../src/lib/api/workspace-view.mjs";
import { checkCutoverReadiness } from "../src/lib/migration/cutover-readiness.mjs";
import { captureWorkspaceBackup } from "../src/lib/client/workspace-backup.mjs";
import { sealBackup } from "../src/lib/client/verified-backup.mjs";
import { migrationPlanV2, hash } from "../src/lib/migration/plan-v2.mjs";
import { createMigrationService } from "../src/lib/migration/service.mjs";
import { createRepository } from "../src/lib/slowly-repository.mjs";
import { indexedDbDouble } from "./helpers/indexed-db-double.mjs";
import { createMainUiSession } from "../src/lib/client/main-ui-session.mjs";

const controllerFor = (f, api = f.api, journal = f.journal) => createMainWorkspaceController({ api, journal, development: true });
const activate = (c, f) => c.activate({ workspaceId: f.workspaceId, apiReady: true });
const record = workspaceId => ({ formatVersion: 1, token: randomUUID(), workspaceId, action: "update", kind: "task" });

test("IndexedDB adapter persists across instances and keeps formal/test namespaces separate", async () => {
  const factory = indexedDbDouble(); const first = createRecoveryJournal({ indexedDB: () => factory });
  const item = record(`SLOWLY#WORKSPACE#${randomUUID()}`); await first.claim(item);
  const reloaded = createRecoveryJournal({ indexedDB: () => factory }); assert.deepEqual(await reloaded.load(), item);
  await assert.rejects(reloaded.claim(record(item.workspaceId)), { code: "RECOVERY_REQUIRED" });
  await assert.rejects(reloaded.clear(randomUUID()), { code: "RECOVERY_SCOPE_CONFLICT" });
  assert.deepEqual(await reloaded.load(), item);
  assert.equal(await createRecoveryJournal({ indexedDB: () => factory, namespace: "isolated" }).load(), null);
  await reloaded.clear(item.token); assert.equal(await first.load(), null); assert.ok(factory.closes() >= 7);
});

test("Reload bootstrap never enables API automatically and freezes local edits for unresolved writes", async () => {
  const f = await mainUiFixture(); await f.journal.claim(record(f.workspaceId)); const c = controllerFor(f);
  const count = f.calls.length; await c.bootstrapRecovery();
  assert.equal(c.getSnapshot().mode, "localStorage"); assert.equal(c.getSnapshot().startupStatus, "blocked");
  assert.equal(c.getSnapshot().recoveryWorkspaceId, f.workspaceId); assert.equal(f.calls.length, count);
  await activate(c, f); assert.equal(c.getSnapshot().uncertainWrite, true);
});

test("Formal runtime view is readable but does not grant UI writes without the Cutover Gate", async () => {
  const f = await mainUiFixture(); const api = { ...f.api, getWorkspaceView: async (...args) => {
    const view = await f.api.getWorkspaceView(...args); Object.assign(view.readiness.capabilities, { formalCutoverRequired: true, formalCutoverEnabled: false }); return view;
  } };
  const c = controllerFor(f, api); await activate(c, f);
  assert.equal(c.getSnapshot().status, "success"); assert.throws(() => c.authorizeWrites(f.workspaceId), { code: "CUTOVER_REQUIRED" });
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
});

test("formal View requires exact server-owned Workspace/Plan binding before data access", async () => {
  const f = await mainUiFixture(); let access = 0;
  const env = { NODE_ENV: "development", SLOWLY_LOCAL_API: "1", SLOWLY_FORMAL_VIEW_ENABLED: "1", SLOWLY_FORMAL_VIEW_WORKSPACE: f.workspaceId, SLOWLY_FORMAL_VIEW_PLAN: f.plan.planId };
  const handler = config => createWorkspaceViewApi({ configuration: () => config, authorizeWorkspace: id => formalWorkspaceBinding(id, config),
    getRepository: async () => { access++; return f.repository; }, getMigrationService: async () => f.service });
  const call = (config, id = f.workspaceId) => handler(config)(new Request(`http://127.0.0.1:3000/api/workspaces/${encodeURIComponent(id)}/view`, { headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } }), { params: Promise.resolve({ id }) });
  for (const config of [{ ...env, SLOWLY_FORMAL_VIEW_ENABLED: "0" }, { ...env, NODE_ENV: "production" }, { ...env, DYNAMODB_ENDPOINT: "https://dynamodb.amazonaws.com" }, { ...env, SLOWLY_MAIN_UI_TEST: "1" }]) assert.equal((await call(config)).status, 403);
  assert.equal((await call(env, `SLOWLY#WORKSPACE#${randomUUID()}`)).status, 403); assert.equal(access, 0);
  const result = await call(env); assert.equal(result.status, 200); assert.equal((await result.json()).data.boards.length, 2);
  assert.equal((await call({ ...env, SLOWLY_FORMAL_VIEW_PLAN: "0".repeat(64) })).status, 409);
});

test("Reload restores frozen create key/payload and NOT_FOUND never permits a new create", async () => {
  const f = await mainUiFixture(); await f.activate(); f.grant(); f.failNextWrite("before");
  await assert.rejects(f.controller.saveTask({ id: "reload-create", title: "Original", status: "todo" }));
  const original = await f.journal.load(); const c = controllerFor(f);
  assert.equal(c.getSnapshot().mode, "localStorage");
  await activate(c, f); assert.equal(c.getSnapshot().uncertainWrite, true);
  assert.throws(() => c.authorizeWrites(f.workspaceId), { code: "WRITES_DISABLED" });
  await assert.rejects(c.saveTask({ title: "different", status: "todo" }), { code: "WRITES_DISABLED" });
  await c.resendCreate(f.workspaceId);
  const posts = f.calls.filter(call => call.method === "POST"); assert.equal(posts.length, 2);
  assert.equal(posts[0].operationKey, original.token); assert.equal(posts[1].operationKey, original.token); assert.equal(posts[0].body, posts[1].body);
  assert.equal(await f.journal.load(), null); assert.equal(c.getSnapshot().uncertainWrite, false); assert.equal(c.getSnapshot().allowWrites, false);
});

test("Reload confirms a lost response, reads current version, and sends no duplicate POST", async () => {
  const f = await mainUiFixture(); let offline = true;
  const api = { ...f.api, getOperation: (...args) => offline ? Promise.reject(Object.assign(new Error("offline"), { code: "NETWORK_ERROR" })) : f.api.getOperation(...args) };
  const c = controllerFor(f, api); await activate(c, f); c.authorizeWrites(f.workspaceId); f.failNextWrite("after");
  await assert.rejects(c.saveTask({ id: "lost-reload", title: "Before", status: "todo" }));
  const saved = await f.journal.load(); const receipt = await f.api.getOperation(saved.token, { resource: "tasks", workspaceId: saved.workspaceId, boardId: saved.intent.input.boardId });
  await f.api.updateTask(receipt.targetId, { boardId: receipt.boardId, workspaceId: f.workspaceId, version: receipt.result.version, data: { title: "Latest server version" } });
  offline = false; const reloaded = controllerFor(f, api); await activate(reloaded, f);
  assert.equal(reloaded.getSnapshot().uncertainWrite, false);
  assert.equal(reloaded.getSnapshot().projection.workspace.boards[0].tasks.find(task => task.id === "lost-reload").title, "Latest server version");
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1); assert.equal(await f.journal.load(), null);
});

test("Recovery unavailable or claim failure prevents POST, without memory fallback", async () => {
  const f = await mainUiFixture(); const missing = createRecoveryJournal({ indexedDB: () => undefined });
  await assert.rejects(controllerFor(f, f.api, missing).activate({ workspaceId: f.workspaceId, apiReady: true }), { code: "RECOVERY_UNAVAILABLE" });
  const failing = { load: async () => null, claim: async () => { throw Object.assign(new Error(), { code: "RECOVERY_UNAVAILABLE", outcome: "not-sent" }); }, clear: async () => {} };
  const c = controllerFor(f, f.api, failing); await activate(c, f); c.authorizeWrites(f.workspaceId);
  await assert.rejects(c.saveTask({ id: "not-sent", title: "Not sent", status: "todo" }));
  assert.equal(f.calls.filter(call => call.method === "POST").length, 0); assert.equal(c.getSnapshot().allowWrites, false);
});

test("Recovery cannot load another Workspace, overwrite a journal or clear another operation", async () => {
  const f = await mainUiFixture(); const first = record(`SLOWLY#WORKSPACE#${randomUUID()}`); await f.journal.claim(first);
  const calls = f.calls.length; await assert.rejects(activate(controllerFor(f), f), { code: "RECOVERY_REQUIRED" }); assert.equal(f.calls.length, calls);
  await assert.rejects(f.journal.claim(record(f.workspaceId)), { code: "RECOVERY_REQUIRED" });
  await assert.rejects(f.journal.clear(randomUUID()), { code: "RECOVERY_SCOPE_CONFLICT" });
  assert.deepEqual(await f.journal.load(), first);
});

test("Task/Board/Widget drafts block navigation and survive version conflict", async () => {
  const f = await mainUiFixture(); await f.activate(); f.grant();
  for (const kind of ["task", "board", "widget"]) {
    const draft = { kind, input: "Unsaved", version: 1 }; f.controller.writeDraft(kind, draft);
    assert.throws(() => f.controller.selectBoard("board-b"), { code: "UNSAVED_DRAFTS" });
    assert.throws(() => f.controller.deactivate(), { code: "UNSAVED_DRAFTS" });
    await assert.rejects(f.controller.activate({ workspaceId: f.workspaceId, apiReady: true }), { code: "UNSAVED_DRAFTS" });
    assert.deepEqual(f.controller.readDraft(kind), draft); f.controller.clearDraft(kind, draft);
  }
  const task = f.controller.getSnapshot().projection.workspace.boards[0].tasks[0]; f.controller.writeDraft("task", task);
  await assert.rejects(f.controller.saveTask({ ...task, notes: "Keep this input" }, { expectedVersion: 9999 }), { status: 409 });
  assert.deepEqual(f.controller.readDraft("task"), task);
});

test("Definitive WIP rejection keeps input, clears the failed attempt and permits an explicit corrected retry", async () => {
  const f = await mainUiFixture(); await f.activate(); f.grant();
  const board = await f.repository.getBoard(f.plan.operations.find(op => op.type === "BOARD").targetId);
  await f.repository.updateBoard(board.id, { ...board.data, wipLimit: 1 }, board.version); await f.controller.refresh();
  await f.controller.saveTask({ id: "doing-one", title: "Doing one", status: "doing" });
  const input = { id: "rejected-two", title: "Preserved input", status: "doing" }; f.controller.writeDraft("task-editor", input);
  await assert.rejects(f.controller.saveTask(input), { code: "WIP_LIMIT", status: 409 });
  assert.deepEqual(f.controller.readDraft("task-editor"), input); assert.equal(await f.journal.load(), null); assert.equal(f.controller.getSnapshot().uncertainWrite, false);
  await f.controller.saveTask({ ...input, status: "todo" });
  assert.equal(f.controller.getSnapshot().projection.workspace.boards[0].tasks.filter(task => task.id === input.id).length, 1);
});

test("Failed Widget config retains proposed input separately and blocks unsafe navigation", async () => {
  const f = await mainUiFixture(); await f.activate(); f.grant();
  const ui = createMainUiSession({ ...f.controller.getSnapshot(), controller: f.controller }); f.failNextWrite("before");
  await assert.rejects(ui.changeWidgets(widgets => widgets.map((widget, index) => index ? widget : { ...widget, config: { text: "Keep proposed config" } }), { widgetId: "widget-a", expectedVersion: ui.widgetVersions["widget-a"] }));
  const drafts = f.controller.listDrafts(); assert.equal(drafts.length, 1); assert.equal(drafts[0].value.after[0].config.text, "Keep proposed config");
  assert.throws(() => f.controller.selectBoard("board-b"), { code: "UNSAVED_DRAFTS" });
});

test("Expired formal Cutover authority cannot grant or dispatch another UI write", async () => {
  const f = await mainUiFixture(); const api = { ...f.api, getWorkspaceView: async (...args) => {
    const view = await f.api.getWorkspaceView(...args); Object.assign(view.readiness.capabilities, { formalCutoverRequired: true, formalCutoverEnabled: true, formalCutoverExpiresAt: 1 }); return view;
  } };
  const c = controllerFor(f, api); await activate(c, f); assert.throws(() => c.authorizeWrites(f.workspaceId), { code: "CUTOVER_REQUIRED" });
  await assert.rejects(c.saveTask({ title: "Not sent", status: "todo" }), { code: "CUTOVER_REQUIRED" });
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
});

test("Pending write blocks all scope switches; cancellation persists UNKNOWN for Reload", async () => {
  const f = await mainUiFixture(); let finish; let invoked;
  const api = { ...f.api, createTask: (input, options) => new Promise(resolve => { invoked = { input, options }; finish = resolve; }) };
  const c = controllerFor(f, api); await activate(c, f); c.authorizeWrites(f.workspaceId);
  const pending = c.saveTask({ id: "pending-reload", title: "Pending", status: "todo" }); await new Promise(setImmediate);
  assert.throws(() => c.deactivate(), { code: "MUTATION_IN_PROGRESS" }); assert.throws(() => c.selectBoard("board-b"), { code: "MUTATION_IN_PROGRESS" });
  await assert.rejects(activate(c, f), { code: "MUTATION_IN_PROGRESS" });
  c.cancel(); finish(await f.api.createTask(invoked.input, invoked.options)); await pending;
  assert.equal(c.getSnapshot().uncertainWrite, true); assert.ok(await f.journal.load());
  const reloaded = controllerFor(f); await activate(reloaded, f); assert.equal(reloaded.getSnapshot().uncertainWrite, false);
});

test("Unknown non-create survives Reload and requires explicit reconciliation without resending", async () => {
  const f = await mainUiFixture(); const active = record(f.workspaceId); await f.journal.claim(active);
  const c = controllerFor(f); await activate(c, f); assert.equal(c.getSnapshot().uncertainWrite, true);
  assert.throws(() => c.authorizeWrites(f.workspaceId), { code: "WRITES_DISABLED" });
  await assert.rejects(c.resolveUncertain("wrong"), { code: "RECOVERY_REQUIRED" });
  await c.resolveUncertain(f.workspaceId); assert.equal(c.getSnapshot().uncertainWrite, false); assert.equal(c.getSnapshot().allowWrites, false);
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
});

test("Legacy fallback never parses/imports Legacy and never writes any localStorage key", () => {
  const legacy = JSON.stringify([{ id: "legacy", title: "do not import" }]); const storage = storageFixture({ "slowly-board-v1": legacy });
  assert.deepEqual(readLocalPrimary(storage), { raw: null, legacyBlocked: true }); assert.equal(storage.values.get("slowly-board-v1"), legacy); assert.deepEqual(storage.writes, []);
  const primary = storageFixture({ "slowly-workspace-v2": "invalid-but-preserved", "slowly-board-v1": legacy });
  assert.deepEqual(readLocalPrimary(primary), { raw: "invalid-but-preserved", legacyBlocked: false }); assert.deepEqual(primary.reads, ["slowly-workspace-v2"]);
});

async function gateFixture() {
  const data = workspaceFixture();
  const backup = await sealBackup(captureWorkspaceBackup({ storage: storageFixture({ "slowly-workspace-v2": JSON.stringify(data), "slowly-board-v1": JSON.stringify([{ id: "legacy-1" }, { id: "legacy-2" }]) }), createdAt }), "http://localhost:3000");
  const options = { sourceNamespace: `gate-${randomUUID()}`, policies: { sourcePolicy: { primary: "slowly-workspace-v2", legacy: { source: "slowly-board-v1", action: "exclude", acknowledged: true } } } };
  const plan = migrationPlanV2(backup, options); const db = new MemoryClient(); const service = createMigrationService(db); const repository = createRepository(db);
  await service.createSession(backup, options, plan.planId);
  for (const op of plan.operations) await service.execute(plan.planId, op.operationId, op.fingerprint);
  await service.verify(plan.planId);
  for (let i = 0; i < plan.operations.length + 2; i++) { const s = await service.getSession(plan.planId); if (s.state === "RELEASED") break; const preview = await service.releasePreview(plan.planId, s.version); await service.release(plan.planId, s.version, preview.verificationHash, plan.planId); }
  const probes = Object.fromEntries(["dynamodbLocal", "apiRepositoryTests", "reactApiTests", "backupArtifactVerified", "sourceFrozen", "draftSafety", "pendingWriteSafety", "unknownRecovery", "reloadRecovery", "legacyProtection"].map(name => [name, async () => true]));
  const evidence = { cleaned: true, dryRunPassed: true, verifyPassed: true, releasePassed: true, planId: plan.planId, backupFingerprint: plan.sourceBinding.backupFingerprint,
    sourceWorkspaceHash: plan.expectedWorkspaceHash, targetWorkspaceHash: plan.expectedWorkspaceHash,
    mappingHash: hash(plan.operations.map(op => [op.key, op.targetId, op.parentId, op.position])), exclusionSummary: plan.sourceBinding.exclusionSummary, differences: [] };
  probes.isolatedDryRun = async () => evidence;
  probes.formalWorkspaceView = () => readWorkspaceView(repository, plan.operations[0].targetId, { migrationService: service });
  return { backup, options, migrationId: plan.planId, service, repository, readItem: async id => structuredClone(db.items.get(id)), probes, evidence, plan,
    authorization: { enabled: true, workspaceId: plan.operations[0].targetId, migrationId: plan.planId, backupFingerprint: plan.sourceBinding.backupFingerprint, expiresAt: Date.now() + 60000 } };
}

test("Gate only enables for matching backup/plan/dry-run/release/all safety probes and scoped authorization", async () => {
  const f = await gateFixture(); assert.equal((await checkCutoverReadiness(f)).cutoverEnabled, true);
  for (const name of Object.keys(f.probes)) {
    const probes = { ...f.probes }; delete probes[name];
    assert.equal((await checkCutoverReadiness({ ...f, probes })).cutoverEnabled, false, name);
  }
  for (const authorization of [null, { ...f.authorization, workspaceId: "other" }, { ...f.authorization, expiresAt: 0 }, { ...f.authorization, enabled: false }]) assert.equal((await checkCutoverReadiness({ ...f, authorization })).cutoverEnabled, false);
});

test("Gate rejects stale backup/Plan, uncleaned or mismatched dry run, data differences and false safety probes", async () => {
  const f = await gateFixture();
  for (const change of [{ planId: "0".repeat(64) }, { backupFingerprint: "0".repeat(64) }, { cleaned: false }, { differences: [{ code: "MISSING_TASK" }] }, { mappingHash: "0".repeat(64) }]) {
    assert.equal((await checkCutoverReadiness({ ...f, probes: { ...f.probes, isolatedDryRun: async () => ({ ...f.evidence, ...change }) } })).ready, false);
  }
  assert.equal((await checkCutoverReadiness({ ...f, probes: { ...f.probes, draftSafety: async () => false } })).cutoverEnabled, false);
});
