import assert from "node:assert/strict";
import test from "node:test";

import { browserWrite, hostOf, sameSiteWrite } from "./origin.js";

const req = (url, headers = {}) => new Request(url, { method: "POST", headers });

test("hostOf reads a URL host and rejects junk", () => {
  assert.equal(hostOf("https://hub.example/api/notes"), "hub.example");
  assert.equal(hostOf("https://hub.example:8788/mcp"), "hub.example:8788");
  assert.equal(hostOf("not a url"), "");
});

test("a same-origin browser write is allowed", () => {
  const r = req("https://hub.example/api/notes", {
    origin: "https://hub.example",
    "sec-fetch-site": "same-origin",
  });
  assert.deepEqual(sameSiteWrite(r), { ok: true });
  assert.deepEqual(browserWrite(r), { ok: true });
});

test("a headerless request (MCP, curl) is a same-site write but not a browser write", () => {
  const r = req("https://hub.example/mcp");
  assert.deepEqual(sameSiteWrite(r), { ok: true });
  assert.equal(browserWrite(r).ok, false);
  assert.match(browserWrite(r).error, /same-site browser/);
});

test("an Origin from another host is refused, even with a matching Referer omitted", () => {
  const r = req("https://hub.example/api/notes", { origin: "https://evil.example" });
  assert.equal(sameSiteWrite(r).ok, false);
  assert.match(sameSiteWrite(r).error, /cross-site write refused/);
  assert.equal(browserWrite(r).ok, false);
});

test("a Referer from another host is refused", () => {
  const r = req("https://hub.example/api/proposals", { referer: "https://evil.example/page" });
  assert.equal(sameSiteWrite(r).ok, false);
  assert.match(sameSiteWrite(r).error, /cross-site write refused/);
});

test("Sec-Fetch-Site: cross-site is refused even with no Origin", () => {
  const r = req("https://hub.example/mcp", { "sec-fetch-site": "cross-site" });
  assert.equal(sameSiteWrite(r).ok, false);
  assert.match(sameSiteWrite(r).error, /cross-site write refused/);
});

test("an unreadable Origin is refused rather than skipped", () => {
  const r = req("https://hub.example/api/notes", { origin: "::::" });
  assert.equal(sameSiteWrite(r).ok, false);
});

test("same-site Sec-Fetch-Site without Origin still counts as a browser write", () => {
  const r = req("https://hub.example/api/notes", { "sec-fetch-site": "same-site" });
  assert.deepEqual(browserWrite(r), { ok: true });
});
