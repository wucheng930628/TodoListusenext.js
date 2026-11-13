import "server-only";

import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { db } from "@/lib/dynamodb";

export async function getTasks() {
  const tasks = [];
  let lastKey;

  do {
    const response = await db.send(
      new ScanCommand({
        TableName: "SlowlyTasks",
        ExclusiveStartKey: lastKey,
      })
    );

    tasks.push(...(response.Items ?? []));
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);

  return tasks;
}
