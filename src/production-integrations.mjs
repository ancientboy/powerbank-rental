/** Admin-only, persisted integration contract laboratory. No network or vendor credentials.
 * All contracts below are INTERNAL normalized contracts, not PVS/WsCharge wire formats.
 * A real adapter must authenticate callbacks, correlate operations and supply trusted time.
 */
import { testPricing, estimateTestRental } from './production-test-rental.mjs';
import { createHash } from 'node:crypto';
import { listRecords, putRecord, recordAudit, transaction } from './production-store.mjs';

export const integrationScenarios = Object.freeze([
  'paid-no-eject', 'unknown-pickup', 'return-unmatched', 'refund-pending', 'refund-failed', 'success',
]);
export const normalizedContract = Object.freeze({
  version: 'normalized-lab-v1', testOnly: true,
  paymentStates: ['pending', 'succeeded', 'failed', 'unknown'],
  refundStates: ['not_requested', 'pending', 'succeeded', 'failed', 'unknown'],
  operationStates: ['not_requested', 'accepted', 'failed', 'unknown', 'confirmed'],
  events: ['payment.succeeded', 'operation.accepted', 'operation.failed', 'operation.unknown', 'pickup.confirmed', 'return.confirmed', 'return.unmatched', 'refund.requested', 'refund.retry_requested', 'refund.pending', 'refund.failed', 'refund.succeeded'],
  requiredEventFields: ['id', 'rentalId', 'type', 'occurredAt', 'sequence', 'source', 'testOnly'],
  notes: [
    'Internal normalized examples only. PVS supplier protocol is not specified.',
    'WsCharge codec is offline only. I65 S200 acknowledges a command, not physical pickup.',
    'WsCharge I66 alone lacks trusted timestamp/authentication; it cannot settle a rental.',
    'Live transport, authentication, callback verification and provider certification are not implemented.',
    'Unknown operations require query/reconciliation. Never blindly retry an eject or refund.',
    'Refund request acceptance is pending, never proof of final refund.',
  ],
});
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const requireThat = (condition, message, status = 400) => { if (!condition) fail(status, message); };
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const idOK = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(x);
const iso = n => new Date(n).toISOString();
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const checkNow = now => requireThat(Number.isSafeInteger(now) && now > 0 && now <= 8640000000000000, 'Valid server time required');
const timestamp = (value, now) => {
  requireThat(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value), 'Canonical UTC timestamp required');
  const time = Date.parse(value);
  requireThat(Number.isFinite(time) && iso(time) === value && time <= now, 'Invalid or future event timestamp');
  return time;
};
function authorize(actor) {
  requireThat(object(actor) && idOK(actor.id) && ['owner', 'operator'].includes(actor.role), 'Owner or operator required for TEST integration changes', 403);
}
const read = db => listRecords(db, 'integration_lab').find(x => x.id === 'mock-v1') || { id: 'mock-v1', version: 1, testOnly: true, runs: [], exceptions: [] };
const save = (db, lab) => putRecord(db, 'integration_lab', lab.id, lab);

/** Reject ambiguous inventory rather than inventing available banks or supplier fields. */
export function normalizeCabinetSnapshot(input, now = Date.now()) {
  checkNow(now);
  requireThat(object(input) && input.testOnly === true && input.source === 'mock', 'Only explicit mock inventory is supported');
  requireThat(idOK(input.id) && typeof input.online === 'boolean' && Array.isArray(input.slots) && input.slots.length <= 128, 'Invalid normalized cabinet');
  const observed = timestamp(input.observedAt, now);
  const slotIds = new Set(), bankIds = new Set();
  const slots = input.slots.map(slot => {
    requireThat(object(slot) && Number.isInteger(slot.slot) && slot.slot >= 1 && slot.slot <= 128 && !slotIds.has(slot.slot), 'Duplicate or invalid slot');
    slotIds.add(slot.slot);
    requireThat(['available', 'empty', 'fault', 'unknown'].includes(slot.status), 'Invalid slot status');
    requireThat(slot.bankId === null || (idOK(slot.bankId) && !bankIds.has(slot.bankId)), 'Duplicate or invalid bank ID');
    requireThat(slot.status !== 'available' || slot.bankId !== null, 'Available slot needs a bank ID');
    requireThat(slot.status !== 'empty' || slot.bankId === null, 'Empty slot cannot contain a bank');
    if (slot.bankId !== null) bankIds.add(slot.bankId);
    return { slot: slot.slot, bankId: slot.bankId, status: slot.status };
  });
  const ageSeconds = Math.floor((now - observed) / 1000);
  const fresh = ageSeconds <= 120;
  return { id: input.id, source: 'mock', testOnly: true, online: input.online, observedAt: input.observedAt, ageSeconds, fresh, freshness: fresh ? 'fresh' : 'stale', available: input.online && fresh ? slots.filter(x => x.status === 'available').length : 0, slots };
}

/** Pure, deterministic projection. Call only after an adapter has authenticated its source.
 * This implementation deliberately only accepts TEST/mock events. No ingress API exists.
 */
export function applyNormalizedLabEvent(run, event, now) {
  checkNow(now);
  requireThat(object(run) && run.testOnly === true && object(event) && event.testOnly === true && event.source === 'mock', 'Only isolated mock events are supported');
  requireThat(idOK(event.id) && event.rentalId === run.id && normalizedContract.events.includes(event.type), 'Invalid event correlation or type');
  requireThat(Number.isSafeInteger(event.sequence) && event.sequence > 0, 'Positive event sequence required');
  const at = timestamp(event.occurredAt, now);
  requireThat(at >= Date.parse(run.createdAt), 'Event predates rental');
  const hash = fingerprint({ id: event.id, rentalId: event.rentalId, type: event.type, occurredAt: event.occurredAt, sequence: event.sequence, source: event.source, testOnly: event.testOnly });
  const previous = run.events.find(x => x.id === event.id);
  if (previous) { requireThat(previous.fingerprint === hash, 'Duplicate event ID has conflicting payload', 409); return { duplicate: true, run }; }
  requireThat(event.sequence === run.events.length + 1 && (!run.events.length || at >= Date.parse(run.events.at(-1).occurredAt)), 'Out-of-order event requires reconciliation; projection unchanged', 409);
  const next = structuredClone(run);
  const expect = (condition, message) => requireThat(condition, message, 409);
  switch (event.type) {
    case 'payment.succeeded':
      expect(next.payment.status === 'pending', 'Payment already finalized');
      next.payment.status = 'succeeded'; next.status = 'awaiting_pickup'; break;
    case 'operation.accepted':
      expect(next.payment.status === 'succeeded' && next.operation.status === 'not_requested', 'Operation cannot be accepted in this state');
      next.operation.status = 'accepted'; break;
    case 'operation.failed':
    case 'operation.unknown':
      expect(next.status === 'awaiting_pickup' && ['accepted', 'not_requested'].includes(next.operation.status), 'Operation result conflicts with current state');
      next.operation.status = event.type.endsWith('failed') ? 'failed' : 'unknown';
      next.status = event.type.endsWith('failed') ? 'pickup_failed' : 'pickup_unknown'; break;
    case 'pickup.confirmed':
      expect(next.status === 'awaiting_pickup' && next.operation.status === 'accepted', 'Explicit correlated pickup evidence required; unknown operations need reconciliation');
      next.operation.status = 'confirmed'; next.startedAt = event.occurredAt; next.status = 'active'; break;
    case 'return.confirmed':
      expect(next.status === 'active' && next.startedAt && at >= Date.parse(next.startedAt), 'Return must follow confirmed pickup');
      next.status = 'completed'; next.returnedAt = event.occurredAt;
      expect(object(next.pricing) && Number.isSafeInteger(next.pricing.hourlyRate) && next.pricing.hourlyRate > 0 && Number.isSafeInteger(next.pricing.dailyCap) && next.pricing.dailyCap > 0, 'Rental pricing snapshot is required');
      next.feeAmount = estimateTestRental({ ...next, status: 'active' }, at).totalAmount;
      expect(Number.isSafeInteger(next.feeAmount), 'Calculated fee exceeds safe amount range');
      next.depositApplied = Math.min(next.payment.amount, next.feeAmount);
      next.refund.amount = Math.max(0, next.payment.amount - next.feeAmount);
      next.outstandingAmount = Math.max(0, next.feeAmount - next.payment.amount);
      next.settlementStatus = next.outstandingAmount ? 'review_required' : next.refund.amount ? 'refund_required' : 'settled'; break;
    case 'return.unmatched':
      // No rental close, fee, or refund is inferred from an uncorrelated observation.
      next.unmatchedReturn = true; break;
    case 'refund.requested':
      expect(next.status === 'completed' && next.refund.amount > 0 && next.refund.status === 'not_requested', 'Refund request requires settled fee and may only occur once');
      next.refund.status = 'pending'; next.settlementStatus = 'refund_pending'; break;
    case 'refund.retry_requested':
      expect(next.refund.status === 'failed', 'Only a confirmed failed refund can be retried');
      next.refund.status = 'pending'; next.settlementStatus = 'refund_pending'; break;
    case 'refund.pending':
    case 'refund.failed':
    case 'refund.succeeded':
      expect(next.refund.status === 'pending', 'Refund result requires an outstanding request');
      next.refund.status = event.type.split('.')[1];
      next.settlementStatus = next.refund.status === 'succeeded' ? 'settled' : `refund_${next.refund.status}`; break;
  }
  next.updatedAt = event.occurredAt;
  const stored = Object.fromEntries(normalizedContract.requiredEventFields.map(key => [key, event[key]]));
  next.events.push({ ...stored, fingerprint: hash });
  Object.assign(run, next);
  return { duplicate: false, run };
}

function buildRun(scenario, key, actor, now) {
  const id = 'lab_' + fingerprint({ actor: actor.id, key }).slice(0, 24);
  const createdAt = iso(now);
  const run = { id, scenario, idempotencyKey: key, actorId: actor.id, createdAt, updatedAt: createdAt, testOnly: true, source: 'mock', pricing: { ...testPricing }, status: 'pending_payment', startedAt: null, returnedAt: null, feeAmount: 0, settlementStatus: 'deposit_held', operation: { id: id + '_op', status: 'not_requested', retryAllowed: false }, payment: { id: id + '_payment', status: 'pending', amount: testPricing.deposit, currency: testPricing.currency, source: 'mock', testOnly: true }, refund: { id: id + '_refund', status: 'not_requested', amount: 0, currency: 'ARS', source: 'mock', testOnly: true }, events: [] };
  const types = ['payment.succeeded', 'operation.accepted'];
  if (scenario === 'paid-no-eject') types.push('operation.failed');
  else if (scenario === 'unknown-pickup') types.push('operation.unknown');
  else {
    types.push('pickup.confirmed');
    if (scenario === 'return-unmatched') types.push('return.unmatched');
    else {
      types.push('return.confirmed', 'refund.requested');
      types.push(scenario === 'success' ? 'refund.succeeded' : scenario === 'refund-failed' ? 'refund.failed' : 'refund.pending');
    }
  }
  types.forEach((type, i) => applyNormalizedLabEvent(run, { id: id + '_event_' + (i + 1), rentalId: id, type, sequence: i + 1, occurredAt: createdAt, source: 'mock', testOnly: true }, now));
  return run;
}
function cabinetFixture(observedAt) {
  return { id: 'LAB-CABINET-001', online: true, observedAt, source: 'mock', testOnly: true, slots: [{ slot: 1, bankId: 'LAB-BANK-001', status: 'available' }, { slot: 2, bankId: null, status: 'empty' }, { slot: 3, bankId: 'LAB-BANK-003', status: 'fault' }] };
}
export function integrationView(db, now = Date.now()) {
  checkNow(now);
  const lab = read(db);
  return {
    testOnly: true, mode: 'mock', serverNow: iso(now), contract: normalizedContract, scenarios: integrationScenarios,
    readiness: {
      mock: { configured: true, verified: true, ready: true, label: 'Isolated TEST fixtures only' },
      pvs: { configured: false, verified: false, ready: false, label: 'Protocol and live adapter not implemented' },
      wscharge: { configured: false, verified: false, ready: false, label: 'Offline codec only; live transport and authenticated events not implemented' },
    },
    cabinets: lab.cabinet ? [normalizeCabinetSnapshot(lab.cabinet, now)] : [],
    runs: [...lab.runs].reverse(),
    payments: [...lab.runs].reverse().map(r => ({ ...r.payment, rentalId: r.id })),
    refunds: [...lab.runs].reverse().filter(r => r.refund.status !== 'not_requested').map(r => ({ ...r.refund, rentalId: r.id })),
    exceptions: [...lab.exceptions].reverse(),
    summary: { runs: lab.runs.length, openExceptions: lab.exceptions.filter(x => x.status === 'open').length },
  };
}
export function applyIntegrationScenario(db, { scenario, idempotencyKey, actor, now = Date.now() }) {
  authorize(actor); checkNow(now);
  requireThat(integrationScenarios.includes(scenario), 'Unsupported TEST scenario');
  requireThat(typeof idempotencyKey === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey), 'Idempotency key must be 8–128 letters, numbers, underscore or hyphen');
  return transaction(db, () => {
    const lab = read(db);
    const existing = lab.runs.find(r => r.actorId === actor.id && r.idempotencyKey === idempotencyKey);
    if (existing) {
      requireThat(existing.scenario === scenario, 'Idempotency key already used for a different scenario', 409);
      return { ...integrationView(db, now), run: existing, replayed: true };
    }
    requireThat(lab.runs.length < 200, 'TEST laboratory limit reached (200 runs); preserve audit records and use a fresh test database', 409);
    const run = buildRun(scenario, idempotencyKey, actor, now);
    lab.runs.push(run); lab.cabinet = cabinetFixture(iso(now));
    if (scenario !== 'success') lab.exceptions.push({ id: run.id + '_exception', rentalId: run.id, type: scenario, status: 'open', createdAt: iso(now), testOnly: true, resolutionNote: null, resolvedAt: null, resolvedBy: null, guidance: scenario === 'unknown-pickup' ? 'Query and reconcile trusted device evidence. Do not blindly resend an eject.' : scenario.startsWith('refund-') ? 'Query provider refund status. Request acceptance is not final payment evidence.' : scenario === 'return-unmatched' ? 'Correlate bank, cabinet, rental and trusted event time before settling.' : 'Confirm no physical pickup before approving any compensating refund.' });
    save(db, lab); recordAudit(db, actor.id, 'integration.test.scenario.' + scenario, run.id, now);
    return { ...integrationView(db, now), run, replayed: false };
  });
}
export function resolveIntegrationException(db, { exceptionId, note, actor, now = Date.now() }) {
  authorize(actor); checkNow(now);
  requireThat(typeof note === 'string' && note.trim().length >= 5 && note.trim().length <= 1000, 'Resolution note must be 5–1000 characters');
  return transaction(db, () => {
    const lab = read(db), exception = lab.exceptions.find(x => x.id === exceptionId);
    requireThat(exception, 'TEST exception not found', 404);
    if (exception.status === 'resolved') {
      requireThat(exception.resolutionNote === note.trim(), 'Exception already resolved; original audit note cannot be replaced', 409);
      return integrationView(db, now);
    }
    requireThat(now >= Date.parse(exception.createdAt), 'Resolution cannot predate exception');
    Object.assign(exception, { status: 'resolved', resolutionNote: note.trim(), resolvedAt: iso(now), resolvedBy: actor.id });
    // A case resolution is an annotation only. Never change rental, payment or device truth.
    save(db, lab); recordAudit(db, actor.id, 'integration.test.exception.resolve', exception.id, now);
    return integrationView(db, now);
  });
}

/** Safe adapter seam for future implementation; never silently fall back from live to mock. */
export function createIntegrationAdapter({ mode = 'mock', db, now = Date.now } = {}) {
  requireThat(mode === 'mock', 'Live provider adapter is not implemented or verified; operation blocked', 503);
  requireThat(db && typeof db.prepare === 'function', 'Database is required');
  const query = (collection, id) => { requireThat(idOK(id), 'Invalid query ID'); return integrationView(db, now())[collection].find(x => x.id === id) || null; };
  return Object.freeze({ mode: 'mock', testOnly: true, getInventory: () => integrationView(db, now()).cabinets, queryPayment: id => query('payments', id), queryRefund: id => query('refunds', id), queryReconciliation: id => {
    const run = integrationView(db, now()).runs.find(r => r.id === id);
    if (!run) return null;
    // Explicit fixture: first refund status query observes provider final success.
    // Unknown pickup deliberately stays unknown: no invented physical evidence.
    return { rentalId: run.id, operationId: run.operation.id, refundId: run.refund.id, operationStatus: run.operation.status, refundStatus: (run.scenario === 'refund-pending' || (run.scenario === 'refund-failed' && run.refund.status === 'pending' && run.commands?.length)) ? 'succeeded' : run.refund.status, observedAt: iso(now()), source: 'mock', testOnly: true };
  }, queryOperation: id => { requireThat(idOK(id), 'Invalid query ID'); const run = integrationView(db, now()).runs.find(r => r.operation.id === id); return run ? { ...run.operation, rentalId: run.id, testOnly: true } : null; }, requestEject: request => {
    requireThat(object(request) && idOK(request.operationId) && idOK(request.idempotencyKey), 'Normalized mock operation request required');
    const run = read(db).runs.find(r => r.operation.id === request.operationId);
    requireThat(run && ['not_requested', 'accepted'].includes(run.operation.status), 'Unknown or terminal operations cannot be blindly retried', 409);
    return { operationId: run.operation.id, status: 'accepted', idempotencyKey: request.idempotencyKey, source: 'mock', testOnly: true };
  }, requestRefund: request => {
    requireThat(object(request) && idOK(request.refundId) && idOK(request.idempotencyKey), 'Normalized mock refund request required');
    requireThat(Object.keys(request).every(k => ['refundId', 'idempotencyKey'].includes(k)), 'Refund amount and destination cannot be overridden');
    const run = read(db).runs.find(r => r.refund.id === request.refundId);
    requireThat(run && run.refund.status === 'failed' && run.queries?.at(-1)?.refundStatus === 'failed', 'Query and confirm failure before retry; pending/unknown/final refunds cannot be retried', 409);
    return { refundId: run.refund.id, amount: run.refund.amount, currency: run.refund.currency, status: 'pending', idempotencyKey: request.idempotencyKey, source: 'mock', testOnly: true };
  } });
}


/** Adapter interface: getInventory(), queryPayment(id), queryRefund(id),
 * queryOperation(id), queryReconciliation(rentalId). Queries may be async.
 * Future live adapters must supply authenticated, correlated normalized evidence;
 * changing this mock-only capability gate requires an explicit reviewed integration.
 * Real device dispatch and financial writes remain disabled. Mock command acceptance
 * is distinct from ledger projection and must never be mistaken for final settlement.
 */
export async function reconcileIntegrationRun(db, { runId, idempotencyKey, actor, now = Date.now(), adapter }) {
  authorize(actor); checkNow(now);
  requireThat(idOK(runId), 'Invalid TEST run ID');
  requireThat(typeof idempotencyKey === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey), 'Valid idempotency key required');
  const initial = read(db).runs.find(r => r.id === runId);
  requireThat(initial, 'TEST run not found', 404);
  const key = actor.id + ':' + idempotencyKey;
  const prior = (initial.queries || []).find(q => q.key === key);
  if (prior) return { ...integrationView(db, now), run: initial, replayed: true };
  requireThat((initial.queries || []).length < 100, 'TEST query history limit reached', 409);
  const provider = adapter || createIntegrationAdapter({ db, now: () => now });
  requireThat(provider.mode === 'mock' && provider.testOnly === true && typeof provider.queryReconciliation === 'function', 'Only explicit mock adapter queries are implemented', 503);
  const result = await provider.queryReconciliation(runId);
  requireThat(object(result) && result.testOnly === true && result.source === 'mock' && result.rentalId === runId && result.operationId === initial.operation.id && result.refundId === initial.refund.id, 'Untrusted or uncorrelated query result', 409);
  timestamp(result.observedAt, now);
  requireThat(Date.parse(result.observedAt) >= Date.parse(initial.updatedAt), 'Stale provider query result', 409);
  requireThat(normalizedContract.operationStates.includes(result.operationStatus) && normalizedContract.refundStates.includes(result.refundStatus), 'Invalid normalized provider status');
  // Querying an existing operation never creates physical pickup evidence.
  requireThat(result.operationStatus === initial.operation.status, 'Changed operation requires authenticated physical evidence; manual reconciliation needed', 409);
  const acceptedRefund = result.refundStatus === initial.refund.status || (initial.refund.status === 'pending' && ['succeeded', 'failed'].includes(result.refundStatus));
  requireThat(acceptedRefund, 'Refund query conflicts with existing ledger; no automatic retry', 409);
  return transaction(db, () => {
    const lab = read(db), run = lab.runs.find(r => r.id === runId);
    const duplicate = (run.queries || []).find(q => q.key === key);
    if (duplicate) return { ...integrationView(db, now), run, replayed: true };
    requireThat(fingerprint(run) === fingerprint(initial), 'Run changed while querying; query again with a new key', 409);
    if (run.refund.status !== result.refundStatus) applyNormalizedLabEvent(run, { id: 'query_' + fingerprint({ runId, key }).slice(0, 24), rentalId: runId, type: 'refund.' + result.refundStatus, sequence: run.events.length + 1, occurredAt: result.observedAt, source: 'mock', testOnly: true }, now);
    run.queries ||= [];
    run.queries.push({ id: 'query_' + fingerprint({ runId, key }).slice(0, 24), key, queriedAt: iso(now), operationStatus: result.operationStatus, refundStatus: result.refundStatus, testOnly: true });
    save(db, lab); recordAudit(db, actor.id, 'integration.test.query', run.id, now);
    return { ...integrationView(db, now), run, replayed: false };
  });
}


/** Retry one confirmed failed mock refund, retaining identity and fixed ledger amount.
 * Acceptance is persisted as pending; final state requires a separate provider query.
 */
export async function retryIntegrationRefund(db, { runId, idempotencyKey, actor, now = Date.now(), adapter }) {
  authorize(actor); checkNow(now);
  requireThat(idOK(runId) && typeof idempotencyKey === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey), 'Valid run and idempotency key required');
  const initial = read(db).runs.find(r => r.id === runId);
  requireThat(initial, 'TEST run not found', 404);
  const key = actor.id + ':' + idempotencyKey;
  if ((initial.commands || []).some(c => c.key === key)) return { ...integrationView(db, now), run: initial, replayed: true };
  requireThat(initial.refund.status === 'failed' && initial.queries?.at(-1)?.refundStatus === 'failed', 'Query and confirm refund failure before retrying; no blind retries', 409);
  const provider = adapter || createIntegrationAdapter({ db, now: () => now });
  requireThat(provider.mode === 'mock' && provider.testOnly === true && typeof provider.requestRefund === 'function', 'Live refund writes are not implemented', 503);
  const result = await provider.requestRefund({ refundId: initial.refund.id, idempotencyKey });
  requireThat(object(result) && result.source === 'mock' && result.testOnly === true && result.refundId === initial.refund.id && result.amount === initial.refund.amount && result.currency === initial.refund.currency && result.idempotencyKey === idempotencyKey && result.status === 'pending', 'Invalid refund acceptance; no settlement inferred', 409);
  return transaction(db, () => {
    const lab = read(db), run = lab.runs.find(r => r.id === runId);
    if ((run.commands || []).some(c => c.key === key)) return { ...integrationView(db, now), run, replayed: true };
    requireThat(fingerprint(run) === fingerprint(initial), 'Run changed during refund request; reconcile before retry', 409);
    const id = 'cmd_' + fingerprint({ runId, key }).slice(0, 24);
    applyNormalizedLabEvent(run, { id, rentalId: run.id, type: 'refund.retry_requested', sequence: run.events.length + 1, occurredAt: iso(now), source: 'mock', testOnly: true }, now);
    run.commands ||= [];
    run.commands.push({ id, key, type: 'refund.retry', refundId: run.refund.id, status: 'accepted', createdAt: iso(now), testOnly: true });
    save(db, lab); recordAudit(db, actor.id, 'integration.test.refund.retry', run.id, now);
    return { ...integrationView(db, now), run, replayed: false };
  });
}
