/**
 * Locked by Charlie Oct 19. Identity and admins are injected; this file
 * never reads Access, env, or hub.config itself.
 */

import { isRestrictedCaller } from "./util.js";

function norm(value) {
  return String(value || "").trim().toLowerCase();
}

export function isAdmin(identity, config) {
  const admins = config?.admins || [];
  const email = norm(identity?.email);
  const id = norm(identity?.id);
  return admins.some((entry) => {
    const admin = norm(entry);
    return Boolean(admin && (admin === email || admin === id));
  });
}

function sameAuthor(identity, comment) {
  const email = norm(identity?.email);
  const id = norm(identity?.id);
  const author = norm(comment?.author);
  return Boolean(author && (author === email || author === id));
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
 */
export function commentPolicy(action, { identity, comment, config }) {
  if (!identity?.id && !identity?.email) {
    return { ok: false, status: 403, error: "no identity on this request" };
  }

  if (action === "create") return { ok: true };

  if (action === "edit") {
    if (!comment) return { ok: false, status: 404, error: "not found" };
    if (comment.deleted_at) return { ok: false, status: 400, error: "deleted comments cannot be edited" };
    if (!sameAuthor(identity, comment)) return { ok: false, status: 403, error: "only the author can edit this comment" };
    return { ok: true };
  }

  if (action === "delete") {
    if (isRestrictedCaller(identity)) {
      return { ok: false, status: 403, error: "only a person can delete a comment" };
    }
    if (!comment) return { ok: false, status: 404, error: "not found" };
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
