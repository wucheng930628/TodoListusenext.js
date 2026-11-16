// Separate from all localStorage keys. Opening is lazy and requires an explicit API action.
const fail = code => { throw Object.assign(new Error("操作恢復紀錄無法安全使用，已阻擋寫入。"), { code, outcome: "not-sent" }); };
export function validateRecovery(record) {
  if (record === null) return null;
  if (!record || record.formatVersion !== 1 || !/^[a-f0-9-]{36}$/.test(record.token || "") ||
    !/^SLOWLY#WORKSPACE#[a-f0-9-]{36}$/.test(record.workspaceId || "") ||
    !["create", "update", "delete", "reorder"].includes(record.action) ||
    (record.action === "create" && (!record.intent || record.intent.operationKey !== record.token || !["boards", "tasks", "widgets"].includes(record.intent.resource) || record.intent.input?.workspaceId !== record.workspaceId))) fail("INVALID_RECOVERY_RECORD");
  return structuredClone(record);
}
export function createRecoveryJournal({ indexedDB = () => globalThis.indexedDB, namespace = "formal" } = {}) {
  if (!["formal", "isolated"].includes(namespace)) fail("INVALID_RECOVERY_SCOPE");
  async function access(action, record) {
    const factory = indexedDB(); if (!factory) fail("RECOVERY_UNAVAILABLE");
    const db = await new Promise((resolve, reject) => {
      const request = factory.open(`slowly-api-recovery-v1-${namespace}`, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("operations");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(Object.assign(new Error("無法開啟操作恢復紀錄。"), { code: "RECOVERY_UNAVAILABLE" }));
      request.onblocked = () => reject(Object.assign(new Error("操作紀錄被其他分頁鎖住。"), { code: "RECOVERY_UNAVAILABLE" }));
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("operations", action === "load" ? "readonly" : "readwrite"); const store = tx.objectStore("operations");
        let result; let failure;
        const request = store.get("active");
        request.onsuccess = () => {
          try {
            const previous = validateRecovery(request.result ?? null);
            if (action === "claim") {
              validateRecovery(record);
              if (previous && JSON.stringify(previous) !== JSON.stringify(record)) fail("RECOVERY_REQUIRED");
              store.put(structuredClone(record), "active"); result = record;
            } else if (action === "clear") {
              if (previous && previous.token !== record) fail("RECOVERY_SCOPE_CONFLICT");
              store.delete("active"); result = null;
            } else result = previous;
          } catch (error) { failure = error; tx.abort(); }
        };
        tx.oncomplete = () => resolve(structuredClone(result));
        tx.onabort = tx.onerror = () => reject(failure || Object.assign(new Error("操作紀錄未完成，已阻擋寫入。"), { code: "RECOVERY_UNAVAILABLE", outcome: "not-sent" }));
      });
    } finally { db.close(); }
  }
  return { load: () => access("load"), claim: record => access("claim", record), clear: token => access("clear", token) };
}

// Only explicitly injected by unit tests; never selected as a browser fallback.
export function createMemoryRecoveryJournal() {
  let active = null;
  return { async load() { return structuredClone(active); }, async claim(record) { validateRecovery(record); if (active && JSON.stringify(active) !== JSON.stringify(record)) fail("RECOVERY_REQUIRED"); active = structuredClone(record); }, async clear(token) { if (active && active.token !== token) fail("RECOVERY_SCOPE_CONFLICT"); active = null; } };
}
