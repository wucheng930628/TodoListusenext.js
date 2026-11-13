import { DescribeTableCommand, UpdateTableCommand } from "@aws-sdk/client-dynamodb";
import { createLocalClient } from "../src/lib/local-dynamodb.mjs";
import { INDEX_NAME } from "../src/lib/data-model.mjs";

const client = createLocalClient();
try {
  const { Table: table } = await client.send(new DescribeTableCommand({ TableName: "SlowlyTasks" }));
  if (table.KeySchema.length !== 1 || table.KeySchema[0].AttributeName !== "id" || !table.AttributeDefinitions.some(a => a.AttributeName === "id" && a.AttributeType === "S")) throw new Error("Unexpected table key schema; no changes made");
  const existing = table.GlobalSecondaryIndexes?.find(index => index.IndexName === INDEX_NAME);
  if (existing) {
    const expected = { gsi1pk: "HASH", gsi1sk: "RANGE" };
    if (existing.KeySchema.length !== 2 || !existing.KeySchema.every(key => expected[key.AttributeName] === key.KeyType) || existing.Projection.ProjectionType !== "ALL" || !["gsi1pk", "gsi1sk"].every(name => table.AttributeDefinitions.some(a => a.AttributeName === name && a.AttributeType === "S"))) throw new Error("Existing index has an incompatible definition; no changes made");
    console.log(JSON.stringify({ table: "SlowlyTasks", index: INDEX_NAME, status: existing.IndexStatus, changed: false }));
  } else {
    const request = {
      TableName: "SlowlyTasks",
      AttributeDefinitions: [{ AttributeName: "gsi1pk", AttributeType: "S" }, { AttributeName: "gsi1sk", AttributeType: "S" }],
      GlobalSecondaryIndexUpdates: [{ Create: { IndexName: INDEX_NAME, KeySchema: [{ AttributeName: "gsi1pk", KeyType: "HASH" }, { AttributeName: "gsi1sk", KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" }, ...(table.BillingModeSummary?.BillingMode === "PAY_PER_REQUEST" ? {} : { ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 } }) } }],
    };
    console.log(JSON.stringify({ mode: process.argv.includes("--apply") ? "apply" : "read-only-plan", request }, null, 2));
    if (process.argv.includes("--apply")) {
      await client.send(new UpdateTableCommand(request));
      console.log("Index creation requested; run without --apply to inspect status.");
    }
  }
} finally { client.destroy(); }
