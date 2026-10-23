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

test('WSCharge configuration stays distinct from TEST and never claims live readiness', async()=>{
  const h=await harness(); h.context.snapshot={enabled:true,configured:true,dispatchEnabled:true,serverNow:'2026-10-23T00:00:00Z',token:'SECRET-MUST-NOT-RENDER',rawPayload:'RAW-MUST-NOT-RENDER'};
  h.run("renderWscharge($('admin-panel'),snapshot)"); const output=text(h.elements.get('admin-panel'));
  assert.match(output,/supplier verification still required/); assert.match(output,/\/api\/integrations\/wscharge\/notify/); assert.match(output,/not a confirmed public URL/); assert.match(output,/Disabled · observation only/); assert.doesNotMatch(output,/SECRET-MUST-NOT-RENDER|RAW-MUST-NOT-RENDER/);
  assert.equal(flat(h.elements.get('admin-panel')).some(n=>n.tagName==='button'||n.tagName==='form'),false);
});
test('WSCharge inventory and command acceptance cannot imply rental availability or pickup',async()=>{
  const h=await harness(); h.context.snapshot={inventory:[{cabinetId:'cab-1',observedAtSeconds:1792713600,stale:true,available:42,banks:[{slot:1,bankId:'bank-1',batteryPercent:90,statusCode:1}]}],commands:[{id:'cmd-1',cabinetId:'cab-1',code:65,status:'accepted',physicalPickupConfirmed:false}],events:[{cabinetId:'cab-1',code:66,disposition:'observation_only',freshness:'outside_window'}]};
  h.run("renderWscharge($('admin-panel'),snapshot)"); const output=text(h.elements.get('admin-panel')); assert.match(output,/Stale/); assert.match(output,/Rentable availability Unknown/); assert.match(output,/bank-1/); assert.match(output,/accepted.*Not confirmed/); assert.match(output,/outside_window/); assert.doesNotMatch(output,/42/);
});
test('WSCharge refresh is read-only, de-duplicates clicks, and preserves existing drafts',async()=>{
  const h=await harness({role:'viewer'}); let complete;
  h.context.fetch=async(path,options)=>{h.requests.push({path,options}); if(path==='/api/admin/wscharge') return new Promise(resolve=>{complete=()=>resolve({ok:true,status:200,json:async()=>({configured:false})});}); return {ok:true,status:200,json:async()=>({})};};
  const panel=h.render('integrations'); const refresh=flat(panel).find(n=>n.textContent==='Refresh gateway records'); refresh.events.click(); assert.equal(h.requests.filter(r=>r.path==='/api/admin/wscharge').length,1);
  h.run("dirtyForms.add({draft:'retain'})"); complete(); await new Promise(resolve=>setImmediate(resolve)); assert.equal(h.run('dirtyForms.size'),1); assert.match(text(panel),/Incomplete or disabled/); assert.ok(h.requests.every(r=>!r.options.method || r.options.method==='GET'));
});
test('late WSCharge responses cannot repopulate a newer page',async()=>{
  const h=await harness(); let complete;
  h.context.fetch=async(path)=>path==='/api/admin/wscharge'?new Promise(resolve=>{complete=()=>resolve({ok:true,status:200,json:async()=>({inventory:[{cabinetId:'late-cabinet'}]})});}):({ok:true,status:200,json:async()=>({})});
  h.render('integrations'); const before=h.elements.get('admin-panel').children.find(n=>text(n).includes('WSCharge gateway · read-only')); h.render('stations'); complete(); await new Promise(resolve=>setImmediate(resolve));
  assert.doesNotMatch(text(h.elements.get('admin-panel')),/late-cabinet/); assert.doesNotMatch(text(before),/late-cabinet/);
});
test('gateway failure keeps TEST lab and independent retry available',async()=>{
  const h=await harness(); h.context.fetch=async(path)=>{if(path==='/api/admin/wscharge') throw new Error('offline'); return {ok:true,status:200,json:async()=>({scenarios:[]})};};
  const panel=h.render('integrations'); await new Promise(resolve=>setImmediate(resolve)); assert.match(text(panel),/Gateway records unavailable/); assert.match(text(panel),/TEST integration lab/); const refresh=flat(panel).find(n=>n.textContent==='Refresh gateway records'); assert.equal(refresh.disabled,false);
});
