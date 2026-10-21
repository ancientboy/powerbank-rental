import { randomBytes, createHash, randomUUID } from "node:crypto";
import {
  verifyPassword,
  listRecords,
  putRecord,
  recordAudit,
  transaction,
} from "./production-store.mjs";
import { readiness } from "./production-config.mjs";
import {
  googleConfigured,
  beginGoogle,
  exchangeGoogle,
} from "./production-google.mjs";
const digest = (x) => createHash("sha256").update(x).digest("hex");
const random = () => randomBytes(32).toString("base64url");
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
const cookieNames = {
  admin: "voltgo_admin",
  user: "voltgo_user",
  oauth: "voltgo_oauth",
};
function cookies(request) {
  return Object.fromEntries(
    (request.headers.get("cookie") || "")
      .split(";")
      .map((x) => x.trim().split("="))
      .filter((x) => x.length === 2),
  );
}
function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}
const text = (value, max = 200) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
export function createProductionAPI({
  db,
  config,
  now = Date.now,
  google = { beginGoogle, exchangeGoogle },
}) {
  const cookie = (kind, token, seconds) =>
    `${cookieNames[kind]}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${config.secure ? "; Secure" : ""}`;
  function session(req, kind) {
    const token = cookies(req)[cookieNames[kind]];
    if (!token || !/^[\w-]{43}$/.test(token)) return null;
    const s = db
      .prepare(
        "SELECT * FROM sessions WHERE token_hash=? AND kind=? AND expires>?",
      )
      .get(digest(token), kind, now());
    if (!s) return null;
    const user = db
      .prepare(
        kind === "admin"
          ? "SELECT id,username,role FROM admins WHERE id=? AND disabled=0"
          : "SELECT id,email,name FROM users WHERE id=?",
      )
      .get(s.subject);
    return user ? { ...s, user } : null;
  }
  function requireSession(req, kind) {
    const s = session(req, kind);
    if (!s) fail(401, "Sign in required");
    return s;
  }
  function csrf(req, s) {
    if (
      req.headers.get("origin") !== config.publicOrigin ||
      req.headers.get("x-csrf-token") !== s.csrf
    )
      fail(403, "Request verification failed");
  }
  function rate(key, limit, windowMs) {
    const time = now();
    const r = db.prepare("SELECT * FROM rate_limits WHERE key=?").get(key);
    if (r && r.expires > time && r.attempts >= limit)
      fail(429, "Too many attempts. Please try again later.");
    db.prepare(
      "INSERT INTO rate_limits VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET attempts=excluded.attempts,expires=excluded.expires",
    ).run(
      key,
      r && r.expires > time ? r.attempts + 1 : 1,
      r && r.expires > time ? r.expires : time + windowMs,
    );
  }
  function newSession(req, kind, subject) {
    const old = cookies(req)[cookieNames[kind]];
    if (old)
      db.prepare("DELETE FROM sessions WHERE token_hash=? AND kind=?").run(
        digest(old),
        kind,
      );
    const token = random(),
      csrfToken = random(),
      seconds =
        kind === "admin" ? config.sessionSeconds : config.userSessionSeconds;
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(
      digest(token),
      kind,
      subject,
      csrfToken,
      now() + seconds * 1000,
    );
    return { csrf: csrfToken, header: cookie(kind, token, seconds) };
  }
  const pricing = () =>
    JSON.parse(
      db.prepare("SELECT data FROM settings WHERE key='pricing'").get()?.data ||
        "null",
    );
  return async function handle(req) {
    try {
      const u = new URL(req.url),
        path = u.pathname,
        method = req.method;
      if (u.origin !== config.publicOrigin)
        fail(400, "Invalid application origin");
      db.prepare("DELETE FROM sessions WHERE expires<=?").run(now());
      db.prepare("DELETE FROM oauth_states WHERE expires<=?").run(now());
      db.prepare("DELETE FROM rate_limits WHERE expires<=?").run(now());
      let body = {};
      if (!["GET", "HEAD"].includes(method)) {
        if (req.headers.get("origin") !== config.publicOrigin)
          fail(403, "Request verification failed");
        if (!req.headers.get("content-type")?.startsWith("application/json"))
          fail(415, "JSON required");
        const raw = await req.text();
        if (Buffer.byteLength(raw) > 16384) fail(413, "Request too large");
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          fail(400, "Invalid JSON");
        }
        if (!body || Array.isArray(body) || typeof body !== "object")
          fail(400, "Invalid request");
      }
      if (path === "/health" && method === "GET")
        return json({ status: "ok", mode: "production", schemaVersion: 1 });
      if (path === "/api/admin/login" && method === "POST") {
        const username = text(body.username, 100).toLowerCase();
        rate("admin-global", 60, 15 * 60000);
        rate("admin:" + digest(username), 5, 15 * 60000);
        const admin = db
          .prepare("SELECT * FROM admins WHERE username=? AND disabled=0")
          .get(username);
        const valid = await verifyPassword(
          body.password,
          admin?.password_hash ||
            "scrypt$32768$0000000000000000000000000000000000000000000000000000000000000000$" +
              "00".repeat(64),
        );
        const issued = transaction(db, () => {
          const current = admin
            ? db
                .prepare(
                  "SELECT password_hash,disabled,role FROM admins WHERE id=?",
                )
                .get(admin.id)
            : null;
          if (
            !admin ||
            !valid ||
            !current ||
            current.disabled ||
            current.password_hash !== admin.password_hash
          ) {
            recordAudit(db, "anonymous", "admin.login.failed", null, now());
            return null;
          }
          const issuedSession = newSession(req, "admin", admin.id);
          recordAudit(db, admin.id, "admin.login", null, now());
          return { session: issuedSession, role: current.role };
        });
        if (!issued) fail(401, "Invalid username or password");
        const s = issued.session;
        return json(
          {
            user: { id: admin.id, username: admin.username, role: issued.role },
            csrf: s.csrf,
          },
          200,
          { "Set-Cookie": s.header },
        );
      }
      if (path.startsWith("/api/admin/")) {
        const s = requireSession(req, "admin");
        if (method !== "GET") csrf(req, s);
        if (path === "/api/admin/session" && method === "GET")
          return json({ user: s.user, csrf: s.csrf });
        if (path === "/api/admin/logout" && method === "POST") {
          db.prepare("DELETE FROM sessions WHERE token_hash=?").run(
            s.token_hash,
          );
          recordAudit(db, s.subject, "admin.logout", null, now());
          return json({ ok: true }, 200, {
            "Set-Cookie": cookie("admin", "", 0),
          });
        }
        if (path === "/api/admin/dashboard" && method === "GET")
          return json({
            stations: listRecords(db, "station"),
            users: db
              .prepare(
                "SELECT id,email,name,created_at FROM users ORDER BY created_at DESC LIMIT 1000",
              )
              .all(),
            rentals: listRecords(db, "rental"),
            payments: listRecords(db, "payment"),
            support: listRecords(db, "support"),
            audit: db
              .prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 200")
              .all(),
            pricing: pricing(),
            readiness: readiness(config),
          });
        if (
          method === "POST" &&
          [
            "/api/admin/stations",
            "/api/admin/pricing",
            "/api/admin/support",
          ].includes(path)
        ) {
          if (
            s.user.role === "viewer" ||
            (s.user.role !== "owner" && path !== "/api/admin/support")
          )
            fail(403, "Your role cannot perform this action");
          rate("write:" + s.subject, 120, 60000);
          if (path.endsWith("/stations")) {
            const id = body.id ? text(body.id, 80) : randomUUID();
            if (
              body.id &&
              !db
                .prepare("SELECT id FROM records WHERE kind='station' AND id=?")
                .get(id)
            )
              fail(404, "Station not found");
            const station = {
              id,
              name: text(body.name),
              address: text(body.address, 500),
              cabinetId: text(body.cabinetId, 80),
              latitude:
                body.latitude === "" || body.latitude == null
                  ? null
                  : Number(body.latitude),
              longitude:
                body.longitude === "" || body.longitude == null
                  ? null
                  : Number(body.longitude),
              active: body.active === true,
              updatedAt: new Date(now()).toISOString(),
            };
            if (
              !station.name ||
              !station.address ||
              (station.latitude !== null &&
                (!Number.isFinite(station.latitude) ||
                  Math.abs(station.latitude) > 90)) ||
              (station.longitude !== null &&
                (!Number.isFinite(station.longitude) ||
                  Math.abs(station.longitude) > 180))
            )
              fail(400, "Provide a name, address and valid coordinates");
            if (
              station.cabinetId &&
              listRecords(db, "station").some(
                (x) => x.id !== id && x.cabinetId === station.cabinetId,
              )
            )
              fail(409, "Cabinet already assigned");
            transaction(db, () => {
              putRecord(db, "station", id, station);
              recordAudit(db, s.subject, "station.save", id, now());
            });
            return json({ station });
          }
          if (path.endsWith("/pricing")) {
            const p = {
              currency: "ARS",
              hourlyRate: Number(body.hourlyRate),
              dailyCap: Number(body.dailyCap),
              deposit: Number(body.deposit),
              version: randomUUID(),
              updatedAt: new Date(now()).toISOString(),
            };
            if (
              body.currency !== "ARS" ||
              ![p.hourlyRate, p.dailyCap, p.deposit].every(
                (x) => Number.isSafeInteger(x) && x > 0 && x <= 100000000,
              ) ||
              p.dailyCap < p.hourlyRate
            )
              fail(
                400,
                "Prices must be positive integer minor units; daily cap must cover one hour",
              );
            transaction(db, () => {
              db.prepare(
                "INSERT INTO settings VALUES('pricing',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
              ).run(JSON.stringify(p));
              recordAudit(db, s.subject, "pricing.update", p.version, now());
            });
            return json({ pricing: p });
          }
          const id = text(body.id, 80),
            ticket = listRecords(db, "support").find((x) => x.id === id);
          if (!ticket) fail(404, "Support case not found");
          if (!["open", "in_progress", "resolved"].includes(body.status))
            fail(400, "Invalid support status");
          ticket.status = body.status;
          ticket.reply = text(body.reply, 4000);
          ticket.updatedAt = new Date(now()).toISOString();
          transaction(db, () => {
            putRecord(db, "support", id, ticket, ticket.userId);
            recordAudit(db, s.subject, "support.update", id, now());
          });
          return json({ support: ticket });
        }
        fail(404, "Not found");
      }
      if (path === "/auth/google" && method === "GET") {
        if (!googleConfigured(config))
          return new Response(null, {
            status: 303,
            headers: {
              Location: "/auth/error?code=google_not_configured",
              "Cache-Control": "no-store",
            },
          });
        rate("oauth-start", 100, 60000);
        const flow = await google.beginGoogle(config),
          binding = random();
        db.prepare("INSERT INTO oauth_states VALUES(?,?,?,?,?)").run(
          digest(flow.state),
          digest(binding),
          flow.nonce,
          flow.verifier,
          now() + 600000,
        );
        return new Response(null, {
          status: 303,
          headers: {
            Location: flow.url,
            "Set-Cookie": cookie("oauth", binding, 600),
            "Cache-Control": "no-store",
          },
        });
      }
      if (path === "/auth/google/callback" && method === "GET") {
        const state = u.searchParams.get("state") || "",
          binding = cookies(req).voltgo_oauth || "";
        const flow = db
          .prepare(
            "DELETE FROM oauth_states WHERE state_hash=? AND binding_hash=? AND expires>? RETURNING *",
          )
          .get(digest(state), digest(binding), now());
        if (
          !flow ||
          !state ||
          !binding ||
          !u.searchParams.get("code") ||
          u.searchParams.has("error")
        )
          return new Response(null, {
            status: 303,
            headers: {
              Location: "/auth/error?code=google_failed",
              "Set-Cookie": cookie("oauth", "", 0),
              "Cache-Control": "no-store",
            },
          });
        try {
          const identity = await google.exchangeGoogle(config, {
            code: u.searchParams.get("code"),
            nonce: flow.nonce,
            verifier: flow.verifier,
          });
          let user = db
            .prepare("SELECT * FROM users WHERE google_sub=?")
            .get(identity.sub);
          if (!user) {
            user = { id: randomUUID() };
            db.prepare("INSERT INTO users VALUES(?,?,?,?,?)").run(
              user.id,
              identity.sub,
              identity.email,
              identity.name,
              new Date(now()).toISOString(),
            );
          } else
            db.prepare("UPDATE users SET email=?,name=? WHERE id=?").run(
              identity.email,
              identity.name,
              user.id,
            );
          const s = newSession(req, "user", user.id),
            headers = new Headers({
              Location: "/",
              "Cache-Control": "no-store",
            });
          headers.append("Set-Cookie", s.header);
          headers.append("Set-Cookie", cookie("oauth", "", 0));
          return new Response(null, { status: 303, headers });
        } catch {
          return new Response(null, {
            status: 303,
            headers: {
              Location: "/auth/error?code=google_failed",
              "Set-Cookie": cookie("oauth", "", 0),
              "Cache-Control": "no-store",
            },
          });
        }
      }
      if (path === "/api/user/session" && method === "GET") {
        const s = session(req, "user");
        return json({
          user: s?.user || null,
          csrf: s?.csrf,
          readiness: readiness(config),
        });
      }
      if (path === "/api/user/stations" && method === "GET")
        return json({
          stations: listRecords(db, "station").filter((x) => x.active),
          pricing: pricing(),
        });
      if (path.startsWith("/api/user/")) {
        const s = requireSession(req, "user");
        if (method !== "GET") csrf(req, s);
        if (path === "/api/user/logout" && method === "POST") {
          db.prepare("DELETE FROM sessions WHERE token_hash=?").run(
            s.token_hash,
          );
          return json({ ok: true }, 200, {
            "Set-Cookie": cookie("user", "", 0),
          });
        }
        if (path === "/api/user/rentals" && method === "GET")
          return json({ rentals: listRecords(db, "rental", s.subject) });
        if (path === "/api/user/support" && method === "GET")
          return json({ support: listRecords(db, "support", s.subject) });
        if (path === "/api/user/support" && method === "POST") {
          rate("support:" + s.subject, 10, 3600000);
          const message = text(body.message, 4000);
          if (message.length < 5)
            fail(400, "Please describe the issue in at least five characters");
          const ticket = {
            id: randomUUID(),
            userId: s.subject,
            message,
            status: "open",
            reply: "",
            createdAt: new Date(now()).toISOString(),
          };
          putRecord(db, "support", ticket.id, ticket, s.subject);
          return json({ support: ticket }, 201);
        }
        if (
          ["/api/user/rent", "/api/user/pay", "/api/user/return"].includes(path)
        )
          fail(503, "Payments and physical device integration are not enabled");
        fail(404, "Not found");
      }
      fail(404, "Not found");
    } catch (error) {
      return json(
        { error: error.status ? error.message : "Unable to process request" },
        error.status || 500,
      );
    }
  };
}
