import { cabinetQrResponse, validCabinetId } from './production-cabinet-qr.mjs';
import {saveCabinetControl,cabinetControl} from './production-cabinet-control.mjs';
import {hardwarePricing,hardwareOrders,customerHardwareRental,hardwareState,hardwareAdmin,authorizeHardware,handleHardware,reconcileManualCommand,maintainHardware,resolveHardwareOrder} from './production-hardware-rental.mjs';
import { WSCHARGE_NOTIFY_PATH, receiveWscharge, wschargeView, sendWschargeCommand, wschargeCabinets, customerStations } from './production-wscharge.mjs';
import { integrationView, applyIntegrationScenario, resolveIntegrationException, reconcileIntegrationRun, retryIntegrationRefund } from './production-integrations.mjs';
import { supportView, auditView, pricingHistory, operationQueue, orderResponse } from './production-operations.mjs';
import { handleTestRental, testRentals, testPayments, testStations, estimateTestRental } from './production-test-rental.mjs';
import { randomBytes, createHash, randomUUID } from "node:crypto";
import {
  verifyPassword,
  listRecords,
  putRecord,
  recordAudit,
  transaction,
} from "./production-store.mjs";
import { readiness, googleTestEnabled } from "./production-config.mjs";
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
  testBrowser: "voltgo_test_browser",
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
  wschargeFetch = fetch,
  google = { beginGoogle, exchangeGoogle },
}) {
  if (!googleTestEnabled(config)) {
    db.prepare("DELETE FROM sessions WHERE kind='user' AND subject IN (SELECT id FROM test_users)").run();
    db.prepare("DELETE FROM test_login_states").run();
  }
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
    let user = db
      .prepare(
        kind === "admin"
          ? "SELECT id,username,role FROM admins WHERE id=? AND disabled=0"
          : "SELECT id,email,name FROM users WHERE id=?",
      )
      .get(s.subject);
    if (kind === "user") {
      if (user) user = { ...user, provider: "google", isTest: false };
      else if (googleTestEnabled(config)) {
        const testUser = db.prepare("SELECT id,name FROM test_users WHERE id=?").get(s.subject);
        if (testUser) user = { ...testUser, email: null, provider: "google_test", isTest: true,
          capabilities: { payments: false, hardware: false } };
      }
    }
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
      // Provider ingress uses its own authentication, never browser session/CSRF.
      // This exact route is the only exception to the browser Origin requirement.
      if (path === WSCHARGE_NOTIFY_PATH) return json(await receiveWscharge(db, config, req, now()));
      db.prepare("DELETE FROM sessions WHERE expires<=?").run(now());
      db.prepare("DELETE FROM test_login_states WHERE expires<=?").run(now());
      if (!googleTestEnabled(config)) {
        db.prepare("DELETE FROM sessions WHERE kind='user' AND subject IN (SELECT id FROM test_users)").run();
        db.prepare("DELETE FROM test_login_states").run();
      }
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
        return json({ status: "ok", mode: "production", schemaVersion: 4 });
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
        if (path === '/api/admin/cabinet-qr' && method === 'GET') return cabinetQrResponse(db, config, u.searchParams);
        maintainHardware(db,now());
        if(path==='/api/admin/hardware/control'&&method==='POST'){rate('write:'+s.subject,120,60000);return json(saveCabinetControl(db,config,s.user,body,now()));}
        if(path==='/api/admin/hardware/resolve'&&method==='POST'){rate('write:'+s.subject,120,60000);return json(resolveHardwareOrder(db,s.user,body,now(),wschargeCabinets(db,config,now())));}
        if(path==='/api/admin/hardware/refresh'&&method==='POST'){if(!['owner','operator'].includes(s.user.role))fail(403,'Your role cannot perform this action');rate('hardware-refresh:'+s.subject,12,60000);return json(await sendWschargeCommand({db,config,actor:{id:s.subject,role:'owner'},body:{code:64,cabinetId:body.cabinetId},idempotencyKey:'review-'+randomUUID(),time:now(),fetchImpl:wschargeFetch}));}
        if(path==='/api/admin/hardware-test'&&method==='GET')return json(hardwareAdmin(db,config,now()));
        if(path==='/api/admin/hardware-test/authorize'&&method==='POST')return json(authorizeHardware(db,s.user,body,now()));
        if(path==='/api/admin/hardware-test/reconcile'&&method==='POST')return json(reconcileManualCommand(db,s.user,body.commandId,now()));
        if (path === '/api/admin/wscharge' && method === 'GET') return json(wschargeView(db, config, now()));
        if (path === '/api/admin/wscharge/commands' && method === 'POST') {
          if (s.user.role !== 'owner') fail(403, 'Owner role required');
          rate('wscharge:' + s.subject, 30, 60000);
          return json(await sendWschargeCommand({ db, config, actor: s.user, body, idempotencyKey: req.headers.get('idempotency-key'), time: now(), fetchImpl: wschargeFetch }));
        }
        if(path==='/api/admin/notifications'&&method==='GET'){
          const pending=listRecords(db,'support').filter(t=>['open','in_progress'].includes(t.status));
          const queue=operationQueue(db).filter(i=>i.type==='hardware_review');
          return json({openSupport:pending.length,newCustomerMessages:pending.filter(t=>t.status==='open').length,hardwareReview:queue.length,version:pending.map(t=>t.id+':'+(t.updatedAt||t.createdAt)).sort().join('|')+';'+queue.map(i=>i.id+':'+i.reason).sort().join('|')});
        }
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
        if (method === 'POST' && /^\/api\/admin\/integrations\/runs\/[^/]+\/retry-refund$/.test(path)) {
          if (!['owner','operator'].includes(s.user.role)) fail(403, 'Your role cannot perform this action');
          if (Object.keys(body).length) fail(400, 'No refund retry body fields are accepted');
          rate('write:' + s.subject, 120, 60000);
          return json(await retryIntegrationRefund(db, { runId: decodeURIComponent(path.split('/')[5]), idempotencyKey: req.headers.get('idempotency-key'), actor: { id: s.subject, role: s.user.role }, now: now() }));
        }
        if (method === 'POST' && /^\/api\/admin\/integrations\/runs\/[^/]+\/reconcile$/.test(path)) {
          if (!['owner','operator'].includes(s.user.role)) fail(403, 'Your role cannot perform this action');
          if (Object.keys(body).length) fail(400, 'No reconciliation body fields are accepted');
          rate('write:' + s.subject, 120, 60000);
          return json(await reconcileIntegrationRun(db, { runId: decodeURIComponent(path.split('/')[5]), idempotencyKey: req.headers.get('idempotency-key'), actor: { id: s.subject, role: s.user.role }, now: now() }));
        }
        if (path === '/api/admin/integrations' && method === 'GET') return json(integrationView(db, now()));
        if (method === 'POST' && (path === '/api/admin/integrations/scenarios' || /^\/api\/admin\/integrations\/exceptions\/[^/]+\/resolve$/.test(path))) {
          if (!['owner','operator'].includes(s.user.role)) fail(403, 'Your role cannot perform this action');
          rate('write:' + s.subject, 120, 60000);
          const actor = { id: s.subject, role: s.user.role };
          if (path.endsWith('/scenarios')) {
            if (Object.keys(body).some(k => k !== 'scenario')) fail(400, 'Only a scenario may be provided');
            return json(applyIntegrationScenario(db, { scenario: body.scenario, idempotencyKey: req.headers.get('idempotency-key'), actor, now: now() }));
          }
          if (Object.keys(body).some(k => k !== 'note')) fail(400, 'Only a resolution note may be provided');
          return json(resolveIntegrationException(db, { exceptionId: decodeURIComponent(path.split('/')[5]), note: body.note, actor, now: now() }));
        }
        if (path === "/api/admin/orders" && method === "GET") return json(orderResponse(db, u, now()));
        if (path.startsWith("/api/admin/orders/") && method === "GET") return json(orderResponse(db, u, now(), decodeURIComponent(path.slice("/api/admin/orders/".length))));
        if (path === "/api/admin/dashboard" && method === "GET")
          return json({
            counts: {
              liveUsers: Number(db.prepare('SELECT count(*) AS n FROM users').get().n),
              testUsers: Number(db.prepare('SELECT count(*) AS n FROM test_users').get().n),
            },
            stations: listRecords(db, "station"),
            deviceCabinets: wschargeCabinets(db, config, now()).map(c=>({...c,control:cabinetControl(db,c.cabinetId)})),
            users: db
              .prepare(
                "SELECT id,email,name,created_at,'google' AS provider,0 AS isTest FROM users UNION ALL SELECT id,NULL AS email,name,created_at,'google_test' AS provider,1 AS isTest FROM test_users ORDER BY created_at DESC",
              )
              .all(),
            serverNow: new Date(now()).toISOString(),
            testRentals: testRentals(db).map(r => estimateTestRental(r, now())),
            testPayments: testPayments(db),
            testStations: googleTestEnabled(config) ? testStations : [],
            rentals: listRecords(db, "rental"),
            payments: listRecords(db, "payment"),
            support: listRecords(db, "support").map(supportView).sort((a,b)=>String(b.updatedAt||b.createdAt).localeCompare(String(a.updatedAt||a.createdAt))),
            hardwareRentals:hardwareOrders(db).map(r=>estimateTestRental(r,now())),
            workQueue: operationQueue(db),
            pricingHistory: pricingHistory(db, pricing()),
            audit: auditView(db),
            hardwarePricing:hardwarePricing(db),
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
            const existingRow = db.prepare("SELECT data FROM records WHERE kind='station' AND id=?").get(id);
            const existing = existingRow ? JSON.parse(existingRow.data) : null;
            if (body.id && !existing) fail(404, "Station not found");
            if (Object.hasOwn(body, "expectedUpdatedAt") && body.expectedUpdatedAt !== (existing?.updatedAt || null))
              fail(409, "Station changed. Reload before saving your edits.");
            for (const [field, limit] of [["name", 200], ["address", 500], ["cabinetId", 80], ["locationNotes", 500], ["openingHours", 300], ["returnInstructions", 500]]) {
              if (typeof body[field] === "string" && body[field].trim().length > limit)
                fail(400, `${field} must be at most ${limit} characters`);
            }
            for (const coordinate of [body.latitude, body.longitude]) {
              if (coordinate != null && typeof coordinate !== "string" && typeof coordinate !== "number")
                fail(400, "Provide valid numeric coordinates");
            }
            const station = {
              id,
              name: text(body.name),
              address: text(body.address, 500),
              locationNotes: Object.hasOwn(body, "locationNotes") ? text(body.locationNotes, 500) : (existing?.locationNotes || ""),
              openingHours: Object.hasOwn(body,"openingHours") ? text(body.openingHours,300) : (existing?.openingHours || ""),
              returnInstructions: Object.hasOwn(body,"returnInstructions") ? text(body.returnInstructions,500) : (existing?.returnInstructions || ""),
              capacity: Object.hasOwn(body,"capacity") ? body.capacity : (existing?.capacity ?? null),
              cabinetId: text(body.cabinetId, 80),
              latitude:
                (typeof body.latitude === "string" && !body.latitude.trim()) || body.latitude == null
                  ? null
                  : Number(body.latitude),
              longitude:
                (typeof body.longitude === "string" && !body.longitude.trim()) || body.longitude == null
                  ? null
                  : Number(body.longitude),
              active: body.active === true,
              updatedAt: new Date(Math.max(now(), (Date.parse(existing?.updatedAt) || 0) + 1)).toISOString(),
            };
            if (station.cabinetId && station.cabinetId !== existing?.cabinetId && !validCabinetId(station.cabinetId)) fail(400, "Cabinet ID must use 1–64 letters, numbers, underscores or hyphens.");
            if (station.capacity !== null && (!Number.isInteger(station.capacity) || station.capacity < 1 || station.capacity > 128)) fail(400,"Total slots must be an integer from 1 to 128, or blank");
            if (
              !station.name ||
              !station.address ||
              ((station.latitude === null) !== (station.longitude === null)) ||
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
              recordAudit(db, s.subject, "station.save", id, now(), { before: existing, after: station });
            });
            return json({ station });
          }
          if (path.endsWith("/pricing")) {
            if (Object.hasOwn(body, "expectedVersion") && body.expectedVersion !== (pricing()?.version || null))
              fail(409, "Pricing changed. Reload before saving your edits.");
            const p = {
              currency: "ARS",
              hourlyRate: Number(body.hourlyRate),
              dailyCap: Number(body.dailyCap),
              deposit: Number(body.deposit),
              totalCap: Number(body.totalCap??body.deposit),
              maxRentalDays: Number(body.maxRentalDays??0),
              policyVersion: 1,
              version: randomUUID(),
              updatedAt: new Date(Math.max(now(), (Date.parse(pricing()?.updatedAt) || 0) + 1)).toISOString(),
            };
            if (
              body.currency !== "ARS" ||
              ![p.hourlyRate, p.dailyCap, p.deposit, p.totalCap].every(
                (x) => Number.isSafeInteger(x) && x > 0 && x <= 100000000,
              ) ||
              p.dailyCap < p.hourlyRate || p.totalCap > p.deposit || p.totalCap < p.hourlyRate ||
              !Number.isInteger(p.maxRentalDays) || p.maxRentalDays < 0 || p.maxRentalDays > 365
            )
              fail(
                400,
                "Prices must be positive integer minor units; caps must cover one hour; total cap must not exceed deposit; maximum days must be 0–365",
              );
            const before = pricing();
            transaction(db, () => {
              if (before?.version) putRecord(db, "pricing_history", before.version, before);
              putRecord(db, "pricing_history", p.version, p);
              db.prepare(
                "INSERT INTO settings VALUES('pricing',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
              ).run(JSON.stringify(p));
              recordAudit(db, s.subject, "pricing.update", p.version, now(), { before, after: p });
            });
            return json({ pricing: p });
          }
          const id = text(body.id, 80),
            ticket = listRecords(db, "support").find((x) => x.id === id);
          if (!ticket) fail(404, "Support case not found");
          if (Object.hasOwn(body, "expectedUpdatedAt") && body.expectedUpdatedAt !== (ticket.updatedAt || null))
            fail(409, "Support case changed. Reload before saving your edits.");
          if (!["open", "in_progress", "resolved", "closed"].includes(body.status))
            fail(400, "Invalid support status");
          if (typeof body.reply === "string" && body.reply.trim().length > 4000)
            fail(400, "Support reply must be at most 4000 characters");
          const reply = text(body.reply, 4000);
          if (body.status === "resolved" && !reply && !ticket.reply && !supportView(ticket).replies.some(r => r.actorRole !== "customer" && r.reply)) fail(400, "Provide a reply before resolving the support case");
          const before = { ...ticket };
          ticket.replies = supportView(ticket).replies;
          ticket.status = body.status;
          if (reply) ticket.reply = reply;
          ticket.updatedAt = new Date(Math.max(now(), (Date.parse(ticket.updatedAt) || 0) + 1)).toISOString();
          if (reply) ticket.replies.push({ id: randomUUID(), reply, createdAt: ticket.updatedAt, actorId: s.subject, actorRole: s.user.role });
          transaction(db, () => {
            putRecord(db, "support", id, ticket, ticket.userId);
            recordAudit(db, s.subject, "support.update", id, now(), { before, after: ticket });
          });
          return json({ support: ticket });
        }
        fail(404, "Not found");
      }
      if (path === "/api/user/test-login-challenge" && method === "GET") {
        if (!googleTestEnabled(config)) fail(404, "Test sign-in is disabled");
        if ((req.headers.has("origin") && req.headers.get("origin") !== config.publicOrigin) ||
            req.headers.get("sec-fetch-site") === "cross-site") fail(403, "Request verification failed");
        rate("test-challenge-global", 100, 60000);
        let token = cookies(req).voltgo_test_browser;
        let binding = token && /^[\w-]{43}$/.test(token)
          ? db.prepare("SELECT * FROM test_login_states WHERE browser_hash=? AND expires>?").get(digest(token), now()) : null;
        const seconds = 30 * 86400;
        if (!binding) {
          token = random();
          binding = { csrf: random() };
          db.prepare("INSERT INTO test_login_states VALUES(?,?,?,NULL)").run(digest(token), binding.csrf, now() + seconds * 1000);
        }
        return json({ csrf: binding.csrf, testOnly: true }, 200, {
          "Set-Cookie": cookie("testBrowser", token, seconds),
        });
      }
      if (path === "/api/user/test-login" && method === "POST") {
        if (!googleTestEnabled(config)) fail(404, "Test sign-in is disabled");
        rate("test-login-global", 60, 15 * 60000);
        if (Object.keys(body).length) fail(400, "Test sign-in does not accept identity or role fields");
        const token = cookies(req).voltgo_test_browser;
        const binding = token && /^[\w-]{43}$/.test(token)
          ? db.prepare("SELECT * FROM test_login_states WHERE browser_hash=? AND expires>?").get(digest(token), now()) : null;
        if (!binding) fail(403, "Request a new test sign-in challenge");
        csrf(req, binding);
        rate("test-login:" + digest(token), 10, 15 * 60000);
        const issued = transaction(db, () => {
          let id = binding.user_id;
          if (!id) {
            id = "test_" + randomUUID();
            db.prepare("INSERT INTO test_users VALUES(?,?,?)").run(id, "Test customer", new Date(now()).toISOString());
            db.prepare("UPDATE test_login_states SET user_id=? WHERE browser_hash=?").run(id, digest(token));
          }
          const issuedSession = newSession(req, "user", id);
          recordAudit(db, id, "user.test_login", null, now());
          return issuedSession;
        });
        return json({ ok: true, testOnly: true, csrf: issued.csrf }, 200, { "Set-Cookie": issued.header });
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
        const cabinet = u.searchParams.get("cabinet") || "";
        transaction(db, () => {
          db.prepare("INSERT INTO oauth_states VALUES(?,?,?,?,?)").run(
            digest(flow.state), digest(binding), flow.nonce, flow.verifier, now() + 600000,
          );
          if (/^[A-Za-z0-9_-]{1,64}$/.test(cabinet))
            db.prepare("INSERT INTO oauth_return_paths VALUES(?,?)").run(
              digest(flow.state), "/rent?cabinet=" + encodeURIComponent(cabinet),
            );
        });
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
        let returnPath = "/";
        const flow = transaction(db, () => {
          const destination = db.prepare("SELECT path FROM oauth_return_paths WHERE state_hash=?").get(digest(state));
          const consumed = db.prepare(
            "DELETE FROM oauth_states WHERE state_hash=? AND binding_hash=? AND expires>? RETURNING *",
          ).get(digest(state), digest(binding), now());
          if (consumed && /^\/rent\?cabinet=[A-Za-z0-9_-]{1,64}$/.test(destination?.path || ""))
            returnPath = destination.path;
          return consumed;
        });
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
              Location: returnPath,
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
      if (path === '/api/user/station-qr' && method === 'GET') {
        const id = u.searchParams.get('cabinet');
        if (!validCabinetId(id)) fail(400, 'Invalid cabinet ID');
        // Only cabinets already visible in the customer listing may be shared.
        const station = customerStations(db, config, now()).find(row => row.cabinetId === id);
        if (!station) fail(404, 'Station not available');
        const format = u.searchParams.get('format') || 'json';
        if (!['json', 'png'].includes(format)) fail(400, 'Choose PNG');
        if (format === 'png') return cabinetQrResponse(db, config, u.searchParams);
        const url = new URL('/rent', config.publicOrigin); url.searchParams.set('cabinet', id);
        return json({ cabinetId: id, stationName: station.name, url: url.href });
      }
      if (path === "/api/user/stations" && method === "GET")
        return json({
          stations: customerStations(db, config, now()),
          serverNow: new Date(now()).toISOString(),
          pricing: hardwarePricing(db),
        });
      if (path.startsWith("/api/user/")) {
        const s = requireSession(req, "user");
        if (method !== "GET") csrf(req, s);
        if(path.startsWith('/api/user/hardware/')){
          maintainHardware(db,now());
          const cabinets=wschargeCabinets(db,config,now());
          if(path==='/api/user/hardware/state'&&method==='GET')return json(hardwareState(db,config,s.subject,now(),cabinets));
          if(method!=='POST')fail(404,'Not found');
          rate('hardware:'+s.subject,12,60000);
          const result=await handleHardware({db,config,subject:s.subject,action:path.split('/').at(-1),body,time:now(),cabinets,send:(body,key,rentalId)=>sendWschargeCommand({db,config,actor:{id:s.subject,role:'owner'},body,idempotencyKey:key,time:now(),fetchImpl:wschargeFetch,rentalId})});
          return json(result.rental?{...result,rental:customerHardwareRental(result.rental,now())}:result);
        }
        if (path.startsWith('/api/user/test/')) {
          if (!googleTestEnabled(config)) fail(404, 'Test rental flow is disabled');
          if (!s.user.isTest) fail(403, 'This simulated flow requires a TEST account');
          if (method !== 'GET') rate('test-rental:' + s.subject, 120, 60000);
          return json(handleTestRental({ db, subject: s.subject, path, method, body, req, time: now() }));
        }
        if (path === "/api/user/logout" && method === "POST") {
          db.prepare("DELETE FROM sessions WHERE token_hash=?").run(
            s.token_hash,
          );
          return json({ ok: true }, 200, {
            "Set-Cookie": cookie("user", "", 0),
          });
        }
        if (path === "/api/user/rentals" && method === "GET")
          return json({ serverNow: new Date(now()).toISOString(), hardwareRentals: listRecords(db,'hardware_rental',s.subject).map(r=>customerHardwareRental(r,now())), rentals: s.user.isTest ? testRentals(db, s.subject).map(r => estimateTestRental(r, now())) : listRecords(db, "rental", s.subject) });
        if (path === '/api/user/support/reply' && method === 'POST') {
          if (typeof body.id !== 'string' || body.id.length > 160) fail(400, 'Invalid support reference');
          if (typeof body.message !== 'string' || body.message.trim().length < 5 || body.message.trim().length > 4000) fail(400, 'Support message must be 5–4000 characters');
          const message = body.message.trim();
          const key = req.headers.get('idempotency-key');
          if (!key || !/^[a-zA-Z0-9_-]{8,128}$/.test(key)) fail(400, 'Provide an Idempotency-Key (8–128 letters, numbers, _ or -)');
          const receiptId = digest(s.subject + '\n' + key);
          const result = transaction(db, () => {
            const row = db.prepare("SELECT data FROM records WHERE kind='support' AND id=? AND owner_id=?").get(body.id, s.subject);
            if (!row) fail(404, 'Support case not found');
            const ticket = supportView(JSON.parse(row.data));
            if ((ticket.testOnly === true) !== (s.user.isTest === true)) fail(404, 'Support case not found');
            const prior = db.prepare("SELECT data FROM records WHERE kind='support_reply_request' AND id=? AND owner_id=?").get(receiptId, s.subject);
            const fingerprint = digest(body.id + '\n' + message);
            if (prior) {
              if (JSON.parse(prior.data).fingerprint !== fingerprint) fail(409, 'Idempotency key already used for a different support reply');
              return ticket;
            }
            rate('support-reply:' + s.subject, 30, 3600000);
            ticket.updatedAt = new Date(Math.max(now(), (Date.parse(ticket.updatedAt) || 0) + 1)).toISOString();
            ticket.replies.push({ id: randomUUID(), reply: message, createdAt: ticket.updatedAt, actorId: s.subject, actorRole: 'customer' });
            ticket.status = 'open';
            putRecord(db, 'support', ticket.id, ticket, s.subject);
            putRecord(db, 'support_reply_request', receiptId, { fingerprint }, s.subject);
            return ticket;
          });
          return json({ support: result });
        }
        if (path === "/api/user/support" && method === "GET")
          return json({ support: listRecords(db, "support", s.subject).map(supportView) });
        if (path === "/api/user/support" && method === "POST") {
          if (typeof body.message === "string" && body.message.trim().length > 4000)
            fail(400, "Support message must be at most 4000 characters");
          const message = text(body.message, 4000);
          if (message.length < 5)
            fail(400, "Please describe the issue in at least five characters");
          if (body.rentalId != null && (typeof body.rentalId !== 'string' || body.rentalId.length > 160)) fail(400, 'Invalid rental reference');
          const rentalId = typeof body.rentalId === 'string' ? body.rentalId.trim() || null : null;
          if (rentalId) {
            const hardwareLinked=db.prepare("SELECT id FROM records WHERE kind='hardware_rental' AND id=? AND owner_id=?").get(rentalId,s.subject);
            const linked = hardwareLinked || (s.user.isTest
              ? db.prepare('SELECT id FROM test_rentals WHERE id=? AND owner_id=?').get(rentalId, s.subject)
              : db.prepare("SELECT id FROM records WHERE kind='rental' AND id=? AND owner_id=?").get(rentalId, s.subject));
            if (!linked) fail(404, 'Rental not found');
          }
          const key = req.headers.get("idempotency-key");
          if (key !== null && !/^[a-zA-Z0-9_-]{8,128}$/.test(key))
            fail(400, "Provide an Idempotency-Key (8–128 letters, numbers, _ or -)");
          // Owner-scoped deterministic IDs allow durable retry without a new ledger or schema.
          const id = key === null ? randomUUID() : "support_" + digest(s.subject + "\n" + key);
          const previous = db.prepare("SELECT data FROM records WHERE kind='support' AND id=? AND owner_id=?").get(id, s.subject);
          if (previous) {
            const ticket = JSON.parse(previous.data);
            if (ticket.message !== message || (ticket.rentalId || null) !== rentalId) fail(409, "Idempotency key already used for a different support request");
            return json({ support: supportView(ticket) }, 201);
          }
          rate("support:" + s.subject, 10, 3600000);
          const ticket = {
            testOnly: s.user.isTest === true,
            id,
            userId: s.subject,
            message,
            rentalId,
            rentalMode:rentalId&&db.prepare("SELECT id FROM records WHERE kind='hardware_rental' AND id=? AND owner_id=?").get(rentalId,s.subject)?'hardware':s.user.isTest?'test':'live',
            replies: [],
            status: "open",
            reply: "",
            createdAt: new Date(now()).toISOString(),
          };
          putRecord(db, "support", ticket.id, ticket, s.subject);
          return json({ support: supportView(ticket) }, 201);
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
