import "server-only";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { DataError, requireValue, assertItemSize } from "../data-model.mjs";

export function migrationStore(db, tableName = "SlowlyTasks") {
  const get = async id => (await db.send(new GetCommand({ TableName: tableName, Key: { id }, ConsistentRead: true }))).Item;
  function condition(previous, target = false) {
    if (!previous) return { ConditionExpression: "attribute_not_exists(id)" };
    const names = {}; const values = {}; const clauses = [];
    // Target deletion/update compares the observed snapshot as well as version
    // and ownership. It never relies on a preflight ownership check alone.
    for (const [index, key] of (target ? Object.keys(previous) : ["version", "entityType"]).entries()) {
      names[`#c${index}`] = key; values[`:c${index}`] = previous[key]; clauses.push(`#c${index} = :c${index}`);
    }
    return { ConditionExpression: clauses.join(" AND "), ExpressionAttributeNames: names, ExpressionAttributeValues: values };
  }
  const put = (item, previous, target = false) => {
    assertItemSize(item);
    return { Put: { TableName: tableName, Item: item, ...condition(previous, target) } };
  };
  const remove = item => ({ Delete: { TableName: tableName, Key: { id: item.id }, ...condition(item, true) } });
  async function transact(actions) {
    requireValue(actions.length > 0 && actions.length <= 100 && new Set(actions.map(action => action.Put?.Item.id || action.Delete?.Key.id)).size === actions.length, "Invalid transaction actions");
    requireValue(Buffer.byteLength(JSON.stringify(actions)) < 3500000, "Transaction size exceeded");
    try { await db.send(new TransactWriteCommand({ TransactItems: actions })); }
    catch (error) {
      if (error.name === "ValidationException") throw new DataError("FAILED_WRITE", "Transaction rejected before commit", { cause: error });
      if (["ConditionalCheckFailedException", "TransactionConflictException"].includes(error.name) || (error.name === "TransactionCanceledException" && error.CancellationReasons?.some(reason => ["ConditionalCheckFailed", "TransactionConflict"].includes(reason.Code)))) throw new DataError("CONFLICT", "Concurrent state change", { cause: error });
      throw new DataError("STORAGE", "Migration storage failed", { cause: error });
    }
  }
  return { get, put, remove, transact };
}
