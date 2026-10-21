import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const root = new URL('../production-public/', import.meta.url);
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.dataset = {}; this.events = {}; this.attributes = {}; this.value = ''; this.classList = { add() {}, remove() {}, toggle() {} }; }
  append(...nodes) { this.children.push(...nodes); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(name, handler) { this.events[name] = handler; }
  querySelector(tag) { for (const child of this.children) { if (child.tagName === tag) return child; const found = child.querySelector?.(tag); if (found) return found; } return null; }
  focus() {}
  remove() {}
}
const settle = () => new Promise(resolve => setImmediate(resolve));
async function harness(file, pathname, responses) {
  const elements = new Map(); const requests = []; const redirects = [];
  const context = vm.createContext({ document: { getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, createElement(tag) { return new Element(tag); } }, window: { addEventListener() {} }, location: { pathname, hash: '', search: '', replace(path) { redirects.push(path); } }, URLSearchParams, Intl, Date, console, fetch: async (path, options) => { requests.push({ path, options }); const response = responses[path] || {}; return { ok: response.status ? response.status < 400 : true, status: response.status || 200, json: async () => response.body || response }; } });
  vm.runInContext(await readFile(new URL(file, root), 'utf8'), context); await settle(); await settle(); return { context, elements, requests, redirects };
}
const text = node => [node.textContent || '', ...node.children.map(text)].join(' ');
test('production templates use external scripts, no inline events or legacy customer operations', async () => {
  for (const file of ['index.html', 'admin.html']) { const source = await readFile(new URL(file, root), 'utf8'); assert.doesNotMatch(source, /<script(?![^>]*src=)|\son\w+=/i); }
  const customer = await readFile(new URL('index.html', root), 'utf8'); assert.doesNotMatch(customer, /apple|simulate|\/admin|operations/i);
  for (const file of ['app.js', 'admin.js']) assert.doesNotMatch(await readFile(new URL(file, root), 'utf8'), /innerHTML|insertAdjacentHTML|eval\(/);
});
test('customer empty states and missing Google configuration are explicit', async () => {
  const h = await harness('app.js', '/', { '/api/user/session': { user: null, readiness: { google: { ready: false } } }, '/api/user/stations': { stations: [], pricing: { hourlyRate: 15000, dailyCap: 50000, deposit: 100000, currency: 'ARS' } } });
  assert.match(text(h.elements.get('account-content')), /Google sign-in is unavailable/); assert.match(text(h.elements.get('station-list')), /No stations available yet/); assert.match(h.elements.get('pricing').textContent, /150\.00/); assert.equal(h.requests.length, 2);
});
test('customer Google button uses only configured real OAuth endpoint', async () => {
  const h = await harness('app.js', '/', { '/api/user/session': { user: null, readiness: { google: { ready: true } } }, '/api/user/stations': { stations: [] } });
  const link = h.elements.get('account-content').children.find(n => n.tagName === 'a'); assert.equal(link.href, '/auth/google');
});
test('administrator session failure redirects to independent login', async () => {
  const h = await harness('admin.js', '/admin', { '/api/admin/session': { status: 401, body: { error: 'Sign in required' } } }); assert.deepEqual(h.redirects, ['/admin/login']);
});
test('administrator login view does not fetch protected data', async () => { const h = await harness('admin.js', '/admin/login', {}); assert.equal(h.requests.length, 0); });
test('admin dashboard renders all real-data sections and mutations include CSRF', async () => {
  const h = await harness('admin.js', '/admin', { '/api/admin/session': { user: { username: 'ops', role: 'owner' }, csrf: 'csrf-test' }, '/api/admin/dashboard': { stations: [], users: [], rentals: [], payments: [], support: [], audit: [], pricing: { hourlyRate: 12345 }, readiness: {} } });
  assert.equal(h.elements.get('admin-nav').children.length, 9);
  for (const section of ['stations', 'pricing', 'orders', 'payments', 'users', 'support', 'audit', 'integrations', 'dashboard']) vm.runInContext(`navigate('${section}')`, h.context);
  await vm.runInContext("api('/api/admin/stations', {method:'POST',body:'{}'})", h.context);
  assert.equal(h.requests.at(-1).options.headers['X-CSRF-Token'], 'csrf-test'); assert.equal(h.requests.at(-1).options.credentials, 'same-origin');
});
test('support status uses accessible inline radio choices, never native popup select', async () => {
  for (const file of ['app.js', 'admin.js']) assert.doesNotMatch(await readFile(new URL(file, root), 'utf8'), /el\(['"]select['"]|createElement\(['"]select['"]/);
  const h = await harness('admin.js', '/admin', { '/api/admin/session': { user: { username: 'ops', role: 'owner' }, csrf: 'csrf-test' }, '/api/admin/dashboard': { support: [{id:'case-one',userId:'user-one',message:'Please help',status:'in_progress'}] } });
  vm.runInContext("navigate('support')", h.context);
  const flat = node => [node,...node.children.flatMap(flat)];
  const nodes=flat(h.elements.get('admin-panel')), radios=nodes.filter(node=>node.tagName==='input'&&node.type==='radio');
  assert.equal(radios.length,3);assert.equal(radios.filter(node=>node.checked).length,1);assert.equal(radios.find(node=>node.checked).value,'in_progress');
  assert.ok(nodes.some(node=>node.tagName==='legend'&&node.textContent==='Request status'));assert.ok(!nodes.some(node=>node.tagName==='select'));
});
test('test login is explicit, uses challenge CSRF and renders test account restrictions', async () => {
  const responses = { '/api/user/session': { user: null, readiness: { google: { ready: false }, googleTest: { ready: true } } }, '/api/user/stations': { stations: [] }, '/api/user/test-login-challenge': { csrf: 'test-challenge' }, '/api/user/test-login': { ok: true }, '/api/user/rentals': { rentals: [] }, '/api/user/support': { support: [] } };
  const h = await harness('app.js', '/', responses);
  const button = h.elements.get('account-content').children.find(n => n.textContent === 'Continue with Google (test)');
  assert.ok(button); assert.match(text(h.elements.get('account-content')), /does not sign in to Google/);
  responses['/api/user/session'] = { user: { id: 'test_customer', name: 'Test customer', isTest: true }, csrf: 'session-csrf', readiness: {} };
  await button.events.click();
  const req = h.requests.find(r => r.path === '/api/user/test-login');
  assert.equal(req.options.headers['X-CSRF-Token'], 'test-challenge');
  assert.equal(req.options.body, '{}');
  assert.match(text(h.elements.get('account-content')), /TEST ACCOUNT/);
  assert.match(text(h.elements.get('account-content')), /hardware actions are disabled/);
  assert.ok(h.requests.some(r => r.path === '/api/user/support'));
});
