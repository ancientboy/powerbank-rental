'use strict';
const $ = id => document.getElementById(id);
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = String(text); if (cls) n.className = cls; return n; };
let session = {}, data = {}, section = 'dashboard', loading = null, hasLoaded = false, initialLoadFailed = false, mutationPending = false, dirtyForms = new Set(), editorForms = new Set();
const canManage = () => session.user?.role === 'owner';
const canSupport = () => ['owner', 'operator'].includes(session.user?.role);
let orderFilters = { q: '', mode: 'all', status: '', from: '', to: '' }, orderSelection = null, detailGeneration = 0, contextFilter = null, pendingLabDrafts = [];
const sections = { dashboard: ['Overview', '◈'], queue: ['Work queue', '✓'], stations: ['Stations', '⌖'], orders: ['Orders', '↗'], payments: ['Payments', '▤'], users: ['Users', '◎'], support: ['Support', '◌'], pricing: ['Pricing', '◷'], audit: ['Audit log', '≡'], integrations: ['Integrations', '⊞'] };
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
async function saveForm(form, save, status, path, payload, message, allowed, headers = {}) {
  if (!allowed()) { formError(status, 'Read-only access. This action is not permitted for your role.'); return; }
  if (mutationPending || Boolean(form.dataset.saved)) return;
  mutationPending = true; save.disabled = true; status.classList.remove('error'); status.textContent = 'Saving…';
  try {
    await api(path, { method: 'POST', body: JSON.stringify(payload), headers });
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
  for (const [label, count] of [['Stations', data.counts?.stations ?? data.stations?.length ?? 0], ['Users', data.counts?.users ?? (data.users || []).filter(user => !user.isTest && !user.testOnly && user.provider !== 'google_test').length], ['Orders', data.counts?.orders ?? data.rentals?.length ?? 0], ['Open requests', data.counts?.openSupport ?? (data.support || []).filter(x => !x.testOnly && !['closed', 'resolved'].includes(x.status)).length]]) { const card = el('div', null, 'card stat-card'); card.append(el('span', label), el('strong', count)); stats.append(card); } panel.append(stats);
  const grid = el('div', null, 'panel-grid'), network = el('section', null, 'card'), integrations = el('section', null, 'card');
  const heading = el('div', null, 'panel-heading'); heading.append(el('h3', 'Stations'), button('View stations ↗', () => navigate('stations'))); network.append(heading);
  network.append(table((data.stations || []).slice(0, 5), [['Station', 'name'], ['Address', 'address'], ['Status', 'active', (_, row) => row.active ? 'Active' : 'Inactive']]));
  integrations.append(el('h3', 'Integrations'), integrationList(), el('p', 'Configuration status only. Live connectivity is unverified.', 'subtle')); grid.append(network, integrations); panel.append(grid);
  panel.append(el('div', 'Live rentals, payments, and cabinet controls are unavailable.', 'notice'));
  deviceStatusPanel(panel);
}
function deviceStatusPanel(panel) {
  const section = el('section', null, 'card'); section.append(el('h3', 'Cabinets and power banks'), el('p', 'Device observations at last refresh. Station Active is a location setting, not an online signal. Inventory is not a rentable count.', 'subtle'));
  if (!data.deviceCabinets?.length) section.append(empty('No cabinets configured.', ''));
  for (const cabinet of data.deviceCabinets || []) {
    const station = (data.stations || []).find(s => s.cabinetId === cabinet.cabinetId);
    const block = el('article', null, 'card');
    block.append(facts(cabinet.cabinetId, [['Location', station?.name || 'Location not configured'], ['Connection', {online:'Online at last refresh',offline:'Last reported offline',unknown:'Unknown'}[cabinet.connection] || 'Unknown'], ['Inventory', {waiting:'Waiting for device data',stale:'Outdated · current status unknown',observed:'Recent observation · availability unconfirmed'}[cabinet.inventoryState] || 'Unknown'], ['Last device update', date(cabinet.lastObservedAt)], ['Inventory sampled', date(cabinet.inventoryObservedAt)], ['Reported power banks', cabinet.observedBankCount ?? 'Unknown'], ['Rentable availability', 'Unknown']]));
    if (cabinet.banks?.length) block.append(table(cabinet.banks, [['Slot','slot'],['Power bank','bankId'],['Reported battery (%)','batteryPercent'],['Supplier status code','statusCode']]));
    if (!station && canManage()) block.append(button('Set location', () => stationEditor({cabinetId: cabinet.cabinetId})));
    const testLink=el('a','打开扫码租借测试');testLink.href='/rent?cabinet='+encodeURIComponent(cabinet.cabinetId);block.append(testLink);
    section.append(block);
  }
  panel.append(section);
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
function stations(panel) { const heading = el('div', null, 'panel-heading'); if (!canManage()) heading.append(el('p', 'Read-only access', 'subtle')); if (canManage()) heading.append(button('Add station +', () => stationEditor(), 'button dark')); panel.append(heading, table(data.stations || [], [['Name', 'name'], ['Address', 'address'], ['Cabinet', 'cabinetId'], ['Status', 'active', (_, row) => row.active ? 'Active' : 'Inactive']], canManage() ? row => button('Edit', () => stationEditor(row)) : null)); testRecords(panel, 'Test stations', data.testStations, [['Station', 'name'], ['Address', 'address'], ['Station ID', 'id']]); deviceStatusPanel(panel); }
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
  const history = el('section', null, 'card'); history.append(el('h3', 'Pricing version history'), el('p', 'Billing begins at pickup. Each started hour is billed, capped per 24-hour period. Deposits, fees and refunds remain distinct. Existing orders retain their pricing snapshot.', 'subtle'), table(data.pricingHistory, [['Version','version'], ['Effective','updatedAt|createdAt',date], ['Hourly rate','hourlyRate',money], ['Daily cap','dailyCap',money], ['Deposit','deposit',money]])); panel.append(history);
}
function filteredOrders(rows, mode) {
  const q = orderFilters.q.trim().toLowerCase();
  return (rows || []).filter(row => {
    const user = (data.users || []).find(user => user.id === row.userId);
    const search = [row.id, row.userId, row.userEmail, user?.email, user?.name, row.stationId, row.stationName].join(' ').toLowerCase();
    const day = String(row.createdAt || '').slice(0, 10);
    return (orderFilters.mode === 'all' || orderFilters.mode === mode) && (!q || search.includes(q)) && (!orderFilters.status || row.status === orderFilters.status) && (!orderFilters.from || day >= orderFilters.from) && (!orderFilters.to || day <= orderFilters.to);
  });
}
function segments(label, choices, selected, onChange) {
  const group = el('fieldset', null, 'status-options'); group.append(el('legend', label));
  const options = el('div', null, 'status-segments');
  for (const [key, title] of choices) {
    const choice = button(title, () => { onChange(key); for (const child of options.children) child.setAttribute('aria-pressed', String(child.dataset.value === key)); }, 'button secondary small');
    choice.dataset.value = key; choice.setAttribute('aria-pressed', String(selected === key)); options.append(choice);
  }
  group.append(options); return group;
}
function openContext(next, filter) { leaveEditor(() => { contextFilter = filter; orderSelection = null; section = next; location.hash = next; notice(''); render(); }); }
function contextHeading(panel) {
  if (!contextFilter) return;
  const heading = el('div', null, 'service-note'); heading.append(el('span', `Showing ${contextFilter.rentalId ? 'order ' + contextFilter.rentalId : 'user ' + contextFilter.userId}`), button('Clear context', () => { contextFilter = null; render(); })); panel.append(heading);
}
function orderList(panel) {
  if (orderSelection) { orderDetail(panel); return; }
  const filter = el('form', null, 'card ops-filters');
  const grid = el('div', null, 'form-grid');
  field(grid, 'Search order, user or station', 'search', 'search', orderFilters.q);
  field(grid, 'Created from (UTC)', 'from', 'date', orderFilters.from);
  field(grid, 'Created through (UTC)', 'to', 'date', orderFilters.to); filter.append(grid);
  filter.append(segments('Record environment', [['all','All'],['live','Live'],['test','TEST']], orderFilters.mode, value => { orderFilters.mode = value; }));
  const statuses = [...new Set([...(data.rentals || []), ...(data.testRentals || [])].map(row => row.status).filter(Boolean))];
  filter.append(segments('Rental status', [['','All statuses'], ...statuses.map(status => [status, status.replaceAll('_',' ')])], orderFilters.status, value => { orderFilters.status = value; }));
  const actions = el('div', null, 'form-actions'), apply = el('button', 'Apply filters', 'button dark'); apply.type = 'submit'; actions.append(apply, button('Reset', () => { orderFilters = { q:'', mode:'all', status:'', from:'', to:'' }; render(); })); filter.append(actions);
  filter.addEventListener('submit', event => { event.preventDefault(); const fields = new FormData(filter); const from = fields.get('from'), to = fields.get('to'); if (from && to && from > to) { notice('The start date must be on or before the end date.', true); return; } orderFilters = { ...orderFilters, q: fields.get('search'), from, to }; notice(''); render(); }); panel.append(filter);
  const columns = [['Order', 'id'], ['User', 'userEmail|userId'], ['Station', 'stationName|stationId'], ['Rental status', 'status'], ['Financial status', 'settlementStatus'], ['Created', 'createdAt', date], ['Started', 'startedAt', date]];
  const live = filteredOrders(data.rentals, 'live'), test = filteredOrders(data.testRentals, 'test');
  panel.append(el('p', `${live.length + test.length} matching orders`, 'subtle'));
  if (orderFilters.mode !== 'test') panel.append(table(live, columns, row => button('View order', () => openOrder(row.id, 'live'))));
  if (orderFilters.mode !== 'live') { const card = el('section', null, 'card'); card.append(el('h3','Test orders'), el('span','TEST','badge pending'), el('p','Simulation only. No charges or physical devices.','subtle'), table(test, [...columns, ['Returned','returnedAt',date], ['Rental fee / active estimate','totalAmount',money], ['Refund','refundAmount',money], ['Outstanding','outstandingAmount',money], ['Refund record','refundId']], row => button('View order', () => openOrder(row.id, 'test')))); panel.append(card); }
  panel.append(el('p', 'TEST amounts are simulated. Deposit payment does not start billing; pickup does. Refunds and fees are separate records. Outstanding balances require review, not automatic charging.', 'subtle'));
}
function openOrder(id, mode) { leaveEditor(() => { orderSelection = { id, mode }; contextFilter = null; section = 'orders'; location.hash = 'orders'; notice(''); render(); }); }
function facts(title, entries) { const card = el('section', null, 'card'); card.append(el('h3',title)); const list = el('dl', null, 'ops-facts'); for (const [label, value] of entries) list.append(el('dt', label), el('dd', value ?? 'Not recorded')); card.append(list); return card; }
function orderDetail(panel) {
  const selection = { ...orderSelection }, generation = ++detailGeneration;
  panel.append(button('← All orders', () => { orderSelection = null; render(); }));
  const content = el('div', null, 'ops-detail'); content.append(empty('Loading order…', '')); panel.append(content);
  api(`/api/admin/orders/${encodeURIComponent(selection.id)}?mode=${selection.mode}`).then(result => {
    if (generation !== detailGeneration || section !== 'orders' || orderSelection?.id !== selection.id || orderSelection?.mode !== selection.mode) return;
    const row = result.order, states = result.states || {}; content.replaceChildren();
    if (!row) { content.append(empty('Order unavailable.', 'Refresh or return to all orders.')); return; }
    content.append(el('h2', row.id), el('p', selection.mode === 'test' ? 'TEST · Simulation only. No charges or physical devices.' : 'Live record · Only recorded events are shown.', 'service-note'));
    const links = el('div', null, 'form-actions');
    if (row.userId) links.append(button('View user', () => openContext('users', {userId:row.userId})));
    links.append(button('Related support', () => openContext('support', {rentalId:row.id, mode:selection.mode})), button('Related funds', () => openContext('payments', {rentalId:row.id, mode:selection.mode}))); content.append(links);
    content.append(facts('Order context', [['User',row.userEmail || row.userId], ['Station',row.stationName || row.stationId], ['Rental state',states.rental || row.status], ['Financial state',states.payment || row.settlementStatus], ['Device state',states.device || 'Not recorded'], ['Pricing version',row.pricing?.version], ['Created',date(row.createdAt)], ['Pickup',date(row.startedAt)], ['Returned',date(row.returnedAt)]]));
    content.append(facts('Amounts', [['Deposit held/paid',money(row.depositPaid,row)], ['Rental fee / active estimate',money(row.totalAmount,row)], ['Deposit applied',money(row.depositApplied,row)], ['Refund',money(row.refundAmount,row)], ['Outstanding',money(row.outstandingAmount,row)], ['Refund record',row.refundId]]));
    content.append(el('p','An active fee is an estimate, not a new charge. Missing amounts are not treated as zero. Outstanding balances require review, not automatic charging.','subtle'));
    const timeline = el('section', null, 'card'); timeline.append(el('h3','Recorded timeline'), table(result.timeline, [['Time','createdAt|timestamp|at',date], ['Event','label|event|type'], ['Status','status'], ['Reference','id|reference']])); content.append(timeline);
    const related = el('section', null, 'card'); related.append(el('h3','Related support'), table(result.support, [['Request','id'],['Status','status'],['Message','message'],['Created','createdAt',date]], ticket => button('Open request', () => openContext('support', {supportId:ticket.id, rentalId:row.id, mode:selection.mode})))); content.append(related);
  }).catch(error => { if (generation === detailGeneration && section === 'orders' && orderSelection?.id === selection.id) { content.replaceChildren(empty('Could not load order.', error.message), button('Retry', () => render())); } });
}
function workQueue(panel) {
  panel.append(el('p','Known records needing review. This queue does not infer device failures, initiate refunds, or charge balances. TEST records remain separate.','subtle'));
  panel.append(table(data.workQueue, [['Environment','mode',value => value === 'test' ? 'TEST' : 'Live'], ['Reason','reason'], ['Status','status'], ['Order','rentalId'], ['Request','supportId'], ['Created','createdAt',date]], item => item.supportId ? button('Review request', () => openContext('support', {supportId:item.supportId})) : item.rentalId ? button('Review order', () => openOrder(item.rentalId,item.mode)) : el('span','No linked record')));
}
function auditLog(panel) {
  panel.append(el('p','Latest 200 recorded administrative changes. Older entries may not include a before/after snapshot.','subtle'));
  panel.append(table(data.audit, [['Time','createdAt|created_at|timestamp',date],['Actor','actor|actorId|username'],['Action','action'],['Target','target|targetId|entityId']], row => {
    const details = el('details', null, 'ops-audit'); details.append(el('summary','View change'));
    for (const [label, snapshot] of [['Before',row.before],['After',row.after]]) { details.append(el('strong',label), el('pre', snapshot == null ? 'Not recorded' : JSON.stringify(snapshot,null,2))); } return details;
  }));
}
function support(panel) {
  if (!data.support?.length) { panel.append(empty('No support requests yet.', '')); return; }
  contextHeading(panel);
  const tickets = data.support.filter(ticket => !contextFilter || (contextFilter.supportId ? ticket.id === contextFilter.supportId : ticket.rentalId === contextFilter.rentalId && (!contextFilter.mode || Boolean(ticket.testOnly) === (contextFilter.mode === 'test'))));
  if (!tickets.length) panel.append(empty('No related support requests.', ''));
  for (const ticket of tickets) { const form = el('form', null, 'ticket'); form.dataset.editor = `support-${ticket.id}`; form.dataset.expectedUpdatedAt = ticket.updatedAt ?? ''; trackEdits(form); const heading = el('div', null, 'panel-heading'); if (ticket.testOnly) heading.append(el('span', 'TEST', 'badge pending')); heading.append(el('strong', ticket.userEmail || ticket.email || ticket.userId || 'Customer request'), el('span', ticket.status || 'open', 'badge')); form.append(heading, el('span', date(ticket.createdAt), 'ticket-meta'), el('p', ticket.message)); const label = el('label', 'Reply to customer'); label.htmlFor = `reply-${ticket.id}`; const reply = el('textarea'); reply.id = label.htmlFor; reply.name = 'reply'; reply.rows = 3; reply.maxLength = 4000; reply.value = ''; reply.placeholder = 'Add a new reply'; form.append(label, reply, el('p', 'Replies appear in the customer account. No email or push notification is sent.', 'subtle')); if (ticket.rentalId) form.append(button(`Related order: ${ticket.rentalId}`, () => openOrder(ticket.rentalId, ticket.testOnly ? 'test' : 'live')));
    const replies = ticket.replies?.length ? ticket.replies : ticket.reply ? [{reply:ticket.reply,createdAt:ticket.updatedAt,legacy:true}] : [];
    if (replies.length) { const history = el('div', null, 'ops-conversation'); history.append(el('h4','Reply history')); for (const entry of replies) { const message = el('article'); message.append(el('span', `${date(entry.createdAt)} · ${entry.actorRole || 'Support'}${entry.legacy ? ' · Legacy reply' : ''}`, 'ticket-meta'), el('p',entry.reply)); history.append(message); } form.append(history); }
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
      if (selectedStatus === 'resolved' && !answer && !ticket.reply && !ticket.replies?.some(entry => entry.actorRole !== 'customer' && entry.reply)) { formError(result, 'Add a reply before resolving this request.'); return; }
      await saveForm(form, save, result, '/api/admin/support', { id: ticket.id, status: selectedStatus, reply: answer, expectedUpdatedAt: form.dataset.expectedUpdatedAt || null }, 'Support request updated.', canSupport);
    }); panel.append(form);
  }
}
function wschargePanel(panel) {
  const generation = detailGeneration;
  const card = el('section', null, 'card ops-detail');
  card.append(el('h3', 'WSCharge gateway · read-only'), el('p', 'Supplier observations, separate from the TEST lab. Configuration and received messages do not prove a verified live connection, physical pickup, return, or billing event.', 'service-note'));
  const content = el('div', null, 'ops-detail');
  let pending = false;
  const refresh = button('Refresh gateway records', () => read());
  card.append(refresh, content); panel.append(card);
  async function read() {
    if (pending || section !== 'integrations' || generation !== detailGeneration) return;
    pending = true; refresh.disabled = true; content.setAttribute('aria-busy', 'true');
    content.replaceChildren(empty('Loading gateway observations…', ''));
    try {
      const snapshot = await api('/api/admin/wscharge');
      if (section !== 'integrations' || generation !== detailGeneration) return;
      content.replaceChildren(); renderWscharge(content, snapshot);
    } catch (error) {
      if (section === 'integrations' && generation === detailGeneration) content.replaceChildren(empty('Gateway records unavailable.', error.message));
    } finally { pending = false; refresh.disabled = false; content.removeAttribute('aria-busy'); }
  }
  read();
}
function renderWscharge(panel, snapshot) {
  const yesNo = value => value === true ? 'Enabled' : 'Disabled';
  panel.append(facts('Gateway configuration', [
    ['HTTP gateway', yesNo(snapshot.enabled)],
    ['Required configuration', snapshot.configured === true ? 'Present · supplier verification still required' : 'Incomplete or disabled'],
    ['Physical dispatch flag', yesNo(snapshot.dispatchEnabled) + ' · no controls on this page'],
    ['Callback path', '/api/integrations/wscharge/notify'],
    ['Automatic settlement', 'Disabled · observation only'],
    ['Records refreshed', date(snapshot.serverNow)],
  ]));
  panel.append(el('p', 'The callback path is relative to your deployed HTTPS origin, not a confirmed public URL. Supplier callback format and authentication must be verified before live use. Secrets and raw callback payloads are not displayed.', 'subtle'));
  const observedDate = seconds => seconds === '—' || seconds == null ? '—' : date(Number(seconds) * 1000);
  const codeLabel = code => ({60:'60 · Login observation',90:'90 · Offline observation',64:'64 · Inventory',65:'65 · Pickup response',66:'66 · Return observation',80:'80 · Maintenance eject observation',81:'81 · Maintenance eject-all observation',67:'67 · Restart observation'}[code] || code);
  const inbox = el('section');
  inbox.append(el('h4', 'Callback inbox · latest 200'), el('p', 'Shared-token receipt is not independently verified device evidence. Candidate command matches are not confirmation; callbacks do not start billing or settle orders.', 'subtle'));
  inbox.append(table(snapshot.events, [['Received','receivedAt',date],['Observed','observedAtSeconds',observedDate],['Cabinet','cabinetId'],['Event','code',codeLabel],['Slot','slot'],['Bank','bankId'],['Supplier status code','statusCode'],['Timestamp check','freshness'],['Treatment','disposition']])); panel.append(inbox);
  const inventory = el('section'); inventory.append(el('h4', 'Observed inventory · latest 200 cabinets'), el('p', 'Partial, unverified observations only. Listed banks are not an available-rental count. Freshness is evaluated at refresh; completeness and rentable availability remain unknown.', 'subtle'));
  if (!snapshot.inventory?.length) inventory.append(empty('No inventory observations yet.', 'No cabinet availability is inferred.'));
  for (const cabinet of snapshot.inventory || []) {
    inventory.append(facts(cabinet.cabinetId || 'Cabinet', [['Observed',observedDate(cabinet.observedAtSeconds)],['Freshness',cabinet.stale === true ? 'Stale' : cabinet.stale === false ? 'Recent observation · unverified' : 'Unknown'],['Completeness','Unknown'],['Rentable availability','Unknown']]));
    inventory.append(table(cabinet.banks, [['Slot','slot'],['Bank','bankId'],['Reported battery (%)','batteryPercent'],['Supplier status code','statusCode']]));
  }
  panel.append(inventory);
  const commands = el('section'); commands.append(el('h4', 'Command attempts · latest 200'), el('p', 'Accepted means the supplier accepted a request, not that a bank was physically picked up. Unknown outcomes require reconciliation; this read-only page never sends or retries commands.', 'subtle'), table(snapshot.commands, [['Created','createdAt',date],['Attempt','id'],['Cabinet','cabinetId'],['Command','code',codeLabel],['Slot','slot'],['Request outcome','status'],['HTTP status','httpStatus'],['Physical pickup','physicalPickupConfirmed',()=>'Not confirmed']])); panel.append(commands);
}
function integrationLab(panel) {
  const generation = detailGeneration, lab = el('section', null, 'ops-lab'); lab.append(el('h3','TEST integration lab'), el('p','Persisted simulation for device, payment and reconciliation workflows. No physical commands or real payments. Live adapters remain unverified.','service-note')); panel.append(lab);
  const content = el('div', null, 'ops-lab'); content.append(empty('Loading TEST records…','')); lab.append(content);
  api('/api/admin/integrations').then(snapshot => { if (section !== 'integrations' || generation !== detailGeneration) return; content.replaceChildren(); renderLab(content, snapshot); for (const draft of pendingLabDrafts) { const form = [...editorForms].find(item => item.dataset.editor === draft.key); if (!form) continue; for (const input of controls(form)) { const saved = draft.values.find(item => item.name === input.name); if (saved) input.value = saved.value; } const scenario = controls(form).find(input => input.name === 'scenario'); if (scenario) { for (const option of form.querySelectorAll('button[data-value]')) option.setAttribute('aria-pressed', String(option.dataset.value === scenario.value)); } dirtyForms.add(form); } pendingLabDrafts = []; }).catch(error => { if (section === 'integrations' && generation === detailGeneration) content.replaceChildren(empty('TEST lab unavailable.',error.message),button('Retry',()=>render())); });
}
function renderLab(panel, snapshot) {
  const readiness = el('section', null, 'card'); readiness.append(el('h3', 'Adapter readiness'), table(Object.entries(snapshot.readiness || {}).map(([provider, state]) => ({provider, ...state})), [['Provider','provider'], ['Status','label'], ['Verified','verified', value => value === true ? 'TEST fixtures only' : 'No']]));
  const form = el('form', null, 'card'); form.dataset.editor = 'integration-scenario'; trackEdits(form); form.append(el('h3','Run a TEST scenario'));
  const scenarioInput = el('input'); scenarioInput.type = 'hidden'; scenarioInput.name = 'scenario'; scenarioInput.value = ''; form.append(scenarioInput); const labels = {'paid-no-eject':'Paid, no ejection','unknown-pickup':'Unknown pickup result','return-unmatched':'Unmatched return','refund-pending':'Refund pending','refund-failed':'Refund failed',success:'Successful return'};
  form.append(segments('Scenario', (snapshot.scenarios || []).map(key => [key,labels[key] || key]), '', key => { scenarioInput.value = key; dirtyForms.add(form); }));
  const save = el('button', canSupport() ? 'Run TEST scenario' : 'Read-only access','button dark'); save.type = 'submit'; save.disabled = !canSupport(); const status = el('p','','form-status'); status.setAttribute('role','status'); form.append(el('p','Creates simulated records only. An unknown pickup result must be reviewed, not retried as a device command.','subtle'), save, status);
  form.addEventListener('submit', async event => { event.preventDefault(); const scenario = scenarioInput.value; if (!scenario) { formError(status,'Choose a TEST scenario.'); return; } if (!canSupport() || mutationPending || form.dataset.saved) return; form.dataset.idempotencyKey ||= crypto.randomUUID(); await saveForm(form,save,status,'/api/admin/integrations/scenarios',{scenario},'TEST scenario recorded.',canSupport,{'Idempotency-Key':form.dataset.idempotencyKey}); }); panel.append(form);
  panel.append(readiness);
  const cabinets = el('section',null,'card'); cabinets.append(el('h3','TEST cabinet inventory'), el('p','Online status is a simulated observation. Freshness is shown separately; stale inventory must not be treated as a current availability guarantee.','subtle'));
  for (const cabinet of snapshot.cabinets || []) { cabinets.append(facts(cabinet.id,[['Observed connection',cabinet.online ? 'Online (TEST)' : 'Offline (TEST)'],['Freshness',cabinet.freshness],['Last observed',date(cabinet.observedAt)],['Observation age',cabinet.ageSeconds == null ? 'Not recorded' : `${cabinet.ageSeconds} seconds`],['Available banks',cabinet.available]]),table(cabinet.slots,[['Slot','slot'],['Power bank','bankId'],['Status','status']])); }
  if (!snapshot.cabinets?.length) cabinets.append(empty('No TEST observations yet.','Run a scenario to create simulated inventory.')); panel.append(cabinets);
  const funds = el('section',null,'card'); funds.append(el('h3','TEST payment and refund records'),el('p','These are provider-independent simulation records, not live provider query results. Refresh reads the persisted state; it does not retry a payment or refund.','subtle'));
  const columns = [['Record','id'],['TEST run','rentalId'],['Status','status'],['Amount','amount',money]]; funds.append(el('h4','Payments'),table(snapshot.payments,columns),el('h4','Refunds'),table(snapshot.refunds,columns)); panel.append(funds);
  const runs = el('section',null,'card'); runs.append(el('h3','TEST rental and command states'),table(snapshot.runs,[['Run','id'],['Scenario','scenario'],['Rental state','status'],['Financial state','settlementStatus'],['Device operation','operation',(_,row)=>row.operation?.status || 'Not recorded']],row=>{ const detail=el('details'); detail.append(el('summary','Recorded events'),table(row.events,[['Time','occurredAt|at|createdAt',date],['Event','type|event'],['Status','status']])); detail.append(el('h4','Status query history'),table(row.queries,[['Query','id'],['Time','queriedAt',date],['Operation','operationStatus'],['Refund','refundStatus']])); const query = el('form'); query.dataset.editor = `integration-query-${row.id}`; const save = el('button',canSupport() ? 'Query / reconcile TEST status' : 'Read-only access','button secondary small'); save.type='submit'; save.disabled=!canSupport(); const status = el('p','','form-status'); status.setAttribute('role','status'); query.append(save,status); query.addEventListener('submit',async event=>{event.preventDefault(); if (!canSupport() || mutationPending || query.dataset.saved) return; query.dataset.idempotencyKey ||= crypto.randomUUID(); await saveForm(query,save,status,`/api/admin/integrations/runs/${encodeURIComponent(row.id)}/reconcile`,{},'TEST provider status queried. Unknown commands are not retried.',canSupport,{'Idempotency-Key':query.dataset.idempotencyKey});}); detail.append(query); if (row.refund?.status === 'failed' && row.queries?.at(-1)?.refundStatus === 'failed') { const retry = el('form'); retry.dataset.editor = `integration-retry-${row.id}`; const retryButton = el('button',canSupport() ? 'Retry TEST refund' : 'Read-only access','button secondary small'); retryButton.type='submit'; retryButton.disabled=!canSupport(); const retryStatus=el('p','','form-status'); retryStatus.setAttribute('role','status'); retry.append(el('p','Only a query-confirmed failed TEST refund can be retried. Acceptance remains pending until queried again. The refund identity and amount do not change.','subtle'),retryButton,retryStatus); retry.addEventListener('submit',async event=>{event.preventDefault(); if(!canSupport() || mutationPending || retry.dataset.saved) return; retry.dataset.idempotencyKey ||= crypto.randomUUID(); await saveForm(retry,retryButton,retryStatus,`/api/admin/integrations/runs/${encodeURIComponent(row.id)}/retry-refund`,{},'TEST refund retry accepted as pending. Query its status to confirm the outcome.',canSupport,{'Idempotency-Key':retry.dataset.idempotencyKey});}); detail.append(retry); } return detail; })); panel.append(runs);
  const exceptions = el('section',null,'card'); exceptions.append(el('h3','TEST reconciliation queue'),el('p','Closing a review records an operational annotation only. It does not confirm pickup, match a return, complete a refund, or change financial/device state.','subtle'));
  if (!snapshot.exceptions?.length) exceptions.append(empty('No reconciliation exceptions.',''));
  for (const item of snapshot.exceptions || []) {
    const review = el('form',null,'ticket'); review.dataset.editor = `integration-exception-${item.id}`; trackEdits(review);
    review.append(el('h4',item.type),el('span',item.status,'badge'),el('p',`TEST run: ${item.rentalId || 'Not recorded'}`,'ticket-meta'),el('p',item.guidance || 'Review the recorded evidence before closing this item.'));
    if (item.status === 'resolved') { review.append(el('p',item.resolutionNote),el('p',`Review closed: ${date(item.resolvedAt)}. Underlying states are unchanged.`,'subtle')); }
    else { const note = field(review,'Review note','note','text','',{required:true,maxLength:1000}); note.minLength=5; note.disabled=!canSupport(); const save=el('button',canSupport()?'Close review with note':'Read-only access','button secondary small'); save.type='submit'; save.disabled=!canSupport(); const status=el('p','','form-status'); status.setAttribute('role','status'); review.append(save,status); review.addEventListener('submit',async event=>{event.preventDefault(); if(note.value.trim().length < 5 || note.value.trim().length > 1000){formError(status,'Enter a review note between 5 and 1,000 characters.');return;} await saveForm(review,save,status,`/api/admin/integrations/exceptions/${encodeURIComponent(item.id)}/resolve`,{note:note.value.trim()},'Review annotation saved. Device and financial states are unchanged.',canSupport);}); }
    exceptions.append(review);
  } panel.append(exceptions);
}
function render() {
  const panel = $('admin-panel'); detailGeneration++; dirtyForms.clear(); editorForms.clear(); panel.replaceChildren(); $('page-title').textContent = sections[section][0]; document.title = `Smile · ${sections[section][0]}`; for (const link of $('admin-nav').children) { const active = link.dataset.section === section; link.classList.toggle('active', active); if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); }
  if (initialLoadFailed) { panel.append(empty('Dashboard unavailable.', 'Use Refresh to try again. No records have been loaded.')); return; }
  if (section === 'dashboard') overview(panel); else if (section === 'stations') stations(panel); else if (section === 'pricing') pricing(panel); else if (section === 'support') support(panel);
  else if (section === 'integrations') { hardwareTestPanel(panel); const card = el('section', null, 'card'); card.append(el('h3', 'Services'), integrationList(), el('p', 'Configuration status only. Live connectivity is unverified.', 'subtle')); panel.append(card, el('div', 'Live payments and cabinet controls are unavailable.', 'notice')); wschargePanel(panel); integrationLab(panel); }
  else if (section === 'orders') orderList(panel);
  else if (section === 'queue') workQueue(panel);
  else if (section === 'payments') { contextHeading(panel); const columns = [['Payment', 'id'], ['Order', 'rentalId|orderId'], ['Type', 'type', kind => ({ deposit: 'Deposit', refund: 'Refund', settlement: 'Legacy settlement', rental_fee: 'Rental fee', authorization: 'Legacy authorization' }[kind] || kind || '—')], ['Amount', 'amount', money], ['Currency', 'currency'], ['Status', 'status'], ['Date', 'createdAt', date]]; panel.append(el('div', 'Recorded payments only. Live payment processing is unavailable.', 'service-note'), table((data.payments || []).filter(row => !contextFilter || (contextFilter.mode !== 'test' && (row.rentalId || row.orderId) === contextFilter.rentalId)), columns)); testRecords(panel, 'Test payments', (data.testPayments || []).filter(row => !contextFilter || (contextFilter.mode !== 'live' && (row.rentalId || row.orderId) === contextFilter.rentalId)), columns); }
  else if (section === 'users') { contextHeading(panel); panel.append(table((data.users || []).filter(row => !contextFilter || row.id === contextFilter.userId), [['Name', 'name'], ['Identity', 'provider', (v, row) => row.isTest || row.testOnly || v === 'google_test' ? 'TEST · Google simulation' : v === 'google' ? 'Google' : v], ['Email', 'email'], ['User ID', 'id'], ['Joined', 'createdAt|created_at', date]])); }
  else if (section === 'audit') auditLog(panel);
  if (['orders','payments'].includes(section)) hardwareTestPanel(panel);
}
function navigate(next) { if (mutationPending) { notice('Wait for the current save to finish.'); return; } if (next === section) { if (!dirtyForms.size) render(); return; } leaveEditor(() => { contextFilter = null; orderSelection = null; section = sections[next] ? next : 'dashboard'; location.hash = section; notice(''); render(); }); }
async function load() {
  if (loading) return loading;
  const refresh = $('reload-dashboard'); refresh.disabled = true; refresh.textContent = 'Refreshing…';
  $('admin-panel').setAttribute('aria-busy', 'true'); $('admin-panel').inert = true;
  loading = (async () => {
    try {
      const snapshot = await api('/api/admin/dashboard');
      const drafts = [...dirtyForms].map(form => ({ key: form.dataset.editor, expectedUpdatedAt: form.dataset.expectedUpdatedAt, values: controls(form).map(input => ({ name: input.name, value: input.value, checked: input.checked })) }));
      pendingLabDrafts = section === 'integrations' ? drafts : []; data = snapshot; hasLoaded = true; initialLoadFailed = false; render();
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
window.addEventListener('hashchange', () => { const next = location.hash.slice(1); if (sections[next] && section !== next) { if (mutationPending || dirtyForms.size) { location.hash = section; navigate(next); return; } contextFilter = null; orderSelection = null; section = next; notice(''); render(); } });
(async () => { if (location.pathname === '/admin/login') { $('boot-status').classList.add('hidden'); $('login-view').classList.remove('hidden'); return; } try { session = await api('/api/admin/session'); if (!session.user) { location.replace('/admin/login'); return; } $('admin-identity').textContent = `${session.user.name || session.user.username || 'Administrator'} · ${session.user.role || 'read-only'}`; section = sections[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard'; for (const [key, [label, symbol]] of Object.entries(sections)) { if (key === 'pricing') $('admin-nav').append(el('span', 'SETTINGS', 'workspace-label ops-nav-group')); const link = el('a', null, 'nav-item'); link.href = `#${key}`; link.dataset.section = key; link.append(el('span', symbol, 'nav-symbol'), el('span', label)); link.addEventListener('click', event => { event.preventDefault(); navigate(key); }); $('admin-nav').append(link); } $('admin-view').classList.remove('hidden'); $('boot-status').classList.add('hidden'); await load(); } catch (error) { $('boot-status').textContent = 'Could not load. Refresh to try again.'; notice(error.message, true); } })();

if (typeof setInterval === 'function') setInterval(() => { if (session.user && document.visibilityState !== 'hidden' && ['dashboard','stations'].includes(section) && !loading && !mutationPending && !dirtyForms.size && !editorForms.size) load().catch(() => {}); }, 30000);

function hardwareTestPanel(panel) {
 const card=el('section',null,'card');card.append(el('h3','真机扫码测试 · 模拟支付'),el('p','所有已登录账号默认可以测试，无需申请或逐个授权。真实弹出，模拟支付，不会扣款。'));panel.append(card);
 const content=el('div');card.append(button('刷新真机测试',read),content);
 async function read(){try{const snapshot=await api('/api/admin/hardware-test');if(!card.isConnected)return;content.replaceChildren();content.append(el('p',`测试入口：${snapshot.enabled?'开启':'关闭'} · 弹出：${snapshot.dispatchEnabled?'开启':'关闭'}`));
 for(const c of data.deviceCabinets||[]){const link=el('a','租借链接 · '+c.cabinetId);link.href='/rent?cabinet='+encodeURIComponent(c.cabinetId);content.append(link,el('br'));}
 const qr=el('a','下载本次测试机柜二维码（TDMB081675764251）');qr.href='/cabinet-test-qr.png';qr.download='TDMB081675764251.png';content.append(qr);
 content.append(el('h4','真机测试订单'),table(snapshot.orders,[['订单','id'],['账号','userId'],['机柜','cabinetId'],['仓位','slot'],['充电宝','bankId'],['状态','status'],['开始','startedAt',date],['归还','returnedAt',date],['模拟费用（最小货币单位）','totalAmount'],['模拟退款（最小货币单位）','refundAmount']]));
 content.append(el('h4','模拟支付账本 · 无实际扣款'),table(snapshot.payments,[['订单','rentalId'],['类型','type'],['金额（最小货币单位）','amount'],['货币','currency'],['时间','createdAt',date]]));
 }catch(e){content.replaceChildren(el('p',e.message));}}
 read();
}
