import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({
  region: "ap-northeast-1",
  endpoint: "http://localhost:9000",
  credentials: {
    accessKeyId: "local",
    secretAccessKey: "local",
  },
});

const db = DynamoDBDocumentClient.from(client);

try {
  const response = await db.send(
    new ScanCommand({
      TableName: "SlowlyTasks",
    })
  );

  console.log("目前的任務：");
  console.table(response.Items ?? []);
} catch (error) {
  console.error("查詢失敗：", error);
  process.exitCode = 1;
}
