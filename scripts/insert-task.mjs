
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

// 1. 建立 DynamoDB 連線
const client = new DynamoDBClient({
  region: "ap-northeast-1",
  endpoint: "http://localhost:9000",
  credentials: {
    accessKeyId: "local",
    secretAccessKey: "local",
  },
});

// 2. 建立 Document Client
const db = DynamoDBDocumentClient.from(client);

// 3. 準備一筆 Todo 任務
const task = {
  id: crypto.randomUUID(),
  title: "學習 DynamoDB",
  status: "todo",
  priority: "high",
  completed: false,
  createdAt: new Date().toISOString(),
};

// 4. 建立新增資料的命令
const command = new PutCommand({
  TableName: "SlowlyTasks",
  Item: task,
});

// 5. 發送請求
try {
  await db.send(command);
  console.log("新增任務成功！");
  console.log(task);
} catch (error) {
  console.error("新增失敗：", error);
  process.exitCode = 1;
}
