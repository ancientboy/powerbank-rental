import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const source = readFileSync(new URL('../production-public/app.js', import.meta.url), 'utf8');
class Element {
  constructor(tag = 'div') { this.isConnected = true; this.tagName = tag; this.children = []; this.events = {}; this.attributes = {}; this.style = {}; this.value = ''; this.hiddenClasses = new Set(); this.classList = { add: name => this.hiddenClasses.add(name), remove: name => this.hiddenClasses.delete(name), toggle: (name, value) => { if (value === undefined ? !this.hiddenClasses.has(name) : value) this.hiddenClasses.add(name); else this.hiddenClasses.delete(name); } }; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { for (const node of this.children.flatMap(flat)) node.isConnected = false; this.children = nodes; }
  async play() {}
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, fn) { this.events[name] = fn; }
  focus() { this.focused = true; }
  click() { return this.events.click?.(); }
  scrollIntoView() {}
  querySelector(tag) { return flat(this).find(node => node.tagName === tag); }
  querySelectorAll() { return flat(this).filter(node => node.tagName === 'button'); }
}
const flat = node => [node, ...node.children.flatMap(flat)];
const text = node => flat(node).map(n => n.textContent || '').join(' ');
const pricing = {currency:'ARS',hourlyRate:50000,dailyCap:300000,deposit:1000000};
const rental = (status = 'pending_payment') => ({id:'test-one',stationId:'DEMO-001',stationName:'TEST · Demo station',pricing,status,createdAt:new Date().toISOString(),startedAt:status==='active'||status==='completed'?new Date().toISOString():null,totalAmount:status==='completed'?50000:0,depositPaid:['awaiting_pickup','active','completed','cancelled'].includes(status)?1000000:0,depositApplied:status==='completed'?50000:0,refundId:['completed','cancelled'].includes(status)?'refund-test':null,refundAmount:status==='completed'?950000:status==='cancelled'?1000000:0,settlementStatus:status==='completed'||status==='cancelled'?'settled':'deposit_held',testOnly:true});
async function harness({authenticated=true, state={rental:null,rentals:[]}}={}) {
  const elements = new Map(), requests = [], events = {}; let current = state;
  const user = authenticated ? {id:'customer',isTest:true,name:'Test customer'} : null;
  const context = vm.createContext({
    document:{body:new Element('body'), getElementById(id) { for (const node of elements.values()) { const found = flat(node).find(n => n.id === id); if (found) return found; } if (!elements.has(id)) elements.set(id,new Element()); return elements.get(id); },createElement:tag=>new Element(tag)},
    window:{addEventListener(name, fn){events[name]=fn;}},location:{pathname:'/',search:''},crypto:{randomUUID},Intl,Date,URLSearchParams,console,setTimeout,clearTimeout,
    fetch:async(path,options={})=> { requests.push({path,options}); let data = {};
      if(path==='/api/user/session') data={user,csrf:'csrf',readiness:{googleTest:{ready:true}}};
      if(path==='/api/user/test/state') data={...current,serverNow:new Date().toISOString()};
      if(path.endsWith('/quote')) data={quote:{id:'quote-one',pricing}};
      if(path.endsWith('/rent')) { current={rental:rental(),rentals:[rental()]};data={rental:current.rental}; }
      if(path.endsWith('/pay')) { const body=JSON.parse(options.body); current={rental:rental(body.outcome==='success'?'awaiting_pickup':'pending_payment'),rentals:[]};data={rental:current.rental}; }
      if(path.endsWith('/pickup')) { const body=JSON.parse(options.body); const next=rental(body.outcome==='success'?'active':'cancelled'); current={rental:body.outcome==='success'?next:null,rentals:[next]};data={rental:next}; }
      if(path.endsWith('/return')) { const completed=rental('completed');current={rental:null,rentals:[completed]};data={rental:completed}; }
      if(path.endsWith('/cancel')) {current={rental:null,rentals:[rental('cancelled')]};data={rental:current.rentals[0]};}
      return {ok:true,status:200,json:async()=>data};
    }
  });
  vm.runInContext(source,context); await new Promise(resolve=>setImmediate(resolve));
  return {run:code=>vm.runInContext(code,context),elements,requests,context,events};
}
test('TEST session restores original home and opens separate scan screen, rejecting non-demo codes', async()=>{
  const h=await harness();
  assert.ok(h.elements.get('account').hiddenClasses.has('hidden'));
  assert.ok(!h.elements.get('home-screen').hiddenClasses.has('hidden'));
  assert.ok(h.elements.get('rental-home').hiddenClasses.has('hidden'));
  h.run('startRental()');
  assert.ok(!h.elements.get('rental-home').hiddenClasses.has('hidden'));
  assert.match(text(h.elements.get('rental-flow')),/Mock scan · DEMO-001/);
  const count=h.requests.length;await h.run("requestQuote('REAL-001')");assert.equal(h.requests.length,count);assert.match(h.elements.get('notice').textContent,/Only the demo/);
});
test('quote, payment failure/retry, active rental and settlement render end to end',async()=>{
  const h=await harness();await h.run("requestQuote('DEMO-001')");
  assert.match(text(h.elements.get('rental-flow')),/500\.00/);assert.match(text(h.elements.get('rental-flow')),/3,000\.00/);assert.match(text(h.elements.get('rental-flow')),/one-hour minimum/);
  await h.run("transact('rent',{quoteId:quote.id})");assert.match(text(h.elements.get('rental-flow')),/Choose a test payment/);
  await h.run("transact('pay',{rentalId:testState.rental.id,outcome:'failure'})");assert.match(h.elements.get('notice').textContent,/failed/);assert.match(text(h.elements.get('rental-flow')),/retry/);
  await h.run("transact('pay',{rentalId:testState.rental.id,outcome:'success'})");assert.match(text(h.elements.get('rental-flow')),/Waiting for pickup/);assert.match(text(h.elements.get('rental-flow')),/clock has not started/);assert.equal(h.run('testState.rental.startedAt'),null);await h.run("transact('pickup',{rentalId:testState.rental.id,outcome:'success'})");assert.match(text(h.elements.get('rental-flow')),/You’re charging/);assert.match(text(h.elements.get('rental-flow')),/500\.00/);
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

test('original tabs switch single screens and retain active rental and quote state', async () => {
  const h = await harness();
  for (const [route, id] of [['stations','stations'],['history','member-area'],['profile','account'],['home','home-screen']]) {
    h.run(`navigate('${route}')`);
    assert.ok(!h.elements.get(id).hiddenClasses.has('hidden'));
    assert.equal(h.elements.get('mobile-' + route).attributes['aria-current'], 'page');
    assert.ok(h.elements.get('rental-home').hiddenClasses.has('hidden'));
  }
  await h.run("requestQuote('DEMO-001')");
  assert.equal(h.elements.get('home-scan-label').textContent, 'Continue rental');
  h.run("navigate('profile'); navigate('scan')");
  assert.match(text(h.elements.get('rental-flow')), /Review your rental/);
  assert.equal(h.elements.get('mobile-home').attributes['aria-current'], 'page');
  h.run('openSheet("Receipt")');
  assert.equal(h.elements.get('customer-shell').inert, true);
  h.run("navigate('history')");
  assert.equal(h.elements.get('customer-shell').inert, false);
  assert.equal(h.elements.get('sheet-root').children.length, 0);
});


test('deposit checkout exposes stored mock payment choice, nonzero deposit and pickup recovery', async () => {
  const h = await harness({state:{rental:rental(),rentals:[]}});
  const checkout = text(h.elements.get('rental-flow'));
  assert.match(checkout, /Pay test deposit/); assert.match(checkout, /10,000\.00/);
  assert.match(checkout, /Debit \/ credit card/); assert.match(checkout, /Google Pay/); assert.match(checkout, /Bank transfer/);
  const choices = flat(h.elements.get('rental-flow')).filter(n => n.attributes.role === 'radio');
  assert.equal(choices.length, 3); assert.ok(!flat(h.elements.get('rental-flow')).some(n => n.tagName === 'select'));
  const google = choices.find(n => text(n).includes('Google Pay')); google.events.click();
  assert.equal(google.attributes['aria-checked'], 'true');
  google.events.keydown({key:'ArrowRight',preventDefault(){}}); assert.equal(h.run('paymentMethod'), 'bank_transfer'); google.events.click();
  await flat(h.elements.get('rental-flow')).find(n => n.textContent?.startsWith('Pay test deposit')).events.click();
  assert.equal(JSON.parse(h.requests.find(r => r.path.endsWith('/pay')).options.body).paymentMethod, 'google_pay');
  assert.doesNotMatch(text(h.elements.get('rental-flow')), /Duration/);
  await h.run("transact('pickup',{rentalId:testState.rental.id,outcome:'failure'})");
  assert.match(text(h.elements.get('sheet-root')), /10,000\.00/);
  assert.match(text(h.elements.get('sheet-root')), /Refund completed/);
});
test('primary scan requests camera once; same hash is harmless and navigation stops stream', async () => {
  const h = await harness(); let requests=0, stops=0;
  h.context.navigator={mediaDevices:{getUserMedia:async()=>{requests++;return{getTracks:()=>[{stop(){stops++;}}]};}}};
  h.context.BarcodeDetector=class { async detect(){return [];} };
  await h.run('startRental()');
  assert.equal(requests,1); h.context.location.hash = '#scan'; h.events.hashchange(); assert.equal(stops, 0); assert.match(text(h.elements.get('sheet-root')), /Mock scan/); assert.match(text(h.elements.get('sheet-root')), /Station code/);
  h.run("navigate('history')"); assert.equal(stops,1); assert.equal(h.elements.get('sheet-root').children.length,0);
});
test('late camera grant after navigation is stopped, and existing rental never requests camera', async () => {
  const h=await harness();let resolve,stops=0;
  h.context.navigator={mediaDevices:{getUserMedia:()=>new Promise(r=>{resolve=r;})}};
  h.context.BarcodeDetector=class {};
  const pending=h.run('startRental()');h.run("navigate('profile')");
  resolve({getTracks:()=>[{stop(){stops++;}}]});await pending;assert.equal(stops,1);
  const active=await harness({state:{rental:rental('awaiting_pickup'),rentals:[]}});
  active.context.navigator={mediaDevices:{getUserMedia:()=>{throw new Error('must not request');}}};active.context.BarcodeDetector=class {};
  await active.run('startRental()');assert.match(text(active.elements.get('rental-flow')),/Waiting for pickup/);
});
