import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openProductionStore} from '../src/production-store.mjs';
import {loadConfig} from '../src/production-config.mjs';
import {receiveWscharge,sendWschargeCommand,wschargeView,wschargeStatus,WSCHARGE_ENDPOINT} from '../src/production-wscharge.mjs';
const now=Date.parse('2026-10-23T00:00:00Z');
const config={wschargeEnabled:true,wschargeDispatchEnabled:true,wschargeApiToken:'review-only-api-secret',wschargeCallbackToken:'review-only-callback-secret',wschargeCabinets:['CAB1']};
const actor={id:'review-owner',role:'owner'};
const payload=(extra={})=>({I:65,E:'CAB1',L:'1',B:'BANK1',S:'200',timestamp:now/1000,token:config.wschargeCallbackToken,...extra});
const req=body=>new Request('https://example.test/api/integrations/wscharge/notify',{method:'POST',headers:{'content-type':'application/json'},body:typeof body==='string'?body:JSON.stringify(body)});
const rejects=(fn,status)=>assert.rejects(fn,e=>e.status===status);
test('review: default disabled and callback authentication/cabinet/schema failures never persist data',async t=>{
 const db=openProductionStore(':memory:');t.after(()=>db.close());
 assert.equal(wschargeStatus(loadConfig({PUBLIC_ORIGIN:'https://example.test'})).enabled,false);
 await rejects(()=>receiveWscharge(db,{},req(payload()),now),503);
 await rejects(()=>receiveWscharge(db,config,req(payload({token:'wrong'})),now),401);
 await rejects(()=>receiveWscharge(db,config,req(payload({E:'OTHER'})),now),403);
 for(const extra of [{L:0},{B:''},{timestamp:'nonsense'},{I:999},{arbitrary:'secret'}])await rejects(()=>receiveWscharge(db,config,req(payload(extra)),now),400);
 await rejects(()=>receiveWscharge(db,config,req('x'.repeat(16385)),now),413);
 assert.equal(db.prepare('SELECT count(*) n FROM records').get().n,0);
});
test('review: callback receipts persist, dedupe semantic retransmits, redact credentials and never change money',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'ws-review-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'db');let db=openProductionStore(path);
 const first=await receiveWscharge(db,config,req(payload()),now);assert.equal(first.duplicate,false);
 assert.equal((await receiveWscharge(db,config,req(payload({L:1,S:200,timestamp:String(now/1000)})),now+1000)).duplicate,true);
 db.close();db=openProductionStore(path);t.after(()=>db.close());
 assert.equal((await receiveWscharge(db,config,req(payload()),now)).duplicate,true);
 const view=wschargeView(db,config,now);assert.equal(view.events.length,1);assert.equal(view.events[0].trustedForSettlement,false);
 const persisted=db.prepare('SELECT data FROM records').all().map(x=>x.data).join('');assert.ok(!persisted.includes(config.wschargeCallbackToken));assert.ok(!persisted.includes(config.wschargeApiToken));
 assert.equal(db.prepare("SELECT count(*) n FROM records WHERE kind IN ('rental','payment')").get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM test_rentals').get().n,0);
});
test('review: stale and future inventory cannot replace recent inventory or infer available banks',async t=>{
 const db=openProductionStore(':memory:');t.after(()=>db.close());const inventory={I:64,E:'CAB1',timestamp:now/1000,token:config.wschargeCallbackToken,terminalArr:[{L:'1',B:'BANK1',D:90}],K:'privateSIMid'};
 await receiveWscharge(db,config,req(inventory),now);
 await receiveWscharge(db,config,req({...inventory,timestamp:now/1000-600,terminalArr:[]}),now);
 await receiveWscharge(db,config,req({...inventory,timestamp:now/1000+60,terminalArr:[]}),now);
 const view=wschargeView(db,config,now+121000);assert.equal(view.inventory[0].banks.length,1);assert.equal(view.inventory[0].stale,true);assert.equal(view.inventory[0].available,null);assert.ok(!JSON.stringify(view).includes('privateSIMid'));
});
test('review: outbound request persists before uncertain network result and prohibits replay/redispatch across restart',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'ws-send-review-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'db');let db=openProductionStore(path);let calls=0;
 const fetchImpl=async(url,options)=>{calls++;assert.equal(url,WSCHARGE_ENDPOINT);assert.equal(options.redirect,'error');assert.equal(options.body.get('token'),config.wschargeApiToken);assert.equal(options.body.get('I'),'65');throw Error('untrusted secret '+config.wschargeApiToken);};
 const args={config,actor,body:{code:65,cabinetId:'CAB1',slot:1},idempotencyKey:'review-command',time:now,fetchImpl};
 await rejects(()=>sendWschargeCommand({...args,db,actor:{...actor,role:'operator'}}),403);
 await rejects(()=>sendWschargeCommand({...args,db,config:{...config,wschargeDispatchEnabled:false}}),403);
 const sent=await sendWschargeCommand({...args,db});assert.equal(sent.command.status,'unknown');assert.equal(sent.command.physicalPickupConfirmed,false);db.close();db=openProductionStore(path);t.after(()=>db.close());
 assert.equal((await sendWschargeCommand({...args,db})).replayed,true);assert.equal(calls,1);
 await rejects(()=>sendWschargeCommand({...args,db,idempotencyKey:'another-key'}),409);assert.equal(calls,1);
 assert.ok(!JSON.stringify(wschargeView(db,config,now)).includes(config.wschargeApiToken));
 await receiveWscharge(db,config,req(payload()),now);const view=wschargeView(db,config,now);assert.deepEqual(view.events[0].candidateCommandIds,[sent.command.id]);assert.equal(view.commands[0].physicalPickupConfirmed,false);assert.equal(view.commands[0].status,'unknown');
});

test('review: ambiguous duplicate JSON keys and nested duplicate keys are rejected before persistence',async t=>{
 const db=openProductionStore(':memory:');t.after(()=>db.close());
 const plain=JSON.stringify(payload());
 await rejects(()=>receiveWscharge(db,config,req(plain.replace('"I":65','"I":60,"I":65')),now),400);
 await rejects(()=>receiveWscharge(db,config,req(plain.replace('"E":"CAB1"','"E":"OTHER","\\u0045":"CAB1"')),now),400);
 const inventory=`{"I":64,"E":"CAB1","timestamp":${now/1000},"token":"${config.wschargeCallbackToken}","terminalArr":[{"L":1,"B":"BAD","B":"BANK1","D":90}]}`;
 await rejects(()=>receiveWscharge(db,config,req(inventory),now),400);
 assert.equal(db.prepare('SELECT count(*) n FROM records').get().n,0);
});

test('review: simultaneous identical dispatch calls make exactly one supplier attempt and accepted reply is not pickup',async t=>{
 const db=openProductionStore(':memory:');t.after(()=>db.close());let calls=0,finish;const response=new Promise(resolve=>{finish=resolve;});
 const args={db,config,actor,body:{code:65,cabinetId:'CAB1',slot:1},idempotencyKey:'simultaneous-key',time:now,fetchImpl:async()=>{calls++;return response;}};
 const pending=sendWschargeCommand(args);const replay=await sendWschargeCommand(args);assert.equal(replay.replayed,true);assert.equal(replay.command.status,'unknown');assert.equal(calls,1);
 finish(Response.json({code:200,token:config.wschargeApiToken,message:config.wschargeCallbackToken}));const result=await pending;assert.equal(result.command.status,'accepted');assert.equal(result.command.physicalPickupConfirmed,false);
 assert.ok(!JSON.stringify(wschargeView(db,config,now)).includes(config.wschargeApiToken));assert.ok(!JSON.stringify(wschargeView(db,config,now)).includes(config.wschargeCallbackToken));
});

test('review: per-code schema rejects unrelated data and whitespace alias collisions',async t=>{
 const db=openProductionStore(':memory:');t.after(()=>db.close());
 await rejects(()=>receiveWscharge(db,config,req(payload({I:60})),now),400);
 const inventory={I:64,E:'CAB1',timestamp:now/1000,token:config.wschargeCallbackToken,terminalArr:[{B:'BANK1',L:1,' L ':2,D:90}]};
 await rejects(()=>receiveWscharge(db,config,req(inventory),now),400);
});

test('review: readiness rejects whitespace credentials/invalid cabinets and JSON lookalike media types',async t=>{
 for(const patch of [{wschargeApiToken:' '.repeat(16)},{wschargeCallbackToken:' '.repeat(16)},{wschargeCabinets:[' ']},{wschargeCabinets:['CAB1','bad/id']}])assert.equal(wschargeStatus({...config,...patch}).configured,false);
 const db=openProductionStore(':memory:');t.after(()=>db.close());
 const lookalike=new Request('https://example.test/api/integrations/wscharge/notify',{method:'POST',headers:{'content-type':'application/jsonjunk'},body:JSON.stringify(payload())});
 await rejects(()=>receiveWscharge(db,config,lookalike,now),415);
});

test('review: current offline notification invalidates otherwise fresh inventory',async t=>{
 const db=openProductionStore(':memory:');t.after(()=>db.close());
 const inventory={I:64,E:'CAB1',timestamp:now/1000,token:config.wschargeCallbackToken,terminalArr:[{L:'1',B:'BANK1',D:90}]};
 await receiveWscharge(db,config,req(inventory),now);assert.equal(wschargeView(db,config,now).inventory[0].stale,false);
 await receiveWscharge(db,config,req({I:90,E:'CAB1',timestamp:now/1000,token:config.wschargeCallbackToken}),now);
 const view=wschargeView(db,config,now);assert.equal(view.inventory[0].stale,true);assert.equal(view.inventory[0].observedConnection,'offline');assert.equal(view.inventory[0].available,null);
});
