/**
 * Team hub file API — Cloudflare Pages Function over an R2 bucket.
 *
 * Pages caps a static asset at 25 MiB and a request body at ~100 MB, so builds
 * and meeting video cannot live in the deploy or ride a single POST. Everything
 * large goes to R2: small files in one shot, big ones via R2 multipart upload
 * driven from the browser a chunk at a time.
 *
 * The whole site already sits behind Cloudflare Access, so these routes inherit
 * that gate. Access forwards the verified identity, which we record as the
 * uploader — never trust a client-supplied name for it.
 *
 * Binding: HUB_FILES -> R2 bucket (see README, "File sharing & builds").
 *
 *   GET    /api/whoami
 *   GET    /api/files?prefix=share/
 *   POST   /api/files?key=share/x.zip        single-shot upload
 *   DELETE /api/files?key=share/x.zip
 *   GET    /api/dl?key=share/x.zip[&inline=1]
 *   POST   /api/mpu/create?key=builds/x.zip  -> { uploadId }
 *   PUT    /api/mpu/part?key&uploadId&part   -> { partNumber, etag }
 *   POST   /api/mpu/complete?key&uploadId    body: { parts: [...] }
 *   DELETE /api/mpu/abort?key&uploadId
 *
 *   POST   /api/event                        record one usage event (fire-and-forget)
 *   GET    /api/stats                        aggregate usage counts, last 30 days
 */

/** Top-level prefixes the API will touch. Anything else is rejected. */
const AREAS = ["share", "builds", "meetings", "clips"];

/** Single-shot uploads stay well under the Pages request-body ceiling. */
const SINGLE_SHOT_MAX = 90 * 1024 * 1024;

/**
 * Usage events: whether the hub is actually opened and used, not what was
 * done in it. A small allowlist on purpose — this is a usage counter, not a
 * place to accumulate free-form telemetry.
 */
export const EVENT_TYPES = new Set(["page_view", "agent_launch"]);

/** How many days of usage events the stats route rolls up. */
export const STATS_WINDOW_DAYS = 30;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });

const bad = (msg, status = 400) => json({ error: msg }, status);

/**
 * Keys are attacker-controlled. Allow only a known area plus safe path
 * segments — no traversal, no absolute paths, no empty or dot-only segments.
 */
function cleanKey(raw) {
  if (!raw) return null;
  const key = String(raw).replace(/^\/+/, "");
  if (key.length === 0 || key.length > 512) return null;
  if (key.includes("..") || key.includes("\\") || key.includes("//")) return null;
  const parts = key.split("/");
  if (parts.length < 2) return null;
  if (!AREAS.includes(parts[0])) return null;
  for (const p of parts.slice(1)) {
    if (!p || p === "." || p === "..") return null;
    if (!/^[\w. ()+@-]+$/.test(p)) return null;
  }
  return key;
}

/**
 * Per-platform pointer rewritten on every publish. Zip names are unique
 * (semver + date + branch) and 409-protected; this one file is allowed to
 * move so "download latest" can stay a stable key.
 */
export function isMutableBuildManifest(key) {
  const parts = String(key || "").split("/");
  return parts.length === 3 && parts[0] === "builds" && parts[2] === "latest.json";
}

function cleanPrefix(raw) {
  if (!raw) return null;
  const p = String(raw).replace(/^\/+/, "");
  if (p.includes("..") || p.includes("\\")) return null;
  const area = p.split("/")[0];
  return AREAS.includes(area) ? p : null;
}

/** Cloudflare Access forwards the verified identity on every request. */
function identity(request) {
  const h = request.headers;
  return (
    h.get("Cf-Access-Authenticated-User-Email") ||
    h.get("cf-access-authenticated-user-email") ||
    "unknown"
  );
}

/** Single-line, length-capped text. Never throws — a malformed field is
 * truncated/blanked rather than failing the whole fire-and-forget request. */
export function cleanText(raw, max) {
  return String(raw ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

/**
 * Builds the record stored for one usage event. `getIdentity` is only ever
 * called when the caller explicitly asked to attribute — see hub.config.js
 * `usageStats.attribution` — and even then the identity value comes from
 * that callback (the Access-verified header), never from `body`. A tenant
 * with attribution off never has this callback invoked, so no identity is
 * read, let alone stored.
 */
export function buildUsageEvent(body, getIdentity, now = new Date()) {
  const type = cleanText(body?.type, 32);
  if (!EVENT_TYPES.has(type)) {
    throw new Error(`type must be one of: ${[...EVENT_TYPES].join(", ")}`);
  }
  const event = {
    type,
    label: cleanText(body?.label, 80),
    source: cleanText(body?.source, 120),
    timestamp: now.toISOString(),
  };
  if (body?.attribute === true) event.email = getIdentity();
  return event;
}

/** Rolls a list of stored event records up into the shape the dashboard's
 * Usage panel renders. Pure and R2-agnostic so it is unit-testable without a
 * bucket — the stats route just supplies the customMetadata it listed. */
export function summarizeEvents(records, windowDays) {
  const byType = {};
  const byPerson = {};
  let totalEvents = 0;
  let attributed = false;

  for (const event of records) {
    totalEvents++;
    const type = event?.type || "unknown";
    byType[type] = (byType[type] || 0) + 1;
    if (event?.email) {
      attributed = true;
      byPerson[event.email] = (byPerson[event.email] || 0) + 1;
    }
  }

  return {
    windowDays,
    totalEvents,
    byType,
    // Reported from what was actually written, not from config — so this can
    // never drift from what the hub is really recording.
    attributed,
    byPerson: attributed
      ? Object.entries(byPerson)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([email, count]) => ({ email, count }))
      : [],
  };
}

function describe(obj) {
  const key = obj.key;
  const name = key.slice(key.lastIndexOf("/") + 1);
  return {
    key,
    name,
    area: key.split("/")[0],
    folder: key.slice(0, key.lastIndexOf("/")),
    size: obj.size,
    uploaded: obj.uploaded instanceof Date ? obj.uploaded.toISOString() : obj.uploaded,
    contentType: obj.httpMetadata?.contentType || "application/octet-stream",
    uploader: obj.customMetadata?.uploader || "",
    note: obj.customMetadata?.note || "",
    etag: obj.httpEtag,
  };
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const bucket = env.HUB_FILES;
  const url = new URL(request.url);
  const route = Array.isArray(params.route) ? params.route.join("/") : params.route || "";
  const method = request.method.toUpperCase();

  if (!bucket) {
    return json(
      { error: "R2 bucket not bound. Add the HUB_FILES binding — see README." },
      503
    );
  }

  try {
    if (route === "whoami") return json({ email: identity(request) });

    // ---- usage events --------------------------------------------------------
    if (route === "event" && method === "POST") {
      let body;
      try { body = await request.json(); } catch { return bad("bad json"); }

      let event;
      try { event = buildUsageEvent(body, () => identity(request)); }
      catch (err) { return bad(err.message); }

      const day = event.timestamp.slice(0, 10);
      const key = `usage/${day}/${event.timestamp.replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}.json`;
      await bucket.put(key, JSON.stringify(event), {
        httpMetadata: { contentType: "application/json" },
        // Mirrored into customMetadata so /api/stats can aggregate from
        // bucket.list() alone — no need to GET every event body back.
        customMetadata: event,
      });
      return json({ ok: true }, 201);
    }

    if (route === "stats" && method === "GET") {
      const records = [];
      const today = new Date();
      // Dated prefixes on the way in are what make this bounded: rather than
      // scanning the whole usage/ history, list only the last N day-prefixes.
      for (let i = 0; i < STATS_WINDOW_DAYS; i++) {
        const day = new Date(today);
        day.setUTCDate(day.getUTCDate() - i);
        const prefix = `usage/${day.toISOString().slice(0, 10)}/`;
        let cursor;
        do {
          const page = await bucket.list({ prefix, cursor, limit: 1000, include: ["customMetadata"] });
          for (const o of page.objects) records.push(o.customMetadata || {});
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
      }
      // Rough aggregate counts, not a live dial — cache briefly so a busy
      // dashboard doesn't re-list 30 days of prefixes on every page load.
      return json(summarizeEvents(records, STATS_WINDOW_DAYS), 200, {
        "cache-control": "private, max-age=300",
      });
    }

    // ---- listing -----------------------------------------------------------
    if (route === "files" && method === "GET") {
      const prefix = cleanPrefix(url.searchParams.get("prefix") || "share/");
      if (!prefix) return bad("bad prefix");

      const files = [];
      let cursor;
      do {
        // R2 omits httpMetadata and customMetadata from list results unless
        // asked. Without this every row renders as application/octet-stream
        // with a blank uploader, even though the stored object is correct.
        const page = await bucket.list({
          prefix, cursor, limit: 1000,
          include: ["httpMetadata", "customMetadata"],
        });
        for (const o of page.objects) files.push(describe(o));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor && files.length < 5000);

      files.sort((a, b) => String(b.uploaded).localeCompare(String(a.uploaded)));
      return json({ prefix, count: files.length, files });
    }

    // ---- single-shot upload -------------------------------------------------
    if (route === "files" && method === "POST") {
      const key = cleanKey(url.searchParams.get("key"));
      if (!key) return bad("bad key");

      const declared = Number(request.headers.get("content-length") || 0);
      if (declared > SINGLE_SHOT_MAX) {
        return bad("file too large for a single request — use the multipart routes", 413);
      }
      if ((await bucket.head(key)) && !isMutableBuildManifest(key)) {
        return bad("a file with that name already exists", 409);
      }

      await bucket.put(key, request.body, {
        httpMetadata: {
          contentType:
            request.headers.get("x-file-type") ||
            request.headers.get("content-type") ||
            "application/octet-stream",
        },
        customMetadata: {
          uploader: identity(request),
          note: (url.searchParams.get("note") || "").slice(0, 200),
        },
      });
      const head = await bucket.head(key);
      return json({ ok: true, file: head ? describe(head) : { key } }, 201);
    }

    if (route === "files" && method === "DELETE") {
      const key = cleanKey(url.searchParams.get("key"));
      if (!key) return bad("bad key");
      await bucket.delete(key);
      return json({ ok: true, deleted: key });
    }

    // ---- download -----------------------------------------------------------
    if (route === "dl" && method === "GET") {
      const key = cleanKey(url.searchParams.get("key"));
      if (!key) return bad("bad key");

      const obj = await bucket.get(key, { range: request.headers });
      if (!obj) return bad("not found", 404);

      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("etag", obj.httpEtag);
      // The mutable manifest is advertised as a stable "poll me" URL, so it
      // must revalidate on every hit; everything else is immutable-by-409.
      headers.set("cache-control", isMutableBuildManifest(key) ? "private, no-cache" : "private, max-age=3600");
      headers.set("accept-ranges", "bytes");

      const name = key.slice(key.lastIndexOf("/") + 1);
      const inline = url.searchParams.get("inline") === "1";
      headers.set(
        "content-disposition",
        `${inline ? "inline" : "attachment"}; filename="${name.replace(/"/g, "")}"`
      );

      // A ranged hit carries .range; reply 206 so media seeking works.
      const status = obj.range && obj.size !== obj.range.length ? 206 : 200;
      if (status === 206) {
        const { offset = 0, length = obj.size } = obj.range;
        headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
      }
      return new Response(obj.body, { status, headers });
    }

    // ---- multipart upload ---------------------------------------------------
    if (route === "mpu/create" && method === "POST") {
      const key = cleanKey(url.searchParams.get("key"));
      if (!key) return bad("bad key");
      if ((await bucket.head(key)) && !isMutableBuildManifest(key)) {
        return bad("a file with that name already exists", 409);
      }

      const mpu = await bucket.createMultipartUpload(key, {
        httpMetadata: {
          contentType: url.searchParams.get("type") || "application/octet-stream",
        },
        customMetadata: {
          uploader: identity(request),
          note: (url.searchParams.get("note") || "").slice(0, 200),
        },
      });
      return json({ key, uploadId: mpu.uploadId });
    }

    if (route === "mpu/part" && method === "PUT") {
      const key = cleanKey(url.searchParams.get("key"));
      const uploadId = url.searchParams.get("uploadId");
      const partNumber = Number(url.searchParams.get("part"));
      if (!key || !uploadId) return bad("bad key or uploadId");
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
        return bad("bad part number");
      }
      const mpu = bucket.resumeMultipartUpload(key, uploadId);
      const part = await mpu.uploadPart(partNumber, request.body);
      return json({ partNumber: part.partNumber, etag: part.etag });
    }

    if (route === "mpu/complete" && method === "POST") {
      const key = cleanKey(url.searchParams.get("key"));
      const uploadId = url.searchParams.get("uploadId");
      if (!key || !uploadId) return bad("bad key or uploadId");

      const body = await request.json();
      const parts = Array.isArray(body?.parts) ? body.parts : null;
      if (!parts || parts.length === 0) return bad("no parts");

      const mpu = bucket.resumeMultipartUpload(key, uploadId);
      await mpu.complete(
        parts.map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) }))
      );
      const head = await bucket.head(key);
      return json({ ok: true, file: head ? describe(head) : { key } }, 201);
    }

    if (route === "mpu/abort" && method === "DELETE") {
      const key = cleanKey(url.searchParams.get("key"));
      const uploadId = url.searchParams.get("uploadId");
      if (!key || !uploadId) return bad("bad key or uploadId");
      await bucket.resumeMultipartUpload(key, uploadId).abort();
      return json({ ok: true });
    }

    return bad("no such route", 404);
  } catch (err) {
    return json({ error: String(err?.message || err) }, 500);
  }
}
