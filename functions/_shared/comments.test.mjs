import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { memoryBucket } from "./memory-bucket.js";
import {
  COMMENT_WRITE_RETRIES,
  addCommentToThread,
  buildComment,
  buildMigratedComment,
  commentPolicy,
  commentsConfig,
  commentsKey,
  describeActor,
  editCommentInThread,
  hasLegacyRepoKey,
  isCommentsStoreKey,
  parseHubConfigSource,
  pinCommentInThread,
  pinnedComments,
  presentComment,
  preserveBody,
  reorderPinsInThread,
  softDeleteCommentInThread,
  sortThreadComments,
  unpinCommentInThread,
  updateThread,
} from "./comments.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const PERSON = describeActor(true, "dev@example.com");
const AGENT = describeActor(false, "bot@example.com", "Atlas Agent");
const ADMIN = describeActor(true, "admin@example.com");
const SETTINGS = commentsConfig({ comments: { enabled: true, admins: ["admin@example.com"] } });

function topLevel(body = "Welcome home", extra = {}) {
  return buildComment({ scope: "home", target_id: "home", body, ...extra }, PERSON, NOW, "aaaa1111");
}

test("commentsConfig is off until a human sets enabled, and admins are lowercased", () => {
  assert.deepEqual(commentsConfig({}), { enabled: false, admins: [] });
  assert.deepEqual(commentsConfig({ comments: { enabled: false, admins: ["Admin@Example.com"] } }), {
    enabled: false,
    admins: ["admin@example.com"],
  });
  assert.equal(commentsConfig({ comments: { enabled: true } }).enabled, true);
});

test("parseHubConfigSource reads the tenant file's HUB_CONFIG assignment", () => {
  const config = parseHubConfigSource("globalThis.HUB_CONFIG = { comments: { enabled: true, admins: [\"a@b.com\"] } };");
  assert.deepEqual(commentsConfig(config), { enabled: true, admins: ["a@b.com"] });
});

test("shipped hub.config.js keeps comments off and admins empty", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../site/hub.config.js"), "utf8");
  const config = parseHubConfigSource(source);
  assert.deepEqual(commentsConfig(config), { enabled: false, admins: [] });
});

test("isCommentsStoreKey refuses the comments/ prefix the file API must not touch", () => {
  assert.equal(isCommentsStoreKey("comments/home/home.json"), true);
  assert.equal(isCommentsStoreKey("/comments"), true);
  assert.equal(isCommentsStoreKey("share/notes.json"), false);
});

test("buildComment mints an id, takes author from the actor, and ignores a spoofed author", () => {
  const comment = buildComment(
    { scope: "page", target_id: "meetings.html", body: "  Keep clips only.  \n", author: "attacker@evil.example" },
    PERSON,
    NOW,
    "abcd1234",
  );
  assert.equal(comment.id, "2026-10-19T12-00-00-000Z-abcd1234");
  assert.equal(comment.scope, "page");
  assert.equal(comment.target_id, "meetings");
  assert.equal(comment.author, "dev@example.com");
  assert.equal(comment.author_kind, "person");
  assert.equal(comment.body, "Keep clips only.");
  assert.equal(comment.edited_at, null);
  assert.equal(comment.deleted_at, null);
  assert.equal(comment.pinned, false);
  assert.equal(comment.legacy, null);
  assert.equal(commentsKey(comment.scope, comment.target_id), "comments/page/meetings.json");
});

test("an agent comment stores author_kind agent plus the agent name, never a body author", () => {
  const comment = buildComment(
    { scope: "home", target_id: "index", body: "Posted by the bot", author: "spoof@evil.example", agent_name: "ignored" },
    AGENT,
    NOW,
    "bot00001",
  );
  assert.equal(comment.author, "bot@example.com");
  assert.equal(comment.author_kind, "agent");
  assert.equal(comment.author_label, "Atlas Agent");
  assert.equal(comment.target_id, "home");
});

test("replies go one level deep only", () => {
  const top = topLevel();
  const thread = addCommentToThread({ comments: [] }, top);
  const reply = buildComment(
    { scope: "home", target_id: "home", parent_id: top.id, body: "A reply" },
    PERSON,
    NOW,
    "bbbb2222",
  );
  const withReply = addCommentToThread(thread, reply);
  assert.equal(withReply.comments[1].parent_id, top.id);

  const nested = buildComment(
    { scope: "home", target_id: "home", parent_id: reply.id, body: "too deep" },
    PERSON,
    NOW,
    "cccc3333",
  );
  assert.throws(() => addCommentToThread(withReply, nested), /one level deep only/);
  assert.throws(
    () => addCommentToThread(thread, buildComment(
      { scope: "home", target_id: "home", parent_id: "missing", body: "x" },
      PERSON,
      NOW,
      "dddd4444",
    )),
    /parent comment not found/,
  );
});

test("soft delete hides the body but keeps the record", () => {
  const top = topLevel("Secret note");
  const deleted = softDeleteCommentInThread({ comments: [top] }, top.id, PERSON, NOW);
  assert.equal(deleted.comments[0].body, "Secret note");
  assert.equal(deleted.comments[0].deleted_at, NOW.toISOString());
  assert.equal(deleted.comments[0].deleted_by, PERSON.email);
  assert.equal(presentComment(deleted.comments[0]).body, "");
  assert.equal(presentComment(deleted.comments[0]).id, top.id);
});

test("pins are per thread and top-level only, ordered by pin_order", () => {
  const a = topLevel("First");
  const b = buildComment({ scope: "home", target_id: "home", body: "Second" }, PERSON, NOW, "bbbb2222");
  const reply = buildComment(
    { scope: "home", target_id: "home", parent_id: a.id, body: "reply" },
    PERSON,
    NOW,
    "cccc3333",
  );
  let doc = { comments: [a, b, reply] };
  doc = pinCommentInThread(doc, a.id, ADMIN, NOW);
  doc = pinCommentInThread(doc, b.id, ADMIN, NOW);
  assert.equal(doc.comments[0].pin_order, 0);
  assert.equal(doc.comments[1].pin_order, 1);
  assert.throws(() => pinCommentInThread(doc, reply.id, ADMIN, NOW), /top-level/);

  doc = reorderPinsInThread(doc, [b.id, a.id]);
  assert.deepEqual(pinnedComments(doc.comments).map((item) => item.id), [b.id, a.id]);
  assert.equal(pinnedComments(doc.comments)[0].pin_order, 0);
  assert.equal(pinnedComments(doc.comments)[1].pin_order, 1);

  doc = unpinCommentInThread(doc, b.id);
  assert.equal(pinnedComments(doc.comments).length, 1);
  assert.equal(pinnedComments(doc.comments)[0].id, a.id);
  assert.equal(pinnedComments(doc.comments)[0].pin_order, 0);
});

test("proposed default: agents may create and cannot pin, unpin, reorder or delete", () => {
  const comment = topLevel();
  assert.equal(commentPolicy("create", { actor: AGENT, settings: SETTINGS }).ok, true);
  for (const action of ["pin", "unpin", "reorder", "delete"]) {
    const decision = commentPolicy(action, { actor: AGENT, comment, settings: SETTINGS });
    assert.equal(decision.ok, false, action);
    assert.equal(decision.status, 403, action);
    assert.match(decision.error, /person/, action);
  }
});

test("proposed default: pin, unpin and reorder are admin-only", () => {
  const comment = topLevel();
  for (const action of ["pin", "unpin", "reorder"]) {
    const person = commentPolicy(action, { actor: PERSON, comment, settings: SETTINGS });
    assert.equal(person.ok, false, action);
    assert.match(person.error, /admin/, action);
    assert.equal(commentPolicy(action, { actor: ADMIN, comment, settings: SETTINGS }).ok, true, action);
  }
});

test("proposed default: delete is admin or the comment author, and person-only", () => {
  const comment = topLevel();
  assert.equal(commentPolicy("delete", { actor: PERSON, comment, settings: SETTINGS }).ok, true);
  assert.equal(commentPolicy("delete", { actor: ADMIN, comment, settings: SETTINGS }).ok, true);
  const other = describeActor(true, "other@example.com");
  assert.equal(commentPolicy("delete", { actor: other, comment, settings: SETTINGS }).ok, false);
  assert.equal(commentPolicy("delete", { actor: AGENT, comment, settings: SETTINGS }).ok, false);
});

test("edit is author-only; a spoofed author on the body is not consulted", () => {
  const comment = topLevel();
  assert.equal(commentPolicy("edit", { actor: PERSON, comment, settings: SETTINGS }).ok, true);
  assert.equal(commentPolicy("edit", { actor: ADMIN, comment, settings: SETTINGS }).ok, false);
  const edited = editCommentInThread({ comments: [comment] }, comment.id, "Updated", NOW);
  assert.equal(edited.comments[0].body, "Updated");
  assert.equal(edited.comments[0].edited_at, NOW.toISOString());
});

test("etag conflict retries and then surfaces 409", async () => {
  let puts = 0;
  const store = { comments: [] };
  const bucket = {
    async get() {
      return {
        httpEtag: `"v${puts}"`,
        json: async () => structuredClone(store),
      };
    },
    async put(_key, value, opts) {
      puts += 1;
      if (opts.onlyIf?.etagMatches && puts < 3) return null;
      store.comments = JSON.parse(value).comments;
      return { etag: `"v${puts}"` };
    },
  };
  const comment = topLevel();
  const result = await updateThread(bucket, "home", "home", (doc) => addCommentToThread(doc, comment));
  assert.equal(result.doc.comments.length, 1);
  assert.equal(puts, 3);

  puts = 0;
  const stubborn = {
    async get() {
      return { httpEtag: '"stale"', json: async () => ({ comments: [] }) };
    },
    async put() {
      puts += 1;
      return null;
    },
  };
  await assert.rejects(() => updateThread(stubborn, "home", "home", (doc) => doc), { status: 409, message: /conflict/ });
  assert.equal(puts, COMMENT_WRITE_RETRIES);
});

test("memory bucket onlyIf matches the etag retry path", async () => {
  const bucket = memoryBucket();
  const first = await updateThread(bucket, "page", "guide", (doc) => addCommentToThread(doc, topLevel("one")));
  assert.equal(first.doc.comments.length, 1);
  const other = buildComment({ scope: "page", target_id: "guide", body: "two" }, PERSON, NOW, "zzzz9999");
  const second = await updateThread(bucket, "page", "guide", (doc) => addCommentToThread(doc, other));
  assert.equal(second.doc.comments.length, 2);
});

test("sortThreadComments keeps replies under their parent", () => {
  const a = { id: "a", parent_id: null, created_at: "2026-10-19T10:00:00.000Z" };
  const b = { id: "b", parent_id: null, created_at: "2026-10-19T11:00:00.000Z" };
  const r = { id: "r", parent_id: "a", created_at: "2026-10-19T12:00:00.000Z" };
  assert.deepEqual(sortThreadComments([b, r, a]).map((item) => item.id), ["a", "r", "b"]);
});

test("migrated comments keep a byte-identical body and a legacy key", () => {
  const body = "Welcome home\nKeep this newline.\n";
  assert.equal(preserveBody(body), body);
  const comment = buildMigratedComment({
    scope: "home",
    target_id: "home",
    body,
    author: "human@example.com",
    created_at: "2026-10-01T00:00:00.000Z",
    pinned: true,
    pin_order: 0,
    repo_key: "notes/pages/index.json",
    etag_or_updatedAt: "2026-10-01T00:00:00.000Z",
  }, NOW, "mig00001");
  assert.equal(comment.body, body);
  assert.equal(comment.pinned, true);
  assert.equal(comment.legacy.repo_key, "notes/pages/index.json");
  assert.equal(hasLegacyRepoKey({ comments: [comment] }, "notes/pages/index.json"), true);
  assert.equal(hasLegacyRepoKey({ comments: [comment] }, "notes/pages/other.json"), false);
});
