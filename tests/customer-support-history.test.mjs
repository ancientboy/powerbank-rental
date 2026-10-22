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
async function harness({authenticated=true, state={rental:null,rentals:[]}, storage={}, pathname='/', search=''}={}) {
  const elements = new Map(), requests = [], events = {}; let current = state;
  const user = authenticated ? {id:'customer',isTest:true,name:'Test customer'} : null;
  const context = vm.createContext({
    document:{body:new Element('body'), getElementById(id) { for (const node of elements.values()) { const found = flat(node).find(n => n.id === id); if (found) return found; } if (!elements.has(id)) elements.set(id,new Element()); return elements.get(id); },createElement:tag=>new Element(tag)},
    window:{addEventListener(name, fn){events[name]=fn;}},location:{pathname,search},sessionStorage:{getItem:key=>storage[key] || null,setItem:(key,value)=>{storage[key]=value;},removeItem:key=>{delete storage[key];}},crypto:{randomUUID},Intl,Date,URLSearchParams,console,setTimeout,clearTimeout,
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

test('rental and receipt help link the selected order without sending or real actions', async () => {
  const h = await harness({state:{rental:null,rentals:[rental('completed')]}});
  const before = h.requests.length;
  const help = flat(h.elements.get('rentals')).find(n=>n.textContent==='Get help with rental');
  help.click(); assert.equal(h.run('supportRentalId'), 'test-one'); assert.equal(h.run('view'),'support');
  assert.match(text(h.elements.get('support-form')), /TEST rental reference: test-one/);
  assert.equal(h.requests.length, before);
  h.run("showReceipt(testState.rentals[0])");
  flat(h.elements.get('sheet-root')).find(n=>n.textContent==='Get help with rental').click();
  assert.equal(h.elements.get('sheet-root').children.length,0);
  flat(h.elements.get('support-form')).find(n=>n.textContent==='Clear rental link').click();
  assert.equal(h.run('supportRentalId'),null);
  assert.match(text(h.elements.get('support-form')), /General help/);
});

test('support retries include the order identity, preserve edits and reset key on link changes', async () => {
  const h=await harness(); const form=h.elements.get('support-form'); form.children.unshift(new Element('button'));
  const submit=()=>form.events.submit({preventDefault(){},currentTarget:form});
  h.run("supportForRental({id:'one'})"); h.elements.get('support-message').value='Please help with my order';
  const attempts=[]; h.context.fetch=async(path,options)=>{attempts.push({path,options});throw new Error('Offline');};
  await submit(); await submit(); assert.equal(attempts[0].options.headers['Idempotency-Key'],attempts[1].options.headers['Idempotency-Key']);
  assert.deepEqual(JSON.parse(attempts[0].options.body),{message:'Please help with my order',rentalId:'one'});
  h.run("supportForRental({id:'two'})"); await submit();
  assert.notEqual(attempts[2].options.headers['Idempotency-Key'],attempts[0].options.headers['Idempotency-Key']);
  assert.equal(JSON.parse(attempts[2].options.body).rentalId,'two');
  assert.ok(attempts.every(r=>r.path==='/api/user/support'));
});

test('session expiry and redirect recover draft and linked order only for the same owner and mode', async () => {
  const storage={};const h=await harness({storage});
  h.elements.get('support-message').value='My private question';h.run("supportForRental({id:'private-order'}); clearMemberState(true); session={...session,user:null}; account()");
  assert.equal(JSON.parse(storage['voltgo-support-draft']).rentalId,'private-order');
  const restored=await harness({storage});assert.equal(restored.run('supportRentalId'),'private-order');assert.equal(restored.elements.get('support-message').value,'My private question');
  restored.run("session={...session,user:{id:'different',isTest:true}}; account()");
  assert.equal(restored.run('supportRentalId'),null);assert.equal(restored.elements.get('support-message').value,'');assert.equal(storage['voltgo-support-draft'],undefined);
  h.run("session={...session,user:{id:'customer',isTest:false}}; account()");assert.equal(h.run('supportRentalId'),null);assert.equal(h.elements.get('support-message').value,'');
});

test('logout deletes recovery draft, while legacy and append-only reply history render safely', async () => {
  const storage={}; const h=await harness({storage});
  h.elements.get('support-message').value='Question to discard';h.run("supportForRental({id:'old'}); clearMemberState()");
  assert.equal(storage['voltgo-support-draft'],undefined);assert.equal(h.run('supportRentalId'),null);
  h.run(`renderSupportHistory([{status:'open',rentalId:'<order>',message:'<script>bad()</script>',reply:'Newest',replies:[{reply:'First reply',createdAt:'2026-10-20T12:00:00Z'},{reply:'Newest',createdAt:'2026-10-21T12:00:00Z'}]},{message:'Legacy question',reply:'Legacy reply'}])`);
  const content=text(h.elements.get('support-history'));assert.match(content,/First reply.*Newest.*Legacy reply/);assert.match(content,/<script>bad/);assert.match(content,/<order>/);
  assert.equal(flat(h.elements.get('support-history')).filter(n=>n.textContent==='Newest').length,1);
  assert.equal(flat(h.elements.get('support-history')).some(n=>n.tagName==='script'),false);
  assert.ok(flat(h.elements.get('support-history')).some(n=>n.textContent===new Date('2026-10-20T12:00:00Z').toLocaleString()));
});

test('generic help submits null rentalId and successful delivery clears linked draft', async () => {
  const storage={}; const h=await harness({storage}); const form=h.elements.get('support-form'); form.children.unshift(new Element('button'));
  const submit=()=>form.events.submit({preventDefault(){},currentTarget:form});
  h.elements.get('support-message').value='General help question'; await submit();
  assert.deepEqual(JSON.parse(h.requests.find(r=>r.path==='/api/user/support'&&r.options.method==='POST').options.body),{message:'General help question',rentalId:null});
  h.elements.get('support-message').value='Order help question'; h.run("supportForRental({id:'test-one'})"); await submit();
  assert.equal(h.run('supportRentalId'),null); assert.equal(h.elements.get('support-message').value,''); assert.equal(storage['voltgo-support-draft'],undefined);
});

test('stale and malformed stored drafts do not restore references or messages', async () => {
  for(const draft of ['{',JSON.stringify({owner:'test:customer',message:'old private question',rentalId:'old',at:Date.now()-31*60*1000})]){
    const h=await harness({storage:{'voltgo-support-draft':draft}});assert.equal(h.run('supportRentalId'),null);assert.equal(h.elements.get('support-message').value,'');
  }
});

test('same-owner session refresh after expiry retains draft but different owner cannot inherit it', async () => {
  const h=await harness();h.elements.get('support-message').value='Keep this question';
  h.run("supportForRental({id:'test-one'}); clearMemberState(true); session={...session,user:null,csrf:null}; account()");
  await h.run('refreshSession()');assert.equal(h.run('supportRentalId'),'test-one');assert.equal(h.elements.get('support-message').value,'Keep this question');
  h.context.fetch=async path=>({ok:true,status:200,json:async()=>path==='/api/user/session'?{user:{id:'other',isTest:true},csrf:'other'}:{}});
  await h.run('refreshSession()');assert.equal(h.run('supportRentalId'),null);assert.equal(h.elements.get('support-message').value,'');
});

test('inline follow-ups use existing case, reuse uncertain-send keys, and render customer/operator chronology', async () => {
  const h=await harness();
  const ticket={id:'case-one',rentalId:'test-one',message:'First question',replies:[{reply:'Operator response',actorRole:'admin',createdAt:'2026-10-20T12:00:00Z'},{reply:'Customer follow-up',actorRole:'customer',createdAt:'2026-10-21T12:00:00Z'}]};
  h.run(`renderSupportHistory(${JSON.stringify([ticket])})`);
  assert.match(text(h.elements.get('support-history')),/voltgo support Operator response.*You Customer follow-up/);
  flat(h.elements.get('support-history')).find(n=>n.textContent==='Reply to this case').click();
  let form=flat(h.elements.get('support-history')).find(n=>n.tagName==='form'), input=form.querySelector('textarea');
  input.value='Please check the refund again';input.events.input();
  const attempts=[];h.context.fetch=async(path,options)=>{attempts.push({path,options});throw new Error('Offline');};
  await form.events.submit({preventDefault(){},currentTarget:form});
  h.run(`renderSupportHistory(${JSON.stringify([ticket])})`);
  form=flat(h.elements.get('support-history')).find(n=>n.tagName==='form');
  await form.events.submit({preventDefault(){},currentTarget:form});
  assert.equal(attempts[0].path,'/api/user/support/reply');
  assert.deepEqual(JSON.parse(attempts[0].options.body),{id:'case-one',message:'Please check the refund again'});
  assert.equal(attempts[0].options.headers['Idempotency-Key'],attempts[1].options.headers['Idempotency-Key']);
  assert.equal(h.run('supportTicketId'),'case-one');
  flat(h.elements.get('support-form')).find(n=>n.textContent==='Start a new support case').click();
  assert.equal(h.run('supportTicketId'),null);
});

test('follow-up intent restores for same owner and clears for another owner', async () => {
  const storage={};const h=await harness({storage});
  h.run("renderSupportHistory([{id:'case-one',rentalId:'test-one',message:'First question'}])");
  flat(h.elements.get('support-history')).find(n=>n.textContent==='Reply to this case').click();
  const input=flat(h.elements.get('support-history')).find(n=>n.tagName==='textarea');input.value='My private follow-up';input.events.input();
  h.run('clearMemberState(true)');
  const restored=await harness({storage}); assert.equal(restored.run('supportTicketId'),'case-one');assert.equal(restored.elements.get('support-message').value,'My private follow-up');
  restored.run("session={...session,user:{id:'other',isTest:true}}; account()");
  assert.equal(restored.run('supportTicketId'),null);assert.equal(restored.elements.get('support-message').value,'');
});
