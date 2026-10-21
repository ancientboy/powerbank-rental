import { isIP } from "node:net";
import {
  randomBytes,
  createHash,
  createPublicKey,
  verify,
  timingSafeEqual,
} from "node:crypto";

// Pinned official discovery endpoints: https://accounts.google.com/.well-known/openid-configuration
// Validation: https://developers.google.com/identity/openid-connect/openid-connect
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const MAX_BODY = 64 * 1024;
const TIMEOUT_MS = 5000;
const caches = new WeakMap(); // Public verification keys only, never tokens or login state.
const fail = () => new Error("Google authentication failed");

function redirectUri(config) {
  if (
    !config ||
    typeof config.googleClientId !== "string" ||
    !config.googleClientId.trim() ||
    config.googleClientId.length > 1024 ||
    typeof config.googleClientSecret !== "string" ||
    !config.googleClientSecret.trim() ||
    config.googleClientSecret.length > 4096 ||
    typeof config.publicOrigin !== "string"
  )
    throw fail();
  const origin = new URL(config.publicOrigin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  const host = origin.hostname.replace(/^\[|\]$/g, "");
  if (
    (!local && isIP(host)) ||
    (origin.protocol !== "https:" && !(local && origin.protocol === "http:")) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw fail();
  return `${origin.origin}/auth/google/callback`;
}

export function googleConfigured(config) {
  try {
    redirectUri(config);
    return true;
  } catch {
    return false;
  }
}

export async function beginGoogle(config) {
  try {
    const redirect_uri = redirectUri(config);
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const url = new URL(AUTH);
    url.search = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri,
      response_type: "code",
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    // Caller must persist a hash of state, nonce/verifier, expiry and browser binding,
    // then consume the state exactly once before calling exchangeGoogle.
    return { url: url.href, state, nonce, verifier };
  } catch {
    throw fail();
  }
}

async function fetchJson(fetcher, url, init = {}) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(fail());
    }, TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        const response = await fetcher(url, {
          ...init,
          redirect: "error",
          signal: controller.signal,
        });
        if (
          !response.ok ||
          Number(response.headers.get("content-length")) > MAX_BODY ||
          !response.body
        )
          throw fail();
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BODY) {
              controller.abort();
              void reader.cancel().catch(() => {});
              throw fail();
            }
            chunks.push(Buffer.from(value));
          }
        } finally {
          reader.releaseLock();
        }
        return {
          data: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          headers: response.headers,
        };
      })(),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function keyFor(kid, fetcher, now) {
  let cache = caches.get(fetcher);
  if (!cache) {
    cache = {
      keys: new Map(),
      expires: 0,
      refreshed: -Infinity,
      pending: null,
    };
    caches.set(fetcher, cache);
  }
  const expired = now >= cache.expires;
  if (expired || (!cache.keys.has(kid) && now - cache.refreshed >= 30000)) {
    if (!cache.pending) {
      cache.pending = (async () => {
        const { data, headers } = await fetchJson(fetcher, JWKS);
        if (
          !Array.isArray(data.keys) ||
          !data.keys.length ||
          data.keys.length > 20
        )
          throw fail();
        const keys = new Map();
        for (const jwk of data.keys) {
          if (
            jwk.kty !== "RSA" ||
            jwk.alg !== "RS256" ||
            jwk.use !== "sig" ||
            typeof jwk.kid !== "string" ||
            !jwk.kid ||
            jwk.kid.length > 256 ||
            keys.has(jwk.kid)
          )
            throw fail();
          const key = createPublicKey({ key: jwk, format: "jwk" });
          if (key.asymmetricKeyDetails.modulusLength < 2048) throw fail();
          keys.set(jwk.kid, key);
        }
        const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(
          headers.get("cache-control") || "",
        );
        const ttl = maxAge
          ? Math.min(Number(maxAge[1]) * 1000, 60 * 60 * 1000)
          : 5 * 60 * 1000;
        cache.keys = keys;
        cache.refreshed = now;
        cache.expires = now + ttl;
      })().finally(() => {
        cache.pending = null;
      });
    }
    await cache.pending;
  }
  const key = cache.keys.get(kid);
  if (!key) throw fail();
  return key;
}

function decodePart(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw fail();
  const bytes = Buffer.from(part, "base64url");
  if (bytes.toString("base64url") !== part) throw fail();
  return JSON.parse(bytes.toString("utf8"));
}

export async function exchangeGoogle(
  config,
  input,
  { fetch: fetcher = globalThis.fetch, now = Date.now } = {},
) {
  try {
    const redirect_uri = redirectUri(config);
    const { code, nonce, verifier } = input;
    if (
      typeof code !== "string" ||
      !code ||
      code.length > 8192 ||
      typeof nonce !== "string" ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(nonce) ||
      typeof verifier !== "string" ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)
    )
      throw fail();
    const { data } = await fetchJson(fetcher, TOKEN, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri,
        code_verifier: verifier,
      }).toString(),
    });
    if (typeof data.id_token !== "string" || data.id_token.length > 16384)
      throw fail();
    const parts = data.id_token.split(".");
    if (parts.length !== 3) throw fail();
    const header = decodePart(parts[0]);
    const claims = decodePart(parts[1]);
    if (
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      !header.kid ||
      header.kid.length > 256 ||
      header.crit
    )
      throw fail();
    if (!/^[A-Za-z0-9_-]+$/.test(parts[2])) throw fail();
    const keyTime = now();
    if (!Number.isFinite(keyTime)) throw fail();
    const key = await keyFor(header.kid, fetcher, keyTime);
    const current = now();
    if (!Number.isFinite(current)) throw fail();
    if (
      !verify(
        "RSA-SHA256",
        Buffer.from(`${parts[0]}.${parts[1]}`),
        key,
        Buffer.from(parts[2], "base64url"),
      )
    )
      throw fail();
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (
      !["accounts.google.com", "https://accounts.google.com"].includes(
        claims.iss,
      ) ||
      !audiences.length ||
      !audiences.every((a) => typeof a === "string") ||
      !audiences.includes(config.googleClientId) ||
      ((audiences.length > 1 || claims.azp !== undefined) &&
        claims.azp !== config.googleClientId) ||
      !Number.isSafeInteger(claims.exp) ||
      !Number.isSafeInteger(claims.iat) ||
      claims.exp <= current / 1000 ||
      claims.iat > current / 1000 + 60 ||
      claims.iat < 0 ||
      claims.exp <= claims.iat ||
      typeof claims.nonce !== "string" ||
      Buffer.byteLength(claims.nonce) !== Buffer.byteLength(nonce) ||
      !timingSafeEqual(Buffer.from(claims.nonce), Buffer.from(nonce)) ||
      claims.email_verified !== true ||
      typeof claims.sub !== "string" ||
      !claims.sub ||
      claims.sub.length > 255 ||
      /\s/.test(claims.sub) ||
      typeof claims.email !== "string" ||
      claims.email.length > 320 ||
      !/^[^\s@]+@[^\s@]+$/.test(claims.email)
    )
      throw fail();
    return {
      sub: claims.sub,
      email: claims.email,
      name: typeof claims.name === "string" ? claims.name.slice(0, 256) : "",
    };
  } catch {
    throw fail();
  } // Never surface provider response bodies, codes, credentials, or tokens.
}
