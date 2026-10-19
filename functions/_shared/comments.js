/**
 * Unified comments on a page, a service, or the home thread.
 *
 * One JSON document per {scope, target_id} in the same R2 bucket as files,
 * under `comments/` (a prefix the file API will not touch). Writes are
 * etag-conditional with a bounded retry so two people commenting on the
 * same thread do not silently clobber each other.
 *
 * Who may pin or delete is still an open Charlie question. The proposed
 * defaults live in `commentPolicy` and `site/hub.config.js` `comments.admins`
 * so they can change in one place.
 */

import { cleanBody, cleanId, cleanLine, newId } from "./collaborate.js";

export const COMMENTS_PREFIX = "comments/";
export const COMMENT_SCOPES = ["page", "service", "home"];
export const COMMENT_BODY_MAX = 8000;
export const COMMENT_WRITE_RETRIES = 3;

const TARGET_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function commentsConfig(config) {
  const raw = config?.comments || {};
  const admins = Array.isArray(raw.admins)
    ? raw.admins.map((email) => String(email || "").trim().toLowerCase()).filter(Boolean)
    : [];
  return {
    enabled: raw.enabled === true,
    admins,
  };
}

/** Trusted tenant file. Used by the API when env.HUB_CONFIG is not injected. */
export function parseHubConfigSource(source) {
  const fn = new Function("globalThis", `${String(source || "")}\nreturn globalThis.HUB_CONFIG;`);
  return fn({}) || {};
}

export function isCommentsStoreKey(raw) {
  const key = String(raw || "").replace(/^\/+/, "");
  return key === "comments" || key.startsWith(COMMENTS_PREFIX);
}

export function cleanScope(raw) {
  const scope = String(raw || "").trim().toLowerCase();
  return COMMENT_SCOPES.includes(scope) ? scope : null;
}

export function cleanTargetId(scope, raw) {
  let value = String(raw ?? "").trim().toLowerCase();
  if (scope === "home") {
    if (!value || value === "home" || value === "index") return "home";
    return null;
  }
  if (!value || value.includes("..") || value.includes("\\") || value.includes("/")) return null;
  value = value.replace(/\.html$/i, "");
  if (!value || value.length > 128 || !TARGET_RE.test(value)) return null;
  return value;
}

export function commentsKey(scope, targetId) {
  const s = cleanScope(scope);
  const t = cleanTargetId(s, targetId);
  if (!s || !t) throw new Error("scope and target_id are required");
  return `${COMMENTS_PREFIX}${s}/${t}.json`;
}

export function emptyThread(scope, targetId) {
  return { comments: [] };
}

/** Person vs agent. The browser signal is decided by the caller; this only labels it. */
export function describeActor(isPerson, identity, agentName = "") {
  const email = String(identity || "").trim() || "unknown";
  if (isPerson) return { kind: "person", email, label: "" };
  return { kind: "agent", email, label: cleanLine(agentName, 80) };
}

function isAdmin(actor, settings) {
  const email = String(actor?.email || "").trim().toLowerCase();
  return Boolean(email && settings?.admins?.includes(email));
}

function sameAuthor(actor, comment) {
  const email = String(actor?.email || "").trim().toLowerCase();
  const author = String(comment?.author || "").trim().toLowerCase();
  return Boolean(email && author && email === author);
}

/**
 * Proposed defaults, pending Charlie. Change this function (and comments.admins)
 * rather than scattering pin/delete rules across routes.
 *
 *   1. Agents/MCP may post a comment, stored with author_kind "agent".
 *      They can never pin, unpin, reorder or delete.
 *   2. Pin, unpin and reorder are admin-only. Delete is admin or the
 *      comment's own author. Both are person-only.
 */
export function commentPolicy(action, { actor, comment, settings }) {
  if (!settings?.enabled) return { ok: false, status: 404, error: "not found" };
  if (!actor?.email) return { ok: false, status: 403, error: "no identity on this request" };

  if (action === "create") return { ok: true };

  if (action === "edit") {
    if (!comment) return { ok: false, status: 404, error: "not found" };
    if (comment.deleted_at) return { ok: false, status: 400, error: "deleted comments cannot be edited" };
    if (!sameAuthor(actor, comment)) return { ok: false, status: 403, error: "only the author can edit this comment" };
    return { ok: true };
  }

  if (action === "delete") {
    if (actor.kind !== "person") return { ok: false, status: 403, error: "only a person can delete a comment" };
    if (!comment) return { ok: false, status: 404, error: "not found" };
    if (!(isAdmin(actor, settings) || sameAuthor(actor, comment))) {
      return { ok: false, status: 403, error: "only an admin or the author can delete this comment" };
    }
    return { ok: true };
  }

  if (action === "pin" || action === "unpin" || action === "reorder") {
    if (actor.kind !== "person") {
      return { ok: false, status: 403, error: `only a person can ${action} a comment` };
    }
    if (!isAdmin(actor, settings)) {
      return { ok: false, status: 403, error: `only an admin can ${action} a comment` };
    }
    if ((action === "pin" || action === "unpin") && !comment) {
      return { ok: false, status: 404, error: "not found" };
    }
    return { ok: true };
  }

  return { ok: false, status: 400, error: `unknown action ${action}` };
}

export function presentComment(comment) {
  if (!comment) return comment;
  if (!comment.deleted_at) return comment;
  return { ...comment, body: "" };
}

function parentOf(doc, parentId) {
  if (parentId == null || parentId === "") return null;
  const id = cleanId(parentId);
  if (!id) throw new Error("bad parent_id");
  const parent = (doc.comments || []).find((item) => item.id === id);
  if (!parent) throw new Error("parent comment not found");
  if (parent.parent_id) throw new Error("replies go one level deep only");
  if (parent.deleted_at) throw new Error("cannot reply to a deleted comment");
  return id;
}

function commentFields({
  id,
  scope,
  targetId,
  parentId,
  author,
  authorKind,
  authorLabel,
  body,
  createdAt,
  editedAt = null,
  deletedAt = null,
  deletedBy = null,
  pinned = false,
  pinnedAt = null,
  pinnedBy = null,
  pinOrder = null,
  runOfShowItem = null,
  legacy = null,
}) {
  return {
    id,
    scope,
    target_id: targetId,
    parent_id: parentId,
    author,
    author_kind: authorKind,
    author_label: authorLabel || "",
    body,
    created_at: createdAt,
    edited_at: editedAt,
    deleted_at: deletedAt,
    deleted_by: deletedBy,
    pinned,
    pinned_at: pinnedAt,
    pinned_by: pinnedBy,
    pin_order: pinOrder,
    run_of_show_item: runOfShowItem,
    legacy,
  };
}

export function buildComment(input, actor, now = new Date(), rand = "") {
  const scope = cleanScope(input?.scope);
  const targetId = cleanTargetId(scope, input?.target_id);
  if (!scope || !targetId) throw new Error("scope must be page, service or home, with a target_id");
  const body = cleanBody(input?.body, COMMENT_BODY_MAX);
  if (!body) throw new Error("body is required");
  if (!actor?.email) throw new Error("author is required");
  let runOfShowItem = null;
  if (input?.run_of_show_item != null && input.run_of_show_item !== "") {
    runOfShowItem = cleanLine(String(input.run_of_show_item), 120);
  }
  return commentFields({
    id: newId(now, rand),
    scope,
    targetId,
    parentId: input?.parent_id ?? null,
    author: actor.email,
    authorKind: actor.kind === "agent" ? "agent" : "person",
    authorLabel: actor.kind === "agent" ? (actor.label || "") : "",
    body,
    createdAt: now.toISOString(),
    runOfShowItem,
    legacy: null,
  });
}

/** Migration keeps the source body bytes (capped) so the report can prove they match. */
export function preserveBody(raw, max = COMMENT_BODY_MAX) {
  const text = String(raw ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return text.length > max ? text.slice(0, max) : text;
}

export function buildMigratedComment(mapped, now = new Date(), rand = "") {
  const scope = cleanScope(mapped?.scope);
  const targetId = cleanTargetId(scope, mapped?.target_id);
  if (!scope || !targetId) throw new Error("scope must be page, service or home, with a target_id");
  const body = preserveBody(mapped?.body);
  if (!body) throw new Error("body is required");
  const author = cleanLine(mapped?.author, 200) || "unknown";
  const createdAt = mapped?.created_at || now.toISOString();
  const pinned = mapped?.pinned === true;
  return commentFields({
    id: newId(typeof createdAt === "string" ? new Date(createdAt) : now, rand),
    scope,
    targetId,
    parentId: null,
    author,
    authorKind: "person",
    authorLabel: "",
    body,
    createdAt,
    pinned,
    pinnedAt: pinned ? (mapped?.pinned_at || createdAt) : null,
    pinnedBy: pinned ? (mapped?.pinned_by || author) : null,
    pinOrder: pinned ? Number(mapped?.pin_order ?? 0) : null,
    legacy: {
      repo_key: String(mapped?.repo_key || ""),
      etag_or_updatedAt: String(mapped?.etag_or_updatedAt || createdAt),
    },
  });
}

export function addCommentToThread(doc, comment) {
  const thread = { comments: [...(doc?.comments || [])] };
  comment.parent_id = parentOf(thread, comment.parent_id);
  thread.comments.push(comment);
  return thread;
}

export function editCommentInThread(doc, id, body, now = new Date()) {
  const text = cleanBody(body, COMMENT_BODY_MAX);
  if (!text) throw new Error("body is required");
  return mapComment(doc, id, (comment) => {
    if (comment.deleted_at) throw new Error("deleted comments cannot be edited");
    return { ...comment, body: text, edited_at: now.toISOString() };
  });
}

export function softDeleteCommentInThread(doc, id, actor, now = new Date()) {
  return mapComment(doc, id, (comment) => {
    if (comment.deleted_at) return comment;
    return {
      ...comment,
      deleted_at: now.toISOString(),
      deleted_by: actor.email,
      pinned: false,
      pinned_at: null,
      pinned_by: null,
      pin_order: null,
    };
  });
}

function nextPinOrder(comments) {
  let max = -1;
  for (const item of comments) {
    if (item.pinned && item.pin_order != null && Number.isFinite(Number(item.pin_order))) {
      max = Math.max(max, Number(item.pin_order));
    }
  }
  return max + 1;
}

export function pinCommentInThread(doc, id, actor, now = new Date()) {
  return mapComment(doc, id, (comment, comments) => {
    if (comment.parent_id) throw new Error("only a top-level comment can be pinned");
    if (comment.deleted_at) throw new Error("deleted comments cannot be pinned");
    if (comment.pinned) return comment;
    return {
      ...comment,
      pinned: true,
      pinned_at: now.toISOString(),
      pinned_by: actor.email,
      pin_order: nextPinOrder(comments),
    };
  });
}

export function unpinCommentInThread(doc, id) {
  const next = mapComment(doc, id, (comment) => {
    if (!comment.pinned) return comment;
    return {
      ...comment,
      pinned: false,
      pinned_at: null,
      pinned_by: null,
      pin_order: null,
    };
  });
  return { comments: compactPinOrder(next.comments) };
}

export function reorderPinsInThread(doc, order) {
  const ids = Array.isArray(order) ? order.map((id) => cleanId(id)).filter(Boolean) : [];
  if (!ids.length) throw new Error("order must be a list of pinned comment ids");
  const comments = [...(doc.comments || [])];
  const pinned = comments.filter((item) => item.pinned && !item.parent_id && !item.deleted_at);
  const byId = new Map(pinned.map((item) => [item.id, item]));
  for (const id of ids) {
    if (!byId.has(id)) throw new Error("order may only name pinned top-level comments");
  }
  const seen = new Set();
  const ranked = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    ranked.push(byId.get(id));
  }
  for (const item of pinned) {
    if (!seen.has(item.id)) ranked.push(item);
  }
  const pinOrder = new Map(ranked.map((item, index) => [item.id, index]));
  return {
    comments: comments.map((item) => (
      pinOrder.has(item.id) ? { ...item, pin_order: pinOrder.get(item.id) } : item
    )),
  };
}

export function compactPinOrder(comments) {
  const pinned = comments
    .filter((item) => item.pinned && !item.parent_id && !item.deleted_at)
    .sort((a, b) => Number(a.pin_order ?? 0) - Number(b.pin_order ?? 0));
  const pinOrder = new Map(pinned.map((item, index) => [item.id, index]));
  return comments.map((item) => (
    pinOrder.has(item.id) ? { ...item, pin_order: pinOrder.get(item.id) } : item
  ));
}

function mapComment(doc, id, fn) {
  const comments = [...(doc?.comments || [])];
  const index = comments.findIndex((item) => item.id === id);
  if (index < 0) throw Object.assign(new Error("not found"), { status: 404 });
  comments[index] = fn(comments[index], comments);
  return { comments };
}

export function sortThreadComments(comments) {
  const list = [...(comments || [])];
  const tops = list
    .filter((item) => !item.parent_id)
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  const out = [];
  for (const top of tops) {
    out.push(top);
    const replies = list
      .filter((item) => item.parent_id === top.id)
      .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    out.push(...replies);
  }
  return out;
}

export function pinnedComments(comments) {
  return (comments || [])
    .filter((item) => item.pinned && !item.parent_id && !item.deleted_at)
    .sort((a, b) => Number(a.pin_order ?? 0) - Number(b.pin_order ?? 0) || String(a.created_at || "").localeCompare(String(b.created_at || "")));
}

export function hasLegacyRepoKey(doc, repoKey) {
  if (!repoKey) return false;
  return (doc?.comments || []).some((item) => item.legacy?.repo_key === repoKey);
}

export function findComment(doc, id) {
  return (doc?.comments || []).find((item) => item.id === id) || null;
}

export async function readThread(bucket, scope, targetId) {
  const key = commentsKey(scope, targetId);
  const obj = await bucket.get(key);
  if (!obj) return { key, doc: emptyThread(scope, targetId), etag: null };
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

export async function updateThread(bucket, scope, targetId, mutator) {
  const key = commentsKey(scope, targetId);
  let last = { ok: false, status: 409 };
  for (let attempt = 0; attempt < COMMENT_WRITE_RETRIES; attempt++) {
    const current = await readThread(bucket, scope, targetId);
    const next = mutator(current.doc);
    last = await writeThread(bucket, key, next, current.etag);
    if (last.ok) return { key, doc: next };
  }
  throw Object.assign(new Error("comment store conflict"), { status: 409 });
}

export async function listCommentObjects(bucket) {
  const objects = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix: COMMENTS_PREFIX, cursor, limit: 1000 });
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
