/**
 * Local helpers. This folder must not import from elsewhere in the repo.
 */

export const COMMENT_SCOPES = ["page", "service", "home"];
export const COMMENTS_PREFIX = "comments/";
export const COMMENT_WRITE_RETRIES = 3;

export const DEFAULT_LIMITS = {
  body: 8000,
  pinnedBody: 256 * 1024,
  quote: 500,
};

const TARGET_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function limitsOf(config) {
  return { ...DEFAULT_LIMITS, ...(config?.limits || {}) };
}

export function cleanLine(raw, max) {
  return String(raw ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

export function normalizeBody(raw) {
  return String(raw ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function cleanBody(raw, max) {
  return normalizeBody(raw).trim().slice(0, max);
}

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

export function isCommentsStoreKey(raw) {
  const key = String(raw || "").replace(/^\/+/, "");
  return key === "comments" || key.startsWith(COMMENTS_PREFIX);
}

export function cleanQuote(raw, max = DEFAULT_LIMITS.quote) {
  if (raw == null || raw === "") return null;
  let text = String(raw).replace(/<[^>]*>/g, "");
  text = normalizeBody(text).trim();
  if (!text) return null;
  return text.slice(0, max);
}

export function byteLength(text) {
  return new TextEncoder().encode(String(text ?? "")).length;
}

export function bodyTooLarge(status = 413) {
  return Object.assign(new Error("body too large"), { status });
}

/** 8000 chars by default; pinned top-level comments may use the 256 KiB budget. */
export function assertBodySize(text, { pinned = false, parent_id = null, allowPinnedBudget = true } = {}, config) {
  const limits = limitsOf(config);
  if (String(text).length <= limits.body) return;
  if (allowPinnedBudget && pinned && !parent_id && byteLength(text) <= limits.pinnedBody) return;
  throw bodyTooLarge();
}

export function preserveBody(raw, max) {
  const text = normalizeBody(raw);
  if (max == null) return text;
  return text.length > max ? text.slice(0, max) : text;
}

export function bumpRev(prev, now = new Date()) {
  const n = Number(prev);
  if (Number.isInteger(n) && String(n) === String(prev).trim() && n >= 0) return String(n + 1);
  return now.toISOString();
}

export function seedRev(legacyEtag) {
  const raw = String(legacyEtag || "").trim();
  return raw || "1";
}

export function authorKindOf(identity) {
  if (!identity) return "agent";
  if (identity.via === "mcp") return "agent";
  if (identity.kind !== "human") return "agent";
  return "person";
}

export function isRestrictedCaller(identity) {
  return !identity || identity.via === "mcp" || identity.kind !== "human";
}

/** Empty, null and the sentinels "unknown" / "legacy" never identify an author. */
export function usableActor(value) {
  const v = String(value ?? "").trim();
  if (!v) return "";
  const lower = v.toLowerCase();
  if (lower === "unknown" || lower === "legacy") return "";
  return v;
}

export function hasWriteIdentity(identity) {
  return Boolean(usableActor(identity?.email) || usableActor(identity?.id));
}

export function serviceAuthor(raw) {
  const id = usableActor(raw);
  if (!id) return "";
  const trimmed = id.slice(0, 80);
  return /^svc:/i.test(trimmed) ? trimmed : `svc:${trimmed}`;
}

export function isSystemComment(comment) {
  return comment?.author_kind === "system" || String(comment?.author || "").trim().toLowerCase() === "legacy";
}

/** Human, non-MCP callers may use the pinned 256 KiB budget on edit. */
export function isHumanAuthor(identity) {
  return Boolean(identity && identity.kind === "human" && identity.via !== "mcp");
}
