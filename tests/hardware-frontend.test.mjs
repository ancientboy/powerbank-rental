import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
class Element{constructor(tag='div'){this.tag=tag;this.children=[];}append(...n){this.children.push(...n);}replaceChildren(...n){this.children=n;}focus(){}}
const flat=n=>[n,...n.children.flatMap(flat)];
const text=n=>typeof n==='string'?n:[n.textContent||'',...n.children.map(text)].join(' ');
const pricing={currency:'ARS',hourlyRate:50000,dailyCap:300000,deposit:1000000};
async function page({user={id:'test_a',isTest:true},rental=null,query='?cabinet=CAB_TEST',fresh=true}={}){
 const elements=new Map(),requests=[];let payError=false;
 const state={enabled:true,dispatchEnabled:true,authorized:true,userId:'test_a',serverNow:new Date().toISOString(),pricing,cabinets:[{cabinetId:'CAB_TEST',connection:'online',inventoryState:'observed',inventoryObservedAt:new Date().toISOString(),banks:[{slot:3,batteryPercent:100}]}],rental,rentals:rental?[rental]:[]};
 const document={getElementById:id=>{for(const e of elements.values()){const found=flat(e).find(n=>n.id===id);if(found)return found;}if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},createElement:tag=>new Element(tag)};
 const context=vm.createContext({document,location:{href:'https://example.test/rent'+query},URL,Intl,Date,setInterval(){},setTimeout(fn){queueMicrotask(fn);},fetch:async(path,opt)=>{
  requests.push({path,opt});let data={ok:true};
  if(path==='/api/user/session')data={user,csrf:'csrf'};
  if(path.endsWith('/state'))data=structuredClone(state);
  if(path.endsWith('/refresh')&&fresh)state.cabinets[0].inventoryObservedAt=new Date().toISOString();
  if(path.endsWith('/create')){state.rental={id:'order1',cabinetId:'CAB_TEST',status:'pending_payment',pricing,createdAt:new Date().toISOString(),depositPaid:0};state.rentals=[state.rental];data={rental:state.rental};}
  if(path.endsWith('/pay')){state.rental.status='dispatching';state.rental.slot=3;state.rental.bankId='BANK_A';state.rental.dispatchedAt=new Date().toISOString();if(payError)throw Error('network');data={rental:state.rental};}
  if(path.endsWith('/cancel')){state.rental.status='cancelled';state.rental=null;}
  return {ok:true,json:async()=>structuredClone(data)};
 }});
 vm.runInContext(await readFile(new URL('../production-public/rent.js',import.meta.url),'utf8'),context);await new Promise(r=>setImmediate(r));return {context,elements,requests,state,run:code=>vm.runInContext(code,context),payError:()=>payError=true};
}
test('scan displays one confirmation with prices; no order creation or dispatch until click',async()=>{
 const signedOut=await page({user:null});assert.match(text(signedOut.elements.get('flow')),/Sign in and continue/);assert.equal(signedOut.requests.some(r=>r.opt.method==='POST'),false);
 for(const user of [{id:'test_a',isTest:true},{id:'google_a',isTest:false}]){const p=await page({user});const content=text(p.elements.get('flow'));assert.match(content,/Confirm rental/);assert.match(content,/Per started hour/);assert.doesNotMatch(content,/创建测试租借订单|申请|授权|刷新机柜库存/);assert.equal(p.requests.some(r=>r.opt.method==='POST'),false);}
 const invalid=await page({query:'?cabinet=%3Cscript%3E'});assert.match(text(invalid.elements.get('flow')),/valid station ID/);
});
test('one confirmation checks inventory, creates and pays once; double click does not dispatch again',async()=>{
 const p=await page();const first=p.run('act(confirmRental)');await p.run('act(confirmRental)');await first;
 assert.deepEqual(p.requests.filter(r=>r.opt.method==='POST').map(r=>r.path.split('/').at(-1)),['refresh','create','pay']);
 assert.equal(p.state.rental.status,'dispatching');assert.match(text(p.elements.get('flow')),/Slot 3/);assert.match(text(p.elements.get('flow')),/timer has not started/);assert.doesNotMatch(text(p.elements.get('flow')),/Ready!/);
});
test('unanswered inventory request cannot create or dispatch',async()=>{
 const p=await page({fresh:false});p.state.cabinets[0].inventoryObservedAt='2020-01-01T00:00:00Z';await p.run('act(confirmRental)');
 assert.equal(p.requests.some(r=>/\/(pay|create)$/.test(r.path)),false);assert.match(p.elements.get('notice').textContent,/The station has not replied/);
});
test('lost payment response restores dispatching order and cannot offer a repeat borrow',async()=>{
 const p=await page();p.payError();await p.run('act(confirmRental)');assert.equal(p.requests.filter(r=>r.path.endsWith('/pay')).length,1);assert.match(text(p.elements.get('flow')),/timer has not started/);assert.doesNotMatch(text(p.elements.get('flow')),/Confirm rental/);
});
test('successful ejection shows slot and timer; matching return shows receipt and collapsible order details',async()=>{
 const r={id:'order1',cabinetId:'CAB_TEST',status:'active',slot:3,bankId:'BANK_A',startedAt:new Date(Date.now()-65000).toISOString(),pricing,totalAmount:50000};
 const p=await page({rental:r});assert.match(text(p.elements.get('flow')),/Ready!/);assert.match(text(p.elements.get('flow')),/Slot 3/);assert.match(text(p.elements.get('flow')),/00:01:05/);assert.doesNotMatch(text(p.elements.get('flow')),/Confirm rental/);
 p.state.rentals=[{...r,status:'completed',returnedAt:new Date().toISOString(),refundAmount:950000}];p.state.rental=null;await p.run('load()');assert.equal(p.elements.get('page-title').textContent,'Returned successfully');assert.match(text(p.elements.get('flow')),/Test refund/);assert.ok(flat(p.elements.get('history')).some(n=>n.tag==='details'));
});
test('hardware templates use external assets and render no HTML from records',async()=>{
 const html=await readFile(new URL('../production-public/rent.html',import.meta.url),'utf8');assert.doesNotMatch(html,/<script(?![^>]*src=)|\son\w+=/i);assert.doesNotMatch(html,/admin#/);
 const js=await readFile(new URL('../production-public/rent.js',import.meta.url),'utf8');assert.doesNotMatch(js,/innerHTML|eval\(|insertAdjacentHTML/);
});

test('expired pending order is replaced under the same confirmation; changed pricing requires reconfirmation',async()=>{
 const old={id:'old',cabinetId:'CAB_TEST',status:'pending_payment',pricing,createdAt:'2020-01-01T00:00:00Z'};
 const p=await page({rental:old});await p.run('act(confirmRental)');assert.deepEqual(p.requests.filter(r=>r.opt.method==='POST').map(r=>r.path.split('/').at(-1)),['refresh','cancel','create','pay']);
 const changed=await page();changed.state.pricing={...pricing,hourlyRate:60000};await changed.run('act(confirmRental)');
 // Newly created order still has the price that was displayed before refresh: safe to confirm.
 assert.equal(changed.requests.filter(r=>r.path.endsWith('/pay')).length,1);
 const mismatch=await page({rental:{...old,status:'pending_payment',pricing:{...pricing,hourlyRate:10000}}});await mismatch.run('act(confirmRental)');
 assert.equal(mismatch.requests.filter(r=>r.path.endsWith('/pay')).length,0);assert.match(mismatch.elements.get('notice').textContent,/Prices have changed/);
});

test('customer rental surfaces are English and share Smile navigation destinations',async()=>{
 for(const file of ['rent.html','rent.js','index.html','app.js']){const source=await readFile(new URL('../production-public/'+file,import.meta.url),'utf8');assert.doesNotMatch(source,/[\u3400-\u9fff]/);}
 const html=await readFile(new URL('../production-public/rent.html',import.meta.url),'utf8');assert.match(html,/<html lang="en">/);
 for(const route of ['/#stations','/#history','/#profile'])assert.ok(html.includes('href="'+route+'"'));
});
