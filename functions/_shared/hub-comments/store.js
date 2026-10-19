import { COMMENT_WRITE_RETRIES, commentsKey } from "./util.js";
import { emptyThread, findComment } from "./model.js";

export async function readThread(bucket, scope, targetId) {
  const key = commentsKey(scope, targetId);
  const obj = await bucket.get(key);
  if (!obj) return { key, doc: emptyThread(), etag: null };
  return { key, doc: await obj.json(), etag: obj.httpEtag || obj.etag || null };
}

export async function writeThread(bucket, key, doc, etag) {
  const body = JSON.stringify(doc);
  const opts = {
    httpMetadata: { contentType: "application/json" },
    onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: "*" },
  };
  try {
    const result = await bucket.put(key, body, opts);
    if (result == null || result.uploaded === false) {
      return { ok: false, status: 409 };
    }
    return { ok: true, etag: result.httpEtag || result.etag || null };
  } catch (err) {
    const message = String(err?.message || err);
    if (/precondition|if-match|conflict|412|409/i.test(message)) {
      return { ok: false, status: 409 };
    }
    throw err;
  }
}

export async function updateThread({ bucket }, scope, targetId, mutator) {
  const key = commentsKey(scope, targetId);
  for (let attempt = 0; attempt < COMMENT_WRITE_RETRIES; attempt++) {
    const current = await readThread(bucket, scope, targetId);
    const next = mutator(current.doc);
    const last = await writeThread(bucket, key, next, current.etag);
    if (last.ok) return { key, doc: next };
  }
  throw Object.assign(new Error("comment store conflict"), { status: 409 });
}

export async function listCommentObjects(bucket) {
  const objects = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix: "comments/", cursor, limit: 1000 });
    for (const obj of page.objects) objects.push(obj);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

export async function findCommentLocation(bucket, id, hint) {
  if (hint?.scope && hint?.target_id) {
    const current = await readThread(bucket, hint.scope, hint.target_id);
    const comment = findComment(current.doc, id);
    if (comment) return { ...current, comment };
  }
  for (const obj of await listCommentObjects(bucket)) {
    const got = await bucket.get(obj.key);
    if (!got) continue;
    const doc = await got.json();
    const comment = findComment(doc, id);
    if (comment) {
      return {
        key: obj.key,
        doc,
        etag: got.httpEtag || got.etag || null,
        comment,
      };
    }
  }
  return null;
}
