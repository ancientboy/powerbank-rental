import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openProductionStore, putRecord } from '../src/production-store.mjs';
import { createProductionAPI } from '../src/production-api.mjs';
import { loadConfig, readiness } from '../src/production-config.mjs';

const origin = 'https://review.example.test';
const base = () => loadConfig({ PUBLIC_ORIGIN: origin, ENABLE_GOOGLE_TEST_LOGIN: '1' });
function fixture(config = base(), db = openProductionStore(':memory:')) {
  let now = Date.now();
  const api = createProductionAPI({ db, config, now: () => now });
  const call = (path, { method = 'GET', cookies = '', csrf, body = {}, requestOrigin = origin, contentType = 'application/json' } = {}) => api(new Request(origin + path, {
    method, headers: { cookie: cookies, ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(method !== 'GET' ? { origin: requestOrigin, 'content-type': contentType } : {}) },
    ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}),
  }));
  return { db, config, call, advance: ms => { now += ms; } };
}
function cookieHeader(response) { return response.headers.getSetCookie().map(x => x.split(';')[0]).join('; '); }
async function login(f, existing = '') {
  const challenge = await f.call('/api/user/test-login-challenge', { cookies: existing });
  assert.equal(challenge.status, 200, await challenge.clone().text());
  const csrf = (await challenge.json()).csrf;
  const browser = cookieHeader(challenge) || existing;
  const response = await f.call('/api/user/test-login', { method: 'POST', cookies: browser, csrf });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  const cookies = browser + '; ' + cookieHeader(response);
  const session = await (await f.call('/api/user/session', { cookies })).json();
  return { ...result, ...session, browser, cookies, response };
}

test('independent test login review: default off, exact flag, credentials disable test mode', async () => {
  for (const value of [undefined, '', '0', 'true', 'yes']) {
    const f = fixture(loadConfig({ PUBLIC_ORIGIN: origin, ENABLE_GOOGLE_TEST_LOGIN: value }));
    try {
      assert.notEqual(readiness(f.config).googleTest?.ready, true);
      assert.ok((await f.call('/api/user/test-login-challenge')).status >= 400);
      assert.equal(f.db.prepare('SELECT count(*) n FROM users').get().n, 0);
    } finally { f.db.close(); }
  }
  for (const credentials of [{ GOOGLE_CLIENT_ID: 'id' }, { GOOGLE_CLIENT_SECRET: 'secret' }, { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }]) {
    const f = fixture(loadConfig({ PUBLIC_ORIGIN: origin, ENABLE_GOOGLE_TEST_LOGIN: '1', ...credentials }));
    try { assert.notEqual(readiness(f.config).googleTest?.ready, true); assert.ok((await f.call('/api/user/test-login-challenge')).status >= 400); }
    finally { f.db.close(); }
  }
});

test('independent test login review: identities are browser-isolated and remain stable after logout', async () => {
  const f = fixture();
  try {
    const a = await login(f), b = await login(f);
    assert.notEqual(a.user.id, b.user.id);
    assert.equal(a.user.isTest, true);
    assert.equal(a.user.provider, 'google_test');
    // TEST history is now isolated from production records.
    f.db.prepare('INSERT INTO test_rentals VALUES(?,?,?,?,?)').run('a-private', a.user.id, 'completed', 'fixture-quote', JSON.stringify({ id: 'a-private', userId: a.user.id, status: 'completed', testOnly: true }));
    putRecord(f.db, 'rental', 'real-only', { id: 'real-only' }, a.user.id);
    const submitted = await f.call('/api/user/support', { ...a, method: 'POST', body: { message: 'Independent review support request' } });
    assert.equal(submitted.status, 201);
    const ticket = (await submitted.json()).support;
    assert.equal(ticket.userId, a.user.id);
    assert.equal(ticket.testOnly, true);
    assert.equal((await (await f.call('/api/user/support', a)).json()).support.length, 1);
    for (const kind of ['rentals', 'support']) assert.deepEqual((await (await f.call('/api/user/' + kind, b)).json())[kind], []);
    assert.equal((await f.call('/api/user/logout', { ...a, method: 'POST' })).status, 200);
    assert.equal((await (await f.call('/api/user/session', a)).json()).user, null);
    const again = await login(f, a.browser);
    assert.equal(again.user.id, a.user.id);
    assert.equal((await (await f.call('/api/user/rentals', again)).json()).rentals[0].id, 'a-private');
  } finally { f.db.close(); }
});

test('independent test login review: login needs browser-bound csrf, same origin and JSON', async () => {
  const f = fixture();
  try {
    const challenge = await f.call('/api/user/test-login-challenge');
    const browser = cookieHeader(challenge), { csrf } = await challenge.json();
    for (const overrides of [{ cookies: '' }, { csrf: undefined }, { csrf: 'forged' }, { requestOrigin: 'https://evil.test' }, { contentType: 'text/plain' }]) {
      const result = await f.call('/api/user/test-login', { method: 'POST', cookies: browser, csrf, ...overrides });
      assert.ok(result.status >= 400, JSON.stringify(overrides));
    }
    assert.ok((await f.call('/api/user/test-login')).status >= 400);
    const other = await f.call('/api/user/test-login-challenge');
    assert.ok((await f.call('/api/user/test-login', { method: 'POST', cookies: cookieHeader(other), csrf })).status >= 400);
    const result = await f.call('/api/user/test-login', { method: 'POST', cookies: browser, csrf, body: { id: 'victim', sub: 'victim', email: 'victim@example.test', role: 'owner', isAdmin: true } });
    if (result.status === 200) { const data = await result.json(); assert.notEqual(data.user.id, 'victim'); assert.notEqual(data.user.email, 'victim@example.test'); assert.notEqual(data.user.role, 'owner'); }
    else assert.ok(result.status >= 400);
  } finally { f.db.close(); }
});

test('independent test login review: customer cookie cannot become admin; mutation and physical gates remain closed', async () => {
  const f = fixture();
  try {
    const a = await login(f);
    for (const value of a.response.headers.getSetCookie()) { assert.match(value, /HttpOnly/); assert.match(value, /Secure/); assert.match(value, /SameSite=Lax/); assert.doesNotMatch(value, /^voltgo_admin=/); }
    for (const cookies of [a.cookies, a.cookies.replace(/voltgo_user=/g, 'voltgo_admin='), 'voltgo_session=' + 'a'.repeat(64)]) {
      for (const path of ['/api/admin/session', '/api/admin/dashboard']) assert.equal((await f.call(path, { cookies })).status, 401);
    }
    assert.equal((await f.call('/api/user/support', { ...a, method: 'POST', csrf: undefined, body: { message: 'Test support message' } })).status, 403);
    for (const path of ['/api/user/rent', '/api/user/pay', '/api/user/return']) assert.equal((await f.call(path, { ...a, method: 'POST' })).status, 503);
    assert.equal((await f.call('/v1/actions', { ...a, method: 'POST', body: { action: 'admin_login' } })).status, 404);
    assert.equal(f.db.prepare('SELECT count(*) n FROM admins').get().n, 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM users').get().n, 0);
    assert.equal(readiness(f.config).pvs.ready, false);
    assert.equal(readiness(f.config).wscharge.ready, false);
  } finally { f.db.close(); }
});

test('independent test login review: existing sessions stop working when flag is disabled or Google configured', async () => {
  for (const change of [{ enableGoogleTestLogin: false }, { googleClientId: 'real-client', googleClientSecret: 'real-secret' }]) {
    const f = fixture();
    try {
      const a = await login(f);
      Object.assign(f.config, change);
      assert.equal((await (await f.call('/api/user/session', a)).json()).user, null);
      assert.equal((await f.call('/api/user/rentals', a)).status, 401);
      assert.ok((await f.call('/api/user/test-login-challenge', a)).status >= 400);
    } finally { f.db.close(); }
  }
});

test('independent test login review: rate limits survive fresh cookies and API instances', async () => {
  const f = fixture();
  try {
    let limited = false;
    for (let i = 0; i < 130; i++) {
      const response = await f.call('/api/user/test-login-challenge');
      if (response.status === 429) { limited = true; break; }
      assert.equal(response.status, 200);
    }
    assert.ok(limited, 'Unauthenticated challenges must have a bounded global rate');
    const recreated = fixture(f.config, f.db);
    assert.equal((await recreated.call('/api/user/test-login-challenge')).status, 429);
  } finally { f.db.close(); }
});

test('independent test login review: schema upgrade preserves legacy real accounts and owned records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'test-login-review-'));
  const path = join(dir, 'existing.sqlite');
  let db;
  try {
    db = new DatabaseSync(path);
    db.exec("CREATE TABLE users(id TEXT PRIMARY KEY, google_sub TEXT NOT NULL UNIQUE, email TEXT, name TEXT, created_at TEXT NOT NULL); INSERT INTO users VALUES('existing-id','existing-google-sub','existing@example.test','Existing person','2026-01-01');");
    db.close();
    db = openProductionStore(path);
    putRecord(db, 'support', 'existing-support', { message: 'preserve existing record' }, 'existing-id');
    const before = { ...db.prepare('SELECT * FROM users').get() };
    db.close();
    db = openProductionStore(path);
    assert.deepEqual({ ...db.prepare('SELECT * FROM users').get() }, before);
    assert.equal(db.prepare("SELECT owner_id FROM records WHERE id='existing-support'").get().owner_id, 'existing-id');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('independent test login review: browser binding and support survive database reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'test-browser-review-'));
  const path = join(dir, 'state.sqlite');
  let f = fixture(base(), openProductionStore(path));
  try {
    const a = await login(f);
    assert.equal((await f.call('/api/user/support', { ...a, method: 'POST', body: { message: 'Restart persistence test' } })).status, 201);
    f.db.close();
    f = fixture(base(), openProductionStore(path));
    const again = await login(f, a.browser);
    assert.equal(again.user.id, a.user.id);
    assert.equal((await (await f.call('/api/user/support', again)).json()).support[0].message, 'Restart persistence test');
  } finally { f.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('independent test login review: real Google subject cannot claim test user or inherit test records', async () => {
  const f = fixture();
  try {
    const a = await login(f);
    putRecord(f.db, 'rental', 'test-rental', { id: 'test-rental' }, a.user.id);
    const cfg = { ...f.config, googleClientId: 'real-test-client', googleClientSecret: 'real-test-secret' };
    const state = 's'.repeat(43);
    const api = createProductionAPI({ db: f.db, config: cfg, google: {
      beginGoogle: async () => ({ state, nonce: 'n'.repeat(43), verifier: 'v'.repeat(43), url: 'https://accounts.google.com/test' }),
      exchangeGoogle: async () => ({ sub: a.user.id, email: 'real@example.test', name: 'Verified customer' }),
    } });
    const get = (path, cookies = '') => api(new Request(origin + path, { headers: { cookie: cookies } }));
    const started = await get('/auth/google');
    const completed = await get('/auth/google/callback?state=' + state + '&code=local-test', cookieHeader(started));
    assert.equal(completed.headers.get('location'), '/');
    const cookie = cookieHeader(completed);
    const real = await (await get('/api/user/session', cookie)).json();
    assert.equal(real.user.provider, 'google');
    assert.equal(real.user.isTest, false);
    assert.notEqual(real.user.id, a.user.id);
    assert.deepEqual((await (await get('/api/user/rentals', cookie)).json()).rentals, []);
    assert.equal((await (await get('/api/user/session', a.cookies)).json()).user, null);
    cfg.enableGoogleTestLogin = false;
    assert.equal((await (await get('/api/user/session', cookie)).json()).user.id, real.user.id);
    f.config.enableGoogleTestLogin = true;
    assert.equal((await (await f.call('/api/user/session', a)).json()).user, null, 'Revoked test sessions must not resurrect when test mode returns');
  } finally { f.db.close(); }
});

test('independent test login review: forged/expired browser tokens never select existing identities', async () => {
  const f = fixture();
  try {
    const a = await login(f);
    const rawToken = a.browser.split('=')[1];
    const stored = f.db.prepare('SELECT browser_hash FROM test_login_states').get().browser_hash;
    assert.notEqual(stored, rawToken);
    assert.match(stored, /^[a-f0-9]{64}$/);
    const forged = await login(f, 'voltgo_test_browser=' + 'x'.repeat(43));
    assert.notEqual(forged.user.id, a.user.id);
    assert.notEqual(forged.browser, 'voltgo_test_browser=' + 'x'.repeat(43));
    f.advance(31 * 86400000);
    assert.equal((await f.call('/api/user/support', a)).status, 401);
    const expired = await login(f, a.browser);
    assert.notEqual(expired.user.id, a.user.id);
  } finally { f.db.close(); }
});
