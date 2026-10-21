import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductionAPI } from "../src/production-api.mjs";
import {
  openProductionStore,
  hashPassword,
  putRecord,
} from "../src/production-store.mjs";
import { loadConfig, readiness } from "../src/production-config.mjs";
const config = {
  publicOrigin: "https://rental.example",
  secure: true,
  sessionSeconds: 3600,
  userSessionSeconds: 3600,
};
function setup() {
  const db = openProductionStore(":memory:");
  let time = Date.now();
  const api = createProductionAPI({ db, config, now: () => time });
  const request = (path, body, cookie, csrf, origin = config.publicOrigin) =>
    api(
      new Request(config.publicOrigin + path, {
        method: body ? "POST" : "GET",
        headers: {
          ...(body ? { "content-type": "application/json", origin } : {}),
          ...(cookie ? { cookie } : {}),
          ...(csrf ? { "x-csrf-token": csrf } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  return { db, request, advance: () => (time += 4000000) };
}
const digest = (x) => createHash("sha256").update(x).digest("hex");
async function admin(s, role = "owner") {
  s.db
    .prepare("INSERT INTO admins VALUES(?,?,?,?,0)")
    .run("a", "owner", await hashPassword("test-only-long-password"), role);
  const r = await s.request("/api/admin/login", {
    username: "owner",
    password: "test-only-long-password",
  });
  assert.equal(r.status, 200);
  return {
    cookie: r.headers.get("set-cookie").split(";")[0],
    ...(await r.json()),
  };
}
function user(s, id) {
  s.db
    .prepare("INSERT INTO users VALUES(?,?,?,?,?)")
    .run(id, id, id + "@example.test", id, "2026-01-01");
  const token = randomBytes(32).toString("base64url"),
    csrf = randomBytes(32).toString("base64url");
  s.db
    .prepare("INSERT INTO sessions VALUES(?,?,?,?,?)")
    .run(digest(token), "user", id, csrf, Date.now() + 3600000);
  return { cookie: "voltgo_user=" + token, csrf };
}
test("production config fails closed except explicit loopback; raw IP Google remains unavailable", () => {
  assert.throws(() => loadConfig({}));
  assert.throws(() => loadConfig({ PUBLIC_ORIGIN: "http://203.0.113.1" }));
  assert.throws(() =>
    loadConfig({ PUBLIC_ORIGIN: "https://example.test/path" }),
  );
  assert.equal(
    loadConfig({
      PUBLIC_ORIGIN: "http://127.0.0.1:4173",
      ALLOW_LOCAL_HTTP: "1",
    }).secure,
    false,
  );
  assert.equal(
    readiness({
      ...config,
      publicOrigin: "https://203.0.113.1",
      googleClientId: "id",
      googleClientSecret: "secret",
    }).google.ready,
    false,
  );
});
test("legacy bypass, sessions and unknown admin endpoints never grant access", async () => {
  const s = setup();
  for (const p of [
    "/api/admin/dashboard",
    "/api/admin/stations",
    "/api/admin/anything",
  ])
    assert.equal((await s.request(p)).status, 401);
  assert.equal(
    (await s.request("/v1/actions", { action: "admin_login" })).status,
    404,
  );
  assert.equal(
    (await s.request("/api/admin/login", { action: "admin_login" })).status,
    401,
  );
  const u = user(s, "u");
  assert.equal(
    (await s.request("/api/admin/dashboard", null, u.cookie)).status,
    401,
  );
  s.db.close();
});
test("admin cookies are secure, separate; login rotates; CSRF, roles, logout, expiry", async () => {
  const s = setup();
  const a = await admin(s);
  assert.equal(
    (await s.request("/api/user/session", null, a.cookie)).status,
    200,
  );
  assert.equal(
    (await (await s.request("/api/user/session", null, a.cookie)).json()).user,
    null,
  );
  assert.equal(
    (
      await s.request(
        "/api/admin/pricing",
        { currency: "ARS", hourlyRate: 500, dailyCap: 3000, deposit: 10000 },
        a.cookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await s.request(
        "/api/admin/pricing",
        { currency: "ARS", hourlyRate: 500, dailyCap: 3000, deposit: 10000 },
        a.cookie,
        a.csrf,
        "https://evil.test",
      )
    ).status,
    403,
  );
  const r = await s.request(
    "/api/admin/login",
    { username: "owner", password: "test-only-long-password" },
    a.cookie,
  );
  assert.match(
    r.headers.get("set-cookie"),
    /HttpOnly; SameSite=Lax; Max-Age=3600; Secure/,
  );
  assert.equal(
    (await s.request("/api/admin/session", null, a.cookie)).status,
    401,
  );
  const b = {
    cookie: r.headers.get("set-cookie").split(";")[0],
    ...(await r.json()),
  };
  assert.equal(
    (await s.request("/api/admin/logout", {}, b.cookie, b.csrf)).status,
    200,
  );
  assert.equal(
    (await s.request("/api/admin/session", null, b.cookie)).status,
    401,
  );
  const c = await s.request("/api/admin/login", {
    username: "owner",
    password: "test-only-long-password",
  });
  s.advance();
  assert.equal(
    (
      await s.request(
        "/api/admin/session",
        null,
        c.headers.get("set-cookie").split(";")[0],
      )
    ).status,
    401,
  );
  s.db.close();
});
test("formal state starts empty, station/pricing persists, audit contains no passwords", async () => {
  const s = setup(),
    a = await admin(s);
  let data = await (
    await s.request("/api/admin/dashboard", null, a.cookie)
  ).json();
  assert.deepEqual(data.stations, []);
  assert.equal(data.pricing, null);
  let r = await s.request(
    "/api/admin/stations",
    { name: "Real site", address: "A street", cabinetId: "CAB1", active: true },
    a.cookie,
    a.csrf,
  );
  assert.equal(r.status, 200);
  assert.equal(
    (
      await s.request(
        "/api/admin/pricing",
        { currency: "ARS", hourlyRate: 500, dailyCap: 3000, deposit: 10000 },
        a.cookie,
        a.csrf,
      )
    ).status,
    200,
  );
  data = await (await s.request("/api/admin/dashboard", null, a.cookie)).json();
  assert.equal(data.stations.length, 1);
  assert.equal(data.pricing.hourlyRate, 500);
  assert.ok(!JSON.stringify(data).includes("test-only-long-password"));
  assert.equal((await s.request("/api/user/stations")).status, 200);
  s.db.close();
});
test("viewer cannot mutate; customer ownership filters every collection and integration stays disabled", async () => {
  const s = setup(),
    a = await admin(s, "viewer"),
    u = user(s, "u"),
    v = user(s, "v");
  assert.equal(
    (await s.request("/api/admin/stations", { name: "x" }, a.cookie, a.csrf))
      .status,
    403,
  );
  putRecord(s.db, "rental", "r", { id: "r" }, "v");
  assert.deepEqual(
    (await (await s.request("/api/user/rentals", null, u.cookie)).json())
      .rentals,
    [],
  );
  await s.request(
    "/api/user/support",
    { message: "Please help me" },
    v.cookie,
    v.csrf,
  );
  assert.deepEqual(
    (await (await s.request("/api/user/support", null, u.cookie)).json())
      .support,
    [],
  );
  assert.equal(
    (await s.request("/api/user/rent", {}, u.cookie, u.csrf)).status,
    503,
  );
  s.db.close();
});
test("rate limits persist and Google missing config never signs in", async () => {
  const s = setup();
  for (let i = 0; i < 5; i++)
    assert.equal(
      (
        await s.request("/api/admin/login", {
          username: "bad",
          password: "bad",
        })
      ).status,
      401,
    );
  assert.equal(
    (await s.request("/api/admin/login", { username: "bad", password: "bad" }))
      .status,
    429,
  );
  const r = await s.request("/auth/google");
  assert.equal(r.status, 303);
  assert.match(r.headers.get("location"), /google_not_configured/);
  assert.equal(s.db.prepare("SELECT count(*) n FROM users").get().n, 0);
  s.db.close();
});
test("SQLite formal schema migration is idempotent and survives reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "voltgo-"));
  try {
    const path = join(dir, "formal.sqlite");
    let db = openProductionStore(path);
    putRecord(db, "station", "s", { id: "s", name: "persisted" });
    db.close();
    db = openProductionStore(path);
    assert.equal(
      db.prepare("SELECT count(*) n FROM schema_migrations").get().n,
      3,
    );
    assert.match(
      db.prepare("SELECT data FROM records").get().data,
      /persisted/,
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
