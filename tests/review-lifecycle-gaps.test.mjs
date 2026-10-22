import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { openProductionStore } from '../src/production-store.mjs';
import { createProductionAPI } from '../src/production-api.mjs';
const origin = 'https://lifecycle.example';
function fixture() {
  const db = openProductionStore(':memory:');
  let time = Date.parse('2026-10-21T00:00:00Z');
  const config = { publicOrigin: origin, secure: true, enableGoogleTestLogin: true, userSessionSeconds: 604800, sessionSeconds: 28800 };
  const api = createProductionAPI({ db, config, now: () => time });
  const clients = {};
  for (const [id, kind] of [['a','user'],['b','user'],['owner','admin']]) {
    const token = (id === 'owner' ? 'z' : id).repeat(43);
    if (kind === 'user') db.prepare('INSERT INTO test_users VALUES(?,?,?)').run(id,id,new Date(time).toISOString());
    else db.prepare('INSERT INTO admins VALUES(?,?,?,?,0)').run(id,id,'unused',id);
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(createHash('sha256').update(token).digest('hex'),kind,id,id+'-csrf',time+604800000);
    clients[id] = { cookie: 'voltgo_'+kind+'='+token, 'x-csrf-token': id+'-csrf' };
  }
  const call = async (path, body, key = randomUUID(), client='a') => {
    const response = await api(new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json',...clients[client],...(key === null ? {} : {'idempotency-key':key})},body:body===undefined?undefined:JSON.stringify(body)}));
    return { status: response.status, data: await response.json() };
  };
  const action = (name,body,key,client) => call('/api/user/test/'+name,body,key,client);
  const rent = async () => { const q=await action('quote',{stationId:'DEMO-001'}); return (await action('rent',{quoteId:q.data.quote.id})).data.rental; };
  return {db,config,call,action,rent,advance(ms){time+=ms;}};
}
test('lifecycle: active history/dashboard use current server estimates while completed settlements stay frozen', async t => {
  const f=fixture(); t.after(()=>f.db.close()); const rental=await f.rent(), rentalId=rental.id;
  await f.action('pay',{rentalId,outcome:'success'}); await f.action('pickup',{rentalId,outcome:'success'});
  f.advance(3600001);
  const state=await f.action('state');
  const history=await f.call('/api/user/rentals');
  const dashboard=await f.call('/api/admin/dashboard',undefined,undefined,'owner');
  assert.equal(history.data.rentals[0].totalAmount,100000);
  assert.deepEqual(history.data.rentals[0],state.data.rental);
  assert.deepEqual(dashboard.data.testRentals[0],state.data.rental);
  assert.equal(history.data.serverNow,state.data.serverNow);
  assert.equal(dashboard.data.serverNow,state.data.serverNow);
  const settled=await f.action('return',{rentalId});f.advance(86400000);
  assert.deepEqual((await f.call('/api/user/rentals')).data.rentals[0],settled.data.rental);
  assert.equal((await f.call('/api/user/rentals',undefined,undefined,'b')).data.rentals.length,0);
});
test('lifecycle: support network retries persist one owner-scoped case, reject altered payload, and retain no-key compatibility',async t=>{
  const f=fixture();t.after(()=>f.db.close());const key=randomUUID(),body={message:'Payment return needs help'};
  const responses=await Promise.all(Array.from({length:12},()=>f.call('/api/user/support',body,key)));
  assert.ok(responses.every(r=>r.status===201));
  assert.equal(new Set(responses.map(r=>r.data.support.id)).size,1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='support'").get().n,1);
  assert.equal((await f.call('/api/user/support',{message:'Different message'},key)).status,409);
  assert.equal((await f.call('/api/user/support',body,'bad')).status,400);
  const other=await f.call('/api/user/support',body,key,'b');assert.equal(other.status,201);assert.notEqual(other.data.support.id,responses[0].data.support.id);
  const existing=responses[0].data.support;
  const updated=await f.call('/api/admin/support',{id:existing.id,status:'resolved',reply:'Resolved in test'},undefined,'owner');assert.equal(updated.status,200);
  assert.equal((await f.call('/api/user/support',body,key)).data.support.status,'resolved');
  assert.equal((await f.call('/api/user/support',body,null)).status,201);
  assert.equal((await f.call('/api/user/support',body,null)).status,201);
  assert.equal((await f.call('/api/user/support',undefined,undefined,'b')).data.support.length,1);
});
test('lifecycle: station coordinates require a pair and cabinet IDs never silently truncate',async t=>{
  const f=fixture();t.after(()=>f.db.close());const body={name:'Station',address:'Test address',active:true};
  for(const extra of [{latitude:10},{longitude:20},{latitude:true,longitude:20},{latitude:[],longitude:20},{latitude:' ',longitude:20},{latitude:91,longitude:20},{cabinetId:'x'.repeat(81)}]) {
    assert.equal((await f.call('/api/admin/stations',{...body,...extra},undefined,'owner')).status,400,JSON.stringify(extra));
  }
  for(const extra of [{},{latitude:' ',longitude:''},{latitude:'-34.6',longitude:'-58.4'}]) {
    assert.equal((await f.call('/api/admin/stations',{...body,...extra},undefined,'owner')).status,200);
  }
});
test('lifecycle: expired session cannot mutate or replay a paid operation',async t=>{
  const f=fixture();t.after(()=>f.db.close());let rental=await f.rent(),rentalId=rental.id;
  const key=randomUUID();await f.action('pay',{rentalId,outcome:'success'},key);
  f.db.prepare("UPDATE sessions SET expires=0 WHERE subject='a'").run();
  assert.equal((await f.action('pay',{rentalId,outcome:'success'},key)).status,401);
  assert.equal((await f.action('cancel',{rentalId})).status,401);
  assert.equal(f.db.prepare("SELECT count(*) n FROM test_records WHERE kind='payment'").get().n,1);
});
test('lifecycle: a lost payment response and later replay never reopens a refunded rental',async t=>{
  const f=fixture();t.after(()=>f.db.close());const rental=await f.rent(), rentalId=rental.id,key=randomUUID();
  const paid=await f.action('pay',{rentalId,outcome:'success'},key);
  await f.action('cancel',{rentalId});
  // Idempotency responses are immutable snapshots; current state is authoritative after replay.
  assert.deepEqual((await f.action('pay',{rentalId,outcome:'success'},key)).data,paid.data);
  const state=await f.action('state');assert.equal(state.data.rental,null);assert.equal(state.data.rentals[0].status,'cancelled');
  assert.equal(state.data.rentals[0].refundAmount,1000000);
  assert.equal(f.db.prepare("SELECT count(*) n FROM test_records WHERE kind='payment'").get().n,2);
});
test('lifecycle: optional optimistic versions reject stale station, pricing and support writes without breaking older callers',async t=>{
  const f=fixture();t.after(()=>f.db.close());
  const admin=(path,body)=>f.call('/api/admin/'+path,body,undefined,'owner');
  const station=(await admin('stations',{name:'Original',address:'Address',expectedUpdatedAt:null})).data.station;
  const first=await admin('stations',{...station,name:'First edit',expectedUpdatedAt:station.updatedAt});assert.equal(first.status,200);
  assert.notEqual(first.data.station.updatedAt,station.updatedAt);
  assert.equal((await admin('stations',{...station,name:'Stale edit',expectedUpdatedAt:station.updatedAt})).status,409);
  assert.equal((await admin('stations',{...station,name:'Older compatible client'})).status,200);
  const price={currency:'ARS',hourlyRate:50000,dailyCap:300000,deposit:1000000};
  const p=(await admin('pricing',{...price,expectedVersion:null})).data.pricing;
  assert.equal((await admin('pricing',{...price,expectedVersion:null})).status,409);
  assert.equal((await admin('pricing',{...price,expectedVersion:p.version})).status,200);
  const ticket=(await f.call('/api/user/support',{message:'Please check this rental'})).data.support;
  assert.equal((await admin('support',{id:ticket.id,status:'resolved',reply:' '})).status,400);
  const updated=await admin('support',{id:ticket.id,status:'in_progress',reply:'Checking',expectedUpdatedAt:null});assert.equal(updated.status,200);
  assert.equal((await admin('support',{id:ticket.id,status:'resolved',reply:'Old response',expectedUpdatedAt:null})).status,409);
  assert.equal((await admin('support',{id:ticket.id,status:'resolved',reply:'Completed',expectedUpdatedAt:updated.data.support.updatedAt})).status,200);
});
test('lifecycle: racing cancellation with payment or pickup preserves one consistent terminal outcome',async t=>{
  const f=fixture();t.after(()=>f.db.close());
  for (const action of ['pay','pickup']) {
    for (const cancelFirst of [true,false]) {
      const rentalId=(await f.rent()).id;
      if(action==='pickup') await f.action('pay',{rentalId,outcome:'success'});
      const cancel=()=>f.action('cancel',{rentalId});const mutate=()=>f.action(action,{rentalId,outcome:'success'});
      await Promise.all((cancelFirst?[cancel,mutate]:[mutate,cancel]).map(fn=>fn()));
      let rental=(await f.action('state')).data.rentals.find(r=>r.id===rentalId);
      if(rental.status==='active') {
        assert.equal(action,'pickup');assert.equal(cancelFirst,false);
        rental=(await f.action('return',{rentalId})).data.rental;
      } else assert.equal(rental.status,'cancelled');
      assert.equal(rental.depositPaid,rental.depositApplied+rental.refundAmount);
      const entries=f.db.prepare("SELECT data FROM test_records WHERE kind='payment'").all().map(r=>JSON.parse(r.data)).filter(p=>p.rentalId===rentalId);
      assert.ok(entries.filter(p=>p.type==='deposit'&&p.status==='succeeded').length<=1);
      assert.ok(entries.filter(p=>p.type==='refund').length<=1);
    }
  }
});
test('lifecycle: long support and station fields reject visibly instead of silently losing text',async t=>{
  const f=fixture();t.after(()=>f.db.close());
  assert.equal((await f.call('/api/user/support',{message:'x'.repeat(4001)})).status,400);
  const accepted=await f.call('/api/user/support',{message:'x'.repeat(4000)});assert.equal(accepted.status,201);assert.equal(accepted.data.support.message.length,4000);
  const admin=(path,body)=>f.call('/api/admin/'+path,body,undefined,'owner');
  assert.equal((await admin('support',{id:accepted.data.support.id,status:'in_progress',reply:'x'.repeat(4001)})).status,400);
  for (const fields of [{name:'x'.repeat(201)},{address:'x'.repeat(501)}])
    assert.equal((await admin('stations',{name:'Test',address:'Test',...fields})).status,400);
  assert.equal(f.db.prepare("SELECT count(*) n FROM records WHERE kind='station'").get().n,0);
});
