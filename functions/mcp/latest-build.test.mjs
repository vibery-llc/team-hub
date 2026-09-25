import assert from "node:assert/strict";
import test from "node:test";

import { latestBuilds } from "./[[route]].js";

// R2's list() returns `uploaded` as a Date. These are the real keys that exposed the bug:
// sorting String(Date) put Thursday's build ahead of Friday's ("Thu" > "Fri").
const obj = (key, iso, size = 1) => ({ key, size, uploaded: new Date(iso) });
const objects = [
  obj("builds/macos/BeforeTheFlood-v0.1.0-2026-09-23-pr-117-playtest-macos.zip", "2026-09-24T06:41:01Z"),
  obj("builds/macos/BeforeTheFlood-v0.1.0-2026-09-25-ui-steam-parity-macos.zip", "2026-09-25T18:40:00Z"),
  obj("builds/macos/latest.json", "2026-09-25T18:40:01Z"),
  obj("builds/windows/BeforeTheFlood-v0.1.0-2026-09-16-main-windows.zip", "2026-09-16T08:50:11Z"),
  obj("builds/windows/BeforeTheFlood-v0.1.0-2026-09-25-playtest-poi-rebuild-windows.zip", "2026-09-25T14:51:06Z"),
  obj("builds/windows/latest.json", "2026-09-25T14:51:07Z"),
];

test("the newest upload wins by time, not by the weekday name in its date string", () => {
  const byPlatform = Object.fromEntries(latestBuilds(objects).map((b) => [b.platform, b]));
  assert.equal(byPlatform.macos.key, "builds/macos/BeforeTheFlood-v0.1.0-2026-09-25-ui-steam-parity-macos.zip");
  assert.equal(byPlatform.windows.key, "builds/windows/BeforeTheFlood-v0.1.0-2026-09-25-playtest-poi-rebuild-windows.zip");
});

test("the per-platform latest.json pointer is not counted as a build", () => {
  const byPlatform = Object.fromEntries(latestBuilds(objects).map((b) => [b.platform, b]));
  assert.equal(byPlatform.macos.olderCount, 1);
  assert.equal(byPlatform.windows.olderCount, 1);
});

test("a platform filter returns only that platform", () => {
  const only = latestBuilds(objects, "windows");
  assert.deepEqual(only.map((b) => b.platform), ["windows"]);
});
