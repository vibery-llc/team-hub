import assert from "node:assert/strict";
import test from "node:test";

import { onRequest, wantsEventStream } from "./[[route]].js";

const get = (accept) => new Request("https://hub.example/mcp", { method: "GET", headers: accept ? { accept } : {} });

test("a client asking to open the event stream gets 405, so it does not reconnect in a loop", async () => {
  const res = await onRequest({ request: get("text/event-stream"), env: {} });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
});

test("only a GET for text/event-stream is treated as a stream request", () => {
  assert.equal(wantsEventStream(get("text/event-stream")), true);
  assert.equal(wantsEventStream(get("application/json, text/event-stream")), true);
  assert.equal(wantsEventStream(get("text/html,application/xhtml+xml")), false);
  assert.equal(wantsEventStream(get()), false);
  assert.equal(wantsEventStream(new Request("https://hub.example/mcp", { method: "POST", headers: { accept: "application/json, text/event-stream" } })), false);
});
