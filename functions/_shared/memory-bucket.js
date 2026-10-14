/** In-memory R2 stand-in for handler tests. list/get/put/head only. */
export function memoryBucket() {
  const store = new Map();
  return {
    async put(key, value) {
      const body = typeof value === "string"
        ? value
        : value instanceof Uint8Array
          ? new TextDecoder().decode(value)
          : String(value);
      store.set(key, body);
    },
    async get(key) {
      if (!store.has(key)) return null;
      const body = store.get(key);
      return {
        key,
        text: async () => body,
        json: async () => JSON.parse(body),
      };
    },
    async head(key) {
      return store.has(key) ? { key } : null;
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = "", limit = 1000 } = {}) {
      const objects = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .slice(0, limit)
        .map((key) => ({ key }));
      return { objects, truncated: false };
    },
  };
}
