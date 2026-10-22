import test from 'node:test';
import assert from 'node:assert/strict';
import { openProductionStore, putRecord, recordAudit } from '../src/production-store.mjs';
import { supportView, auditView, orderResponse, operationQueue, pricingHistory } from '../src/production-operations.mjs';
test('operational projections keep explicit environments and linked owner boundaries', () => {
  const db = openProductionStore(':memory:');
  try {
    putRecord(db, 'rental', 'one', {id:'one',userId:'u',status:'completed',settlementStatus:'review_required',createdAt:'2026-01-01',returnedAt:'2026-01-02'},'u');
    putRecord(db, 'payment','good',{id:'good',rentalId:'one',amount:10,createdAt:'2026-01-02'},'u');
    putRecord(db, 'payment','bad',{id:'bad',rentalId:'one',amount:99},'other');
    putRecord(db, 'support','good',{id:'good',rentalId:'one',testOnly:false,status:'open'},'u');
    putRecord(db, 'support','wrongmode',{id:'wrongmode',rentalId:'one',testOnly:true},'u');
    const url = new URL('https://example.test/api/admin/orders?mode=live');
    const detail = orderResponse(db,url,0,'one');
    assert.equal(detail.payments.length,1); assert.equal(detail.support.length,1);
    assert.equal(detail.states.device,'not_connected');
    assert.deepEqual(detail.timeline.map(t=>t.type),['created','returned','payment']);
    assert.throws(()=>orderResponse(db,new URL('https://example.test/api/admin/orders'),0),{status:400});
    assert.throws(()=>orderResponse(db,new URL('https://example.test/api/admin/orders?mode=test'),0,'one'),{status:404});
    assert.equal(orderResponse(db,new URL(url+'&q=missing'),0).total,0);
    assert.equal(operationQueue(db).filter(x=>x.type==='settlement_review').length,1);
  } finally { db.close(); }
});
test('legacy reply and audit allowlist preserve facts without copying secrets', () => {
  const db=openProductionStore(':memory:');
  try {
    assert.deepEqual(supportView({id:'a',reply:'old'}).replies.map(r=>[r.reply,r.createdAt,r.legacy]),[['old',null,true]]);
    recordAudit(db,'a','support.update','s',0,{before:{status:'open',password:'secret',reply:'private'},after:{status:'resolved',access_token:'secret'}});
    const row=auditView(db)[0]; assert.deepEqual(row.before,{status:'open'}); assert.deepEqual(row.after,{status:'resolved'});
    recordAudit(db,'a','admin.login','a',0,{after:{password:'secret'}});
    assert.equal(auditView(db)[0].after,null);
    assert.equal(pricingHistory(db,{version:'legacy',deposit:100}).length,1);
    assert.equal(db.prepare('SELECT max(version) AS v FROM schema_migrations').get().v,4);
  } finally {db.close();}
});
