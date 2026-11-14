import { randomUUID } from "node:crypto";
import { createMigrationService } from "../../src/lib/migration/service.mjs";
import { createRepository } from "../../src/lib/slowly-repository.mjs";
import { migrationPlanV2 } from "../../src/lib/migration/plan-v2.mjs";
import { captureWorkspaceBackup } from "../../src/lib/client/workspace-backup.mjs";
import { workspaceFixture, storageFixture, createdAt } from "../phase4a-fixtures.mjs";
import { MemoryClient } from "./memory-client.mjs";

export function releaseFixture({ db = new MemoryClient(), tableName = "isolated-memory", data = workspaceFixture() } = {}) {
  const options = { sourceNamespace: `release-${randomUUID()}` };
  const backup = captureWorkspaceBackup({ storage: storageFixture({ "slowly-workspace-v2": JSON.stringify(data) }), createdAt });
  const plan = migrationPlanV2(backup, options); const service = createMigrationService(db, { tableName }); const repository = createRepository(db, { tableName });
  const step = async () => { const session = await service.getSession(plan.migrationId); const preview = await service.releasePreview(plan.migrationId, session.version); return service.release(plan.migrationId, session.version, preview.verificationHash, plan.migrationId); };
  return { db, tableName, data, options, backup, plan, service, repository, step,
    async apply() {
      let session; do { session = await service.createSession(backup, options, plan.planId); } while (session.state === "PREPARING");
      for (const operation of plan.operations) await service.execute(plan.migrationId, operation.operationId, operation.fingerprint);
      await service.verify(plan.migrationId);
    },
    async finish() { for (let i = 0; i <= plan.operations.length + 1; i++) { const session = await step(); if (session.lockState === "RELEASED") return session; } throw new Error("Release did not finish"); },
  };
}
