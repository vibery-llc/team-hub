/**
 * Feedback items, pinned notes and agent note proposals.
 *
 * Stored as JSON in the same R2 bucket as files, under prefixes the file API
 * will not touch (`feedback/`, `notes/`). Pure helpers so the routes and the
 * MCP tools share one set of rules, and so the tests do not need a bucket.
 *
 * Agents may file feedback, comment, claim, and *propose* a note. They may
 * not pin a note or approve a proposal — those are browser-only (see
 * functions/_shared/origin.js `browserWrite`).
 */

export const FEEDBACK_STATUSES = ["open", "claimed", "done"];
export const PROPOSAL_STATUSES = ["pending", "approved", "rejected"];

export const FEEDBACK_PREFIX = "feedback/items/";
export const NOTES_PREFIX = "notes/pages/";
export const PROPOSALS_PREFIX = "notes/proposals/";

const PAGE_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Single-line, length-capped. Empty after trim is empty. */
export function cleanLine(raw, max) {
  return String(raw ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

/** Multiline body. Newlines kept; length-capped. */
export function cleanBody(raw, max) {
  return String(raw ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().slice(0, max);
}

/**
 * Hub page identity: "index.html", "/meetings", "Meetings" all become
 * "index" / "meetings". Anything that is not a short safe token is rejected
 * so a key cannot escape its prefix.
 */
export function cleanPageKey(raw) {
  let s = String(raw ?? "").trim().toLowerCase();
  if (!s || s.includes("..") || s.includes("\\")) return null;
  s = s.replace(/^[./]+/, "");
  s = s.split(/[?#]/)[0];
  s = s.replace(/\.html$/i, "");
  if (!s || s.includes("/") || s.length > 64 || !PAGE_RE.test(s)) return null;
  return s;
}

/** Stored object ids are the stamp we minted — no path separators. */
export function cleanId(raw) {
  const id = String(raw ?? "").trim();
  if (!id || id.length > 80) return null;
  if (!/^[A-Za-z0-9-]+$/.test(id)) return null;
  return id;
}

export function newId(now = new Date(), rand = "") {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const suffix = rand || (globalThis.crypto?.randomUUID?.() || "xxxxxxxx").slice(0, 8);
  return `${stamp}-${suffix}`;
}

export function feedbackKey(id) {
  return `${FEEDBACK_PREFIX}${id}.json`;
}

export function noteKey(page) {
  return `${NOTES_PREFIX}${page}.json`;
}

export function proposalKey(id) {
  return `${PROPOSALS_PREFIX}${id}.json`;
}

export function buildFeedback({ page, title, body }, identity, now = new Date(), rand = "") {
  const pageKey = cleanPageKey(page);
  if (!pageKey) throw new Error("page must be a hub page key, e.g. index or meetings");
  const t = cleanLine(title, 160);
  if (!t) throw new Error("title is required");
  const b = cleanBody(body, 4000);
  if (!b) throw new Error("body is required");
  return {
    id: newId(now, rand),
    page: pageKey,
    title: t,
    body: b,
    status: "open",
    createdBy: identity,
    createdAt: now.toISOString(),
    claimedBy: "",
    claimedAt: "",
    resolvedBy: "",
    resolvedAt: "",
    comments: [],
  };
}

export function claimFeedback(item, identity, now = new Date()) {
  if (!item || item.status === "done") throw new Error("resolved items cannot be claimed");
  if (item.status === "claimed" && item.claimedBy && item.claimedBy !== identity) {
    throw new Error(`already claimed by ${item.claimedBy}`);
  }
  return {
    ...item,
    status: "claimed",
    claimedBy: identity,
    claimedAt: now.toISOString(),
  };
}

export function releaseFeedback(item, identity) {
  if (!item || item.status !== "claimed") throw new Error("not claimed");
  if (item.claimedBy !== identity) throw new Error("only the claimant can release this item");
  return {
    ...item,
    status: "open",
    claimedBy: "",
    claimedAt: "",
  };
}

export function resolveFeedback(item, identity, now = new Date()) {
  if (!item) throw new Error("no such item");
  return {
    ...item,
    status: "done",
    resolvedBy: identity,
    resolvedAt: now.toISOString(),
  };
}

export function reopenFeedback(item) {
  if (!item || item.status !== "done") throw new Error("only resolved items can be reopened");
  return {
    ...item,
    status: item.claimedBy ? "claimed" : "open",
    resolvedBy: "",
    resolvedAt: "",
  };
}

export function addComment(item, body, identity, now = new Date(), rand = "") {
  if (!item) throw new Error("no such item");
  const text = cleanBody(body, 2000);
  if (!text) throw new Error("comment is required");
  const comment = {
    id: newId(now, rand),
    body: text,
    author: identity,
    createdAt: now.toISOString(),
  };
  return { ...item, comments: [...(item.comments || []), comment] };
}

export function buildNote(page, body, identity, now = new Date()) {
  const pageKey = cleanPageKey(page);
  if (!pageKey) throw new Error("page must be a hub page key, e.g. index or meetings");
  return {
    page: pageKey,
    body: cleanBody(body, 8000),
    updatedBy: identity,
    updatedAt: now.toISOString(),
  };
}

export function buildProposal({ page, body }, identity, now = new Date(), rand = "") {
  const pageKey = cleanPageKey(page);
  if (!pageKey) throw new Error("page must be a hub page key, e.g. index or meetings");
  const b = cleanBody(body, 8000);
  if (!b) throw new Error("body is required");
  return {
    id: newId(now, rand),
    page: pageKey,
    body: b,
    status: "pending",
    proposedBy: identity,
    proposedAt: now.toISOString(),
    reviewedBy: "",
    reviewedAt: "",
  };
}

export function approveProposal(proposal, identity, now = new Date()) {
  if (!proposal || proposal.status !== "pending") throw new Error("proposal is not pending");
  return {
    proposal: {
      ...proposal,
      status: "approved",
      reviewedBy: identity,
      reviewedAt: now.toISOString(),
    },
    note: buildNote(proposal.page, proposal.body, identity, now),
  };
}

export function rejectProposal(proposal, identity, now = new Date()) {
  if (!proposal || proposal.status !== "pending") throw new Error("proposal is not pending");
  return {
    ...proposal,
    status: "rejected",
    reviewedBy: identity,
    reviewedAt: now.toISOString(),
  };
}

/** Newest first; open/claimed before done, so the queue reads as work. */
export function sortFeedback(items) {
  const rank = { open: 0, claimed: 1, done: 2 };
  return [...items].sort((a, b) => {
    const ra = rank[a.status] ?? 9;
    const rb = rank[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });
}
