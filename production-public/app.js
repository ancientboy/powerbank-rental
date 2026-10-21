'use strict';
const $ = (id) => document.getElementById(id);
let session = { user: null, readiness: {} };
let testState = null, quote = null, busy = false, clockOffset = 0, cameraStream = null, cameraTimer = null, sheetOpener = null;
const operationKeys = new Map();
let navigationVersion = 0, afterLogin = 'home', scanAfterLogin = false, paymentMethod = 'card';
let view = 'home', stationData = { stations: [], pricing: null };
const screens = { home: 'home-screen', stations: 'stations', history: 'member-area', profile: 'account', support: 'support-screen', scan: 'rental-home' };
const navigation = { 'brand-home': 'home', 'desktop-home': 'home', 'desktop-stations': 'stations', 'desktop-history': 'history', 'desktop-support': 'support', 'mobile-home': 'home', 'mobile-stations': 'stations', 'mobile-history': 'history', 'mobile-profile': 'profile', 'profile-history': 'history', 'profile-stations': 'stations', 'profile-support': 'support', 'home-stations': 'stations', 'footer-help': 'support', 'rental-back': 'home' };
function showScreen() {
  for (const [name, id] of Object.entries(screens)) $(id).classList.toggle('hidden', name !== view);
  const selected = view === 'scan' ? 'home' : view;
  for (const [id, target] of Object.entries(navigation)) {
    $(id).classList.toggle('current', target === selected);
    $(id).setAttribute('aria-current', target === selected ? 'page' : 'false');
  }
  $('account-button').setAttribute('aria-current', selected === 'profile' ? 'page' : 'false');
}
function navigate(next, updateHash = true) {
  closeSheet(); navigationVersion++;
  view = Object.hasOwn(screens, next) ? next : 'home';
  if (view === 'scan' && !session.user?.isTest) { afterLogin = 'scan'; view = 'profile'; }
  if (view === 'support' && !session.user) view = 'profile';
  showScreen();
  if (updateHash && location.hash !== '#' + view) location.hash = view;
  if (updateHash) window.scrollTo?.({ top: 0, behavior: 'instant' });
  if (view === 'stations') renderStations();
}
function startRental() {
  if (!session.user?.isTest) { scanAfterLogin = true; navigate('scan'); return; }
  navigate('scan');
  if (!testState?.rental && !quote) return startCamera();
}
function refreshHome() {
  $('home-scan-label').textContent = testState?.rental ? 'View current rental' : quote ? 'Continue rental' : 'Scan to rent';
  const first = stationData.stations?.[0], summary = $('home-station'); summary.replaceChildren();
  if (first) summary.append(el('strong', first.name, 'home-station-name'), el('p', first.address || 'Address coming soon'), el('p', session.user?.isTest ? `${first.available ?? 0} ready for a test rental · No physical device` : 'Real rentals are not yet available.'));
  else summary.append(el('p', 'No stations available yet.'));
  $('home-price').textContent = stationData.pricing ? money(stationData.pricing.hourlyRate, stationData.pricing.currency) + ' / hour' : '—';
  $('home-pricing-note').textContent = session.user?.isTest ? 'Test pricing only. No real charge.' : (!session.user && session.readiness?.googleTest?.ready) ? 'Sign in to try a test rental. You won’t be charged.' : 'Real rentals are not yet available.';
}
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
  const button = $('refresh-stations'); button.disabled = true;
  try {
    const isTest = Boolean(session.user?.isTest); const data = await api(isTest ? '/api/user/test/stations' : '/api/user/stations'); if (isTest !== Boolean(session.user?.isTest)) return; stationData = data; refreshHome(); renderStations();
  } catch (error) { $('station-list').replaceChildren(empty('Stations could not be loaded.', 'Please refresh to try again.')); notice(error.message); } finally { button.disabled = false; }
}
function renderStations() {
  const data = stationData, isTest = Boolean(session.user?.isTest);
  const list = $('station-list'); list.replaceChildren();
    const available = Array.isArray(data.stations) ? data.stations.filter(s => s.active !== false) : [];
    if (!available.length) list.append(empty('No stations available yet', 'Check back later.'));
    for (const station of available) { const card = el('article', null, 'card station-card'); card.append(el('span', '↯', 'station-icon'), el('h3', station.name), el('p', station.address || 'Address coming soon'), el('span', isTest ? `${station.available ?? 0} available · TEST` : 'Rentals not yet available', 'badge pending')); if (isTest) card.append(action(testState?.rental?.status === 'active' ? 'Return here · TEST' : testState?.rental ? 'View current rental' : 'Rent here · TEST', () => { if (testState?.rental?.status === 'active') confirmReturn(testState.rental); else if (testState?.rental) navigate('scan'); else requestQuote(station.id); })); list.append(card); }
    $('pricing').textContent = data.pricing ? `${isTest ? 'Test' : 'Planned'} pricing: ${money(data.pricing.hourlyRate, data.pricing.currency)} / hour · ${money(data.pricing.dailyCap, data.pricing.currency)} daily cap · ${money(data.pricing.deposit, data.pricing.currency)} deposit. ${isTest ? 'No real charge.' : 'Rentals are not yet available.'}` : '';
}
function account() {
  const testExperience = Boolean(session.user?.isTest || (!session.user && session.readiness?.googleTest?.ready));
  $('experience-label').textContent = testExperience ? 'TEST EXPERIENCE' : 'CHARGE ON THE GO';
  $('experience-detail').textContent = testExperience ? '· No real charges or physical devices.' : '· Real rentals are not yet available.';
  $('footer-label').textContent = testExperience ? '© 2026 voltgo · TEST EXPERIENCE' : '© 2026 voltgo';
  $('home-mode-note').textContent = testExperience ? 'Test experience. No real payments or devices.' : 'Real rentals are not yet available.';
  $('home-scan-note').textContent = testExperience ? 'Try a test rental. No power bank is released.' : 'Explore stations. Real rentals are not yet available.';
  $('home-price-label').textContent = session.user?.isTest ? 'SIMPLE TEST PRICING' : 'PLANNED PRICING';
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
        testLogin.disabled = true; notice(''); const loginNavigation = navigationVersion;
        try {
          const challenge = await api('/api/user/test-login-challenge');
          await api('/api/user/test-login', { method: 'POST', body: '{}', headers: { 'X-CSRF-Token': challenge.csrf } });
          session = await api('/api/user/session'); account(); if (navigationVersion === loginNavigation) navigate(afterLogin); afterLogin = 'home'; const landedNavigation = navigationVersion; await memberData(); await stations(); if (navigationVersion === landedNavigation && view === 'home' && testState?.rental) navigate('scan'); if (navigationVersion === landedNavigation && view === 'scan' && scanAfterLogin && !testState?.rental && !quote) { scanAfterLogin = false; await startCamera(); } else scanAfterLogin = false;
        } catch (error) { notice(error.message); testLogin.disabled = false; }
      });
      container.append(testLogin);
    }
    $('account-button').textContent = '↗'; $('account-button').setAttribute('aria-label', 'Sign in to your account'); $('rentals').replaceChildren(empty('Your story starts with a scan.', 'Sign in to see your rentals.'), action('Sign in', () => navigate('profile')));
  } else {
    container.append(el('span', 'YOU’RE SIGNED IN', 'eyebrow'), el('h3', session.user.name || 'Your account'), el('p', session.user.email || ''));
    if (session.user.isTest) container.append(el('div', 'TEST ACCOUNT · No real charge. Real payments and hardware actions are disabled.', 'service-note'));
    const logout = el('button', 'Sign out', 'button secondary small'); logout.type = 'button'; logout.addEventListener('click', async () => { logout.disabled = true; try { await api('/api/user/logout', { method: 'POST', body: '{}' }); session = { ...session, user: null, csrf: null }; testState = null; quote = null; operationKeys.clear(); closeSheet(); account(); navigate('home'); await stations(); $('support-history').replaceChildren(); } catch (error) { notice(error.message); logout.disabled = false; } }); container.append(logout);
    $('account-button').textContent = (session.user.name || 'U').charAt(0); $('account-button').setAttribute('aria-label', 'Your account');
  }
  showScreen();
}
async function memberData() {
  if (!session.user) return;
  const member = session.user;
  if (session.user.isTest) await loadTestState();
  const results = await Promise.allSettled([api('/api/user/rentals'), api('/api/user/support')]);
  if (session.user !== member) return;
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
    renderFlow(); renderHistory(state.rentals || []); refreshHome();
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
  const startedNavigation = navigationVersion;
  busy = true; notice(''); renderFlow();
  try {
    const result = await mutate(kind, body);
    quote = null;
    if (kind === 'pay' && body.outcome === 'failure') notice('Test payment failed. Retry or cancel below. No money was charged.');
    if (kind === 'return') notice(`Test return complete. Rental fee: ${money(result.rental.totalAmount, result.rental.pricing?.currency)}. No real charge.`);
    if (kind === 'pay' && body.outcome === 'success') notice('Test deposit paid. Waiting for simulated pickup. The rental clock has not started.');
    if (kind === 'pickup') notice(body.outcome === 'success' ? 'Simulated pickup confirmed. Your rental clock has started.' : 'Simulated pickup failed. Your full test deposit was refunded.');
    if (kind === 'cancel') notice(result.rental.depositPaid > 0 ? 'Test rental canceled. Your full test deposit was refunded.' : 'Test rental canceled. No charge.');
    await loadTestState();
    if ((kind === 'return' || (['cancel', 'pickup'].includes(kind) && result.rental.depositPaid > 0 && result.rental.status === 'cancelled')) && navigationVersion === startedNavigation) showReceipt(result.rental);
  } catch (error) { showFlowError(error); await loadTestState(); }
  finally { busy = false; renderFlow(); }
}
async function requestQuote(code) {
  if (busy) return;
  if (String(code).trim().toUpperCase() !== 'DEMO-001') { notice('Use DEMO-001. Only the demo station supports test rentals.'); return; }
  navigate('scan'); busy = true; notice(''); renderFlow();
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
  refreshHome();
  if (!session.user?.isTest) return;
  const root = $('rental-flow'); root.replaceChildren();
  const rental = testState?.rental;
  const heading = el('div', null, 'rental-page-heading');
  const title = rental?.status === 'active' ? 'You’re all charged up.' : rental?.status === 'awaiting_pickup' ? 'Ready when you are.' : rental?.status === 'pending_payment' ? 'Pick your way to pay.' : quote ? 'Your next charge.' : 'A quick scan. A full day ahead.';
  heading.append(el('h1', title), el('p', rental?.status === 'active' ? 'A little power. Wherever your day takes you.' : 'Test experience. No real payment or device.')); root.append(heading);
  const card = el('div', null, 'card rental-card'); root.append(card);
  if (rental?.status === 'active') {
    card.classList.add('rental-active-panel');
    card.append(el('span', 'ACTIVE TEST RENTAL', 'eyebrow'), el('h2', 'You’re charging'), el('p', rental.stationName || 'Demo station'));
    const stats = el('div', null, 'rental-stats');
    for (const [label, id] of [['Duration', 'active-duration'], ['Estimated test total', 'active-cost']]) { const stat = el('div'); const value = el('strong', '…'); value.id = id; stat.append(el('span', label), value); stats.append(stat); }
    const battery = el('div', 'ϟ', 'battery-illustration rental-active-art'); card.append(battery);
    card.append(stats, priceSummary(rental.pricing), el('p', rental.legacy ? 'Legacy test rental: original rates preserved. No deposit was collected.' : 'Clock started at confirmed pickup. The rental fee is deducted from your test deposit on return.', 'subtle'), action('Return demo power bank', () => confirmReturn(rental)));
    card.append(action('Find a return station', () => navigate('stations'), 'secondary')); updateClock(); return;
  }
  if (rental?.status === 'awaiting_pickup') {
    card.append(el('span', 'TEST DEPOSIT PAID', 'eyebrow'), el('h2', 'Waiting for pickup'), el('p', `Test deposit: ${money(rental.depositPaid, rental.pricing.currency)}. The rental clock has not started.`), el('p', 'No real hardware is connected. Confirm simulated pickup to start billing, or cancel for a full test deposit refund.', 'subtle'));
    const buttons = el('div', null, 'flow-actions');
    buttons.append(action('Simulate pickup', () => transact('pickup', { rentalId: rental.id, outcome: 'success' })), action('Simulate pickup failure', () => transact('pickup', { rentalId: rental.id, outcome: 'failure' }), 'secondary'), action('Cancel and refund deposit', () => transact('cancel', { rentalId: rental.id }), 'secondary')); card.append(buttons); return;
  }
  if (rental?.status === 'pending_payment') {
    card.append(el('span', 'TEST CHECKOUT', 'eyebrow'), el('h2', 'Choose a test payment'), priceSummary(rental.pricing));
    if (rental.legacy) {
      card.append(el('p', 'This older zero-deposit quote is no longer payable. Cancel it and scan again to review the current test deposit and rates.'), action('Cancel old quote', () => transact('cancel', { rentalId: rental.id }))); return;
    }
    card.append(el('p', 'Pay a refundable test deposit for this rental only. Billing starts after simulated pickup. On return, the fee is deducted and the remainder refunded. No real payment details are collected. If payment fails, use Pay test deposit to retry.'));
    const methods = el('fieldset'); methods.style.border = '0'; methods.style.padding = '0'; methods.style.margin = '0'; methods.append(el('legend', 'Test payment method')); methods.setAttribute('role', 'radiogroup');
    const choices = [];
    for (const [value, title] of [['card', 'Debit / credit card'], ['google_pay', 'Google Pay'], ['bank_transfer', 'Bank transfer']]) {
      const option = el('button', null, 'payment-option'); option.type = 'button'; option.disabled = busy; option.setAttribute('role', 'radio');
      const copy = el('span', null, 'grow'); copy.append(el('strong', title), el('span', 'Mock payment only', 'small muted'));
      const radio = el('span', null, 'radio'); radio.setAttribute('aria-hidden', 'true'); option.append(copy, radio);
      const select = () => { paymentMethod = value; for (const [button, key] of choices) { button.classList.toggle('selected', key === value); button.setAttribute('aria-checked', String(key === value)); button.tabIndex = key === value ? 0 : -1; } };
      option.addEventListener('click', select);
      option.addEventListener('keydown', event => { if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) { event.preventDefault(); const index = choices.findIndex(([button]) => button === option); const target = choices[(index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : choices.length - 1)) % choices.length][0]; target.click(); target.focus(); } });
      choices.push([option, value]); option.classList.toggle('selected', value === paymentMethod); option.setAttribute('aria-checked', String(value === paymentMethod)); option.tabIndex = value === paymentMethod ? 0 : -1; methods.append(option);
    }
    card.append(methods, el('p', 'Simulated methods only. No provider, bank or card is contacted.', 'subtle'));
    const buttons = el('div', null, 'flow-actions');
    buttons.append(action(`Pay test deposit · ${money(rental.pricing.deposit, rental.pricing.currency)}`, () => transact('pay', { rentalId: rental.id, outcome: 'success', paymentMethod })), action('Simulate payment failure', () => transact('pay', { rentalId: rental.id, outcome: 'failure', paymentMethod }), 'secondary'), action('Cancel rental', () => transact('cancel', { rentalId: rental.id }), 'secondary')); card.append(buttons); return;
  }
  if (quote) {
    card.append(el('span', 'DEMO-001 · TEST QUOTE', 'eyebrow'), el('h2', 'Review your rental'), priceSummary(quote.pricing), el('p', 'Illustrative test prices only. Pay the deposit before pickup. Billed from confirmed pickup per started hour, with a one-hour minimum and a cap per 24 hours. The fee is deducted on return; the remainder is refunded.', 'subtle'));
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
    row.append(el('span', 'TEST', 'badge'), el('strong', rental.stationName || rental.stationId || 'Demo station'), el('span', { pending_payment: 'Awaiting test deposit', awaiting_pickup: 'Deposit paid · awaiting pickup', active: 'Active', completed: ['review_required', 'legacy_review'].includes(rental.settlementStatus) ? 'Returned · review required' : 'Returned · settled', canceled: 'Canceled', cancelled: 'Canceled' }[rental.status] || rental.status));
    if (['active', 'pending_payment', 'awaiting_pickup'].includes(rental.status)) row.append(action('View current rental', () => navigate('scan'), 'secondary small'));
    if (rental.depositPaid > 0) row.append(el('span', `Test deposit: ${money(rental.depositPaid, rental.pricing?.currency)}`));
    if (rental.status === 'completed' || rental.status === 'cancelled') { row.append(el('strong', `Rental fee: ${money(rental.totalAmount, rental.pricing?.currency)}`), el('span', rental.legacy ? 'Legacy rental · no deposit collected' : `Test refund: ${money(rental.refundAmount || 0, rental.pricing?.currency)} · ${settlementLabel(rental)}`), action('View receipt', () => showReceipt(rental), 'secondary small')); }
    if (rental.createdAt) row.append(el('span', new Date(rental.createdAt).toLocaleString(), 'subtle')); list.append(row);
  }
}
function closeSheet() {
  if (cameraStream) { cameraStream.getTracks().forEach(track => track.stop()); cameraStream = null; }
  if (cameraTimer) { clearTimeout(cameraTimer); cameraTimer = null; }
  $('sheet-root').replaceChildren(); $('customer-shell').inert = false; $('main-content').inert = false;
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
  $('sheet-root').append(overlay); $('customer-shell').inert = true; $('main-content').inert = true;
  if (document.body) document.body.style.overflow = 'hidden'; sheet.focus(); return sheet;
}
function settlementLabel(rental) {
  return ({ unpaid: 'Not paid', deposit_held: 'Deposit held until return', settled: rental.refundAmount > 0 ? (rental.refundId ? 'Refund completed · TEST' : 'Refund confirmation pending · TEST') : 'Settled · no refund due', review_required: 'Additional amount due · not charged', legacy_review: 'Legacy · no deposit collected' })[rental.settlementStatus] || 'Not due';
}
function showReceipt(rental) {
  const sheet = openSheet('Test rental receipt');
  const seconds = rental.durationSeconds || 0;
  sheet.append(el('span', ['review_required', 'legacy_review'].includes(rental.settlementStatus) ? 'REVIEW REQUIRED · NO REAL CHARGE' : 'TEST RECEIPT · NO REAL CHARGE', 'badge'), el('p', rental.stationName || 'Demo station'));
  const details = el('div', null, 'price-summary');
  for (const [label, value] of [
    ['Started', rental.startedAt ? new Date(rental.startedAt).toLocaleString() : '—'],
    ['Returned', rental.returnedAt ? new Date(rental.returnedAt).toLocaleString() : '—'],
    ['Duration', `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m ${seconds % 60}s`],
    ['Test payment method', ({ card: 'Debit / credit card · mock', google_pay: 'Google Pay · mock', bank_transfer: 'Bank transfer · mock' })[rental.paymentMethod] || 'Mock payment'],
    ['Test deposit paid', money(rental.depositPaid || 0, rental.pricing?.currency)],
    ['Rental fee', money(rental.totalAmount, rental.pricing?.currency)],
    ['Deducted from deposit', money(rental.depositApplied || 0, rental.pricing?.currency)],
    ['Test deposit refund', money(rental.refundAmount || 0, rental.pricing?.currency)],
    ['Refund / settlement status', rental.legacy ? 'Legacy · no deposit collected' : settlementLabel(rental)],
    ...(rental.outstandingAmount > 0 ? [['Balance due', money(rental.outstandingAmount, rental.pricing?.currency)]] : []),
    ['Real charge', money(0, rental.pricing?.currency)]
  ]) { const row = el('div'); row.append(el('span', label), el('strong', value)); details.append(row); }
  sheet.append(details, el('p', rental.legacy ? 'Legacy test rental: original rates preserved. No deposit was collected or refunded, and no additional payment was charged.' : 'Mock settlement only. No physical return or real payment occurred.', 'subtle'));
}
function confirmReturn(rental) {
  const sheet = openSheet('Return demo power bank?');
  sheet.append(el('p', rental.legacy ? 'End this legacy test rental at its original rates. No deposit was collected and no real charge will occur.' : 'End your test rental, deduct the rental fee from your test deposit and refund the remainder. Any fee above the deposit will be shown separately. No real charge.'), action('Confirm test return', () => { closeSheet(); transact('return', { rentalId: rental.id }); }));
}
async function startCamera() {
  if (!globalThis.BarcodeDetector || !globalThis.navigator?.mediaDevices?.getUserMedia) { notice('Camera scanning is unavailable in this browser. Enter DEMO-001 or use Mock scan.'); return; }
  const sheet = openSheet('Scan a demo QR code');
  const hint = el('p', 'Allow camera access to scan. Only DEMO-001 is supported.'); const video = el('video'); video.autoplay = true; video.muted = true; video.playsInline = true; sheet.append(hint, video);
  sheet.append(action('Mock scan · DEMO-001', () => requestQuote('DEMO-001'), 'secondary'));
  const manual = el('form'), label = el('label', 'Station code'); label.setAttribute('for', 'camera-station-code');
  const input = el('input'); input.id = 'camera-station-code'; input.placeholder = 'DEMO-001'; input.maxLength = 40; input.required = true;
  const submit = el('button', 'Use code', 'button secondary'); submit.type = 'submit';
  manual.append(label, input, submit); manual.addEventListener('submit', event => { event.preventDefault(); requestQuote(input.value); }); sheet.append(manual);
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
for (const [id, target] of Object.entries(navigation)) $(id).addEventListener('click', () => navigate(target));
$('account-button').addEventListener('click', () => navigate('profile'));
$('home-scan').addEventListener('click', startRental);
$('home-code').addEventListener('click', () => { scanAfterLogin = false; navigate('scan'); });
window.addEventListener('hashchange', () => { const next = String(location.hash || '#home').slice(1); if (next !== view) navigate(next, false); });
window.addEventListener('popstate', closeSheet);
$('refresh-history').addEventListener('click', memberData);
$('refresh-stations').addEventListener('click', stations);
$('support-form').addEventListener('submit', async event => { event.preventDefault(); const button = event.currentTarget.querySelector('button'); const message = $('support-message').value.trim(); if (!message) return; button.disabled = true; $('support-status').textContent = 'Sending…'; try { await api('/api/user/support', { method: 'POST', body: JSON.stringify({ message }) }); $('support-message').value = ''; $('support-status').textContent = 'Message sent.'; await memberData(); } catch (error) { $('support-status').textContent = error.message; } finally { button.disabled = false; } });
(async () => {
  if (location.pathname === '/auth/error') { const code = new URLSearchParams(location.search).get('code'); const errors = { not_configured: 'Google sign-in is unavailable', google_not_configured: 'Google sign-in is unavailable', access_denied: 'Google sign-in was canceled. You can try again when you’re ready.', invalid_state: 'Your sign-in session expired. Please try again.', oauth_failed: 'Google sign-in could not be completed. Please try again.' }; notice(errors[code] || 'We couldn’t complete Google sign-in. Please try again or contact support.'); }
  try { session = await api('/api/user/session'); account(); navigate(String(location.hash || '#home').slice(1), false); const initialNavigation = navigationVersion; await memberData(); if (navigationVersion === initialNavigation && !location.hash && view === 'home' && testState?.rental) navigate('scan'); } catch (error) { $('account-content').replaceChildren(empty('Your account is unavailable.', 'Please refresh the page to try again.')); notice('We couldn’t check your sign-in status. Please refresh to try again.'); }
  await stations();
})();
