import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertBodySize,
  authorKindOf,
  buildComment,
  buildMigratedComment,
  commentPolicy,
  createHubComments,
  editCommentInThread,
  isAdmin,
} from "./index.js";

const DIR = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-10-19T12:00:00.000Z");
const HUMAN = { id: "dev@example.com", email: "dev@example.com", kind: "human", via: "browser" };
const CONFIG = { admins: ["admin@example.com"], limits: { body: 8000, pinnedBody: 256 * 1024, quote: 500 } };

test("hub-comments has no imports outside this folder", () => {
  for (const name of readdirSync(DIR)) {
    if (!name.endsWith(".js")) continue;
    const source = readFileSync(join(DIR, name), "utf8");
    for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      const spec = match[1];
      assert.ok(spec.startsWith("./"), `${name} imports ${spec}`);
      assert.doesNotMatch(spec, /access|identity\.js/i, `${name} must not import Access or identity`);
    }
  }
});

test("author_kind is agent when kind is not human or via is mcp", () => {
  assert.equal(authorKindOf({ kind: "human", via: "browser" }), "person");
  assert.equal(authorKindOf({ kind: "human", via: "mcp" }), "agent");
  assert.equal(authorKindOf({ kind: "agent", via: "browser" }), "agent");
  assert.equal(authorKindOf({ kind: "agent", via: "mcp" }), "agent");
});

test("createHubComments injects bucket, identity, config and now", () => {
  const comments = createHubComments({ identity: HUMAN, config: CONFIG, now: NOW });
  const built = comments.build({ scope: "home", target_id: "home", body: "Hello" }, "inj00001");
  assert.equal(built.author, HUMAN.email);
  assert.equal(built.via, "browser");
  assert.equal(built.rev, "1");
  assert.equal(comments.policy("create").ok, true);
  assert.equal(comments.viewer().is_admin, false);
});

test("admins match email only", () => {
  assert.equal(isAdmin({ id: "github:charlie", email: "" }, CONFIG), false);
  assert.equal(isAdmin({ id: "admin@example.com", email: "admin@example.com" }, CONFIG), true);
  assert.equal(isAdmin(HUMAN, CONFIG), false);
});

test("adminIdps: a GitHub sign-in is admin; unknown or other providers fall back to the email list", () => {
  const config = { ...CONFIG, adminIdps: ["github"] };
  assert.equal(isAdmin({ ...HUMAN, idp: "github" }, config), true);
  assert.equal(isAdmin({ ...HUMAN, idp: "GitHub" }, config), true);
  assert.equal(isAdmin({ ...HUMAN, idp: "google" }, config), false);
  assert.equal(isAdmin({ ...HUMAN, idp: "onetimepin" }, config), false);
  assert.equal(isAdmin({ ...HUMAN, idp: "" }, config), false);
  assert.equal(isAdmin({ ...HUMAN, idp: "github" }, CONFIG), false, "no adminIdps configured");
  assert.equal(isAdmin({ id: "svc:client", email: "", idp: "github" }, config), false, "needs an email");
  assert.equal(isAdmin({ id: "admin@example.com", email: "admin@example.com", idp: "google" }, config), true);
});

test("a reply or unpinned comment over 8000 chars is 413; a pinned top-level may be 256 KiB", () => {
  const over = "x".repeat(8001);
  assert.throws(() => assertBodySize(over, { pinned: false }, CONFIG), { status: 413 });
  assert.throws(() => assertBodySize(over, { pinned: true, parent_id: "parent" }, CONFIG), { status: 413 });
  assert.doesNotThrow(() => assertBodySize(over, { pinned: true, parent_id: null }, CONFIG));
  assert.throws(
    () => buildComment({ scope: "home", target_id: "home", body: over }, { identity: HUMAN, config: CONFIG, now: NOW }),
    { status: 413 },
  );
  const pinned = buildComment(
    { scope: "home", target_id: "home", body: over, pinned: true },
    { identity: HUMAN, config: CONFIG, now: NOW, rand: "pin00001" },
  );
  assert.equal(pinned.body.length, 8001);
  assert.equal(pinned.pinned, true);

  const longNote = "L".repeat(20_000);
  const migrated = buildMigratedComment({
    scope: "service",
    target_id: "2026-10-13",
    body: longNote,
    author: "ops@example.com",
    created_at: "2026-10-13T00:00:00.000Z",
    pinned: true,
    repo_key: "notes/service-2026-10-13.md",
    etag_or_updatedAt: '"abc"',
  }, { now: NOW, config: CONFIG });
  assert.equal(migrated.body, longNote);
  assert.equal(migrated.rev, '"abc"');
});

test("rev bumps on body edit and edited_by / proposal_id are stored", () => {
  const comment = buildComment(
    { scope: "home", target_id: "home", body: "first", proposal_id: "prop-1" },
    { identity: HUMAN, config: CONFIG, now: NOW, rand: "rev00001" },
  );
  assert.equal(comment.rev, "1");
  assert.equal(comment.proposal_id, "prop-1");
  assert.equal(comment.edited_by, null);
  const next = editCommentInThread(
    { comments: [comment] },
    comment.id,
    "second",
    { identity: HUMAN, config: CONFIG, now: NOW },
  );
  assert.equal(next.comments[0].rev, "2");
  assert.equal(next.comments[0].edited_by, HUMAN.email);
  assert.equal(next.comments[0].body, "second");
});

test("policy refuses pin and delete for via=mcp even when kind is human", () => {
  const identity = { id: HUMAN.id, email: HUMAN.email, kind: "human", via: "mcp" };
  const comment = buildComment(
    { scope: "home", target_id: "home", body: "mine" },
    { identity: HUMAN, config: CONFIG, now: NOW, rand: "mcp00001" },
  );
  assert.equal(commentPolicy("delete", { identity, comment, config: CONFIG }).ok, false);
  assert.equal(commentPolicy("pin", { identity, comment, config: CONFIG }).ok, false);
});

test("sameAuthor never matches empty, unknown or legacy", () => {
  const ghost = { id: "unknown", email: "unknown", kind: "human", via: "browser" };
  const comment = buildComment(
    { scope: "home", target_id: "home", body: "mine" },
    { identity: HUMAN, config: CONFIG, now: NOW, rand: "unk00001" },
  );
  assert.equal(commentPolicy("edit", { identity: ghost, comment: { ...comment, author: "unknown" }, config: CONFIG }).ok, false);
  assert.equal(commentPolicy("edit", { identity: { id: "", email: "" }, comment, config: CONFIG }).ok, false);
  assert.equal(commentPolicy("create", { identity: { id: "", email: "" }, config: CONFIG }).status, 403);
});
