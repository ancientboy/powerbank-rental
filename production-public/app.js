'use strict';
const $ = (id) => document.getElementById(id);
let session = { user: null, readiness: {} };
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
    const data = await api('/api/user/stations'); const list = $('station-list'); list.replaceChildren();
    const available = Array.isArray(data.stations) ? data.stations.filter(s => s.active !== false) : [];
    if (!available.length) list.append(empty('Good energy is on its way.', 'There are no stations available yet. Check back as the network grows.'));
    for (const station of available) { const card = el('article', null, 'card station-card'); card.append(el('span', '↯', 'station-icon'), el('h3', station.name), el('p', station.address || 'Address coming soon'), el('span', 'Rentals not yet available', 'badge pending')); list.append(card); }
    $('pricing').textContent = data.pricing ? `Planned pricing: ${money(data.pricing.hourlyRate, data.pricing.currency)} / hour · ${money(data.pricing.dailyCap, data.pricing.currency)} daily cap · ${money(data.pricing.deposit, data.pricing.currency)} deposit. Rentals are not yet available.` : '';
  } catch (error) { $('station-list').replaceChildren(empty('Stations could not be loaded.', 'Please refresh to try again.')); notice(error.message); } finally { button.disabled = false; }
}
function account() {
  const container = $('account-content'); container.replaceChildren();
  if (!session.user) {
    container.append(el('h3', 'Welcome to your next charge.'), el('p', 'Sign in securely with your Google account.'));
    if (session.readiness?.google?.ready) { const link = el('a', 'Continue with Google', 'button dark'); link.href = '/auth/google'; container.append(link); }
    else container.append(el('div', 'Google sign-in is not configured yet', 'service-note'));
    if (session.readiness?.googleTest?.ready) {
      container.append(el('div', 'Test mode only. This does not sign in to Google. Test support messages are saved for administrators; do not enter personal information. Payments and hardware actions remain disabled.', 'service-note'));
      const testLogin = el('button', 'Continue with Google (test)', 'button secondary');
      testLogin.type = 'button';
      testLogin.addEventListener('click', async () => {
        testLogin.disabled = true; notice('');
        try {
          const challenge = await api('/api/user/test-login-challenge');
          await api('/api/user/test-login', { method: 'POST', body: '{}', headers: { 'X-CSRF-Token': challenge.csrf } });
          session = await api('/api/user/session'); account(); await memberData();
        } catch (error) { notice(error.message); testLogin.disabled = false; }
      });
      container.append(testLogin);
    }
    $('member-area').classList.add('hidden'); $('account-button').textContent = 'Your account';
  } else {
    container.append(el('span', 'YOU’RE SIGNED IN', 'eyebrow'), el('h3', session.user.name || 'Your account'), el('p', session.user.email || ''));
    if (session.user.isTest) container.append(el('div', 'TEST ACCOUNT · Not a verified Google identity. Orders and support belong to this browser’s test account. Payments and hardware actions are disabled.', 'service-note'));
    const logout = el('button', 'Sign out', 'button secondary small'); logout.type = 'button'; logout.addEventListener('click', async () => { logout.disabled = true; try { await api('/api/user/logout', { method: 'POST', body: '{}' }); session = { ...session, user: null, csrf: null }; account(); $('rentals').replaceChildren(); $('support-history').replaceChildren(); } catch (error) { notice(error.message); logout.disabled = false; } }); container.append(logout);
    $('member-area').classList.remove('hidden'); $('account-button').textContent = session.user.name || 'Your account';
  }
}
async function memberData() {
  if (!session.user) return;
  const results = await Promise.allSettled([api('/api/user/rentals'), api('/api/user/support')]);
  const rentals = $('rentals'); rentals.replaceChildren();
  if (results[0].status === 'rejected') rentals.append(el('p', 'Your rentals could not be loaded. Please refresh the page.'));
  else { const rows = results[0].value.rentals || []; if (!rows.length) rentals.append(empty('A fresh start.', 'Your rental history will appear here once rentals are available.')); for (const rental of rows) { const row = el('div', null, 'integration'); row.append(el('strong', rental.stationName || rental.stationId || 'Rental'), el('span', rental.status || 'Unknown', 'badge')); rentals.append(row); } }
  const support = $('support-history'); support.replaceChildren();
  if (results[1].status === 'rejected') support.append(el('p', 'Your support history could not be loaded.'));
  else for (const ticket of results[1].value.support || []) { const card = el('article', null, 'ticket'); card.append(el('span', ticket.status || 'Open', 'badge'), el('p', ticket.message)); if (ticket.reply) card.append(el('strong', 'voltgo support'), el('p', ticket.reply)); support.append(card); }
}
$('account-button').addEventListener('click', () => $('account').scrollIntoView({ behavior: 'smooth' }));
$('refresh-stations').addEventListener('click', stations);
$('support-form').addEventListener('submit', async event => { event.preventDefault(); const button = event.currentTarget.querySelector('button'); const message = $('support-message').value.trim(); if (!message) return; button.disabled = true; $('support-status').textContent = 'Sending…'; try { await api('/api/user/support', { method: 'POST', body: JSON.stringify({ message }) }); $('support-message').value = ''; $('support-status').textContent = 'Message sent. You can view your request and replies here.'; await memberData(); } catch (error) { $('support-status').textContent = error.message; } finally { button.disabled = false; } });
(async () => {
  if (location.pathname === '/auth/error') { const code = new URLSearchParams(location.search).get('code'); const errors = { not_configured: 'Google sign-in is not configured yet', google_not_configured: 'Google sign-in is not configured yet', access_denied: 'Google sign-in was canceled. You can try again when you’re ready.', invalid_state: 'Your sign-in session expired. Please try again.', oauth_failed: 'Google sign-in could not be completed. Please try again.' }; notice(errors[code] || 'We couldn’t complete Google sign-in. Please try again or contact support.'); }
  try { session = await api('/api/user/session'); account(); await memberData(); } catch (error) { $('account-content').replaceChildren(empty('Your account is unavailable.', 'Please refresh the page to try again.')); notice('We couldn’t check your sign-in status. Please refresh to try again.'); }
  await stations();
})();
