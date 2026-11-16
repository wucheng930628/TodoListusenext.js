import "server-only";
import { readFileSync, realpathSync, statSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { createLocalDocumentClient } from "../local-dynamodb.mjs";
import { createRepository } from "../slowly-repository.mjs";
import { createMigrationService } from "../migration/service.mjs";
import { createTrustedEvidenceProvider, verifyEvidenceSignature } from "../migration/trusted-evidence.mjs";
import { formalWorkspaceBinding } from "./formal-workspace.mjs";

const root = realpathSync(process.cwd());
function privateFile(path, limit) {
  if (!isAbsolute(path || "")) throw new Error("Private absolute evidence path required");
  const resolved = realpathSync(path); const rel = relative(root, resolved);
  if (!(rel.startsWith("..") || isAbsolute(rel)) || !statSync(resolved).isFile() || statSync(resolved).size > limit) throw new Error("Evidence must remain private");
  for (let directory = dirname(resolved); ; directory = dirname(directory)) {
    if (existsSync(join(directory, ".git"))) throw new Error("Evidence cannot be in Git");
    if (dirname(directory) === directory) break;
  }
  return readFileSync(resolved, "utf8");
}

export async function formalCutoverEvidence(binding, snapshot, env = process.env) {
  const blocked = { ready: false, cutoverEnabled: false, workspaceId: binding.workspaceId, migrationId: binding.migrationId, expiresAt: null, blockers: ["TRUSTED_EVIDENCE_NOT_CONFIGURED"] };
  // No files, clients or DB queries before explicit server configuration. No client request input.
  if (!env.SLOWLY_FORMAL_EVIDENCE_FILE || !env.SLOWLY_FORMAL_EVIDENCE_KEY_FILE) return blocked;
  try {
    formalWorkspaceBinding(binding.workspaceId, env);
    const keyText = privateFile(env.SLOWLY_FORMAL_EVIDENCE_KEY_FILE, 4096).trim();
    if (!/^[a-f0-9]{64,128}$/.test(keyText) || keyText.length % 2) return blocked;
    const signed = JSON.parse(privateFile(env.SLOWLY_FORMAL_EVIDENCE_FILE, 2097152));
    const key = Buffer.from(keyText, "hex");
    const document = createLocalDocumentClient(); const tableName = "SlowlyTasks";
    // A second boundary makes this provider incapable of writes, even if a dependency regresses.
    const readOnly = { send(command) {
      if (!["GetCommand", "QueryCommand"].includes(command.constructor.name) || command.input.TableName !== tableName) throw new Error("Read-only evidence boundary");
      return document.send(command);
    } };
    return await createTrustedEvidenceProvider({ loadBundle: async () => signed, verifySignature: (body, signature) => verifyEvidenceSignature(body, signature, key),
      endpoint: "http://127.0.0.1:9000", tableName, repository: createRepository(readOnly, { tableName }), service: createMigrationService(readOnly, { tableName }),
      readItem: async id => (await readOnly.send(new GetCommand({ TableName: tableName, Key: { id }, ConsistentRead: true }))).Item })(binding, snapshot);
  } catch { return blocked; }
}
