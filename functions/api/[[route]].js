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
 *
 *   GET    /api/feedback                     claimable queue, newest open first
 *   POST   /api/feedback                     file an item { page, title, body }
 *   GET    /api/feedback/item?id=            one item and its comments
 *   POST   /api/feedback/claim?id=
 *   POST   /api/feedback/release?id=
 *   POST   /api/feedback/resolve?id=
 *   POST   /api/feedback/reopen?id=
 *   POST   /api/feedback/comment?id=         body: { body }
 *
 *   GET    /api/notes?page=                  pinned note for one hub page
 *   PUT    /api/notes?page=                  human pins or clears it (browser only)
 *   GET    /api/proposals?page=              agent proposals, pending first
 *   POST   /api/proposals                    agent proposes { page, body }
 *   POST   /api/proposals/approve?id=        human only — becomes the pinned note
 *   POST   /api/proposals/reject?id=         human only
 *
 *   GET    /api/comments?scope=&target_id=   thread for one target (404 if comments.enabled is off)
 *   GET    /api/comments/pins?scope=&target_id=
 *   POST   /api/comments                     { scope, target_id, body, parent_id? }
 *   PATCH  /api/comments/{id}                author-only edit
 *   DELETE /api/comments/{id}                soft delete
 *   POST   /api/comments/{id}/pin
 *   POST   /api/comments/{id}/unpin
 *   POST   /api/comments/{id}/reorder        body: { order: [id, ...] }
 */

import { accessIdentity } from "../_shared/access.js";
import { browserWrite, sameSiteWrite } from "../_shared/origin.js";
import {
  FEEDBACK_PREFIX,
  PROPOSALS_PREFIX,
  addComment,
  approveProposal,
  buildFeedback,
  buildNote,
  buildProposal,
  claimFeedback,
  cleanId,
  cleanPageKey,
  feedbackKey,
  noteKey,
  proposalKey,
  rejectProposal,
  releaseFeedback,
  reopenFeedback,
  resolveFeedback,
  sortFeedback,
} from "../_shared/collaborate.js";
import {
  addCommentToThread,
  buildComment,
  cleanScope,
  cleanTargetId,
  commentPolicy,
  commentsConfig,
  describeActor,
  editCommentInThread,
  findCommentLocation,
  isCommentsStoreKey,
  parseHubConfigSource,
  pinCommentInThread,
  pinnedComments,
  presentComment,
  readThread,
  viewerFor,
  reorderPinsInThread,
  softDeleteCommentInThread,
  sortThreadComments,
  unpinCommentInThread,
  updateThread,
} from "../_shared/comments.js";

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
 * The type to show a stored file inline as, or null to make it download. The
 * stored type is whatever the uploader claimed, so this is an allowlist of
 * types that can't run script: a text/html or image/svg+xml file shown inline
 * would run its script on the hub's own origin. Raster images, video and
 * audio are all the Files page and the meeting player show inline.
 *
 * The caller must send the returned type, not the stored header: browsers
 * read Content-Type as a comma-separated list and use the last entry, so a
 * stored "video/mp4;x=,text/html" passes a check on its first part and still
 * renders as HTML.
 */
const INLINE_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
  "video/mp4", "video/webm", "video/quicktime", "video/ogg", "video/x-m4v",
  "audio/mpeg", "audio/mp4", "audio/aac", "audio/ogg", "audio/wav", "audio/webm", "audio/x-m4a", "audio/flac",
]);
export function inlineType(contentType) {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  return INLINE_TYPES.has(type) ? type : null;
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


/** Single-line, length-capped text. Never throws — a malformed field is
 * truncated/blanked rather than failing the whole fire-and-forget request. */
export function cleanText(raw, max) {
  return String(raw ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

/**
 * Builds the record stored for one usage event. `getIdentity` is only ever
 * called when the caller explicitly asked to attribute — see hub.config.js
 * `usageStats.attribution` — and even then the identity value comes from
 * that callback (the identity Access verified), never from `body`. A tenant
 * with attribution off never has this callback invoked, so no identity is
 * stored with an event. (Every request is still checked against Cloudflare
 * Access, which reads the identity to verify it; checking is not recording.)
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

async function readJson(bucket, key) {
  const obj = await bucket.get(key);
  if (!obj) return null;
  return obj.json();
}

async function writeJson(bucket, key, record) {
  await bucket.put(key, JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
  });
  return record;
}

async function listJson(bucket, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects) {
      const record = await readJson(bucket, o.key);
      if (record) out.push(record);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && out.length < 2000);
  return out;
}

function refuseWrite(check) {
  return json({ error: check.error }, 403);
}

function refuseCommentsStore(raw) {
  if (isCommentsStoreKey(raw)) return bad("comments/ is a reserved store", 403);
  return null;
}

async function loadCommentsSettings(env, request) {
  if (env.HUB_CONFIG && typeof env.HUB_CONFIG === "object") {
    return commentsConfig(env.HUB_CONFIG);
  }
  try {
    const url = new URL("/hub.config.js", request.url);
    const res = env.ASSETS ? await env.ASSETS.fetch(new Request(url)) : await fetch(url);
    if (!res.ok) return commentsConfig({});
    return commentsConfig(parseHubConfigSource(await res.text()));
  } catch {
    return commentsConfig({});
  }
}

function commentsActor(request, identity, body = {}) {
  return describeActor(
    browserWrite(request).ok,
    identity,
    body.agent_name || body.agent || request.headers.get("x-hub-agent") || "",
  );
}

function threadQuery(url, body = {}) {
  const scope = cleanScope(url.searchParams.get("scope") || body.scope);
  const targetId = cleanTargetId(scope, url.searchParams.get("target_id") || body.target_id);
  if (!scope || !targetId) return { error: "scope and target_id are required" };
  return { scope, targetId };
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

  /* Who Cloudflare Access verified this request as (see functions/_shared/access.js). A
     service token carries no email, hence the fallback. */
  const access = await accessIdentity(request, env);
  if (!access.ok) return json({ error: access.error }, access.status);
  const identity = () => access.email || "unknown";

  try {
    if (route === "whoami") return json({ email: identity() });

    // ---- usage events --------------------------------------------------------
    if (route === "event" && method === "POST") {
      let body;
      try { body = await request.json(); } catch { return bad("bad json"); }

      let event;
      try { event = buildUsageEvent(body, () => identity()); }
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

    // ---- feedback queue ----------------------------------------------------
    if (route === "feedback" && method === "GET") {
      const pageFilter = url.searchParams.get("page");
      const statusFilter = url.searchParams.get("status");
      let items = await listJson(bucket, FEEDBACK_PREFIX);
      if (pageFilter) {
        const pageKey = cleanPageKey(pageFilter);
        if (!pageKey) return bad("bad page");
        items = items.filter((i) => i.page === pageKey);
      }
      if (statusFilter) {
        items = items.filter((i) => i.status === statusFilter);
      }
      return json({ count: items.length, items: sortFeedback(items) });
    }

    if (route === "feedback" && method === "POST") {
      const gate = sameSiteWrite(request);
      if (!gate.ok) return refuseWrite(gate);
      let body;
      try { body = await request.json(); } catch { return bad("bad json"); }
      let item;
      try { item = buildFeedback(body, identity()); }
      catch (err) { return bad(err.message); }
      await writeJson(bucket, feedbackKey(item.id), item);
      return json({ ok: true, item }, 201);
    }

    if (route === "feedback/item" && method === "GET") {
      const id = cleanId(url.searchParams.get("id"));
      if (!id) return bad("bad id");
      const item = await readJson(bucket, feedbackKey(id));
      if (!item) return bad("not found", 404);
      return json({ item });
    }

    if (route.startsWith("feedback/") && method === "POST") {
      const gate = sameSiteWrite(request);
      if (!gate.ok) return refuseWrite(gate);
      const id = cleanId(url.searchParams.get("id"));
      if (!id) return bad("bad id");
      const current = await readJson(bucket, feedbackKey(id));
      if (!current) return bad("not found", 404);
      const action = route.slice("feedback/".length);
      let next;
      try {
        if (action === "claim") next = claimFeedback(current, identity());
        else if (action === "release") next = releaseFeedback(current, identity());
        else if (action === "resolve") next = resolveFeedback(current, identity());
        else if (action === "reopen") next = reopenFeedback(current);
        else if (action === "comment") {
          let body;
          try { body = await request.json(); } catch { return bad("bad json"); }
          next = addComment(current, body?.body, identity());
        } else {
          return bad("no such route", 404);
        }
      } catch (err) { return bad(err.message, err.message.startsWith("already claimed") ? 409 : 400); }
      await writeJson(bucket, feedbackKey(id), next);
      return json({ ok: true, item: next });
    }

    // ---- pinned notes + proposals ------------------------------------------
    if (route === "notes" && method === "GET") {
      const pageKey = cleanPageKey(url.searchParams.get("page") || "");
      if (!pageKey) return bad("bad page");
      const note = await readJson(bucket, noteKey(pageKey));
      return json({ page: pageKey, note: note || { page: pageKey, body: "", updatedBy: "", updatedAt: "" } });
    }

    if (route === "notes" && method === "PUT") {
      const gate = browserWrite(request);
      if (!gate.ok) return refuseWrite(gate);
      const pageKey = cleanPageKey(url.searchParams.get("page") || "");
      if (!pageKey) return bad("bad page");
      let body;
      try { body = await request.json(); } catch { return bad("bad json"); }
      let note;
      try { note = buildNote(pageKey, body?.body, identity()); }
      catch (err) { return bad(err.message); }
      await writeJson(bucket, noteKey(pageKey), note);
      return json({ ok: true, note });
    }

    if (route === "proposals" && method === "GET") {
      const pageFilter = url.searchParams.get("page");
      let items = await listJson(bucket, PROPOSALS_PREFIX);
      if (pageFilter) {
        const pageKey = cleanPageKey(pageFilter);
        if (!pageKey) return bad("bad page");
        items = items.filter((p) => p.page === pageKey);
      }
      items.sort((a, b) => {
        const ra = a.status === "pending" ? 0 : 1;
        const rb = b.status === "pending" ? 0 : 1;
        if (ra !== rb) return ra - rb;
        return String(b.proposedAt || "").localeCompare(String(a.proposedAt || ""));
      });
      return json({ count: items.length, proposals: items });
    }

    if (route === "proposals" && method === "POST") {
      const gate = sameSiteWrite(request);
      if (!gate.ok) return refuseWrite(gate);
      let body;
      try { body = await request.json(); } catch { return bad("bad json"); }
      let proposal;
      try { proposal = buildProposal(body, identity()); }
      catch (err) { return bad(err.message); }
      await writeJson(bucket, proposalKey(proposal.id), proposal);
      return json({ ok: true, proposal }, 201);
    }

    if ((route === "proposals/approve" || route === "proposals/reject") && method === "POST") {
      const gate = browserWrite(request);
      if (!gate.ok) return refuseWrite(gate);
      const id = cleanId(url.searchParams.get("id"));
      if (!id) return bad("bad id");
      const current = await readJson(bucket, proposalKey(id));
      if (!current) return bad("not found", 404);
      try {
        if (route === "proposals/approve") {
          const { proposal, note } = approveProposal(current, identity());
          await writeJson(bucket, proposalKey(id), proposal);
          await writeJson(bucket, noteKey(note.page), note);
          return json({ ok: true, proposal, note });
        }
        const proposal = rejectProposal(current, identity());
        await writeJson(bucket, proposalKey(id), proposal);
        return json({ ok: true, proposal });
      } catch (err) { return bad(err.message); }
    }

    // ---- comments ----------------------------------------------------------
    if (route === "comments" || route === "comments/pins" || route.startsWith("comments/")) {
      const settings = await loadCommentsSettings(env, request);
      if (!settings.enabled) return bad("not found", 404);

      if (route === "comments" && method === "GET") {
        const loc = threadQuery(url);
        if (loc.error) return bad(loc.error);
        const actor = commentsActor(request, identity());
        const { doc } = await readThread(bucket, loc.scope, loc.targetId);
        return json({
          scope: loc.scope,
          target_id: loc.targetId,
          viewer: viewerFor(actor, settings),
          comments: sortThreadComments(doc.comments).map((item) => presentComment(item, actor, settings)),
        });
      }

      if (route === "comments/pins" && method === "GET") {
        const loc = threadQuery(url);
        if (loc.error) return bad(loc.error);
        const actor = commentsActor(request, identity());
        const { doc } = await readThread(bucket, loc.scope, loc.targetId);
        return json({
          scope: loc.scope,
          target_id: loc.targetId,
          viewer: viewerFor(actor, settings),
          pins: pinnedComments(doc.comments).map((item) => presentComment(item, actor, settings)),
        });
      }

      if (route === "comments" && method === "POST") {
        const gate = sameSiteWrite(request);
        if (!gate.ok) return refuseWrite(gate);
        let body;
        try { body = await request.json(); } catch { return bad("bad json"); }
        const actor = commentsActor(request, identity(), body);
        const allowed = commentPolicy("create", { actor, settings });
        if (!allowed.ok) return bad(allowed.error, allowed.status);
        let comment;
        try { comment = buildComment(body, actor); }
        catch (err) { return bad(err.message); }
        try {
          const { doc } = await updateThread(bucket, comment.scope, comment.target_id, (current) => (
            addCommentToThread(current, comment)
          ));
          const stored = doc.comments.find((item) => item.id === comment.id);
          return json({ ok: true, comment: presentComment(stored, actor, settings) }, 201);
        } catch (err) {
          return bad(err.message, err.status || 400);
        }
      }

      const parts = route.split("/");
      const id = cleanId(parts[1]);
      const action = parts[2] || "";
      if (!id || parts[0] !== "comments" || parts.length > 3) return bad("no such route", 404);

      if (method === "PATCH" && !action) {
        const gate = sameSiteWrite(request);
        if (!gate.ok) return refuseWrite(gate);
        let body;
        try { body = await request.json(); } catch { return bad("bad json"); }
        const hint = threadQuery(url, body);
        const found = await findCommentLocation(bucket, id, hint.error ? null : { scope: hint.scope, target_id: hint.targetId });
        if (!found) return bad("not found", 404);
        const actor = commentsActor(request, identity(), body);
        const allowed = commentPolicy("edit", { actor, comment: found.comment, settings });
        if (!allowed.ok) return bad(allowed.error, allowed.status);
        try {
          const extra = Object.hasOwn(body || {}, "quote") ? { quote: body.quote } : {};
          const { doc } = await updateThread(bucket, found.comment.scope, found.comment.target_id, (current) => (
            editCommentInThread(current, id, body?.body, new Date(), extra)
          ));
          return json({ ok: true, comment: presentComment(doc.comments.find((item) => item.id === id), actor, settings) });
        } catch (err) {
          return bad(err.message, err.status || 400);
        }
      }

      if (method === "DELETE" && !action) {
        const gate = sameSiteWrite(request);
        if (!gate.ok) return refuseWrite(gate);
        const hint = threadQuery(url);
        const found = await findCommentLocation(bucket, id, hint.error ? null : { scope: hint.scope, target_id: hint.targetId });
        if (!found) return bad("not found", 404);
        const actor = commentsActor(request, identity());
        const allowed = commentPolicy("delete", { actor, comment: found.comment, settings });
        if (!allowed.ok) return bad(allowed.error, allowed.status);
        try {
          const { doc } = await updateThread(bucket, found.comment.scope, found.comment.target_id, (current) => (
            softDeleteCommentInThread(current, id, actor)
          ));
          return json({ ok: true, comment: presentComment(doc.comments.find((item) => item.id === id), actor, settings) });
        } catch (err) {
          return bad(err.message, err.status || 400);
        }
      }

      if (method === "POST" && (action === "pin" || action === "unpin" || action === "reorder")) {
        const gate = sameSiteWrite(request);
        if (!gate.ok) return refuseWrite(gate);
        let body = {};
        if (action === "reorder") {
          try { body = await request.json(); } catch { return bad("bad json"); }
        }
        const hint = threadQuery(url, body);
        const found = await findCommentLocation(bucket, id, hint.error ? null : { scope: hint.scope, target_id: hint.targetId });
        if (!found) return bad("not found", 404);
        const actor = commentsActor(request, identity(), body);
        const allowed = commentPolicy(action, { actor, comment: found.comment, settings });
        if (!allowed.ok) return bad(allowed.error, allowed.status);
        try {
          const { doc } = await updateThread(bucket, found.comment.scope, found.comment.target_id, (current) => {
            if (action === "pin") return pinCommentInThread(current, id, actor);
            if (action === "unpin") return unpinCommentInThread(current, id);
            return reorderPinsInThread(current, body?.order);
          });
          return json({
            ok: true,
            comment: presentComment(doc.comments.find((item) => item.id === id), actor, settings),
            pins: pinnedComments(doc.comments).map((item) => presentComment(item, actor, settings)),
            viewer: viewerFor(actor, settings),
          });
        } catch (err) {
          return bad(err.message, err.status || 400);
        }
      }

      return bad("no such route", 404);
    }

    // ---- listing -----------------------------------------------------------
    if (route === "files" && method === "GET") {
      const reserved = refuseCommentsStore(url.searchParams.get("prefix") || "");
      if (reserved) return reserved;
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
      const reserved = refuseCommentsStore(url.searchParams.get("key") || "");
      if (reserved) return reserved;
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
          uploader: identity(),
          note: (url.searchParams.get("note") || "").slice(0, 200),
        },
      });
      const head = await bucket.head(key);
      return json({ ok: true, file: head ? describe(head) : { key } }, 201);
    }

    if (route === "files" && method === "DELETE") {
      const reserved = refuseCommentsStore(url.searchParams.get("key") || "");
      if (reserved) return reserved;
      const key = cleanKey(url.searchParams.get("key"));
      if (!key) return bad("bad key");
      await bucket.delete(key);
      return json({ ok: true, deleted: key });
    }

    // ---- download -----------------------------------------------------------
    if (route === "dl" && method === "GET") {
      const reserved = refuseCommentsStore(url.searchParams.get("key") || "");
      if (reserved) return reserved;
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
      // The browser must take the stored type at its word, never guess a
      // scriptable one from the bytes.
      headers.set("x-content-type-options", "nosniff");

      const name = key.slice(key.lastIndexOf("/") + 1);
      const shownAs = url.searchParams.get("inline") === "1" ? inlineType(headers.get("content-type")) : null;
      const inline = shownAs !== null;
      if (inline) headers.set("content-type", shownAs);
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
      const reserved = refuseCommentsStore(url.searchParams.get("key") || "");
      if (reserved) return reserved;
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
          uploader: identity(),
          note: (url.searchParams.get("note") || "").slice(0, 200),
        },
      });
      return json({ key, uploadId: mpu.uploadId });
    }

    if (route === "mpu/part" && method === "PUT") {
      const reserved = refuseCommentsStore(url.searchParams.get("key") || "");
      if (reserved) return reserved;
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
      const reserved = refuseCommentsStore(url.searchParams.get("key") || "");
      if (reserved) return reserved;
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
      const reserved = refuseCommentsStore(url.searchParams.get("key") || "");
      if (reserved) return reserved;
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
