/**
 * Who Cloudflare Access says is making a request.
 *
 * Access checks every request before it reaches a Function and forwards what it verified in two
 * headers: Cf-Access-Authenticated-User-Email, and Cf-Access-Jwt-Assertion, a JWT signed with the
 * team's keys. The email header is only as good as the promise that nothing reaches the Function
 * without passing Access: one hostname or route left out of the Access application, and anyone
 * can send any email. The JWT proves itself. So once a deployment names its Access team and
 * application (ACCESS_TEAM_DOMAIN and ACCESS_AUD in wrangler.toml), every request must carry a
 * valid JWT and the email is read from inside it. Cloudflare requires this of an MCP server
 * before its Access application turns on Managed OAuth.
 *
 * Without those two settings (a new deployment, or `wrangler pages dev`, which has no Access in
 * front of it) the email header is trusted, as it always was. Exactly one of them set is refused
 * as a misconfiguration: a typo in one name must not quietly turn the check off.
 *
 * A service token's JWT carries no email, so `email` is "" for one; callers pick their own
 * fallback label.
 *
 * Hand-rolled on WebCrypto rather than a JWT library for the same reason the MCP server is
 * hand-rolled: this repo has no build step and no package.json.
 */

const KEY_TTL_MS = 60 * 60 * 1000;
const REFETCH_MIN_MS = 30 * 1000;
const CLOCK_LEEWAY_S = 60;

/* Keys are cached per isolate. Access rotates them, so an unknown key id triggers a refetch
   before the token is rejected, but at most once per REFETCH_MIN_MS: otherwise a stream of
   tokens naming made-up key ids would cost one subrequest each. */
let cachedKeys = { domain: "", keys: [], at: 0 };

async function fetchKeys(domain) {
  const res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access keys -> ${res.status}`);
  const body = await res.json();
  return body.keys || [];
}

async function keyFor(kid, domain, load, now) {
  const fresh = cachedKeys.domain === domain && now - cachedKeys.at < KEY_TTL_MS;
  let key = fresh ? cachedKeys.keys.find((k) => k.kid === kid) : undefined;
  if (!key && !(fresh && now - cachedKeys.at < REFETCH_MIN_MS)) {
    cachedKeys = { domain, keys: await load(domain), at: now };
    key = cachedKeys.keys.find((k) => k.kid === kid);
  }
  return key;
}

function base64url(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const decodeJson = (part) => JSON.parse(new TextDecoder().decode(base64url(part)));

/** Throws with a short reason when the token isn't a valid Access JWT for this application. */
export async function verifyAccessJwt(token, { teamDomain, aud, loadKeys = fetchKeys, now = Date.now() }) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("not a JWT");
  const [h, p, s] = parts;

  let header, payload;
  try { header = decodeJson(h); payload = decodeJson(p); }
  catch { throw new Error("unreadable JWT"); }
  if (header.alg !== "RS256") throw new Error(`unexpected algorithm ${header.alg}`);

  const jwk = await keyFor(header.kid, teamDomain, loadKeys, now);
  if (!jwk) throw new Error("signed with a key Access doesn't publish");
  const key = await crypto.subtle.importKey(
    "jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
  );
  const signed = new TextEncoder().encode(`${h}.${p}`);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64url(s), signed))) {
    throw new Error("bad signature");
  }

  if (payload.iss !== `https://${teamDomain}`) throw new Error("issued by a different Access team");
  if (![].concat(payload.aud || []).includes(aud)) throw new Error("issued for a different application");
  const seconds = now / 1000;
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_LEEWAY_S < seconds) throw new Error("expired");
  if (typeof payload.nbf === "number" && payload.nbf - CLOCK_LEEWAY_S > seconds) throw new Error("not valid yet");
  return payload;
}

/**
 * { ok: true, email } when the request may proceed; { ok: false, status, error } when it must be
 * refused (403 for the request, 500 for a half-configured deployment). `deps` exists for tests:
 * { loadKeys, now }.
 */
export async function accessIdentity(request, env, deps = {}) {
  const teamDomain = String(env?.ACCESS_TEAM_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const aud = String(env?.ACCESS_AUD || "");
  if (!teamDomain && !aud) {
    return { ok: true, email: request.headers.get("Cf-Access-Authenticated-User-Email") || "" };
  }
  if (!teamDomain || !aud) {
    return { ok: false, status: 500, error: "ACCESS_TEAM_DOMAIN and ACCESS_AUD must be set together (see wrangler.toml)" };
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { ok: false, status: 403, error: "no Cloudflare Access token on this request" };
  try {
    const payload = await verifyAccessJwt(token, { teamDomain, aud, ...deps });
    return { ok: true, email: typeof payload.email === "string" ? payload.email : "" };
  } catch (err) {
    return { ok: false, status: 403, error: `Cloudflare Access token rejected: ${err.message}` };
  }
}
