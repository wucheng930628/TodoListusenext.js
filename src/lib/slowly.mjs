import "server-only";
import { createLocalDocumentClient } from "./local-dynamodb.mjs";
import { createRepository } from "./slowly-repository.mjs";

// Explicit calls only. Importing this module never creates application records.
export const slowly = createRepository(createLocalDocumentClient());
