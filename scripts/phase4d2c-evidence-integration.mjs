import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand, DeleteTableCommand, waitUntilTableExists, waitUntilTableNotExists } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { evidenceFixture } from "../tests/helpers/evidence-fixture.mjs";
import { formalCutoverEvidence } from "../src/lib/api/formal-evidence.mjs";

if (!process.argv.includes("--isolated-table")) throw new Error("Explicit isolated table required");
const runId = randomUUID(); const tableName = `Slowly_Phase4D2C_${runId.replaceAll("-", "")}`; const endpoint = "http://127.0.0.1:9000";
const client = new DynamoDBClient({ endpoint, region: "ap-northeast-1", credentials: { accessKeyId: "local", secretAccessKey: "local" }, maxAttempts: 1 });
client.middlewareStack.add(next => async args => { const input = args.input; const tables = input.TransactItems ? input.TransactItems.map(action => (action.Put || action.Delete || action.ConditionCheck || action.Update).TableName) : [input.TableName]; if (!tables.length || tables.some(name => name !== tableName || name === "SlowlyTasks")) throw new Error("Isolated table boundary violated"); return next(args); }, { step: "initialize", name: "evidenceIsolationBoundary" });
const document = DynamoDBDocumentClient.from(client); let readOnly = false;
const db = { send(command) { if (readOnly && !["GetCommand", "QueryCommand", "ScanCommand"].includes(command.constructor.name)) throw new Error("Provider attempted a write"); return document.send(command); } };
mkdirSync(".phase4d2c-test-runs", { recursive: true }); const path = `.phase4d2c-test-runs/${runId}.json`;
const report = { runId, tableName, endpoint, evidenceSource: "synthetic signed fixtures only; NOT browser acceptance or formal authority", checks: [], created: false, cleaned: false };
const save = () => writeFileSync(path, JSON.stringify(report, null, 2));
const check = (ok, name) => { report.checks.push({ name, passed: Boolean(ok) }); save(); if (!ok) throw new Error("EVIDENCE_CHECK_FAILED"); };
save();
try {
  try { await client.send(new DescribeTableCommand({ TableName: tableName })); throw new Error("Fresh table exists"); } catch (error) { if (error.name !== "ResourceNotFoundException") throw error; }
  await client.send(new CreateTableCommand({ TableName: tableName, BillingMode: "PAY_PER_REQUEST", KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }, { AttributeName: "gsi1pk", AttributeType: "S" }, { AttributeName: "gsi1sk", AttributeType: "S" }],
    GlobalSecondaryIndexes: [{ IndexName: "SlowlyByParent", KeySchema: [{ AttributeName: "gsi1pk", KeyType: "HASH" }, { AttributeName: "gsi1sk", KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" } }] }));
  report.created = true; save(); await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
  check((await db.send(new ScanCommand({ TableName: tableName, ConsistentRead: true, Select: "COUNT" }))).Count === 0, "New empty local test table");
  const f = await evidenceFixture({ db, tableName }); readOnly = true;
  check((await f.provider(f.binding, await f.snapshot())).ready, "Live Session/Receipt/Verify/Release/Fidelity with read-only provider boundary");
  f.setSigned({ payload: f.bundle, signature: "0".repeat(64) }); check(!(await f.provider(f.binding)).ready, "Forged browser ready/signature denied");
  const expired = structuredClone(f.bundle); expired.expiresAt = 0; f.setSigned(f.sign(expired)); check(!(await f.provider(f.binding)).ready, "Expired evidence denied");
  const changed = structuredClone(f.bundle); changed.subject.planId = "0".repeat(64); f.setSigned(f.sign(changed)); check(!(await f.provider(f.binding)).ready, "Different Plan denied");
  f.setSigned(f.sign(f.bundle)); readOnly = false; const taskOp = f.plan.operations.find(op => op.type === "TASK"); const task = await f.repository.getTask(taskOp.targetId);
  await f.repository.updateTask(task.boardId, task.id, { ...task.data, notes: "Synthetic version change" }, task.version); readOnly = true;
  check(!(await f.provider(f.binding)).ready, "Live changed target version/Fidelity denied");
  check(!(await formalCutoverEvidence(f.binding, null, {})).cutoverEnabled, "Unconfigured formal provider stays NOT READY without IO");
  report.passed = report.checks.length; report.failed = 0;
} catch (error) { report.failed = report.checks.filter(row => !row.passed).length || 1; report.errorType = error.name; process.exitCode = 1; }
finally {
  readOnly = false;
  if (report.created) { await client.send(new DeleteTableCommand({ TableName: tableName })); await waitUntilTableNotExists({ client, maxWaitTime: 30 }, { TableName: tableName }); report.cleaned = true; }
  save(); client.destroy(); console.log(JSON.stringify(report));
}
