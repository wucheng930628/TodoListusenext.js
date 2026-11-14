import "server-only";
import { createLocalDocumentClient } from "../local-dynamodb.mjs";
import { createMigrationService } from "./service.mjs";

export const migrations = createMigrationService(createLocalDocumentClient());
