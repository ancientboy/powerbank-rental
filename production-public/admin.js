'use strict';
const $ = id => document.getElementById(id);
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = String(text); if (cls) n.className = cls; return n; };
let session = {}, data = {}, section = 'dashboard', loading = null, hasLoaded = false, initialLoadFailed = false, mutationPending = false, dirtyForms = new Set(), editorForms = new Set();
const canManage = () => session.user?.role === 'owner';
const canSupport = () => ['owner', 'operator'].includes(session.user?.role);
const sections = { dashboard: ['Overview', '◈'], stations: ['Stations', '⌖'], pricing: ['Pricing', '◷'], orders: ['Orders', '↗'], payments: ['Payments', '▤'], users: ['Users', '◎'], support: ['Support', '◌'], audit: ['Audit log', '≡'], integrations: ['Integrations', '⊞'] };
async function api(path, options = {}) {
  let response;
  try { response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(session.csrf ? { 'X-CSRF-Token': session.csrf } : {}), ...options.headers } }); } catch (cause) { const error = new Error(options.method === 'POST' ? 'The connection was lost. The request outcome is unknown.' : 'Could not connect. Check your connection and try again.'); error.uncertain = options.method === 'POST'; throw error; }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) { if (response.status === 401 && path !== '/api/admin/login') { session = {}; data = {}; dirtyForms.clear(); hasLoaded = false; $('admin-panel').replaceChildren(); $('admin-view').classList.add('hidden'); location.replace('/admin/login'); throw new Error('Session expired. Sign in again.'); } const error = new Error(typeof result.error === 'string' ? result.error : result.error?.message || result.message || 'Request failed. Try again.'); error.status = response.status; error.uncertain = options.method === 'POST' && response.status >= 500; throw error; }
  return result;
}
function notice(text, error = false) { $('admin-notice').textContent = text; $('admin-notice').classList.toggle('hidden', !text); $('admin-notice').classList.toggle('error', error); }
function empty(title, detail) { const n = el('div', null, 'empty-state'); n.append(el('strong', title), el('span', detail)); return n; }
function button(text, handler, cls = 'button secondary small') { const b = el('button', text, cls); b.type = 'button'; b.addEventListener('click', handler); return b; }
function date(value) { if (!value) return '—'; const d = new Date(value); return Number.isNaN(d.valueOf()) ? '—' : d.toLocaleString(); }
function value(row, keys) { for (const key of keys.split('|')) if (row[key] != null) return typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key]; return '—'; }
function table(rows, columns, action) {
  if (!rows?.length) return empty('No records yet.', '');
  const wrap = el('div', null, 'table-wrap'), t = el('table'), head = el('thead'), hr = el('tr');
  for (const [label] of columns) { const th = el('th', label); th.scope = 'col'; hr.append(th); } if (action) hr.append(el('th', 'Actions')); head.append(hr); t.append(head);
  const body = el('tbody');
  for (const row of rows) { const tr = el('tr'); for (const [, key, format] of columns) { const val = value(row, key); tr.append(el('td', format ? format(val, row) : val)); } if (action) { const td = el('td'); td.append(action(row)); tr.append(td); } body.append(tr); }
  t.append(body); wrap.append(t); return wrap;
}
function controls(form) { return Array.from(form.children || []).flatMap(node => ['input', 'textarea'].includes(node.tagName?.toLowerCase()) ? [node] : controls(node)); }
function trackEdits(form) {
  editorForms.add(form);
  form.addEventListener('input', () => dirtyForms.add(form));
  form.addEventListener('change', () => dirtyForms.add(form));
}
function leaveEditor(action) {
  if (loading) { notice('Wait for the dashboard refresh to finish.'); return; }
  if (mutationPending) { notice('Wait for the current save to finish.', true); return; }
  if (!dirtyForms.size) { action(); return; }
  notice('You have unsaved changes. Save them first or discard them to continue.');
  $('admin-notice').append(button('Keep editing', () => notice('')), button('Discard changes', () => { dirtyForms.clear(); action(); }));
}
function money(amount, row = {}) {
  if (amount == null || amount === '' || amount === '—' || !Number.isFinite(Number(amount))) return '—';
  const currency = row.currency || row.pricing?.currency || 'ARS';
  try { return new Intl.NumberFormat('en-AR', { style: 'currency', currency }).format(Number(amount) / 100); }
  catch { return `${(Number(amount) / 100).toFixed(2)} ${currency}`; }
}
function formError(status, message) { status.textContent = message; status.classList.add('error'); }
async function saveForm(form, save, status, path, payload, message, allowed) {
  if (!allowed()) { formError(status, 'Read-only access. This action is not permitted for your role.'); return; }
  if (mutationPending || Boolean(form.dataset.saved)) return;
  mutationPending = true; save.disabled = true; status.classList.remove('error'); status.textContent = 'Saving…';
  try {
    await api(path, { method: 'POST', body: JSON.stringify(payload) });
    form.dataset.saved = 'true'; dirtyForms.delete(form); status.textContent = message;
    try { await load(); notice(message); }
    catch { notice(`${message} Refresh failed. Do not submit again; use Refresh to see the saved record.`, true); }
  } catch (error) {
    if (error.uncertain) { form.dataset.saved = 'unknown'; dirtyForms.delete(form); formError(status, 'Save outcome unknown. Use Refresh and check the records before trying again.'); notice('The server may have saved this change. Refresh and review before submitting again.', true); }
    else formError(status, error.message);
  }
  finally { mutationPending = false; save.disabled = Boolean(form.dataset.saved) || !allowed(); }
}
function testRecords(panel, title, rows, columns) {
  if (!rows?.length) return;
  const card = el('section', null, 'card'), heading = el('div', null, 'panel-heading');
  heading.append(el('h3', title), el('span', 'TEST', 'badge pending'));
  card.append(heading, el('p', 'Simulation only. No charges or physical devices.', 'subtle'), table(rows, columns)); panel.append(card);
}
function field(form, label, name, type = 'text', current = '', options = {}) { const wrap = el('div', null, options.wide ? 'wide' : ''); const labelEl = el('label', label); labelEl.htmlFor = `field-${name}`; const input = el('input'); input.id = `field-${name}`; input.name = name; input.type = type; input.value = current ?? ''; if (options.required) input.required = true; if (options.min != null) input.min = options.min; if (options.max != null) input.max = options.max; if (options.step) input.step = options.step; if (options.maxLength) input.maxLength = options.maxLength; wrap.append(labelEl, input); form.append(wrap); return input; }
function integrationList() { const wrap = el('div'); for (const [key, name, detail] of [['google', 'Google sign-in', 'Customer sign-in'], ['pvs', 'PVS payments', 'Payments and deposits'], ['wscharge', 'WSCharge devices', 'Cabinet controls']]) { const state = data.readiness?.[key]; const row = el('div', null, 'integration'); const text = el('div'); text.append(el('strong', name), el('p', detail)); row.append(text, el('span', state?.ready ? (state.label || 'Configured') : (state?.label || 'Not configured'), `badge${state?.ready ? '' : ' pending'}`)); wrap.append(row); } return wrap; }
function overview(panel) {
  const stats = el('div', null, 'stats');
  for (const [label, count] of [['Stations', data.stations?.length || 0], ['Users', (data.users || []).filter(user => !user.isTest && !user.testOnly && user.provider !== 'google_test').length], ['Orders', data.rentals?.length || 0], ['Open requests', (data.support || []).filter(x => !x.testOnly && !['closed', 'resolved'].includes(x.status)).length]]) { const card = el('div', null, 'card stat-card'); card.append(el('span', label), el('strong', count)); stats.append(card); } panel.append(stats);
  const grid = el('div', null, 'panel-grid'), network = el('section', null, 'card'), integrations = el('section', null, 'card');
  const heading = el('div', null, 'panel-heading'); heading.append(el('h3', 'Stations'), button('View stations ↗', () => navigate('stations'))); network.append(heading);
  network.append(table((data.stations || []).slice(0, 5), [['Station', 'name'], ['Address', 'address'], ['Status', 'active', (_, row) => row.active ? 'Active' : 'Inactive']]));
  integrations.append(el('h3', 'Integrations'), integrationList(), el('p', 'Configuration status only. Live connectivity is unverified.', 'subtle')); grid.append(network, integrations); panel.append(grid);
  panel.append(el('div', 'Live rentals, payments, and cabinet controls are unavailable.', 'notice'));
}
function stationEditor(station = {}, discard = false) {
  if (!discard) { leaveEditor(() => stationEditor(station, true)); return; }
  if (!canManage()) { notice('Stations are read-only for your account.', true); return; }
  const old = $('station-editor'); if (old) old.remove(); const form = el('form', null, 'card editor'); form.id = 'station-editor'; form.dataset.editor = 'station'; trackEdits(form); form.append(el('h3', station.id ? 'Edit station' : 'Add a station')); const grid = el('div', null, 'form-grid');
  field(grid, 'Station name', 'name', 'text', station.name, { required: true, maxLength: 150 }); field(grid, 'Cabinet ID', 'cabinetId', 'text', station.cabinetId, { maxLength: 80 }); field(grid, 'Address', 'address', 'text', station.address, { required: true, wide: true, maxLength: 500 }); field(grid, 'Latitude', 'latitude', 'number', station.latitude, { min: -90, max: 90, step: 'any' }); field(grid, 'Longitude', 'longitude', 'number', station.longitude, { min: -180, max: 180, step: 'any' });
  const check = el('label', null, 'check-label'); const active = el('input'); active.type = 'checkbox'; active.name = 'active'; active.checked = station.active !== false; check.append(active, el('span', 'Active location (does not enable rentals)')); grid.append(check); form.append(grid);
  const actions = el('div', null, 'form-actions'), save = el('button', 'Save station', 'button dark'); save.type = 'submit'; actions.append(save, button('Cancel', () => { dirtyForms.delete(form); form.remove(); })); form.append(actions); const status = el('p', '', 'form-status'); status.setAttribute('role', 'status'); form.append(status);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (mutationPending || Boolean(form.dataset.saved)) return;
    const fields = new FormData(form);
    const payload = { name: fields.get('name').trim(), address: fields.get('address').trim(), cabinetId: fields.get('cabinetId').trim(), latitude: fields.get('latitude') === '' ? null : Number(fields.get('latitude')), longitude: fields.get('longitude') === '' ? null : Number(fields.get('longitude')), active: active.checked };
    if (!payload.name || !payload.address) { formError(status, 'Enter a station name and address.'); return; }
    if ((payload.latitude === null) !== (payload.longitude === null) || (payload.latitude !== null && (!Number.isFinite(payload.latitude) || Math.abs(payload.latitude) > 90 || !Number.isFinite(payload.longitude) || Math.abs(payload.longitude) > 180))) { formError(status, 'Enter both valid latitude and longitude, or leave both blank.'); return; }
    if (payload.cabinetId.length > 80) { formError(status, 'Cabinet ID must be 80 characters or fewer.'); return; }
    if ((data.stations || []).some(row => payload.cabinetId && row.id !== station.id && row.cabinetId === payload.cabinetId)) { formError(status, 'This cabinet is already assigned to another station.'); return; }
    if (station.id) { payload.id = station.id; payload.expectedUpdatedAt = station.updatedAt ?? null; }
    await saveForm(form, save, status, '/api/admin/stations', payload, 'Station saved.', canManage);
  });
  $('admin-panel').prepend(form); form.querySelector('input').focus();
}
function stations(panel) { const heading = el('div', null, 'panel-heading'); if (!canManage()) heading.append(el('p', 'Read-only access', 'subtle')); if (canManage()) heading.append(button('Add station +', () => stationEditor(), 'button dark')); panel.append(heading, table(data.stations || [], [['Name', 'name'], ['Address', 'address'], ['Cabinet', 'cabinetId'], ['Status', 'active', (_, row) => row.active ? 'Active' : 'Inactive']], canManage() ? row => button('Edit', () => stationEditor(row)) : null)); testRecords(panel, 'Test stations', data.testStations, [['Station', 'name'], ['Address', 'address'], ['Station ID', 'id']]); }
function pricing(panel) {
  const pricingVersion = data.pricing?.version ?? null;
  const form = el('form', null, 'card'); form.dataset.editor = 'pricing'; trackEdits(form); form.append(el('h3', 'Rental pricing'), el('p', 'Rates in ARS. New versions apply to future live rentals only, not existing orders or TEST prices. Saving does not enable live rentals or payments.', 'subtle')); const grid = el('div', null, 'form-grid');
  for (const [label, key] of [['Hourly rate (ARS)', 'hourlyRate'], ['Daily cap (ARS)', 'dailyCap'], ['Refundable deposit (ARS)', 'deposit']]) field(grid, label, key, 'number', data.pricing?.[key] == null ? '' : data.pricing[key] / 100, { required: true, min: '.01', max: 1000000, step: '.01' }); form.append(grid); const save = el('button', 'Save pricing', 'button dark'); save.type = 'submit'; if (!canManage()) { save.disabled = true; save.textContent = 'Read-only access'; for (const wrap of grid.children) { const input = wrap.querySelector('input'); if (input) input.disabled = true; } } const status = el('p', '', 'form-status'); status.setAttribute('role', 'status'); form.append(save, status);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (mutationPending || Boolean(form.dataset.saved)) return;
    if (!canManage()) { formError(status, 'Read-only access.'); return; }
    const fields = new FormData(form), payload = { currency: 'ARS', expectedVersion: pricingVersion };
    for (const key of ['hourlyRate', 'dailyCap', 'deposit']) {
      const raw = String(fields.get(key) ?? '').trim();
      if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) { formError(status, 'Enter positive prices with no more than two decimal places.'); return; }
      payload[key] = Math.round(Number(raw) * 100);
      if (!Number.isSafeInteger(payload[key]) || payload[key] <= 0 || payload[key] > 100000000) { formError(status, 'Prices must be between ARS 0.01 and 1,000,000.00.'); return; }
    }
    if (payload.dailyCap < payload.hourlyRate) { formError(status, 'Daily cap must cover at least one hour.'); return; }
    await saveForm(form, save, status, '/api/admin/pricing', payload, 'Pricing saved.', canManage);
  }); panel.append(form);
}
function support(panel) {
  if (!data.support?.length) { panel.append(empty('No support requests yet.', '')); return; }
  for (const ticket of data.support) { const form = el('form', null, 'ticket'); form.dataset.editor = `support-${ticket.id}`; form.dataset.expectedUpdatedAt = ticket.updatedAt ?? ''; trackEdits(form); const heading = el('div', null, 'panel-heading'); if (ticket.testOnly) heading.append(el('span', 'TEST', 'badge pending')); heading.append(el('strong', ticket.userEmail || ticket.email || ticket.userId || 'Customer request'), el('span', ticket.status || 'open', 'badge')); form.append(heading, el('span', date(ticket.createdAt), 'ticket-meta'), el('p', ticket.message)); const label = el('label', 'Reply to customer'); label.htmlFor = `reply-${ticket.id}`; const reply = el('textarea'); reply.id = label.htmlFor; reply.name = 'reply'; reply.rows = 3; reply.maxLength = 4000; reply.value = ticket.reply || ''; form.append(label, reply, el('p', 'Replies appear in the customer account. No email or push notification is sent.', 'subtle')); if (ticket.rentalId) form.append(el('p', `Related order: ${ticket.rentalId}`, 'ticket-meta'));
    const actions = el('div', null, 'form-actions'), status = el('fieldset', null, 'status-options');
    status.append(el('legend', 'Request status'));
    let selectedStatus = ticket.status === 'closed' ? 'resolved' : (['open', 'in_progress', 'resolved'].includes(ticket.status) ? ticket.status : 'open');
    const choices = el('div', null, 'status-segments');
    for (const [state, title] of [['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved']]) {
      const choice = el('label', null, 'status-choice'), radio = el('input');
      radio.type = 'radio'; radio.name = 'status'; radio.value = state; radio.checked = selectedStatus === state;
      radio.disabled = !canSupport(); radio.addEventListener('change', () => { if (radio.checked) selectedStatus = state; });
      choice.append(radio, el('span', title)); choices.append(choice);
    }
    status.append(choices); const save = el('button', 'Save reply & status', 'button dark'); save.type = 'submit'; if (!canSupport()) { save.disabled = true; save.textContent = 'Read-only access'; status.disabled = true; reply.disabled = true; } actions.append(status, save); const result = el('p', '', 'form-status'); result.setAttribute('role', 'status'); form.append(actions, result); form.addEventListener('submit', async event => {
      event.preventDefault(); if (mutationPending || Boolean(form.dataset.saved)) return;
      const answer = reply.value.trim(); selectedStatus = controls(form).find(input => input.type === 'radio' && input.checked)?.value || selectedStatus;
      if (selectedStatus === 'resolved' && !answer) { formError(result, 'Add a reply before resolving this request.'); return; }
      await saveForm(form, save, result, '/api/admin/support', { id: ticket.id, status: selectedStatus, reply: answer, expectedUpdatedAt: form.dataset.expectedUpdatedAt || null }, 'Support request updated.', canSupport);
    }); panel.append(form);
  }
}
function render() {
  const panel = $('admin-panel'); dirtyForms.clear(); editorForms.clear(); panel.replaceChildren(); $('page-title').textContent = sections[section][0]; document.title = `voltgo · ${sections[section][0]}`; for (const link of $('admin-nav').children) { const active = link.dataset.section === section; link.classList.toggle('active', active); if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); }
  if (initialLoadFailed) { panel.append(empty('Dashboard unavailable.', 'Use Refresh to try again. No records have been loaded.')); return; }
  if (section === 'dashboard') overview(panel); else if (section === 'stations') stations(panel); else if (section === 'pricing') pricing(panel); else if (section === 'support') support(panel);
  else if (section === 'integrations') { const card = el('section', null, 'card'); card.append(el('h3', 'Services'), integrationList(), el('p', 'Configuration status only. Live connectivity is unverified.', 'subtle')); panel.append(card, el('div', 'Live payments and cabinet controls are unavailable.', 'notice')); }
  else if (section === 'orders') { const columns = [['Order', 'id'], ['User', 'userEmail|userId'], ['Station', 'stationName|stationId'], ['Status', 'status'], ['Created', 'createdAt', date], ['Started', 'startedAt', date]]; panel.append(table(data.rentals, columns)); testRecords(panel, 'Test orders', data.testRentals, [...columns, ['Returned', 'returnedAt', date], ['Deposit held/paid', 'depositPaid', money], ['Rental fee / active estimate', 'totalAmount', money], ['Deposit applied', 'depositApplied', money], ['Refund', 'refundAmount', money], ['Outstanding', 'outstandingAmount', money], ['Settlement', 'settlementStatus'], ['Refund record', 'refundId']]); panel.append(el('p', 'TEST amounts are simulated. Deposit payment does not start billing; pickup does. Refunds and fees are separate records. Outstanding balances require review, not automatic charging.', 'subtle')); }
  else if (section === 'payments') { const columns = [['Payment', 'id'], ['Order', 'rentalId|orderId'], ['Type', 'type', kind => ({ deposit: 'Deposit', refund: 'Refund', settlement: 'Legacy settlement', rental_fee: 'Rental fee', authorization: 'Legacy authorization' }[kind] || kind || '—')], ['Amount', 'amount', money], ['Currency', 'currency'], ['Status', 'status'], ['Date', 'createdAt', date]]; panel.append(el('div', 'Recorded payments only. Live payment processing is unavailable.', 'service-note'), table(data.payments, columns)); testRecords(panel, 'Test payments', data.testPayments, columns); }
  else if (section === 'users') panel.append(table(data.users, [['Name', 'name'], ['Identity', 'provider', (v, row) => row.isTest || row.testOnly || v === 'google_test' ? 'TEST · Google simulation' : v === 'google' ? 'Google' : v], ['Email', 'email'], ['User ID', 'id'], ['Joined', 'createdAt|created_at', date]]));
  else if (section === 'audit') panel.append(table(data.audit, [['Time', 'createdAt|created_at|timestamp', date], ['Actor', 'actor|actorId|username'], ['Action', 'action'], ['Target', 'target|targetId|entityId']]));
}
function navigate(next) { if (mutationPending) { notice('Wait for the current save to finish.'); return; } if (next === section) { if (!dirtyForms.size) render(); return; } leaveEditor(() => { section = sections[next] ? next : 'dashboard'; location.hash = section; notice(''); render(); }); }
async function load() {
  if (loading) return loading;
  const refresh = $('reload-dashboard'); refresh.disabled = true; refresh.textContent = 'Refreshing…';
  $('admin-panel').setAttribute('aria-busy', 'true'); $('admin-panel').inert = true;
  loading = (async () => {
    try {
      const snapshot = await api('/api/admin/dashboard');
      const drafts = [...dirtyForms].map(form => ({ key: form.dataset.editor, expectedUpdatedAt: form.dataset.expectedUpdatedAt, values: controls(form).map(input => ({ name: input.name, value: input.value, checked: input.checked })) }));
      data = snapshot; hasLoaded = true; initialLoadFailed = false; render();
      for (const draft of drafts) {
        const form = [...editorForms].find(item => item.dataset.editor === draft.key);
        if (!form) continue;
        if (draft.expectedUpdatedAt != null) form.dataset.expectedUpdatedAt = draft.expectedUpdatedAt;
        for (const input of controls(form)) {
          const saved = draft.values.find(item => item.name === input.name && (input.type !== 'radio' || item.value === input.value));
          if (saved) { input.value = saved.value; input.checked = saved.checked; }
        }
        dirtyForms.add(form);
      }
    }
    catch (error) {
      if (!hasLoaded) { initialLoadFailed = true; $('admin-panel').replaceChildren(empty('Dashboard unavailable.', 'Use Refresh to try again. No records have been loaded.')); }
      notice(hasLoaded ? `Refresh failed. Displayed records may be outdated. ${error.message}` : error.message, true); throw error;
    } finally { refresh.disabled = false; refresh.textContent = 'Refresh'; $('admin-panel').removeAttribute('aria-busy'); $('admin-panel').inert = false; }
  })();
  try { return await loading; } finally { loading = null; }
}
$('login-form').addEventListener('submit', async event => { event.preventDefault(); const button = event.currentTarget.querySelector('button'); if (button.disabled) return; button.disabled = true; $('login-status').classList.remove('error'); $('login-status').textContent = 'Signing in…'; try { session = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ username: $('username').value.trim(), password: $('password').value }) }); $('password').value = ''; location.replace('/admin'); } catch (error) { $('login-status').textContent = error.message; $('login-status').classList.add('error'); } finally { button.disabled = false; } });
$('logout-button').addEventListener('click', () => leaveEditor(async () => { const b = $('logout-button'); if (b.disabled) return; if (mutationPending) { notice('Wait for the current save to finish before signing out.', true); return; } b.disabled = true; try { await api('/api/admin/logout', { method: 'POST', body: '{}' }); session = {}; data = {}; $('admin-panel').replaceChildren(); $('admin-view').classList.add('hidden'); location.replace('/admin/login'); } catch (error) { notice(error.message, true); b.disabled = false; } }));
$('reload-dashboard').addEventListener('click', () => { if (mutationPending) { notice('Wait for the current save to finish before refreshing.'); return; } return leaveEditor(() => load().then(() => notice('Updated.')).catch(() => {})); });
window.addEventListener('beforeunload', event => { if (dirtyForms.size || mutationPending) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('hashchange', () => { const next = location.hash.slice(1); if (sections[next] && section !== next) { if (mutationPending || dirtyForms.size) { location.hash = section; navigate(next); return; } section = next; notice(''); render(); } });
(async () => { if (location.pathname === '/admin/login') { $('boot-status').classList.add('hidden'); $('login-view').classList.remove('hidden'); return; } try { session = await api('/api/admin/session'); if (!session.user) { location.replace('/admin/login'); return; } $('admin-identity').textContent = `${session.user.name || session.user.username || 'Administrator'} · ${session.user.role || 'read-only'}`; section = sections[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard'; for (const [key, [label, symbol]] of Object.entries(sections)) { const link = el('a', null, 'nav-item'); link.href = `#${key}`; link.dataset.section = key; link.append(el('span', symbol, 'nav-symbol'), el('span', label)); link.addEventListener('click', event => { event.preventDefault(); navigate(key); }); $('admin-nav').append(link); } $('admin-view').classList.remove('hidden'); $('boot-status').classList.add('hidden'); await load(); } catch (error) { $('boot-status').textContent = 'Could not load. Refresh to try again.'; notice(error.message, true); } })();
