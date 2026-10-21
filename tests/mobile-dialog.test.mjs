import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Controller tests with a deliberately small DOM/history double, not rendered-browser QA.
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function harness() {
  const listeners = {}, windowListeners = {}, timers = [], requests = [], scrolls = [];
  const app = { inert: false, innerHTML: '' };
  const root = { _html: '', get innerHTML() { return this._html; }, set innerHTML(value) { this._html = value; this.childNodes = value ? [{ html: value }] : []; }, childNodes: [], querySelectorAll() { return []; }, replaceChildren(...nodes) { this.childNodes = nodes; this._html = nodes.map(n => n.html || '').join(''); }, addEventListener(type, fn) { listeners[`root:${type}`] = fn; } };
  const document = { activeElement: null, body: { style: { position: '', top: '', width: '', overflow: '' } }, visibilityState: 'visible',
    addEventListener(type, fn) { listeners[type] = fn; }, querySelectorAll() { return []; },
    querySelector(selector) { if (selector.includes('picker-value')) return document.chosen || null; if (selector === '#app') return app; if (selector === '#modal-root') return root; if (selector === '.modal' || selector === '.modal-overlay') return root.innerHTML ? dialog : null; return null; } };
  const element = () => ({ isConnected: true, focus() { document.activeElement = this; }, getClientRects() { return [{}]; }, closest() { return null; } });
  const opener = element(), first = element(), last = element(); document.activeElement = opener;
  const dialog = { ...element(), querySelectorAll() { return [first, last]; } };
  const history = { state: { original: true }, pushes: 0, backs: 0,
    pushState(state) { this.state = state; this.pushes++; }, replaceState(state) { this.state = state; }, back() { this.backs++; } };
  const window = { history, scrollY: 123, scrollTo(value) { scrolls.push(value); }, addEventListener(type, fn) { windowListeners[type] = fn; } };
  const context = vm.createContext({ document, window, history, location: { href: 'https://example.test/#stations', hash: '#stations' },
    setInterval(fn, delay) { timers.push({ fn, delay }); }, setTimeout() {}, clearTimeout() {}, clearInterval() {},
    fetch: async (...args) => { requests.push(args); return { ok: true, json: async () => ({ data: { serverTime: 0 }, result: {} }) }; },
    Event: class { constructor(type, options) { this.type = type; Object.assign(this, options); } }, crypto: { randomUUID: () => 'test-key' }, FormData: class { constructor(form) { return Object.entries(form.data || {}); } }, console });
  vm.runInContext(source.replace(/boot\(\);\s*$/, ''), context);
  const run = (code) => vm.runInContext(code, context);
  run('render = () => {}; toast = () => {}; state = { csrf: "csrf", activeRental: { id: "rental-1" } };');
  return { run, context, document, window, app, root, history, opener, dialog, first, last, listeners, windowListeners, requests, scrolls, timers };
}
test('customer scenario groups use labelled native radios, collapsed standard default, no native selects', () => {
  const h = harness();
  for (const kind of ['payment', 'pickup', 'return']) {
    const html = h.run(`scenarioSettings("${kind}")`);
    assert.doesNotMatch(html, /<select|<details[^>]+\bopen\b/);
    assert.equal((html.match(/ checked>/g) || []).length, 1);
    assert.match(html, /value="success" checked/);
    assert.match(html, /<fieldset/);
    assert.match(html, /<legend/);
  }
  assert.doesNotMatch(source, /<select[^>]+id="(?:return|payment|device)-scenario"/);
});
test('dialog locks background once, labels itself, restores scroll, focus and prior body styles', () => {
  const h = harness(); h.document.body.style.overflow = 'clip';
  h.run('modal("Return", "Body", {kind:"return"})');
  assert.equal(h.app.inert, true); assert.equal(h.document.body.style.position, 'fixed');
  assert.equal(h.document.body.style.top, '-123px'); assert.equal(h.document.activeElement, h.dialog);
  assert.match(h.root.innerHTML, /aria-modal="true" aria-labelledby="dialog-title"/);
  h.run('modal("Replacement", "Body")'); assert.equal(h.history.pushes, 1);
  h.run('closeModal({navigation:true})'); assert.equal(h.app.inert, false);
  assert.equal(h.document.body.style.position, ''); assert.equal(h.document.body.style.overflow, 'clip');
  assert.equal(h.document.activeElement, h.opener); assert.equal(h.scrolls.at(-1).top, 123);
  assert.equal(h.root.innerHTML, ''); assert.equal(h.requests.length, 0);
});
test('Tab and Shift-Tab wrap; Escape cancels without a network action', () => {
  const h = harness(); h.run('modal("Return", "Body")');
  let prevented = 0;
  const key = (key, shiftKey = false) => h.listeners.keydown({ key, shiftKey, preventDefault() { prevented++; } });
  key('Tab'); assert.equal(h.document.activeElement, h.first);
  key('Tab', true); assert.equal(h.document.activeElement, h.last);
  key('Tab'); assert.equal(h.document.activeElement, h.first);
  key('Escape'); assert.equal(h.root.innerHTML, ''); assert.equal(h.requests.length, 0); assert.equal(h.history.backs, 1);
  assert.equal(prevented, 4);
});
test('backdrop, browser Back and pagehide release dialog locks without mutation', () => {
  for (const trigger of ['backdrop', 'popstate', 'pagehide']) {
    const h = harness(); h.run('modal("Return", "Body")');
    if (trigger === 'backdrop') h.listeners['root:click']({ target: { classList: { contains: v => v === 'modal-overlay' } } });
    else h.windowListeners[trigger]();
    assert.equal(h.root.innerHTML, ''); assert.equal(h.app.inert, false);
    assert.equal(h.document.body.style.position, ''); assert.equal(h.requests.length, 0);
  }
});
test('changing a scenario only changes local selection; confirm sends chosen return exactly once', async () => {
  const h = harness(); h.run('modal("Return", "Body")');
  h.listeners.change({ target: { dataset: { scenarioKind: 'return' }, value: 'wrong_bank', closest() { return null; } } });
  assert.equal(h.requests.length, 0);
  const event = { target: { id: 'return-form', dataset: { station: 'station-1' }, data: { scenario: 'wrong_bank' } }, preventDefault() {} };
  await Promise.all([h.listeners.submit(event), h.listeners.submit(event)]);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(JSON.parse(h.requests[0][1].body), { action: 'return', rentalId: 'rental-1', stationId: 'station-1', scenario: 'wrong_bank' });
});
test('six-second refresh skips an open dialog and rejects a response arriving after it opens', async () => {
  const h = harness(); h.run('view = "active"; rental = () => ({id:"rental-1"}); modal("Return", "Body")');
  const poll = h.timers.find(t => t.delay === 6000).fn;
  await poll(); assert.equal(h.requests.length, 0);
  h.run('closeModal({navigation:true})');
  let resolve;
  h.context.fetch = () => new Promise(r => { resolve = r; });
  const pending = poll(); h.run('modal("Return", "Body")');
  resolve({ ok: true, json: async () => ({ data: { csrf: 'stale', serverTime: 0 } }) });
  await pending;
  assert.equal(h.run('state.csrf'), 'csrf'); assert.notEqual(h.root.innerHTML, '');
});
test('reopening while dismissal Back is pending queues rather than losing new dialog', () => {
  const h = harness(); h.run('modal("First", "Body"); closeModal(); modal("Second", "Body")');
  assert.equal(h.history.pushes, 1); assert.equal(h.root.innerHTML, '');
  h.history.state = { original: true }; h.windowListeners.popstate();
  assert.equal(h.history.pushes, 2); assert.match(h.root.innerHTML, /Second/);
  assert.equal(h.app.inert, true);
  h.run('closeModal({navigation:true})'); assert.equal(h.app.inert, false);
});
test('nested picker dismissal restores exact parent DOM nodes and their unsaved values', () => {
  const h = harness(); h.run('modal("Parent", "Form")');
  const parent = h.root.childNodes[0]; parent.unsavedValue = 'Keep my drafted reason';
  h.run('modal("Picker", "Choices", {nested:true})');
  assert.equal(h.history.pushes, 2); assert.notEqual(h.root.childNodes[0], parent);
  h.run('closeModal()');
  assert.equal(h.root.childNodes[0], parent); assert.equal(parent.unsavedValue, 'Keep my drafted reason');
  assert.equal(h.app.inert, true); assert.equal(h.document.body.style.position, 'fixed');
  h.history.state = { original: true, voltgoModal: true }; h.windowListeners.popstate();
  assert.equal(h.root.childNodes[0], parent); assert.equal(h.app.inert, true);
  h.run('closeModal({navigation:true})'); assert.equal(h.app.inert, false);
});
test('picker apply updates original form select exactly once, while cancel and disabled option do not', () => {
  const h = harness(); let changes = 0;
  const select = { value: 'original', options: [{ value: 'original' }, { value: 'replacement' }, { value: 'disabled', disabled: true }], dispatchEvent(event) { assert.equal(event.type, 'change'); changes++; } };
  h.context.selectTarget = select;
  h.run('modal("Choose", "Options"); selectorTarget = { select: selectTarget };');
  h.document.chosen = { value: '2' }; h.run('applyPicker()'); assert.equal(select.value, 'original'); assert.equal(changes, 0);
  h.run('closeModal({navigation:true})'); assert.equal(select.value, 'original'); assert.equal(changes, 0);
  h.run('modal("Choose", "Options"); selectorTarget = { select: selectTarget };');
  h.document.chosen = { value: '1' }; h.run('applyPicker(); applyPicker()');
  assert.equal(select.value, 'replacement'); assert.equal(changes, 1); assert.equal(h.requests.length, 0);
});
test('navigation requested during pending Back waits, then closes cleanly without reopening stale dialog', () => {
  const h = harness(); h.run('modal("First", "Body"); closeModal(); modal("Stale", "Body"); go("profile")');
  assert.equal(h.run('view'), 'home');
  h.history.state = { original: true }; h.windowListeners.popstate();
  assert.equal(h.run('view'), 'profile'); assert.equal(h.root.innerHTML, '');
  assert.equal(h.app.inert, false); assert.equal(h.document.body.style.position, '');
});
test('repeated nested dismissal cannot overshoot history while Back is pending', () => {
  const h = harness(); h.run('modal("Parent", "Form"); modal("Picker", "Options", {nested:true}); closeModal(); closeModal(); closeModal()');
  assert.equal(h.history.backs, 1); assert.match(h.root.innerHTML, /Parent/); assert.equal(h.app.inert, true);
  h.history.state = { voltgoModal: true }; h.windowListeners.popstate();
  assert.match(h.root.innerHTML, /Parent/);
});
test('generic select enhancement retains original field, named current value and no browser select trigger', () => {
  const h = harness(); let button, changeHandler;
  h.document.createElement = () => button = { dataset: {}, attributes: {}, setAttribute(k,v) { this.attributes[k] = v; }, addEventListener(type, fn) { this[type] = fn; } };
  const select = { dataset: {}, disabled: false, value: 'rental', name: 'category', labels: [{ childNodes: [{ nodeType: 3, textContent: 'What can we help with?' }] }],
    options: [{ textContent: 'Rental', value: 'rental', selected: true }], selectedOptions: [{ textContent: 'Rental', value: 'rental' }],
    classList: { add(value) { this.value = value; } }, setAttribute(k,v) { this[k] = v; }, getAttribute() { return null; }, closest() { return null; },
    addEventListener(type, fn) { if (type === 'change') changeHandler = fn; }, insertAdjacentElement(where, el) { assert.equal(where, 'afterend'); assert.equal(el, button); } };
  h.context.selectContainer = { querySelectorAll() { return [select]; } };
  h.run('enhanceSelects(selectContainer)');
  assert.equal(select.name, 'category'); assert.equal(select.value, 'rental'); assert.equal(select.tabIndex, -1);
  assert.equal(select.classList.value, 'native-select-value'); assert.equal(select['aria-hidden'], 'true');
  assert.equal(button.type, 'button'); assert.match(button.attributes['aria-label'], /What can we help with.*Rental/);
  assert.equal(button.attributes['aria-haspopup'], 'dialog'); assert.equal(h.requests.length, 0);
  select.selectedOptions = [{ textContent: 'Refund' }]; changeHandler(); assert.match(button.attributes['aria-label'], /Refund/);
});
