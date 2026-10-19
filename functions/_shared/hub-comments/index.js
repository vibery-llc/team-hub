/**
 * Vendorable hub comments core.
 *
 * Pure ESM. Do not import Access, identity.js, hub.config, or anything
 * else outside this folder. Callers inject
 * { bucket, identity:{id,email,kind,via}, config:{admins,limits}, now }.
 */

export {
  COMMENT_SCOPES,
  COMMENTS_PREFIX,
  COMMENT_WRITE_RETRIES,
  DEFAULT_LIMITS,
  authorKindOf,
  assertBodySize,
  bumpRev,
  cleanBody,
  cleanId,
  cleanLine,
  cleanQuote,
  cleanScope,
  cleanTargetId,
  commentsKey,
  isCommentsStoreKey,
  isRestrictedCaller,
  limitsOf,
  newId,
  preserveBody,
  seedRev,
} from "./util.js";

export {
  capabilitiesFor,
  commentPolicy,
  isAdmin,
  viewerFor,
} from "./policy.js";

export {
  addCommentToThread,
  buildComment,
  buildMigratedComment,
  compactPinOrder,
  editCommentInThread,
  emptyThread,
  findComment,
  hasLegacyRepoKey,
  pinCommentInThread,
  pinnedComments,
  presentComment,
  reorderPinsInThread,
  softDeleteCommentInThread,
  sortThreadComments,
  unpinCommentInThread,
} from "./model.js";

export {
  findCommentLocation,
  listCommentObjects,
  readThread,
  updateThread,
  writeThread,
} from "./store.js";

import { commentPolicy, viewerFor } from "./policy.js";
import { buildComment, presentComment } from "./model.js";
import { readThread, updateThread } from "./store.js";

export function createHubComments({ bucket, identity, config, now = new Date() } = {}) {
  return {
    identity,
    config,
    now,
    policy(action, comment) {
      return commentPolicy(action, { identity, comment, config });
    },
    present(comment) {
      return presentComment(comment, identity, config);
    },
    viewer() {
      return viewerFor(identity, config);
    },
    build(input, rand = "") {
      return buildComment(input, { identity, config, now, rand });
    },
    read(scope, targetId) {
      return readThread(bucket, scope, targetId);
    },
    update(scope, targetId, mutator) {
      return updateThread({ bucket }, scope, targetId, mutator);
    },
  };
}
