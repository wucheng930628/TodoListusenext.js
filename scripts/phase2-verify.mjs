import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DescribeTableCommand, UpdateTableCommand } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { createLocalDocumentClient, localClientOptions } from "../src/lib/local-dynamodb.mjs";
import { INDEX_NAME } from "../src/lib/data-model.mjs";
import { runScenario } from "../tests/phase2-scenario.mjs";

// Explicitly authorized local-only acceptance run. No environment file is read.
if (!process.argv.includes("--authorized-local-run")) throw new Error("Explicit authorization is required; pass --authorized-local-run only after approval");
const endpoint = "http://127.0.0.1:9000";
process.env.DYNAMODB_ENDPOINT = endpoint;
assert.equal(localClientOptions().endpoint, endpoint);
const db = createLocalDocumentClient();
const runId = randomUUID();
const folder = resolve(".phase2-test-runs");
mkdirSync(folder, { recursive: true });
const reportPath = resolve(folder, `${runId}.json`);
const report = { runId, endpoint, table: "SlowlyTasks", startedAt: new Date().toISOString(), events: [], proposedIds: [], cleanup: [] };
function record(event) {
  report.events.push({ at: new Date().toISOString(), ...event });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(event));
}
const owned = new Set();
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
async function snapshot() {
  const result = {}; let cursor;
  do {
    const response = await db.send(new ScanCommand({ TableName: "SlowlyTasks", ConsistentRead: true, ExclusiveStartKey: cursor }));
    for (const item of response.Items || []) result[item.id] = createHash("sha256").update(JSON.stringify(stable(item))).digest("hex");
    cursor = response.LastEvaluatedKey;
  } while (cursor);
  return result;
}
async function describe() {
  const { Table: table } = await db.send(new DescribeTableCommand({ TableName: "SlowlyTasks" }));
  assert.equal(table.TableName, "SlowlyTasks");
  assert.deepEqual(table.KeySchema, [{ AttributeName: "id", KeyType: "HASH" }]);
  assert.ok(table.AttributeDefinitions.some(a => a.AttributeName === "id" && a.AttributeType === "S"));
  return table;
}
function validateIndex(table) {
  const index = table.GlobalSecondaryIndexes?.find(item => item.IndexName === INDEX_NAME);
  if (index) {
    assert.equal(index.KeySchema.length, 2, "Index structure conflict; stopping");
    for (const [name, kind] of [["gsi1pk", "HASH"], ["gsi1sk", "RANGE"]]) {
      assert.ok(index.KeySchema.some(key => key.AttributeName === name && key.KeyType === kind), "Index structure conflict; stopping");
      assert.ok(table.AttributeDefinitions.some(a => a.AttributeName === name && a.AttributeType === "S"), "Index type conflict; stopping");
    }
    assert.equal(index.Projection.ProjectionType, "ALL", "Index projection conflict; stopping");
  }
  return index;
}
const tracked = {
  async send(command) {
    for (const action of command.input.TransactItems || []) {
      const value = action.Put || action.Delete;
      const id = value.Item?.id || value.Key.id;
      if (action.Put?.ConditionExpression === "attribute_not_exists(id)") {
        assert.equal(value.Item.data.testRun, runId);
        assert.ok(!Object.hasOwn(report.baseline, id), "Refusing an existing ID");
        owned.add(id);
        report.proposedIds.push({ id, entityType: value.Item.entityType });
        record({ operation: "proposed-create", id, entityType: value.Item.entityType });
      } else {
        assert.ok(owned.has(id), "Refusing to mutate an item outside this run");
        if (action.Put) assert.equal(value.Item.data.testRun, runId);
      }
    }
    return db.send(command);
  },
};
let failure;
try {
  record({ operation: "start", runId, endpoint, reportPath });
  const table = await describe();
  let index = validateIndex(table);
  report.baseline = await snapshot();
  record({ operation: "baseline", itemCount: Object.keys(report.baseline).length, tableStatus: table.TableStatus });
  if (!index) {
    const request = {
      TableName: "SlowlyTasks",
      AttributeDefinitions: [{ AttributeName: "gsi1pk", AttributeType: "S" }, { AttributeName: "gsi1sk", AttributeType: "S" }],
      GlobalSecondaryIndexUpdates: [{ Create: { IndexName: INDEX_NAME, KeySchema: [{ AttributeName: "gsi1pk", KeyType: "HASH" }, { AttributeName: "gsi1sk", KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" }, ...(table.BillingModeSummary?.BillingMode === "PAY_PER_REQUEST" ? {} : { ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 } }) } }],
    };
    record({ operation: "create-index-request", request });
    await db.send(new UpdateTableCommand(request));
    report.indexCreated = true;
  } else { report.indexCreated = false; record({ operation: "existing-index-matched", status: index.IndexStatus }); }
  for (let attempt = 0; attempt < 60; attempt++) {
    index = validateIndex(await describe());
    if (index?.IndexStatus === "ACTIVE") break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(index?.IndexStatus, "ACTIVE", "Index not ACTIVE before timeout");
  record({ operation: "index-ready", status: index.IndexStatus });
  report.scenario = await runScenario(tracked, runId);
  const types = report.proposedIds.map(item => item.entityType);
  assert.deepEqual(Object.fromEntries(["WORKSPACE", "BOARD", "TASK", "WIDGET"].map(type => [type, types.filter(item => item === type).length])), { WORKSPACE: 1, BOARD: 2, TASK: 2, WIDGET: 2 });
  record({ operation: "scenario-passed", ...report.scenario });
} catch (error) {
  failure = error;
  record({ operation: "error", name: error.name, code: error.code || "UNEXPECTED", message: error.message });
} finally {
  for (const id of owned) {
    try {
      const { Item: item } = await db.send(new GetCommand({ TableName: "SlowlyTasks", Key: { id }, ConsistentRead: true }));
      if (item) {
        assert.equal(item.data?.testRun, runId, "Cleanup ownership mismatch; refusing delete");
        await db.send(new DeleteCommand({ TableName: "SlowlyTasks", Key: { id }, ConditionExpression: "#v = :v AND #d.#r = :run", ExpressionAttributeNames: { "#v": "version", "#d": "data", "#r": "testRun" }, ExpressionAttributeValues: { ":v": item.version, ":run": runId } }));
      }
      report.cleanup.push({ id, status: item ? "deleted" : "already-absent" });
      record({ operation: "cleanup", id, status: item ? "deleted" : "already-absent" });
    } catch (error) {
      failure ||= error;
      record({ operation: "cleanup-error", id, name: error.name, message: error.message });
    }
  }
  if (report.baseline) {
    try {
      const table = await describe();
      const after = await snapshot();
      assert.deepEqual(after, report.baseline, "Existing data changed or test items remain; no automatic repair attempted");
      report.final = { tableExists: true, tableStatus: table.TableStatus, baselineItemsUnchanged: Object.keys(after).length, testItemsRemaining: [...owned].filter(id => Object.hasOwn(after, id)).length, indexStatus: validateIndex(table)?.IndexStatus };
      record({ operation: "final-verification", ...report.final });
    } catch (error) {
      failure ||= error;
      record({ operation: "verification-error", name: error.name, message: error.message });
    }
  }
  report.finishedAt = new Date().toISOString();
  record({ operation: "finished", success: !failure, reportPath });
  db.destroy();
}
if (failure) process.exitCode = 1;
