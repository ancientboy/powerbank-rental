import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openProductionStore,listRecords,putRecord} from '../src/production-store.mjs';
import {createProductionAPI} from '../src/production-api.mjs';
import {receiveWscharge} from '../src/production-wscharge.mjs';
import {hardwareOrders,authorizeHardware,reconcileManualCommand} from '../src/production-hardware-rental.mjs';
const token='test-only-hardware-token',cabinet='CAB_TEST';
async function setup(t){
 const db=openProductionStore(':memory:');t.after(()=>db.close());let time=Date.parse('2026-10-23T09:00:00Z'),calls=0,intercept=null;
 const config={publicOrigin:'https://example.test',enableGoogleTestLogin:true,hardwareRentalEnabled:true,wschargeEnabled:true,wschargeDispatchEnabled:true,wschargeApiToken:token,wschargeCallbackToken:token,wschargeCabinets:[cabinet]};
 for(const [id,ch]of [['test_a','a'],['test_b','b']]){db.prepare('INSERT INTO test_users VALUES(?,?,?)').run(id,id,new Date(time).toISOString());db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(createHash('sha256').update(ch.repeat(43)).digest('hex'),'user',id,'csrf',time+86400000);}
 const api=createProductionAPI({db,config,now:()=>time,wschargeFetch:async(url,opt)=>{calls++;if(intercept)await intercept(opt);return new Response('{"code":200}',{status:200});}});
 const request=async(action,body,who='a',csrf='csrf')=>{const r=await api(new Request(config.publicOrigin+'/api/user/hardware/'+action,{method:body===undefined?'GET':'POST',headers:{cookie:'voltgo_user='+who.repeat(43),'content-type':'application/json',origin:config.publicOrigin,'x-csrf-token':csrf},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:r.status,body:await r.json()};};
 const notify=async(I,fields={},timestamp=Math.floor(time/1000))=>receiveWscharge(db,config,new Request(config.publicOrigin+'/api/integrations/wscharge/notify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({I,E:cabinet,token,timestamp,...fields})}),time);
 const inventory=()=>notify(64,{terminalArr:[{B:'BANK_A',L:3,D:100},{B:'BANK_B',L:4,D:90}]});
 await inventory();
 const create=async(who='a')=>{const r=await request('create',{cabinetId:cabinet},who);assert.equal(r.status,200);return r.body.rental;};
 return {db,config,request,notify,inventory,create,advance:ms=>time+=ms,time:()=>time,calls:()=>calls,intercept:fn=>intercept=fn};
}
test('all signed-in account types can test without grants, while authentication and CSRF remain required',async t=>{
 const x=await setup(t);
 x.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run('google_c','sub_c','test@example.test','Customer',new Date(x.time()).toISOString());
 x.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(createHash('sha256').update('c'.repeat(43)).digest('hex'),'user','google_c','csrf',x.time()+86400000);
 for(const who of ['a','b','c']){
  assert.equal((await x.request('state',undefined,who)).body.authorized,true);
  assert.equal((await x.request('create',{cabinetId:cabinet},who,'wrong')).status,403);
  const order=await x.create(who);assert.equal((await x.request('cancel',{rentalId:order.id},who)).status,200);
 }
 assert.equal((await x.request('state',undefined,'z')).status,401);
 assert.equal((await x.request('create',{cabinetId:cabinet},'z')).status,401);
 assert.equal(listRecords(x.db,'hardware_test_request').length,0);
 assert.equal(listRecords(x.db,'hardware_tester').length,0);
 assert.throws(()=>authorizeHardware(x.db,{id:'owner',role:'owner'},{userId:'test_a',enabled:true},x.time()),/no longer used/);
 assert.equal((await x.request('create',{cabinetId:'OTHER'})).status,404);
 // Old expired/revoked grants do not prevent the new default access policy.
 putRecord(x.db,'hardware_tester','google_c',{id:'google_c',expiresAt:0});
 x.advance(3600001);await x.inventory();const order=await x.create('c');
 assert.equal((await x.request('pay',{rentalId:order.id},'c')).status,200);assert.equal(x.calls(),1);
 assert.equal(listRecords(x.db,'payment').length,0);
});
test('one order dispatches once, starts on successful eject and automatically settles matched return once',async t=>{
 const x=await setup(t);const r=await x.create();
 assert.equal((await x.create()).id,r.id);
 assert.equal((await x.request('pay',{rentalId:r.id})).status,200);
 assert.equal(x.calls(),1);assert.equal(hardwareOrders(x.db)[0].status,'dispatching');
 await x.request('pay',{rentalId:r.id});assert.equal(x.calls(),1);
 x.advance(1000);await x.notify(65,{L:3,B:'BANK_A',S:200});
 assert.equal(hardwareOrders(x.db)[0].status,'active');
 x.advance(20000);await x.notify(66,{L:3,B:'BANK_A'});
 await x.notify(66,{L:3,B:'BANK_A'});
 const done=hardwareOrders(x.db)[0];assert.equal(done.status,'completed');assert.equal(done.totalAmount,50000);assert.equal(done.refundAmount,950000);
 assert.equal(listRecords(x.db,'hardware_payment').length,3);assert.ok(listRecords(x.db,'wscharge_command')[0].reconciledAt);
 x.advance(1000);await x.inventory();const next=await x.create();assert.notEqual(next.id,r.id);await x.request('pay',{rentalId:next.id});assert.equal(x.calls(),2);
 assert.equal(listRecords(x.db,'rental').length,0);assert.equal(listRecords(x.db,'payment').length,0);
});
test('concurrent pay, another account and callbacks arriving before command HTTP response remain single dispatch',async t=>{
 const x=await setup(t);const a=await x.create(),b=await x.create('b');
 let release;const gate=new Promise(r=>release=r);x.intercept(async()=>{await gate;x.advance(1000);await x.notify(65,{L:3,B:'BANK_A',S:200});x.advance(1000);await x.notify(66,{L:3,B:'BANK_A'});});
 const pending=x.request('pay',{rentalId:a.id});await new Promise(r=>setTimeout(r,0));
 assert.equal((await x.request('pay',{rentalId:a.id})).status,200);
 assert.equal((await x.request('pay',{rentalId:b.id},'b')).status,409);
 release();await pending;assert.equal(x.calls(),1);assert.equal(hardwareOrders(x.db).find(r=>r.id===a.id).status,'completed');assert.ok(listRecords(x.db,'wscharge_command')[0].reconciledAt);
});
test('stale inventory, disabled switch, expired quote and another owner cannot dispatch',async t=>{
 const x=await setup(t);const r=await x.create();
 assert.equal((await x.request('pay',{rentalId:r.id},'b')).status,404);
 assert.equal((await x.request('pay',{rentalId:r.id},'b')).status,404);
 x.config.wschargeDispatchEnabled=false;assert.equal((await x.request('pay',{rentalId:r.id})).status,503);x.config.wschargeDispatchEnabled=true;
 x.advance(121000);assert.equal((await x.request('pay',{rentalId:r.id})).status,409);
 x.advance(181000);await x.inventory();assert.equal((await x.request('pay',{rentalId:r.id})).status,409);assert.equal(x.calls(),0);
});
test('mismatched/stale callbacks cannot start or end rental and delayed return before eject is reconciled',async t=>{
 const x=await setup(t);const r=await x.create();await x.request('pay',{rentalId:r.id});
 await x.notify(65,{L:4,B:'BANK_A',S:200});await x.notify(65,{L:3,B:'OTHER',S:200});await x.notify(65,{L:3,B:'BANK_A',S:200},x.time()/1000-400);
 assert.equal(hardwareOrders(x.db)[0].status,'dispatching');
 const ejectTime=x.time()/1000+1;x.advance(2000);await x.notify(66,{L:3,B:'BANK_A'});await x.notify(65,{L:3,B:'BANK_A',S:200},ejectTime);
 assert.equal(hardwareOrders(x.db)[0].status,'completed');
});
test('network uncertainty, failed ejection and client cancel/return/pickup cannot bypass reconciliation',async t=>{
 const x=await setup(t);const r=await x.create();x.intercept(()=>{throw Error('transport');});await x.request('pay',{rentalId:r.id});
 assert.equal(hardwareOrders(x.db)[0].status,'dispatching');await x.request('pay',{rentalId:r.id});assert.equal(x.calls(),1);
 assert.equal((await x.request('cancel',{rentalId:r.id})).status,409);
 assert.equal((await x.request('return',{rentalId:r.id})).status,404);assert.equal((await x.request('pickup',{rentalId:r.id})).status,404);
 x.advance(1000);await x.notify(65,{L:3,B:'BANK_A',S:500});assert.equal(hardwareOrders(x.db)[0].status,'review_required');
 assert.equal(listRecords(x.db,'hardware_payment').length,1);assert.equal(hardwareOrders(x.db)[0].startedAt,undefined);
});
test('standalone historical command only reconciles after successful eject, matching return and fresh inventory',async t=>{
 const x=await setup(t);const c={id:'manual',code:65,cabinetId:cabinet,slot:3,createdAt:new Date(x.time()).toISOString()};putRecord(x.db,'wscharge_command',c.id,c);
 assert.throws(()=>reconcileManualCommand(x.db,{role:'owner'},c.id,x.time()),/Need matched/);
 x.advance(1000);await x.notify(65,{L:3,B:'BANK_A',S:200});x.advance(1000);await x.notify(66,{L:3,B:'BANK_A'});x.advance(1000);await x.inventory();
 reconcileManualCommand(x.db,{id:'owner',role:'owner'},c.id,x.time());assert.ok(listRecords(x.db,'wscharge_command')[0].reconciledAt);
 const r=await x.create();await x.request('pay',{rentalId:r.id});assert.equal(x.calls(),1);
});
