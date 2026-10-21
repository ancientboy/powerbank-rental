// Deliberately self-contained simulation. No payment/hardware adapter or network imports.
import { randomUUID, createHash } from 'node:crypto';
import { transaction, recordAudit } from './production-store.mjs';
export const testPricing = Object.freeze({ currency: 'ARS', hourlyRate: 10000, dailyCap: 60000, deposit: 0, version: 'test-v1', testOnly: true });
export const testStations = Object.freeze([{ id: 'DEMO-001', name: 'TEST · Demo station', address: 'Virtual station · no physical device', available: 8, testOnly: true }]);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export function testRentals(db, owner) {
  return (owner === undefined ? db.prepare('SELECT data FROM test_rentals ORDER BY rowid DESC').all() : db.prepare('SELECT data FROM test_rentals WHERE owner_id=? ORDER BY rowid DESC').all(owner)).map(x => JSON.parse(x.data));
}
export function testPayments(db) {
  return db.prepare("SELECT data FROM test_records WHERE kind='payment' ORDER BY rowid DESC").all().map(x => JSON.parse(x.data));
}
export function estimateTestRental(rental, time) {
  if (rental.status !== 'active') return rental;
  const elapsedMs = Math.max(0, time - Date.parse(rental.startedAt));
  const durationSeconds = Math.floor(elapsedMs / 1000);
  const hours = Math.max(1, Math.ceil(elapsedMs / 3600000));
  const totalAmount = Math.floor(hours / 24) * rental.pricing.dailyCap + Math.min(hours % 24 * rental.pricing.hourlyRate, rental.pricing.dailyCap);
  return { ...rental, durationSeconds, totalAmount };
}
export function handleTestRental({ db, subject, path, method, body, req, time }) {
  const iso = new Date(time).toISOString();
  const all = () => testRentals(db, subject).map(r => estimateTestRental(r, time));
  if (method === 'GET' && path === '/api/user/test/stations') return { testOnly: true, stations: testStations, pricing: testPricing };
  if (method === 'GET' && path === '/api/user/test/state') {
    const rentals = all();
    return { testOnly: true, serverNow: iso, rental: rentals.find(r => ['pending_payment','active'].includes(r.status)) || null, rentals };
  }
  if (method !== 'POST' || !['quote','rent','pay','cancel','return'].some(action => path === '/api/user/test/' + action)) fail(404, 'Not found');
  const key = req.headers.get('idempotency-key');
  if (!key || !/^[a-zA-Z0-9_-]{8,128}$/.test(key)) fail(400, 'Provide an Idempotency-Key (8–128 letters, numbers, _ or -)');
  const fingerprint = createHash('sha256').update(path + '\n' + JSON.stringify(body, Object.keys(body).sort())).digest('hex');
  return transaction(db, () => {
    const previous = db.prepare('SELECT * FROM test_idempotency WHERE owner_id=? AND key=?').get(subject, key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail(409, 'Idempotency key already used for a different request');
      return JSON.parse(previous.response);
    }
    const getRecord = (kind, id) => {
      const row = db.prepare('SELECT data FROM test_records WHERE kind=? AND id=? AND owner_id=?').get(kind, typeof id === 'string' ? id : '', subject);
      return row ? JSON.parse(row.data) : null;
    };
    const put = (kind, value) => db.prepare('INSERT INTO test_records VALUES(?,?,?,?)').run(kind, value.id, subject, JSON.stringify(value));
    const save = rental => db.prepare('UPDATE test_rentals SET status=?,data=? WHERE id=? AND owner_id=?').run(rental.status, JSON.stringify(rental), rental.id, subject);
    let response;
    if (path.endsWith('/quote')) {
      if (body.stationId !== 'DEMO-001') fail(404, 'Test station not found. Use DEMO-001.');
      const quote = { id: 'test_quote_' + randomUUID(), stationId: 'DEMO-001', pricing: { ...testPricing }, createdAt: iso, expiresAt: new Date(time + 300000).toISOString(), testOnly: true };
      put('quote', quote); response = { quote };
    } else if (path.endsWith('/rent')) {
      const quote = getRecord('quote', body.quoteId);
      if (!quote) fail(404, 'Test quote not found');
      const existing = testRentals(db, subject).find(r => r.quoteId === quote.id);
      if (existing) response = { rental: estimateTestRental(existing, time) };
      else {
        if (Date.parse(quote.expiresAt) <= time) fail(409, 'Test quote expired. Scan the station again.');
        if (all().some(r => ['pending_payment','active'].includes(r.status))) fail(409, 'Finish or cancel your current test rental first');
        const rental = { id: 'test_rental_' + randomUUID(), userId: subject, quoteId: quote.id, stationId: quote.stationId, stationName: testStations[0].name, pricing: quote.pricing, currency: 'ARS', status: 'pending_payment', createdAt: iso, startedAt: null, returnedAt: null, durationSeconds: 0, totalAmount: 0, testOnly: true };
        db.prepare('INSERT INTO test_rentals VALUES(?,?,?,?,?)').run(rental.id, subject, rental.status, quote.id, JSON.stringify(rental));
        recordAudit(db, subject, 'test.rental.create', rental.id, time); response = { rental };
      }
    } else {
      const rental = testRentals(db, subject).find(r => r.id === body.rentalId);
      if (!rental) fail(404, 'Test rental not found');
      const payment = (type, status, amount) => {
        const value = { id: 'test_payment_' + randomUUID(), rentalId: rental.id, userId: subject, type, status, amount, currency: 'ARS', provider: 'mock', createdAt: iso, testOnly: true };
        put('payment', value); return value;
      };
      if (path.endsWith('/pay')) {
        if (!['success','failure'].includes(body.outcome)) fail(400, 'Choose success or failure for the simulated payment');
        if (rental.status === 'active' || rental.status === 'completed') response = { rental: estimateTestRental(rental, time), payment: getRecord('payment', rental.authorizationId) };
        else {
          if (rental.status !== 'pending_payment') fail(409, 'Cancelled rentals cannot be paid');
          const p = payment('authorization', body.outcome === 'success' ? 'authorized' : 'failed', 0);
          if (body.outcome === 'success') { rental.status = 'active'; rental.startedAt = iso; rental.authorizationId = p.id; }
          save(rental); response = { rental: estimateTestRental(rental, time), payment: p };
          recordAudit(db, subject, 'test.payment.' + body.outcome, rental.id, time);
        }
      } else if (path.endsWith('/cancel')) {
        if (!['pending_payment','cancelled'].includes(rental.status)) fail(409, 'An active test rental must be returned, not cancelled');
        rental.status = 'cancelled'; rental.cancelledAt ||= iso; save(rental); response = { rental };
      } else {
        if (rental.status === 'completed') response = { rental, payment: getRecord('payment', rental.settlementId) };
        else {
          if (rental.status !== 'active') fail(409, 'Only an active test rental can be returned');
          Object.assign(rental, estimateTestRental(rental, time));
          rental.status = 'completed'; rental.returnedAt = iso;
          const p = payment('settlement', 'succeeded', rental.totalAmount);
          rental.settlementId = p.id; save(rental); response = { rental, payment: p };
          recordAudit(db, subject, 'test.rental.return', rental.id, time);
        }
      }
    }
    response.testOnly = true; response.serverNow = iso;
    db.prepare('INSERT INTO test_idempotency VALUES(?,?,?,?)').run(subject, key, fingerprint, JSON.stringify(response));
    return response;
  });
}
