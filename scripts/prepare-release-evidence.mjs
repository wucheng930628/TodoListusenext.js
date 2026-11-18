import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { createLocalDocumentClient } from "../src/lib/local-dynamodb.mjs";
import { createRepository } from "../src/lib/slowly-repository.mjs";
import { createMigrationService } from "../src/lib/migration/service.mjs";
import { evidenceEndpoint, prepareSignedReleaseEvidence } from "../src/lib/migration/release-evidence.mjs";
import { createTrustedEvidenceProvider, verifyEvidenceSignature } from "../src/lib/migration/trusted-evidence.mjs";

function privatePath(path) {
  if (!isAbsolute(path || "")) throw new Error("Private absolute path required");
  const resolved = realpathSync(path);
  const rel = relative(realpathSync(process.cwd()), resolved);
  if (!rel.startsWith("..") && !isAbsolute(rel)) throw new Error("Private path must be outside the project");
  for (let dir = resolved; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) throw new Error("Private path must be outside Git");
    if (dirname(dir) === dir) return resolved;
  }
}

async function main() {
  const [mode, backupFile, outputParent, workspaceId, migrationId, sourceNamespace, backupFingerprint, ...extra] = process.argv.slice(2);
  if (mode !== "--prepare-only" || extra.length || !/^SLOWLY#WORKSPACE#[a-f0-9-]{36}$/.test(workspaceId || "") ||
    !/^[a-f0-9]{64}$/.test(migrationId || "") || !/^[a-zA-Z0-9._-]{8,128}$/.test(sourceNamespace || "") ||
    !/^[a-f0-9]{64}$/.test(backupFingerprint || "")) throw new Error("Expected --prepare-only BACKUP PRIVATE_DIRECTORY WORKSPACE_ID PLAN_ID SOURCE_NAMESPACE FINGERPRINT");
  const backup = JSON.parse(readFileSync(privatePath(backupFile), "utf8"));
  const parent = privatePath(outputParent);
  const tableName = "SlowlyTasks";
  process.env.DYNAMODB_ENDPOINT = evidenceEndpoint;
  const document = createLocalDocumentClient();
  try {
    const db = { send(command) {
      if (!(command instanceof GetCommand || command instanceof QueryCommand) || command.input.TableName !== tableName) {
        throw new Error("Evidence preparation only permits reads from SlowlyTasks");
      }
      return document.send(command);
    } };
    const service = createMigrationService(db, { tableName });
    const repository = createRepository(db, { tableName });
    const readItem = async id => (await db.send(new GetCommand({ TableName: tableName, Key: { id }, ConsistentRead: true }))).Item;
    const binding = { workspaceId, migrationId, sourceNamespace };
    const options = { sourceNamespace, policies: { sourcePolicy: { primary: "slowly-workspace-v2",
      legacy: { source: "slowly-board-v1", action: "exclude", acknowledged: true } } } };
    const key = randomBytes(32);
    const signed = await prepareSignedReleaseEvidence({ backup, options, binding, backupFingerprint, tableName, key,
      expiresInMs: 60 * 60 * 1000, service, repository, readItem });
    const verification = await createTrustedEvidenceProvider({ loadBundle: async () => signed, repository, service, readItem,
      verifySignature: (payload, signature) => verifyEvidenceSignature(payload, signature, key), endpoint: evidenceEndpoint, tableName })(binding);
    if (verification.evidenceVerified !== true || verification.ready || verification.cutoverEnabled) throw new Error("Preparation evidence failed verification");
    const directory = mkdtempSync(join(parent, "slowly-release-evidence-"));
    const bundleFile = join(directory, "release-preparation.json");
    const keyFile = join(directory, "signing-key.hex");
    writeFileSync(keyFile, key.toString("hex"), { flag: "wx", mode: 0o600 });
    writeFileSync(bundleFile, JSON.stringify(signed), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ bundleFile, keyFile, workspaceId, migrationId, sessionVersion: verification.sessionVersion,
      expiresAt: new Date(verification.evidenceExpiresAt).toISOString(), evidenceVerified: true, ready: false, cutoverEnabled: false }));
  } finally { document.destroy(); }
}

main().catch(error => {
  console.error(error.code && /^[A-Z_]+$/.test(error.code) ? error.code : "Release evidence preparation stopped");
  process.exitCode = 1;
});
