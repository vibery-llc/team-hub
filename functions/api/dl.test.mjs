/*
 * Proves /api/dl shows a file inline only when it is a type that can't run
 * script. The stored content type is whatever the uploader claimed, so an
 * html or svg upload opened with ?inline=1 used to render on the hub's own
 * origin. Images, video and audio still play inline (the Files page previews
 * and the meeting player depend on it), range requests still answer 206 so
 * video can seek, and every download says nosniff.
 *
 * Runs the real route against a stub R2 bucket; no Access settings in env,
 * so identity falls back to the header as on `wrangler pages dev`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { inlineType, onRequest } from "./[[route]].js";

const BODY = "0123456789";

function bucketWith(contentType) {
  return {
    async get(key, { range } = {}) {
      const r = range?.get?.("range");
      const m = r && /^bytes=(\d+)-(\d+)$/.exec(r);
      const out = m ? { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 } : undefined;
      return {
        body: m ? BODY.slice(out.offset, out.offset + out.length) : BODY,
        size: BODY.length,
        range: out,
        httpEtag: '"etag"',
        writeHttpMetadata(h) { h.set("content-type", contentType); },
      };
    },
  };
}

async function download(key, contentType, { inline = true, headers = {} } = {}) {
  return onRequest({
    request: new Request(`https://hub.example/api/dl?key=${encodeURIComponent(key)}${inline ? "&inline=1" : ""}`, { headers }),
    env: { HUB_FILES: bucketWith(contentType) },
    params: { route: ["dl"] },
  });
}

test("images, video and audio are shown inline when asked", async () => {
  for (const [key, type] of [
    ["share/shot.png", "image/png"],
    ["share/photo.jpg", "image/jpeg"],
    ["clips/clip.mp4", "video/mp4"],
    ["clips/clip.mov", "video/quicktime"],
    ["meetings/talk.m4a", "audio/mp4"],
  ]) {
    const res = await download(key, type);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition"), /^inline;/, `${type} should be inline`);
  }
});

test("anything that could run script downloads instead, even with ?inline=1", async () => {
  for (const [key, type] of [
    ["share/page.html", "text/html"],
    ["share/page.html", "text/html; charset=utf-8"],
    ["share/logo.svg", "image/svg+xml"],
    ["share/doc.pdf", "application/pdf"],
    ["share/app.js", "text/javascript"],
    ["share/blob.bin", "application/octet-stream"],
  ]) {
    const res = await download(key, type);
    assert.match(res.headers.get("content-disposition"), /^attachment;/, `${type} must not render inline`);
  }
});

test("a stored type that smuggles html after a comma can't render inline", async () => {
  // Browsers take the LAST entry of a comma-separated Content-Type, so the
  // header sent must be the checked type, never the uploader's string.
  const res = await download("share/a.mp4", "video/mp4;x=,text/html");
  assert.match(res.headers.get("content-disposition"), /^inline;/);
  assert.equal(res.headers.get("content-type"), "video/mp4", "must send the validated type, not the stored header");
  for (const type of ["text/html,video/mp4", "video/x+xml", "video/mp4+xml", "audio/svg+xml"]) {
    const r = await download("share/b.mp4", type);
    assert.match(r.headers.get("content-disposition"), /^attachment;/, `${type} must not render inline`);
  }
});

test("every download says nosniff, and a plain download stays an attachment", async () => {
  const res = await download("clips/clip.mp4", "video/mp4", { inline: false });
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("content-disposition"), /^attachment;/);
});

test("a range request still answers 206 so video can seek", async () => {
  const res = await download("clips/clip.mp4", "video/mp4", { headers: { range: "bytes=2-5" } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), `bytes 2-5/${BODY.length}`);
  assert.equal(await res.text(), "2345");
});

test("inlineType reads only the media type, case-insensitively", () => {
  assert.equal(inlineType("IMAGE/PNG"), "image/png");
  assert.equal(inlineType("video/mp4; codecs=avc1"), "video/mp4");
  assert.equal(inlineType("image/svg+xml"), null);
  assert.equal(inlineType(""), null);
  assert.equal(inlineType(undefined), null);
});
