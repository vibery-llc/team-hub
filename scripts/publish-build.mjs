#!/usr/bin/env node
/**
 * Publish a locally-built artifact to the hub's builds/ prefix in R2.
 *
 * There is deliberately no CI workflow that produces this file. The first
 * tenant of this template builds a Unity game against a machine-bound
 * license with no CI at all, and other tenants will have their own reasons
 * a build can only happen on someone's machine. So this is the on-ramp: a
 * developer builds locally, then runs this script to push the artifact to
 * the same builds/<platform>/ prefix the Files page reads "latest build"
 * cards from.
 *
 * It drives the same chunked multipart route functions/api/[[route]].js
 * exposes to the browser (mpu/create, mpu/part, mpu/complete), not a single
 * request, because builds are large. Any failure aborts the multipart
 * upload so no partial object is left in the bucket.
 *
 * Usage:
 *   node scripts/publish-build.mjs <file> <platform> [options]
 *
 *   node scripts/publish-build.mjs ./dist/MyGame-1.4.0.zip windows
 *
 * Options:
 *   --name=<file name>     override the uploaded file name (default: the
 *                           local file's base name) — use this to publish
 *                           under a versioned name
 *   --note=<text>          short note stored as metadata (<=200 chars)
 *   --content-type=<mime>  override the guessed Content-Type
 *   --dry-run              print what would happen, make no network calls
 *   --help                 print this usage
 *
 * Required environment (read only, never logged or printed):
 *   HUB_URL             base URL of the deployed hub, e.g. https://my-hub.pages.dev
 *   HUB_ACCESS_ID       Cloudflare Access service token Client Id
 *   HUB_ACCESS_SECRET   Cloudflare Access service token Client Secret
 *
 * The hub sits behind Cloudflare Access, so a machine caller authenticates
 * with a service token (Access → Service Auth in the Cloudflare dashboard),
 * sent as the CF-Access-Client-Id / CF-Access-Client-Secret headers. If
 * HUB_ACCESS_ID or HUB_ACCESS_SECRET is unset, the script proceeds without
 * those headers — useful against `wrangler pages dev`, which has no Access
 * gate in front of it — and Access will reject the request if the target
 * hub is actually gated.
 */

import { open, stat } from "node:fs/promises";

const CHUNK = 32 * 1024 * 1024; // matches the browser uploader in site/files.html
const AREA = "builds";
const KEY_SEGMENT = /^[\w. ()+@-]+$/; // must match cleanKey() in functions/api/[[route]].js

function usage() {
  return [
    "Usage:",
    "  node scripts/publish-build.mjs <file> <platform> [options]",
    "",
    "  node scripts/publish-build.mjs ./dist/MyGame-1.4.0.zip windows",
    "",
    "Options:",
    "  --name=<file name>     upload under this name instead of the local file's",
    "  --note=<text>          short note stored as metadata (<=200 chars)",
    "  --content-type=<mime>  override the guessed Content-Type",
    "  --dry-run              print what would happen, make no network calls",
    "  --help                 print this usage",
    "",
    "Required environment (never logged or printed):",
    "  HUB_URL             e.g. https://my-hub.pages.dev",
    "  HUB_ACCESS_ID       Cloudflare Access service token Client Id",
    "  HUB_ACCESS_SECRET   Cloudflare Access service token Client Secret",
  ];
}

function parseArgs(argv) {
  const positional = [];
  const opts = { dryRun: false, help: false };
  for (const token of argv) {
    if (token === "--help" || token === "-h") { opts.help = true; continue; }
    if (token === "--dry-run") { opts.dryRun = true; continue; }
    const match = token.match(/^--([a-z-]+)=(.*)$/s);
    if (match) {
      const key = match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      opts[key] = match[2];
      continue;
    }
    if (token.startsWith("-")) throw new Error(`Unrecognized option: ${token}`);
    positional.push(token);
  }
  return { positional, opts };
}

/* Same sanitizing the browser applies in files.html's keyFor(), so a name
   that would be rejected by cleanKey() never reaches the network. Dots stay
   allowed (extensions need them), so a run of ".." can still survive this
   replace — assertValidSegment below closes that gap the same way
   cleanKey()'s explicit ".." check does. */
function sanitizeSegment(raw, replacement) {
  return String(raw).trim().replace(/[^\w. ()+@-]/g, replacement);
}

function assertValidSegment(value, label) {
  if (!value || value === "." || value === ".." || value.includes("..") || !KEY_SEGMENT.test(value)) {
    throw new Error(`"${value}" is not a usable ${label} (letters, digits, spaces, . _ - + @ ( ) only, no "..").`);
  }
  return value;
}

const MIME_BY_EXT = {
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
  tgz: "application/gzip",
  exe: "application/vnd.microsoft.portable-executable",
  msi: "application/x-msi",
  dmg: "application/x-apple-diskimage",
  pkg: "application/x-newton-compatible-pkg",
  apk: "application/vnd.android.package-archive",
  aab: "application/octet-stream",
  ipa: "application/octet-stream",
};

function guessContentType(name) {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return MIME_BY_EXT[extension] || "application/octet-stream";
}

function fmtSize(n) {
  if (!Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function versionedSuggestion(name) {
  const dot = name.lastIndexOf(".");
  const stamp = new Date().toISOString().slice(0, 10);
  return dot > 0 ? `${name.slice(0, dot)}-${stamp}${name.slice(dot)}` : `${name}-${stamp}`;
}

async function apiFetch(baseUrl, path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (process.env.HUB_ACCESS_ID && process.env.HUB_ACCESS_SECRET) {
    headers["CF-Access-Client-Id"] = process.env.HUB_ACCESS_ID;
    headers["CF-Access-Client-Secret"] = process.env.HUB_ACCESS_SECRET;
  }
  const res = await fetch(`${baseUrl}/api/${path}`, { ...opts, headers });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body (e.g. an Access login-page redirect) — keep the status line
    }
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return res;
}

async function abortUpload(baseUrl, key, uploadId) {
  try {
    await apiFetch(
      baseUrl,
      `mpu/abort?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}`,
      { method: "DELETE" }
    );
    console.error(`  aborted multipart upload for ${key} — no partial object left in the bucket.`);
  } catch (err) {
    console.error(`  WARNING: failed to abort the multipart upload (${err.message}). Check the bucket for a stray upload for key ${key}.`);
  }
}

async function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));

  if (opts.help || positional.length === 0) {
    console.log(usage().join("\n"));
    return;
  }

  const [filePath, platformRaw] = positional;
  if (!filePath || !platformRaw) {
    throw new Error("Both <file> and <platform> are required. Run with --help for usage.");
  }

  const platform = assertValidSegment(
    sanitizeSegment(platformRaw, "-").replace(/-+/g, "-").replace(/^-|-$/g, ""),
    "platform segment"
  );

  const info = await stat(filePath).catch(() => {
    throw new Error(`No such file: ${filePath}`);
  });
  if (!info.isFile()) throw new Error(`Not a regular file: ${filePath}`);
  if (info.size === 0) throw new Error(`Refusing to upload an empty file: ${filePath}`);

  const localName = filePath.split(/[\\/]/).pop();
  const uploadName = assertValidSegment(sanitizeSegment(opts.name || localName, "_"), "file name");
  if (opts.note && opts.note.length > 200) throw new Error("--note must be 200 characters or fewer.");

  const key = `${AREA}/${platform}/${uploadName}`;
  const contentType = opts.contentType || guessContentType(uploadName);

  if (!process.env.HUB_URL) {
    throw new Error("HUB_URL is not set — e.g. export HUB_URL=https://my-hub.pages.dev");
  }
  const baseUrl = process.env.HUB_URL.replace(/\/+$/, "");
  if (!process.env.HUB_ACCESS_ID || !process.env.HUB_ACCESS_SECRET) {
    console.error("HUB_ACCESS_ID / HUB_ACCESS_SECRET not set — sending unauthenticated requests. This only works against a hub with no Access gate in front of it (e.g. `wrangler pages dev`).");
  }

  console.log(`${filePath} -> ${key} (${fmtSize(info.size)}, ${contentType})`);

  if (opts.dryRun) {
    console.log(`[dry-run] would upload in ${Math.ceil(info.size / CHUNK)} chunk(s) of up to ${fmtSize(CHUNK)}`);
    console.log(`[dry-run] would print: ${baseUrl}/api/dl?key=${encodeURIComponent(key)}`);
    return;
  }

  let uploadId;
  try {
    const created = await apiFetch(
      baseUrl,
      `mpu/create?key=${encodeURIComponent(key)}&type=${encodeURIComponent(contentType)}${opts.note ? `&note=${encodeURIComponent(opts.note)}` : ""}`,
      { method: "POST" }
    );
    ({ uploadId } = await created.json());
  } catch (err) {
    if (err.status === 409) {
      throw new Error(
        `${key} already exists — refusing to overwrite it. Try a versioned name instead, e.g.\n` +
        `  node scripts/publish-build.mjs ${filePath} ${platformRaw} --name="${versionedSuggestion(uploadName)}"`
      );
    }
    throw err;
  }

  const fh = await open(filePath, "r");
  try {
    const total = Math.ceil(info.size / CHUNK);
    const parts = [];
    for (let i = 0; i < total; i++) {
      const start = i * CHUNK;
      const length = Math.min(CHUNK, info.size - start);
      const buffer = Buffer.allocUnsafe(length);
      await fh.read(buffer, 0, length, start);
      const res = await apiFetch(
        baseUrl,
        `mpu/part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&part=${i + 1}`,
        { method: "PUT", body: buffer }
      );
      const part = await res.json();
      parts.push(part);
      process.stderr.write(`\r  part ${i + 1}/${total} · ${fmtSize(start + length)}/${fmtSize(info.size)}`);
    }
    process.stderr.write("\n");

    await apiFetch(baseUrl, `mpu/complete?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts }),
    });
  } catch (err) {
    console.error(`\nupload failed: ${err.message}`);
    await abortUpload(baseUrl, key, uploadId);
    throw err;
  } finally {
    await fh.close();
  }

  console.log(`done: ${baseUrl}/api/dl?key=${encodeURIComponent(key)}`);
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((err) => {
    console.error(`publish-build: ${err.message}`);
    process.exitCode = 1;
  });
}

export { parseArgs, sanitizeSegment, guessContentType, versionedSuggestion };
