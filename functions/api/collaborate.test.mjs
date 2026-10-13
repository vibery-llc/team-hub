import assert from "node:assert/strict";
import test from "node:test";

import { onRequest } from "./[[route]].js";
import { memoryBucket } from "../_shared/memory-bucket.js";

const email = "dev@example.com";
const headers = (extra = {}) => ({
  "content-type": "application/json",
  "Cf-Access-Authenticated-User-Email": email,
  ...extra,
});

function ctx(url, { method = "GET", body, extraHeaders, bucket } = {}) {
  return {
    request: new Request(url, {
      method,
      headers: headers(extraHeaders),
      body: body == null ? undefined : JSON.stringify(body),
    }),
    env: { HUB_FILES: bucket },
    params: { route: new URL(url).pathname.replace(/^\/api\//, "").split("/") },
  };
}

async function api(bucket, url, opts) {
  return onRequest(ctx(url, { bucket, ...opts }));
}

test("files a feedback item, lists it, comments, claims, and refuses a second claimant", async () => {
  const bucket = memoryBucket();
  const created = await api(bucket, "https://hub.example/api/feedback", {
    method: "POST",
    extraHeaders: { origin: "https://hub.example" },
    body: { page: "index.html", title: "KPI stuck at zero", body: "Opened in a background tab." },
  });
  assert.equal(created.status, 201);
  const { item } = await created.json();
  assert.equal(item.page, "index");
  assert.equal(item.status, "open");
  assert.equal(item.createdBy, email);

  const listed = await api(bucket, "https://hub.example/api/feedback?page=index");
  assert.equal((await listed.json()).count, 1);

  const commented = await api(bucket, `https://hub.example/api/feedback/comment?id=${item.id}`, {
    method: "POST",
    extraHeaders: { origin: "https://hub.example" },
    body: { body: "Also happens on Files." },
  });
  assert.equal(commented.status, 200);
  assert.equal((await commented.json()).item.comments.length, 1);

  const claimed = await api(bucket, `https://hub.example/api/feedback/claim?id=${item.id}`, {
    method: "POST",
    extraHeaders: { origin: "https://hub.example" },
  });
  assert.equal((await claimed.json()).item.status, "claimed");

  const other = await onRequest(ctx(`https://hub.example/api/feedback/claim?id=${item.id}`, {
    method: "POST",
    extraHeaders: { origin: "https://hub.example", "Cf-Access-Authenticated-User-Email": "other@example.com" },
    bucket,
  }));
  assert.equal(other.status, 409);
});

test("a cross-site Origin cannot file feedback or propose a note", async () => {
  const bucket = memoryBucket();
  const feedback = await api(bucket, "https://hub.example/api/feedback", {
    method: "POST",
    extraHeaders: { origin: "https://evil.example" },
    body: { page: "index", title: "x", body: "y" },
  });
  assert.equal(feedback.status, 403);
  assert.match((await feedback.json()).error, /cross-site write refused/);

  const proposal = await api(bucket, "https://hub.example/api/proposals", {
    method: "POST",
    extraHeaders: { origin: "https://evil.example" },
    body: { page: "index", body: "pin this" },
  });
  assert.equal(proposal.status, 403);
});

test("an agent can propose a note; pinning and approving need a browser Origin", async () => {
  const bucket = memoryBucket();

  const pin = await api(bucket, "https://hub.example/api/notes?page=index", {
    method: "PUT",
    body: { body: "direct pin" },
  });
  assert.equal(pin.status, 403);
  assert.match((await pin.json()).error, /same-site browser/);

  const proposed = await api(bucket, "https://hub.example/api/proposals", {
    method: "POST",
    body: { page: "index", body: "Ship the Friday build." },
  });
  assert.equal(proposed.status, 201);
  const { proposal } = await proposed.json();
  assert.equal(proposal.status, "pending");

  const sneak = await api(bucket, `https://hub.example/api/proposals/approve?id=${proposal.id}`, {
    method: "POST",
  });
  assert.equal(sneak.status, 403);

  const approved = await api(bucket, `https://hub.example/api/proposals/approve?id=${proposal.id}`, {
    method: "POST",
    extraHeaders: { origin: "https://hub.example" },
  });
  assert.equal(approved.status, 200);
  const result = await approved.json();
  assert.equal(result.proposal.status, "approved");
  assert.equal(result.note.body, "Ship the Friday build.");

  const note = await api(bucket, "https://hub.example/api/notes?page=index");
  assert.equal((await note.json()).note.body, "Ship the Friday build.");
});

test("a human in the hub can pin a note directly", async () => {
  const bucket = memoryBucket();
  const res = await api(bucket, "https://hub.example/api/notes?page=meetings", {
    method: "PUT",
    extraHeaders: { origin: "https://hub.example" },
    body: { body: "Do not publish the full recording." },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).note.updatedBy, email);
});
