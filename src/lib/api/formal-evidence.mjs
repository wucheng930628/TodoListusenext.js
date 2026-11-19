import "server-only";
import { readFileSync, realpathSync, statSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { createLocalDocumentClient } from "../local-dynamodb.mjs";
import { createRepository } from "../slowly-repository.mjs";
import { createMigrationService } from "../migration/service.mjs";
import { createTrustedEvidenceProvider, verifyEvidenceSignature } from "../migration/trusted-evidence.mjs";
import { formalWorkspaceBinding } from "./formal-workspace.mjs";
import { createCutoverAuthorization } from "../migration/cutover-authorization.mjs";

const root = realpathSync(process.cwd());
export function privateEvidenceFile(path, limit) {
  if (!isAbsolute(path || "")) throw new Error("Private absolute evidence path required");
  const resolved = realpathSync(path); const rel = relative(root, resolved);
  if (!(rel.startsWith("..") || isAbsolute(rel)) || !statSync(resolved).isFile() || statSync(resolved).size > limit) throw new Error("Evidence must remain private");
  for (let directory = dirname(resolved); ; directory = dirname(directory)) {
    if (existsSync(join(directory, ".git"))) throw new Error("Evidence cannot be in Git");
    if (dirname(directory) === directory) break;
  }
  return readFileSync(resolved, "utf8");
}

export function loadFormalEvidenceKey(env) {
  const value = privateEvidenceFile(env.SLOWLY_FORMAL_EVIDENCE_KEY_FILE, 4096).trim();
  if (!/^[a-f0-9]{64,128}$/.test(value) || value.length % 2) throw new Error("Invalid private evidence key");
  return Buffer.from(value, "hex");
}

export function formalEvidenceDependencies(db, key) {
  const tableName = "SlowlyTasks";
  return { tableName, endpoint: "http://127.0.0.1:9000", service: createMigrationService(db, { tableName }),
    repository: createRepository(db, { tableName }), verifySignature: (body, signature) => verifyEvidenceSignature(body, signature, key),
    requireBrowserState: true,
    readItem: async id => (await db.send(new GetCommand({ TableName: tableName, Key: { id }, ConsistentRead: true }))).Item };
}

export async function formalCutoverEvidence(binding, snapshot, env = process.env) {
  const blocked = { ready: false, cutoverEnabled: false, workspaceId: binding.workspaceId, migrationId: binding.migrationId, expiresAt: null, blockers: ["TRUSTED_EVIDENCE_NOT_CONFIGURED"] };
  // No files, clients or DB queries before explicit server configuration. No client request input.
  if (!env.SLOWLY_FORMAL_EVIDENCE_FILE || !env.SLOWLY_FORMAL_EVIDENCE_KEY_FILE) return blocked;
  let document, key;
  try {
    const configured = formalWorkspaceBinding(binding.workspaceId, env);
    if (binding.migrationId !== configured.migrationId || binding.sourceNamespace !== configured.sourceNamespace) return blocked;
    key = loadFormalEvidenceKey(env);
    const signed = JSON.parse(privateEvidenceFile(env.SLOWLY_FORMAL_EVIDENCE_FILE, 2097152));
    document = createLocalDocumentClient(); const tableName = "SlowlyTasks";
    // A second boundary makes this provider incapable of writes, even if a dependency regresses.
    const readOnly = { send(command) {
      if (!["GetCommand", "QueryCommand"].includes(command.constructor.name) || command.input.TableName !== tableName) throw new Error("Read-only evidence boundary");
      return document.send(command);
    } };
    const deps = formalEvidenceDependencies(readOnly, key);
    const { redeemedUntil } = createCutoverAuthorization({ ...deps, db: readOnly });
    return await createTrustedEvidenceProvider({ ...deps, redeemedUntil, loadBundle: async () => signed })(binding, snapshot);
  } catch { return blocked; }
  finally { key?.fill(0); document?.destroy(); }
}
