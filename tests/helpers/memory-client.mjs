import assert from "node:assert/strict";

// Transactional document-client double. Every test gets its own isolated instance.
export class MemoryClient {
  items = new Map();
  calls = [];
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
    const actions = input.TransactItems.map(action => ({ kind: action.Put ? "put" : "delete", value: action.Put || action.Delete }));
    assert.equal(new Set(actions.map(({ value }) => value.Item?.id || value.Key.id)).size, actions.length);
    for (const { value } of actions) {
      const existing = this.items.get(value.Item?.id || value.Key.id);
      const valid = value.ConditionExpression === "attribute_not_exists(id)" ? !existing : existing && existing.version === value.ExpressionAttributeValues[":v"] && existing.entityType === value.ExpressionAttributeValues[":t"];
      if (!valid) throw Object.assign(new Error("Condition failed"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }] });
    }
    for (const { kind, value } of actions) {
      if (kind === "put") this.items.set(value.Item.id, structuredClone(value.Item)); else this.items.delete(value.Key.id);
    }
    return {};
  }
}
