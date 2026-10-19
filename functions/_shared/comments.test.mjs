import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { memoryBucket } from "./memory-bucket.js";
import {
  COMMENT_BODY_MAX,
  COMMENT_PINNED_BODY_MAX,
  COMMENT_QUOTE_MAX,
  COMMENT_WRITE_RETRIES,
  accessClientId,
  addCommentToThread,
  buildComment,
  buildMigratedComment,
  capabilitiesFor,
  cleanQuote,
  commentPolicy,
  commentsConfig,
  commentsIdentity,
  commentsKey,
  describeActor,
  editCommentInThread,
  hasLegacyRepoKey,
  isCommentsStoreKey,
  parseHubAdmins,
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
  viewerFor,
} from "./comments.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const PERSON = describeActor(true, "dev@example.com");
const AGENT = describeActor(false, "bot@example.com", "Atlas Agent");
const ADMIN = describeActor(true, "admin@example.com");
const LIMITS = { body: COMMENT_BODY_MAX, pinnedBody: COMMENT_PINNED_BODY_MAX, quote: COMMENT_QUOTE_MAX };
const SETTINGS = commentsConfig({ comments: { enabled: true, admins: ["admin@example.com"] } });

function make(identity, input, rand = "aaaa1111") {
  return buildComment({ scope: "home", target_id: "home", ...input }, { identity, config: SETTINGS, now: NOW, rand });
}

function topLevel(body = "Welcome home", extra = {}) {
  return make(PERSON, { body, ...extra }, extra.rand || "aaaa1111");
}

test("commentsConfig is off until a human sets enabled, and admins are lowercased", () => {
  assert.deepEqual(commentsConfig({}), { enabled: false, admins: [], limits: LIMITS });
  assert.deepEqual(commentsConfig({ comments: { enabled: false, admins: ["Admin@Example.com"] } }), {
    enabled: false,
    admins: ["admin@example.com"],
    limits: LIMITS,
  });
  assert.equal(commentsConfig({ comments: { enabled: true } }).enabled, true);
});

test("commentsIdentity maps same-site browser writes to human/browser and headerless callers to agent/mcp", () => {
  const browser = commentsIdentity(
    new Request("https://hub.example/api/comments", { headers: { origin: "https://hub.example" } }),
    "dev@example.com",
  );
  assert.equal(browser.kind, "human");
  assert.equal(browser.via, "browser");
  const mcp = commentsIdentity(
    new Request("https://hub.example/api/comments"),
    "dev@example.com",
    { agentName: "Codex" },
  );
  assert.equal(mcp.kind, "agent");
  assert.equal(mcp.via, "mcp");
  assert.equal(mcp.label, "Codex");
});

test("no email and no service-token id is not a write identity; unknown never matches", () => {
  const none = commentsIdentity(new Request("https://hub.example/api/comments"), "", {});
  assert.equal(none.id, "");
  assert.equal(none.email, "");
  assert.equal(commentPolicy("create", { identity: none, config: SETTINGS }).ok, false);
  assert.equal(commentPolicy("create", { identity: none, config: SETTINGS }).status, 403);

  const unknown = { id: "unknown", email: "unknown", kind: "human", via: "browser" };
  const comment = { ...topLevel(), author: "unknown" };
  assert.equal(commentPolicy("edit", { identity: unknown, comment, config: SETTINGS }).ok, false);
  assert.equal(commentPolicy("delete", { identity: unknown, comment, config: SETTINGS }).ok, false);

  const payload = Buffer.from(JSON.stringify({ common_name: "client-id.access" })).toString("base64url");
  const token = `e30.${payload}.`;
  const jwtReq = new Request("https://hub.example/api/comments", { headers: { "Cf-Access-Jwt-Assertion": token } });
  const ignored = commentsIdentity(jwtReq, "");
  assert.equal(ignored.id, "");
  assert.equal(accessClientId(jwtReq), "");
  assert.equal(accessClientId(jwtReq, {}), "");
  assert.equal(accessClientId(jwtReq, { ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" }), "");

  const accessEnv = { ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "aud-tag" };
  assert.equal(accessClientId(jwtReq, accessEnv), "client-id.access");
  const svc = commentsIdentity(jwtReq, "", { env: accessEnv });
  assert.equal(svc.id, "svc:client-id.access");
  assert.equal(svc.email, "");
  assert.equal(svc.kind, "agent");
  assert.equal(commentPolicy("create", { identity: svc, config: SETTINGS }).ok, true);
  const stored = make(svc, { body: "from a token" }, "svc00001");
  assert.equal(stored.author, "svc:client-id.access");
  assert.equal(stored.author_kind, "agent");
});

test("migrated notes with no author are legacy/system and only admins may edit or delete them", () => {
  const comment = buildMigratedComment({
    scope: "home",
    target_id: "home",
    body: "Welcome home",
    author: "",
    created_at: "2026-10-01T00:00:00.000Z",
    pinned: true,
    repo_key: "notes/pages/index.json",
    etag_or_updatedAt: "etag",
  }, { now: NOW, rand: "leg00001", config: SETTINGS });
  assert.equal(comment.author, "legacy");
  assert.equal(comment.author_kind, "system");
  assert.equal(presentComment(comment).author_kind, "system");
  assert.equal(commentPolicy("edit", { identity: PERSON, comment, config: SETTINGS }).ok, false);
  assert.equal(commentPolicy("delete", { identity: PERSON, comment, config: SETTINGS }).ok, false);
  assert.equal(commentPolicy("edit", { identity: ADMIN, comment, config: SETTINGS }).ok, true);
  assert.equal(commentPolicy("delete", { identity: ADMIN, comment, config: SETTINGS }).ok, true);
});

test("unpin of a body over 8000 is 409 and tells the caller to trim first", () => {
  const long = make(ADMIN, { body: "L".repeat(8001), pinned: true }, "long0001");
  assert.throws(
    () => unpinCommentInThread({ comments: [long] }, long.id, SETTINGS),
    { status: 409, message: /trim the body below 8000/ },
  );
});

test("an agent may edit their own pinned comment only within 8000 chars", () => {
  const comment = make(AGENT, { body: "bot note" }, "abot0001");
  const pinned = pinCommentInThread({ comments: [comment] }, comment.id, { identity: ADMIN, now: NOW }).comments[0];
  const grown = editCommentInThread({ comments: [pinned] }, pinned.id, "ok".repeat(10), { identity: AGENT, config: SETTINGS, now: NOW });
  assert.equal(grown.comments[0].body, "ok".repeat(10));
  assert.throws(
    () => editCommentInThread({ comments: [pinned] }, pinned.id, "x".repeat(8001), { identity: AGENT, config: SETTINGS, now: NOW }),
    { status: 413 },
  );
  const adminEdit = editCommentInThread({ comments: [pinned] }, pinned.id, "y".repeat(8001), { identity: ADMIN, config: SETTINGS, now: NOW });
  assert.equal(adminEdit.comments[0].body.length, 8001);
});

test("an admin-authored pinned comment edited via MCP cannot grow past 8000", () => {
  const comment = make(ADMIN, { body: "admin note", pinned: true }, "adm00001");
  const mcpAdmin = { id: ADMIN.id, email: ADMIN.email, kind: "human", via: "mcp" };
  assert.equal(commentPolicy("edit", { identity: mcpAdmin, comment, config: SETTINGS }).ok, true);
  assert.throws(
    () => editCommentInThread({ comments: [comment] }, comment.id, "x".repeat(8001), { identity: mcpAdmin, config: SETTINGS, now: NOW }),
    { status: 413 },
  );
  const authorNote = make(PERSON, { body: "mine", pinned: true }, "per00001");
  const authorEdit = editCommentInThread({ comments: [authorNote] }, authorNote.id, "y".repeat(8001), { identity: PERSON, config: SETTINGS, now: NOW });
  assert.equal(authorEdit.comments[0].body.length, 8001);
});

test("HUB_ADMINS env values merge with config.comments.admins", () => {
  assert.deepEqual(parseHubAdmins("Admin@Example.com, github:charlie, "), [
    "admin@example.com",
  ]);
  const merged = commentsConfig(
    { comments: { enabled: true, admins: ["admin@example.com"] } },
    "ops@example.com, github:charlie",
  );
  assert.deepEqual(merged.admins, ["admin@example.com", "ops@example.com"]);
});

test("parseHubConfigSource reads the tenant file's HUB_CONFIG assignment", () => {
  const config = parseHubConfigSource("globalThis.HUB_CONFIG = { comments: { enabled: true, admins: [\"a@b.com\"] } };");
  assert.deepEqual(commentsConfig(config).admins, ["a@b.com"]);
  assert.equal(commentsConfig(config).enabled, true);
});

test("shipped hub.config.js keeps comments off and admins empty", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../site/hub.config.js"), "utf8");
  const config = parseHubConfigSource(source);
  assert.deepEqual(commentsConfig(config), { enabled: false, admins: [], limits: LIMITS });
});

test("isCommentsStoreKey refuses the comments/ prefix the file API must not touch", () => {
  assert.equal(isCommentsStoreKey("comments/home/home.json"), true);
  assert.equal(isCommentsStoreKey("/comments"), true);
  assert.equal(isCommentsStoreKey("share/notes.json"), false);
});

test("buildComment mints an id, takes author from the actor, and ignores a spoofed author", () => {
  const comment = make(PERSON, {
    scope: "page",
    target_id: "meetings.html",
    body: "  Keep clips only.  \n",
    author: "attacker@evil.example",
  }, "abcd1234");
  assert.equal(comment.id, "2026-10-19T12-00-00-000Z-abcd1234");
  assert.equal(comment.scope, "page");
  assert.equal(comment.target_id, "meetings");
  assert.equal(comment.author, "dev@example.com");
  assert.equal(comment.author_kind, "person");
  assert.equal(comment.via, "browser");
  assert.equal(comment.body, "Keep clips only.");
  assert.equal(comment.rev, "1");
  assert.equal(comment.edited_by, null);
  assert.equal(comment.proposal_id, null);
  assert.equal(comment.edited_at, null);
  assert.equal(comment.deleted_at, null);
  assert.equal(comment.pinned, false);
  assert.equal(comment.legacy, null);
  assert.equal(commentsKey(comment.scope, comment.target_id), "comments/page/meetings.json");
});

test("an agent comment stores author_kind agent plus the agent name, never a body author", () => {
  const comment = make(AGENT, {
    body: "Posted by the bot",
    author: "spoof@evil.example",
  }, "bot00001");
  assert.equal(comment.author, "bot@example.com");
  assert.equal(comment.author_kind, "agent");
  assert.equal(comment.author_label, "Atlas Agent");
  assert.equal(comment.via, "mcp");
  assert.equal(comment.target_id, "home");
});

test("replies go one level deep only", () => {
  const top = topLevel();
  const thread = addCommentToThread({ comments: [] }, top);
  const reply = make(PERSON, { parent_id: top.id, body: "A reply" }, "bbbb2222");
  const withReply = addCommentToThread(thread, reply);
  assert.equal(withReply.comments[1].parent_id, top.id);

  const nested = make(PERSON, { parent_id: reply.id, body: "too deep" }, "cccc3333");
  assert.throws(() => addCommentToThread(withReply, nested), /one level deep only/);
  assert.throws(
    () => addCommentToThread(thread, make(PERSON, { parent_id: "missing", body: "x" }, "dddd4444")),
    /parent comment not found/,
  );
});

test("soft delete hides the body and quote but keeps the record", () => {
  const top = topLevel("Secret note", { quote: "selected line" });
  const deleted = softDeleteCommentInThread({ comments: [top] }, top.id, { identity: PERSON, now: NOW });
  assert.equal(deleted.comments[0].body, "Secret note");
  assert.equal(deleted.comments[0].quote, "selected line");
  assert.equal(deleted.comments[0].deleted_at, NOW.toISOString());
  assert.equal(deleted.comments[0].deleted_by, PERSON.email);
  assert.equal(presentComment(deleted.comments[0]).body, "");
  assert.equal(presentComment(deleted.comments[0]).quote, null);
  assert.equal(presentComment(deleted.comments[0]).id, top.id);
});

test("pins are per thread and top-level only, ordered by pin_order", () => {
  const a = topLevel("First");
  const b = make(PERSON, { body: "Second" }, "bbbb2222");
  const reply = make(PERSON, { parent_id: a.id, body: "reply" }, "cccc3333");
  let doc = { comments: [a, b, reply] };
  doc = pinCommentInThread(doc, a.id, { identity: ADMIN, now: NOW });
  doc = pinCommentInThread(doc, b.id, { identity: ADMIN, now: NOW });
  assert.equal(doc.comments[0].pin_order, 0);
  assert.equal(doc.comments[1].pin_order, 1);
  assert.throws(() => pinCommentInThread(doc, reply.id, { identity: ADMIN, now: NOW }), /top-level/);

  doc = reorderPinsInThread(doc, [b.id, a.id]);
  assert.deepEqual(pinnedComments(doc.comments).map((item) => item.id), [b.id, a.id]);
  assert.equal(pinnedComments(doc.comments)[0].pin_order, 0);
  assert.equal(pinnedComments(doc.comments)[1].pin_order, 1);

  doc = unpinCommentInThread(doc, b.id);
  assert.equal(pinnedComments(doc.comments).length, 1);
  assert.equal(pinnedComments(doc.comments)[0].id, a.id);
  assert.equal(pinnedComments(doc.comments)[0].pin_order, 0);
});

test("locked by Charlie Oct 19: agents may create and cannot pin, unpin, reorder or delete", () => {
  const comment = topLevel();
  assert.equal(commentPolicy("create", { identity: AGENT, config: SETTINGS }).ok, true);
  for (const action of ["pin", "unpin", "reorder", "delete"]) {
    const decision = commentPolicy(action, { identity: AGENT, comment, config: SETTINGS });
    assert.equal(decision.ok, false, action);
    assert.equal(decision.status, 403, action);
    assert.match(decision.error, /person/, action);
  }
});

test("locked by Charlie Oct 19: pin, unpin and reorder are admin-only", () => {
  const comment = topLevel();
  for (const action of ["pin", "unpin", "reorder"]) {
    const person = commentPolicy(action, { identity: PERSON, comment, config: SETTINGS });
    assert.equal(person.ok, false, action);
    assert.match(person.error, /admin/, action);
    assert.equal(commentPolicy(action, { identity: ADMIN, comment, config: SETTINGS }).ok, true, action);
  }
});

test("locked by Charlie Oct 19: delete is admin or the comment author, and person-only", () => {
  const comment = topLevel();
  assert.equal(commentPolicy("delete", { identity: PERSON, comment, config: SETTINGS }).ok, true);
  assert.equal(commentPolicy("delete", { identity: ADMIN, comment, config: SETTINGS }).ok, true);
  const other = describeActor(true, "other@example.com");
  assert.equal(commentPolicy("delete", { identity: other, comment, config: SETTINGS }).ok, false);
  assert.equal(commentPolicy("delete", { identity: AGENT, comment, config: SETTINGS }).ok, false);
});

test("via=mcp or a non-human kind cannot pin, unpin, reorder or delete", () => {
  const comment = topLevel();
  const mcpHuman = { id: "dev@example.com", email: "dev@example.com", kind: "human", via: "mcp" };
  const service = { id: "github:bot", email: "", kind: "agent", via: "api" };
  for (const identity of [mcpHuman, service]) {
    for (const action of ["pin", "unpin", "reorder", "delete"]) {
      assert.equal(commentPolicy(action, { identity, comment, config: SETTINGS }).ok, false, `${identity.via}:${action}`);
    }
  }
});

test("edit is author-only; a spoofed author on the body is not consulted", () => {
  const comment = topLevel();
  assert.equal(commentPolicy("edit", { identity: PERSON, comment, config: SETTINGS }).ok, true);
  assert.equal(commentPolicy("edit", { identity: ADMIN, comment, config: SETTINGS }).ok, false);
  const edited = editCommentInThread({ comments: [comment] }, comment.id, "Updated", { identity: PERSON, config: SETTINGS, now: NOW });
  assert.equal(edited.comments[0].body, "Updated");
  assert.equal(edited.comments[0].edited_at, NOW.toISOString());
  assert.equal(edited.comments[0].edited_by, PERSON.email);
  assert.equal(edited.comments[0].rev, "2");
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
  const result = await updateThread({ bucket }, "home", "home", (doc) => addCommentToThread(doc, comment));
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
  await assert.rejects(() => updateThread({ bucket: stubborn }, "home", "home", (doc) => doc), { status: 409, message: /conflict/ });
  assert.equal(puts, COMMENT_WRITE_RETRIES);
});

test("memory bucket onlyIf matches the etag retry path", async () => {
  const bucket = memoryBucket();
  const first = await updateThread({ bucket }, "page", "guide", (doc) => addCommentToThread(doc, topLevel("one")));
  assert.equal(first.doc.comments.length, 1);
  const other = make(PERSON, { scope: "page", target_id: "guide", body: "two" }, "zzzz9999");
  const second = await updateThread({ bucket }, "page", "guide", (doc) => addCommentToThread(doc, other));
  assert.equal(second.doc.comments.length, 2);
});

test("sortThreadComments keeps replies under their parent", () => {
  const a = { id: "a", parent_id: null, created_at: "2026-10-19T10:00:00.000Z" };
  const b = { id: "b", parent_id: null, created_at: "2026-10-19T11:00:00.000Z" };
  const r = { id: "r", parent_id: "a", created_at: "2026-10-19T12:00:00.000Z" };
  assert.deepEqual(sortThreadComments([b, r, a]).map((item) => item.id), ["a", "r", "b"]);
});

test("quote is optional plain text, capped at 500, with tags stripped", () => {
  assert.equal(cleanQuote(undefined), null);
  assert.equal(cleanQuote(""), null);
  assert.equal(cleanQuote("  selected line  "), "selected line");
  assert.equal(cleanQuote("<em>hello</em> world"), "hello world");
  assert.equal(cleanQuote("x".repeat(600)).length, 500);
  const comment = make(PERSON, { body: "about this", quote: "<b>Welcome home</b>" }, "quot0001");
  assert.equal(comment.quote, "Welcome home");
  assert.equal(presentComment(comment).quote, "Welcome home");
});

test("per-viewer capabilities come from commentPolicy", () => {
  const comment = topLevel();
  const reply = make(PERSON, { parent_id: comment.id, body: "reply" }, "repl0001");
  assert.deepEqual(capabilitiesFor(comment, PERSON, SETTINGS), {
    can_edit: true,
    can_delete: true,
    can_pin: false,
  });
  assert.deepEqual(capabilitiesFor(comment, ADMIN, SETTINGS), {
    can_edit: false,
    can_delete: true,
    can_pin: true,
  });
  assert.deepEqual(capabilitiesFor(comment, AGENT, SETTINGS), {
    can_edit: false,
    can_delete: false,
    can_pin: false,
  });
  assert.equal(capabilitiesFor(reply, ADMIN, SETTINGS).can_pin, false);
  assert.deepEqual(viewerFor(ADMIN, SETTINGS), { can_pin: true, is_admin: true });
  assert.deepEqual(viewerFor(PERSON, SETTINGS), { can_pin: false, is_admin: false });
  assert.deepEqual(viewerFor(AGENT, SETTINGS), { can_pin: false, is_admin: false });

  const shown = presentComment(comment, PERSON, SETTINGS);
  assert.equal(shown.author_kind, "person");
  assert.equal(shown.author_label, "");
  assert.equal(shown.can_edit, true);
  assert.equal(shown.can_delete, true);
  assert.equal(shown.can_pin, false);

  const pinned = { ...comment, pinned: true };
  assert.equal(capabilitiesFor(pinned, PERSON, SETTINGS).can_edit, true);
  assert.equal(capabilitiesFor(pinned, ADMIN, SETTINGS).can_edit, true);
  assert.equal(capabilitiesFor(pinned, describeActor(true, "other@example.com"), SETTINGS).can_edit, false);
  assert.equal(commentPolicy("edit", { identity: ADMIN, comment: pinned, config: SETTINGS }).ok, true);
  assert.equal(commentPolicy("edit", {
    identity: describeActor(true, "other@example.com"),
    comment: pinned,
    config: SETTINGS,
  }).ok, false);
});

test("migrated comments keep a byte-identical body, a legacy key and a seeded rev", () => {
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
    etag_or_updatedAt: "etag-from-note",
  }, { now: NOW, rand: "mig00001", config: SETTINGS });
  assert.equal(comment.body, body);
  assert.equal(comment.pinned, true);
  assert.equal(comment.legacy.repo_key, "notes/pages/index.json");
  assert.equal(comment.rev, "etag-from-note");
  assert.equal(hasLegacyRepoKey({ comments: [comment] }, "notes/pages/index.json"), true);
  assert.equal(hasLegacyRepoKey({ comments: [comment] }, "notes/pages/other.json"), false);
});
