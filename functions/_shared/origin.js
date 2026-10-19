/**
 * Same-site write check for the collaborative routes (feedback, notes,
 * proposals) and for MCP tools that mutate those stores.
 *
 * Cloudflare Access already proves who is calling. That is not enough for a
 * write: a signed-in person who has this hub open can be made to POST here
 * from a different site they also have open. Access cookies ride along. So
 * a mutating request that names another host in Origin, Referer or
 * Sec-Fetch-Site is refused, even with a valid Access JWT.
 *
 * A request with none of those headers — an MCP client, `cloudflared access
 * curl`, a service token — is allowed through. Those callers are not a
 * browser being borrowed by another origin.
 *
 * Human-only actions (pin a note, approve or reject a proposal) go further:
 * they require a same-site browser signal, so an agent that can reach the
 * HTTP API cannot approve its own proposal by issuing a headerless POST.
 */

export function hostOf(value) {
  try {
    return new URL(String(value || "")).host;
  } catch {
    return "";
  }
}

/**
 * { ok: true } when the request may mutate; { ok: false, error } when it
 * named a different site.
 */
export function sameSiteWrite(request) {
  const host = hostOf(request.url);
  const fetchSite = String(request.headers.get("sec-fetch-site") || "").toLowerCase();
  if (fetchSite === "cross-site") {
    return { ok: false, error: "cross-site write refused" };
  }

  const origin = request.headers.get("origin");
  if (origin) {
    const originHost = hostOf(origin);
    if (!originHost || originHost !== host) {
      return { ok: false, error: "cross-site write refused" };
    }
  }

  const referer = request.headers.get("referer");
  if (referer) {
    const refHost = hostOf(referer);
    if (!refHost || refHost !== host) {
      return { ok: false, error: "cross-site write refused" };
    }
  }

  return { ok: true };
}

/**
 * Same as sameSiteWrite, plus: a request with no Origin and no same-origin
 * Sec-Fetch-Site is refused. Used for pin / approve / reject — the actions
 * that must be a human in this hub's own pages, not an agent.
 */
export function browserWrite(request) {
  const site = sameSiteWrite(request);
  if (!site.ok) return site;

  const origin = request.headers.get("origin");
  const fetchSite = String(request.headers.get("sec-fetch-site") || "").toLowerCase();
  if (origin || fetchSite === "same-origin" || fetchSite === "same-site") {
    return { ok: true };
  }
  return { ok: false, error: "this action needs a same-site browser request" };
}
