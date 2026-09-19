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
 *   --latest-json=<file>   also upload this small JSON as
 *                           builds/<platform>/latest.json (overwrites)
 *   --manifest-only        skip the build upload; verify the stored build
 *                           matches <file>, then write just latest.json.
 *                           This is the retry path for a run that died
 *                           between the two uploads (requires --latest-json)
 *   --note=<text>          short note stored as metadata (<=200 chars)
 *   --content-type=<mime>  override the guessed Content-Type
 *   --dry-run              print what would happen, make no network calls
 *   --help                 print this usage
 *
 * Environment (read only, never logged or printed):
 *   HUB_URL             base URL of the deployed hub, e.g. https://my-hub.pages.dev
 *   HUB_ACCESS_ID       Cloudflare Access service token Client Id     (build machines only)
 *   HUB_ACCESS_SECRET   Cloudflare Access service token Client Secret (build machines only)
 *
 * The hub sits behind Cloudflare Access. How this run gets through, first
 * match wins (see resolveAccess):
 *   1. HUB_ACCESS_ID + HUB_ACCESS_SECRET: a service token, for a build machine
 *      with nobody at it. Uploads are recorded against the token, not a person.
 *   2. `cloudflared access token -app=<HUB_URL>`: the person at this machine,
 *      after signing in once with `cloudflared access login <HUB_URL>`. Uploads
 *      are recorded against their email.
 *   3. Neither: no credentials at all. That only works against `wrangler pages
 *      dev`, which has no Access gate in front of it.
 * Before uploading, the script asks the hub who it thinks you are and prints
 * it, so a run that Access would turn away fails before any bytes move.
 */

import { execFileSync } from "node:child_process";
import { open, stat, readFile } from "node:fs/promises";

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
    "  --latest-json=<file>   also write builds/<platform>/latest.json (overwrites)",
    "  --manifest-only        skip the build upload; verify the stored build matches",
    "                         <file>, then write just latest.json (the retry path for",
    "                         a run that died between the two uploads)",
    "  --note=<text>          short note stored as metadata (<=200 chars)",
    "  --content-type=<mime>  override the guessed Content-Type",
    "  --dry-run              print what would happen, make no network calls",
    "  --help                 print this usage",
    "",
    "Environment (never logged or printed):",
    "  HUB_URL             e.g. https://my-hub.pages.dev",
    "  HUB_ACCESS_ID       Cloudflare Access service token Client Id (build machines)",
    "  HUB_ACCESS_SECRET   Cloudflare Access service token Client Secret (build machines)",
    "",
    "On your own machine, skip the token: sign in once with",
    "  cloudflared access login <HUB_URL>",
    "and uploads are recorded against your email.",
  ];
}

function parseArgs(argv) {
  const positional = [];
  const opts = { dryRun: false, help: false, manifestOnly: false };
  for (const token of argv) {
    if (token === "--help" || token === "-h") { opts.help = true; continue; }
    if (token === "--dry-run") { opts.dryRun = true; continue; }
    if (token === "--manifest-only") { opts.manifestOnly = true; continue; }
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

/* The person's own Access session, from `cloudflared access login`. Returns
   null when cloudflared is missing (it throws), the person hasn't signed in
   (it exits non-zero), or the session has expired (it deletes the session,
   exits 0 and prints nothing). Anything that isn't a JWT counts as no token,
   so an error message can never be sent as a credential. */
function cloudflaredToken(baseUrl) {
  try {
    const out = execFileSync("cloudflared", ["access", "token", `-app=${baseUrl}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
    }).trim();
    return /^[\w-]+\.[\w-]+\.[\w-]+$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/* Which credentials this run sends, first match wins. The service token
   stays first so a build machine that has one keeps working exactly as
   before, even if someone once ran cloudflared on it. */
function resolveAccess(env, baseUrl, getToken = cloudflaredToken) {
  if (env.HUB_ACCESS_ID && env.HUB_ACCESS_SECRET) {
    return {
      via: "service token",
      headers: { "CF-Access-Client-Id": env.HUB_ACCESS_ID, "CF-Access-Client-Secret": env.HUB_ACCESS_SECRET },
    };
  }
  const token = getToken(baseUrl);
  if (token) return { via: "cloudflared", headers: { "cf-access-token": token } };
  return { via: null, headers: {} };
}

let access = { via: null, headers: {} };

async function apiFetch(baseUrl, path, opts = {}) {
  const headers = { ...access.headers, ...(opts.headers || {}) };
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

  /* Read the manifest before anything uploads, so a bad --latest-json path
     fails here rather than after the build zip is already published. */
  let latestBody = null;
  if (opts.latestJson) {
    latestBody = await readFile(opts.latestJson).catch(() => {
      throw new Error(`No such file: ${opts.latestJson} (--latest-json)`);
    });
    try { JSON.parse(String(latestBody)); }
    catch { throw new Error(`--latest-json is not valid JSON: ${opts.latestJson}`); }
  }
  if (opts.manifestOnly && !latestBody) {
    throw new Error("--manifest-only needs --latest-json — there is nothing else for it to publish.");
  }

  if (!process.env.HUB_URL) {
    throw new Error("HUB_URL is not set — e.g. export HUB_URL=https://my-hub.pages.dev");
  }
  const baseUrl = process.env.HUB_URL.replace(/\/+$/, "");

  console.log(`${filePath} -> ${key} (${fmtSize(info.size)}, ${contentType})`);

  if (opts.dryRun) {
    if (opts.manifestOnly) {
      console.log(`[dry-run] would check ${key} is already stored with exactly ${info.size} bytes`);
    } else {
      console.log(`[dry-run] would upload in ${Math.ceil(info.size / CHUNK)} chunk(s) of up to ${fmtSize(CHUNK)}`);
      console.log(`[dry-run] would print: ${baseUrl}/api/dl?key=${encodeURIComponent(key)}`);
    }
    if (latestBody) console.log(`[dry-run] would overwrite: ${AREA}/${platform}/latest.json (${fmtSize(latestBody.length)})`);
    return;
  }

  access = resolveAccess(process.env, baseUrl);
  if (!access.via) {
    console.error(
      `No Access credentials: sign in once with \`cloudflared access login ${baseUrl}\`, or set ` +
      "HUB_ACCESS_ID / HUB_ACCESS_SECRET on a build machine. Sending unauthenticated requests, which " +
      "only works against a hub with no Access gate in front of it (e.g. `wrangler pages dev`)."
    );
  }
  console.log(`publishing as ${await whoami(baseUrl)}`);

  if (opts.manifestOnly) {
    /* The exact key as the prefix, not the platform folder: the listing route
       stops at 5000 objects, so a folder-wide scan could miss the target key
       and report a stored build as absent. */
    const listed = await apiFetch(baseUrl, `files?prefix=${encodeURIComponent(key)}`);
    assertStoredBuildMatches(await listed.json(), key, info.size);
    console.log(`verified: ${key} is already stored with a matching size — skipping the build upload`);
    await publishLatestManifest(baseUrl, platform, latestBody);
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
      const retryHint = latestBody
        ? "If this is a retry of a run that died after the build uploaded, re-run with --manifest-only to verify the stored build and refresh just latest.json. Otherwise try"
        : "Try";
      throw new Error(
        `${key} already exists — refusing to overwrite it. ${retryHint} a versioned name instead, e.g.\n` +
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

  if (latestBody) await publishLatestManifest(baseUrl, platform, latestBody);
}

/* latest.json is only a pointer; writing it against a mismatched object would
   hand users a manifest describing different bytes than they download. Build
   names like {semver}-{date}-{branch}-{platform} collide across same-day
   rebuilds of the same branch, so "the key already exists" is not proof the
   stored zip is this zip. The size check is the strongest contradiction the
   hub API offers today — the listing carries sizes, while a multipart etag is
   not comparable to a local hash. A same-size different-bytes rebuild still
   passes; upgrading to a content digest is tracked as issue #17. */
function assertStoredBuildMatches(listing, key, localSize) {
  const stored = (listing?.files || []).find((f) => f.key === key);
  if (!stored) {
    throw new Error(
      `--manifest-only: ${key} is not in the bucket, so there is no build for latest.json to point at. ` +
      "Re-run without --manifest-only to upload it."
    );
  }
  if (stored.size !== localSize) {
    throw new Error(
      `--manifest-only: ${key} holds a different build (stored ${stored.size} bytes, local ${localSize} bytes) — ` +
      "refusing to publish a manifest that misdescribes the stored zip. Publish this build under a versioned --name instead."
    );
  }
  return stored;
}

/* Access turns away a request it won't let through in one of two ways: a 401
   (to a non-browser client, once Managed OAuth is on for the application) or
   a redirect to its login page, which fetch follows into an HTML 200. Asking
   /api/whoami first turns either into a clear message before any upload
   starts, and tells the person who the upload will be recorded against. */
async function whoami(baseUrl) {
  const refused = new Error(
    `Cloudflare Access did not let this request through to ${baseUrl}. Sign in with ` +
    `\`cloudflared access login ${baseUrl}\` (your session may have expired), or set ` +
    "HUB_ACCESS_ID / HUB_ACCESS_SECRET on a build machine."
  );
  let res;
  try { res = await apiFetch(baseUrl, "whoami"); }
  catch (err) {
    if (err.status !== 401 && err.status !== 403) throw err;
    /* Keep the hub's own reason when it gave one: "issued for a different application" is
       not something signing in again can fix, and hiding it sends people round in circles. */
    if (/^\d{3} /.test(err.message)) throw refused;
    throw new Error(`${refused.message}\n  The hub said: ${err.message}`);
  }
  let body;
  try { body = await res.json(); } catch { body = null; }
  if (!body || typeof body.email !== "string") throw refused;
  return body.email;
}

async function publishLatestManifest(baseUrl, platform, body) {
  const manifestKey = `${AREA}/${platform}/latest.json`;
  await apiFetch(baseUrl, `files?key=${encodeURIComponent(manifestKey)}`, {
    method: "POST",
    headers: { "x-file-type": "application/json", "content-type": "application/json" },
    body,
  });
  console.log(`latest: ${baseUrl}/api/dl?key=${encodeURIComponent(manifestKey)}`);
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((err) => {
    console.error(`publish-build: ${err.message}`);
    process.exitCode = 1;
  });
}

export { parseArgs, sanitizeSegment, guessContentType, versionedSuggestion, assertStoredBuildMatches, resolveAccess };
