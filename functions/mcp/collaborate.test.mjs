import assert from "node:assert/strict";
import test from "node:test";

import { onRequest } from "./[[route]].js";
import { memoryBucket } from "../_shared/memory-bucket.js";

const headers = (extra = {}) => ({
  "content-type": "application/json",
  "Cf-Access-Authenticated-User-Email": "dev@example.com",
  ...extra,
});

function rpc(method, params) {
  return { jsonrpc: "2.0", id: 1, method, params };
}

function ctx(body, { extraHeaders, bucket } = {}) {
  return {
    request: new Request("https://hub.example/mcp", {
      method: "POST",
      headers: headers(extraHeaders),
      body: JSON.stringify(body),
    }),
    env: { HUB_FILES: bucket || memoryBucket() },
  };
}

async function call(name, args, opts) {
  const res = await onRequest(ctx(rpc("tools/call", { name, arguments: args }), opts));
  assert.equal(res.status, 200);
  return res.json();
}

test("tools/list includes the feedback and notes tools", async () => {
  const res = await onRequest(ctx(rpc("tools/list")));
  const names = (await res.json()).result.tools.map((t) => t.name);
  for (const name of [
    "list_feedback", "get_feedback", "create_feedback", "comment_on_feedback",
    "claim_feedback", "list_notes", "propose_note", "list_note_proposals",
  ]) {
    assert.ok(names.includes(name), `missing ${name}`);
  }
  assert.ok(!names.includes("approve_note"));
  assert.ok(!names.includes("pin_note"));
});

test("an agent can create, comment, claim feedback and propose a note", async () => {
  const bucket = memoryBucket();
  const created = await call("create_feedback", {
    page: "index", title: "Empty queue reads as broken", body: "Name the shortfall.",
  }, { bucket });
  const item = JSON.parse(created.result.content[0].text).item;
  assert.equal(item.status, "open");

  const commented = await call("comment_on_feedback", { id: item.id, body: "Also on Files." }, { bucket });
  assert.equal(JSON.parse(commented.result.content[0].text).item.comments.length, 1);

  const claimed = await call("claim_feedback", { id: item.id }, { bucket });
  assert.equal(JSON.parse(claimed.result.content[0].text).item.claimedBy, "dev@example.com");

  const proposed = await call("propose_note", { page: "index", body: "Friday build is the one." }, { bucket });
  const proposal = JSON.parse(proposed.result.content[0].text).proposal;
  assert.equal(proposal.status, "pending");

  const listed = await call("list_note_proposals", { page: "index" }, { bucket });
  assert.equal(JSON.parse(listed.result.content[0].text).count, 1);
});

test("a cross-site Origin cannot call a write tool, but can still list", async () => {
  const bucket = memoryBucket();
  const refused = await call("propose_note", { page: "index", body: "nope" }, {
    bucket,
    extraHeaders: { origin: "https://evil.example" },
  });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /cross-site write refused/);

  const listed = await call("list_notes", {}, {
    bucket,
    extraHeaders: { origin: "https://evil.example" },
  });
  assert.ok(!listed.result.isError);
});
