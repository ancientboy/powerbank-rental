import test from 'node:test';
import assert from 'node:assert/strict';
import { openProductionStore } from '../src/production-store.mjs';
import { integrationScenarios, integrationView, applyIntegrationScenario, resolveIntegrationException, applyNormalizedLabEvent, normalizeCabinetSnapshot, createIntegrationAdapter, reconcileIntegrationRun, retryIntegrationRefund } from '../src/production-integrations.mjs';
const now = Date.parse('2026-10-22T07:00:00.000Z');
const actor = { id: 'owner_1', role: 'owner' };
const scenario = (db, name, key = 'test_key_123') => applyIntegrationScenario(db, { scenario: name, idempotencyKey: key, actor, now });

test('lab is empty until explicit mutation; all scenarios are isolated, persisted and TEST marked', () => {
  const db = openProductionStore(':memory:');
  assert.equal(integrationView(db, now).cabinets.length, 0);
  for (const name of integrationScenarios) {
    const result = scenario(db, name, 'scenario_' + name);
    assert.equal(result.run.testOnly, true);
    assert.equal(result.run.payment.status, 'succeeded');
  }
  assert.equal(integrationView(db, now).runs.length, 6);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM test_rentals').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM test_records').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind!='integration_lab'").get().n, 0);
  const fresh = integrationView(db, now), stale = integrationView(db, now + 121000);
  assert.equal(fresh.cabinets[0].available, 1);
  assert.equal(stale.cabinets[0].fresh, false);
  assert.equal(stale.cabinets[0].available, 0);
  db.close();
});
test('ACK/unknown pickup never starts billing, unmatched return never settles', () => {
  const db = openProductionStore(':memory:');
  for (const name of ['paid-no-eject', 'unknown-pickup']) {
    const { run } = scenario(db, name, 'scenario_' + name);
    assert.equal(run.startedAt, null); assert.equal(run.feeAmount, 0); assert.equal(run.refund.status, 'not_requested');
    assert.equal(run.operation.retryAllowed, false);
  }
  const { run } = scenario(db, 'return-unmatched');
  assert.equal(run.status, 'active'); assert.equal(run.returnedAt, null); assert.equal(run.feeAmount, 0);
  db.close();
});
test('refund request accepted remains pending, only confirmed success settles once', () => {
  const db = openProductionStore(':memory:');
  const pending = scenario(db, 'refund-pending', 'pending_key').run;
  assert.equal(pending.refund.status, 'pending'); assert.equal(pending.settlementStatus, 'refund_pending');
  const failed = scenario(db, 'refund-failed', 'failed_key').run;
  assert.equal(failed.refund.status, 'failed'); assert.equal(failed.settlementStatus, 'refund_failed');
  const success = scenario(db, 'success', 'success_key').run;
  assert.equal(success.refund.status, 'succeeded'); assert.equal(success.settlementStatus, 'settled');
  assert.equal(success.payment.amount, success.refund.amount + success.feeAmount);
  const duplicate = scenario(db, 'success', 'success_key');
  assert.equal(duplicate.replayed, true); assert.equal(duplicate.run.id, success.id);
  assert.equal(integrationView(db, now).runs.length, 3);
  assert.throws(() => scenario(db, 'unknown-pickup', 'success_key'), { status: 409 });
  db.close();
});
test('normalized reducer rejects out of order, invalid time and conflicts atomically; exact duplicate harmless', () => {
  const db = openProductionStore(':memory:');
  const run = scenario(db, 'unknown-pickup').run;
  const before = JSON.stringify(run);
  assert.equal(applyNormalizedLabEvent(run, { ...run.events[0] }, now).duplicate, true);
  assert.throws(() => applyNormalizedLabEvent(run, { ...run.events[0], type: 'operation.failed' }, now), { status: 409 });
  const next = { id: 'event_next', rentalId: run.id, type: 'pickup.confirmed', source: 'mock', testOnly: true, sequence: run.events.length + 1, occurredAt: new Date(now).toISOString() };
  assert.throws(() => applyNormalizedLabEvent(run, { ...next, sequence: 99 }, now), { status: 409 });
  assert.throws(() => applyNormalizedLabEvent(run, { ...next, occurredAt: new Date(now + 1).toISOString() }, now), { status: 400 });
  assert.throws(() => applyNormalizedLabEvent(run, { ...next, source: 'wscharge' }, now), { status: 400 });
  assert.throws(() => applyNormalizedLabEvent(run, next, now), { status: 409 });
  assert.equal(JSON.stringify(run), before);
  db.close();
});
test('inventory rejects duplicated slots/banks, missing IDs, future time and untrusted source', () => {
  const snapshot = { id: 'cabinet_1', online: true, observedAt: new Date(now).toISOString(), source: 'mock', testOnly: true, slots: [{ slot: 1, status: 'available', bankId: 'bank_1' }] };
  assert.equal(normalizeCabinetSnapshot(snapshot, now).available, 1);
  assert.equal(normalizeCabinetSnapshot({ ...snapshot, online: false }, now).available, 0);
  for (const bad of [{ ...snapshot, slots: [...snapshot.slots, ...snapshot.slots] }, { ...snapshot, slots: [...snapshot.slots, { ...snapshot.slots[0], slot: 2 }] }, { ...snapshot, slots: [{ slot: 1, status: 'available', bankId: null }] }, { ...snapshot, observedAt: new Date(now + 1).toISOString() }, { ...snapshot, source: 'pvs' }]) assert.throws(() => normalizeCabinetSnapshot(bad, now), { status: 400 });
});
test('resolution requires operator, persists note and audit without changing money/device truth', () => {
  const db = openProductionStore(':memory:');
  const view = scenario(db, 'refund-failed');
  const exceptionId = view.exceptions[0].id;
  assert.throws(() => resolveIntegrationException(db, { exceptionId, note: 'Manual review', actor: { id: 'viewer', role: 'viewer' }, now }), { status: 403 });
  assert.throws(() => resolveIntegrationException(db, { exceptionId, note: 'x', actor, now }), { status: 400 });
  const result = resolveIntegrationException(db, { exceptionId, note: 'Confirmed test case review', actor, now });
  assert.equal(result.exceptions[0].status, 'resolved');
  assert.deepEqual(result.runs, view.runs);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='integration.test.exception.resolve'").get().n, 1);
  resolveIntegrationException(db, { exceptionId, note: 'Confirmed test case review', actor, now });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='integration.test.exception.resolve'").get().n, 1);
  assert.throws(() => resolveIntegrationException(db, { exceptionId, note: 'Overwrite original evidence', actor, now }), { status: 409 });
  db.close();
});
test('adapter queries normalized records; live and direct financial/device writes fail closed', () => {
  const db = openProductionStore(':memory:');
  const { run } = scenario(db, 'refund-pending');
  const adapter = createIntegrationAdapter({ db, now: () => now });
  assert.equal(adapter.queryPayment(run.payment.id).status, 'succeeded');
  assert.equal(adapter.queryRefund(run.refund.id).status, 'pending');
  assert.equal(adapter.queryOperation(run.operation.id).status, 'confirmed');
  assert.equal(adapter.queryRefund('missing'), null);
  assert.throws(() => createIntegrationAdapter({ db, mode: 'live' }), { status: 503 });
  assert.throws(() => adapter.requestRefund(), { status: 400 });
  assert.throws(() => adapter.requestEject(), { status: 400 });
  db.close();
});

test('query reconciles pending refund, unknown stays unknown, and duplicate query does not add events', async () => {
  const db = openProductionStore(':memory:');
  const { run } = scenario(db, 'refund-pending');
  const queried = await reconcileIntegrationRun(db, { runId: run.id, idempotencyKey: 'query_key_1', actor, now });
  assert.equal(queried.run.refund.status, 'succeeded');
  assert.equal(queried.run.settlementStatus, 'settled');
  const replay = await reconcileIntegrationRun(db, { runId: run.id, idempotencyKey: 'query_key_1', actor, now });
  assert.equal(replay.replayed, true); assert.equal(replay.run.events.length, queried.run.events.length);
  const unknown = scenario(db, 'unknown-pickup', 'unknown_key').run;
  const unknownQuery = await reconcileIntegrationRun(db, { runId: unknown.id, idempotencyKey: 'query_key_2', actor, now });
  assert.equal(unknownQuery.run.operation.status, 'unknown'); assert.equal(unknownQuery.run.startedAt, null);
  assert.throws(() => createIntegrationAdapter({ db, now: () => now }).requestEject({ operationId: unknown.operation.id, idempotencyKey: 'eject_key' }), { status: 409 });
  db.close();
});
test('failed refund requires query before retry, acceptance remains pending, no double refund or fee', async () => {
  const db = openProductionStore(':memory:');
  const { run } = scenario(db, 'refund-failed');
  const args = { runId: run.id, idempotencyKey: 'retry_key', actor, now };
  await assert.rejects(retryIntegrationRefund(db, args), { status: 409 });
  await reconcileIntegrationRun(db, { ...args, idempotencyKey: 'query_failed' });
  const retried = await retryIntegrationRefund(db, args);
  assert.equal(retried.run.refund.status, 'pending');
  assert.equal(retried.run.refund.id, run.refund.id);
  assert.equal(retried.run.refund.amount, run.refund.amount);
  assert.equal((await retryIntegrationRefund(db, args)).replayed, true);
  await assert.rejects(retryIntegrationRefund(db, { ...args, idempotencyKey: 'other_retry' }), { status: 409 });
  const final = await reconcileIntegrationRun(db, { ...args, idempotencyKey: 'query_final' });
  assert.equal(final.run.refund.status, 'succeeded');
  assert.equal(final.run.feeAmount, run.feeAmount);
  assert.equal(final.refunds.filter(r => r.rentalId === run.id).length, 1);
  assert.equal(final.run.commands.length, 1);
  await assert.rejects(retryIntegrationRefund(db, { ...args, idempotencyKey: 'final_retry' }), { status: 409 });
  db.close();
});
test('injected adapter must preserve source, correlation, time and original monetary values', async () => {
  const db = openProductionStore(':memory:');
  const { run } = scenario(db, 'refund-pending');
  const normal = createIntegrationAdapter({ db, now: () => now }).queryReconciliation(run.id);
  for (const bad of [{ ...normal, source: 'live' }, { ...normal, refundId: 'wrong' }, { ...normal, observedAt: new Date(now + 1).toISOString() }, { ...normal, operationStatus: 'unknown' }]) {
    await assert.rejects(reconcileIntegrationRun(db, { runId: run.id, idempotencyKey: 'invalid_query', actor, now, adapter: { mode: 'mock', testOnly: true, queryReconciliation: async () => bad } }));
  }
  assert.equal(integrationView(db, now).runs[0].refund.status, 'pending');
  db.close();
});
test('normalized event persistence omits arbitrary raw vendor payloads and pricing charges elapsed time', () => {
  const db = openProductionStore(':memory:');
  const run = scenario(db, 'return-unmatched').run;
  const returned = now + 7200000;
  const event = { id: 'late_return', rentalId: run.id, type: 'return.confirmed', sequence: run.events.length + 1, occurredAt: new Date(returned).toISOString(), source: 'mock', testOnly: true, rawVendorPayload: 'do not persist' };
  applyNormalizedLabEvent(run, event, returned);
  assert.equal(run.feeAmount, run.pricing.hourlyRate * 2);
  assert.equal(run.depositApplied, run.feeAmount);
  assert.equal(run.events.at(-1).rawVendorPayload, undefined);
  db.close();
});
test('query concurrency check preserves another completed projection instead of overwriting it', async () => {
  const db = openProductionStore(':memory:');
  const run = scenario(db, 'refund-pending').run;
  const adapter = createIntegrationAdapter({ db, now: () => now });
  const reply = adapter.queryReconciliation(run.id);
  const injected = { mode: 'mock', testOnly: true, queryReconciliation: async () => {
    await reconcileIntegrationRun(db, { runId: run.id, idempotencyKey: 'winning_query', actor, now });
    return reply;
  } };
  await assert.rejects(reconcileIntegrationRun(db, { runId: run.id, idempotencyKey: 'losing_query', actor, now, adapter: injected }), { status: 409 });
  const final = integrationView(db, now).runs[0];
  assert.equal(final.refund.status, 'succeeded'); assert.equal(final.queries.length, 1);
  db.close();
});
