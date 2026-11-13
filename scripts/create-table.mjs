import {
  DynamoDBClient,
  CreateTableCommand,
} from "@aws-sdk/client-dynamodb";

// 建立 DynamoDB 連線工具
const client = new DynamoDBClient({
  region: "ap-northeast-1",
  endpoint: "http://localhost:9000",
  credentials: {
    accessKeyId: "local",
    secretAccessKey: "local",
  },
});

// 定義資料表
const command = new CreateTableCommand({
  TableName: "SlowlyTasks",

  KeySchema: [
    {
      AttributeName: "id",
      KeyType: "HASH",
    },
  ],

  AttributeDefinitions: [
    {
      AttributeName: "id",
      AttributeType: "S",
    },
  ],

  BillingMode: "PAY_PER_REQUEST",
});

// 發送建立資料表的請求
try {
  const response = await client.send(command);

  console.log("資料表建立成功！");
  console.log(response.TableDescription?.TableName);
} catch (error) {
  if (error.name === "ResourceInUseException") {
    console.log("資料表已經存在！");
  } else {
    console.error("建立資料表失敗：", error);
    process.exitCode = 1;
  }
}