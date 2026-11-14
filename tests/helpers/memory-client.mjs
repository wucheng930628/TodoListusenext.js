import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

function evaluate(expression, item, names = {}, values = {}) {
  const tokens = expression.match(/attribute_not_exists\([#\w]+\)|[#\w]+\s*=\s*:\w+|AND|OR|[()]/g) || [];
  let cursor = 0;
  function atom() {
    const token = tokens[cursor++];
    if (token === "(") { const value = or(); assert.equal(tokens[cursor++], ")"); return value; }
    if (token?.startsWith("attribute_not_exists")) { const key = token.slice(21, -1); return item?.[names[key] || key] === undefined; }
    const match = token?.match(/^([#\w]+)\s*=\s*(:\w+)$/); assert.ok(match, `Unsupported condition ${expression}`);
    return isDeepStrictEqual(item?.[names[match[1]] || match[1]], values[match[2]]);
  }
  function and() { let value = atom(); while (tokens[cursor] === "AND") { cursor++; const right = atom(); value = value && right; } return value; }
  function or() { let value = and(); while (tokens[cursor] === "OR") { cursor++; const right = and(); value = value || right; } return value; }
  const value = or(); assert.equal(cursor, tokens.length); return value;
}

// Transactional document-client double. Every test gets its own isolated instance.
export class MemoryClient {
  items = new Map();
  calls = [];
  beforeTransaction = null;
  afterTransaction = null;
  async send(command) {
    const input = structuredClone(command.input); const type = command.constructor.name;
    this.calls.push({ type, input });
    if (type === "GetCommand") return { Item: structuredClone(this.items.get(input.Key.id)) };
    if (type === "QueryCommand") {
      const all = [...this.items.values()].filter(item => item.gsi1pk === input.ExpressionAttributeValues[":parent"] && item.gsi1sk.startsWith(input.ExpressionAttributeValues[":type"])).sort((a, b) => a.gsi1sk.localeCompare(b.gsi1sk));
      const start = input.ExclusiveStartKey ? all.findIndex(item => item.id === input.ExclusiveStartKey.id) + 1 : 0;
      const page = all.slice(start, start + 1);
      return { Items: structuredClone(page), ...(start + 1 < all.length ? { LastEvaluatedKey: { id: page[0].id } } : {}) };
    }
    assert.equal(type, "TransactWriteCommand");
    if (this.beforeTransaction) await this.beforeTransaction(input);
    const actions = input.TransactItems.map(action => ({ kind: action.Put ? "put" : "delete", value: action.Put || action.Delete }));
    assert.equal(new Set(actions.map(({ value }) => value.Item?.id || value.Key.id)).size, actions.length);
    for (const { value } of actions) {
      const existing = this.items.get(value.Item?.id || value.Key.id);
      const valid = evaluate(value.ConditionExpression, existing, value.ExpressionAttributeNames, value.ExpressionAttributeValues);
      if (!valid) throw Object.assign(new Error("Condition failed"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }] });
    }
    for (const { kind, value } of actions) {
      if (kind === "put") this.items.set(value.Item.id, structuredClone(value.Item)); else this.items.delete(value.Key.id);
    }
    if (this.afterTransaction) await this.afterTransaction(input);
    return {};
  }
}
