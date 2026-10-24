// Software integration: actual QR pixels + scan parser + rent.js controller + HTTP API.
// Fake DOM, synthetic signed-in sessions and supplier; not a camera/Google/hardware test.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import http from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openProductionStore,listRecords} from '../src/production-store.mjs';
import {createProductionAPI} from '../src/production-api.mjs';
import {saveCabinetControl} from '../src/production-cabinet-control.mjs';
const source=name=>readFileSync(new URL('../production-public/'+name,import.meta.url),'utf8');
const rentSource=source('rent.js'),appSource=source('app.js');
const scanSource=appSource.slice(appSource.indexOf('function scannedCabinet('),appSource.indexOf('async function requestQuote('));
const hash=s=>createHash('sha256').update(s).digest('hex');
class Element{constructor(tag='div'){this.tag=tag;this.children=[];}append(...n){this.children.push(...n);}replaceChildren(...n){this.children=n;}focus(){}}
const flat=n=>typeof n==='string'?[]:[n,...n.children.flatMap(flat)];
const content=n=>typeof n==='string'?n:[n.textContent||'',...n.children.map(content)].join(' ');
function decodePng(png){
 let width,height;const chunks=[];
 for(let p=8;p<png.length;){const length=png.readUInt32BE(p),type=png.toString('ascii',p+4,p+8),part=png.subarray(p+8,p+8+length);if(type==='IHDR'){width=part.readUInt32BE(0);height=part.readUInt32BE(4);assert.equal(part[8],8);assert.equal(part[9],0);}if(type==='IDAT')chunks.push(part);p+=length+12;}
 const raw=inflateSync(Buffer.concat(chunks)),pixels=new Uint8ClampedArray(width*height*4);
 for(let y=0;y<height;y++){assert.equal(raw[y*(width+1)],0);for(let x=0;x<width;x++){const i=(y*width+x)*4;pixels[i]=pixels[i+1]=pixels[i+2]=raw[y*(width+1)+x+1];pixels[i+3]=255;}}
 const ctx={module:{exports:{}},exports:{}};vm.runInNewContext(source('jsQR.js'),ctx);return ctx.module.exports(pixels,width,height)?.data;
}
test('six independent scan pages: real QR decode, competing confirmations, lost responses, isolated orders and repeated returns',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'multi-scan-')),path=join(dir,'isolated.sqlite');let db=openProductionStore(path),time=Math.floor(Date.now()/1000)*1000,dispatches=0,inventoryReplies=true;
 const config={publicOrigin:'https://example.test',enableGoogleTestLogin:true,hardwareRentalEnabled:true,wschargeEnabled:true,wschargeDispatchEnabled:true,wschargeApiToken:'isolated-synthetic-only',wschargeCallbackToken:'isolated-synthetic-only',wschargeCabinets:['CAB_A','CAB_B']};
 const users=Array.from({length:6},(_,i)=>({id:'scan_'+i,cabinetId:config.wschargeCabinets[Math.floor(i/3)],cookie:createHash('sha256').update('isolated_scan_'+i).digest('base64url'),csrf:'isolated_csrf_'+i}));
 for(const u of users){db.prepare('INSERT INTO test_users VALUES(?,?,?)').run(u.id,u.id,new Date(time).toISOString());db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(hash(u.cookie),'user',u.id,u.csrf,time+86400000);}
 let api,base,release,gate;const resetGate=()=>gate=new Promise(r=>release=r);resetGate();
 const notify=async(cab,I,extra={})=>{const r=await fetch(base+'/api/integrations/wscharge/notify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({I,E:cab,token:config.wschargeCallbackToken,timestamp:time/1000,...extra})});assert.equal(r.status,200);return r.json();};
 const inventory=cab=>notify(cab,64,{terminalArr:Array.from({length:3},(_,i)=>({B:cab+'_BANK_'+(i+1),L:i+1,D:100}))});
 const boot=()=>api=createProductionAPI({db,config,now:()=>time,wschargeFetch:async(_url,options)=>{const code=Number(options.body.get('I')),cab=options.body.get('E');assert.ok(config.wschargeCabinets.includes(cab));if(code===64){if(inventoryReplies)await inventory(cab);}else{assert.equal(code,65);dispatches++;await gate;}return new Response('{"code":200}');}});boot();
 const server=http.createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const r=await api(new Request(config.publicOrigin+req.url,{method:req.method,headers:req.headers,body:req.method==='GET'?undefined:Buffer.concat(chunks)}));res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));}catch{res.writeHead(500);res.end('{}');}});
 server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{release();server.closeAllConnections();await new Promise(r=>server.close(r));db.close();rmSync(dir,{recursive:true});});
 const request=(u,path,options={})=>fetch(base+path,{...options,headers:{...options.headers,cookie:'voltgo_user='+u.cookie,origin:config.publicOrigin}});
 const post=(u,action,body)=>request(u,'/api/user/hardware/'+action,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':u.csrf},body:JSON.stringify(body)});
 for(const cab of config.wschargeCabinets)await inventory(cab);
 const links=new Map();for(const cab of config.wschargeCabinets){const r=await fetch(base+'/api/user/station-qr?cabinet='+cab+'&format=png');assert.equal(r.status,200);const decoded=decodePng(Buffer.from(await r.arrayBuffer()));assert.equal(decoded,config.publicOrigin+'/rent?cabinet='+cab);const ctx=vm.createContext({URL,location:{origin:config.publicOrigin},stationData:{stations:[]},code:decoded});vm.runInContext(scanSource,ctx);assert.equal(vm.runInContext('scannedCabinet(code)',ctx),cab);ctx.code='https://wrong.example/rent?cabinet='+cab;assert.equal(vm.runInContext('scannedCabinet(code)',ctx),null);links.set(cab,decoded);}
 const page=async(u,{dropPay=false}={})=>{
  const elements=new Map(),requests=[];let dropped=false;
  const document={getElementById:id=>{for(const e of elements.values()){const found=flat(e).find(n=>n.id===id);if(found)return found;}if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},createElement:tag=>new Element(tag)};
  class Clock extends Date{constructor(...a){super(...(a.length?a:[time]));}static now(){return time;}}
  const ctx=vm.createContext({document,location:{href:links.get(u.cabinetId)},URL,Intl,Date:Clock,setInterval(){},setTimeout(fn){queueMicrotask(fn);},fetch:async(path,options)=>{requests.push(path);const r=await request(u,path,options);if(dropPay&&!dropped&&path.endsWith('/pay')&&r.ok){dropped=true;await r.arrayBuffer();throw Error('synthetic response lost after commit');}return r;}});
  vm.runInContext(rentSource,ctx);const run=code=>vm.runInContext(code,ctx);await run('load()');return {u,run,elements,requests,get dropped(){return dropped;}};
 };
 const pages=await Promise.all(users.map(u=>page(u,{dropPay:true})));
 assert.equal(listRecords(db,'hardware_rental').length,0);assert.equal(dispatches,0);
 for(const p of pages)assert.match(content(p.elements.get('flow')),/Confirm rental/);
 // Actual controller must refuse to create/pay when a fresh inventory reply never arrives.
 time+=1000;inventoryReplies=false;await pages[0].run('act(confirmRental)');inventoryReplies=true;
 assert.match(pages[0].elements.get('notice').textContent,/station has not replied/);assert.equal(listRecords(db,'hardware_rental').length,0);assert.equal(dispatches,0);
 let waiting=[...pages];
 for(let wave=0;wave<3;wave++){
  const before=dispatches;let settled=false;
  const jobs=waiting.map(p=>Promise.all([p.run('act(confirmRental)'),p.run('act(confirmRental)')]));const all=Promise.all(jobs).then(()=>settled=true);
  const deadline=Date.now()+5000;while(dispatches<before+2&&!settled&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
  assert.equal(dispatches,before+2,'one dispatch per cabinet per wave');release();await all;
  const winners=waiting.filter(p=>p.run('state.rental?.status')==='dispatching');assert.equal(winners.length,2);
  for(const p of winners){assert.equal(p.dropped,true);assert.match(content(p.elements.get('flow')),/timer has not started/);assert.doesNotMatch(content(p.elements.get('flow')),/Confirm rental/);const reload=await page(p.u);await reload.run('act(confirmRental)');assert.equal(dispatches,before+2);}
  time+=1000;
  for(const p of winners){const r=listRecords(db,'hardware_rental').find(r=>r.userId===p.u.id);await notify(r.cabinetId,65,{L:r.slot,B:r.bankId,S:200});const duplicate=await notify(r.cabinetId,65,{L:r.slot,B:r.bankId,S:200});assert.equal(duplicate.duplicate,true);await p.run('load()');assert.equal(p.run('state.rental.status'),'active');assert.match(content(p.elements.get('flow')),/Ready!/);}
  waiting=waiting.filter(p=>!winners.includes(p));time+=1000;resetGate();
 }
 assert.equal(waiting.length,0);assert.equal(dispatches,6);
 const active=listRecords(db,'hardware_rental');assert.equal(active.length,6);assert.ok(active.every(r=>r.status==='active'));assert.equal(new Set(active.map(r=>r.bankId)).size,6);
 for(const p of pages){await p.run('load()');assert.equal(p.run('state.rentals.length'),1);assert.equal(p.run('state.rentals[0].userId'),p.u.id);}
 const foreign=active.find(r=>r.userId!==users[0].id);assert.equal((await post(users[0],'pay',{rentalId:foreign.id})).status,404);assert.equal((await post(users[0],'cancel',{rentalId:foreign.id})).status,404);assert.equal(dispatches,6);
 // Restart persistence while every bank is in use; pausing new lending must not block returns.
 for(const cab of config.wschargeCabinets)saveCabinetControl(db,config,{id:'owner',role:'owner'},{cabinetId:cab,paused:true,note:'Isolated simulation',expectedUpdatedAt:null},time);
 db.close();db=openProductionStore(path);boot();time+=60000;
 for(const r of [...active].reverse()){await notify(r.cabinetId,66,{L:r.slot,B:r.bankId});assert.equal((await notify(r.cabinetId,66,{L:r.slot,B:r.bankId})).duplicate,true);}
 for(const p of pages){await p.run('load()');assert.equal(p.run('state.rental'),null);assert.equal(p.run('state.rentals.length'),1);assert.equal(p.elements.get('page-title').textContent,'Returned successfully');assert.match(content(p.elements.get('flow')),/Test refund/);assert.equal(p.run('state.rentals[0].status'),'completed');assert.equal(p.run('state.rentals[0].userId'),p.u.id);}
 const completed=listRecords(db,'hardware_rental'),payments=listRecords(db,'hardware_payment');assert.equal(payments.length,18);
 for(const r of completed){assert.equal(r.totalAmount,r.pricing.hourlyRate);assert.equal(r.depositPaid,r.pricing.deposit);assert.equal(r.refundAmount,r.depositPaid-r.totalAmount);assert.equal(r.settlementStatus,'settled');const ledger=payments.filter(p=>p.rentalId===r.id);assert.equal(ledger.length,3);assert.deepEqual(new Set(ledger.map(p=>p.type)),new Set(['deposit','rental_fee','refund']));assert.ok(ledger.every(p=>p.userId===r.userId));}
 assert.equal(listRecords(db,'wscharge_command').filter(c=>c.code===65).length,6);assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');
 t.diagnostic(JSON.stringify({accounts:6,cabinets:2,decodedQrImages:2,completed:6,dispatches,ledgerEntries:18,lostPayResponsesRecovered:6,duplicateClicks:true,duplicateCallbacks:true,foreignOrderAccessRejected:true,restartAndPausedReturns:true,missingInventoryBlocksRental:true,scope:'isolated fake DOM controller + real loopback HTTP and SQLite; synthetic sessions, supplier and payments; no real camera, Google authorization or physical release'}));
});
