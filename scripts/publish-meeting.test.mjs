import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildPlainText,
  indexLabel,
  mergeFragments,
  parseRedactRange,
  prependIndexEntry,
  publishMeeting,
  redactSegments,
} from "./publish-meeting.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(HERE, "fixtures", "sample-transcript.json"), "utf8"));

test("parses a redact range with a colon-free reason", () => {
  assert.deepEqual(parseRedactRange("2382-2820:off-topic tangent"), {
    start: 2382,
    end: 2820,
    reason: "off-topic tangent",
  });
});

test("rejects malformed redact ranges", () => {
  assert.throws(() => parseRedactRange("2382:reason"), /start-end/);
  assert.throws(() => parseRedactRange("2382-2820"), /reason/);
  assert.throws(() => parseRedactRange("2820-2382:backwards"), /after start/);
});

test("mergeFragments folds a short interjection into the previous line", () => {
  const lines = mergeFragments([
    { start: 4, end: 8, text: "Sure, go ahead." },
    { start: 8, end: 8.5, text: "Right." },
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "Sure, go ahead. Right.");
  assert.equal(lines[0].end, 8.5);
});

test("a fragment never merges into a redaction marker", () => {
  const { timeline } = redactSegments(
    [
      { start: 1200, end: 1210, text: "kept line" },
      { start: 1210, end: 1212, text: "secret" },
    ],
    [{ start: 1210, end: 1400, reason: "reason" }],
  );
  const lines = mergeFragments([...timeline, { start: 1400, end: 1401, text: "Okay." }]);
  const okLine = lines.find((l) => l.text === "Okay.");
  assert.ok(okLine, "the fragment after the marker must stand on its own line");
  assert.ok(!lines.some((l) => l.redacted && l.text.includes("Okay")), "marker must not absorb the following fragment");
});

test("redaction runs before merge, so a fragment inside a cut range cannot glue withheld text onto a kept neighbour", () => {
  // This is the exact regression this script guards against: "Confidential."
  // is a short fragment sitting right after a kept line, inside the redact
  // range. Merging fragments before dropping redacted segments would splice
  // it onto the kept line and publish it anyway.
  const { compactTranscript, plainText } = publishMeeting({
    input: fixture,
    id: "test-meeting",
    title: "Test Meeting",
    date: "2026-08-16",
    model: "",
    source: "sample.wav",
    redactRanges: ["1210-1400:financial specifics"],
  });

  const json = JSON.stringify(compactTranscript);
  for (const withheld of ["Confidential", "dollar figures", "the deal"]) {
    assert.ok(!json.includes(withheld), `compact transcript leaked "${withheld}"`);
    assert.ok(!plainText.includes(withheld), `plain text leaked "${withheld}"`);
  }

  const keptLine = compactTranscript.segments.find((s) => s.t.includes("acquisition timeline"));
  assert.equal(keptLine.t, "Now let's talk about the acquisition timeline.", "withheld text must not be appended to the kept line before it");

  const marker = compactTranscript.segments.find((s) => s.redacted);
  assert.ok(marker, "a marker segment must appear where content was cut");
  assert.match(marker.t, /financial specifics/);
  assert.match(marker.t, /00:20:10/);
  assert.match(marker.t, /00:23:20/);
  assert.match(plainText, /financial specifics/);

  assert.deepEqual(compactTranscript.redactions, [
    { start: 1210, end: 1400, reason: "financial specifics", marked: true },
  ]);
  assert.equal(compactTranscript.lineCount, compactTranscript.segments.length);

  const afterMarker = compactTranscript.segments.find((s) => s.t === "Okay.");
  assert.ok(afterMarker, "the fragment right after the cut must survive as its own line, not merged into the marker");
});

test("publishMeeting also merges an ordinary fragment outside any redaction", () => {
  const { compactTranscript } = publishMeeting({
    input: fixture,
    id: "test-meeting",
    title: "Test Meeting",
    date: "2026-08-16",
    model: "",
    source: "sample.wav",
    redactRanges: [],
  });
  const merged = compactTranscript.segments.find((s) => s.t.startsWith("Sure, go ahead."));
  assert.equal(merged.t, "Sure, go ahead. Right.");
});

test("meeting skeleton carries every field the page renders, prose left empty", () => {
  const { meeting } = publishMeeting({
    input: fixture,
    id: "test-meeting",
    title: "Test Meeting",
    date: "2026-08-16",
    model: "Whisper large-v3",
    source: "sample.wav",
    redactRanges: ["1210-1400:financial specifics"],
  });
  assert.equal(meeting.id, "test-meeting");
  assert.equal(meeting.transcript, "meetings/test-meeting.transcript.json");
  assert.equal(meeting.durationSec, 1420);
  assert.equal(meeting.provenance.redacted, true);
  assert.equal(meeting.provenance.model, "Whisper large-v3");
  assert.deepEqual(meeting.summary, { headline: "", paragraphs: [] });
  assert.deepEqual(meeting.topics, []);
  assert.deepEqual(meeting.decisions, []);
  assert.deepEqual(meeting.actionItems, []);
  assert.deepEqual(meeting.clips, []);
  assert.deepEqual(meeting.downloads, [
    { label: "Download transcript (.txt)", href: "meetings/test-meeting.transcript.txt" },
  ]);
});

test("index label reads like the shipped example", () => {
  assert.equal(indexLabel("2026-01-15", "Weekly sync"), "15 Jan 2026 — Weekly sync");
});

test("prepending a duplicate index entry is refused", () => {
  const index = { meetings: [{ label: "old", file: "meetings/test-meeting.json" }] };
  assert.throws(
    () => prependIndexEntry(index, { label: "new", file: "meetings/test-meeting.json" }),
    /already has an entry/,
  );
});

test("prependIndexEntry keeps existing entries and puts the new one first", () => {
  const index = { note: "keep me", meetings: [{ label: "old", file: "meetings/older.json" }] };
  const next = prependIndexEntry(index, { label: "new", file: "meetings/test-meeting.json" });
  assert.equal(next.note, "keep me");
  assert.deepEqual(next.meetings, [
    { label: "new", file: "meetings/test-meeting.json" },
    { label: "old", file: "meetings/older.json" },
  ]);
});

test("plain text transcript has a readable header and timestamped lines", () => {
  const text = buildPlainText({
    title: "Test Meeting",
    source: "sample.wav",
    model: "Whisper large-v3",
    lines: [{ start: 12, end: 20, text: "hello" }],
  });
  assert.match(text, /^Test Meeting\n/);
  assert.match(text, /source: sample\.wav/);
  assert.match(text, /\[00:00:12\] hello/);
});
