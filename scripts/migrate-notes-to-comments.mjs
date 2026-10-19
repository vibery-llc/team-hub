#!/usr/bin/env node
/**
 * Map existing pinned notes onto the unified comments store.
 *
 * Dry-run by default: prints a report (counts and a byte-identical body
 * check per note) and writes nothing. --apply writes comments documents.
 * Old note keys are never written or deleted.
 *
 * Adapters turn a hub-specific note store into the same mapped shape.
 * team-hub reads R2 `notes/pages/{page}.json`. compass-city-hub is a stub
 * for `notes/*.md` (service-YYYY-MM-DD.md becomes scope=service).
 *
 * Usage:
 *   node scripts/migrate-notes-to-comments.mjs --source-dir=./r2-dump
 *   node scripts/migrate-notes-to-comments.mjs --source-dir=./r2-dump --apply
 *   node scripts/migrate-notes-to-comments.mjs --adapter=compass-city-hub --source-dir=./r2-dump
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanPageKey, noteKey, NOTES_PREFIX } from "../functions/_shared/collaborate.js";
import {
  addCommentToThread,
  buildMigratedComment,
  commentsConfig,
  commentsKey,
  hasLegacyRepoKey,
  preserveBody,
  readThread,
  updateThread,
} from "../functions/_shared/comments.js";

export function pinOrderFromConfig(config) {
  return (config?.nav || [])
    .map((item) => cleanPageKey(item?.href || item?.page || ""))
    .filter(Boolean);
}

export function teamHubNotesAdapter() {
  return {
    name: "team-hub-notes",
    async listNotes(source) {
      const page = await source.list({ prefix: NOTES_PREFIX });
      const notes = [];
      for (const obj of page.objects || []) {
        if (!obj.key.endsWith(".json")) continue;
        const got = await source.get(obj.key);
        if (!got) continue;
        const record = typeof got.json === "function" ? await got.json() : JSON.parse(await got.text());
        const pageKey = cleanPageKey(record?.page || obj.key.slice(NOTES_PREFIX.length).replace(/\.json$/i, ""));
        if (!pageKey) continue;
        notes.push({
          repo_key: obj.key,
          page: pageKey,
          body: String(record?.body ?? ""),
          updatedBy: record?.updatedBy || "",
          updatedAt: record?.updatedAt || "",
          etag_or_updatedAt: got.httpEtag || got.etag || record?.updatedAt || "",
        });
      }
      return notes;
    },
    mapNote(note) {
      const page = note.page;
      const home = page === "index" || page === "home";
      return {
        scope: home ? "home" : "page",
        target_id: home ? "home" : page,
        body: note.body,
        author: note.updatedBy,
        created_at: note.updatedAt,
        pinned: Boolean(String(note.body || "").length),
        pin_order: 0,
        pinned_by: note.updatedBy,
        repo_key: note.repo_key || noteKey(page),
        etag_or_updatedAt: note.etag_or_updatedAt || note.updatedAt || "",
      };
    },
  };
}

/**
 * Stub for a later compass-city-hub port. Service notes are markdown objects
 * at notes/*.md; customMetadata.uploader is the author. A long service note
 * becomes one pinned top-level comment on that service thread.
 */
export function compassCityHubAdapter() {
  return {
    name: "compass-city-hub",
    async listNotes(source) {
      const page = await source.list({ prefix: "notes/", include: ["customMetadata"] });
      const notes = [];
      for (const obj of page.objects || []) {
        if (!obj.key.toLowerCase().endsWith(".md")) continue;
        const got = await source.get(obj.key);
        if (!got) continue;
        const body = typeof got.text === "function" ? await got.text() : String(got.body || "");
        const filename = obj.key.slice("notes/".length);
        notes.push({
          repo_key: obj.key,
          filename,
          body,
          uploader: got.customMetadata?.uploader || obj.customMetadata?.uploader || "",
          etag_or_updatedAt: got.httpEtag || got.etag || obj.etag || "",
        });
      }
      return notes;
    },
    mapNote(note) {
      const file = String(note.filename || "").replace(/\.md$/i, "");
      const service = /^service-(\d{4}-\d{2}-\d{2})$/i.exec(file);
      return {
        scope: service ? "service" : "page",
        target_id: service ? service[1] : (cleanPageKey(file) || file.toLowerCase()),
        body: note.body,
        author: note.uploader,
        created_at: note.created_at || "",
        pinned: true,
        pin_order: 0,
        pinned_by: note.uploader,
        repo_key: note.repo_key,
        etag_or_updatedAt: note.etag_or_updatedAt || "",
      };
    },
  };
}

export function getAdapter(name) {
  if (name === "compass-city-hub") return compassCityHubAdapter();
  return teamHubNotesAdapter();
}

export async function migrateNotes({
  adapter,
  source,
  dest,
  apply = false,
  now = new Date(),
} = {}) {
  if (!adapter) throw new Error("adapter is required");
  if (!source) throw new Error("source is required");
  const notes = await adapter.listNotes(source);
  const report = {
    adapter: adapter.name,
    apply: Boolean(apply),
    scanned: 0,
    written: 0,
    skipped: 0,
    invalid: 0,
    items: [],
  };

  for (const note of notes) {
    report.scanned += 1;
    let mapped;
    try { mapped = adapter.mapNote(note); }
    catch (err) {
      report.invalid += 1;
      report.items.push({ repo_key: note.repo_key, action: "invalid", error: err.message });
      continue;
    }
    if (!String(mapped?.body || "").length) {
      report.skipped += 1;
      report.items.push({
        repo_key: mapped.repo_key || note.repo_key,
        scope: mapped.scope,
        target_id: mapped.target_id,
        action: "skip-empty",
        byteIdentical: true,
        bodyBytes: 0,
      });
      continue;
    }

    let comment;
    try {
      comment = buildMigratedComment(mapped, { now, config: commentsConfig({ comments: { enabled: true } }) });
    } catch (err) {
      report.invalid += 1;
      report.items.push({
        repo_key: mapped.repo_key || note.repo_key,
        scope: mapped.scope,
        target_id: mapped.target_id,
        action: "invalid",
        error: err.message,
      });
      continue;
    }
    const byteIdentical = comment.body === mapped.body && comment.body === preserveBody(mapped.body);
    const item = {
      repo_key: comment.legacy.repo_key,
      scope: comment.scope,
      target_id: comment.target_id,
      bodyBytes: Buffer.byteLength(comment.body, "utf8"),
      sourceBytes: Buffer.byteLength(String(mapped.body), "utf8"),
      byteIdentical,
      truncated: comment.body.length < String(mapped.body).length,
      pinned: comment.pinned,
      pin_order: comment.pin_order,
      action: "write",
    };

    const destBucket = dest || source;
    const current = await readThread(destBucket, comment.scope, comment.target_id);
    if (hasLegacyRepoKey(current.doc, comment.legacy.repo_key)) {
      item.action = "skip-existing";
      report.skipped += 1;
      report.items.push(item);
      continue;
    }

    if (apply) {
      await updateThread({ bucket: destBucket }, comment.scope, comment.target_id, (doc) => {
        if (hasLegacyRepoKey(doc, comment.legacy.repo_key)) return doc;
        return addCommentToThread(doc, comment);
      });
      item.action = "wrote";
      report.written += 1;
    } else {
      item.action = "would-write";
      report.written += 1;
    }
    report.items.push(item);
  }

  return report;
}

export function fsBucket(root) {
  const base = resolve(root);

  const full = (key) => {
    const clean = String(key || "").replace(/^\/+/, "");
    if (!clean || clean.includes("..") || clean.includes("\\")) throw new Error(`bad key ${key}`);
    const path = resolve(base, clean);
    if (relative(base, path).startsWith("..")) throw new Error(`bad key ${key}`);
    return path;
  };

  const walk = (dir, prefix, out) => {
    let entries = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const path = join(dir, name);
      const rel = relative(base, path).split(sep).join("/");
      if (statSync(path).isDirectory()) walk(path, prefix, out);
      else if (rel.startsWith(prefix)) out.push(rel);
    }
  };

  return {
    async list({ prefix = "", include = [] } = {}) {
      const keys = [];
      walk(base, prefix, keys);
      return {
        objects: keys.map((key) => ({ key, customMetadata: include.includes("customMetadata") ? {} : undefined })),
        truncated: false,
      };
    },
    async get(key) {
      let body;
      try { body = readFileSync(full(key), "utf8"); }
      catch { return null; }
      return {
        key,
        etag: `"fs-${Buffer.byteLength(body)}"`,
        httpEtag: `"fs-${Buffer.byteLength(body)}"`,
        customMetadata: {},
        text: async () => body,
        json: async () => JSON.parse(body),
      };
    },
    async put(key, value) {
      const path = full(key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, typeof value === "string" ? value : String(value));
      return { key, etag: `"fs-written"` };
    },
    async head(key) {
      try {
        statSync(full(key));
        return { key };
      } catch {
        return null;
      }
    },
  };
}

function parseArgs(argv) {
  const args = { apply: false, adapter: "team-hub-notes", help: false };
  for (const token of argv) {
    if (token === "--apply") { args.apply = true; continue; }
    if (token === "--help" || token === "-h") { args.help = true; continue; }
    const match = token.match(/^--([a-z-]+)=(.*)$/s);
    if (!match) throw new Error(`Expected --key=value, received: ${token}`);
    const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    args[key] = match[2];
  }
  return args;
}

function usage() {
  return `Usage:
  node scripts/migrate-notes-to-comments.mjs --source-dir=<r2 dump> [--dest-dir=<dir>] [--apply]

Dry-run by default. --apply writes comments/{scope}/{target_id}.json only.
Never writes or deletes notes/ keys.

Adapters: team-hub-notes (default), compass-city-hub
  --report=<file>   write the JSON report (default: stdout only)`;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.sourceDir) throw new Error("source-dir is required (a directory of R2 keys, e.g. notes/pages/index.json)");
  const adapter = getAdapter(args.adapter);
  const source = fsBucket(args.sourceDir);
  const dest = fsBucket(args.destDir || args.sourceDir);
  const report = await migrateNotes({ adapter, source, dest, apply: args.apply });
  const text = JSON.stringify(report, null, 2);
  if (args.report) writeFileSync(args.report, `${text}\n`);
  console.log(text);
  console.log(args.apply
    ? `Wrote ${report.written} comment(s); skipped ${report.skipped}. Note keys were left untouched.`
    : `Dry-run: ${report.written} note(s) would be written; skipped ${report.skipped}. Re-run with --apply to write.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`migrate-notes-to-comments: ${error.message}`);
    process.exitCode = 1;
  });
}
