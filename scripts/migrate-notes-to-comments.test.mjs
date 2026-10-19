import assert from "node:assert/strict";
import test from "node:test";

import { memoryBucket } from "../functions/_shared/memory-bucket.js";
import { noteKey } from "../functions/_shared/collaborate.js";
import { commentsKey, readThread } from "../functions/_shared/comments.js";
import {
  compassCityHubAdapter,
  migrateNotes,
  pinOrderFromConfig,
  teamHubNotesAdapter,
} from "./migrate-notes-to-comments.mjs";

const NOW = new Date("2026-10-19T15:00:00.000Z");

const CONFIG = {
  nav: [
    { href: "index.html" },
    { href: "meetings.html" },
    { href: "files.html" },
  ],
};

async function seedNote(bucket, page, body, updatedBy = "human@example.com", updatedAt = "2026-10-01T00:00:00.000Z") {
  const record = { page, body, updatedBy, updatedAt };
  await bucket.put(noteKey(page), JSON.stringify(record));
  return record;
}

test("pinOrderFromConfig follows hub nav order", () => {
  assert.deepEqual(pinOrderFromConfig(CONFIG), ["index", "meetings", "files"]);
});

test("team-hub notes map index/home to scope=home and other pages to scope=page", async () => {
  const source = memoryBucket();
  const homeBody = "Welcome home\nKeep this newline.\n";
  await seedNote(source, "index", homeBody);
  await seedNote(source, "meetings", "Do not publish the full recording.");
  const adapter = teamHubNotesAdapter({ pinOrder: pinOrderFromConfig(CONFIG) });
  const notes = await adapter.listNotes(source);
  const mapped = notes.map((note) => adapter.mapNote(note));
  const home = mapped.find((item) => item.repo_key === "notes/pages/index.json");
  const meetings = mapped.find((item) => item.repo_key === "notes/pages/meetings.json");
  assert.deepEqual({ scope: home.scope, target_id: home.target_id, pinned: home.pinned, pin_order: home.pin_order }, {
    scope: "home",
    target_id: "home",
    pinned: true,
    pin_order: 0,
  });
  assert.deepEqual({ scope: meetings.scope, target_id: meetings.target_id, pin_order: meetings.pin_order }, {
    scope: "page",
    target_id: "meetings",
    pin_order: 1,
  });
  assert.equal(home.body, homeBody);
});

test("dry-run reports byte-identical bodies and writes nothing", async () => {
  const source = memoryBucket();
  const dest = memoryBucket();
  const body = "Welcome home\nKeep this newline.\n";
  await seedNote(source, "index", body);
  const report = await migrateNotes({
    adapter: teamHubNotesAdapter({ pinOrder: ["index"] }),
    source,
    dest,
    apply: false,
    now: NOW,
  });
  assert.equal(report.apply, false);
  assert.equal(report.scanned, 1);
  assert.equal(report.items[0].byteIdentical, true);
  assert.equal(report.items[0].action, "would-write");
  assert.equal(await dest.head(commentsKey("home", "home")), null);
  assert.ok(await source.head(noteKey("index")));
});

test("apply writes one comment per note and never touches old note keys", async () => {
  const bucket = memoryBucket();
  const body = "Welcome home\nKeep this newline.\n";
  const original = JSON.stringify({ page: "index", body, updatedBy: "human@example.com", updatedAt: "2026-10-01T00:00:00.000Z" });
  await bucket.put(noteKey("index"), original);
  await seedNote(bucket, "meetings", "Clips only.");

  const report = await migrateNotes({
    adapter: teamHubNotesAdapter({ pinOrder: pinOrderFromConfig(CONFIG) }),
    source: bucket,
    dest: bucket,
    apply: true,
    now: NOW,
  });
  assert.equal(report.written, 2);
  const home = await readThread(bucket, "home", "home");
  assert.equal(home.doc.comments.length, 1);
  assert.equal(home.doc.comments[0].body, body);
  assert.equal(home.doc.comments[0].author, "human@example.com");
  assert.equal(home.doc.comments[0].pinned, true);
  assert.equal(home.doc.comments[0].legacy.repo_key, "notes/pages/index.json");
  assert.equal(await (await bucket.get(noteKey("index"))).text(), original);
  assert.ok(await bucket.head(noteKey("meetings")));
});

test("apply is idempotent: a note whose legacy.repo_key already exists is skipped", async () => {
  const bucket = memoryBucket();
  await seedNote(bucket, "index", "Welcome home");
  const adapter = teamHubNotesAdapter({ pinOrder: ["index"] });
  await migrateNotes({ adapter, source: bucket, dest: bucket, apply: true, now: NOW });
  const again = await migrateNotes({ adapter, source: bucket, dest: bucket, apply: true, now: NOW });
  assert.equal(again.items[0].action, "skip-existing");
  assert.equal(again.skipped, 1);
  assert.equal(again.written, 0);
  const home = await readThread(bucket, "home", "home");
  assert.equal(home.doc.comments.length, 1);
});

test("migrated comments seed rev from the legacy etag and keep a long pinned body", async () => {
  const source = memoryBucket();
  const dest = memoryBucket();
  const body = "N".repeat(12_000);
  await seedNote(source, "index", body);
  const got = await source.get(noteKey("index"));
  const report = await migrateNotes({
    adapter: teamHubNotesAdapter({ pinOrder: ["index"] }),
    source,
    dest,
    apply: true,
    now: NOW,
  });
  assert.equal(report.items[0].byteIdentical, true);
  assert.equal(report.items[0].truncated, false);
  const home = await readThread(dest, "home", "home");
  assert.equal(home.doc.comments[0].body, body);
  assert.equal(home.doc.comments[0].rev, got.httpEtag);
  assert.equal(home.doc.comments[0].edited_by, null);
  assert.equal(home.doc.comments[0].proposal_id, null);
});

test("compass stub: a long service note becomes one pinned service comment", async () => {
  const source = memoryBucket();
  const dest = memoryBucket();
  const body = `# Service ${"ok ".repeat(40)}\n`;
  await source.put("notes/service-2026-10-13.md", body, {
    customMetadata: { uploader: "ops@example.com" },
  });
  const adapter = compassCityHubAdapter();
  const notes = await adapter.listNotes(source);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].uploader, "ops@example.com");
  const mapped = adapter.mapNote(notes[0]);
  assert.equal(mapped.scope, "service");
  assert.equal(mapped.target_id, "2026-10-13");
  assert.equal(mapped.pinned, true);

  const report = await migrateNotes({ adapter, source, dest, apply: true, now: NOW });
  assert.equal(report.written, 1);
  assert.equal(report.items[0].byteIdentical, true);
  const thread = await readThread(dest, "service", "2026-10-13");
  assert.equal(thread.doc.comments.length, 1);
  assert.equal(thread.doc.comments[0].body, body);
  assert.equal(thread.doc.comments[0].pinned, true);
  assert.equal(thread.doc.comments[0].parent_id, null);
  assert.equal(await source.head("notes/service-2026-10-13.md") != null, true);
  assert.equal(await dest.head("notes/service-2026-10-13.md"), null);
});
