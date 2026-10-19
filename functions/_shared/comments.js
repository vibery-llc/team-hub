/**
 * Team-hub glue around the vendorable comments core.
 *
 * Identity, Access, hub.config and HUB_ADMINS stay here. The core in
 * functions/_shared/hub-comments/ never imports those.
 */

import { browserWrite } from "./origin.js";
import { cleanLine, serviceAuthor, usableActor } from "./hub-comments/util.js";
export {
  hasWriteIdentity,
  isHumanAuthor,
  isSystemComment,
  serviceAuthor,
  usableActor,
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

/** Emails only. github:login and other non-email entries are dropped. */
function emailAdmins(entries) {
  return (entries || [])
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter((entry) => entry.includes("@"));
}

/** Comma-separated emails from HUB_ADMINS. github:login is ignored (future PR). */
export function parseHubAdmins(raw) {
  return emailAdmins(String(raw ?? "").split(","));
}

export function commentsConfig(config, envAdmins) {
  const raw = config?.comments || {};
  const fromConfig = Array.isArray(raw.admins) ? emailAdmins(raw.admins) : [];
  const fromEnv = Array.isArray(envAdmins) ? emailAdmins(envAdmins) : parseHubAdmins(envAdmins);
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

function jwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return {};
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) || {};
  } catch {
    return {};
  }
}

/**
 * Access (access.js) only returns email. A service token JWT has no
 * email; its stable id is common_name. We read that claim here without
 * changing Access. When Access is configured the JWT was already verified.
 */
export function accessClientId(request) {
  const payload = jwtPayload(request?.headers?.get?.("Cf-Access-Jwt-Assertion"));
  return String(payload.common_name || "").trim();
}

/**
 * Map a request onto the injected identity bag the core expects.
 * Browser same-site => kind human, via browser. Anything else (MCP, curl)
 * => via mcp. No email and no service-token id => empty id (writes 403).
 */
export function commentsIdentity(request, email, extra = {}) {
  const browser = browserWrite(request).ok;
  const actorEmail = usableActor(email);
  const clientId = usableActor(extra.id || extra.clientId || accessClientId(request));
  let id = "";
  if (actorEmail) id = actorEmail;
  else if (clientId) id = serviceAuthor(clientId);
  const via = extra.via || (browser ? "browser" : "mcp");
  const kind = extra.kind || (actorEmail && browser ? "human" : "agent");
  const label = browser ? "" : cleanLine(extra.agentName || extra.label || "", 80);
  return {
    id,
    email: actorEmail,
    kind,
    via,
    label,
  };
}

/** Test helper: a human browser actor vs an MCP/agent actor. */
export function describeActor(isPerson, email, agentName = "") {
  const id = usableActor(email);
  if (isPerson) return { id, email: id, kind: "human", via: "browser", label: "" };
  return { id, email: id, kind: "agent", via: "mcp", label: cleanLine(agentName, 80) };
}
