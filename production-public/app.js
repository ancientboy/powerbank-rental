'use strict';
const $ = (id) => document.getElementById(id);
let session = { user: null, readiness: {} };
let testState = null, quote = null, busy = false, clockOffset = 0, cameraStream = null, cameraTimer = null, sheetOpener = null;
const operationKeys = new Map();
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(session.csrf ? { 'X-CSRF-Token': session.csrf } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || 'Something went wrong. Please try again.'); error.status = response.status; throw error; }
  return data;
}
function notice(message) { $('notice').textContent = message; $('notice').classList.toggle('hidden', !message); }
function empty(title, detail) { const n = el('div', null, 'empty-state'); n.append(el('strong', title), el('span', detail)); return n; }
function money(value, currency = 'ARS') { const number = Number(value); return Number.isFinite(number) ? new Intl.NumberFormat('en-AR', { style: 'currency', currency }).format(number / 100) : 'Not set'; }
async function stations() {
  $('stations').classList.toggle('hidden', Boolean(session.user?.isTest));
  const button = $('refresh-stations'); button.disabled = true;
  try {
    const data = await api('/api/user/stations'); const list = $('station-list'); list.replaceChildren();
    const available = Array.isArray(data.stations) ? data.stations.filter(s => s.active !== false) : [];
    if (!available.length) list.append(empty('No stations available yet', 'Check back later.'));
    for (const station of available) { const card = el('article', null, 'card station-card'); card.append(el('span', '↯', 'station-icon'), el('h3', station.name), el('p', station.address || 'Address coming soon'), el('span', 'Rentals not yet available', 'badge pending')); list.append(card); }
    $('pricing').textContent = data.pricing ? `Planned pricing: ${money(data.pricing.hourlyRate, data.pricing.currency)} / hour · ${money(data.pricing.dailyCap, data.pricing.currency)} daily cap · ${money(data.pricing.deposit, data.pricing.currency)} deposit. Rentals are not yet available.` : '';
  } catch (error) { $('station-list').replaceChildren(empty('Stations could not be loaded.', 'Please refresh to try again.')); notice(error.message); } finally { button.disabled = false; }
}
function account() {
  $('support-privacy').textContent = session.user?.isTest ? 'Test messages are saved for administrators. Do not include personal or payment information.' : 'Do not include passwords or payment details.';
  const container = $('account-content'); container.replaceChildren();
  if (!session.user) {
    container.append(el('h3', 'Sign in'), el('p', 'Choose how to continue.'));
    if (session.readiness?.google?.ready) { const link = el('a', 'Continue with Google', 'button dark'); link.href = '/auth/google'; container.append(link); }
    else container.append(el('div', 'Google sign-in is unavailable', 'service-note'));
    if (session.readiness?.googleTest?.ready) {
      container.append(el('div', 'TEST · No real charge. This does not sign in to Google.', 'service-note'));
      const testLogin = el('button', 'Continue with Google (test)', 'button secondary');
      testLogin.type = 'button';
      testLogin.addEventListener('click', async () => {
        testLogin.disabled = true; notice('');
        try {
          const challenge = await api('/api/user/test-login-challenge');
          await api('/api/user/test-login', { method: 'POST', body: '{}', headers: { 'X-CSRF-Token': challenge.csrf } });
          session = await api('/api/user/session'); account(); await memberData(); $('rental-home').focus();
        } catch (error) { notice(error.message); testLogin.disabled = false; }
      });
      container.append(testLogin);
    }
    $('rental-home').classList.add('hidden'); $('account').classList.remove('hidden'); $('member-area').classList.add('hidden'); $('account-button').textContent = 'Sign in';
  } else {
    container.append(el('span', 'YOU’RE SIGNED IN', 'eyebrow'), el('h3', session.user.name || 'Your account'), el('p', session.user.email || ''));
    if (session.user.isTest) container.append(el('div', 'TEST ACCOUNT · No real charge. Real payments and hardware actions are disabled.', 'service-note'));
    const logout = el('button', 'Sign out', 'button secondary small'); logout.type = 'button'; logout.addEventListener('click', async () => { logout.disabled = true; try { await api('/api/user/logout', { method: 'POST', body: '{}' }); session = { ...session, user: null, csrf: null }; testState = null; quote = null; operationKeys.clear(); closeSheet(); account(); await stations(); $('rentals').replaceChildren(); $('support-history').replaceChildren(); } catch (error) { notice(error.message); logout.disabled = false; } }); container.append(logout);
    $('rental-home').classList.toggle('hidden', !session.user.isTest); $('account').classList.add('hidden'); $('member-area').classList.remove('hidden'); $('account-button').textContent = session.user.name || 'Sign in';
  }
}
async function memberData() {
  if (!session.user) return;
  if (session.user.isTest) await loadTestState();
  const results = await Promise.allSettled([api('/api/user/rentals'), api('/api/user/support')]);
  const rentals = $('rentals'); rentals.replaceChildren();
  if (session.user.isTest && testState) renderHistory(testState.rentals || []);
  else if (results[0].status === 'rejected') rentals.append(el('p', 'Your rentals could not be loaded. Please refresh the page.'));
  else { const rows = results[0].value.rentals || []; if (!rows.length) rentals.append(empty('No rentals yet', 'Real rentals are unavailable.')); for (const rental of rows) { const row = el('div', null, 'integration'); row.append(el('strong', rental.stationName || rental.stationId || 'Rental'), el('span', rental.status || 'Unknown', 'badge')); rentals.append(row); } }
  const support = $('support-history'); support.replaceChildren();
  if (results[1].status === 'rejected') support.append(el('p', 'Your support history could not be loaded.'));
  else for (const ticket of results[1].value.support || []) { const card = el('article', null, 'ticket'); card.append(el('span', ticket.status || 'Open', 'badge'), el('p', ticket.message)); if (ticket.reply) card.append(el('strong', 'voltgo support'), el('p', ticket.reply)); support.append(card); }
}
function action(label, handler, style = 'dark') {
  const button = el('button', label, `button ${style}`); button.type = 'button'; button.disabled = busy;
  button.addEventListener('click', handler); return button;
}
function showFlowError(error) { notice(error.message || 'Please try again.'); }
async function loadTestState() {
  try {
    const state = await api('/api/user/test/state');
    if (!session.user?.isTest) return;
    testState = state; clockOffset = Date.parse(state.serverNow) - Date.now();
    if (!Number.isFinite(clockOffset)) clockOffset = 0;
    renderFlow(); renderHistory(state.rentals || []);
  } catch (error) { showFlowError(error); if (!testState) $('rental-flow').replaceChildren(empty('Rental unavailable', 'Refresh to try again.'), action('Try again', loadTestState)); }
}
async function mutate(kind, body) {
  const identity = kind + ':' + JSON.stringify(body);
  if (!operationKeys.has(identity)) operationKeys.set(identity, crypto.randomUUID());
  try {
    const result = await api('/api/user/test/' + kind, { method: 'POST', headers: { 'Idempotency-Key': operationKeys.get(identity) }, body: JSON.stringify(body) });
    operationKeys.delete(identity); return result;
  } catch (error) { if (error.status && error.status < 500) operationKeys.delete(identity); throw error; }
}
async function transact(kind, body) {
  if (busy) return;
  busy = true; notice(''); renderFlow();
  try {
    const result = await mutate(kind, body);
    quote = null;
    if (kind === 'pay' && body.outcome === 'failure') notice('Test payment failed. Retry or cancel below. No money was charged.');
    if (kind === 'return') notice(`Test return complete. Settled: ${money(result.rental.totalAmount, result.rental.pricing?.currency)}. No real charge.`);
    if (kind === 'cancel') notice('Test rental canceled. No charge.');
    await loadTestState();
    if (kind === 'return') showReceipt(result.rental);
  } catch (error) { showFlowError(error); await loadTestState(); }
  finally { busy = false; renderFlow(); }
}
async function requestQuote(code) {
  if (busy) return;
  if (String(code).trim().toUpperCase() !== 'DEMO-001') { notice('Use DEMO-001. Only the demo station supports test rentals.'); return; }
  busy = true; notice(''); renderFlow();
  try { const result = await mutate('quote', { stationId: 'DEMO-001' }); quote = result.quote; }
  catch (error) { showFlowError(error); }
  finally { busy = false; renderFlow(); }
}
function priceSummary(pricing) {
  const card = el('div', null, 'price-summary');
  for (const [label, value] of [['Per started hour', pricing.hourlyRate], ['24-hour cap', pricing.dailyCap], ['Deposit', pricing.deposit]]) {
    const row = el('div'); row.append(el('span', label), el('strong', money(value, pricing.currency))); card.append(row);
  }
  return card;
}
function renderFlow() {
  if (!session.user?.isTest) return;
  $('stations').classList.add('hidden');
  const root = $('rental-flow'); root.replaceChildren();
  const rental = testState?.rental;
  const card = el('div', null, 'card rental-card'); root.append(card);
  if (rental?.status === 'active') {
    card.append(el('span', 'ACTIVE TEST RENTAL', 'eyebrow'), el('h2', 'You’re charging'), el('p', rental.stationName || 'Demo station'));
    const stats = el('div', null, 'rental-stats');
    for (const [label, id] of [['Duration', 'active-duration'], ['Estimated test total', 'active-cost']]) { const stat = el('div'); const value = el('strong', '…'); value.id = id; stat.append(el('span', label), value); stats.append(stat); }
    card.append(stats, priceSummary(rental.pricing), el('p', 'Clock starts after test payment. No physical power bank is released.', 'subtle'), action('Return demo power bank', () => confirmReturn(rental)));
    updateClock(); return;
  }
  if (rental?.status === 'pending_payment') {
    card.append(el('span', 'TEST CHECKOUT', 'eyebrow'), el('h2', 'Choose a test payment'), priceSummary(rental.pricing), el('p', 'No card required. Test authorization: ARS 0.00. Test total settles on return.'));
    const buttons = el('div', null, 'flow-actions');
    buttons.append(action('Test payment success / retry', () => transact('pay', { rentalId: rental.id, outcome: 'success' })), action('Test payment failure', () => transact('pay', { rentalId: rental.id, outcome: 'failure' }), 'secondary'), action('Cancel rental', () => transact('cancel', { rentalId: rental.id }), 'secondary')); card.append(buttons); return;
  }
  if (quote) {
    card.append(el('span', 'DEMO-001 · TEST QUOTE', 'eyebrow'), el('h2', 'Review your rental'), priceSummary(quote.pricing), el('p', 'Test prices only. Billed per started hour, with a one-hour minimum and a cap per 24 hours.', 'subtle'));
    const buttons = el('div', null, 'flow-actions');
    buttons.append(action('Continue to test payment', () => transact('rent', { quoteId: quote.id })), action('Back', () => { quote = null; renderFlow(); }, 'secondary')); card.append(buttons); return;
  }
  card.append(el('span', 'DEMO STATION', 'eyebrow'), el('h2', 'Start a test rental'), el('p', 'Scan a DEMO-001 QR code, enter its code, or try a mock scan.'));
  const buttons = el('div', null, 'flow-actions');
  buttons.append(action('Mock scan · DEMO-001', () => requestQuote('DEMO-001')), action('Scan with camera', startCamera, 'secondary')); card.append(buttons);
  const form = el('form'); const label = el('label', 'Station code'); label.setAttribute('for', 'station-code');
  const input = el('input'); input.id = 'station-code'; input.name = 'stationCode'; input.placeholder = 'DEMO-001'; input.maxLength = 40; input.required = true; input.autocomplete = 'off'; input.disabled = busy;
  const submit = el('button', 'Use code', 'button secondary'); submit.type = 'submit'; submit.disabled = busy;
  form.append(label, input, submit); form.addEventListener('submit', event => { event.preventDefault(); requestQuote(input.value); }); card.append(form);
}
function updateClock() {
  const rental = testState?.rental; if (rental?.status !== 'active') return;
  const elapsedMs = Math.max(0, Date.now() + clockOffset - Date.parse(rental.startedAt));
  const seconds = Math.floor(elapsedMs / 1000);
  const duration = $('active-duration'), cost = $('active-cost');
  if (duration) duration.textContent = `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m ${seconds % 60}s`;
  const hours = Math.max(1, Math.ceil(elapsedMs / 3600000));
  const days = Math.floor(hours / 24), remainder = hours % 24;
  const total = days * rental.pricing.dailyCap + Math.min(remainder * rental.pricing.hourlyRate, rental.pricing.dailyCap);
  if (cost) cost.textContent = money(total, rental.pricing.currency);
}
function renderHistory(rows) {
  const list = $('rentals'); list.replaceChildren();
  if (!rows.length) { list.append(empty('No rentals yet', 'Your test rentals will appear here.')); return; }
  for (const rental of rows) {
    const row = el('article', null, 'history-row');
    row.append(el('span', 'TEST', 'badge'), el('strong', rental.stationName || rental.stationId || 'Demo station'), el('span', { pending_payment: 'Awaiting test payment', active: 'Active', completed: 'Returned · settled', canceled: 'Canceled', cancelled: 'Canceled' }[rental.status] || rental.status));
    if (rental.status === 'completed') row.append(el('strong', money(rental.totalAmount, rental.pricing?.currency)), action('View receipt', () => showReceipt(rental), 'secondary small'));
    if (rental.createdAt) row.append(el('span', new Date(rental.createdAt).toLocaleString(), 'subtle')); list.append(row);
  }
}
function closeSheet() {
  if (cameraStream) { cameraStream.getTracks().forEach(track => track.stop()); cameraStream = null; }
  if (cameraTimer) { clearTimeout(cameraTimer); cameraTimer = null; }
  $('sheet-root').replaceChildren(); $('main-content').inert = false;
  if (document.body) document.body.style.overflow = '';
  sheetOpener?.focus?.(); sheetOpener = null;
}
function openSheet(title) {
  closeSheet(); sheetOpener = document.activeElement;
  const overlay = el('div', null, 'sheet-overlay'), sheet = el('section', null, 'rental-sheet');
  sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-labelledby', 'sheet-title'); sheet.tabIndex = -1;
  const heading = el('h2', title); heading.id = 'sheet-title';
  const dismiss = action('Close', closeSheet, 'secondary small'); dismiss.disabled = false;
  sheet.append(heading, dismiss); overlay.append(sheet);
  overlay.addEventListener('click', event => { if (event.target === overlay) closeSheet(); });
  sheet.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeSheet(); }
    if (event.key === 'Tab') { const focusable = [...sheet.querySelectorAll('button:not(:disabled),input,video[controls]')]; const first = focusable[0], last = focusable.at(-1); if (event.shiftKey && (document.activeElement === first || document.activeElement === sheet)) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === sheet)) { event.preventDefault(); first?.focus(); } }
  });
  $('sheet-root').append(overlay); $('main-content').inert = true;
  if (document.body) document.body.style.overflow = 'hidden'; sheet.focus(); return sheet;
}
function showReceipt(rental) {
  const sheet = openSheet('Test rental receipt');
  const seconds = rental.durationSeconds || 0;
  sheet.append(el('span', 'SETTLED · NO REAL CHARGE', 'badge'), el('p', rental.stationName || 'Demo station'));
  const details = el('div', null, 'price-summary');
  for (const [label, value] of [
    ['Started', rental.startedAt ? new Date(rental.startedAt).toLocaleString() : '—'],
    ['Returned', rental.returnedAt ? new Date(rental.returnedAt).toLocaleString() : '—'],
    ['Duration', `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m ${seconds % 60}s`],
    ['Test total', money(rental.totalAmount, rental.pricing?.currency)],
    ['Real charge', money(0, rental.pricing?.currency)]
  ]) { const row = el('div'); row.append(el('span', label), el('strong', value)); details.append(row); }
  sheet.append(details, el('p', 'Mock payment settled. No physical return or real payment occurred.', 'subtle'));
}
function confirmReturn(rental) {
  const sheet = openSheet('Return demo power bank?');
  sheet.append(el('p', 'This ends your test rental and settles the test total. No real charge.'), action('Confirm test return', () => { closeSheet(); transact('return', { rentalId: rental.id }); }));
}
async function startCamera() {
  if (!globalThis.BarcodeDetector || !globalThis.navigator?.mediaDevices?.getUserMedia) { notice('Camera scanning is unavailable in this browser. Enter DEMO-001 or use Mock scan.'); return; }
  const sheet = openSheet('Scan a demo QR code');
  const hint = el('p', 'Allow camera access to scan. Only DEMO-001 is supported.'); const video = el('video'); video.autoplay = true; video.muted = true; video.playsInline = true; sheet.append(hint, video);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    if (!sheet.isConnected) { stream.getTracks().forEach(track => track.stop()); return; }
    cameraStream = stream; video.srcObject = stream; await video.play();
    if (!sheet.isConnected) return;
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    const scan = async () => {
      if (!cameraStream || !sheet.isConnected) return;
      try { const codes = await detector.detect(video); if (!cameraStream || !sheet.isConnected) return; if (codes.length) { const value = codes[0].rawValue; closeSheet(); await requestQuote(value); return; } }
      catch { hint.textContent = 'Could not read a QR code. Close this window and enter DEMO-001.'; }
      if (cameraStream && sheet.isConnected) cameraTimer = setTimeout(scan, 400);
    }; scan();
  } catch { if (sheet.isConnected) { closeSheet(); notice('Camera access is unavailable. Enter DEMO-001 or use Mock scan.'); } }
}
window.addEventListener('pagehide', closeSheet);
if (typeof setInterval === 'function') setInterval(updateClock, 1000);
$('account-button').addEventListener('click', () => { if (session.user) $('account').classList.toggle('hidden'); else $('account').classList.remove('hidden'); $('account').scrollIntoView?.({ behavior: 'smooth' }); });
$('refresh-history').addEventListener('click', memberData);
$('refresh-stations').addEventListener('click', stations);
$('support-form').addEventListener('submit', async event => { event.preventDefault(); const button = event.currentTarget.querySelector('button'); const message = $('support-message').value.trim(); if (!message) return; button.disabled = true; $('support-status').textContent = 'Sending…'; try { await api('/api/user/support', { method: 'POST', body: JSON.stringify({ message }) }); $('support-message').value = ''; $('support-status').textContent = 'Message sent.'; await memberData(); } catch (error) { $('support-status').textContent = error.message; } finally { button.disabled = false; } });
(async () => {
  if (location.pathname === '/auth/error') { const code = new URLSearchParams(location.search).get('code'); const errors = { not_configured: 'Google sign-in is unavailable', google_not_configured: 'Google sign-in is unavailable', access_denied: 'Google sign-in was canceled. You can try again when you’re ready.', invalid_state: 'Your sign-in session expired. Please try again.', oauth_failed: 'Google sign-in could not be completed. Please try again.' }; notice(errors[code] || 'We couldn’t complete Google sign-in. Please try again or contact support.'); }
  try { session = await api('/api/user/session'); account(); await memberData(); $('rental-home').focus(); } catch (error) { $('account-content').replaceChildren(empty('Your account is unavailable.', 'Please refresh the page to try again.')); notice('We couldn’t check your sign-in status. Please refresh to try again.'); }
  await stations();
})();
