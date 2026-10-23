import test from 'node:test';
import assert from 'node:assert/strict';
import {openProductionStore,listRecords} from '../src/production-store.mjs';
import {createProductionAPI} from '../src/production-api.mjs';
const time=Date.parse('2026-10-23T07:00:00Z'),token='synthetic-only-form-token';
const config={publicOrigin:'https://rental.example',wschargeEnabled:true,wschargeApiToken:token,wschargeCallbackToken:token,wschargeCabinets:['CAB_TEST'],wschargeDispatchEnabled:false};
const url=config.publicOrigin+'/api/integrations/wscharge/notify';
const payload={I:'64',E:'CAB_TEST',token,timestamp:String(time/1000),X:'1F',terminalArr:JSON.stringify([{B:'BANK_TEST',L:'01',D:99}])};
const form=(fields=payload)=>{const f=new FormData();for(const [k,v]of Object.entries(fields))f.append(k,v);return f;};
function setup(t){const db=openProductionStore(':memory:');t.after(()=>db.close());const api=createProductionAPI({db,config,now:()=>time});return {db,api};}
const post=(api,body)=>api(new Request(url,{method:'POST',body}));
test('supplier GET and empty POST probes succeed without recording or acknowledging inventory',async t=>{
 const {db,api}=setup(t);
 for(const req of [new Request(url),new Request(url,{method:'POST'}),new Request(url,{method:'POST',body:new FormData()})]){
  const r=await api(req);assert.equal(r.status,200);assert.deepEqual(await r.json(),{code:200,probe:true,received:false});
 }
 assert.equal(listRecords(db,'wscharge_event').length,0);assert.equal(listRecords(db,'wscharge_inventory').length,0);
 const disabled=createProductionAPI({db,config:{...config,wschargeEnabled:false},now:()=>time});assert.equal((await disabled(new Request(url))).status,503);
 assert.equal((await api(new Request(url+'?I=64'))).status,400);
 assert.equal((await api(new Request(url,{method:'PUT'}))).status,405);
});
test('authenticated multipart inventory updates sanitized state and duplicate retry is acknowledged',async t=>{
 const {db,api}=setup(t);const r=await post(api,form());assert.equal(r.status,200);assert.equal((await r.json()).received,true);
 assert.equal((await (await post(api,form())).json()).duplicate,true);
 const inv=listRecords(db,'wscharge_inventory');assert.equal(inv.length,1);assert.equal(inv[0].banks[0].slot,1);assert.equal(inv[0].banks[0].batteryPercent,99);
 assert.equal(JSON.stringify(inv).includes(token),false);
 assert.equal(listRecords(db,'payment').length,0);assert.equal(listRecords(db,'rental').length,0);
});
test('form callbacks still reject missing/bad token, unknown cabinets, stale timestamp state and invalid fields',async t=>{
 const {db,api}=setup(t);
 assert.equal((await post(api,form({...payload,token:''}))).status,401);
 assert.equal((await post(api,form({...payload,token:'wrong'}))).status,401);
 assert.equal((await post(api,form({...payload,E:'OTHER'}))).status,403);
 assert.equal((await post(api,form({...payload,timestamp:'not-seconds'}))).status,400);
 assert.equal((await post(api,form({...payload,extra:'unexpected'}))).status,400);
 assert.equal((await post(api,form({...payload,timestamp:String(time/1000-600)}))).status,200);
 assert.equal(listRecords(db,'wscharge_inventory').length,0);assert.equal(listRecords(db,'wscharge_event')[0].freshness,'outside_window');
});
test('nested form inventory is supported while duplicate/colliding fields, files and oversize payloads fail',async t=>{
 const {api}=setup(t);const nested={...payload};delete nested.terminalArr;
 Object.assign(nested,{'terminalArr[0][B]':'BANK_TEST','terminalArr[0][L]':'01','terminalArr[0][D]':'99'});
 assert.equal((await post(api,form(nested))).status,200);
 assert.equal((await post(api,form({...nested,terminalArr:'[]'}))).status,400);
 const repeated=form();repeated.append('token',token);assert.equal((await post(api,repeated)).status,400);
 const files=form();files.append('upload',new Blob(['example']),'file.txt');assert.equal((await post(api,files)).status,400);
 assert.equal((await post(api,form({...payload,token:'a'.repeat(17000)}))).status,413);
 assert.equal((await post(api,form({...payload,terminalArr:'[{"B":"BANK_TEST","L":1,"D":99,"D":0}]'}))).status,400);
});
test('form-urlencoded notifications and borrow/return observations preserve common event validation',async t=>{
 const {db,api}=setup(t);
 assert.equal((await post(api,new URLSearchParams(payload))).status,200);
 for(const I of ['65','66']) {
  const fields={I,E:'CAB_TEST',L:'01',B:'BANK_TEST',token,timestamp:String(time/1000)};if(I==='65')fields.S='200';
  assert.equal((await post(api,form(fields))).status,200);
 }
 assert.equal(listRecords(db,'wscharge_event').length,3);assert.equal(listRecords(db,'rental').length,0);
 assert.equal((await api(new Request(config.publicOrigin+'/api/admin/wscharge/commands',{method:'POST',body:form()}))).status,403);
});
