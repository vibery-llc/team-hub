import {
  assertBodySize,
  authorKindOf,
  cleanBody,
  cleanId,
  cleanLine,
  cleanQuote,
  cleanScope,
  cleanTargetId,
  limitsOf,
  newId,
  preserveBody,
  bumpRev,
  seedRev,
  hasWriteIdentity,
  isHumanAuthor,
  usableActor,
} from "./util.js";
import { capabilitiesFor, isAdmin } from "./policy.js";

export function emptyThread() {
  return { comments: [] };
}

export function presentComment(comment, identity, config) {
  if (!comment) return comment;
  const shown = {
    ...comment,
    body: comment.deleted_at ? "" : comment.body,
    author_kind: comment.author_kind === "agent" ? "agent" : comment.author_kind === "system" ? "system" : "person",
    author_label: comment.author_label || "",
    via: comment.via || null,
    quote: comment.deleted_at ? null : (comment.quote || null),
    rev: comment.rev || "1",
    edited_by: comment.edited_by || null,
    proposal_id: comment.proposal_id || null,
  };
  if (identity && config) {
    const caps = capabilitiesFor(comment, identity, config);
    shown.can_edit = caps.can_edit;
    shown.can_delete = caps.can_delete;
    shown.can_pin = caps.can_pin;
  }
  return shown;
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

function commentFields(fields) {
  return {
    id: fields.id,
    scope: fields.scope,
    target_id: fields.targetId,
    parent_id: fields.parentId,
    author: fields.author,
    author_kind: fields.authorKind,
    author_label: fields.authorLabel || "",
    via: fields.via || null,
    body: fields.body,
    quote: fields.quote ?? null,
    created_at: fields.createdAt,
    edited_at: fields.editedAt ?? null,
    edited_by: fields.editedBy ?? null,
    deleted_at: fields.deletedAt ?? null,
    deleted_by: fields.deletedBy ?? null,
    pinned: fields.pinned ?? false,
    pinned_at: fields.pinnedAt ?? null,
    pinned_by: fields.pinnedBy ?? null,
    pin_order: fields.pinOrder ?? null,
    run_of_show_item: fields.runOfShowItem ?? null,
    rev: fields.rev ?? "1",
    proposal_id: fields.proposalId ?? null,
    legacy: fields.legacy ?? null,
  };
}

export function buildComment(input, { identity, config, now = new Date(), rand = "" } = {}) {
  const scope = cleanScope(input?.scope);
  const targetId = cleanTargetId(scope, input?.target_id);
  if (!scope || !targetId) throw new Error("scope must be page, service or home, with a target_id");
  const pinned = input?.pinned === true && !input?.parent_id;
  const prepared = cleanBody(input?.body, Number.MAX_SAFE_INTEGER);
  if (!prepared) throw new Error("body is required");
  assertBodySize(prepared, { pinned, parent_id: input?.parent_id || null }, config);
  if (!hasWriteIdentity(identity)) {
    throw Object.assign(new Error("no identity on this request"), { status: 403 });
  }
  const author = usableActor(identity.email) || usableActor(identity.id);
  let runOfShowItem = null;
  if (input?.run_of_show_item != null && input.run_of_show_item !== "") {
    runOfShowItem = cleanLine(String(input.run_of_show_item), 120);
  }
  let proposalId = null;
  if (input?.proposal_id) proposalId = cleanId(input.proposal_id);
  const limits = limitsOf(config);
  return commentFields({
    id: newId(now, rand),
    scope,
    targetId,
    parentId: input?.parent_id ?? null,
    author,
    authorKind: authorKindOf(identity),
    authorLabel: authorKindOf(identity) === "agent" ? (identity.label || "") : "",
    via: identity.via || null,
    body: prepared,
    quote: cleanQuote(input?.quote, limits.quote),
    createdAt: now.toISOString(),
    pinned,
    pinnedAt: pinned ? now.toISOString() : null,
    pinnedBy: pinned ? (identity.email || identity.id) : null,
    pinOrder: pinned ? 0 : null,
    runOfShowItem,
    rev: "1",
    proposalId,
    legacy: null,
  });
}

export function buildMigratedComment(mapped, { now = new Date(), rand = "", config } = {}) {
  const scope = cleanScope(mapped?.scope);
  const targetId = cleanTargetId(scope, mapped?.target_id);
  if (!scope || !targetId) throw new Error("scope must be page, service or home, with a target_id");
  const pinned = mapped?.pinned === true;
  const body = preserveBody(mapped?.body);
  if (!body) throw new Error("body is required");
  assertBodySize(body, { pinned, parent_id: null, allowPinnedBudget: pinned }, config);
  const rawAuthor = cleanLine(mapped?.author, 200);
  const hasAuthor = Boolean(usableActor(rawAuthor));
  const author = hasAuthor ? rawAuthor : "legacy";
  const authorKind = hasAuthor ? "person" : "system";
  const createdAt = mapped?.created_at || now.toISOString();
  const legacyEtag = String(mapped?.etag_or_updatedAt || createdAt);
  return commentFields({
    id: newId(typeof createdAt === "string" ? new Date(createdAt) : now, rand),
    scope,
    targetId,
    parentId: null,
    author,
    authorKind,
    authorLabel: "",
    via: "migration",
    body,
    createdAt,
    pinned,
    pinnedAt: pinned ? (mapped?.pinned_at || createdAt) : null,
    pinnedBy: pinned ? (mapped?.pinned_by || author) : null,
    pinOrder: pinned ? 0 : null,
    rev: seedRev(legacyEtag),
    proposalId: mapped?.proposal_id || null,
    legacy: {
      repo_key: String(mapped?.repo_key || ""),
      etag_or_updatedAt: legacyEtag,
    },
  });
}

export function addCommentToThread(doc, comment) {
  const thread = { comments: [...(doc?.comments || [])] };
  comment.parent_id = parentOf(thread, comment.parent_id);
  thread.comments.push(comment);
  thread.comments = compactPinOrder(thread.comments);
  return thread;
}

export function editCommentInThread(doc, id, body, { identity, config, now = new Date() } = {}, extra = {}) {
  return mapComment(doc, id, (comment) => {
    if (comment.deleted_at) throw new Error("deleted comments cannot be edited");
    const prepared = cleanBody(body, Number.MAX_SAFE_INTEGER);
    if (!prepared) throw new Error("body is required");
    const allowPinnedBudget = isAdmin(identity, config) || isHumanAuthor(identity);
    assertBodySize(prepared, {
      pinned: comment.pinned,
      parent_id: comment.parent_id,
      allowPinnedBudget,
    }, config);
    const next = {
      ...comment,
      body: prepared,
      edited_at: now.toISOString(),
      edited_by: identity?.email || identity?.id || null,
      rev: bumpRev(comment.rev, now),
    };
    if (Object.hasOwn(extra, "quote")) next.quote = cleanQuote(extra.quote, limitsOf(config).quote);
    if (Object.hasOwn(extra, "proposal_id")) next.proposal_id = extra.proposal_id ? cleanId(extra.proposal_id) : null;
    return next;
  });
}

export function softDeleteCommentInThread(doc, id, { identity, now = new Date() } = {}) {
  return mapComment(doc, id, (comment) => {
    if (comment.deleted_at) return comment;
    return {
      ...comment,
      deleted_at: now.toISOString(),
      deleted_by: identity?.email || identity?.id || null,
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

export function pinCommentInThread(doc, id, { identity, now = new Date() } = {}) {
  return mapComment(doc, id, (comment, comments) => {
    if (comment.parent_id) throw new Error("only a top-level comment can be pinned");
    if (comment.deleted_at) throw new Error("deleted comments cannot be pinned");
    if (comment.pinned) return comment;
    return {
      ...comment,
      pinned: true,
      pinned_at: now.toISOString(),
      pinned_by: identity?.email || identity?.id || null,
      pin_order: nextPinOrder(comments),
    };
  });
}

export function unpinCommentInThread(doc, id, config) {
  const limits = limitsOf(config);
  const next = mapComment(doc, id, (comment) => {
    if (!comment.pinned) return comment;
    if (String(comment.body || "").length > limits.body) {
      throw Object.assign(
        new Error("trim the body below 8000 characters before unpinning"),
        { status: 409 },
      );
    }
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
