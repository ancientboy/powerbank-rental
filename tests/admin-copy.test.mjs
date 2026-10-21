import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { readiness } from '../src/production-config.mjs';

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.events = {}; this.classList = { add() {}, remove() {}, toggle() {} }; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(name, handler) { this.events[name] = handler; }
}
const text = node => [node.textContent || '', ...node.children.map(text)].join(' ');
async function admin(data = {}, role = 'owner') {
  const elements = new Map();
  const context = vm.createContext({ document: { getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, createElement(tag) { return new Element(tag); } }, window: { addEventListener() {} }, location: { pathname: '/admin/login', hash: '' }, Intl, Date });
  vm.runInContext(await readFile(new URL('../production-public/admin.js', import.meta.url), 'utf8'), context);
  context.fixture = data; context.role = role;
  vm.runInContext('data = fixture; session = { user: { role } };', context);
  const render = section => { context.next = section; vm.runInContext('navigate(next)', context); return text(elements.get('admin-panel')); };
  return { context, elements, render };
}

test('admin copy stays concise without hiding integration limitations', async () => {
  const html = await readFile(new URL('../production-public/admin.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../production-public/admin.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /THE ENERGY BEHIND|Good energy|Welcome back|VOL TGO/);
  assert.doesNotMatch(source, /Real records|real locations|Credentials are never|Connected services/);
  const h = await admin({ readiness: readiness({}) });
  assert.match(h.render('dashboard'), /Live rentals, payments, and cabinet controls are unavailable/);
  const integrations = h.render('integrations');
  assert.match(integrations, /Live connectivity is unverified/);
  assert.match(integrations, /Pending integration/);
  assert.match(integrations, /Live payments and cabinet controls are unavailable/);
  assert.match(h.render('support'), /No support requests yet/);
});

test('readiness compact labels do not claim a live connection', () => {
  const missing = readiness({});
  assert.equal(missing.google.label, 'Not configured');
  assert.equal(missing.pvs.label, 'Pending integration');
  assert.equal(missing.wscharge.label, 'Pending integration');
  assert.equal(missing.pvs.ready, false);
  assert.equal(missing.wscharge.ready, false);
  const configured = readiness({ googleClientId: 'client-id', googleClientSecret: 'secret', publicOrigin: 'https://example.com' });
  assert.equal(configured.google.label, 'Configured');
});

test('read-only stations remain explicit after copy cleanup', async () => {
  const h = await admin({}, 'viewer');
  assert.match(h.render('stations'), /Read-only access/);
  assert.doesNotMatch(h.render('stations'), /Add station/);
});

test('test rental and payment records are separate and visibly marked', async () => {
  const h = await admin({
    rentals: [{ id: 'live-order', status: 'active' }], payments: [],
    testRentals: [{ id: 'test-order', userId: 'test-user', stationName: 'TEST Demo station', status: 'completed', createdAt: '2026-01-01T00:00:00Z', returnedAt: '2026-01-01T00:02:00Z', testOnly: true }],
    testPayments: [{ id: 'test-payment', rentalId: 'test-order', amount: 10000, currency: 'ARS', status: 'succeeded', testOnly: true }],
    testStations: [{ id: 'DEMO-001', name: 'TEST Demo station', address: 'Virtual station · no physical device', testOnly: true }],
  });
  const orders = h.render('orders');
  assert.match(orders, /live-order.*Test orders.*TEST.*Simulation only.*test-order/);
  assert.match(orders, /Returned/);
  assert.match(h.render('payments'), /Live payment processing is unavailable.*Test payments.*TEST.*No charges or physical devices.*test-payment/);
  assert.match(h.render('stations'), /Test stations.*TEST.*DEMO-001/);
});

test('overview counts exclude mock orders, payments, users and support', async () => {
  const h = await admin({ stations: [], users: [{ id: 'test-user', provider: 'google_test' }], rentals: [], support: [{ testOnly: true, status: 'open' }], testRentals: [{ id: 'test-order' }], testPayments: [{ id: 'test-payment' }], testStations: [{ id: 'DEMO-001' }] });
  h.render('dashboard');
  const stats = h.elements.get('admin-panel').children[0];
  assert.deepEqual(stats.children.map(card => card.children[1].textContent), ['0', '0', '0', '0']);
  assert.doesNotMatch(text(stats), /Recorded rentals|Registered locations|Customer accounts/);
});


test('test deposit and refund transactions have distinct labels', async () => {
  const h = await admin({ payments: [], testPayments: [
    { id: 'deposit-demo', rentalId: 'r-demo', type: 'deposit', amount: 1000000, currency: 'ARS', status: 'succeeded', testOnly: true },
    { id: 'refund-demo', rentalId: 'r-demo', type: 'refund', amount: 950000, currency: 'ARS', status: 'succeeded', testOnly: true }
  ] });
  const output = h.render('payments');
  assert.match(output, /Type/);
  assert.match(output, /deposit-demo.*Deposit/);
  assert.match(output, /refund-demo.*Refund/);
});
