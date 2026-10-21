import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openProductionStore } from '../src/production-store.mjs';
import { createProductionAPI } from '../src/production-api.mjs';
import { loadConfig } from '../src/production-config.mjs';
const origin = 'https://review-rental.example';
const prefix = '/api/user/test/';
const cookies = r => r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
function fixture(path = ':memory:') {
  let time = Date.now(), db = openProductionStore(path);
  const config = loadConfig({ PUBLIC_ORIGIN: origin, ENABLE_GOOGLE_TEST_LOGIN: '1' });
  let api = createProductionAPI({ db, config, now: () => time });
  const call = (path, client = {}, body, key = randomUUID(), extraHeaders = {}) => api(new Request(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: client.cookies || '', origin, 'content-type': 'application/json', 'x-csrf-token': client.csrf || '', 'idempotency-key': key, ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const ok = async (path, client, body, key) => { const r = await call(path, client, body, key); const result = await r.json(); assert.equal(r.status, 200, JSON.stringify(result)); return result; };
  return { get db() { return db; }, config, call, ok, advance(ms) { time += ms; }, reopen() { db.close(); db = openProductionStore(path); api = createProductionAPI({ db, config, now: () => time }); }, close() { db.close(); } };
}
async function login(f) {
  const challenge = await f.call('/api/user/test-login-challenge');
  const browser = cookies(challenge), { csrf } = await challenge.json();
  const result = await f.call('/api/user/test-login', { cookies: browser, csrf }, {});
  assert.equal(result.status, 200);
  const client = { cookies: browser + '; ' + cookies(result) };
  Object.assign(client, await f.ok('/api/user/session', client));
  return client;
}
async function rent(f, a) {
  const { quote } = await f.ok(prefix + 'quote', a, { stationId: 'DEMO-001' });
  return (await f.ok(prefix + 'rent', a, { quoteId: quote.id })).rental;
}
test('independent rental review: formal TEST cycle persists active state and immutable receipt over restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rental-review-')); const f = fixture(join(dir, 'state.sqlite'));
  try {
    const a = await login(f);
    const stations = await f.ok(prefix + 'stations', a);
    assert.equal(stations.testOnly, true); assert.ok(stations.stations.every(s => s.testOnly));
    const rental = await rent(f, a);
    assert.equal(rental.status, 'pending_payment');
    f.reopen();
    assert.equal((await f.ok(prefix + 'state', a)).rental.id, rental.id);
    const pay = await f.ok(prefix + 'pay', a, { rentalId: rental.id, outcome: 'success' });
    assert.equal(pay.rental.status, 'active'); assert.equal(pay.payment.provider, 'mock');
    f.advance(3601000); f.reopen();
    assert.equal((await f.ok(prefix + 'state', a)).rental.totalAmount, 20000);
    const receipt = await f.ok(prefix + 'return', a, { rentalId: rental.id });
    assert.equal(receipt.rental.status, 'completed'); assert.equal(receipt.rental.testOnly, true);
    assert.equal(receipt.payment.amount, 20000); assert.equal(receipt.payment.provider, 'mock');
    f.advance(3600000); f.reopen();
    const state = await f.ok(prefix + 'state', a);
    assert.equal(state.rental, null); assert.deepEqual(state.rentals[0], receipt.rental);
    assert.deepEqual((await f.ok('/api/user/rentals', a)).rentals[0], receipt.rental);
    assert.equal(f.db.prepare('SELECT count(*) n FROM users').get().n, 0);
    assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind IN ('rental','payment','station')").get().n, 0);
  } finally { f.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('independent rental review: ownership enforced even with known foreign IDs and reused idempotency keys', async () => {
  const f = fixture(); try {
    const a = await login(f), b = await login(f), key = randomUUID();
    const qa = await f.ok(prefix + 'quote', a, { stationId: 'DEMO-001' }, key);
    const qb = await f.ok(prefix + 'quote', b, { stationId: 'DEMO-001' }, key);
    assert.notEqual(qa.quote.id, qb.quote.id);
    assert.equal((await f.call(prefix + 'rent', b, { quoteId: qa.quote.id })).status, 404);
    const ra = (await f.ok(prefix + 'rent', a, { quoteId: qa.quote.id })).rental;
    for (const action of ['pay', 'cancel', 'return']) assert.equal((await f.call(prefix + action, b, { rentalId: ra.id, outcome: 'success' })).status, 404);
    assert.deepEqual((await f.ok(prefix + 'state', b)).rentals, []);
    assert.deepEqual((await f.ok('/api/user/rentals', b)).rentals, []);
    assert.equal((await f.ok(prefix + 'state', a)).rental.status, 'pending_payment');
  } finally { f.close(); }
});
test('independent rental review: failures retry, double clicks do not duplicate authorizations or settlements', async () => {
  const f = fixture(); try {
    const a = await login(f), rental = await rent(f, a), key = randomUUID();
    const failed = await f.ok(prefix + 'pay', a, { rentalId: rental.id, outcome: 'failure' }, key);
    assert.equal(failed.rental.status, 'pending_payment');
    assert.deepEqual(await f.ok(prefix + 'pay', a, { rentalId: rental.id, outcome: 'failure' }, key), failed);
    assert.equal((await f.call(prefix + 'pay', a, { rentalId: rental.id, outcome: 'success' }, key)).status, 409);
    const results = await Promise.all([1,2].map(() => f.ok(prefix + 'pay', a, { rentalId: rental.id, outcome: 'success' })));
    assert.equal(results[0].payment.id, results[1].payment.id);
    assert.equal((await f.call(prefix + 'cancel', a, { rentalId: rental.id })).status, 409);
    const returns = await Promise.all([1,2].map(() => f.ok(prefix + 'return', a, { rentalId: rental.id })));
    assert.equal(returns[0].payment.id, returns[1].payment.id);
    assert.equal(f.db.prepare("SELECT count(*) n FROM test_records WHERE kind='payment'").get().n, 3);
    const next = await rent(f, a);
    await f.ok(prefix + 'cancel', a, { rentalId: next.id });
    assert.equal((await f.call(prefix + 'pay', a, { rentalId: next.id, outcome: 'success' })).status, 409);
    assert.equal((await f.call(prefix + 'return', a, { rentalId: next.id })).status, 409);
    assert.equal((await f.ok(prefix + 'state', a)).rental, null);
  } finally { f.close(); }
});
test('independent rental review: expiry, CSRF, authentication and real-account boundaries fail closed', async () => {
  const f = fixture(); try {
    const a = await login(f);
    const { quote } = await f.ok(prefix + 'quote', a, { stationId: 'DEMO-001' });
    f.advance(300001);
    assert.equal((await f.call(prefix + 'rent', a, { quoteId: quote.id })).status, 409);
    assert.equal((await f.call(prefix + 'quote', a, { stationId: 'REAL-001' })).status, 404);
    assert.equal((await f.call(prefix + 'quote', {}, { stationId: 'DEMO-001' })).status, 401);
    assert.equal((await f.call(prefix + 'quote', { ...a, csrf: 'wrong' }, { stationId: 'DEMO-001' })).status, 403);
    assert.equal((await f.call(prefix + 'quote', a, { stationId: 'DEMO-001' }, randomUUID(), { origin: 'https://evil.example' })).status, 403);
    for (const action of ['rent','pay','return']) assert.equal((await f.call('/api/user/' + action, a, {})).status, 503);
    assert.equal((await f.call('/api/admin/dashboard', a)).status, 401);
    const token = 'r'.repeat(43);
    f.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run('real-user', 'real-sub', 'real@example.test', 'Real', new Date().toISOString());
    f.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'user', 'real-user', 'real-csrf', Date.now() + 86400000);
    const real = { cookies: 'voltgo_user=' + token, csrf: 'real-csrf' };
    for (const action of ['state','stations']) assert.equal((await f.call(prefix + action, real)).status, 403);
    assert.equal((await f.call(prefix + 'quote', real, { stationId: 'DEMO-001' })).status, 403);
    f.config.enableGoogleTestLogin = false;
    assert.equal((await f.call(prefix + 'state', a)).status, 401);
    assert.equal((await f.call(prefix + 'state', real)).status, 404);
  } finally { f.close(); }
});
test('independent rental review: simulation module has no payment, hardware or network execution dependency', () => {
  const source = readFileSync(new URL('../src/production-test-rental.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|https?:\/\/|from\s+['"].*(?:wscharge|adapters|pvs|https|http)/i);
});

test('independent rental review: customer JavaScript drives formal API from mock sign-in through receipt and refresh', async () => {
  const vm = await import('node:vm');
  const f = fixture(), jar = new Map(), requests = [];
  class Element {
    constructor(tag = 'div') { this.tagName = tag; this.children = []; this.events = {}; this.attributes = {}; this.style = {}; const classes = new Set(); this.classList = { add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); }, toggle(c, on = !classes.has(c)) { if (on) classes.add(c); else classes.delete(c); } }; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(name, fn) { this.events[name] = fn; }
    focus() {}
  }
  const source = readFileSync(new URL('../production-public/app.js', import.meta.url), 'utf8');
  const render = async () => {
    const elements = new Map();
    const context = vm.createContext({ document: { body: { style: {} }, getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, createElement(tag) { return new Element(tag); } }, window: { addEventListener() {} }, location: { pathname: '/', search: '' }, crypto: { randomUUID }, Intl, Date, URLSearchParams, console,
      fetch: async (path, opts = {}) => {
        requests.push(path);
        const headers = new Headers(opts.headers);
        const client = { cookies: [...jar].map(([k,v]) => k + '=' + v).join('; '), csrf: headers.get('x-csrf-token') };
        const r = await f.call(path, client, opts.body ? JSON.parse(opts.body) : undefined, headers.get('idempotency-key') || randomUUID());
        for (const value of r.headers.getSetCookie()) { const [k,v] = value.split(';')[0].split('='); jar.set(k,v); }
        return r;
      } });
    vm.runInContext(source, context);
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    return { context, elements, run: command => vm.runInContext(command, context) };
  };
  const nodeText = node => [node.textContent || '', ...node.children.map(nodeText)].join(' ');
  try {
    let h = await render();
    const signIn = h.elements.get('account-content').children.find(n => n.textContent === 'Continue with Google (test)');
    assert.ok(signIn); await signIn.events.click();
    assert.match(nodeText(h.elements.get('rental-flow')), /Mock scan/);
    await h.run("requestQuote('DEMO-001')");
    assert.match(nodeText(h.elements.get('rental-flow')), /Review your rental/);
    await h.run("transact('rent', {quoteId:quote.id})");
    assert.match(nodeText(h.elements.get('rental-flow')), /Choose a test payment/);
    await h.run("transact('pay', {rentalId:testState.rental.id,outcome:'failure'})");
    assert.match(h.elements.get('notice').textContent, /failed.*Retry/);
    await h.run("transact('pay', {rentalId:testState.rental.id,outcome:'success'})");
    h = await render();
    assert.match(nodeText(h.elements.get('rental-flow')), /ACTIVE TEST RENTAL/);
    await h.run("transact('return', {rentalId:testState.rental.id})");
    assert.match(nodeText(h.elements.get('rentals')), /Returned · settled/);
    assert.match(h.elements.get('notice').textContent, /No real charge/);
    h = await render();
    assert.match(nodeText(h.elements.get('rentals')), /Returned · settled/);
    assert.match(nodeText(h.elements.get('rental-flow')), /Start a test rental/);
    assert.equal(h.elements.get('stations').classList.contains('hidden'), true);
    const logout = h.elements.get('account-content').children.find(n => n.textContent === 'Sign out');
    await logout.events.click();
    assert.equal(h.run('view'), 'home', 'sign-out returns to the original home screen');
    assert.equal(h.elements.get('home-screen').classList.contains('hidden'), false);
    assert.equal(h.elements.get('stations').classList.contains('hidden'), true, 'stations are now an independent screen');
    assert.equal(h.run('session.user'), null);
    assert.equal(h.run('testState'), null);
    assert.equal(h.run('quote'), null);
    assert.equal(requests.at(-1), '/api/user/stations', 'sign-out reloads non-TEST station data');
    assert.equal(h.run('stationData.stations.length'), 0);
    h.run("navigate('stations')");
    assert.equal(h.elements.get('stations').classList.contains('hidden'), false);
    assert.equal(h.elements.get('home-screen').classList.contains('hidden'), true);
    assert.match(nodeText(h.elements.get('station-list')), /No stations available yet/);
    assert.doesNotMatch(nodeText(h.elements.get('station-list')), /DEMO-001|Return here|Rent here/);
    assert.ok(requests.includes('/api/user/test/quote'));
    assert.ok(!requests.some(path => /\/v1\/|\/api\/admin|\/api\/user\/(pay|rent|return)$/.test(path)));
  } finally { f.close(); }
});
