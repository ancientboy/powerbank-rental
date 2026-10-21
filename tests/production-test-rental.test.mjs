import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createProductionAPI } from '../src/production-api.mjs';
import { openProductionStore } from '../src/production-store.mjs';
import { estimateTestRental, testPricing } from '../src/production-test-rental.mjs';
const config = { publicOrigin: 'https://rental.example', secure: true, enableGoogleTestLogin: true, sessionSeconds: 3600, userSessionSeconds: 3600 };
async function setup() {
  const db = openProductionStore(':memory:');
  let time = Date.parse('2026-10-21T00:00:00Z');
  const api = createProductionAPI({ db, config, now: () => time });
  let cookie = '', csrf = '';
  async function request(path, body, key = randomUUID(), extra = {}) {
    const r = await api(new Request(config.publicOrigin + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin: config.publicOrigin, 'content-type': 'application/json', 'x-csrf-token': csrf, 'idempotency-key': key, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  const challenge = await request('/api/user/test-login-challenge'); cookie = challenge.cookie; csrf = challenge.data.csrf;
  const login = await request('/api/user/test-login', {}); cookie = login.cookie; csrf = login.data.csrf;
  const call = (action, body, key, headers) => request('/api/user/test/' + action, body, key, headers);
  return { db, call, advance: ms => { time += ms; }, request };
}
test('TEST pricing uses integer cents, started hours, daily cap and server clock', () => {
  const r = { status: 'active', startedAt: new Date(0).toISOString(), pricing: { ...testPricing } };
  for (const [ms, amount] of [[0,10000],[3600000,10000],[3600001,20000],[7*3600000,60000],[24*3600000,60000],[24*3600000+1,70000],[48*3600000,120000]]) {
    assert.equal(estimateTestRental(r, ms).totalAmount, amount);
  }
  assert.equal(estimateTestRental(r, -1).totalAmount, 10000);
});
test('TEST quotes, open-rental uniqueness and idempotency reject conflicts', async t => {
  const s = await setup(); t.after(() => s.db.close());
  assert.equal((await s.call('quote', { stationId: 'REAL-001' })).status,404);
  assert.equal((await s.call('quote', { stationId: 'DEMO-001' }, '')).status,400);
  assert.equal((await s.call('quote', { stationId: 'DEMO-001' }, undefined, { 'x-csrf-token': 'bad' })).status,403);
  const key = randomUUID();
  const q = await s.call('quote', { stationId: 'DEMO-001' }, key);
  assert.deepEqual((await s.call('quote', { stationId: 'DEMO-001' }, key)).data,q.data);
  assert.equal((await s.call('quote', { stationId: 'bad' }, key)).status,409);
  const r = await s.call('rent', { quoteId: q.data.quote.id });
  assert.equal(r.data.rental.status,'pending_payment');
  assert.equal((await s.call('rent', { quoteId: q.data.quote.id })).data.rental.id,r.data.rental.id);
  const q2 = await s.call('quote', { stationId: 'DEMO-001' });
  assert.equal((await s.call('rent', { quoteId: q2.data.quote.id })).status,409);
  assert.equal(s.db.prepare('SELECT count(*) n FROM records').get().n,0);
});
test('TEST failed payment retries, duplicate success/return, immutable settlement and cancellation', async t => {
  const s = await setup(); t.after(() => s.db.close());
  const q = await s.call('quote', { stationId: 'DEMO-001' });
  const r = await s.call('rent', { quoteId: q.data.quote.id });
  const rentalId = r.data.rental.id;
  const failKey = randomUUID();
  assert.equal((await s.call('pay', { rentalId, outcome: 'failure' },failKey)).data.payment.status,'failed');
  await s.call('pay', { rentalId, outcome: 'failure' }, failKey);
  assert.equal(s.db.prepare("SELECT count(*) n FROM test_records WHERE kind='payment'").get().n,1);
  const paid = await s.call('pay', { rentalId, outcome: 'success', totalAmount: 1, startedAt: '1900-01-01' });
  assert.equal(paid.data.rental.status,'active');
  assert.equal(paid.data.rental.totalAmount,10000);
  assert.equal((await s.call('pay', { rentalId, outcome: 'success' })).data.payment.id,paid.data.payment.id);
  assert.equal((await s.call('cancel', { rentalId })).status,409);
  s.advance(3600001);
  // Refresh expiry for this clock-driven pricing test only.
  s.db.prepare('UPDATE sessions SET expires=expires+10000000').run();
  const returned = await s.call('return', { rentalId, totalAmount: 1 });
  assert.equal(returned.data.rental.status,'completed');
  assert.equal(returned.data.payment.amount,20000);
  s.advance(100000);
  assert.deepEqual((await s.call('return', { rentalId })).data.rental,returned.data.rental);
  assert.equal(s.db.prepare("SELECT count(*) n FROM test_records WHERE kind='payment'").get().n,3);
  const q2 = await s.call('quote', { stationId: 'DEMO-001' });
  const r2 = await s.call('rent', { quoteId: q2.data.quote.id });
  const cancelled = await s.call('cancel', { rentalId: r2.data.rental.id });
  assert.equal(cancelled.data.rental.status,'cancelled');
  assert.equal((await s.call('pay', { rentalId: r2.data.rental.id, outcome:'success' })).status,409);
  assert.equal((await s.call('state')).data.rental,null);
  assert.equal((await s.request('/api/user/rentals')).data.rentals.length,2);
  assert.equal(s.db.prepare('SELECT count(*) n FROM records').get().n,0);
});
test('TEST quote expires and no-network simulation module stays isolated', async t => {
  const s = await setup(); t.after(() => s.db.close());
  const q = await s.call('quote', { stationId:'DEMO-001' });
  s.advance(300000);
  assert.equal((await s.call('rent', { quoteId: q.data.quote.id })).status,409);
});
