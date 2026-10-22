import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProductionAPI } from '../src/production-api.mjs';
import { openProductionStore, putRecord } from '../src/production-store.mjs';
const config = { publicOrigin:'https://rental.example', secure:true, enableGoogleTestLogin:true, sessionSeconds:3600, userSessionSeconds:3600 };
const now = Date.parse('2026-10-22T00:00:00Z');
function harness(path=':memory:') {
  const db = openProductionStore(path);
  const api = createProductionAPI({db,config,now:()=>now});
  function identity(id,role='user') {
    const kind = role === 'user' || role === 'test' ? 'user' : 'admin';
    if (role === 'user') db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(id,id,`${id}@example.test`,id,new Date(now).toISOString());
    else if (role === 'test') db.prepare('INSERT INTO test_users VALUES(?,?,?)').run(id,id,new Date(now).toISOString());
    else db.prepare('INSERT INTO admins VALUES(?,?,?,?,0)').run(id,id,'not-a-login-password',role);
    const token=randomBytes(32).toString('base64url'), csrf=randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(createHash('sha256').update(token).digest('hex'),kind,id,csrf,now+3600000);
    return {cookie:`voltgo_${kind}=${token}`,csrf};
  }
  async function request(path, who, body, key) {
    const response=await api(new Request(config.publicOrigin+path,{method:body===undefined?'GET':'POST',headers:{origin:config.publicOrigin,'content-type':'application/json',...(who?{cookie:who.cookie,'x-csrf-token':who.csrf}:{}),...(key?{'idempotency-key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)}));
    return {status:response.status,data:await response.json()};
  }
  return {db,identity,request};
}
function rental(s,id,owner,extra={}) { putRecord(s.db,'rental',id,{id,userId:owner,status:'completed',stationId:'S1',createdAt:'2026-10-21T12:00:00Z',totalAmount:500,depositPaid:10000,...extra},owner); }

test('review: order APIs require admin and explicit scope; filters and pagination reject malformed inputs',async t=>{
  const s=harness(); t.after(()=>s.db.close()); const viewer=s.identity('viewer','viewer'), user=s.identity('customer');
  rental(s,'LIVE-1','customer'); rental(s,'LIVE-2','customer',{status:'active',createdAt:'2026-10-22T00:00:00Z'});
  for(const who of [undefined,user]) assert.equal((await s.request('/api/admin/orders?mode=live',who)).status,401);
  for(const query of ['', '?mode=all','?mode=test&limit=501','?mode=live&offset=-1','?mode=live&from=nonsense']) assert.equal((await s.request('/api/admin/orders'+query,viewer)).status,400);
  const filtered=await s.request('/api/admin/orders?mode=live&status=completed&q=live&limit=1',viewer);
  assert.equal(filtered.status,200); assert.equal(filtered.data.total,1); assert.equal(filtered.data.orders[0].id,'LIVE-1');
  assert.equal((await s.request('/api/admin/orders?mode=test',viewer)).data.total,0);
  assert.equal((await s.request('/api/admin/orders/LIVE-1?mode=test',viewer)).status,404);
  assert.equal((await s.request('/api/admin/orders/LIVE-1?mode=live',viewer)).data.order.id,'LIVE-1');
});

test('review: linked support enforces rental ownership, mode and durable idempotency, preserving reply history',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'operations-review-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'state.sqlite'); let s=harness(path);
  const u=s.identity('alice'), v=s.identity('bob'), testUser=s.identity('test-alice','test'), operator=s.identity('operator','operator'), viewer=s.identity('viewer','viewer');
  rental(s,'alice-order','alice'); rental(s,'bob-order','bob'); rental(s,'test-cross','test-alice');
  assert.equal((await s.request('/api/user/support',u,{message:'Please check rental',rentalId:'bob-order'},'other-order-key')).status,404);
  assert.equal((await s.request('/api/user/support',testUser,{message:'Please check rental',rentalId:'test-cross'},'cross-mode-key')).status,404);
  const body={message:'Please check rental',rentalId:'alice-order'}, key='durable-support-key';
  const created=await s.request('/api/user/support',u,body,key); assert.equal(created.status,201);
  assert.equal((await s.request('/api/user/support',u,body,key)).data.support.id,created.data.support.id);
  assert.equal((await s.request('/api/user/support',u,{...body,message:'A different issue'},key)).status,409);
  assert.deepEqual((await s.request('/api/user/support',v)).data.support,[]);
  assert.equal((await s.request('/api/admin/support',viewer,{id:created.data.support.id,status:'in_progress',reply:'No access'})).status,403);
  const first=await s.request('/api/admin/support',operator,{id:created.data.support.id,status:'in_progress',reply:'First response',expectedUpdatedAt:null}); assert.equal(first.status,200);
  const second=await s.request('/api/admin/support',operator,{id:created.data.support.id,status:'resolved',reply:'Second response',expectedUpdatedAt:first.data.support.updatedAt}); assert.equal(second.status,200);
  assert.equal((await s.request('/api/admin/support',operator,{id:created.data.support.id,status:'open',reply:'Stale overwrite',expectedUpdatedAt:first.data.support.updatedAt})).status,409);
  assert.deepEqual(second.data.support.replies.map(x=>x.reply),['First response','Second response']);
  s.db.close(); s=harness(path); t.after(()=>s.db.close());
  assert.equal((await s.request('/api/user/support',u,body,key)).data.support.id,created.data.support.id);
  assert.deepEqual((await s.request('/api/user/support',u)).data.support[0].replies.map(x=>x.reply),['First response','Second response']);
  const order=await s.request('/api/admin/orders/alice-order?mode=live',viewer); assert.equal(order.data.support.length,1);
  assert.equal((await s.request('/api/admin/dashboard',viewer)).data.workQueue.filter(x=>x.supportId===created.data.support.id).length,0);
});

test('review: detail joins are scoped by owner and mode even for colliding references',async t=>{
  const s=harness(); t.after(()=>s.db.close()); const owner=s.identity('owner','owner'); s.identity('alice'); s.identity('bob');
  rental(s,'same','alice');
  putRecord(s.db,'payment','right',{id:'right',rentalId:'same',amount:500},'alice');
  putRecord(s.db,'payment','wrong',{id:'wrong',rentalId:'same',amount:999999},'bob');
  putRecord(s.db,'support','good',{id:'good',userId:'alice',rentalId:'same',status:'open'},'alice');
  putRecord(s.db,'support','wrong-mode',{id:'wrong-mode',userId:'alice',rentalId:'same',testOnly:true,status:'open'},'alice');
  putRecord(s.db,'support','wrong-owner',{id:'wrong-owner',userId:'bob',rentalId:'same',status:'open'},'bob');
  const detail=(await s.request('/api/admin/orders/same?mode=live',owner)).data;
  assert.deepEqual(detail.payments.map(x=>x.id),['right']); assert.deepEqual(detail.support.map(x=>x.id),['good']);
  assert.equal(detail.order.totalAmount,500); assert.notEqual(detail.order.totalAmount,detail.order.depositPaid);
});

test('review: pricing history, immutable audit snapshots and legacy support survive reopen without secrets',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'operations-history-')); t.after(()=>rmSync(dir,{recursive:true,force:true})); const path=join(dir,'state.sqlite'); let s=harness(path);
  const owner=s.identity('owner','owner'), operator=s.identity('operator','operator');
  const price={currency:'ARS',hourlyRate:500,dailyCap:3000,deposit:10000,expectedVersion:null,secret:'must-never-appear'};
  assert.equal((await s.request('/api/admin/pricing',operator,price)).status,403);
  const first=await s.request('/api/admin/pricing',owner,price); assert.equal(first.status,200);
  const second=await s.request('/api/admin/pricing',owner,{...price,hourlyRate:600,expectedVersion:first.data.pricing.version}); assert.equal(second.status,200);
  assert.equal((await s.request('/api/admin/pricing',owner,{...price,expectedVersion:first.data.pricing.version})).status,409);
  putRecord(s.db,'support','legacy',{id:'legacy',userId:'legacy-user',status:'open',reply:'Old reply',updatedAt:'2025-01-01T00:00:00Z'},'legacy-user');
  const before=(await s.request('/api/admin/dashboard',owner)).data;
  assert.equal(before.pricingHistory.length,2); assert.equal(before.pricingHistory.find(x=>x.version===first.data.pricing.version).hourlyRate,500);
  const audit=before.audit.filter(x=>x.action==='pricing.update'); assert.equal(audit.length,2); assert.equal(audit[0].before.hourlyRate,500); assert.equal(audit[0].after.hourlyRate,600); assert.equal(audit[1].before,null);
  assert.ok(!JSON.stringify(before.audit).includes('must-never-appear'));
  assert.equal(before.support.find(x=>x.id==='legacy').replies[0].reply,'Old reply');
  s.db.close(); s=harness(path); t.after(()=>s.db.close());
  const after=(await s.request('/api/admin/dashboard',owner)).data; assert.deepEqual(after.audit,before.audit); assert.deepEqual(after.pricingHistory,before.pricingHistory);
});

test('review: customer followups require ownership and key, reopen resolved threads without erasing history',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'operations-reply-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'state.sqlite');let s=harness(path);
 const alice=s.identity('alice'), bob=s.identity('bob'), operator=s.identity('operator','operator');
 const created=await s.request('/api/user/support',alice,{message:'Please help me'},'create-thread-key');const id=created.data.support.id;
 const closed=await s.request('/api/admin/support',operator,{id,status:'resolved',reply:'Please try again',expectedUpdatedAt:null});assert.equal(closed.status,200);
 const followup={id,message:'It still does not work'};
 assert.equal((await s.request('/api/user/support/reply',bob,followup,'bob-followup-key')).status,404);
 assert.equal((await s.request('/api/user/support/reply',alice,followup)).status,400);
 const reply=await s.request('/api/user/support/reply',alice,followup,'alice-followup-key');assert.equal(reply.status,200);assert.equal(reply.data.support.status,'open');assert.equal(reply.data.support.replies.length,2);assert.equal(reply.data.support.replies[1].actorRole,'customer');
 assert.equal((await s.request('/api/admin/support',operator,{id,status:'resolved',reply:'A stale admin edit',expectedUpdatedAt:closed.data.support.updatedAt})).status,409);
 assert.equal((await s.request('/api/user/support/reply',alice,{id,message:'Different reply'},'alice-followup-key')).status,409);
 s.db.close();s=harness(path);t.after(()=>s.db.close());
 assert.equal((await s.request('/api/user/support/reply',alice,followup,'alice-followup-key')).data.support.replies.length,2);
 assert.equal((await s.request('/api/admin/dashboard',operator)).data.workQueue.find(x=>x.supportId===id).status,'open');
 const fresh=await s.request('/api/user/support',alice,{message:'A second question'},'second-thread-key');
 await s.request('/api/user/support/reply',alice,{id:fresh.data.support.id,message:'Some extra context'},'second-followup-key');
 assert.equal((await s.request('/api/admin/support',operator,{id:fresh.data.support.id,status:'resolved',reply:''})).status,400);
});

test('review: integration endpoints enforce admin roles, CSRF, fixed fixtures and annotation-only review',async t=>{
 const s=harness();t.after(()=>s.db.close());const owner=s.identity('owner','owner'),operator=s.identity('operator','operator'),viewer=s.identity('viewer','viewer'),customer=s.identity('customer');
 assert.equal((await s.request('/api/admin/integrations',customer)).status,401);
 assert.equal((await s.request('/api/admin/integrations',viewer)).status,200);
 const route='/api/admin/integrations/scenarios',body={scenario:'unknown-pickup'};
 assert.equal((await s.request(route,viewer,body,'viewer-key')).status,403);
 assert.equal((await s.request(route,{...owner,csrf:'invalid'},body,'csrf-key-1')).status,403);
 assert.equal((await s.request(route,owner,{...body,amount:1},'unsafe-input-key')).status,400);
 const created=await s.request(route,operator,body,'fixed-scenario-key');assert.equal(created.status,200);assert.equal(created.data.run.startedAt,null);assert.equal(created.data.run.operation.retryAllowed,false);
 assert.equal((await s.request(route,operator,body,'fixed-scenario-key')).data.replayed,true);
 const exception=created.data.exceptions[0],resolve=`/api/admin/integrations/exceptions/${exception.id}/resolve`;
 assert.equal((await s.request(resolve,viewer,{note:'Reviewed fixture'})).status,403);
 const closed=await s.request(resolve,operator,{note:'Reviewed fixture'});assert.equal(closed.status,200);assert.deepEqual(closed.data.runs[0],created.data.run);
 assert.equal((await s.request('/api/admin/dashboard',owner)).data.rentals.length,0);
 assert.equal((await s.request('/api/admin/dashboard',owner)).data.payments.length,0);
});
