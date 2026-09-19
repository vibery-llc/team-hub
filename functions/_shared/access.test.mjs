/*
 * Proves the Functions trust who Cloudflare Access says is calling only when Access actually
 * signed it. Once ACCESS_TEAM_DOMAIN and ACCESS_AUD are set, a request needs a valid
 * Cf-Access-Jwt-Assertion, the email comes from inside that JWT (never from the plain header),
 * and a token from another team, another application, an expired session or a forged signature
 * is refused. Without those settings the header is trusted as before, so `wrangler pages dev` and
 * unconfigured deployments keep working.
 *
 * Tokens are signed here with a throwaway RSA key standing in for the team's; the key set is
 * served through an injected loader, or a stubbed global fetch for the handler-level tests.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { accessIdentity, verifyAccessJwt } from "./access.js";
import { onRequest as apiRequest } from "../api/[[route]].js";
import { onRequest as mcpRequest } from "../mcp/[[route]].js";

const TEAM = "team.cloudflareaccess.com";
const AUD = "app-aud-tag";
const ENV = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

async function signer(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256", use: "sig" };
  const sign = async (claims, header = { alg: "RS256", kid, typ: "JWT" }) => {
    const unsigned = `${enc(header)}.${enc(claims)}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(unsigned));
    return `${unsigned}.${b64url(new Uint8Array(sig))}`;
  };
  return { jwk, sign };
}

const team = await signer("team-key-1");
const stranger = await signer("team-key-1"); // same kid, different key: a forgery
const rotated = await signer("team-key-2");
const now = Date.now();
const claims = (extra = {}) => ({
  iss: `https://${TEAM}`, aud: [AUD], email: "dev@example.com",
  iat: Math.floor(now / 1000) - 10, exp: Math.floor(now / 1000) + 3600, ...extra,
});
const keys = (...signers) => async () => signers.map((s) => s.jwk);
const req = (headers = {}) => new Request("https://hub.example/api/whoami", { headers });

test("a valid Access JWT passes and its email wins over the header", async () => {
  const token = await team.sign(claims());
  const who = await accessIdentity(
    req({ "Cf-Access-Jwt-Assertion": token, "Cf-Access-Authenticated-User-Email": "someone-else@example.com" }),
    ENV, { loadKeys: keys(team), now }
  );
  assert.deepEqual(who, { ok: true, email: "dev@example.com" });
});

test("configured but no JWT: refused, whatever the email header says", async () => {
  const who = await accessIdentity(req({ "Cf-Access-Authenticated-User-Email": "boss@example.com" }), ENV, { loadKeys: keys(team), now });
  assert.equal(who.ok, false);
  assert.equal(who.status, 403);
  assert.match(who.error, /no Cloudflare Access token/);
});

for (const [name, make, why] of [
  ["another application", () => team.sign(claims({ aud: ["other-app"] })), /different application/],
  ["another Access team", () => team.sign(claims({ iss: "https://evil.cloudflareaccess.com" })), /different Access team/],
  ["an expired session", () => team.sign(claims({ exp: Math.floor(now / 1000) - 120 })), /expired/],
  ["no expiry at all", () => team.sign(claims({ exp: undefined })), /expired/],
  ["a forged signature", () => stranger.sign(claims()), /bad signature/],
  ["a non-RS256 algorithm", () => team.sign(claims(), { alg: "HS256", kid: "team-key-1" }), /unexpected algorithm/],
  ["a key Access doesn't publish", () => rotated.sign(claims()), /key Access doesn't publish/],
]) {
  test(`refuses a token for ${name}`, async () => {
    const who = await accessIdentity(req({ "Cf-Access-Jwt-Assertion": await make() }), ENV, { loadKeys: keys(team), now });
    assert.equal(who.ok, false, `should refuse ${name}`);
    assert.match(who.error, why);
  });
}

test("a rotated key is picked up by refetching once, and made-up key ids can't force a fetch each", async () => {
  let fetches = 0;
  let published = [team];
  const loadKeys = async () => { fetches++; return published.map((s) => s.jwk); };
  const later = now + 60 * 1000; // past the refetch floor, inside the cache lifetime
  assert.equal((await accessIdentity(req({ "Cf-Access-Jwt-Assertion": await team.sign(claims()) }), ENV, { loadKeys, now: later })).ok, true);
  published = [team, rotated];
  const before = fetches;
  const who = await accessIdentity(req({ "Cf-Access-Jwt-Assertion": await rotated.sign(claims()) }), ENV, { loadKeys, now: later });
  assert.equal(who.ok, true);
  assert.equal(fetches, before + 1, "exactly one refetch for the unknown key id");

  const bogus = await (await signer("made-up-kid")).sign(claims());
  for (let i = 0; i < 5; i++) {
    assert.equal((await accessIdentity(req({ "Cf-Access-Jwt-Assertion": bogus }), ENV, { loadKeys, now: later + 1000 })).ok, false);
  }
  assert.equal(fetches, before + 1, "no refetch within 30 s of the last one");
});

test("a service token's JWT has no email and still passes", async () => {
  const token = await team.sign(claims({ email: undefined, common_name: "client-id.access" }));
  assert.deepEqual(await accessIdentity(req({ "Cf-Access-Jwt-Assertion": token }), ENV, { loadKeys: keys(team), now }), { ok: true, email: "" });
});

test("unconfigured (wrangler pages dev, a new deployment): the header is trusted as before", async () => {
  assert.deepEqual(await accessIdentity(req({ "Cf-Access-Authenticated-User-Email": "dev@example.com" }), {}), { ok: true, email: "dev@example.com" });
});

test("half-configured (one of the two settings missing or misspelt): refused as a server error", async () => {
  for (const env of [{ ACCESS_TEAM_DOMAIN: TEAM }, { ACCESS_AUD: AUD }]) {
    const who = await accessIdentity(req({ "Cf-Access-Authenticated-User-Email": "dev@example.com" }), env);
    assert.equal(who.ok, false, "a typo in one name must not turn the check off");
    assert.equal(who.status, 500);
    assert.match(who.error, /must be set together/);
  }
});

test("the team domain may be written with https:// and a trailing slash", async () => {
  const token = await team.sign(claims());
  const who = await accessIdentity(req({ "Cf-Access-Jwt-Assertion": token }),
    { ACCESS_TEAM_DOMAIN: `https://${TEAM}/`, ACCESS_AUD: AUD }, { loadKeys: keys(team), now });
  assert.equal(who.ok, true);
});

test("verifyAccessJwt rejects things that aren't JWTs", async () => {
  await assert.rejects(verifyAccessJwt("not-a-jwt", { teamDomain: TEAM, aud: AUD, loadKeys: keys(team), now }), /not a JWT/);
  await assert.rejects(verifyAccessJwt("a.b.c", { teamDomain: TEAM, aud: AUD, loadKeys: keys(team), now }), /unreadable JWT/);
});

/* ---- the handlers themselves: key set served by a stubbed fetch to the team's certs URL ----
   A team domain of their own, so the key cache the tests above filled can't answer for them and
   the real fetch path runs. */

const HUB_TEAM = "hub-team.cloudflareaccess.com";
const HUB_ENV = { ACCESS_TEAM_DOMAIN: HUB_TEAM, ACCESS_AUD: AUD };
const hubClaims = () => claims({ iss: `https://${HUB_TEAM}` });
let certFetches = 0;

async function withCerts(fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url) === `https://${HUB_TEAM}/cdn-cgi/access/certs`) { certFetches++; return Response.json({ keys: [team.jwk] }); }
    throw new Error(`unexpected fetch ${url}`);
  };
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}

const apiCtx = (headers) => ({
  request: new Request("https://hub.example/api/whoami", { headers }),
  env: { ...HUB_ENV, HUB_FILES: {} },
  params: { route: ["whoami"] },
});
const mcpCtx = (headers) => ({
  request: new Request("https://hub.example/mcp", {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }),
  env: HUB_ENV,
});

test("file API: whoami answers with the JWT's email, and refuses a forged header alone", async () => {
  await withCerts(async () => {
    const ok = await apiRequest(apiCtx({ "Cf-Access-Jwt-Assertion": await team.sign(hubClaims()) }));
    assert.equal(ok.status, 200);
    assert.ok(certFetches >= 1, "the team's keys came from its certs URL");
    assert.deepEqual(await ok.json(), { email: "dev@example.com" });
    const forged = await apiRequest(apiCtx({ "Cf-Access-Authenticated-User-Email": "boss@example.com" }));
    assert.equal(forged.status, 403);
  });
});

test("MCP: a signed-in request lists tools, a request with no Access JWT is refused", async () => {
  await withCerts(async () => {
    const ok = await mcpRequest(mcpCtx({ "Cf-Access-Jwt-Assertion": await team.sign(hubClaims()) }));
    assert.equal(ok.status, 200);
    assert.ok((await ok.json()).result.tools.some((t) => t.name === "list_meetings"));
    const refused = await mcpRequest(mcpCtx({ "Cf-Access-Authenticated-User-Email": "boss@example.com" }));
    assert.equal(refused.status, 403);
  });
});
