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
  const h = { "content-type": "application/json", ...extra };
  if (email) h["Cf-Access-Authenticated-User-Email"] = email;
  return h;
}

function ctx(url, { method = "GET", body, email = person, extraHeaders, bucket, config = ENABLED, admins } = {}) {
  return {
    request: new Request(url, {
      method,
      headers: headers(email, extraHeaders),
      body: body == null ? undefined : JSON.stringify(body),
    }),
    env: { HUB_FILES: bucket, HUB_CONFIG: config, HUB_ADMINS: admins },
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
  assert.equal(comment.author_label, "");
  assert.equal(comment.via, "browser");
  assert.equal(comment.rev, "1");
  assert.equal(comment.edited_by, null);
  assert.equal(comment.proposal_id, null);
  assert.equal(comment.body, "Welcome home");
  assert.equal(comment.scope, "home");
  assert.equal(comment.target_id, "home");

  const listed = await api(bucket, "https://hub.example/api/comments?scope=home&target_id=index", {
    extraHeaders: { origin: "https://hub.example" },
  });
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.equal(body.comments.length, 1);
  assert.equal(body.comments[0].author, person);
  assert.equal(body.comments[0].author_kind, "person");
  assert.equal(body.comments[0].author_label, "");
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
  assert.equal(comment.via, "mcp");
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
  const afterEdit = await edited.json();
  assert.equal(afterEdit.comment.body, "edited");
  assert.equal(afterEdit.comment.rev, "2");
  assert.equal(afterEdit.comment.edited_by, person);

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

test("GET comments and pins return per-viewer capabilities and viewer flags", async () => {
  const bucket = memoryBucket();
  const created = await create(bucket, { body: "Welcome home" });
  const { comment } = await created.json();
  await api(bucket, `https://hub.example/api/comments/${comment.id}/pin`, {
    method: "POST",
    email: admin,
    extraHeaders: { origin: "https://hub.example" },
  });

  const asAuthor = await (await api(bucket, "https://hub.example/api/comments?scope=home&target_id=home", {
    extraHeaders: { origin: "https://hub.example" },
  })).json();
  assert.deepEqual(asAuthor.viewer, { can_pin: false, is_admin: false });
  assert.equal(asAuthor.comments[0].author_kind, "person");
  assert.equal(asAuthor.comments[0].can_edit, true);
  assert.equal(asAuthor.comments[0].can_delete, true);
  assert.equal(asAuthor.comments[0].can_pin, false);

  const asAdmin = await (await api(bucket, "https://hub.example/api/comments?scope=home&target_id=home", {
    email: admin,
    extraHeaders: { origin: "https://hub.example" },
  })).json();
  assert.deepEqual(asAdmin.viewer, { can_pin: true, is_admin: true });
  assert.equal(asAdmin.comments[0].can_edit, true);
  assert.equal(asAdmin.comments[0].can_delete, true);
  assert.equal(asAdmin.comments[0].can_pin, true);

  const asOther = await (await api(bucket, "https://hub.example/api/comments/pins?scope=home&target_id=home", {
    email: other,
    extraHeaders: { origin: "https://hub.example" },
  })).json();
  assert.deepEqual(asOther.viewer, { can_pin: false, is_admin: false });
  assert.equal(asOther.pins[0].can_edit, false);
  assert.equal(asOther.pins[0].can_delete, false);
  assert.equal(asOther.pins[0].can_pin, false);

  const asAgent = await (await api(bucket, "https://hub.example/api/comments?scope=home&target_id=home")).json();
  assert.deepEqual(asAgent.viewer, { can_pin: false, is_admin: false });
  assert.equal(asAgent.comments[0].can_edit, true);
  assert.equal(asAgent.comments[0].can_delete, false);
  assert.equal(asAgent.comments[0].can_pin, false);
});

test("optional quote is stored as plain text and returned, never as HTML", async () => {
  const bucket = memoryBucket();
  const created = await create(bucket, {
    body: "This line is wrong",
    quote: "<script>alert(1)</script>Keep clips only.",
  });
  assert.equal(created.status, 201);
  const { comment } = await created.json();
  assert.equal(comment.quote, "alert(1)Keep clips only.");
  assert.equal(comment.author_kind, "person");

  const listed = await (await api(bucket, "https://hub.example/api/comments?scope=home&target_id=home", {
    extraHeaders: { origin: "https://hub.example" },
  })).json();
  assert.equal(listed.comments[0].quote, "alert(1)Keep clips only.");
  assert.doesNotMatch(listed.comments[0].quote, /</);

  const long = await create(bucket, { body: "long quote", quote: `<em>${"q".repeat(600)}</em>` });
  assert.equal((await long.json()).comment.quote.length, 500);
});

test("an unpinned body over 8000 chars is 413; a pinned top-level long body is accepted", async () => {
  const bucket = memoryBucket();
  const tooLong = await create(bucket, { body: "y".repeat(8001) });
  assert.equal(tooLong.status, 413);

  const replyOver = await create(bucket, { body: "ok" });
  const parent = (await replyOver.json()).comment;
  const nested = await create(bucket, { parent_id: parent.id, body: "z".repeat(8001) });
  assert.equal(nested.status, 413);

  const personPin = await create(bucket, { body: "y".repeat(8001), pinned: true });
  assert.equal(personPin.status, 403);

  const pinned = await create(bucket, { body: "y".repeat(8001), pinned: true }, { email: admin });
  assert.equal(pinned.status, 201);
  const stored = await pinned.json();
  assert.equal(stored.comment.body.length, 8001);
  assert.equal(stored.comment.pinned, true);
});

test("HUB_ADMINS is merged into comments.admins so an env admin can pin", async () => {
  const bucket = memoryBucket();
  const created = await create(bucket, {}, { config: { comments: { enabled: true, admins: [] } } });
  const { comment } = await created.json();
  const refused = await api(bucket, `https://hub.example/api/comments/${comment.id}/pin`, {
    method: "POST",
    email: "ops@example.com",
    extraHeaders: { origin: "https://hub.example" },
    config: { comments: { enabled: true, admins: [] } },
  });
  assert.equal(refused.status, 403);

  const allowed = await api(bucket, `https://hub.example/api/comments/${comment.id}/pin`, {
    method: "POST",
    email: "ops@example.com",
    extraHeaders: { origin: "https://hub.example" },
    config: { comments: { enabled: true, admins: [] } },
    admins: "ops@example.com",
  });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).comment.pinned, true);
});

function unsignedJwt(payload) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(payload)}.`;
}

test("a caller with no email cannot edit or delete, even with a forged Origin", async () => {
  const bucket = memoryBucket();
  await bucket.put("comments/home/home.json", JSON.stringify({
    comments: [{
      id: "legacy-home",
      scope: "home",
      target_id: "home",
      parent_id: null,
      author: "legacy",
      author_kind: "system",
      body: "Welcome home",
      quote: "keep me",
      created_at: "2026-10-01T00:00:00.000Z",
      pinned: true,
      pin_order: 0,
      rev: "1",
      edited_by: null,
      proposal_id: null,
    }],
  }));

  const forged = {
    origin: "https://hub.example",
    "sec-fetch-site": "same-origin",
  };
  const edited = await api(bucket, "https://hub.example/api/comments/legacy-home", {
    method: "PATCH",
    email: "",
    extraHeaders: forged,
    body: { body: "hijack" },
  });
  assert.equal(edited.status, 403);

  const deleted = await api(bucket, "https://hub.example/api/comments/legacy-home", {
    method: "DELETE",
    email: "",
    extraHeaders: forged,
  });
  assert.equal(deleted.status, 403);

  const created = await create(bucket, {}, { email: "" });
  assert.equal(created.status, 403);

  const listed = await (await api(bucket, "https://hub.example/api/comments?scope=home&target_id=home", {
    extraHeaders: { origin: "https://hub.example" },
  })).json();
  assert.equal(listed.comments[0].author, "legacy");
  assert.equal(listed.comments[0].author_kind, "system");
  assert.equal(listed.comments[0].body, "Welcome home");
});

test("a service-token common_name is ignored when Access is not configured", async () => {
  const bucket = memoryBucket();
  const created = await api(bucket, "https://hub.example/api/comments", {
    method: "POST",
    email: "",
    extraHeaders: { "Cf-Access-Jwt-Assertion": unsignedJwt({ common_name: "client-id.access" }) },
    body: { scope: "home", target_id: "home", body: "from a token" },
  });
  assert.equal(created.status, 403);
});

test("unpin of a pinned body over 8000 is 409 and asks to trim first", async () => {
  const bucket = memoryBucket();
  const created = await create(bucket, { body: "y".repeat(8001), pinned: true }, { email: admin });
  assert.equal(created.status, 201);
  const { comment } = await created.json();
  const unpin = await api(bucket, `https://hub.example/api/comments/${comment.id}/unpin`, {
    method: "POST",
    email: admin,
    extraHeaders: { origin: "https://hub.example" },
  });
  assert.equal(unpin.status, 409);
  assert.match((await unpin.json()).error, /trim the body below 8000/);
});

test("an agent can edit their pinned comment only within 8000; an admin may use 256 KiB", async () => {
  const bucket = memoryBucket();
  const created = await api(bucket, "https://hub.example/api/comments", {
    method: "POST",
    body: { scope: "home", target_id: "home", body: "bot note", agent_name: "Codex" },
  });
  const { comment } = await created.json();
  await api(bucket, `https://hub.example/api/comments/${comment.id}/pin`, {
    method: "POST",
    email: admin,
    extraHeaders: { origin: "https://hub.example" },
  });
  const tooBig = await api(bucket, `https://hub.example/api/comments/${comment.id}`, {
    method: "PATCH",
    body: { body: "z".repeat(8001) },
  });
  assert.equal(tooBig.status, 413);
  const adminEdit = await api(bucket, `https://hub.example/api/comments/${comment.id}`, {
    method: "PATCH",
    email: admin,
    extraHeaders: { origin: "https://hub.example" },
    body: { body: "z".repeat(8001) },
  });
  assert.equal(adminEdit.status, 200);
  assert.equal((await adminEdit.json()).comment.body.length, 8001);
});

test("a non-admin, non-author cannot directly edit a pinned comment", async () => {
  const bucket = memoryBucket();
  const created = await create(bucket, { body: "Welcome home" });
  const { comment } = await created.json();
  await api(bucket, `https://hub.example/api/comments/${comment.id}/pin`, {
    method: "POST",
    email: admin,
    extraHeaders: { origin: "https://hub.example" },
  });
  const sneak = await api(bucket, `https://hub.example/api/comments/${comment.id}`, {
    method: "PATCH",
    email: other,
    extraHeaders: { origin: "https://hub.example" },
    body: { body: "propose this instead" },
  });
  assert.equal(sneak.status, 403);
  const asOther = await (await api(bucket, "https://hub.example/api/comments?scope=home&target_id=home", {
    email: other,
    extraHeaders: { origin: "https://hub.example" },
  })).json();
  assert.equal(asOther.comments[0].can_edit, false);
  const asAdmin = await (await api(bucket, "https://hub.example/api/comments?scope=home&target_id=home", {
    email: admin,
    extraHeaders: { origin: "https://hub.example" },
  })).json();
  assert.equal(asAdmin.comments[0].can_edit, true);
});

test("the file API refuses the comments/ prefix", async () => {
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
