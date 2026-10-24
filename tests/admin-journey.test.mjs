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

test('station validates whitespace, paired coordinates and cabinet length before saving', async () => {
  const h = await harness(); h.render('stations'); h.run('stationEditor()'); const form = h.elements.get('admin-panel').children[0];
  set(form,'name','  '); set(form,'address','Address'); await submit(form); assert.equal(h.requests.length,0); assert.match(text(form),/name and address/);
  set(form,'name','Station'); set(form,'latitude','12'); await submit(form); assert.match(text(form),/both valid latitude/); assert.equal(h.requests.length,0);
  set(form,'longitude','13'); set(form,'cabinetId','a'.repeat(81)); await submit(form); assert.equal(h.requests.length,0); assert.match(text(form),/80 characters/);
});

test('pricing validates exact cents and daily cap and explains test price separation', async () => {
  const h = await harness({data:{pricing:{hourlyRate:100,dailyCap:200,deposit:500,version:'p1'}}}); const form = h.render('pricing').children[0];
  assert.match(text(form),/Existing orders keep their agreed rules/);
  set(form,'hourlyRate','1.001'); await submit(form); assert.equal(h.requests.length,0);
  set(form,'hourlyRate','3'); await submit(form); assert.equal(h.requests.length,0); assert.match(text(form),/at least one hour/);
  set(form,'dailyCap','4'); await submit(form); const payload = JSON.parse(h.requests[0].options.body); assert.equal(payload.expectedVersion,'p1'); assert.equal(payload.hourlyRate,300);
});

test('runtime role guard prevents direct pricing and support submits', async () => {
  for (const role of ['viewer','operator']) { const h = await harness({role, data:{pricing:{hourlyRate:100,dailyCap:200,deposit:500}}}); await submit(h.render('pricing').children[0]); assert.equal(h.requests.length,0); }
  const h = await harness({role:'viewer',data:{support:[{id:'t1',status:'open',reply:'answer'}]}}); await submit(h.render('support').children[0]); assert.equal(h.requests.length,0);
});

test('support resolution requires reply and preserves optimistic version', async () => {
  const h = await harness({data:{support:[{id:'t1',status:'open',updatedAt:'v1'}]}}); const form = h.render('support').children[0];
  const resolved = flat(form).find(n=>n.type==='radio'&&n.value==='resolved'); for (const radio of flat(form).filter(n=>n.type==='radio')) radio.checked=false; resolved.checked=true; resolved.events.change();
  await submit(form); assert.equal(h.requests.length,0); assert.match(text(form),/Add a reply/);
  set(form,'reply','Resolved with details'); await submit(form); assert.equal(JSON.parse(h.requests[0].options.body).expectedUpdatedAt,'v1');
});

test('confirmed save survives failed refresh and cannot be submitted twice', async () => {
  const h = await harness({data:{pricing:{hourlyRate:100,dailyCap:200,deposit:500}}}); const form = h.render('pricing').children[0];
  h.context.fetch = async(path,options) => { h.requests.push({path,options}); if(path.endsWith('/dashboard')) throw new Error('offline'); return {ok:true,status:200,json:async()=>({})}; };
  await submit(form); assert.match(h.elements.get('admin-notice').textContent,/Pricing saved.*Refresh failed.*Do not submit again/); assert.equal(form.dataset.saved,'true');
  await submit(form); assert.equal(h.requests.filter(r=>r.options.method==='POST').length,1);
});

test('repeated submit while pending sends once and refuses section changes', async () => {
  const h = await harness({data:{pricing:{hourlyRate:100,dailyCap:200,deposit:500}}}); const form = h.render('pricing').children[0]; let finish;
  h.context.fetch = async(path,options) => { h.requests.push({path,options}); if(options.method==='POST') await new Promise(resolve=>finish=resolve); return {ok:true,status:200,json:async()=>({})}; };
  const first=submit(form); await submit(form); h.render('orders'); assert.equal(h.run('section'),'pricing'); assert.equal(h.requests.length,1); finish(); await first;
});

test('dirty edits stay until explicitly discarded and refresh errors keep last snapshot', async () => {
  const h = await harness({data:{pricing:{hourlyRate:100,dailyCap:200,deposit:500}}}); const form=h.render('pricing').children[0]; form.events.input(); h.render('orders'); assert.equal(h.run('section'),'pricing');
  flat(h.elements.get('admin-notice')).find(n=>n.textContent==='Discard changes').events.click(); assert.equal(h.run('section'),'orders');
  h.run('hasLoaded = true'); h.context.fetch=async()=>{throw new Error('offline');}; await assert.rejects(h.run('load()')); assert.match(h.elements.get('admin-notice').textContent,/outdated/);
});

test('first load failure remains unavailable on navigation, expiry clears private data', async () => {
  const h = await harness(); h.context.fetch=async()=>{throw new Error('offline');}; await assert.rejects(h.run('load()')); assert.match(text(h.render('stations')),/Dashboard unavailable/); assert.doesNotMatch(text(h.render('dashboard')),/No records yet/);
  h.context.fetch=async()=>({ok:false,status:401,json:async()=>({})}); await assert.rejects(h.run("api('/api/admin/dashboard')")); assert.deepEqual(h.redirects,['/admin/login']); assert.equal(h.run('Object.keys(data).length'),0); assert.ok(h.elements.get('admin-view').classes.has('hidden'));
});

test('order review exposes refund, outstanding balance and live estimates', async()=>{
  const h=await harness({data:{testRentals:[{id:'t1',status:'active',depositPaid:10000,totalAmount:100,refundAmount:0,outstandingAmount:0,settlementStatus:'deposit_held'}]}});
  const output=text(h.render('orders')); assert.match(output,/Rental fee \/ active estimate/); assert.match(output,/Outstanding/); assert.match(output,/Refund record/); assert.match(output,/not automatic charging/);
});


test('unknown write outcome blocks retry until records are refreshed', async () => {
  for (const failure of ['network', 'server']) {
    const h=await harness({data:{pricing:{hourlyRate:100,dailyCap:200,deposit:500}}}); const form=h.render('pricing').children[0];
    h.context.fetch=async(path,options)=>{h.requests.push({path,options});if(failure==='network') throw new Error('lost response');return {ok:false,status:500,json:async()=>({error:'Server error'})};};
    await submit(form); assert.equal(form.dataset.saved,'unknown'); assert.match(text(form),/outcome unknown/); await submit(form); assert.equal(h.requests.length,1);
  }
});

test('saving one support ticket preserves other drafts and their original version', async () => {
  const initial={support:[{id:'one',status:'open',reply:'',updatedAt:'v1'},{id:'two',status:'open',reply:'',updatedAt:'v1'}]};
  const h=await harness({data:initial}); const panel=h.render('support'); const first=panel.children[0], second=panel.children[1];
  set(first,'reply','First reply'); first.events.input(); set(second,'reply','Unsaved second reply'); second.events.input();
  h.context.fetch=async(path,options)=>{h.requests.push({path,options});return {ok:true,status:200,json:async()=>path.endsWith('/dashboard')?{support:[{...initial.support[0],reply:'First reply',updatedAt:'v2'},{...initial.support[1],updatedAt:'v2'}]}:{}};};
  await submit(first); const restored=h.elements.get('admin-panel').children[1]; assert.equal(flat(restored).find(n=>n.name==='reply').value,'Unsaved second reply'); assert.equal(restored.dataset.expectedUpdatedAt,'v1'); assert.equal(h.run('dirtyForms.size'),1);
});

test('buyout settings share pricing form, validate caps and days, and submit cents plus whole days',async()=>{
 const h=await harness({data:{hardwarePricing:{hourlyRate:50000,dailyCap:300000,deposit:1000000,totalCap:1000000,maxRentalDays:0}}});const form=h.render('pricing').children[0];assert.match(text(form),/Buyout after days/);
 set(form,'maxRentalDays','1.5');await submit(form);assert.equal(h.requests.length,0);
 set(form,'maxRentalDays','3');set(form,'totalCap','20000');await submit(form);assert.equal(h.requests.length,0);
 set(form,'totalCap','10000');await submit(form);const p=JSON.parse(h.requests[0].options.body);assert.equal(p.maxRentalDays,3);assert.equal(p.totalCap,1000000);assert.equal(p.expectedVersion,null);
});

test('explicit close and reopen preserve optimistic version without requiring a public reply',async()=>{
 for(const [status,label,next] of [['open','Close ticket','closed'],['closed','Reopen ticket','open']]){
  const h=await harness({data:{support:[{id:'case',status,updatedAt:'v1',replies:[]}]}});const form=h.render('support').children[0];
  await flat(form).find(n=>n.textContent===label).events.click();
  assert.deepEqual(JSON.parse(h.requests[0].options.body),{id:'case',status:next,reply:'',expectedUpdatedAt:'v1'});
 }
});
test('closing never silently sends or discards a draft and viewer cannot close',async()=>{
 const h=await harness({data:{support:[{id:'case',status:'open'}]}});const form=h.render('support').children[0];set(form,'reply','Unfinished reply');
 await flat(form).find(n=>n.textContent==='Close ticket').events.click();assert.equal(h.requests.length,0);assert.match(text(form),/Send or clear your draft/);
 const v=await harness({role:'viewer',data:{support:[{id:'case',status:'open'}]}});const button=flat(v.render('support')).find(n=>n.textContent==='Close ticket');assert.equal(button.disabled,true);await button.events.click();assert.equal(v.requests.length,0);
});

test('station editor previews coordinates and saves entrance notes with selected unassigned cabinet',async()=>{
 const h=await harness({data:{stations:[{id:'other',cabinetId:'TAKEN'}],deviceCabinets:[{cabinetId:'TAKEN'},{cabinetId:'FREE'}]}});h.render('stations');h.run('stationEditor()');const form=h.elements.get('admin-panel').children[0];
 assert.equal(flat(form).filter(n=>n.tagName==='button'&&n.textContent==='TAKEN').length,0);
 await flat(form).find(n=>n.tagName==='button'&&n.textContent==='FREE').events.click();
 assert.equal(flat(form).find(n=>n.name==='cabinetId').value,'FREE');
 set(form,'name','Store');set(form,'address','Street');set(form,'latitude','-34.6037');set(form,'longitude','-58.3816');set(form,'locationNotes','Floor 1');
 flat(form).find(n=>n.className==='form-grid').events.input();
 assert.ok(flat(form).some(n=>n.href==='https://www.google.com/maps/search/?api=1&query=-34.6037%2C-58.3816'));
 await submit(form);const saved=JSON.parse(h.requests.find(x=>x.path==='/api/admin/stations').options.body);assert.equal(saved.cabinetId,'FREE');assert.equal(saved.locationNotes,'Floor 1');assert.equal(saved.latitude,-34.6037);
});

test('Stations automatically presents one QR per bound/configured cabinet, with downloads and print; no writes on render', async()=>{
 const h=await harness({role:'viewer',data:{stations:[{id:'s1',name:'Store',cabinetId:'BOUND'},{id:'s2',name:'New store',cabinetId:'NEW'}],deviceCabinets:[{cabinetId:'BOUND'},{cabinetId:'UNBOUND'}]}});
 const panel=h.render('stations');const nodes=flat(panel);const images=nodes.filter(n=>n.tagName==='img'&&n.src?.includes('/api/admin/cabinet-qr'));
 assert.equal(images.length,3);assert.match(text(panel),/Device connection still needs/);
 for(const id of ['BOUND','NEW','UNBOUND']){
  assert.ok(nodes.some(n=>n.href===`/api/admin/cabinet-qr?cabinet=${id}&format=png&download=1`));
  assert.ok(nodes.some(n=>n.href===`/api/admin/cabinet-qr?cabinet=${id}&format=svg&download=1`));
  assert.ok(nodes.some(n=>n.href===`/admin/cabinet-label?cabinet=${id}`&&n.rel==='noopener'));
 }
 assert.equal(h.requests.filter(r=>r.options?.method==='POST').length,0);
 images[0].events.error();assert.equal(images[0].hidden,true);assert.match(text(panel),/QR unavailable/);
});
test('empty station list explains binding, invalid legacy IDs have no broken QR image', async()=>{
 const empty=await harness();assert.match(text(empty.render('stations')),/Bind a cabinet ID/);
 const legacy=await harness({data:{stations:[{cabinetId:'old invalid',name:'Legacy'}]}});
 const panel=legacy.render('stations');assert.match(text(panel),/Update this cabinet ID/);assert.equal(flat(panel).filter(n=>n.tagName==='img'&&n.src?.includes('/cabinet-qr')).length,0);
});
