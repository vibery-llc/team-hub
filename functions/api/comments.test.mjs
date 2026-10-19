import assert from "node:assert/strict";
import test from "node:test";

import { onRequest } from "./[[route]].js";
import { memoryBucket } from "../_shared/memory-bucket.js";

const person = "dev@example.com";
const admin = "admin@example.com";
const other = "other@example.com";

const ENABLED = {
  comments: { enabled: true, admins: [admin] },
};

function headers(email, extra = {}) {
  return {
    "content-type": "application/json",
    "Cf-Access-Authenticated-User-Email": email,
    ...extra,
  };
}

function ctx(url, { method = "GET", body, email = person, extraHeaders, bucket, config = ENABLED } = {}) {
  return {
    request: new Request(url, {
      method,
      headers: headers(email, extraHeaders),
      body: body == null ? undefined : JSON.stringify(body),
    }),
    env: { HUB_FILES: bucket, HUB_CONFIG: config },
    params: { route: new URL(url).pathname.replace(/^\/api\//, "").split("/") },
  };
}

async function api(bucket, url, opts) {
  return onRequest(ctx(url, { bucket, ...opts }));
}

async function create(bucket, fields, opts = {}) {
  return api(bucket, "https://hub.example/api/comments", {
    method: "POST",
    extraHeaders: { origin: "https://hub.example" },
    body: { scope: "home", target_id: "home", body: "Welcome home", ...fields },
    ...opts,
  });
}

test("comments API is 404 while the tenant flag is off", async () => {
  const bucket = memoryBucket();
  const res = await api(bucket, "https://hub.example/api/comments?scope=home&target_id=home", {
    config: { comments: { enabled: false, admins: [] } },
  });
  assert.equal(res.status, 404);
  const posted = await create(bucket, {}, { config: { comments: { enabled: false } } });
  assert.equal(posted.status, 404);
});

test("a person can post and list; a spoofed author is ignored", async () => {
  const bucket = memoryBucket();
  const created = await create(bucket, { author: "attacker@evil.example", body: "Welcome home" });
  assert.equal(created.status, 201);
  const { comment } = await created.json();
  assert.equal(comment.author, person);
  assert.equal(comment.author_kind, "person");
  assert.equal(comment.body, "Welcome home");
  assert.equal(comment.scope, "home");
  assert.equal(comment.target_id, "home");

  const listed = await api(bucket, "https://hub.example/api/comments?scope=home&target_id=index");
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.equal(body.comments.length, 1);
  assert.equal(body.comments[0].author, person);
});

test("an agent may post with a bot label and cannot pin, unpin, reorder or delete", async () => {
  const bucket = memoryBucket();
  const created = await api(bucket, "https://hub.example/api/comments", {
    method: "POST",
    body: { scope: "page", target_id: "meetings", body: "From MCP", agent_name: "Codex" },
  });
  assert.equal(created.status, 201);
  const { comment } = await created.json();
  assert.equal(comment.author_kind, "agent");
  assert.equal(comment.author_label, "Codex");
  assert.equal(comment.author, person);

  for (const path of [`pin`, `unpin`, `reorder`]) {
    const res = await api(bucket, `https://hub.example/api/comments/${comment.id}/${path}`, {
      method: "POST",
      body: path === "reorder" ? { order: [comment.id] } : undefined,
    });
    assert.equal(res.status, 403, path);
  }
  const del = await api(bucket, `https://hub.example/api/comments/${comment.id}`, { method: "DELETE" });
  assert.equal(del.status, 403);
});

test("pin, unpin and reorder are admin-only; delete is admin or author", async () => {
  const bucket = memoryBucket();
  const created = await create(bucket);
  const { comment } = await created.json();

  const personPin = await api(bucket, `https://hub.example/api/comments/${comment.id}/pin`, {
    method: "POST",
    extraHeaders: { origin: "https://hub.example" },
  });
  assert.equal(personPin.status, 403);

  const adminPin = await api(bucket, `https://hub.example/api/comments/${comment.id}/pin`, {
    method: "POST",
    email: admin,
    extraHeaders: { origin: "https://hub.example" },
  });
  assert.equal(adminPin.status, 200);
  assert.equal((await adminPin.json()).comment.pinned, true);

  const pins = await api(bucket, "https://hub.example/api/comments/pins?scope=home&target_id=home");
  assert.equal((await pins.json()).pins.length, 1);

  const otherDelete = await api(bucket, `https://hub.example/api/comments/${comment.id}`, {
    method: "DELETE",
    email: other,
    extraHeaders: { origin: "https://hub.example" },
  });
  assert.equal(otherDelete.status, 403);

  const authorDelete = await api(bucket, `https://hub.example/api/comments/${comment.id}`, {
    method: "DELETE",
    extraHeaders: { origin: "https://hub.example" },
  });
  assert.equal(authorDelete.status, 200);
  const gone = await authorDelete.json();
  assert.ok(gone.comment.deleted_at);
  assert.equal(gone.comment.body, "");
});

test("an admin can delete someone else's comment", async () => {
  const bucket = memoryBucket();
  const created = await create(bucket);
  const { comment } = await created.json();
  const res = await api(bucket, `https://hub.example/api/comments/${comment.id}`, {
    method: "DELETE",
    email: admin,
    extraHeaders: { origin: "https://hub.example" },
  });
  assert.equal(res.status, 200);
});

test("author-only edit; replies cannot nest", async () => {
  const bucket = memoryBucket();
  const created = await create(bucket, { body: "original" });
  const { comment } = await created.json();

  const sneak = await api(bucket, `https://hub.example/api/comments/${comment.id}`, {
    method: "PATCH",
    email: other,
    extraHeaders: { origin: "https://hub.example" },
    body: { body: "hijack" },
  });
  assert.equal(sneak.status, 403);

  const edited = await api(bucket, `https://hub.example/api/comments/${comment.id}`, {
    method: "PATCH",
    extraHeaders: { origin: "https://hub.example" },
    body: { body: "edited" },
  });
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).comment.body, "edited");

  const reply = await create(bucket, { parent_id: comment.id, body: "a reply" });
  assert.equal(reply.status, 201);
  const nested = await create(bucket, { parent_id: (await reply.json()).comment.id, body: "too deep" });
  assert.equal(nested.status, 400);
  assert.match((await nested.json()).error, /one level deep only/);
});

test("per-scope pin order is returned by the pins route", async () => {
  const bucket = memoryBucket();
  const a = await create(bucket, { body: "one" });
  const b = await create(bucket, { body: "two" });
  const first = (await a.json()).comment;
  const second = (await b.json()).comment;
  await api(bucket, `https://hub.example/api/comments/${first.id}/pin`, {
    method: "POST",
    email: admin,
    extraHeaders: { origin: "https://hub.example" },
  });
  await api(bucket, `https://hub.example/api/comments/${second.id}/pin`, {
    method: "POST",
    email: admin,
    extraHeaders: { origin: "https://hub.example" },
  });
  const reordered = await api(bucket, `https://hub.example/api/comments/${first.id}/reorder`, {
    method: "POST",
    email: admin,
    extraHeaders: { origin: "https://hub.example" },
    body: { order: [second.id, first.id] },
  });
  assert.equal(reordered.status, 200);
  const pins = await (await api(bucket, "https://hub.example/api/comments/pins?scope=home&target_id=home")).json();
  assert.deepEqual(pins.pins.map((item) => item.id), [second.id, first.id]);
  assert.deepEqual(pins.pins.map((item) => item.pin_order), [0, 1]);
});

test("a cross-site Origin cannot write comments", async () => {
  const bucket = memoryBucket();
  const res = await create(bucket, {}, { extraHeaders: { origin: "https://evil.example" } });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /cross-site write refused/);
});

test("the generic file API refuses the comments/ prefix", async () => {
  const bucket = memoryBucket();
  const upload = await api(bucket, "https://hub.example/api/files?key=comments/home/home.json", {
    method: "POST",
    extraHeaders: { "content-type": "application/json" },
    body: { nope: true },
  });
  assert.equal(upload.status, 403);
  assert.match((await upload.json()).error, /reserved/);

  const listed = await api(bucket, "https://hub.example/api/files?prefix=comments/");
  assert.equal(listed.status, 403);
});
