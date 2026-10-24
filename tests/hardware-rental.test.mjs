import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openProductionStore,listRecords,putRecord} from '../src/production-store.mjs';
import {createProductionAPI} from '../src/production-api.mjs';
import {receiveWscharge,wschargeCabinets} from '../src/production-wscharge.mjs';
import {hardwareOrders,authorizeHardware,reconcileManualCommand,maintainHardware,resolveHardwareOrder} from '../src/production-hardware-rental.mjs';
const token='test-only-hardware-token',cabinet='CAB_TEST';
async function setup(t,path=':memory:'){
 const db=openProductionStore(path);t.after(()=>{try{db.close();}catch{}});let time=Date.parse('2026-10-23T09:00:00Z'),calls=0,intercept=null;
 const config={publicOrigin:'https://example.test',enableGoogleTestLogin:true,hardwareRentalEnabled:true,wschargeEnabled:true,wschargeDispatchEnabled:true,wschargeApiToken:token,wschargeCallbackToken:token,wschargeCabinets:[cabinet]};
 for(const [id,ch]of [['test_a','a'],['test_b','b']]){db.prepare('INSERT INTO test_users VALUES(?,?,?)').run(id,id,new Date(time).toISOString());db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(createHash('sha256').update(ch.repeat(43)).digest('hex'),'user',id,'csrf',time+86400000);}
 const api=createProductionAPI({db,config,now:()=>time,wschargeFetch:async(url,opt)=>{calls++;if(intercept)await intercept(opt);return new Response('{"code":200}',{status:200});}});
 const request=async(action,body,who='a',csrf='csrf')=>{const r=await api(new Request(config.publicOrigin+'/api/user/hardware/'+action,{method:body===undefined?'GET':'POST',headers:{cookie:'voltgo_user='+who.repeat(43),'content-type':'application/json',origin:config.publicOrigin,'x-csrf-token':csrf},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:r.status,body:await r.json()};};
 const notify=async(I,fields={},timestamp=Math.floor(time/1000))=>receiveWscharge(db,config,new Request(config.publicOrigin+'/api/integrations/wscharge/notify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({I,E:cabinet,token,timestamp,...fields})}),time);
 const inventory=()=>notify(64,{terminalArr:[{B:'BANK_A',L:3,D:100},{B:'BANK_B',L:4,D:90}]});
 await inventory();
 const create=async(who='a')=>{const r=await request('create',{cabinetId:cabinet},who);assert.equal(r.status,200);return r.body.rental;};
 const admin={id:'operator',role:'operator'};
 const resolve=(r,action,note='Checked the device and supplier records')=>resolveHardwareOrder(db,admin,{rentalId:r.id,expectedStatus:hardwareOrders(db).find(x=>x.id===r.id).status,action,note},time,wschargeCabinets(db,config,time));
 return {db,config,api,resolve,request,notify,inventory,create,advance:ms=>time+=ms,time:()=>time,calls:()=>calls,intercept:fn=>intercept=fn};
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
 x.advance(181000);await x.inventory();const expired=await x.request('pay',{rentalId:r.id});assert.equal(expired.status,200);assert.equal(expired.body.rental.status,'cancelled');assert.equal(x.calls(),0);
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

test('another customer can rent the remaining bank while first rental stays active; reservations hide unavailable banks',async t=>{
 const x=await setup(t),a=await x.create(),b=await x.create('b');
 await x.request('pay',{rentalId:a.id});x.advance(1000);await x.notify(65,{L:3,B:'BANK_A',S:200});
 x.advance(1000);await x.inventory();
 const state=(await x.request('state',undefined,'b')).body;
 assert.equal(state.cabinets[0].busy,false);assert.deepEqual(state.cabinets[0].availableSlots,[4]);
 assert.equal((await x.request('pay',{rentalId:b.id},'b')).status,200);
 assert.equal(hardwareOrders(x.db).find(r=>r.id===b.id).bankId,'BANK_B');assert.equal(x.calls(),2);
 x.advance(1000);await x.notify(65,{L:4,B:'BANK_B',S:200});
 assert.equal(hardwareOrders(x.db).filter(r=>r.status==='active').length,2);
 x.advance(1000);await x.notify(66,{L:3,B:'BANK_A'});
 assert.equal(hardwareOrders(x.db).find(r=>r.id===b.id).status,'active');
 x.advance(1000);await x.notify(66,{L:4,B:'BANK_B'});
 assert.equal(hardwareOrders(x.db).filter(r=>r.status==='completed').length,2);
 assert.equal(listRecords(x.db,'hardware_payment').length,6);
});
test('uncertain release times out durably, holds only its slot/bank, accepts a late success and return without resend',async t=>{
 const x=await setup(t),a=await x.create(),b=await x.create('b');
 await x.request('pay',{rentalId:a.id});x.advance(61000);assert.equal(maintainHardware(x.db,x.time()),1);assert.equal(maintainHardware(x.db,x.time()),0);
 assert.equal(hardwareOrders(x.db).find(r=>r.id===a.id).reviewReason,'release_confirmation_timeout');
 await x.inventory();assert.equal((await x.request('pay',{rentalId:b.id},'b')).status,200);
 assert.equal(hardwareOrders(x.db).find(r=>r.id===b.id).slot,4);
 x.advance(301000);await x.notify(65,{L:3,B:'BANK_A',S:200});
 assert.equal(hardwareOrders(x.db).find(r=>r.id===a.id).status,'active');
 x.advance(1000);await x.notify(66,{L:3,B:'BANK_A'});
 assert.equal(hardwareOrders(x.db).find(r=>r.id===a.id).status,'completed');assert.equal(x.calls(),2);
});
test('failed ejection is cancelled only with operator note and fresh matching inventory, refund is idempotent',async t=>{
 const x=await setup(t),r=await x.create();await x.request('pay',{rentalId:r.id});
 x.advance(1000);await x.notify(65,{L:3,B:'BANK_A',S:500});
 assert.throws(()=>x.resolve(r,'cancel_unreleased'),/Wait for release/);
 x.advance(60000);assert.throws(()=>x.resolve(r,'cancel_unreleased'),/Refresh inventory/);
 await x.inventory();assert.throws(()=>x.resolve(r,'cancel_unreleased',''),/handling note/);
 const done=x.resolve(r,'cancel_unreleased').rental;assert.equal(done.status,'cancelled');assert.equal(done.refundAmount,done.depositPaid);
 assert.throws(()=>x.resolve(r,'cancel_unreleased'),/Only an unconfirmed/);
 assert.equal(listRecords(x.db,'hardware_payment').filter(p=>p.type==='refund').length,1);
 assert.equal(done.handlingHistory.length,1);assert.equal(x.calls(),1);
});
test('missing return callback can be handled using fresh bank inventory; stale views and viewer role are rejected',async t=>{
 const x=await setup(t),r=await x.create();await x.request('pay',{rentalId:r.id});x.advance(1000);await x.notify(65,{L:3,B:'BANK_A',S:200});
 assert.throws(()=>x.resolve(r,'confirm_return'),/Refresh inventory/);
 x.advance(61000);await x.inventory();
 const base={rentalId:r.id,expectedStatus:'active',action:'confirm_return',note:'Return verified in the station'};
 assert.throws(()=>resolveHardwareOrder(x.db,{role:'viewer'},base,x.time(),wschargeCabinets(x.db,x.config,x.time())),/role/);
 assert.throws(()=>resolveHardwareOrder(x.db,{role:'operator'},{...base,expectedStatus:'dispatching'},x.time(),[]),/Order changed/);
 const done=x.resolve(r,'confirm_return').rental;assert.equal(done.status,'completed');assert.equal(done.returnTimeSource,'operator_verified_inventory');
 assert.equal(done.returnedAt,new Date(x.time()).toISOString());assert.equal(listRecords(x.db,'hardware_payment').length,3);
 x.advance(1000);await x.notify(66,{L:3,B:'BANK_A'});assert.equal(listRecords(x.db,'hardware_payment').length,3);assert.equal(x.calls(),1);
});
test('physical rental support reaches admin inbox, can be replied/resolved and reopened, with ownership and CSRF checks',async t=>{
 const x=await setup(t),r=await x.create();
 x.db.prepare('INSERT INTO admins VALUES(?,?,?,?,0)').run('operator','operator','not-a-login-password','operator');
 x.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(createHash('sha256').update('o'.repeat(43)).digest('hex'),'admin','operator','admin-csrf',x.time()+3600000);
 const call=async(path,body,who='a',key='support-test-key')=>{const admin=who==='o';const res=await x.api(new Request(x.config.publicOrigin+path,{method:body===undefined?'GET':'POST',headers:{origin:x.config.publicOrigin,cookie:'voltgo_'+(admin?'admin':'user')+'='+who.repeat(43),'content-type':'application/json','x-csrf-token':admin?'admin-csrf':'csrf','idempotency-key':key},body:body===undefined?undefined:JSON.stringify(body)}));return {status:res.status,data:await res.json()};};
 assert.equal((await call('/api/user/support',{rentalId:r.id,message:'Please check my power bank'},'b')).status,404);
 const created=await call('/api/user/support',{rentalId:r.id,message:'Please check my power bank'});assert.equal(created.status,201);const ticket=created.data.support;
 assert.equal(ticket.rentalMode,'hardware');assert.equal((await call('/api/admin/notifications',undefined,'o')).data.openSupport,1);
 assert.equal((await call('/api/admin/orders/'+r.id+'?mode=hardware',undefined,'o')).data.support[0].id,ticket.id);
 assert.equal((await call('/api/admin/orders/'+r.id+'?mode=hardware',undefined,'b')).status,401);
 assert.equal((await call('/api/admin/support',{id:ticket.id,status:'resolved',reply:'We checked your station. Please try again.',expectedUpdatedAt:null},'o')).status,200);
 assert.equal((await call('/api/user/support')).data.support[0].replies.length,1);
 assert.equal((await call('/api/admin/notifications',undefined,'o')).data.openSupport,0);
 await call('/api/user/support/reply',{id:ticket.id,message:'I still need assistance'},'a','followup-key');
 const n=await call('/api/admin/notifications',undefined,'o');assert.equal(n.data.newCustomerMessages,1);
 const dashboard=await call('/api/admin/dashboard',undefined,'o');assert.equal(dashboard.data.workQueue.find(q=>q.supportId===ticket.id).mode,'hardware');
 assert.equal((await call('/api/admin/hardware/resolve',{rentalId:r.id,action:'note',note:'Investigated issue',expectedStatus:'pending_payment'},'a')).status,401);
 assert.equal((await call('/api/admin/hardware/resolve',{rentalId:r.id,action:'note',note:'Investigated issue',expectedStatus:'pending_payment'},'o')).status,200);
 assert.equal(x.calls(),0);
});
test('late success after cancellation is flagged and holds bank again without reversing or duplicating the refund',async t=>{
 const x=await setup(t),r=await x.create();await x.request('pay',{rentalId:r.id});x.advance(61000);maintainHardware(x.db,x.time());await x.inventory();
 x.resolve(r,'cancel_unreleased');x.advance(1000);await x.notify(65,{L:3,B:'BANK_A',S:200});
 const late=hardwareOrders(x.db).find(o=>o.id===r.id);assert.equal(late.status,'review_required');assert.equal(late.reviewReason,'release_after_cancellation');assert.equal(late.refundAmount,late.depositPaid);
 x.advance(1000);await x.notify(66,{L:3,B:'BANK_A'});
 const done=hardwareOrders(x.db).find(o=>o.id===r.id);assert.equal(done.status,'completed');assert.equal(done.totalAmount,0);assert.equal(done.refundAmount,done.depositPaid);
 assert.equal(listRecords(x.db,'hardware_payment').filter(p=>p.type==='refund').length,1);assert.equal(x.calls(),1);
});
test('slot remains held on uncertain release even when an inventory reports a different bank in it',async t=>{
 const x=await setup(t),a=await x.create(),b=await x.create('b');await x.request('pay',{rentalId:a.id});x.advance(61000);maintainHardware(x.db,x.time());
 await x.notify(64,{terminalArr:[{B:'BANK_C',L:3,D:100},{B:'BANK_B',L:4,D:90}]});
 const state=(await x.request('state',undefined,'b')).body;assert.deepEqual(state.cabinets[0].availableSlots,[4]);
 await x.request('pay',{rentalId:b.id},'b');assert.equal(hardwareOrders(x.db).find(o=>o.id===b.id).bankId,'BANK_B');
});

test('reserved banks and command idempotency survive SQLite reopen without a second supplier request',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'physical-rental-restart-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'state.sqlite');
 const x=await setup(t,file),r=await x.create();await x.request('pay',{rentalId:r.id});x.db.close();
 const db=openProductionStore(file);t.after(()=>db.close());let network=0;const now=x.time()+61000;
 maintainHardware(db,now);assert.equal(hardwareOrders(db)[0].status,'review_required');
 const api=createProductionAPI({db,config:x.config,now:()=>now,wschargeFetch:async()=>{network++;throw Error('must not resend');}});
 const response=await api(new Request(x.config.publicOrigin+'/api/user/hardware/pay',{method:'POST',headers:{cookie:'voltgo_user'+'='+'a'.repeat(43),origin:x.config.publicOrigin,'x-csrf-token':'csrf','content-type':'application/json'},body:JSON.stringify({rentalId:r.id})}));
 assert.equal(response.status,200);assert.equal((await response.json()).rental.status,'review_required');assert.equal(network,0);assert.equal(listRecords(db,'wscharge_command').length,1);assert.equal(listRecords(db,'hardware_payment').length,1);
});

function setPolicy(x,overrides={}){const p={currency:'ARS',hourlyRate:50000,dailyCap:300000,deposit:1000000,totalCap:1000000,maxRentalDays:0,policyVersion:1,version:'policy-test',...overrides};x.db.prepare("INSERT INTO settings VALUES('pricing',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(JSON.stringify(p));return p;}
async function borrowWithPolicy(x,overrides={}){setPolicy(x,overrides);const r=await x.create();await x.request('pay',{rentalId:r.id});x.advance(1000);await x.notify(65,{L:3,B:'BANK_A',S:200});return hardwareOrders(x.db).find(o=>o.id===r.id);}
test('total cap settles once without inventing a return; holds bought-out bank but allows other banks',async t=>{
 const x=await setup(t);const r=await borrowWithPolicy(x,{totalCap:100000});
 x.advance(3600000);maintainHardware(x.db,x.time());assert.equal(hardwareOrders(x.db)[0].status,'active');
 x.advance(1);assert.equal(maintainHardware(x.db,x.time()),1);const bought=hardwareOrders(x.db)[0];
 assert.equal(bought.status,'bought_out');assert.equal(bought.totalAmount,100000);assert.equal(bought.refundAmount,900000);assert.equal(bought.returnedAt,undefined);
 assert.equal(bought.endedAt,new Date(Date.parse(r.startedAt)+3600001).toISOString());
 assert.equal(maintainHardware(x.db,x.time()+86400000),0);assert.equal(listRecords(x.db,'hardware_payment').length,3);
 await x.inventory();const state=await x.request('state');assert.equal(state.body.rental,null);assert.deepEqual(state.body.cabinets[0].availableSlots,[4]);
 const next=await x.create();await x.request('pay',{rentalId:next.id});assert.equal(hardwareOrders(x.db).find(o=>o.id===next.id).slot,4);
});
test('maximum days ends at exact deadline, includes accrued rent, and retains order pricing snapshot',async t=>{
 const x=await setup(t);const r=await borrowWithPolicy(x,{maxRentalDays:1});setPolicy(x,{maxRentalDays:7,totalCap:500000,version:'new'});
 x.advance(86400000-1);maintainHardware(x.db,x.time());assert.equal(hardwareOrders(x.db)[0].status,'active');
 x.advance(1);maintainHardware(x.db,x.time());const done=hardwareOrders(x.db)[0];assert.equal(done.status,'bought_out');assert.equal(done.totalAmount,1000000);assert.equal(done.depositApplied,1000000);assert.equal(done.refundAmount,0);assert.equal(done.buyoutReason,'maximum_duration');assert.equal(done.pricing.maxRentalDays,1);assert.equal(done.endedAt,new Date(Date.parse(r.startedAt)+86400000).toISOString());
});
test('late maintenance records original cutoff, not restart time',async t=>{
 const x=await setup(t);const r=await borrowWithPolicy(x,{maxRentalDays:1});x.advance(10*86400000);maintainHardware(x.db,x.time());const done=hardwareOrders(x.db)[0];assert.equal(done.durationSeconds,86400);assert.equal(done.endedAt,new Date(Date.parse(r.startedAt)+86400000).toISOString());
});
test('open support freezes buyout settlement; operator must resolve support then explicitly resume',async t=>{
 const x=await setup(t);const r=await borrowWithPolicy(x,{totalCap:100000});putRecord(x.db,'support','case',{id:'case',rentalId:r.id,userId:'test_a',status:'open'},'test_a');x.advance(3600001);maintainHardware(x.db,x.time());
 let held=hardwareOrders(x.db)[0];assert.equal(held.status,'active');assert.equal(held.buyoutReview,true);assert.equal(listRecords(x.db,'hardware_payment').length,1);
 assert.throws(()=>x.resolve(r,'resume_buyout'),/Resolve related support/);
 putRecord(x.db,'support','case',{id:'case',rentalId:r.id,status:'resolved'},'test_a');maintainHardware(x.db,x.time());assert.equal(hardwareOrders(x.db)[0].status,'active');
 x.resolve(r,'resume_buyout');maintainHardware(x.db,x.time());assert.equal(hardwareOrders(x.db)[0].status,'bought_out');
});
test('post-release inventory evidence prevents automatic buyout and cannot be overridden as missing',async t=>{
 const x=await setup(t);const r=await borrowWithPolicy(x,{totalCap:100000});x.advance(3601000);await x.inventory();maintainHardware(x.db,x.time());assert.equal(hardwareOrders(x.db)[0].reviewReason,'buyout_return_evidence');assert.throws(()=>x.resolve(r,'resume_buyout'),/Return evidence exists/);x.resolve(r,'confirm_return');assert.equal(hardwareOrders(x.db)[0].status,'completed');assert.equal(hardwareOrders(x.db)[0].totalAmount,100000);
});
test('return before cap wins, return after cap has distinct buyout and return states',async t=>{
 const x=await setup(t);const r=await borrowWithPolicy(x,{totalCap:100000});x.advance(3600000);await x.notify(66,{L:3,B:'BANK_A'});assert.equal(hardwareOrders(x.db)[0].status,'completed');assert.equal(hardwareOrders(x.db)[0].totalAmount,50000);
 const y=await setup(t);await borrowWithPolicy(y,{totalCap:100000});y.advance(3601000);await y.notify(66,{L:3,B:'BANK_A'});const returned=hardwareOrders(y.db)[0];assert.equal(returned.status,'bought_out');assert.equal(returned.totalAmount,100000);assert.ok(returned.returnedAt);assert.equal(returned.settlementStatus,'review_required');assert.equal(listRecords(y.db,'hardware_payment').length,3);
});
test('late earlier return supports one audited difference refund; callback repeats never duplicate money',async t=>{
 const x=await setup(t);const r=await borrowWithPolicy(x,{totalCap:100000});const returnedSeconds=(x.time()+3500000)/1000;x.advance(3601000);maintainHardware(x.db,x.time());await x.notify(66,{L:3,B:'BANK_A'},returnedSeconds);const before=hardwareOrders(x.db)[0];assert.equal(before.status,'bought_out');assert.equal(before.reviewReason,'return_after_buyout');
 x.resolve(r,'refund_buyout_difference');let done=hardwareOrders(x.db)[0];assert.equal(done.status,'completed');assert.equal(done.totalAmount,50000);assert.equal(done.refundAmount,950000);assert.equal(listRecords(x.db,'hardware_payment').length,4);
 await x.notify(66,{L:3,B:'BANK_A'},returnedSeconds);assert.throws(()=>x.resolve(r,'refund_buyout_difference'),/returned mock buyout/);assert.equal(listRecords(x.db,'hardware_payment').length,4);
});
test('unconfirmed dispatch and legacy orders never auto-buyout',async t=>{
 const x=await setup(t);setPolicy(x,{maxRentalDays:1});const r=await x.create();await x.request('pay',{rentalId:r.id});x.advance(2*86400000);maintainHardware(x.db,x.time());assert.equal(hardwareOrders(x.db)[0].status,'review_required');assert.equal(listRecords(x.db,'hardware_payment').length,1);
 putRecord(x.db,'hardware_rental','legacy',{id:'legacy',userId:'test_b',status:'active',startedAt:new Date(x.time()-10*86400000).toISOString(),pricing:{currency:'ARS',hourlyRate:50000,dailyCap:300000,deposit:1000000}},'test_b');maintainHardware(x.db,x.time());assert.equal(hardwareOrders(x.db).find(o=>o.id==='legacy').status,'active');
});
test('stale displayed policy is rejected before creating a quote',async t=>{
 const x=await setup(t);setPolicy(x);const out=await x.request('create',{cabinetId:cabinet,pricingVersion:'old'});assert.equal(out.status,409);assert.equal(hardwareOrders(x.db).length,0);
});

test('restart recovers overdue buyout transaction once and keeps bank reserved',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'buyout-restart-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'db.sqlite');const x=await setup(t,path);const r=await borrowWithPolicy(x,{maxRentalDays:1});x.advance(2*86400000);x.db.close();
 const restored=openProductionStore(path);try{assert.equal(maintainHardware(restored,x.time()),1);const done=hardwareOrders(restored)[0];assert.equal(done.status,'bought_out');assert.equal(done.endedAt,new Date(Date.parse(r.startedAt)+86400000).toISOString());assert.equal(listRecords(restored,'hardware_payment').length,3);}finally{restored.close();}
 const again=openProductionStore(path);try{assert.equal(maintainHardware(again,x.time()+1000),0);assert.equal(listRecords(again,'hardware_payment').length,3);assert.equal(hardwareOrders(again)[0].returnedAt,undefined);}finally{again.close();}
});

test('pause blocks new quotes and previously unpaid orders; in-flight release, replay and returns continue',async t=>{
 const {saveCabinetControl}=await import('../src/production-cabinet-control.mjs');
 const x=await setup(t),a=await x.create(),b=await x.create('b');
 let release;const gate=new Promise(r=>release=r);x.intercept(()=>gate);
 const pending=x.request('pay',{rentalId:a.id});await new Promise(r=>setTimeout(r,0));
 saveCabinetControl(x.db,x.config,{id:'operator',role:'operator'},{cabinetId:cabinet,paused:true,note:'Maintenance scheduled',expectedUpdatedAt:null},x.time());
 assert.equal((await x.request('state')).body.cabinets[0].newRentalsPaused,true);
 assert.equal((await x.request('pay',{rentalId:b.id},'b')).status,409);
 assert.equal(listRecords(x.db,'hardware_payment').length,1);
 assert.equal((await x.request('pay',{rentalId:a.id})).status,200);assert.equal(x.calls(),1);
 release();await pending;x.advance(1000);await x.notify(65,{L:3,B:'BANK_A',S:200});
 x.advance(1000);await x.notify(66,{L:3,B:'BANK_A'});await x.notify(66,{L:3,B:'BANK_A'});
 assert.equal(hardwareOrders(x.db).find(r=>r.id===a.id).status,'completed');
 assert.equal(listRecords(x.db,'hardware_payment').length,3);
 assert.equal((await x.request('create',{cabinetId:cabinet})).status,409);
 assert.equal((await x.request('cancel',{rentalId:b.id},'b')).status,200);
 assert.equal(x.calls(),1);
});

test('delayed release from cancelled rental cannot reclaim a bank already re-rented; review is actionable',async t=>{
 const x=await setup(t),a=await x.create();await x.request('pay',{rentalId:a.id});const oldTs=x.time()/1000+1;
 x.advance(61000);maintainHardware(x.db,x.time());await x.inventory();x.resolve(a,'cancel_unreleased');
 x.advance(1000);await x.inventory();const b=await x.create('b');await x.request('pay',{rentalId:b.id},'b');x.advance(1000);await x.notify(65,{L:3,B:'BANK_A',S:200});
 await x.notify(65,{L:3,B:'BANK_A',S:200},oldTs);
 const old=hardwareOrders(x.db).find(r=>r.id===a.id);assert.equal(old.status,'cancelled');assert.equal(old.lateReleaseConflict.laterRentalId,b.id);assert.equal(old.settlementStatus,'review_required');
 const {operationQueue}=await import('../src/production-operations.mjs');assert.ok(operationQueue(x.db).some(i=>i.rentalId===a.id));
 x.resolve(a,'acknowledge_balance');assert.ok(!operationQueue(x.db).some(i=>i.rentalId===a.id));
 x.advance(1000);await x.notify(66,{L:3,B:'BANK_A'});await x.notify(66,{L:3,B:'BANK_A'});
 assert.equal(hardwareOrders(x.db).find(r=>r.id===b.id).status,'completed');assert.equal(hardwareOrders(x.db).find(r=>r.id===a.id).status,'cancelled');
 assert.equal(listRecords(x.db,'hardware_payment').filter(r=>r.rentalId===a.id&&r.type==='refund').length,1);
 assert.equal(listRecords(x.db,'hardware_payment').filter(r=>r.rentalId===b.id).length,3);
 assert.equal(x.calls(),2);
});

test('future-clock return is applied on retry once due and cannot settle twice',async t=>{
 const x=await setup(t),r=await x.create();await x.request('pay',{rentalId:r.id});x.advance(1000);await x.notify(65,{L:3,B:'BANK_A',S:200});
 x.advance(1000);const timestamp=x.time()/1000+5;await x.notify(66,{L:3,B:'BANK_A'},timestamp);
 assert.equal(hardwareOrders(x.db)[0].status,'active');assert.equal(listRecords(x.db,'wscharge_pending_event').length,1);
 x.advance(10000);assert.equal((await x.notify(66,{L:3,B:'BANK_A'},timestamp)).duplicate,true);
 assert.equal(hardwareOrders(x.db)[0].status,'completed');assert.equal(hardwareOrders(x.db)[0].returnedAt,new Date(timestamp*1000).toISOString());
 maintainHardware(x.db,x.time());assert.equal(listRecords(x.db,'wscharge_pending_event').length,0);assert.equal(listRecords(x.db,'hardware_payment').length,3);
});

test('future-clock release and return survive restart and process in event order without supplier retries',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'deferred-events-')),path=join(dir,'test.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const x=await setup(t,path),r=await x.create();await x.request('pay',{rentalId:r.id});
 const start=x.time()/1000+5,end=start+2;
 await x.notify(66,{L:3,B:'BANK_A'},end);await x.notify(65,{L:3,B:'BANK_A',S:200},start);
 assert.equal(hardwareOrders(x.db)[0].status,'dispatching');x.db.close();
 const db=openProductionStore(path);try{maintainHardware(db,(end+1)*1000);const done=hardwareOrders(db)[0];assert.equal(done.status,'completed');assert.equal(done.startedAt,new Date(start*1000).toISOString());assert.equal(done.returnedAt,new Date(end*1000).toISOString());assert.equal(listRecords(db,'wscharge_pending_event').length,0);maintainHardware(db,(end+100)*1000);assert.equal(listRecords(db,'hardware_payment').length,3);}finally{db.close();}
 assert.equal(x.calls(),1);
});

test('out-of-window future callbacks remain observations and never enter deferred settlement',async t=>{
 const x=await setup(t),r=await x.create();await x.request('pay',{rentalId:r.id});
 await x.notify(65,{L:3,B:'BANK_A',S:200},x.time()/1000+600);assert.equal(listRecords(x.db,'wscharge_pending_event').length,0);
 x.advance(601000);maintainHardware(x.db,x.time());assert.equal(hardwareOrders(x.db)[0].status,'review_required');assert.equal(hardwareOrders(x.db)[0].startedAt,undefined);
});

test('customer state, history and mutation responses never expose operator notes or internal evidence',async t=>{
 const x=await setup(t),r=await x.create();x.resolve(r,'note','Private supplier investigation');
 const stored=hardwareOrders(x.db)[0];stored.resolutionEvidence={secretMarker:'internal-only'};stored.pricing.internalOnly='hidden-pricing';putRecord(x.db,'hardware_rental',stored.id,stored,stored.userId);
 const responses=[(await x.request('state')).body,(await x.request('cancel',{rentalId:r.id})).body];
 const history=await x.api(new Request(x.config.publicOrigin+'/api/user/rentals',{headers:{cookie:'voltgo_user='+'a'.repeat(43)}}));responses.push(await history.json());
 responses.push((await x.request('pay',{rentalId:r.id})).body);
 for(const response of responses){const raw=JSON.stringify(response);assert.doesNotMatch(raw,/handlingHistory|actorId|actorRole|resolutionEvidence|Private supplier|internal-only|hidden-pricing/);}
 const internal=hardwareOrders(x.db)[0];assert.equal(internal.handlingHistory[0].note,'Private supplier investigation');assert.equal(internal.resolutionEvidence.secretMarker,'internal-only');
});

test('state query uses a bounded number of full order reads with 1000 unreturned buyouts',async t=>{
 const x=await setup(t),timestamp=new Date(x.time()-3600000).toISOString();
 for(let i=0;i<1000;i++){const r={id:'history_'+i,userId:'other_'+i,cabinetId:cabinet,status:'bought_out',createdAt:timestamp,startedAt:timestamp,bankId:'HIST_'+i,slot:3};putRecord(x.db,'hardware_rental',r.id,r,r.userId);putRecord(x.db,'wscharge_command','command_'+i,{id:'command_'+i,code:65,cabinetId:cabinet,rentalId:r.id,createdAt:timestamp});}
 let queries=0,rows=0;const prepare=x.db.prepare.bind(x.db);
 x.db.prepare=function(sql){const statement=prepare(sql);if(sql==='SELECT data FROM records WHERE kind=?')return {all(...args){const result=statement.all(...args);if(args[0]==='hardware_rental'){queries++;rows+=result.length;}return result;}};return statement;};
 const start=performance.now(),state=await x.request('state');assert.equal(state.status,200);assert.equal(state.body.cabinets[0].busy,false);assert.deepEqual(state.body.cabinets[0].availableSlots,[3,4]);assert.equal(state.body.rentals.length,0);
 assert.ok(queries<=2,`Unexpected full reads: ${queries}`);assert.ok(rows<=2000,`Unexpected parsed rows: ${rows}`);
 t.diagnostic(JSON.stringify({history:1000,fullOrderReads:queries,rowsParsed:rows,stateMs:Math.round((performance.now()-start)*100)/100}));
});
