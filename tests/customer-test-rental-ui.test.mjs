import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const source = readFileSync(new URL('../production-public/app.js', import.meta.url), 'utf8');
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.events = {}; this.attributes = {}; this.style = {}; this.value = ''; this.hiddenClasses = new Set(); this.classList = { add: name => this.hiddenClasses.add(name), remove: name => this.hiddenClasses.delete(name), toggle: (name, value) => { if (value === undefined ? !this.hiddenClasses.has(name) : value) this.hiddenClasses.add(name); else this.hiddenClasses.delete(name); } }; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, fn) { this.events[name] = fn; }
  focus() { this.focused = true; }
  scrollIntoView() {}
  querySelector(tag) { return flat(this).find(node => node.tagName === tag); }
  querySelectorAll() { return flat(this).filter(node => node.tagName === 'button'); }
}
const flat = node => [node, ...node.children.flatMap(flat)];
const text = node => flat(node).map(n => n.textContent || '').join(' ');
const pricing = {currency:'ARS',hourlyRate:10000,dailyCap:60000,deposit:0};
const rental = (status = 'pending_payment') => ({id:'test-one',stationId:'DEMO-001',stationName:'TEST · Demo station',pricing,status,createdAt:new Date().toISOString(),startedAt:new Date().toISOString(),totalAmount:10000,testOnly:true});
async function harness({authenticated=true, state={rental:null,rentals:[]}}={}) {
  const elements = new Map(), requests = []; let current = state;
  const user = authenticated ? {id:'customer',isTest:true,name:'Test customer'} : null;
  const context = vm.createContext({
    document:{body:new Element('body'), getElementById(id) { for (const node of elements.values()) { const found = flat(node).find(n => n.id === id); if (found) return found; } if (!elements.has(id)) elements.set(id,new Element()); return elements.get(id); },createElement:tag=>new Element(tag)},
    window:{addEventListener(){}},location:{pathname:'/',search:''},crypto:{randomUUID},Intl,Date,URLSearchParams,console,
    fetch:async(path,options={})=> { requests.push({path,options}); let data = {};
      if(path==='/api/user/session') data={user,csrf:'csrf',readiness:{googleTest:{ready:true}}};
      if(path==='/api/user/test/state') data={...current,serverNow:new Date().toISOString()};
      if(path.endsWith('/quote')) data={quote:{id:'quote-one',pricing}};
      if(path.endsWith('/rent')) { current={rental:rental(),rentals:[rental()]};data={rental:current.rental}; }
      if(path.endsWith('/pay')) { const body=JSON.parse(options.body); current={rental:rental(body.outcome==='success'?'active':'pending_payment'),rentals:[]};data={rental:current.rental}; }
      if(path.endsWith('/return')) { const completed=rental('completed');current={rental:null,rentals:[completed]};data={rental:completed}; }
      if(path.endsWith('/cancel')) {current={rental:null,rentals:[rental('cancelled')]};data={rental:current.rentals[0]};}
      return {ok:true,status:200,json:async()=>data};
    }
  });
  vm.runInContext(source,context); await new Promise(resolve=>setImmediate(resolve));
  return {run:code=>vm.runInContext(code,context),elements,requests,context};
}
test('TEST session opens scan surface, not account marketing, and rejects non-demo codes', async()=>{
  const h=await harness();
  assert.ok(h.elements.get('account').hiddenClasses.has('hidden'));
  assert.ok(!h.elements.get('rental-home').hiddenClasses.has('hidden'));
  assert.match(text(h.elements.get('rental-flow')),/Mock scan · DEMO-001/);
  const count=h.requests.length;await h.run("requestQuote('REAL-001')");assert.equal(h.requests.length,count);assert.match(h.elements.get('notice').textContent,/Only the demo/);
});
test('quote, payment failure/retry, active rental and settlement render end to end',async()=>{
  const h=await harness();await h.run("requestQuote('DEMO-001')");
  assert.match(text(h.elements.get('rental-flow')),/100\.00/);assert.match(text(h.elements.get('rental-flow')),/600\.00/);assert.match(text(h.elements.get('rental-flow')),/one-hour minimum/);
  await h.run("transact('rent',{quoteId:quote.id})");assert.match(text(h.elements.get('rental-flow')),/Choose a test payment/);
  await h.run("transact('pay',{rentalId:testState.rental.id,outcome:'failure'})");assert.match(h.elements.get('notice').textContent,/failed/);assert.match(text(h.elements.get('rental-flow')),/retry/);
  await h.run("transact('pay',{rentalId:testState.rental.id,outcome:'success'})");assert.match(text(h.elements.get('rental-flow')),/You’re charging/);assert.match(text(h.elements.get('rental-flow')),/100\.00/);
  await h.run("transact('return',{rentalId:testState.rental.id})");assert.match(text(h.elements.get('rentals')),/Returned · settled/);assert.match(h.elements.get('notice').textContent,/No real charge/);
  assert.match(text(h.elements.get('sheet-root')),/Test rental receipt/);assert.match(text(h.elements.get('sheet-root')),/Real charge/);assert.equal(flat(h.elements.get('sheet-root')).find(n=>n.textContent==='Close').disabled,false);
  for(const req of h.requests.filter(r=>r.options.method==='POST')) {assert.equal(req.options.headers['X-CSRF-Token'],'csrf');assert.match(req.options.headers['Idempotency-Key'],/^[a-f0-9-]{36}$/);assert.match(req.path,/^\/api\/user\/test\//);}
});
test('reload restores pending and active state; cancel returns to scan',async()=>{
  for(const status of ['pending_payment','active']) {const h=await harness({state:{rental:rental(status),rentals:[]}});assert.match(text(h.elements.get('rental-flow')),status==='active'?/You’re charging/:/Choose a test payment/);}
  const h=await harness({state:{rental:rental(),rentals:[]}});await h.run("transact('cancel',{rentalId:'test-one'})");assert.match(text(h.elements.get('rental-flow')),/Start a test rental/);assert.match(text(h.elements.get('rentals')),/Canceled/);
});
test('history renders untrusted content only as text and camera fallback needs no permission',async()=>{
  const bad='<img src=x onerror=alert(1)>'; const h=await harness({state:{rental:null,rentals:[{...rental('completed'),stationName:bad}]}});
  assert.ok(flat(h.elements.get('rentals')).some(n=>n.textContent===bad));assert.ok(!flat(h.elements.get('rentals')).some(n=>n.tagName==='img'));
  const count=h.requests.length;await h.run('startCamera()');assert.equal(h.requests.length,count);assert.match(h.elements.get('notice').textContent,/Enter DEMO-001/);
  assert.doesNotMatch(source,/innerHTML|insertAdjacentHTML|\balert\(|\bconfirm\(/);
});
test('return opens custom accessible confirmation and dismissal never mutates',async()=>{
  const h=await harness({state:{rental:rental('active'),rentals:[]}});const count=h.requests.length;
  h.run('confirmReturn(testState.rental)');const sheet=flat(h.elements.get('sheet-root')).find(n=>n.attributes.role==='dialog');assert.equal(sheet.attributes['aria-modal'],'true');assert.equal(h.elements.get('main-content').inert,true);
  h.run('closeSheet()');assert.equal(h.elements.get('main-content').inert,false);assert.equal(h.requests.length,count);
});
test('ambiguous mutation retries preserve key; distinct logical outcomes use separate keys',async()=>{
  const h=await harness();const keys=[];h.context.fetch=async(path,opts)=>{keys.push(opts.headers['Idempotency-Key']);throw new Error('Network lost');};
  await assert.rejects(h.run("mutate('pay',{rentalId:'r1',outcome:'success'})"));await assert.rejects(h.run("mutate('pay',{rentalId:'r1',outcome:'success'})"));await assert.rejects(h.run("mutate('pay',{rentalId:'r1',outcome:'failure'})"));
  assert.equal(keys[0],keys[1]);assert.notEqual(keys[0],keys[2]);
});
