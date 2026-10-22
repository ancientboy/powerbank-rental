import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../production-public/admin.js', import.meta.url), 'utf8');
const flat = node => [node, ...node.children.flatMap(flat)];
const text = node => flat(node).map(n => n.textContent || '').join(' ');
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.events = {}; this.dataset = {}; this.attributes = {}; this.value = ''; this.classes = new Set(); this.classList = { add: n => this.classes.add(n), remove: n => this.classes.delete(n), toggle: (n, on) => on ? this.classes.add(n) : this.classes.delete(n) }; }
  append(...nodes) { this.children.push(...nodes); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(k,v) { this.attributes[k] = v; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(k,fn) { this.events[k] = fn; }
  querySelector(tag) { return flat(this).find(n => n !== this && n.tagName === tag); }
  focus() {}
  remove() {}
}
async function harness({ role = 'owner', data = {} } = {}) {
  const elements = new Map(), requests = [], redirects = [], events = {};
  const context = vm.createContext({ document: { getElementById(id) { for (const node of elements.values()) { const match = flat(node).find(n => n.id === id); if (match) return match; } if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, createElement: tag => new Element(tag) }, window: { addEventListener(k,fn) { events[k] = fn; } }, location: { pathname: '/admin/login', hash: '', replace(path) { redirects.push(path); } }, Intl, Date,
    FormData: class { constructor(form) { this.inputs = flat(form); } get(name) { return this.inputs.find(n => n.name === name)?.value ?? ''; } },
    fetch: async (path, options) => { requests.push({path,options}); return {ok:true,status:200,json:async()=>data}; }
  });
  vm.runInContext(source, context); context.fixture = data; context.role = role;
  vm.runInContext('session = { user: { role }, csrf: "csrf" }; data = fixture;', context);
  return { elements, requests, redirects, events, context, run: code => vm.runInContext(code, context), render(section) { context.next = section; vm.runInContext('navigate(next)', context); return elements.get('admin-panel'); } };
}
const submit = form => form.events.submit({preventDefault(){},currentTarget:form});
const set = (form, name, value) => { flat(form).find(n => n.name === name).value = value; };

test('order filters combine environment, status, UTC dates and customer search', async () => {
  const h = await harness({data:{users:[{id:'u1',email:'alice@example.com'}],rentals:[{id:'live1',userId:'u1',status:'active',createdAt:'2026-10-22T01:00:00Z'}],testRentals:[{id:'test1',status:'completed',createdAt:'2026-10-21T23:59:00Z'}]}});
  h.run("orderFilters = {q:'alice',mode:'live',status:'active',from:'2026-10-22',to:'2026-10-22'}");
  const output = text(h.render('orders')); assert.match(output,/1 matching orders/); assert.match(output,/live1/); assert.doesNotMatch(output,/test1/);
  assert.equal(flat(h.elements.get('admin-panel')).some(n=>n.tagName==='select'),false);
});
test('support history is immutable display and new replies start blank', async () => {
  const h = await harness({data:{support:[{id:'s1',status:'in_progress',rentalId:'r1',testOnly:true,reply:'Last answer',replies:[{reply:'First answer',createdAt:'2026-10-21T10:00:00Z',actorRole:'operator'},{reply:'Last answer',createdAt:'2026-10-22T10:00:00Z'}]}]}});
  const panel=h.render('support'); assert.match(text(panel),/First answer.*Last answer/); assert.equal(flat(panel).find(n=>n.name==='reply').value,''); assert.match(text(panel),/Related order: r1/);
});
test('context filters payments to selected order and correct environment', async () => {
  const h=await harness({data:{payments:[{id:'live-funds',rentalId:'r1'}],testPayments:[{id:'test-funds',rentalId:'r1'},{id:'unrelated',rentalId:'r2'}]}});
  h.run("openContext('payments',{rentalId:'r1',mode:'test'})"); const output=text(h.elements.get('admin-panel')); assert.match(output,/test-funds/); assert.doesNotMatch(output,/live-funds|unrelated/);
});
test('work queue includes only supplied records with explicit TEST labels',async()=>{
  const h=await harness({data:{workQueue:[{id:'q1',mode:'test',rentalId:'r1',reason:'Outstanding balance requires review',status:'open'}]}});
  const output=text(h.render('queue')); assert.match(output,/TEST/); assert.match(output,/Outstanding balance requires review/); assert.match(output,/Review order/); assert.doesNotMatch(output,/Refund now|Charge now/);
});
test('order detail renders separate states, unknown amounts and factual events',async()=>{
  const h=await harness(); h.context.fetch=async()=>({ok:true,status:200,json:async()=>({order:{id:'r1',userId:'u1',status:'active',pricing:{version:'v1'}},states:{rental:'active',payment:'deposit_held',device:'simulation_only'},timeline:[{type:'pickup_confirmed',at:'2026-10-22T10:00:00Z'}],support:[]})});
  h.run("openOrder('r1','test')"); await new Promise(resolve=>setImmediate(resolve));
  const output=text(h.elements.get('admin-panel')); assert.match(output,/Rental state.*active.*Financial state.*deposit_held.*Device state.*simulation_only/); assert.match(output,/pickup_confirmed/); assert.match(output,/Missing amounts are not treated as zero/);
});
test('audit details expose before and after, not invented missing snapshots',async()=>{
  const h=await harness({data:{audit:[{action:'pricing.update',before:{hourlyRate:100},after:{hourlyRate:200}},{action:'legacy'}]}}); const output=text(h.render('audit')); assert.match(output,/Before.*100.*After.*200/s); assert.match(output,/Not recorded/);
});

test('TEST lab shows inventory freshness, separate funds and annotation-only resolution', async()=>{
  const h=await harness(); h.context.lab={scenarios:['success'],cabinets:[{id:'cab-test',online:true,freshness:'stale',observedAt:'2026-10-21T00:00:00Z',ageSeconds:900,available:1,slots:[{slot:1,bankId:'bank-test',status:'available'}]}],payments:[{id:'payment-test',rentalId:'run-1',status:'succeeded',amount:10000}],refunds:[{id:'refund-test',rentalId:'run-1',status:'pending',amount:9000}],exceptions:[{id:'ex1',rentalId:'run-1',type:'refund_pending',status:'resolved',resolutionNote:'Reviewed with provider',resolvedAt:'2026-10-22T00:00:00Z'}]};
  h.run("renderLab($('admin-panel'),lab)"); const output=text(h.elements.get('admin-panel')); assert.match(output,/stale/); assert.match(output,/bank-test/); assert.match(output,/payment-test.*succeeded/); assert.match(output,/refund-test.*pending/); assert.match(output,/Underlying states are unchanged/);
});
test('TEST scenario submits once with idempotency header and role guard',async()=>{
  const h=await harness(); h.context.crypto={randomUUID:()=> 'test-idempotency-key'}; h.context.lab={scenarios:['success']}; h.run("renderLab($('admin-panel'),lab)"); const form=h.elements.get('admin-panel').children[0]; flat(form).find(n=>n.dataset.value==='success').events.click(); await submit(form); await submit(form);
  const writes=h.requests.filter(r=>r.options.method==='POST'); assert.equal(writes.length,1); assert.equal(writes[0].options.headers['Idempotency-Key'],'test-idempotency-key'); assert.equal(JSON.parse(writes[0].options.body).scenario,'success');
  const viewer=await harness({role:'viewer'}); viewer.context.lab={scenarios:['success']}; viewer.run("renderLab($('admin-panel'),lab)"); const readonly=viewer.elements.get('admin-panel').children[0]; flat(readonly).find(n=>n.dataset.value==='success').events.click(); await submit(readonly); assert.equal(viewer.requests.length,0);
});
test('customer-only conversation cannot be resolved without a support answer',async()=>{
  const h=await harness({data:{support:[{id:'s1',status:'open',replies:[{actorRole:'customer',reply:'More context'}]}]}}); const form=h.render('support').children[0]; for(const radio of flat(form).filter(n=>n.type==='radio')) radio.checked=radio.value==='resolved'; await submit(form); assert.equal(h.requests.length,0); assert.match(text(form),/Add a reply/);
});

test('TEST reconcile uses explicit query endpoint with idempotency and never resends eject',async()=>{
  const h=await harness(); h.context.crypto={randomUUID:()=> 'query-idempotency-key'}; h.context.lab={runs:[{id:'run-1',status:'active',operation:{status:'unknown'},events:[{type:'operation.unknown',occurredAt:'2026-10-22T00:00:00Z'}],queries:[]}]}; h.run("renderLab($('admin-panel'),lab)"); const query=flat(h.elements.get('admin-panel')).find(n=>n.dataset.editor==='integration-query-run-1'); await submit(query);
  const request=h.requests.find(r=>r.options.method==='POST'); assert.equal(request.path,'/api/admin/integrations/runs/run-1/reconcile'); assert.equal(request.options.headers['Idempotency-Key'],'query-idempotency-key'); assert.equal(request.options.body,'{}'); assert.ok(!h.requests.some(r=>r.path.includes('eject')));
});

test('TEST refund retry appears only after a query confirms failure',async()=>{
  for (const [refundStatus,queryStatus,visible] of [['failed','failed',true],['failed',undefined,false],['pending','failed',false],['unknown','unknown',false],['succeeded','succeeded',false]]) {
    const h=await harness(); h.context.lab={runs:[{id:'r1',refund:{status:refundStatus},queries:queryStatus?[{refundStatus:queryStatus}]:[]}]}; h.run("renderLab($('admin-panel'),lab)"); assert.equal(flat(h.elements.get('admin-panel')).some(n=>n.textContent==='Retry TEST refund'),visible);
  }
});
