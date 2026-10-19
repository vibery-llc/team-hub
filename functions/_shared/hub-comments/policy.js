/**
 * Locked by Charlie Oct 19. Identity and admins are injected; this file
 * never reads Access, env, or hub.config itself.
 *
 * Admins are emails only. github:login is ignored here; wiring that up
 * is a separate future PR. The identity bag is currently email-only
 * plus an optional service-token id (svc:<id>).
 */

import { hasWriteIdentity, isHumanAuthor, isRestrictedCaller, isSystemComment, usableActor } from "./util.js";

function norm(value) {
  return usableActor(value).toLowerCase();
}

export function isAdmin(identity, config) {
  const admins = config?.admins || [];
  const email = norm(identity?.email);
  const id = norm(identity?.id);
  return admins.some((entry) => {
    const admin = norm(entry);
    if (!admin || !admin.includes("@")) return false;
    return Boolean((email && admin === email) || (id && admin === id));
  });
}

function sameAuthor(identity, comment) {
  const email = norm(identity?.email);
  const id = norm(identity?.id);
  const author = norm(comment?.author);
  if (!author || (!email && !id)) return false;
  return author === email || author === id;
}

/** 256 KiB on a pinned edit: human browser, and admin or author. */
export function allowPinnedBodyBudget(identity, comment, config) {
  return isHumanAuthor(identity) && (isAdmin(identity, config) || sameAuthor(identity, comment));
}

/**
 * Locked by Charlie Oct 19.
 *
 *   1. Agents/MCP may post a comment. author_kind is "agent" when
 *      identity.kind !== "human" or via === "mcp". They can never pin,
 *      unpin, reorder or delete.
 *   2. Pin, unpin and reorder are admin-only. Delete is admin or the
 *      comment's own author. Both require a human identity that did not
 *      arrive via MCP.
 *   3. A long service note becomes one pinned top-level comment.
 *   4. Writes with no email fail closed unless a stable service-token
 *      id is present. sameAuthor never matches empty, null, "unknown"
 *      or "legacy". Migrated notes with author "legacy" / author_kind
 *      "system" are admin-only to edit or delete.
 *   5. A pinned comment's body is edited directly only by an admin or
 *      its author. Everyone else must propose (proposal_id). Approve
 *      stays a later slice; this PR refuses the direct edit.
 */
export function commentPolicy(action, { identity, comment, config }) {
  if (!hasWriteIdentity(identity)) {
    return { ok: false, status: 403, error: "no identity on this request" };
  }

  if (action === "create") return { ok: true };

  if (action === "edit") {
    if (!comment) return { ok: false, status: 404, error: "not found" };
    if (comment.deleted_at) return { ok: false, status: 400, error: "deleted comments cannot be edited" };
    if (isSystemComment(comment)) {
      if (isRestrictedCaller(identity) || !isAdmin(identity, config)) {
        return { ok: false, status: 403, error: "only an admin can edit a migrated note" };
      }
      return { ok: true };
    }
    const authorOk = sameAuthor(identity, comment);
    const adminOk = isAdmin(identity, config) && !isRestrictedCaller(identity);
    if (comment.pinned) {
      if (authorOk || adminOk) return { ok: true };
      return { ok: false, status: 403, error: "only an admin or the author can edit a pinned comment" };
    }
    if (!authorOk) return { ok: false, status: 403, error: "only the author can edit this comment" };
    return { ok: true };
  }

  if (action === "delete") {
    if (isRestrictedCaller(identity)) {
      return { ok: false, status: 403, error: "only a person can delete a comment" };
    }
    if (!comment) return { ok: false, status: 404, error: "not found" };
    if (isSystemComment(comment)) {
      if (!isAdmin(identity, config)) {
        return { ok: false, status: 403, error: "only an admin can delete a migrated note" };
      }
      return { ok: true };
    }
    if (!(isAdmin(identity, config) || sameAuthor(identity, comment))) {
      return { ok: false, status: 403, error: "only an admin or the author can delete this comment" };
    }
    return { ok: true };
  }

  if (action === "pin" || action === "unpin" || action === "reorder") {
    if (isRestrictedCaller(identity)) {
      return { ok: false, status: 403, error: `only a person can ${action} a comment` };
    }
    if (!isAdmin(identity, config)) {
      return { ok: false, status: 403, error: `only an admin can ${action} a comment` };
    }
    if ((action === "pin" || action === "unpin") && !comment) {
      return { ok: false, status: 404, error: "not found" };
    }
    return { ok: true };
  }

  return { ok: false, status: 400, error: `unknown action ${action}` };
}

export function viewerFor(identity, config) {
  return {
    can_pin: commentPolicy("pin", { identity, comment: { id: "viewer" }, config }).ok,
    is_admin: isAdmin(identity, config),
  };
}

export function capabilitiesFor(comment, identity, config) {
  const pinnable = Boolean(comment && !comment.parent_id && !comment.deleted_at);
  return {
    can_edit: commentPolicy("edit", { identity, comment, config }).ok,
    can_delete: commentPolicy("delete", { identity, comment, config }).ok,
    can_pin: pinnable && commentPolicy("pin", { identity, comment, config }).ok,
  };
}
