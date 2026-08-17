#!/usr/bin/env node

// Turns a raw Whisper-style transcript into everything the Meetings page
// needs, in one command: the compact transcript the page fetches, a plain
// text download, a skeleton meeting JSON for a human to fill in, and an
// index entry. This is the one-command version of the manual pipeline
// described in the README's "Publishing a meeting" section.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MEETINGS_DIR = join(ROOT, "site", "meetings");
const INDEX_PATH = join(MEETINGS_DIR, "index.json");

// Whisper often splits a short interjection ("Yeah.", "Right?") into its own
// segment. A fragment at or under this many words reads better folded into
// the line before it than standing alone.
const FRAGMENT_MAX_WORDS = 2;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* ---- CLI args -------------------------------------------------------- */

export function parseArgs(argv) {
  const args = { redact: [] };
  for (const token of argv) {
    const match = token.match(/^--([a-z-]+)(?:=(.*))?$/s);
    if (!match) throw new Error(`Expected --key=value, received: ${token}`);
    const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = match[2] ?? "true";
    if (key === "redact") args.redact.push(value);
    else args[key] = value;
  }
  return args;
}

/* ---- redaction ranges -------------------------------------------------- */

// "2382-2820:off-topic tangent" -> { start: 2382, end: 2820, reason: "off-topic tangent" }
// Split on the first colon only — a reason is free text and may contain one.
export function parseRedactRange(raw) {
  const text = raw.trim().replace(/^['"]|['"]$/g, "");
  const sep = text.indexOf(":");
  if (sep < 0) throw new Error(`--redact must be "start-end:reason", received: ${raw}`);
  const range = text.slice(0, sep).trim();
  const reason = text.slice(sep + 1).trim();
  const rangeMatch = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(range);
  if (!rangeMatch) throw new Error(`--redact range must be "start-end" in seconds, received: ${range}`);
  if (!reason) throw new Error("--redact requires a reason after the colon");
  const start = Number(rangeMatch[1]);
  const end = Number(rangeMatch[2]);
  if (end <= start) throw new Error(`--redact range end must be after start, received: ${range}`);
  return { start, end, reason };
}

export function parseRedactRanges(rawList) {
  return (rawList || [])
    .map(parseRedactRange)
    .sort((a, b) => a.start - b.start);
}

/* ---- transcript loading ------------------------------------------------ */

export function loadWhisperSegments(input) {
  const raw = Array.isArray(input?.segments) ? input.segments : [];
  return raw
    .map((s) => ({ start: Number(s.start), end: Number(s.end), text: String(s.text || "").trim() }))
    .filter((s) => s.text && Number.isFinite(s.start) && Number.isFinite(s.end))
    .sort((a, b) => a.start - b.start);
}

const overlaps = (segment, range) => segment.start < range.end && segment.end > range.start;

const pad2 = (n) => String(n).padStart(2, "0");
export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function markerText(range) {
  return `[ redacted — ${formatClock(range.start)}–${formatClock(range.end)} — ${range.reason} — not published ]`;
}

// Drops every raw segment that overlaps a redaction range and replaces it
// with a single marker line for that range. This MUST run before fragment
// merging: merging first would let a short fragment glue its text onto a
// kept neighbouring line, and by the time redaction ran the withheld text
// would already be inside a line that no longer looks redacted.
export function redactSegments(segments, ranges) {
  const dropped = new Set();
  for (const segment of segments) {
    if (ranges.some((range) => overlaps(segment, range))) dropped.add(segment);
  }
  const kept = segments.filter((s) => !dropped.has(s)).map((s) => ({ ...s, redacted: false }));
  const markers = ranges.map((range) => ({
    start: range.start,
    end: range.end,
    text: markerText(range),
    redacted: true,
  }));
  const timeline = [...kept, ...markers].sort((a, b) => a.start - b.start);
  return { timeline, redactions: ranges.map((r) => ({ ...r, marked: true })) };
}

// Folds short fragments into the line before them. A marker is never a merge
// source or target: it must stand alone so the withheld stretch stays visible.
export function mergeFragments(timeline, { maxWords = FRAGMENT_MAX_WORDS } = {}) {
  const lines = [];
  for (const item of timeline) {
    const words = item.text.split(/\s+/).filter(Boolean).length;
    const isFragment = !item.redacted && words <= maxWords;
    const prev = lines[lines.length - 1];
    if (isFragment && prev && !prev.redacted) {
      prev.text = `${prev.text} ${item.text}`;
      prev.end = Math.max(prev.end, item.end);
    } else {
      lines.push({ ...item });
    }
  }
  return lines;
}

/* ---- output builders ---------------------------------------------------- */

export function buildCompactTranscript({ source, model, durationSec, lines, redactions }) {
  return {
    source,
    model,
    durationSec,
    lineCount: lines.length,
    redactions,
    segments: lines.map((line) => {
      const seg = { s: line.start, e: line.end, t: line.text };
      if (line.redacted) seg.redacted = true;
      return seg;
    }),
  };
}

export function buildPlainText({ title, source, model, lines }) {
  const header = [title, [source && `source: ${source}`, model && `model: ${model}`].filter(Boolean).join(" · ")]
    .filter(Boolean)
    .join("\n");
  const body = lines.map((line) => `[${formatClock(line.start)}] ${line.text}`).join("\n");
  return `${header}\n\n${body}\n`;
}

export function buildMeetingSkeleton({ id, title, date, durationSec, model, redacted }) {
  return {
    id,
    title,
    blurb: "",
    date,
    durationSec,
    attendees: [],
    absent: [],
    transcript: `meetings/${id}.transcript.json`,
    provenance: {
      model: model || "",
      transcribedAt: date,
      speakerLabels: false,
      note: "",
      redacted,
    },
    cautions: [],
    summary: { headline: "", paragraphs: [] },
    topics: [],
    decisions: [],
    actionItems: [],
    clips: [],
    downloads: [{ label: "Download transcript (.txt)", href: `meetings/${id}.transcript.txt` }],
    recordingPolicy: "",
  };
}

export function indexLabel(date, title) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ""));
  if (!m) return title;
  const day = String(Number(m[3]));
  const month = MONTHS[Number(m[2]) - 1] || m[2];
  return `${day} ${month} ${m[1]} — ${title}`;
}

export function prependIndexEntry(index, entry) {
  const meetings = Array.isArray(index?.meetings) ? index.meetings : [];
  if (meetings.some((m) => m.file === entry.file)) {
    throw new Error(`Index already has an entry for ${entry.file} — pass --force to overwrite the files, then edit the index by hand`);
  }
  return { ...index, meetings: [entry, ...meetings] };
}

/* ---- pipeline ------------------------------------------------------------ */

export function publishMeeting({ input, id, title, date, model, source, redactRanges }) {
  const rawSegments = loadWhisperSegments(input);
  if (!rawSegments.length) throw new Error("Transcript has no usable segments");

  const ranges = parseRedactRanges(redactRanges);
  const { timeline, redactions } = redactSegments(rawSegments, ranges);
  const lines = mergeFragments(timeline);

  const durationSec = Math.max(...rawSegments.map((s) => s.end));

  const compactTranscript = buildCompactTranscript({ source, model, durationSec, lines, redactions });
  const plainText = buildPlainText({ title, source, model, lines });
  const meeting = buildMeetingSkeleton({ id, title, date, durationSec, model, redacted: redactions.length > 0 });
  const indexEntry = { label: indexLabel(date, title), file: `meetings/${id}.json` };

  return { compactTranscript, plainText, meeting, indexEntry };
}

/* ---- CLI ------------------------------------------------------------------ */

function slugCheck(id) {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
    throw new Error(`--id must be a plain filename slug (letters, digits, dashes), received: ${id}`);
  }
  return id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`Usage:
  node scripts/publish-meeting.mjs \\
    --input=transcript.json --id=2026-08-16 --title="Weekly sync — 16 Aug 2026" \\
    [--date=2026-08-16] [--model="Whisper large-v3"] [--source=meeting.wav] \\
    [--redact=2382-2820:"off-topic tangent"] [--force]

--input   Whisper-style JSON: { "segments": [{ "start", "end", "text" }, ...] }
--redact  Repeatable. Drops segments overlapping the range and leaves a marker.
--force   Overwrite existing files for this id instead of refusing.

Writes site/meetings/<id>.json, <id>.transcript.json, <id>.transcript.txt,
and prepends an entry to site/meetings/index.json. Prose fields in the
meeting JSON (blurb, summary, topics, decisions, action items, clips) are
left empty for a human to fill in.`);
    return;
  }

  if (!args.input) throw new Error("--input is required (path to a Whisper-style transcript JSON)");
  if (!args.id) throw new Error("--id is required");
  if (!args.title) throw new Error("--title is required");
  const id = slugCheck(args.id);
  const title = args.title;
  const date = args.date || new Date().toISOString().slice(0, 10);
  const source = args.source || basename(args.input);
  const model = args.model || "";
  const force = args.force === "true";

  const inputPath = resolve(process.cwd(), args.input);
  const input = JSON.parse(readFileSync(inputPath, "utf8"));

  const { compactTranscript, plainText, meeting, indexEntry } = publishMeeting({
    input,
    id,
    title,
    date,
    model,
    source,
    redactRanges: args.redact,
  });

  const meetingPath = join(MEETINGS_DIR, `${id}.json`);
  const transcriptPath = join(MEETINGS_DIR, `${id}.transcript.json`);
  const txtPath = join(MEETINGS_DIR, `${id}.transcript.txt`);

  if (!force) {
    for (const p of [meetingPath, transcriptPath, txtPath]) {
      if (existsSync(p)) throw new Error(`${p} already exists — pass --force to overwrite`);
    }
  }

  let index = { meetings: [] };
  try { index = JSON.parse(readFileSync(INDEX_PATH, "utf8")); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const nextIndex = force
    ? { ...index, meetings: [indexEntry, ...(index.meetings || []).filter((m) => m.file !== indexEntry.file)] }
    : prependIndexEntry(index, indexEntry);

  writeFileSync(meetingPath, JSON.stringify(meeting, null, 2) + "\n");
  writeFileSync(transcriptPath, JSON.stringify(compactTranscript, null, 2) + "\n");
  writeFileSync(txtPath, plainText);
  writeFileSync(INDEX_PATH, JSON.stringify(nextIndex, null, 2) + "\n");

  console.log(`Published ${id}:`);
  console.log(`  ${meetingPath}`);
  console.log(`  ${transcriptPath}`);
  console.log(`  ${txtPath}`);
  console.log(`  ${INDEX_PATH} (prepended)`);
  if (compactTranscript.redactions.length) {
    console.log(`Redacted ${compactTranscript.redactions.length} range(s) — verify the markers before publishing.`);
  }
  console.log("Prose fields (blurb, summary, topics, decisions, action items, clips) are empty — fill them in by hand.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`publish-meeting: ${error.message}`);
    process.exitCode = 1;
  });
}
