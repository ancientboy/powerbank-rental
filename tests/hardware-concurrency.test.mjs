// Real loopback HTTP, isolated disk database, entirely synthetic supplier.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {openProductionStore,listRecords} from '../src/production-store.mjs';
import {createProductionAPI} from '../src/production-api.mjs';
import {receiveWscharge} from '../src/production-wscharge.mjs';
import {saveCabinetControl} from '../src/production-cabinet-control.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
test('50 concurrent HTTP users: 10 cabinets, 5 lending waves, no duplicate dispatch or settlement',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'rental-concurrency-')),path=join(dir,'isolated.sqlite');let db=openProductionStore(path),time=Date.parse('2026-10-23T09:00:00Z'),calls=0;
 const config={publicOrigin:'https://example.test',enableGoogleTestLogin:true,hardwareRentalEnabled:true,wschargeEnabled:true,wschargeDispatchEnabled:true,wschargeApiToken:'isolated-supplier-token',wschargeCallbackToken:'isolated-supplier-token',wschargeCabinets:Array.from({length:10},(_,i)=>'CAB_'+i)};
 const users=Array.from({length:50},(_,i)=>({id:'test_'+i,cabinetId:'CAB_'+Math.floor(i/5),cookie:createHash('sha256').update('session_'+i).digest('base64url')}));
 for(const u of users){db.prepare('INSERT INTO test_users VALUES(?,?,?)').run(u.id,u.id,new Date(time).toISOString());db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(hash(u.cookie),'user',u.id,'csrf',time+86400000);}
 let release;let gate=new Promise(r=>release=r);
 let api;const boot=()=>api=createProductionAPI({db,config,now:()=>time,wschargeFetch:async()=>{calls++;await gate;return new Response('{"code":200}');}});boot();
 const server=http.createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const r=await api(new Request(config.publicOrigin+req.url,{method:req.method,headers:req.headers,body:req.method==='GET'?undefined:Buffer.concat(chunks)}));res.writeHead(r.status,Object.fromEntries(r.headers));res.end(await r.text());}catch{res.writeHead(500);res.end('{}');}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));db.close();rmSync(dir,{recursive:true});});
 const base='http://127.0.0.1:'+server.address().port,latencies=[];
 const request=async(u,action,body)=>{const started=performance.now();const r=await fetch(base+'/api/user/hardware/'+action,{method:body===undefined?'GET':'POST',headers:{cookie:'voltgo_user='+u.cookie,'content-type':'application/json',origin:config.publicOrigin,'x-csrf-token':'csrf'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();latencies.push(performance.now()-started);return {status:r.status,data};};
 const notify=(cab,I,extra={})=>receiveWscharge(db,config,new Request(config.publicOrigin+'/api/integrations/wscharge/notify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({I,E:cab,token:config.wschargeCallbackToken,timestamp:time/1000,...extra})}),time);
 const inventory=async()=>{for(const cab of config.wschargeCabinets)await notify(cab,64,{terminalArr:Array.from({length:5},(_,i)=>({B:cab+'_BANK_'+(i+1),L:i+1,D:100}))});};
 await inventory();
 const quotes=await Promise.all(users.map(u=>request(u,'create',{cabinetId:u.cabinetId})));quotes.forEach((r,i)=>{assert.equal(r.status,200);users[i].rentalId=r.data.rental.id;});
 const started=performance.now();let waiting=[...users],conflicts=0;
 for(let wave=0;wave<5;wave++){
  const before=calls,pending=waiting.map(u=>request(u,'pay',{rentalId:u.rentalId}));
  // Keep commands pending until every competing request reached its reservation decision.
  const deadline=Date.now()+10000;
  while(calls<before+10&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
  assert.equal(calls,before+10);
  await new Promise(r=>setTimeout(r,30));release();
  const results=await Promise.all(pending),winners=[],retry=[];
  results.forEach((r,i)=>{if(r.status===200){assert.equal(r.data.rental.status,'dispatching');winners.push(waiting[i]);}else{assert.equal(r.status,409);retry.push(waiting[i]);conflicts++;}});
  assert.equal(winners.length,10);assert.equal(new Set(winners.map(u=>u.cabinetId)).size,10);
  const replay=await Promise.all(winners.map(u=>request(u,'pay',{rentalId:u.rentalId})));assert.ok(replay.every(r=>r.status===200));assert.equal(calls,before+10);
  time+=1000;
  for(const u of winners){const r=listRecords(db,'hardware_rental').find(r=>r.id===u.rentalId);await notify(r.cabinetId,65,{L:r.slot,B:r.bankId,S:200});await notify(r.cabinetId,65,{L:r.slot,B:r.bankId,S:200});}
  time+=1000;await inventory();waiting=retry;gate=new Promise(r=>release=r);
 }
 assert.equal(waiting.length,0);assert.equal(calls,50);assert.equal(conflicts,100);
 const active=listRecords(db,'hardware_rental');assert.equal(active.length,50);assert.ok(active.every(r=>r.status==='active'));
 assert.equal(new Set(active.map(r=>r.bankId)).size,50);assert.equal(new Set(active.map(r=>r.cabinetId+':'+r.slot)).size,50);
 assert.equal(listRecords(db,'hardware_payment').length,50);
 // Pause every cabinet, restart the API/database, then process returns twice.
 for(const cab of config.wschargeCabinets)saveCabinetControl(db,config,{id:'owner',role:'owner'},{cabinetId:cab,paused:true,note:'Isolated pause test',expectedUpdatedAt:null},time);
 db.close();db=openProductionStore(path);boot();time+=60000;
 for(const r of active){await notify(r.cabinetId,66,{L:r.slot,B:r.bankId});await notify(r.cabinetId,66,{L:r.slot,B:r.bankId});}
 const states=await Promise.all(users.map(u=>request(u,'state')));
 states.forEach((r,i)=>{assert.equal(r.status,200);assert.equal(r.data.rentals.length,1);assert.equal(r.data.rentals[0].id,users[i].rentalId);assert.equal(r.data.rentals[0].status,'completed');assert.equal(r.data.rental,null);assert.ok(r.data.cabinets.every(c=>c.newRentalsPaused));});
 assert.equal(listRecords(db,'hardware_payment').length,150);assert.equal(listRecords(db,'wscharge_command').filter(c=>c.code===65).length,50);
 assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');
 const sorted=latencies.sort((a,b)=>a-b);t.diagnostic(JSON.stringify({users:50,cabinets:10,requests:latencies.length,dispatches:calls,completed:50,expectedBusyResponses:conflicts,duplicateCallbacksSafe:true,elapsedMs:Math.round(performance.now()-started),p95Ms:Math.round(sorted[Math.ceil(sorted.length*.95)-1]),scope:'isolated loopback single Node process, SQLite disk WAL; mock supplier, no physical device'}));
});
