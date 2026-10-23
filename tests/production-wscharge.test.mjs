import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openProductionStore,listRecords} from '../src/production-store.mjs';
import {createProductionAPI} from '../src/production-api.mjs';
import {loadConfig} from '../src/production-config.mjs';
import {sendWschargeCommand,receiveWscharge,wschargeView,WSCHARGE_NOTIFY_PATH,WSCHARGE_ENDPOINT} from '../src/production-wscharge.mjs';
const time=Date.parse('2026-10-23T06:00:00Z'), token='synthetic-test-token-not-a-credential';
const config={publicOrigin:'https://rental.example',secure:true,sessionSeconds:3600,userSessionSeconds:3600,wschargeEnabled:true,wschargeDispatchEnabled:true,wschargeApiToken:token,wschargeCallbackToken:token,wschargeCabinets:['CABINET_TEST_01']};
const event=(extra={})=>({I:65,E:'CABINET_TEST_01',L:'1',B:'BANK_TEST_01',S:'200',timestamp:String(time/1000),token,...extra});
const request=body=>new Request(config.publicOrigin+WSCHARGE_NOTIFY_PATH,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const actor={id:'owner-test',role:'owner'};
test('WsCharge transport sends only documented multipart fields, stores acceptance not pickup, durably deduplicates',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'wscharge-'));let db=openProductionStore(join(dir,'db.sqlite'));let calls=0;
 const fetchImpl=async(url,options)=>{calls++;assert.equal(url,WSCHARGE_ENDPOINT);assert.equal(options.redirect,'error');assert.deepEqual(Object.fromEntries(options.body),{token,E:'CABINET_TEST_01',I:'65',L:'1'});return Response.json({code:200,msg:token,data:[]});};
 try{
  const args={db,config,actor,body:{code:65,cabinetId:'CABINET_TEST_01',slot:1},idempotencyKey:'dispatch-key-one',time,fetchImpl};
  const r=await sendWschargeCommand(args);assert.equal(r.command.status,'accepted');assert.equal(r.command.physicalPickupConfirmed,false);
  db.close();db=openProductionStore(join(dir,'db.sqlite'));
  assert.equal((await sendWschargeCommand({...args,db})).replayed,true);assert.equal(calls,1);
  await assert.rejects(()=>sendWschargeCommand({...args,db,idempotencyKey:'different-key-two'}),{status:409});
  assert.equal(JSON.stringify(listRecords(db,'wscharge_command')).includes(token),false);
  assert.deepEqual(listRecords(db,'rental'),[]);assert.deepEqual(listRecords(db,'payment'),[]);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('timeout/redirect/malformed response stay unknown, no physical retry; disabled roles and maintenance fail closed',async()=>{
 const db=openProductionStore(':memory:');try{
 const args={db,config,actor,body:{code:65,cabinetId:'CABINET_TEST_01',slot:1},idempotencyKey:'timeout-key-one',time,fetchImpl:async()=>{throw new Error(token);}};
 assert.equal((await sendWschargeCommand(args)).command.status,'unknown');
 assert.equal((await sendWschargeCommand(args)).replayed,true);
 await assert.rejects(()=>sendWschargeCommand({...args,actor:{...actor,role:'operator'}}),{status:403});
 await assert.rejects(()=>sendWschargeCommand({...args,body:{code:80,cabinetId:'CABINET_TEST_01',slot:1}}),{status:400});
 await assert.rejects(()=>sendWschargeCommand({...args,config:{...config,wschargeDispatchEnabled:false}}),{status:403});
 await assert.rejects(()=>sendWschargeCommand({...args,config:{...config,wschargeEnabled:false}}),{status:503});
 }finally{db.close();}
});
test('authenticated callbacks are sanitized durable observations; stale/future retained but cannot replace inventory',async()=>{
 const db=openProductionStore(':memory:');try{
 await assert.rejects(()=>receiveWscharge(db,config,request(event({token:'wrong'})),time),{status:401});
 await assert.rejects(()=>receiveWscharge(db,config,request(event({E:'OTHER_CABINET'})),time),{status:403});
 assert.equal((await receiveWscharge(db,config,request(event()),time)).duplicate,false);
 assert.equal((await receiveWscharge(db,config,request(event()),time)).duplicate,true);
 assert.equal((await receiveWscharge(db,config,request(event({timestamp:String(time/1000+1)})),time)).duplicate,false);
 const inv={I:64,E:'CABINET_TEST_01',K:'PrivateSimNotStored',X:'1F',terminalArr:[{B:'BANK_TEST_01',L:'01',D:80}],timestamp:String(time/1000),token};
 await receiveWscharge(db,config,request(inv),time);
 await receiveWscharge(db,config,request({...inv,timestamp:String(time/1000-600),terminalArr:[]}),time);
 await receiveWscharge(db,config,request({...inv,timestamp:String(time/1000+600),terminalArr:[]}),time);
 const view=wschargeView(db,config,time);assert.equal(view.inventory[0].banks.length,1);assert.equal(view.inventory[0].available,null);
 assert.equal(view.events.filter(e=>e.freshness==='outside_window').length,2);
 assert.ok(view.events.every(e=>e.trustedForSettlement===false));
 assert.equal(JSON.stringify(view).includes(token),false);assert.equal(JSON.stringify(view).includes('PrivateSimNotStored'),false);
 await assert.rejects(()=>receiveWscharge(db,config,request({...inv,terminalArr:[inv.terminalArr[0],inv.terminalArr[0]]}),time),{status:400});
 assert.equal(listRecords(db,'payment').length,0);assert.equal(listRecords(db,'rental').length,0);
 }finally{db.close();}
});
test('API provider exception is route-specific, admin reads hide secrets and command writes retain CSRF/roles',async()=>{
 const db=openProductionStore(':memory:');try{
 let calls=0;const api=createProductionAPI({db,config,now:()=>time,wschargeFetch:async()=>{calls++;return Response.json({code:200});}});
 assert.equal((await api(request(event()))).status,200);
 const adminToken=randomBytes(32).toString('base64url');
 db.prepare('INSERT INTO admins VALUES(?,?,?,?,0)').run(actor.id,'owner-test','unused','owner');
 db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(createHash('sha256').update(adminToken).digest('hex'),'admin',actor.id,'csrf-test',time+60000);
 const call=(path,body,csrf=true)=>api(new Request(config.publicOrigin+path,{method:body?'POST':'GET',headers:{cookie:'voltgo_admin='+adminToken,...(body?{'content-type':'application/json',origin:config.publicOrigin,'idempotency-key':'api-query-one',...(csrf?{'x-csrf-token':'csrf-test'}:{})}:{})},body:body?JSON.stringify(body):undefined}));
 assert.equal((await api(new Request(config.publicOrigin+'/api/admin/wscharge'))).status,401);
 const view=await (await call('/api/admin/wscharge')).json();assert.equal(JSON.stringify(view).includes(token),false);
 assert.equal((await call('/api/admin/wscharge/commands',{code:64,cabinetId:'CABINET_TEST_01'},false)).status,403);
 assert.equal((await call('/api/admin/wscharge/commands',{code:64,cabinetId:'CABINET_TEST_01'})).status,200);assert.equal(calls,1);
 db.prepare('UPDATE admins SET role=? WHERE id=?').run('viewer',actor.id);
 assert.equal((await call('/api/admin/wscharge/commands',{code:64,cabinetId:'CABINET_TEST_01'})).status,403);
 }finally{db.close();}
});
test('config defaults closed and validates local timestamp policy',()=>{
 const c=loadConfig({PUBLIC_ORIGIN:'https://example.test'});assert.equal(c.wschargeEnabled,false);assert.deepEqual(c.wschargeCabinets,[]);
 assert.throws(()=>loadConfig({PUBLIC_ORIGIN:'https://example.test',WSCHARGE_MAX_CLOCK_SKEW_SECONDS:'bad'}));
});
test('inventory whitespace fields normalize with collision rejection; offline observations invalidate fresh snapshots',async()=>{
 const db=openProductionStore(':memory:');try{
 const inv={I:64,E:'CABINET_TEST_01',terminalArr:[{B:'BANK_TEST_01',' L ':'01',D:80}],timestamp:String(time/1000),token};
 await receiveWscharge(db,config,request(inv),time);
 assert.equal(wschargeView(db,config,time).inventory[0].banks[0].slot,1);
 await assert.rejects(()=>receiveWscharge(db,config,request({...inv,terminalArr:[{...inv.terminalArr[0],L:'02'}]}),time),{status:400});
 await receiveWscharge(db,config,request({I:90,E:'CABINET_TEST_01',timestamp:String(time/1000),token}),time);
 const inventory=wschargeView(db,config,time).inventory[0];assert.equal(inventory.stale,true);assert.equal(inventory.observedConnection,'offline');
 const duplicateRaw=JSON.stringify(event()).replace('"I":65','"I":66,"I":65');
 await assert.rejects(()=>receiveWscharge(db,config,new Request(config.publicOrigin+WSCHARGE_NOTIFY_PATH,{method:'POST',headers:{'content-type':'application/json'},body:duplicateRaw}),time),{status:400});
 await assert.rejects(()=>receiveWscharge(db,config,request({I:60,E:'CABINET_TEST_01',L:{unexpected:true},timestamp:String(time/1000),token}),time),{status:400});
 }finally{db.close();}
});
