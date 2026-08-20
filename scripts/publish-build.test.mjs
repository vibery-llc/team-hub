/*
 * Proves the publish flow can no longer stamp builds/<platform>/latest.json
 * against bytes it never verified. Build names ({semver}-{date}-{branch})
 * collide across same-day rebuilds, so a 409 from mpu/create must refuse —
 * even with --latest-json — and the manifest-refresh retry path must be the
 * explicit --manifest-only flag, which checks the stored object's size
 * against the local file before overwriting the manifest.
 *
 * The behavioral tests run the script as a child process against a stub hub
 * API on localhost, then assert on exit code, message, and which routes were
 * actually hit (a refusal that still wrote the manifest would fail here).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertStoredBuildMatches, parseArgs } from "./publish-build.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "publish-build.mjs");

const ZIP_BYTES = Buffer.from("PK\x03\x04 not a real archive, size is what matters");
const KEY = "builds/windows/game.zip";

const workDir = await mkdtemp(join(tmpdir(), "publish-build-test-"));
const zipPath = join(workDir, "game.zip");
const manifestPath = join(workDir, "latest.json");
await writeFile(zipPath, ZIP_BYTES);
await writeFile(manifestPath, JSON.stringify({ version: "1.0.0", file: "game.zip" }));

/* Routes are "METHOD /pathname"; a hit outside the map answers 500 so a test
   can only pass when the script touches exactly the endpoints it expects. */
function startStub(handlers) {
  return new Promise((resolve) => {
    const requests = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      const target = url.searchParams.get("prefix") || url.searchParams.get("key") || "";
      requests.push(`${req.method} ${url.pathname}${target ? ` ${target}` : ""}`);
      const reply = handlers[`${req.method} ${url.pathname}`] || { status: 500, body: { error: `unexpected ${req.method} ${url.pathname}` } };
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ requests, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function runScript(args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { ...process.env, HUB_ACCESS_ID: "", HUB_ACCESS_SECRET: "", ...env } },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

test("parseArgs understands --manifest-only and still rejects unknown flags", () => {
  const { opts } = parseArgs([zipPath, "windows", "--manifest-only"]);
  assert.equal(opts.manifestOnly, true);
  assert.equal(parseArgs([zipPath, "windows"]).opts.manifestOnly, false);
  assert.throws(() => parseArgs(["--manifest_only"]), /Unrecognized option/);
});

test("assertStoredBuildMatches accepts only a same-size object under the same key", () => {
  const stored = { key: KEY, size: ZIP_BYTES.length };
  assert.equal(assertStoredBuildMatches({ files: [stored] }, KEY, ZIP_BYTES.length), stored);
  assert.throws(() => assertStoredBuildMatches({ files: [] }, KEY, ZIP_BYTES.length), /not in the bucket/);
  assert.throws(
    () => assertStoredBuildMatches({ files: [{ key: KEY, size: ZIP_BYTES.length + 1 }] }, KEY, ZIP_BYTES.length),
    /different build/,
  );
});

test("409 with --latest-json refuses instead of silently refreshing the manifest", async () => {
  const stub = await startStub({
    "POST /api/mpu/create": { status: 409, body: { error: "exists" } },
  });
  try {
    const run = await runScript([zipPath, "windows", `--latest-json=${manifestPath}`], { HUB_URL: stub.url });
    assert.equal(run.code, 1, `expected failure, got:\n${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /already exists — refusing to overwrite/);
    assert.match(run.stderr, /--manifest-only/, "must point the retry at the explicit verified path");
    assert.ok(!stub.requests.some((r) => r.startsWith("POST /api/files")), "must not write latest.json after a refusal");
  } finally {
    await stub.close();
  }
});

test("bare 409 still refuses with the versioned-name suggestion", async () => {
  const stub = await startStub({
    "POST /api/mpu/create": { status: 409, body: { error: "exists" } },
  });
  try {
    const run = await runScript([zipPath, "windows"], { HUB_URL: stub.url });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /already exists — refusing to overwrite/);
    assert.match(run.stderr, /--name="game-\d{4}-\d{2}-\d{2}\.zip"/);
  } finally {
    await stub.close();
  }
});

test("--manifest-only publishes the manifest once the stored size matches", async () => {
  const stub = await startStub({
    "GET /api/files": { status: 200, body: { files: [{ key: KEY, size: ZIP_BYTES.length }] } },
    "POST /api/files": { status: 201, body: { ok: true } },
  });
  try {
    const run = await runScript([zipPath, "windows", `--latest-json=${manifestPath}`, "--manifest-only"], { HUB_URL: stub.url });
    assert.equal(run.code, 0, `expected success, got:\n${run.stdout}${run.stderr}`);
    assert.deepEqual(
      stub.requests,
      [`GET /api/files ${KEY}`, "POST /api/files builds/windows/latest.json"],
      "verify the stored build via its exact key (the folder-wide listing caps at 5000), then write only the manifest",
    );
  } finally {
    await stub.close();
  }
});

test("--manifest-only hard-errors when the stored zip has different bytes", async () => {
  const stub = await startStub({
    "GET /api/files": { status: 200, body: { files: [{ key: KEY, size: ZIP_BYTES.length + 7 }] } },
  });
  try {
    const run = await runScript([zipPath, "windows", `--latest-json=${manifestPath}`, "--manifest-only"], { HUB_URL: stub.url });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /different build/);
    assert.ok(!stub.requests.some((r) => r.startsWith("POST /api/files")), "must not write a manifest that misdescribes the stored zip");
  } finally {
    await stub.close();
  }
});

test("--manifest-only hard-errors when nothing is stored under the key", async () => {
  const stub = await startStub({
    "GET /api/files": { status: 200, body: { files: [] } },
  });
  try {
    const run = await runScript([zipPath, "windows", `--latest-json=${manifestPath}`, "--manifest-only"], { HUB_URL: stub.url });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /not in the bucket/);
  } finally {
    await stub.close();
  }
});

test("--manifest-only without --latest-json fails before touching the network", async () => {
  const run = await runScript([zipPath, "windows", "--manifest-only"], { HUB_URL: "http://127.0.0.1:9" });
  assert.equal(run.code, 1);
  assert.match(run.stderr, /--manifest-only needs --latest-json/);
});
