import "server-only";
import { GetCommand, TransactGetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { DataError, requireValue, assertItemSize } from "../data-model.mjs";

export function migrationStore(db, tableName = "SlowlyTasks") {
  const get = async id => (await db.send(new GetCommand({ TableName: tableName, Key: { id }, ConsistentRead: true }))).Item;
  const concurrent = error => ["ConditionalCheckFailedException", "TransactionConflictException"].includes(error.name) ||
    (error.name === "TransactionCanceledException" && error.CancellationReasons?.some(reason => ["ConditionalCheckFailed", "TransactionConflict"].includes(reason.Code)));
  async function getPair(first, second) {
    try {
      const { Responses } = await db.send(new TransactGetCommand({
        TransactItems: [first, second].map(id => ({ Get: { TableName: tableName, Key: { id } } })),
      }));
      requireValue(Responses?.length === 2, "Incomplete migration snapshot", "STORAGE");
      return Responses.map(response => response.Item);
    } catch (error) {
      if (concurrent(error)) throw new DataError("CONFLICT", "Concurrent state change", { cause: error });
      throw new DataError("STORAGE", "Migration snapshot read failed", { cause: error });
    }
  }
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
  const check = item => ({ ConditionCheck: { TableName: tableName, Key: { id: item.id }, ...condition(item, true) } });
  async function transact(actions) {
    requireValue(actions.length > 0 && actions.length <= 100 && new Set(actions.map(action => action.Put?.Item.id || action.Delete?.Key.id || action.ConditionCheck?.Key.id)).size === actions.length, "Invalid transaction actions");
    requireValue(Buffer.byteLength(JSON.stringify(actions)) < 3500000, "Transaction size exceeded");
    try { await db.send(new TransactWriteCommand({ TransactItems: actions })); }
    catch (error) {
      if (error.name === "ValidationException") throw new DataError("FAILED_WRITE", "Transaction rejected before commit", { cause: error });
      if (concurrent(error)) throw new DataError("CONFLICT", "Concurrent state change", { cause: error });
      throw new DataError("STORAGE", "Migration storage failed", { cause: error });
    }
  }
  return { get, getPair, put, remove, check, transact };
}
