/** In-memory R2 stand-in for handler tests. list/get/put/head only. */
export function memoryBucket() {
  const store = new Map();
  const meta = new Map();

  const asBody = (value) => {
    if (typeof value === "string") return value;
    if (value instanceof Uint8Array) return new TextDecoder().decode(value);
    return String(value);
  };

  const etagFor = (body) => {
    let hash = 0;
    for (let i = 0; i < body.length; i++) hash = (Math.imul(31, hash) + body.charCodeAt(i)) >>> 0;
    return `"${hash.toString(16)}-${body.length}"`;
  };

  return {
    async put(key, value, opts = {}) {
      const body = asBody(value);
      const etag = etagFor(body);
      const existing = store.get(key);
      const onlyIf = opts.onlyIf;
      if (onlyIf) {
        if (onlyIf.etagMatches && (!existing || existing.etag !== onlyIf.etagMatches)) return null;
        if (onlyIf.etagDoesNotMatch === "*" && existing) return null;
      }
      store.set(key, { body, etag });
      if (opts.customMetadata) meta.set(key, { ...opts.customMetadata });
      return { key, etag, httpEtag: etag };
    },
    async get(key) {
      const row = store.get(key);
      if (!row) return null;
      return {
        key,
        etag: row.etag,
        httpEtag: row.etag,
        customMetadata: meta.get(key) || {},
        text: async () => row.body,
        json: async () => JSON.parse(row.body),
      };
    },
    async head(key) {
      const row = store.get(key);
      return row ? { key, etag: row.etag, httpEtag: row.etag } : null;
    },
    async delete(key) {
      store.delete(key);
      meta.delete(key);
    },
    async list({ prefix = "", limit = 1000, include = [] } = {}) {
      const objects = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .slice(0, limit)
        .map((key) => {
          const row = { key, etag: store.get(key).etag, httpEtag: store.get(key).etag };
          if (include.includes("customMetadata")) row.customMetadata = meta.get(key) || {};
          return row;
        });
      return { objects, truncated: false };
    },
  };
}
