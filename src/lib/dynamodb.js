import "server-only";

import { createLocalDocumentClient } from "./local-dynamodb.mjs";

export const db = createLocalDocumentClient();
