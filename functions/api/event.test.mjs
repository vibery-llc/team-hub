import assert from "node:assert/strict";
import test from "node:test";

import { EVENT_TYPES, buildUsageEvent, cleanText, summarizeEvents } from "./[[route]].js";

test("cleanText trims, single-lines and caps", () => {
  assert.equal(cleanText("  hi  ", 10), "hi");
  assert.equal(cleanText("a\nb\tc", 10), "a b c");
  assert.equal(cleanText("x".repeat(20), 5), "xxxxx");
  assert.equal(cleanText(undefined, 5), "");
});

test("rejects a type outside the allowlist", () => {
  assert.throws(() => buildUsageEvent({ type: "delete_everything" }, () => "a@b.com"), /type must be one of/);
  for (const type of EVENT_TYPES) {
    assert.doesNotThrow(() => buildUsageEvent({ type }, () => "a@b.com"));
  }
});

test("attribution off never calls getIdentity and records no identity", () => {
  let calls = 0;
  const getIdentity = () => { calls++; return "someone@example.com"; };

  const withoutFlag = buildUsageEvent(
    { type: "agent_launch", label: "claude-terminal", source: "ATL-42" },
    getIdentity,
    new Date("2026-08-14T18:30:00.000Z"),
  );
  const withFalseFlag = buildUsageEvent(
    { type: "page_view", label: "index.html", attribute: false },
    getIdentity,
    new Date("2026-08-14T18:30:00.000Z"),
  );

  assert.equal(calls, 0, "getIdentity must never be invoked when attribution is not requested");
  assert.deepEqual(withoutFlag, {
    type: "agent_launch",
    label: "claude-terminal",
    source: "ATL-42",
    timestamp: "2026-08-14T18:30:00.000Z",
  });
  assert.ok(!("email" in withoutFlag));
  assert.ok(!("email" in withFalseFlag));
});

test("attribution on records only the server-derived identity, never a client-supplied one", () => {
  const event = buildUsageEvent(
    { type: "agent_launch", label: "codex", attribute: true, email: "attacker@evil.example" },
    () => "real-user@northwind-labs.dev",
    new Date("2026-08-14T18:30:00.000Z"),
  );
  assert.equal(event.email, "real-user@northwind-labs.dev");
});

test("field caps apply even when attribution is on", () => {
  const event = buildUsageEvent(
    { type: "page_view", label: "y".repeat(200), source: "z".repeat(200) },
    () => "a@b.com",
  );
  assert.equal(event.label.length, 80);
  assert.equal(event.source.length, 120);
});

test("summarizeEvents reports attributed:false and no byPerson when nothing carries an email", () => {
  const summary = summarizeEvents(
    [
      { type: "page_view" },
      { type: "page_view" },
      { type: "agent_launch" },
    ],
    30,
  );
  assert.deepEqual(summary, {
    windowDays: 30,
    totalEvents: 3,
    byType: { page_view: 2, agent_launch: 1 },
    attributed: false,
    byPerson: [],
  });
});

test("summarizeEvents surfaces attribution only from what was actually recorded", () => {
  const summary = summarizeEvents(
    [
      { type: "agent_launch", email: "a@b.com" },
      { type: "agent_launch", email: "a@b.com" },
      { type: "agent_launch", email: "c@d.com" },
      { type: "page_view" },
    ],
    30,
  );
  assert.equal(summary.attributed, true);
  assert.deepEqual(summary.byPerson, [
    { email: "a@b.com", count: 2 },
    { email: "c@d.com", count: 1 },
  ]);
});
