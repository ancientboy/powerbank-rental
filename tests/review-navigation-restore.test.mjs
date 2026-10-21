import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
// Independent controller/source regression checks. These are not rendered browser QA.
const source = readFileSync(new URL('../production-public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../production-public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../production-public/customer.css', import.meta.url), 'utf8');
const originalCSS = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const flat = node => [node, ...node.children.flatMap(flat)];
const text = node => flat(node).map(n => n.textContent || '').join(' ');
class Element {
  constructor(tag = 'div') { this.tagName=tag; this.children=[]; this.events={}; this.attributes={}; this.style={}; this.value=''; this.classes=new Set(); this.classList={add:n=>this.classes.add(n),remove:n=>this.classes.delete(n),toggle:(n,v)=>{if(v===undefined?!this.classes.has(n):v)this.classes.add(n);else this.classes.delete(n);}}; }
  append(...nodes){this.children.push(...nodes);} replaceChildren(...nodes){this.children=nodes;} setAttribute(k,v){this.attributes[k]=v;} addEventListener(k,v){this.events[k]=v;} focus(){} scrollIntoView(){} querySelector(tag){return flat(this).find(n=>n.tagName===tag);} querySelectorAll(){return flat(this).filter(n=>n.tagName==='button');}
}
const pricing={currency:'ARS',hourlyRate:10000,dailyCap:60000,deposit:0};
const rental=status=>({id:'r1',stationId:'DEMO-001',stationName:'Demo station',pricing,status,startedAt:new Date().toISOString(),createdAt:new Date().toISOString(),totalAmount:10000});
async function harness({authenticated=true,status=null,hash=''}={}) {
  const elements=new Map(),events={},requests=[]; let user=authenticated?{id:'test-user',name:'Test customer',isTest:true}:null;
  let current={rental:status?rental(status):null,rentals:status?[rental(status)]:[]};
  const location={pathname:'/',search:'',_hash:hash,get hash(){return this._hash;},set hash(v){this._hash=v.startsWith('#')?v:'#'+v;}};
  const context=vm.createContext({document:{body:new Element('body'),getElementById(id){for(const node of elements.values()){const found=flat(node).find(n=>n.id===id);if(found)return found;}if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},createElement:tag=>new Element(tag)},window:{addEventListener:(name,fn)=>{events[name]=fn;}},location,crypto:{randomUUID},Intl,Date,URLSearchParams,console,
    fetch:async(path,options={})=>{requests.push({path,options});let data={};
      if(path==='/api/user/session')data={user,csrf:'session-csrf',readiness:{googleTest:{ready:true}}};
      if(path==='/api/user/test-login-challenge')data={csrf:'challenge-csrf'};
      if(path==='/api/user/test-login')user={id:'test-user',name:'Test customer',isTest:true};
      if(path==='/api/user/test/state')data={...current,serverNow:new Date().toISOString()};
      if(path.endsWith('/stations'))data={stations:[{id:'DEMO-001',name:'Demo station',active:true,available:3}],pricing};
      if(path.endsWith('/quote'))data={quote:{id:'q1',pricing}};
      if(path.endsWith('/rent')){current={rental:rental('pending_payment'),rentals:[rental('pending_payment')]};data={rental:current.rental};}
      if(path.endsWith('/pay')){current={rental:rental(JSON.parse(options.body).outcome==='success'?'active':'pending_payment'),rentals:[]};data={rental:current.rental};}
      if(path.endsWith('/return')){current={rental:null,rentals:[rental('completed')]};data={rental:current.rentals[0]};}
      return{ok:true,status:200,json:async()=>data};}
  });vm.runInContext(source,context);await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
  return{elements,events,requests,location,run:code=>vm.runInContext(code,context),click:async id=>elements.get(id).events.click()};
}
const hidden=(h,id)=>h.elements.get(id).classes.has('hidden');
test('restores exact four original mobile tabs and original layout stylesheet',()=>{
  const mobile=html.split('aria-label="Mobile navigation"')[1];
  const labels=[...mobile.matchAll(/id="mobile-([^"]+)"[^>]*>[\s\S]*?<\/svg>([^<]+)<\/button>/g)].map(m=>[m[1],m[2]]);
  assert.deepEqual(labels,[['home','Rent'],['stations','Stations'],['history','Rentals'],['profile','Account']]);
  // Formal CSP disallows the legacy external font import; layout rules remain verbatim.
  assert.ok(css.startsWith(originalCSS.replace(/^@import[^\n]*\n/, '')));assert.match(html,/href="\/customer.css"/);assert.match(html,/Scan\.<br>Charge\.<br><span>Go\./);
  assert.match(css,/\.mobile-bottom\s*\{\s*display:\s*none/);assert.match(css,/@media\s*\(max-width:\s*580px\)/);
  assert.match(css,/\.mobile-bottom\s*\{\s*display:\s*flex;\s*position:\s*fixed;[\s\S]*?safe-area-inset-bottom/);assert.match(html,/viewport-fit=cover/);
});
test('all four nav buttons change only screens, preserve tab state, and never mutate',async()=>{
  const h=await harness();const count=h.requests.filter(r=>r.options.method==='POST').length;
  for(const[route,id]of[['home','home-screen'],['stations','stations'],['history','member-area'],['profile','account']]){
    await h.click('mobile-'+route);assert.equal(h.run('view'),route);assert.equal(h.location.hash,'#'+route);assert.equal(hidden(h,id),false);assert.equal(h.elements.get('mobile-'+route).attributes['aria-current'],'page');
    assert.equal(['home-screen','stations','member-area','account','rental-home','support-screen'].filter(id=>!hidden(h,id)).length,1);
  }assert.equal(h.requests.filter(r=>r.options.method==='POST').length,count);
});
test('scan intent survives test login using challenge CSRF, then enters scan',async()=>{
  const h=await harness({authenticated:false});await h.click('home-scan');assert.equal(h.run('view'),'profile');
  const login=flat(h.elements.get('account-content')).find(n=>n.textContent==='Continue with Google (test)');await login.events.click();
  assert.equal(h.run('view'),'scan');assert.equal(hidden(h,'rental-home'),false);assert.match(text(h.elements.get('rental-flow')),/Mock scan/);
  assert.equal(h.requests.find(r=>r.path==='/api/user/test-login').options.headers['X-CSRF-Token'],'challenge-csrf');
});
test('active rental survives navigation, explicit history reload and bare reload',async()=>{
  for(const hash of ['', '#scan','#history']){
    const h=await harness({status:'active',hash});assert.equal(h.run('view'),hash==='#history'?'history':'scan');
    for(const route of ['stations','history','profile','home']){await h.click('mobile-'+route);assert.equal(h.run('testState.rental.status'),'active');}
    await h.click('home-scan');assert.equal(h.run('view'),'scan');assert.match(text(h.elements.get('rental-flow')),/You’re charging/);
  }
});
test('back/forward hash navigation dismisses modal and never submits return',async()=>{
  const h=await harness({status:'active'});const count=h.requests.filter(r=>r.options.method==='POST').length;
  h.run('confirmReturn(testState.rental)');assert.equal(h.elements.get('customer-shell').inert,true);
  h.location.hash='#stations';h.events.popstate();h.events.hashchange();assert.equal(h.run('view'),'stations');assert.equal(h.elements.get('sheet-root').children.length,0);assert.equal(h.elements.get('customer-shell').inert,false);
  h.location.hash='#scan';h.events.popstate();h.events.hashchange();assert.equal(h.run('view'),'scan');assert.equal(h.elements.get('sheet-root').children.length,0);assert.equal(h.requests.filter(r=>r.options.method==='POST').length,count);
  h.run('confirmReturn(testState.rental)');await h.click('mobile-profile');assert.equal(h.elements.get('sheet-root').children.length,0);assert.equal(h.elements.get('customer-shell').inert,false);assert.equal(h.requests.filter(r=>r.options.method==='POST').length,count);
});
test('formal TEST quote/payment/return flow remains isolated after restored navigation',async()=>{
  const h=await harness();await h.run("requestQuote('DEMO-001')");assert.equal(h.run('view'),'scan');await h.run("transact('rent',{quoteId:quote.id})");await h.run("transact('pay',{rentalId:testState.rental.id,outcome:'success'})");
  await h.click('mobile-history');await h.click('home-scan');assert.equal(h.run('testState.rental.status'),'active');
  await h.run("transact('return',{rentalId:testState.rental.id})");assert.match(text(h.elements.get('sheet-root')),/Test rental receipt/);h.run('closeSheet()');await h.click('mobile-history');assert.match(text(h.elements.get('rentals')),/Returned · settled/);
  for(const r of h.requests.filter(r=>r.options.method==='POST')){assert.match(r.path,/^\/api\/user\/test\//);assert.equal(r.options.headers['X-CSRF-Token'],'session-csrf');assert.match(r.options.headers['Idempotency-Key'],/^[a-f0-9-]{36}$/);}
  assert.doesNotMatch(source+html,/\/v1\/|\/api\/admin|\/admin|Continue with Apple|Apple Pay|innerHTML|insertAdjacentHTML/);
});
