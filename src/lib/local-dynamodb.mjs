import "server-only";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export function localClientOptions(endpoint = process.env.DYNAMODB_ENDPOINT || "http://127.0.0.1:9000") {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "9000" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Phase 2 only permits DynamoDB Local on localhost:9000");
  }
  return {
    endpoint: url.origin,
    region: process.env.AWS_REGION || "ap-northeast-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || "local",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "local",
    },
  };
}
export function createLocalClient() { return new DynamoDBClient(localClientOptions()); }
export function createLocalDocumentClient() { return DynamoDBDocumentClient.from(createLocalClient()); }
