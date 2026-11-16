// Adapter-level IndexedDB double. Browser engine behavior is not claimed by these tests.
export function indexedDbDouble() {
  const databases = new Map(); let closes = 0;
  return { databases, closes: () => closes,
    open(name) {
      const request = {};
      queueMicrotask(() => {
        const fresh = !databases.has(name); if (fresh) databases.set(name, new Map());
        const values = databases.get(name);
        request.result = { createObjectStore() {}, close() { closes++; }, transaction() {
          let aborted = false; const tx = { abort() { aborted = true; queueMicrotask(() => tx.onabort?.()); }, objectStore() { return {
            get(key) { const read = {}; queueMicrotask(() => { read.result = structuredClone(values.get(key)); read.onsuccess?.(); queueMicrotask(() => { if (!aborted) tx.oncomplete?.(); }); }); return read; },
            put(value, key) { values.set(key, structuredClone(value)); }, delete(key) { values.delete(key); },
          }; } }; return tx;
        } };
        if (fresh) request.onupgradeneeded?.(); request.onsuccess?.();
      }); return request;
    },
  };
}
