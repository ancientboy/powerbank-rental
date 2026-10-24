// Read-only operational projections. No device or payment execution lives here.
import { hardwareOrders } from './production-hardware-rental.mjs';
import { listRecords } from './production-store.mjs';
import { testRentals, estimateTestRental } from './production-test-rental.mjs';
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export function supportView(ticket) {
  const replies = Array.isArray(ticket.replies) ? ticket.replies : ticket.reply ? [{ id: 'legacy:' + ticket.id, reply: ticket.reply, createdAt: ticket.updatedAt || null, actorId: null, actorRole: null, legacy: true }] : [];
  return { ...ticket, rentalId: ticket.rentalId || null, replies };
}
export function auditView(db) {
  return db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all().map(row => {
    const extra = db.prepare("SELECT data FROM records WHERE kind='audit_detail' AND id=?").get(String(row.id));
    return { ...row, before: null, after: null, ...(extra ? JSON.parse(extra.data) : {}) };
  });
}
export function pricingHistory(db, current) {
  const history = listRecords(db, 'pricing_history');
  if (current && !history.some(p => p.version === current.version)) history.push({ ...current, legacy: true });
  return history.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}
export function orders(db, mode, time) {
  return mode === 'hardware' ? hardwareOrders(db).map(r=>estimateTestRental(r,time)) : mode === 'test' ? testRentals(db).map(r => estimateTestRental(r, time)) : listRecords(db, 'rental');
}
export function operationQueue(db) {
  const items = [];
  for (const mode of ['live', 'test']) {
    for (const r of (mode === 'test' ? testRentals(db) : listRecords(db, 'rental'))) {
      if (['review_required', 'legacy_review'].includes(r.settlementStatus)) items.push({ id: mode + ':rental:' + r.id, type: 'settlement_review', mode, rentalId: r.id, reason: r.settlementStatus, status: r.status, createdAt: r.returnedAt || r.createdAt || null });
    }
  }
  for(const r of hardwareOrders(db)){
    if(r.buyoutReview||r.status==='review_required'||r.settlementStatus==='review_required'&&!r.settlementReviewedAt)items.push({id:'hardware:'+r.id,type:'hardware_review',mode:'hardware',rentalId:r.id,reason:r.reviewReason||'settlement_review',status:r.status,createdAt:r.reviewAt||r.createdAt});
  }
  for (const t of listRecords(db, 'support')) {
    if (['open', 'in_progress'].includes(t.status)) items.push({ id: 'support:' + t.id, type: 'support', mode: t.rentalMode || (t.testOnly === true ? 'test' : 'live'), supportId: t.id, rentalId: t.rentalId || null, reason: 'support_' + t.status, status: t.status, createdAt: t.createdAt || null });
  }
  return items.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}
export function orderResponse(db, url, time, id = null) {
  const mode = url.searchParams.get('mode');
  if (!['live', 'test', 'hardware'].includes(mode)) fail(400, 'Choose mode=live, mode=test or mode=hardware');
  const serverNow = new Date(time).toISOString();
  const all = orders(db, mode, time);
  if (id !== null) {
    const order = all.find(r => r.id === id);
    if (!order) fail(404, 'Order not found');
    if(mode==='hardware'){
      const payments=listRecords(db,'hardware_payment',order.userId).filter(p=>p.rentalId===id);
      const support=listRecords(db,'support',order.userId).filter(t=>t.rentalId===id).map(supportView);
      const command=listRecords(db,'wscharge_command').find(c=>c.id===order.commandId)||null;
      const events=listRecords(db,'wscharge_event').filter(e=>e.bankId===order.bankId&&e.observedAtSeconds*1000>=Date.parse(order.dispatchedAt||order.createdAt)&&(!order.returnedAt||e.observedAtSeconds*1000<=Date.parse(order.returnedAt)));
      const timeline=[...payments.map(p=>({...p,type:p.type,at:p.createdAt})),...events.map(e=>({id:e.id,type:'device_'+e.code,status:e.statusCode,at:new Date(e.observedAtSeconds*1000).toISOString()})),...(order.handlingHistory||[]).map(e=>({...e,type:'operator_'+e.action,at:e.createdAt}))].sort((a,b)=>a.at.localeCompare(b.at));
      return {mode,serverNow,order,payments,support,timeline,command,events,states:{rental:order.status,payment:order.settlementStatus,device:order.reviewReason||(order.startedAt?'release_confirmed':'release_unconfirmed')}};
    }
    const ownerRow = mode === 'test' ? db.prepare('SELECT owner_id FROM test_rentals WHERE id=?').get(id) : db.prepare("SELECT owner_id FROM records WHERE kind='rental' AND id=?").get(id);
    const owner = ownerRow?.owner_id;
    const paymentRows = mode === 'test' ? db.prepare("SELECT owner_id,data FROM test_records WHERE kind='payment'").all() : db.prepare("SELECT owner_id,data FROM records WHERE kind='payment'").all();
    const payments = paymentRows.filter(row => owner && row.owner_id === owner).map(row => JSON.parse(row.data)).filter(p => p.rentalId === id);
    const support = listRecords(db, 'support', owner || '__no_owner__').filter(t => t.rentalId === id && (t.testOnly === true) === (mode === 'test')).map(supportView);
    const timeline = [];
    for (const [field, type] of [['createdAt','created'],['paidAt','deposit_paid'],['startedAt','rental_started'],['returnedAt','returned'],['cancelledAt','cancelled']]) {
      if (order[field]) timeline.push({ id: field, type, at: order[field], source: 'rental', testOnly: mode === 'test' });
    }
    for (const p of payments) if (p.createdAt) timeline.push({ id: p.id, type: 'payment', at: p.createdAt, source: 'payment', status: p.status, paymentType: p.type, amount: p.amount, testOnly: mode === 'test' });
    timeline.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return { mode, serverNow, order, payments, support, timeline, states: { rental: order.status || 'unknown', payment: order.settlementStatus || 'unknown', device: mode === 'test' ? (order.pickupOutcome ? 'simulated_pickup_' + order.pickupOutcome : 'simulation_only') : 'not_connected' } };
  }
  let result = all;
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  if (q.length > 200) fail(400, 'Search must be at most 200 characters');
  if (q) result = result.filter(r => [r.id,r.userId,r.stationId,r.stationName,r.cabinetId,r.bankId].some(v => String(v || '').toLowerCase().includes(q)));
  for (const field of ['status','settlementStatus','stationId']) {
    const value = url.searchParams.get(field);
    if (value) result = result.filter(r => r[field] === value);
  }
  for (const field of ['from','to']) {
    const raw = url.searchParams.get(field);
    if (raw) {
      const value = Date.parse(raw);
      if (!Number.isFinite(value)) fail(400, 'Invalid date filter');
      result = result.filter(r => field === 'from' ? Date.parse(r.createdAt) >= value : Date.parse(r.createdAt) <= value);
    }
  }
  const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 100);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail(400, 'Invalid pagination');
  result.sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
  return { mode, serverNow, total: result.length, offset, limit, orders: result.slice(offset, offset + limit) };
}
