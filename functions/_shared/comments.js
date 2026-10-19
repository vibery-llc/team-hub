/**
 * Team-hub glue around the vendorable comments core.
 *
 * Identity, Access, hub.config and HUB_ADMINS stay here. The core in
 * functions/_shared/hub-comments/ never imports those.
 */

import { browserWrite } from "./origin.js";
import { cleanLine } from "./hub-comments/util.js";
export {
  COMMENT_SCOPES,
  COMMENTS_PREFIX,
  COMMENT_WRITE_RETRIES,
  DEFAULT_LIMITS,
  addCommentToThread,
  assertBodySize,
  authorKindOf,
  buildComment,
  buildMigratedComment,
  bumpRev,
  capabilitiesFor,
  cleanQuote,
  cleanScope,
  cleanTargetId,
  commentPolicy,
  commentsKey,
  createHubComments,
  editCommentInThread,
  findCommentLocation,
  hasLegacyRepoKey,
  isAdmin,
  isCommentsStoreKey,
  pinCommentInThread,
  pinnedComments,
  presentComment,
  preserveBody,
  readThread,
  reorderPinsInThread,
  seedRev,
  softDeleteCommentInThread,
  sortThreadComments,
  unpinCommentInThread,
  updateThread,
  viewerFor,
} from "./hub-comments/index.js";

export const COMMENT_BODY_MAX = 8000;
export const COMMENT_QUOTE_MAX = 500;
export const COMMENT_PINNED_BODY_MAX = 256 * 1024;

/** Trusted tenant file. Used by the API when env.HUB_CONFIG is not injected. */
export function parseHubConfigSource(source) {
  const fn = new Function("globalThis", `${String(source || "")}\nreturn globalThis.HUB_CONFIG;`);
  return fn({}) || {};
}

/** Comma-separated emails or github:login values from HUB_ADMINS. */
export function parseHubAdmins(raw) {
  return String(raw ?? "")
    .split(",")
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter(Boolean);
}

export function commentsConfig(config, envAdmins) {
  const raw = config?.comments || {};
  const fromConfig = Array.isArray(raw.admins)
    ? raw.admins.map((email) => String(email || "").trim().toLowerCase()).filter(Boolean)
    : [];
  const fromEnv = Array.isArray(envAdmins) ? envAdmins.map((e) => String(e).trim().toLowerCase()).filter(Boolean) : parseHubAdmins(envAdmins);
  const admins = [...new Set([...fromConfig, ...fromEnv])];
  return {
    enabled: raw.enabled === true,
    admins,
    limits: {
      body: COMMENT_BODY_MAX,
      pinnedBody: COMMENT_PINNED_BODY_MAX,
      quote: COMMENT_QUOTE_MAX,
    },
  };
}

/**
 * Map a request onto the injected identity bag the core expects.
 * Browser same-site => kind human, via browser. Anything else (MCP, curl)
 * => via mcp. author_kind is derived inside the core.
 */
export function commentsIdentity(request, email, extra = {}) {
  const browser = browserWrite(request).ok;
  const id = String(extra.id || email || "").trim() || "unknown";
  const via = extra.via || (browser ? "browser" : "mcp");
  const kind = extra.kind || (browser ? "human" : "agent");
  const label = browser ? "" : cleanLine(extra.agentName || extra.label || "", 80);
  return {
    id,
    email: String(email || "").trim(),
    kind,
    via,
    label,
  };
}

/** Test helper: a human browser actor vs an MCP/agent actor. */
export function describeActor(isPerson, email, agentName = "") {
  const id = String(email || "").trim() || "unknown";
  if (isPerson) return { id, email: id, kind: "human", via: "browser", label: "" };
  return { id, email: id, kind: "agent", via: "mcp", label: cleanLine(agentName, 80) };
}
