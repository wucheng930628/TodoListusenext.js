import { createHmac } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLocalDocumentClient } from "../src/lib/local-dynamodb.mjs";
import { formalEvidenceDependencies, loadFormalEvidenceKey, privateEvidenceFile } from "../src/lib/api/formal-evidence.mjs";
import { formalWorkspaceBinding } from "../src/lib/api/formal-workspace.mjs";
import { authorizationEvidenceId, createCutoverAuthorization } from "../src/lib/migration/cutover-authorization.mjs";
import { canonical } from "../src/lib/migration/plan-v2.mjs";
import { createTrustedEvidenceProvider } from "../src/lib/migration/trusted-evidence.mjs";

const validActions = ["review", "sign", "request", "approve", "redeem", "revoke", "status", "dry-run", "review-execution", "sign-execution"];
async function main() {
  const [action, argument, reviewDigest, ...extra] = process.argv.slice(2);
  if (!validActions.includes(action) || extra.length ||
    (["request", "status", "dry-run"].includes(action) ? argument !== undefined : !argument) ||
    (["sign", "sign-execution"].includes(action) ? !reviewDigest : reviewDigest !== undefined)) throw new Error("Invalid operator command");
  const env = process.env;
  const binding = formalWorkspaceBinding(env.SLOWLY_FORMAL_VIEW_WORKSPACE, env);
  const sourceFile = env.SLOWLY_FORMAL_EVIDENCE_FILE;
  const key = loadFormalEvidenceKey(env);
  const document = createLocalDocumentClient();
  try {
    const db = { send(command) {
      if (["GetCommand", "QueryCommand"].includes(command.constructor.name) && command.input.TableName === "SlowlyTasks") return document.send(command);
      const actions = command.input.TransactItems;
      if (!["request", "approve", "redeem", "revoke"].includes(action) || command.constructor.name !== "TransactWriteCommand" || !actions?.every(tx => Object.keys(tx).length === 1 &&
        (tx.Put?.TableName === "SlowlyTasks" && /^SLOWLY#CUTOVER_AUTHORIZATION#[a-f0-9]{64}$/.test(tx.Put.Item.id) ||
          tx.ConditionCheck?.TableName === "SlowlyTasks" && tx.ConditionCheck.Key.id === `SLOWLY#MIGRATION_SESSION#${binding.migrationId}`))) throw new Error("Unauthorized database action");
      return document.send(command);
    } };
    const deps = formalEvidenceDependencies(db, key);
    const verify = (scope, signed) => createTrustedEvidenceProvider({ ...deps, loadBundle: async () => signed })(scope);
    const signed = JSON.parse(privateEvidenceFile(sourceFile, 2097152));
    if (!deps.verifySignature(signed.payload, signed.signature)) throw new Error("Invalid evidence signature");
    const service = createCutoverAuthorization({ ...deps, db, verify });
    const sign = payload => ({ payload, signature: createHmac("sha256", key).update(canonical(payload)).digest("hex") });
    if (action === "dry-run") {
      const report = await verify(binding, signed);
      const row = report.requestEligible ? await service.status(signed.payload) : null;
      const ready = report.requestEligible === true && row === null;
      const blockers = row ? ["AUTHORIZATION_RECORD_EXISTS"] : report.blockers;
      if (signed.payload.purpose === "release-preparation") blockers.push("SIGNED_REQUEST_EVIDENCE_REQUIRED");
      console.log(JSON.stringify({ requestEligible: ready, evidenceVerified: report.evidenceVerified === true,
        evidenceExpiresAt: report.evidenceExpiresAt ?? null, signedBundleExpiresAt: signed.payload.expiresAt, state: report.requestEligible ? row?.state ?? "ABSENT" : "NOT_CHECKED",
        blockers: ready ? [] : blockers }));
      if (!ready) process.exitCode = 1;
      return;
    }
    if (action === "review-execution" || action === "sign-execution") {
      if (signed.payload.purpose !== "cutover-request") throw new Error("A request bundle is required");
      const approval = JSON.parse(privateEvidenceFile(argument, 65536));
      const payload = { ...signed.payload, purpose: "cutover-execution", attestations: { ...signed.payload.attestations, approval } };
      const candidate = sign(payload);
      const report = await createTrustedEvidenceProvider({ ...deps, redeemedUntil: service.redeemedUntil, loadBundle: async () => candidate })(binding);
      if (!report.ready) throw Object.assign(new Error("Execution evidence preflight failed"), { code: report.blockers[0] });
      const evidenceId = authorizationEvidenceId(payload);
      if (action === "sign-execution") {
        if (reviewDigest !== evidenceId) throw new Error("Confirm the exact execution evidence digest");
        const output = join(dirname(realpathSync(sourceFile)), "cutover-execution.json");
        writeFileSync(output, JSON.stringify(candidate), { flag: "wx", mode: 0o600 });
        console.log(JSON.stringify({ state: "EXECUTION_EVIDENCE_SIGNED", evidenceId, file: output }));
        return;
      }
      console.log(JSON.stringify({ state: "EXECUTION_REVIEW", subject: payload.subject, evidenceId, expiresAt: report.evidenceExpiresAt }));
      return;
    }
    if (action === "review" || action === "sign") {
      if (signed.payload.purpose !== "release-preparation") throw new Error("A preparation bundle is required");
      const attestations = JSON.parse(privateEvidenceFile(argument, 2097152));
      const payload = { ...signed.payload, purpose: "cutover-request", attestations };
      const evidenceId = authorizationEvidenceId(payload);
      if (action === "sign" && reviewDigest !== evidenceId) throw new Error("Explicit evidence confirmation required");
      const candidate = sign(payload);
      const report = await verify(binding, candidate);
      if (!report.requestEligible) throw Object.assign(new Error("Evidence preflight failed"), { code: report.blockers[0] });
      if (action === "sign") {
        const output = join(dirname(realpathSync(sourceFile)), "cutover-request.json");
        writeFileSync(output, JSON.stringify(candidate), { flag: "wx", mode: 0o600 });
        console.log(JSON.stringify({ state: "SIGNED", evidenceId, file: output, expiresAt: report.evidenceExpiresAt }));
        return;
      }
      console.log(JSON.stringify({ state: "REVIEW", subject: payload.subject, sessionVersion: payload.release.sessionVersion,
        origin: attestations.requestConsent.origin, observedAt: attestations.requestConsent.observedAt,
        browserState: attestations.requestConsent.browserState, expiresAt: report.evidenceExpiresAt, evidenceId }));
      return;
    }
    if (action === "status") {
      const subject = signed.payload.subject;
      if (signed.payload.purpose !== "cutover-request" || subject.workspaceId !== binding.workspaceId ||
        subject.migrationId !== binding.migrationId || subject.sourceNamespace !== binding.sourceNamespace ||
        signed.payload.tableName !== "SlowlyTasks") throw new Error("Authorization scope differs");
      const row = await service.status(signed.payload);
      console.log(JSON.stringify({ state: row?.state ?? "ABSENT", evidenceId: authorizationEvidenceId(signed.payload),
        expiresAt: row?.expiresAt ?? null, expired: row ? Date.now() >= row.expiresAt : null }));
      return;
    }
    const row = await service.transition(action, { binding, signed, confirmation: argument });
    console.log(JSON.stringify({ state: row.state, evidenceId: row.evidenceId, expiresAt: row.expiresAt }));
  } finally { key.fill(0); document.destroy(); }
}

main().catch(error => {
  console.error(/^[A-Z_]{1,80}$/.test(error.code || "") ? error.code : "Cutover authorization command stopped");
  process.exitCode = 1;
});
