import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { INDEX_NAME } from "../src/lib/data-model.mjs";
import { createLocalDocumentClient } from "../src/lib/local-dynamodb.mjs";
import { runScenario } from "../tests/phase2-scenario.mjs";

if (!process.argv.includes("--write-test-data")) throw new Error("Database writes require explicit approval, then --write-test-data");
const db = createLocalDocumentClient();
const runId = randomUUID();
const createdIds = new Set();
console.log(JSON.stringify({ mode: "isolated-write-test", runId }));
const tracked = {
  async send(command) {
    // Track proposed new IDs before sending, including an ambiguous network failure.
    for (const action of command.input.TransactItems || []) {
      if (action.Put?.ConditionExpression === "attribute_not_exists(id)" && action.Put.Item.data.testRun === runId) {
        createdIds.add(action.Put.Item.id);
        console.log(JSON.stringify({ runId, proposedTestId: action.Put.Item.id }));
      }
    }
    return db.send(command);
  },
};
try {
  const { Table: table } = await db.send(new DescribeTableCommand({ TableName: "SlowlyTasks" }));
  assert.ok(table.GlobalSecondaryIndexes?.some(index => index.IndexName === INDEX_NAME && index.IndexStatus === "ACTIVE"), "Create and activate the approved GSI before writing test data");
  console.log(JSON.stringify(await runScenario(tracked, runId)));
} finally {
  const errors = [];
  for (const id of createdIds) {
    try {
      const { Item: item } = await db.send(new GetCommand({ TableName: "SlowlyTasks", Key: { id }, ConsistentRead: true }));
      if (!item) continue;
      assert.equal(item.data?.testRun, runId, "Refusing to clean a different test run");
      await db.send(new DeleteCommand({ TableName: "SlowlyTasks", Key: { id }, ConditionExpression: "#v = :v AND #d.#r = :run", ExpressionAttributeNames: { "#v": "version", "#d": "data", "#r": "testRun" }, ExpressionAttributeValues: { ":v": item.version, ":run": runId } }));
    } catch (error) { errors.push({ id, name: error.name }); }
  }
  db.destroy();
  if (errors.length) throw new Error(`Cleanup incomplete for run ${runId}: ${JSON.stringify(errors)}`);
}
