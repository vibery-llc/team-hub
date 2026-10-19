/*
 * The comments admin model (Charlie, Oct 19): isAdmin = signedInViaGitHub || HUB_ADMINS has the
 * email. Developers sign in through GitHub and are admins by default; HUB_ADMINS (merged with
 * comments.admins) whitelists non-developers. Everyone else can comment but not pin.
 *
 * The Access JWT does not name the identity provider, so the Functions ask Access's
 * /cdn-cgi/access/get-identity. These tests sign real Access JWTs with a throwaway key and stub
 * global fetch for both the key set and get-identity. A failed lookup is never admin.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { onRequest } from "./[[route]].js";
import { accessIdp } from "../_shared/access.js";
import { memoryBucket } from "../_shared/memory-bucket.js";

const TEAM = "admins-team.cloudflareaccess.com";
const AUD = "admins-app-aud";
const HUB = "https://hub.example";
const ENABLED = { comments: { enabled: true, admins: [] } };

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"]
);
const JWK = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "admins-key", alg: "RS256", use: "sig" };
async function sign(email) {
  const t = Math.floor(Date.now() / 1000);
  const unsigned = `${enc({ alg: "RS256", kid: "admins-key", typ: "JWT" })}.${enc({
    iss: `https://${TEAM}`, aud: [AUD], email, iat: t - 10, exp: t + 3600,
  })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

/* tokens -> what get-identity answers for that token ({ status, body } or "throw"). */
const identities = new Map();
let identityCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === `https://${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [JWK] });
  if (url === `${HUB}/cdn-cgi/access/get-identity`) {
    const cookie = new Headers(init.headers).get("Cookie") || "";
    const token = cookie.replace(/^CF_Authorization=/, "");
    identityCalls.push(token);
    const answer = identities.get(token);
    if (!answer || answer === "throw") throw new Error("get-identity unreachable");
    if (answer.raw) return new Response(answer.raw, { status: answer.status || 200 });
    return Response.json(answer.body, { status: answer.status || 200 });
  }
  return realFetch(input, init);
};
test.after(() => { globalThis.fetch = realFetch; });

/** A signed-in person: a verified JWT, and what get-identity says about it. */
async function person(email, answer) {
  const token = await sign(email);
  identities.set(token, answer);
  return token;
}
const idp = (email, type) => ({ body: { email, idp: { id: `${type}-idp-id`, type } } });

function call(bucket, path, { token, method = "GET", body, admins, browser = true, cookie = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) {
    if (cookie) headers.Cookie = `other=1; CF_Authorization=${token}`;
    headers["Cf-Access-Jwt-Assertion"] = token;
  }
  if (browser) headers.origin = HUB;
  const url = `${HUB}/api/${path}`;
  return onRequest({
    request: new Request(url, { method, headers, body: body == null ? undefined : JSON.stringify(body) }),
    env: { HUB_FILES: bucket, HUB_CONFIG: ENABLED, HUB_ADMINS: admins, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD },
    params: { route: path.split("?")[0].split("/") },
  });
}

/** Posts a comment as an ordinary author, then tries pin as `token`. Returns the pin response. */
async function tryPin(token, opts = {}) {
  const bucket = memoryBucket();
  const author = await person("author@example.com", idp("author@example.com", "google"));
  const created = await call(bucket, "comments", {
    token: author, method: "POST", body: { scope: "home", target_id: "home", body: "Welcome home" },
  });
  assert.equal(created.status, 201);
  const { comment } = await created.json();
  const pin = await call(bucket, `comments/${comment.id}/pin`, { token, method: "POST", ...opts });
  const listed = await (await call(bucket, "comments?scope=home&target_id=home", { token, ...opts })).json();
  const del = await call(bucket, `comments/${comment.id}`, { token, method: "DELETE", ...opts });
  return { pin, viewer: listed.viewer, del };
}

test("a GitHub sign-in is an admin: can pin and delete others' comments", async () => {
  const token = await person("dev@example.com", idp("dev@example.com", "github"));
  const { pin, viewer, del } = await tryPin(token);
  assert.equal(pin.status, 200);
  assert.equal((await pin.json()).comment.pinned, true);
  assert.deepEqual(viewer, { can_pin: true, is_admin: true });
  assert.equal(del.status, 200);
});

test("a Google sign-in not on HUB_ADMINS is a normal user: can comment, cannot pin or delete others'", async () => {
  const token = await person("guest@example.com", idp("guest@example.com", "google"));
  const { pin, viewer, del } = await tryPin(token, { admins: "boss@example.com" });
  assert.equal(pin.status, 403);
  assert.deepEqual(viewer, { can_pin: false, is_admin: false });
  assert.equal(del.status, 403);

  const bucket = memoryBucket();
  const own = await call(bucket, "comments", {
    token, method: "POST", body: { scope: "home", target_id: "home", body: "hi" },
  });
  assert.equal(own.status, 201);
});

test("a Google sign-in on HUB_ADMINS is an admin (the allowlist is case-insensitive)", async () => {
  const token = await person("Boss@Example.com", idp("Boss@Example.com", "google"));
  const { pin, viewer, del } = await tryPin(token, { admins: " other@example.com, boss@example.com " });
  assert.equal(pin.status, 200);
  assert.deepEqual(viewer, { can_pin: true, is_admin: true });
  assert.equal(del.status, 200);
});

test("an email one-time-code sign-in is a normal user", async () => {
  const token = await person("visitor@example.com", idp("visitor@example.com", "onetimepin"));
  const { pin, viewer, del } = await tryPin(token);
  assert.equal(pin.status, 403);
  assert.deepEqual(viewer, { can_pin: false, is_admin: false });
  assert.equal(del.status, 403);
});

test("an email one-time-code sign-in on HUB_ADMINS is an admin", async () => {
  const token = await person("boss@example.com", idp("boss@example.com", "onetimepin"));
  const { pin } = await tryPin(token, { admins: "boss@example.com" });
  assert.equal(pin.status, 200);
});

test("IdP lookup failure is never admin (fail closed): unreachable, 5xx, not JSON, no idp, other email", async () => {
  const failures = [
    "throw",
    { status: 500, body: { err: "boom" } },
    { status: 401, body: { err: "expired" } },
    { raw: "<html>sign in</html>" },
    { body: { email: "dev@example.com" } },
    { body: { email: "dev@example.com", idp: { id: "x" } } },
    { body: { email: "someone-else@example.com", idp: { type: "github" } } },
  ];
  for (const answer of failures) {
    const token = await person("dev@example.com", answer);
    const { pin, viewer } = await tryPin(token);
    assert.equal(pin.status, 403, JSON.stringify(answer));
    assert.deepEqual(viewer, { can_pin: false, is_admin: false }, JSON.stringify(answer));
  }
});

test("IdP lookup failure still leaves the HUB_ADMINS allowlist working", async () => {
  const token = await person("boss@example.com", "throw");
  const { pin } = await tryPin(token, { admins: "boss@example.com" });
  assert.equal(pin.status, 200);
});

test("a GitHub sign-in arriving via MCP (no same-site origin) still cannot pin", async () => {
  const token = await person("dev@example.com", idp("dev@example.com", "github"));
  const { pin } = await tryPin(token, { browser: false });
  assert.equal(pin.status, 403);
});

test("get-identity is asked with the CF_Authorization cookie when the browser sent one", async () => {
  const token = await person("dev@example.com", idp("dev@example.com", "github"));
  identityCalls = [];
  const { pin } = await tryPin(token, { cookie: true });
  assert.equal(pin.status, 200);
  assert.ok(identityCalls.includes(token));
});

test("accessIdp: unconfigured Access never looks the provider up and returns \"\"", async () => {
  let called = false;
  const fetchIdentity = async () => { called = true; return Response.json({ idp: { type: "github" } }); };
  const request = new Request(`${HUB}/api/comments`, { headers: { "Cf-Access-Jwt-Assertion": "x.y.z" } });
  assert.equal(await accessIdp(request, {}, { fetchIdentity }), "");
  assert.equal(called, false);
});

test("accessIdp: configured, no token at all returns \"\" without a lookup", async () => {
  let called = false;
  const fetchIdentity = async () => { called = true; return Response.json({ idp: { type: "github" } }); };
  const request = new Request(`${HUB}/api/comments`);
  assert.equal(await accessIdp(request, { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD }, { fetchIdentity }), "");
  assert.equal(called, false);
});

test("accessIdp: lower-cases the provider type and checks the email", async () => {
  const fetchIdentity = async () => Response.json({ email: "Dev@Example.com", idp: { type: "GitHub" } });
  const request = new Request(`${HUB}/api/comments`, { headers: { Cookie: "CF_Authorization=tok" } });
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
  assert.equal(await accessIdp(request, env, { fetchIdentity, email: "dev@example.com" }), "github");
  assert.equal(await accessIdp(request, env, { fetchIdentity, email: "other@example.com" }), "");
});
