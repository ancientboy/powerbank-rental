import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  beginGoogle,
  exchangeGoogle,
  googleConfigured,
} from "../src/production-google.mjs";

const config = {
  googleClientId: "test.apps.googleusercontent.com",
  googleClientSecret: "test-secret-not-real",
  publicOrigin: "https://rental.example",
};
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "key-1",
  alg: "RS256",
  use: "sig",
};
const timestamp = 1800000000000;
const input = {
  code: "one-time-code",
  nonce: "n".repeat(43),
  verifier: "v".repeat(43),
};
const baseClaims = {
  iss: "https://accounts.google.com",
  aud: config.googleClientId,
  sub: "1234567890",
  email: "user@example.com",
  email_verified: true,
  name: "Customer",
  nonce: input.nonce,
  iat: timestamp / 1000 - 5,
  exp: timestamp / 1000 + 3600,
};
function jwt(claims = {}, header = {}) {
  const h = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "key-1", ...header }),
  ).toString("base64url");
  const p = Buffer.from(JSON.stringify({ ...baseClaims, ...claims })).toString(
    "base64url",
  );
  return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`;
}
function provider(token = jwt(), keys = [jwk]) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === "https://oauth2.googleapis.com/token")
      return Response.json({ id_token: token });
    assert.equal(url, "https://www.googleapis.com/oauth2/v3/certs");
    return Response.json(
      { keys },
      { headers: { "cache-control": "public, max-age=3600" } },
    );
  };
  return { fetch, now: () => timestamp, calls };
}

test("configuration fails closed, permits HTTPS and only loopback HTTP", async () => {
  assert.equal(googleConfigured(config), true);
  for (const patch of [
    { googleClientSecret: "" },
    { googleClientId: "" },
    { publicOrigin: "http://rental.example" },
    { publicOrigin: "https://203.0.113.42" },
    { publicOrigin: "https://[2001:db8::42]" },
    { publicOrigin: "https://2130706434" },
    { publicOrigin: "https://x.example/path" },
    { publicOrigin: "https://u:p@x.example" },
    { publicOrigin: "https://x.example/?a=1" },
  ]) {
    assert.equal(googleConfigured({ ...config, ...patch }), false);
    await assert.rejects(
      beginGoogle({ ...config, ...patch }),
      /Google authentication failed/,
    );
  }
  assert.equal(googleConfigured(undefined), false);
  assert.equal(
    googleConfigured({ ...config, publicOrigin: "http://localhost:3000" }),
    true,
  );
});

test("authorization URL has independent 256-bit state/nonce, PKCE S256 and identity-only scopes", async () => {
  const one = await beginGoogle(config);
  const two = await beginGoogle(config);
  const url = new URL(one.url);
  assert.equal(
    url.origin + url.pathname,
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
  for (const field of ["state", "nonce", "verifier"]) {
    assert.equal(Buffer.from(one[field], "base64url").length, 32);
    assert.notEqual(one[field], two[field]);
  }
  assert.notEqual(one.state, one.nonce);
  assert.equal(url.searchParams.get("state"), one.state);
  assert.equal(url.searchParams.get("nonce"), one.nonce);
  assert.equal(
    url.searchParams.get("code_challenge"),
    createHash("sha256").update(one.verifier).digest("base64url"),
  );
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://rental.example/auth/google/callback",
  );
  assert.equal(url.searchParams.has("client_secret"), false);
});

test("exchanges with secret and verifier, verifies signature and returns only identity", async () => {
  const stub = provider();
  assert.deepEqual(await exchangeGoogle(config, input, stub), {
    sub: "1234567890",
    email: "user@example.com",
    name: "Customer",
  });
  const body = new URLSearchParams(stub.calls[0].options.body);
  assert.equal(body.get("client_secret"), config.googleClientSecret);
  assert.equal(body.get("code_verifier"), input.verifier);
  assert.equal(
    body.get("redirect_uri"),
    "https://rental.example/auth/google/callback",
  );
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(stub.calls[0].options.redirect, "error");
  assert.ok(stub.calls[0].options.signal instanceof AbortSignal);
  await exchangeGoogle(config, input, stub);
  assert.equal(stub.calls.filter((c) => c.url.endsWith("/certs")).length, 1);
});

for (const [name, claims] of Object.entries({
  wrongIssuer: { iss: "https://evil.example" },
  wrongAudience: { aud: "another-client" },
  multiAudienceWithoutAzp: { aud: [config.googleClientId, "other"] },
  wrongAzp: { azp: "other" },
  expired: { exp: timestamp / 1000 },
  futureIat: { iat: timestamp / 1000 + 120 },
  stringExpiry: { exp: String(timestamp / 1000 + 3600) },
  wrongNonce: { nonce: "x".repeat(43) },
  missingNonce: { nonce: undefined },
  unverified: { email_verified: false },
  stringVerified: { email_verified: "true" },
  missingSub: { sub: "" },
  missingEmail: { email: "" },
})) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(
      exchangeGoogle(config, input, provider(jwt(claims))),
      /^Error: Google authentication failed$/,
    );
  });
}

test("accepts multi audience only with correct azp and legacy issuer", async () => {
  const result = await exchangeGoogle(
    config,
    input,
    provider(
      jwt({
        aud: [config.googleClientId, "other"],
        azp: config.googleClientId,
        iss: "accounts.google.com",
      }),
    ),
  );
  assert.equal(result.sub, baseClaims.sub);
});

test("rejects unsupported algorithm, malformed JWT, unknown key and bad signature", async () => {
  const valid = jwt();
  const parts = valid.split(".");
  parts[2] = Buffer.alloc(256).toString("base64url");
  for (const token of [
    jwt({}, { alg: "HS256" }),
    jwt({}, { alg: "none" }),
    jwt({}, { kid: "unknown" }),
    "bad.jwt",
    parts.join("."),
    jwt({}, { crit: ["extension"] }),
  ]) {
    await assert.rejects(
      exchangeGoogle(config, input, provider(token)),
      /Google authentication failed/,
    );
  }
});

test("refreshes public keys on rotation, limits repeated unknown-key refreshes", async () => {
  let token = jwt();
  let keys = [jwk];
  let time = timestamp;
  let keyRequests = 0;
  const fetch = async (url) => {
    if (url.endsWith("/token")) return Response.json({ id_token: token });
    keyRequests++;
    return Response.json(
      { keys },
      { headers: { "cache-control": "max-age=3600" } },
    );
  };
  const deps = { fetch, now: () => time };
  await exchangeGoogle(config, input, deps);
  token = jwt({}, { kid: "rotated" });
  keys = [{ ...jwk, kid: "rotated" }];
  time += 31000;
  await exchangeGoogle(config, input, deps);
  assert.equal(keyRequests, 2);
  token = jwt({}, { kid: "absent" });
  await assert.rejects(exchangeGoogle(config, input, deps));
  await assert.rejects(exchangeGoogle(config, input, deps));
  assert.equal(keyRequests, 2);
});

test("provider errors and oversize bodies are bounded and secret-free", async () => {
  for (const fetch of [
    async () => {
      throw new Error(config.googleClientSecret);
    },
    async () => new Response(config.googleClientSecret, { status: 400 }),
    async () => new Response("x".repeat(65537)),
    async () => new Response("{}", { headers: { "content-length": "70000" } }),
  ]) {
    await assert.rejects(
      exchangeGoogle(config, input, { fetch }),
      (error) =>
        error.message === "Google authentication failed" && !error.cause,
    );
  }
});

test("invalid input fails before making network requests", async () => {
  let called = false;
  await assert.rejects(
    exchangeGoogle(
      config,
      { ...input, verifier: "" },
      {
        fetch: async () => {
          called = true;
        },
      },
    ),
  );
  assert.equal(called, false);
});

test("enforces deadline even when fetch does not honor abort", async () => {
  const started = Date.now();
  await assert.rejects(
    exchangeGoogle(config, input, { fetch: async () => new Promise(() => {}) }),
    /Google authentication failed/,
  );
  assert.ok(Date.now() - started < 6500);
});

test("checks expiry after fetching keys, not before a delayed response", async () => {
  let time = timestamp;
  const fetch = async (url) => {
    if (url.endsWith("/token"))
      return Response.json({ id_token: jwt({ exp: timestamp / 1000 + 1 }) });
    time += 2000;
    return Response.json({ keys: [jwk] });
  };
  await assert.rejects(
    exchangeGoogle(config, input, { fetch, now: () => time }),
    /Google authentication failed/,
  );
});
