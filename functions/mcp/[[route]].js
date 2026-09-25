/**
 * Team hub MCP server — Model Context Protocol over Streamable HTTP.
 *
 * Lets an agent working in the team repo read the hub directly instead of a
 * human relaying it: what the last meeting decided, whose action items are
 * open, which tickets are agent-ready, where the latest build is.
 *
 * Hand-rolled JSON-RPC rather than the MCP SDK on purpose. This repo has no
 * build step — the deploy is `wrangler pages deploy` over plain files — and
 * pulling in a dependency would mean adding package.json plus an npm install
 * to the workflow. The protocol surface we need is four methods.
 *
 * AUTH: this route sits behind the same Cloudflare Access gate as the rest of
 * the site, and Access checks every request before it reaches this code. There
 * is no token scheme of our own here, which would be a second, weaker gate.
 * What this code does check is the JWT Access signs onto each request
 * (functions/_shared/access.js), so the identity it records can't be faked by
 * a request that somehow skipped Access. Two kinds of caller get through:
 *   - A person's agent signs in as that person, in the browser. With Managed
 *     OAuth turned on for the Access application, Access answers an MCP client
 *     that has no token with a 401 that starts the standard MCP OAuth flow, and
 *     forwards the person's email (Cf-Access-Authenticated-User-Email) on every
 *     request after that.
 *   - A build machine with nobody at it uses an Access service token
 *     (CF-Access-Client-Id / CF-Access-Client-Secret headers). Service tokens
 *     carry no email, so uploads from one are recorded against the token.
 *
 * Binding: HUB_FILES -> R2. Static JSON is read through env.ASSETS.
 */

import { accessIdentity } from "../_shared/access.js";

const PROTOCOL_VERSION = "2025-06-18";
/* The hub's name is per-deployment, so it comes from a wrangler.toml [vars]
   entry rather than being baked in here. Falls back to a neutral default so an
   unconfigured deploy still speaks valid MCP. */
const VERSION = "1.0.0";
const serverInfo = (env) => ({ name: (env && env.HUB_NAME) || "team-hub", version: VERSION });

/** Areas the upload tool may write to, mirroring the file API. */
const UPLOAD_AREAS = ["share", "builds", "meetings", "clips"];

/** Inline base64 is fine for a screenshot, not for a multi-gigabyte build. */
const INLINE_UPLOAD_MAX = 8 * 1024 * 1024;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

/** Tool results are content blocks; everything here answers as text/JSON. */
const ok = (data) => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
const fail = (message) => ({ content: [{ type: "text", text: message }], isError: true });

/* ---- reading the site's own published JSON -------------------------------- */

async function readAsset(env, request, path) {
  const url = new URL(request.url);
  url.pathname = path;
  url.search = "";
  const res = env.ASSETS ? await env.ASSETS.fetch(new Request(url)) : await fetch(url);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

const asMeetingSummary = (m) => ({
  id: m.id,
  title: m.title,
  date: m.date,
  durationSec: m.durationSec,
  attendees: m.attendees || [],
  blurb: m.blurb || "",
  headline: m.summary?.headline || "",
  counts: {
    decisions: (m.decisions || []).length,
    actionItems: (m.actionItems || []).length,
    clips: (m.clips || []).length,
  },
});

async function loadMeeting(env, request, id) {
  const index = await readAsset(env, request, "/meetings/index.json");
  const entry = (index.meetings || []).find((m) => m.file.includes(id));
  if (!entry) throw new Error(`no meeting with id ${id}`);
  return readAsset(env, request, "/" + entry.file.replace(/^\/+/, ""));
}

/* ---- tools ---------------------------------------------------------------- */

const TOOLS = [
  {
    name: "list_meetings",
    description:
      "List published team meetings, newest first, with attendees and a one-line headline. Start here to find a meeting id.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_meeting",
    description:
      "Full record for one meeting: summary, decisions, action items, clips, and any cautions about what must not be shared. Note some meetings withhold portions of the transcript.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: 'Meeting id, e.g. "2026-08-12"' } },
      required: ["id"],
    },
  },
  {
    name: "search_transcript",
    description:
      "Search one meeting's transcript for a phrase. Returns matching lines with timestamps. Withheld sections are absent and marked in the transcript.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Meeting id" },
        query: { type: "string", description: "Text to find, case-insensitive" },
        limit: { type: "number", description: "Max lines to return (default 20)" },
      },
      required: ["id", "query"],
    },
  },
  {
    name: "list_action_items",
    description:
      "Action items across meetings, optionally filtered by owner. Names are inferred from context — no speaker labels — so treat ownership as a strong hint, not a record.",
    inputSchema: {
      type: "object",
      properties: {
        who: { type: "string", description: "Filter by owner, case-insensitive substring" },
        meeting: { type: "string", description: "Limit to one meeting id" },
      },
    },
  },
  {
    name: "list_agent_ready_tickets",
    description:
      'Jira tickets that carry a "Done =" acceptance line and are ready for an agent to pick up, from the dashboard data feed.',
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_files",
    description:
      "List files in the team store. Prefixes: builds/, share/, meetings/, clips/.",
    inputSchema: {
      type: "object",
      properties: { prefix: { type: "string", description: 'Defaults to "share/"' } },
    },
  },
  {
    name: "latest_build",
    description:
      "The newest build per platform, with a download URL. Platform folders live under builds/<platform>/.",
    inputSchema: {
      type: "object",
      properties: { platform: { type: "string", description: 'e.g. "windows"; omit for all' } },
    },
  },
  {
    name: "upload_file",
    description:
      "Upload a small file (<=8MB) such as a screenshot or document, base64-encoded. For builds and other large files use start_large_upload — base64 in a tool call is the wrong transport for gigabytes.",
    inputSchema: {
      type: "object",
      properties: {
        area: { type: "string", description: "share | builds | meetings | clips" },
        name: { type: "string", description: "File name" },
        data_base64: { type: "string", description: "File bytes, base64" },
        folder: { type: "string", description: "Optional subfolder, e.g. windows" },
        content_type: { type: "string", description: "MIME type; defaults by extension" },
      },
      required: ["area", "name", "data_base64"],
    },
  },
  {
    name: "start_large_upload",
    description:
      "Begin a chunked upload for a large file (a build). Returns the endpoints and uploadId to PUT 32MB chunks to, then complete. Use this instead of upload_file above 8MB.",
    inputSchema: {
      type: "object",
      properties: {
        area: { type: "string", description: "share | builds | meetings | clips" },
        name: { type: "string" },
        folder: { type: "string", description: "Optional subfolder, e.g. windows" },
      },
      required: ["area", "name"],
    },
  },
];

const TYPE_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  mp4: "video/mp4", zip: "application/zip", json: "application/json",
  txt: "text/plain", md: "text/markdown", pdf: "application/pdf",
};

function buildKey(area, folder, name) {
  if (!UPLOAD_AREAS.includes(area)) throw new Error(`area must be one of ${UPLOAD_AREAS.join(", ")}`);
  const safeName = String(name).replace(/[^\w. ()+@-]/g, "_");
  const safeFolder = folder ? String(folder).replace(/[^\w -]/g, "").replace(/\s+/g, "-") : "";
  if (!safeName) throw new Error("name is empty after sanitising");
  return [area, safeFolder, safeName].filter(Boolean).join("/");
}

async function callTool(name, args, { env, request, identity }) {
  const bucket = env.HUB_FILES;
  args = args || {};

  switch (name) {
    case "list_meetings": {
      const index = await readAsset(env, request, "/meetings/index.json");
      const out = [];
      for (const entry of index.meetings || []) {
        const m = await readAsset(env, request, "/" + entry.file.replace(/^\/+/, ""));
        out.push(asMeetingSummary(m));
      }
      return ok(out);
    }

    case "get_meeting": {
      const m = await loadMeeting(env, request, args.id);
      return ok({
        ...asMeetingSummary(m),
        cautions: m.cautions || [],
        provenance: m.provenance || {},
        recordingPolicy: m.recordingPolicy || "",
        summary: m.summary || {},
        topics: m.topics || [],
        decisions: m.decisions || [],
        actionItems: m.actionItems || [],
        clips: (m.clips || []).map((c) => ({
          title: c.title, audience: c.audience, start: c.start, end: c.end,
          quote: c.quote, why: c.why, key: c.key,
        })),
      });
    }

    case "search_transcript": {
      const m = await loadMeeting(env, request, args.id);
      if (!m.transcript) return fail(`meeting ${args.id} has no transcript`);
      const t = await readAsset(env, request, "/" + m.transcript.replace(/^\/+/, ""));
      const needle = String(args.query || "").toLowerCase();
      if (!needle) return fail("query is empty");
      const limit = Math.min(Number(args.limit) || 20, 100);
      const hits = (t.segments || [])
        .filter((s) => s.t.toLowerCase().includes(needle))
        .slice(0, limit)
        .map((s) => ({ at: s.s, text: s.t }));
      return ok({
        meeting: args.id, query: args.query, matches: hits.length,
        redactions: t.redactions || [], lines: hits,
      });
    }

    case "list_action_items": {
      const index = await readAsset(env, request, "/meetings/index.json");
      const who = (args.who || "").toLowerCase();
      const out = [];
      for (const entry of index.meetings || []) {
        const m = await readAsset(env, request, "/" + entry.file.replace(/^\/+/, ""));
        if (args.meeting && m.id !== args.meeting) continue;
        for (const a of m.actionItems || []) {
          if (who && !(a.who || "").toLowerCase().includes(who)) continue;
          out.push({ meeting: m.id, who: a.who, what: a.what, at: a.at, ticket: a.ticket || null });
        }
      }
      return ok({
        count: out.length,
        note: "Owners are inferred from context — the transcripts have no speaker labels.",
        items: out,
      });
    }

    case "list_agent_ready_tickets": {
      const data = await readAsset(env, request, "/data.json");
      const q = data.jira?.agentReady || {};
      return ok({
        readyTotal: q.readyTotal ?? 0,
        todoTotal: q.todoTotal ?? 0,
        generatedAt: data.generatedAt,
        tickets: q.tickets || [],
      });
    }

    case "list_files": {
      if (!bucket) return fail("R2 bucket not bound");
      const prefix = args.prefix || "share/";
      const listed = await bucket.list({
        prefix, limit: 1000, include: ["httpMetadata", "customMetadata"],
      });
      return ok({
        prefix,
        count: listed.objects.length,
        files: listed.objects.map((o) => ({
          key: o.key,
          size: o.size,
          uploaded: o.uploaded,
          contentType: o.httpMetadata?.contentType || "application/octet-stream",
          uploader: o.customMetadata?.uploader || "",
          downloadUrl: `/api/dl?key=${encodeURIComponent(o.key)}`,
        })),
      });
    }

    case "latest_build": {
      if (!bucket) return fail("R2 bucket not bound");
      const listed = await bucket.list({ prefix: "builds/", limit: 1000, include: ["customMetadata"] });
      const groups = {};
      for (const o of listed.objects) {
        const parts = o.key.split("/");
        const platform = parts.length > 2 ? parts[1] : "general";
        if (args.platform && platform !== args.platform) continue;
        (groups[platform] ||= []).push(o);
      }
      const latest = Object.entries(groups).map(([platform, objs]) => {
        objs.sort((a, b) => String(b.uploaded).localeCompare(String(a.uploaded)));
        const o = objs[0];
        return {
          platform,
          key: o.key,
          size: o.size,
          uploaded: o.uploaded,
          downloadUrl: `/api/dl?key=${encodeURIComponent(o.key)}`,
          olderCount: objs.length - 1,
        };
      });
      return latest.length
        ? ok(latest)
        : ok({ note: "No builds uploaded yet — builds/ is empty.", builds: [] });
    }

    case "upload_file": {
      if (!bucket) return fail("R2 bucket not bound");
      let key;
      try { key = buildKey(args.area, args.folder, args.name); }
      catch (e) { return fail(e.message); }

      let bytes;
      try {
        const bin = atob(String(args.data_base64 || ""));
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } catch { return fail("data_base64 is not valid base64"); }

      if (bytes.length === 0) return fail("file is empty");
      if (bytes.length > INLINE_UPLOAD_MAX) {
        return fail(
          `file is ${bytes.length} bytes; inline upload caps at ${INLINE_UPLOAD_MAX}. Use start_large_upload.`
        );
      }
      if (await bucket.head(key)) return fail(`${key} already exists — pick another name`);

      const ext = String(args.name).split(".").pop().toLowerCase();
      await bucket.put(key, bytes, {
        httpMetadata: { contentType: args.content_type || TYPE_BY_EXT[ext] || "application/octet-stream" },
        customMetadata: { uploader: identity, note: "via mcp" },
      });
      return ok({ uploaded: key, size: bytes.length, downloadUrl: `/api/dl?key=${encodeURIComponent(key)}` });
    }

    case "start_large_upload": {
      if (!bucket) return fail("R2 bucket not bound");
      let key;
      try { key = buildKey(args.area, args.folder, args.name); }
      catch (e) { return fail(e.message); }
      if (await bucket.head(key)) return fail(`${key} already exists — pick another name`);

      const mpu = await bucket.createMultipartUpload(key, {
        customMetadata: { uploader: identity, note: "via mcp" },
      });
      return ok({
        key,
        uploadId: mpu.uploadId,
        chunkSize: 32 * 1024 * 1024,
        instructions:
          "PUT each 32MB chunk to /api/mpu/part?key=..&uploadId=..&part=N (1-based, every chunk the same size except the last), collecting the returned {partNumber, etag}. Then POST /api/mpu/complete?key=..&uploadId=.. with {parts:[...]}. On failure DELETE /api/mpu/abort?key=..&uploadId=.. so no partial object is left behind. These are plain HTTPS requests, so they need their own way past Cloudflare Access: on a person's machine, sign in once with `cloudflared access login <hub URL>` and send each request with `cloudflared access curl`, which records the upload against that person; a build machine sends its Access service token headers instead.",
      });
    }

    default:
      return fail(`unknown tool: ${name}`);
  }
}

/* ---- JSON-RPC plumbing ---------------------------------------------------- */

async function handleRpc(msg, ctx) {
  const { id, method, params } = msg || {};

  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: serverInfo(ctx && ctx.env),
      /* The default describes what every hub serves. A deployment whose
         transcripts carry caveats worth stating up front — no speaker labels,
         withheld sections — can say so by setting HUB_MCP_INSTRUCTIONS. */
      instructions:
        (ctx && ctx.env && ctx.env.HUB_MCP_INSTRUCTIONS) ||
        "Read-and-upload access to this team hub: meetings, decisions, action items, the agent-ready ticket queue, and the shared file store.",
    });
  }
  if (method === "tools/list") return rpcResult(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    try {
      return rpcResult(id, await callTool(name, params?.arguments, ctx));
    } catch (err) {
      return rpcResult(id, fail(`${name} failed: ${err.message}`));
    }
  }
  if (method === "ping") return rpcResult(id, {});
  return rpcError(id, -32601, `method not found: ${method}`);
}

/* Streamable HTTP clients (Claude Code, Codex, Cursor) open a GET asking for text/event-stream to
   listen for server messages. This server has none to send, so the spec's answer is 405, which
   tells the client not to open that stream. Answering 200 JSON instead made clients treat it as a
   stream that ended at once and reconnect in a loop, which used up the Functions request quota. */
export function wantsEventStream(request) {
  return request.method === "GET" && /text\/event-stream/i.test(request.headers.get("accept") || "");
}

export async function onRequest(context) {
  const { request, env } = context;
  if (wantsEventStream(request)) {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }

  /* Who Cloudflare Access verified this request as (see functions/_shared/access.js). A
     service token carries no email, hence the fallback. */
  const access = await accessIdentity(request, env);
  if (!access.ok) return json({ error: access.error }, access.status);
  const ctx = { ...context, identity: access.email || "mcp-service-token" };

  if (request.method === "GET") {
    // A browser landing here should get an explanation, not a protocol error.
    return json({
      server: serverInfo(context.env),
      protocolVersion: PROTOCOL_VERSION,
      transport: "streamable-http",
      tools: TOOLS.map((t) => t.name),
      hint: "POST JSON-RPC to this endpoint. See README, 'Connecting an agent'.",
    });
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body;
  try { body = await request.json(); }
  catch { return json(rpcError(null, -32700, "parse error"), 400); }

  // A batch is an array; notifications carry no id and get no reply.
  const messages = Array.isArray(body) ? body : [body];
  const replies = [];
  for (const msg of messages) {
    if (msg && msg.id === undefined) continue;
    replies.push(await handleRpc(msg, ctx));
  }
  if (replies.length === 0) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? replies : replies[0]);
}
