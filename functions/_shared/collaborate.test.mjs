import assert from "node:assert/strict";
import test from "node:test";

import {
  addComment,
  approveProposal,
  buildFeedback,
  buildNote,
  buildProposal,
  claimFeedback,
  cleanPageKey,
  feedbackKey,
  noteKey,
  proposalKey,
  rejectProposal,
  releaseFeedback,
  reopenFeedback,
  resolveFeedback,
  sortFeedback,
} from "./collaborate.js";

const NOW = new Date("2026-10-13T12:00:00.000Z");
const RAND = "abcd1234";

test("cleanPageKey strips .html and path junk, rejects traversal", () => {
  assert.equal(cleanPageKey("index.html"), "index");
  assert.equal(cleanPageKey("/meetings"), "meetings");
  assert.equal(cleanPageKey("Feedback.HTML"), "feedback");
  assert.equal(cleanPageKey("files.html?x=1"), "files");
  assert.equal(cleanPageKey("../etc/passwd"), null);
  assert.equal(cleanPageKey("notes/pages/index"), null);
  assert.equal(cleanPageKey(""), null);
  assert.equal(cleanPageKey("x".repeat(80)), null);
});

test("buildFeedback records the server identity and starts open", () => {
  const item = buildFeedback(
    { page: "index.html", title: "  Broken KPI  ", body: "The count stays at zero.\n" },
    "dev@example.com",
    NOW,
    RAND,
  );
  assert.equal(item.page, "index");
  assert.equal(item.title, "Broken KPI");
  assert.equal(item.body, "The count stays at zero.");
  assert.equal(item.status, "open");
  assert.equal(item.createdBy, "dev@example.com");
  assert.equal(item.claimedBy, "");
  assert.equal(item.comments.length, 0);
  assert.equal(item.id, "2026-10-13T12-00-00-000Z-abcd1234");
  assert.equal(feedbackKey(item.id), `feedback/items/${item.id}.json`);
});

test("buildFeedback refuses a blank title, body or page", () => {
  assert.throws(() => buildFeedback({ page: "??", title: "x", body: "y" }, "a"), /page must be/);
  assert.throws(() => buildFeedback({ page: "index", title: "  ", body: "y" }, "a"), /title is required/);
  assert.throws(() => buildFeedback({ page: "index", title: "x", body: "" }, "a"), /body is required/);
});

test("claim is exclusive; the holder can claim again; a third party cannot", () => {
  const item = buildFeedback({ page: "index", title: "t", body: "b" }, "a@b.com", NOW, RAND);
  const mine = claimFeedback(item, "dev@example.com", NOW);
  assert.equal(mine.status, "claimed");
  assert.equal(mine.claimedBy, "dev@example.com");
  const again = claimFeedback(mine, "dev@example.com", NOW);
  assert.equal(again.claimedBy, "dev@example.com");
  assert.throws(() => claimFeedback(mine, "other@example.com"), /already claimed by dev@example.com/);
});

test("only the claimant can release; resolve and reopen keep the claimer", () => {
  const item = claimFeedback(
    buildFeedback({ page: "index", title: "t", body: "b" }, "a@b.com", NOW, RAND),
    "dev@example.com",
    NOW,
  );
  assert.throws(() => releaseFeedback(item, "other@example.com"), /only the claimant/);
  const open = releaseFeedback(item, "dev@example.com");
  assert.equal(open.status, "open");
  assert.equal(open.claimedBy, "");

  const done = resolveFeedback(item, "dev@example.com", NOW);
  assert.equal(done.status, "done");
  assert.throws(() => claimFeedback(done, "dev@example.com"), /resolved items cannot be claimed/);
  const back = reopenFeedback(done);
  assert.equal(back.status, "claimed");
  assert.equal(back.claimedBy, "dev@example.com");
  assert.equal(back.resolvedBy, "");
});

test("addComment appends a capped body against the server identity", () => {
  const item = buildFeedback({ page: "meetings", title: "t", body: "b" }, "a@b.com", NOW, RAND);
  const next = addComment(item, "  looks like the clip key\n", "dev@example.com", NOW, "c0ffee00");
  assert.equal(next.comments.length, 1);
  assert.equal(next.comments[0].author, "dev@example.com");
  assert.equal(next.comments[0].body, "looks like the clip key");
  assert.throws(() => addComment(item, "   ", "dev@example.com"), /comment is required/);
});

test("sortFeedback puts open, then claimed, then done, newest first inside a status", () => {
  const a = { status: "done", createdAt: "2026-10-13T10:00:00.000Z" };
  const b = { status: "open", createdAt: "2026-10-13T09:00:00.000Z" };
  const c = { status: "open", createdAt: "2026-10-13T11:00:00.000Z" };
  const d = { status: "claimed", createdAt: "2026-10-13T12:00:00.000Z" };
  assert.deepEqual(sortFeedback([a, b, c, d]).map((i) => i.createdAt), [
    "2026-10-13T11:00:00.000Z",
    "2026-10-13T09:00:00.000Z",
    "2026-10-13T12:00:00.000Z",
    "2026-10-13T10:00:00.000Z",
  ]);
});

test("a proposal stays pending until a human approves it into the pinned note", () => {
  const proposal = buildProposal(
    { page: "index.html", body: "Ship the Friday build." },
    "agent@example.com",
    NOW,
    RAND,
  );
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.proposedBy, "agent@example.com");
  assert.equal(proposalKey(proposal.id), `notes/proposals/${proposal.id}.json`);

  const { proposal: approved, note } = approveProposal(proposal, "human@example.com", NOW);
  assert.equal(approved.status, "approved");
  assert.equal(approved.reviewedBy, "human@example.com");
  assert.equal(note.page, "index");
  assert.equal(note.body, "Ship the Friday build.");
  assert.equal(note.updatedBy, "human@example.com");
  assert.equal(noteKey(note.page), "notes/pages/index.json");
  assert.throws(() => approveProposal(approved, "human@example.com"), /not pending/);
});

test("rejecting a proposal does not produce a note", () => {
  const proposal = buildProposal({ page: "files", body: "nope" }, "agent@example.com", NOW, RAND);
  const rejected = rejectProposal(proposal, "human@example.com", NOW);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.reviewedBy, "human@example.com");
  assert.throws(() => rejectProposal(rejected, "human@example.com"), /not pending/);
});

test("a human can pin a note directly; empty body is a cleared note, not an error", () => {
  const note = buildNote("guide.html", "", "human@example.com", NOW);
  assert.equal(note.page, "guide");
  assert.equal(note.body, "");
  assert.equal(note.updatedBy, "human@example.com");
  assert.throws(() => buildNote("../x", "hi", "human@example.com"), /page must be/);
});
