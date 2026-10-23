import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openProductionStore } from '../src/production-store.mjs';
import { createProductionAPI } from '../src/production-api.mjs';
import { loadConfig } from '../src/production-config.mjs';
const origin = 'https://review-rental.example';
const prefix = '/api/user/test/';
const cookies = r => r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
function fixture(path = ':memory:') {
  let time = Date.now(), db = openProductionStore(path);
  const config = loadConfig({ PUBLIC_ORIGIN: origin, ENABLE_GOOGLE_TEST_LOGIN: '1' });
  let api = createProductionAPI({ db, config, now: () => time });
  const call = (path, client = {}, body, key = randomUUID(), extraHeaders = {}) => api(new Request(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: client.cookies || '', origin, 'content-type': 'application/json', 'x-csrf-token': client.csrf || '', 'idempotency-key': key, ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const ok = async (path, client, body, key) => { const r = await call(path, client, body, key); const result = await r.json(); assert.equal(r.status, 200, JSON.stringify(result)); return result; };
  return { get db() { return db; }, config, call, ok, advance(ms) { time += ms; }, reopen() { db.close(); db = openProductionStore(path); api = createProductionAPI({ db, config, now: () => time }); }, close() { db.close(); } };
}
async function login(f) {
  const challenge = await f.call('/api/user/test-login-challenge');
  const browser = cookies(challenge), { csrf } = await challenge.json();
  const result = await f.call('/api/user/test-login', { cookies: browser, csrf }, {});
  assert.equal(result.status, 200);
  const client = { cookies: browser + '; ' + cookies(result) };
  Object.assign(client, await f.ok('/api/user/session', client));
  return client;
}
async function rent(f, a) {
  const { quote } = await f.ok(prefix + 'quote', a, { stationId: 'DEMO-001' });
  return (await f.ok(prefix + 'rent', a, { quoteId: quote.id })).rental;
}
const payments = f => f.db.prepare("SELECT data FROM test_records WHERE kind='payment'").all().map(r => JSON.parse(r.data));
const success = (f, a, action, id) => f.ok(prefix + action, a, { rentalId: id, outcome: 'success' });
test('deposit QA: positive deposit does not start time; only pickup starts fee, return balances deposit and refund', async () => {
  const f = fixture(); try {
    const a = await login(f), r = await rent(f, a);
    assert.equal(r.pricing.deposit, 1000000); assert.equal(r.pricing.hourlyRate, 50000); assert.equal(r.pricing.dailyCap, 300000);
    const paid = await success(f, a, 'pay', r.id);
    assert.equal(paid.rental.status, 'awaiting_pickup'); assert.equal(paid.rental.startedAt, null); assert.equal(paid.rental.totalAmount, 0);
    assert.equal(paid.payment.amount, r.pricing.deposit); assert.equal(paid.payment.provider, 'mock'); assert.equal(paid.rental.depositPaid, r.pricing.deposit);
    f.advance(2 * 3600000);
    let state = (await f.ok(prefix + 'state', a)).rental;
    assert.equal(state.startedAt, null); assert.equal(state.durationSeconds, 0); assert.equal(state.totalAmount, 0);
    assert.equal((await f.call(prefix + 'return', a, {rentalId:r.id})).status, 409);
    const q = await f.ok(prefix + 'quote', a, {stationId:'DEMO-001'});
    assert.equal((await f.call(prefix + 'rent', a, {quoteId:q.quote.id})).status, 409);
    const picked = await success(f,a,'pickup',r.id);
    assert.equal(picked.rental.status,'active'); assert.equal(picked.rental.durationSeconds,0); assert.equal(picked.rental.totalAmount,50000);
    f.advance(3600001);
    const receipt = await f.ok(prefix + 'return',a,{rentalId:r.id,totalAmount:1,refundAmount:100000000});
    assert.equal(receipt.rental.totalAmount,100000); assert.equal(receipt.rental.refundAmount,900000);
    assert.equal(receipt.rental.depositApplied + receipt.rental.refundAmount, receipt.rental.depositPaid);
    assert.equal(receipt.rental.depositApplied + receipt.rental.outstandingAmount,receipt.rental.totalAmount);
    assert.equal(receipt.rental.outstandingAmount,0);
    const count = payments(f).length;
    assert.deepEqual((await f.ok(prefix+'return',a,{rentalId:r.id})).rental,receipt.rental);
    assert.equal(payments(f).length,count);
  } finally { f.close(); }
});
test('deposit QA: failure/cancel before pickup refund fully exactly once, payment failures never fabricate deposit', async () => {
  const f=fixture();try {
    const a=await login(f);
    for (const action of ['cancel','pickup']) {
      const r=await rent(f,a);
      const failed=await f.ok(prefix+'pay',a,{rentalId:r.id,outcome:'failure'});
      assert.equal(failed.rental.status,'pending_payment');assert.equal(failed.rental.depositPaid,0);
      await success(f,a,'pay',r.id);
      const body={rentalId:r.id,...(action==='pickup'?{outcome:'failure'}:{})};
      const [x,y]=await Promise.all([f.ok(prefix+action,a,body),f.ok(prefix+action,a,body)]);
      assert.equal(x.rental.status,'cancelled');assert.equal(x.rental.startedAt,null);assert.equal(x.rental.totalAmount,0);
      assert.equal(x.rental.refundAmount,x.rental.depositPaid);assert.equal(x.rental.refundId,y.rental.refundId);
      const refunds=payments(f).filter(p=>p.rentalId===r.id&&p.type==='refund');assert.equal(refunds.length,1);assert.equal(refunds[0].amount,1000000);
    }
    const r=await rent(f,a);await f.ok(prefix+'cancel',a,{rentalId:r.id});
    assert.equal(payments(f).filter(p=>p.rentalId===r.id).length,0);
  }finally{f.close();}
});
test('deposit QA: concurrent distinct keys cannot double-charge, double-pickup or double-refund',async()=>{
  const f=fixture();try {
    const a=await login(f),r=await rent(f,a);
    const paid=await Promise.all(Array.from({length:8},()=>success(f,a,'pay',r.id)));
    assert.equal(new Set(paid.map(x=>x.payment.id)).size,1);assert.equal(payments(f).length,1);
    const picked=await Promise.all(Array.from({length:8},()=>success(f,a,'pickup',r.id)));
    assert.equal(new Set(picked.map(x=>x.rental.startedAt)).size,1);
    const returned=await Promise.all(Array.from({length:8},()=>f.ok(prefix+'return',a,{rentalId:r.id})));
    assert.equal(new Set(returned.map(x=>x.rental.refundId)).size,1);
    assert.equal(payments(f).filter(p=>p.type==='refund').length,1);
    assert.equal(payments(f).filter(p=>p.id===paid[0].payment.id).length,1);
    const lateFailure = await f.ok(prefix+'pickup',a,{rentalId:r.id,outcome:'failure'}); assert.deepEqual(lateFailure.rental,returned[0].rental); assert.equal(payments(f).filter(p=>p.type==='refund').length,1);
  }finally{f.close();}
});
test('deposit QA: pickup and refund endpoints preserve owner, CSRF, origin and test-account gates',async()=>{
  const f=fixture();try {
    const a=await login(f),b=await login(f),r=await rent(f,a);await success(f,a,'pay',r.id);
    for(const action of ['pickup','cancel','return']) {
      const body={rentalId:r.id,outcome:'success'};
      assert.equal((await f.call(prefix+action,b,body)).status,404);
      assert.equal((await f.call(prefix+action,{...a,csrf:'wrong'},body)).status,403);
      assert.equal((await f.call(prefix+action,a,body,randomUUID(),{origin:'https://evil.example'})).status,403);
      assert.equal((await f.call(prefix+action,{},body)).status,401);
    }
    assert.equal(payments(f).length,1);assert.equal((await f.ok(prefix+'state',a)).rental.status,'awaiting_pickup');
    const token='z'.repeat(43);f.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run('real','sub-real','r@example.test','Real',new Date().toISOString());
    f.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(createHash('sha256').update(token).digest('hex'),'user','real','real-csrf',Date.now()+86400000);
    assert.equal((await f.call(prefix+'pickup',{cookies:'voltgo_user='+token,csrf:'real-csrf'},{rentalId:r.id,outcome:'success'})).status,403);
    f.config.enableGoogleTestLogin=false;assert.equal((await f.call(prefix+'pickup',a,{rentalId:r.id,outcome:'success'})).status,401);
  }finally{f.close();}
});
test('deposit QA: fee exceeding deposit is flagged without an invented supplemental charge',async()=>{
  const f=fixture();try {
    const a=await login(f),r=await rent(f,a);await success(f,a,'pay',r.id);await success(f,a,'pickup',r.id);
    f.advance(96*3600000);f.db.prepare('UPDATE sessions SET expires=expires+?').run(100*3600000);
    const receipt=await f.ok(prefix+'return',a,{rentalId:r.id});
    assert.equal(receipt.rental.totalAmount,1200000);assert.equal(receipt.rental.depositApplied,1000000);assert.equal(receipt.rental.refundAmount,0);assert.equal(receipt.rental.outstandingAmount,200000);assert.equal(receipt.rental.settlementStatus,'review_required');
    assert.equal(receipt.payment.amount,1000000);assert.equal(receipt.payment.feeAmount,1200000);assert.equal(receipt.payment.source,'deposit');assert.equal(payments(f).length,2);
  }finally{f.close();}
});
test('deposit QA: schema 3 upgrade preserves rows byte-for-byte; legacy zero-deposit records never gain money',async()=>{
  const {DatabaseSync}=await import('node:sqlite');
  const dir=mkdtempSync(join(tmpdir(),'deposit-migration-')), path=join(dir,'old.sqlite');
  let old=new DatabaseSync(path);
  old.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES(1,'old'),(2,'old'),(3,'old');
    CREATE TABLE test_users(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL);
    INSERT INTO test_users VALUES('old-user','Original','2026-10-20');
    CREATE TABLE test_rentals(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES test_users(id),status TEXT NOT NULL CHECK(status IN ('pending_payment','active','completed','cancelled')),quote_id TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
    CREATE UNIQUE INDEX test_one_open_rental ON test_rentals(owner_id) WHERE status IN ('pending_payment','active');
    CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,owner_id TEXT,data TEXT NOT NULL,PRIMARY KEY(kind,id));
    INSERT INTO records VALUES('payment','real-payment','real-user','{"amount":123456,"provider":"real"}');
    CREATE TABLE test_records(kind TEXT NOT NULL,id TEXT NOT NULL,owner_id TEXT NOT NULL REFERENCES test_users(id),data TEXT NOT NULL,PRIMARY KEY(kind,id));
    INSERT INTO test_records VALUES('payment','old-auth','old-user','{"id":"old-auth","amount":0,"type":"authorization"}');`);
  const legacy={id:'old-rental',userId:'old-user',quoteId:'old-quote',status:'active',pricing:{currency:'ARS',hourlyRate:10000,dailyCap:60000,deposit:0,version:'test-v1'},startedAt:new Date().toISOString(),authorizationId:'old-auth',totalAmount:0,testOnly:true};
  const historical={...legacy,id:'history',quoteId:'history-quote',status:'completed',totalAmount:10000};
  for(const r of [legacy,historical])old.prepare('INSERT INTO test_rentals VALUES(?,?,?,?,?)').run(r.id,'old-user',r.status,r.quoteId,JSON.stringify(r));
  const rows=old.prepare('SELECT * FROM test_rentals ORDER BY id').all();old.close();
  const f=fixture(path);try {
    assert.equal(f.db.prepare('SELECT max(version) n FROM schema_migrations').get().n,4);
    assert.deepEqual(f.db.prepare('SELECT * FROM test_rentals ORDER BY id').all(),rows);
    assert.equal(f.db.prepare("SELECT data FROM records WHERE id='real-payment'").get().data,'{"amount":123456,"provider":"real"}');
    assert.equal(f.db.prepare("SELECT data FROM test_records WHERE id='old-auth'").get().data,'{"id":"old-auth","amount":0,"type":"authorization"}');
    const a=await login(f);f.db.prepare('UPDATE sessions SET subject=? WHERE subject=?').run('old-user',a.user.id);
    const state=await f.ok(prefix+'state',a);assert.equal(state.rental.legacy,true);assert.equal(state.rentals.find(r=>r.id==='history').totalAmount,10000);
    const returned=await f.ok(prefix+'return',a,{rentalId:'old-rental'});
    assert.equal(returned.rental.refundAmount,0);assert.equal(returned.rental.depositPaid||0,0);assert.equal(returned.rental.depositApplied,0);assert.equal(returned.rental.settlementStatus,'legacy_review');assert.equal(returned.payment.amount,0);
    assert.equal(payments(f).filter(p=>p.type==='refund'||p.type==='deposit').length,0);
    // Old pending rentals must be canceled and requoted, never silently charged at a new price.
    const pending={...legacy,id:'old-pending',quoteId:'pending-quote',status:'pending_payment',startedAt:null};
    f.db.prepare('INSERT INTO test_rentals VALUES(?,?,?,?,?)').run(pending.id,'old-user',pending.status,pending.quoteId,JSON.stringify(pending));
    assert.equal((await f.call(prefix+'pay',a,{rentalId:pending.id,outcome:'success'})).status,409);
    await f.ok(prefix+'cancel',a,{rentalId:pending.id});assert.equal(payments(f).filter(p=>p.type==='refund'||p.type==='deposit').length,0);
    f.reopen();assert.equal(f.db.prepare("SELECT data FROM test_rentals WHERE id='history'").get().data,JSON.stringify(historical));
  }finally{f.close();rmSync(dir,{recursive:true,force:true});}
});
test('deposit QA: customer UI clicks drive real API deposit, pickup, return/refund and persisted receipt; camera only after click',async()=>{
  const vm=await import('node:vm');const dir=mkdtempSync(join(tmpdir(),'deposit-ui-'));const f=fixture(join(dir,'state.sqlite'));const jar=new Map(),requests=[];let cameras=0;
  const flatten=n=>[n,...n.children.flatMap(flatten)];const text=n=>flatten(n).map(x=>x.textContent||'').join(' ');
  class Element {
    constructor(tag='div'){this.tagName=tag;this.children=[];this.events={};this.attributes={};this.style={};this.isConnected=true;const c=new Set();this.classList={add:x=>c.add(x),remove:x=>c.delete(x),contains:x=>c.has(x),toggle:(x,on=!c.has(x))=>on?c.add(x):c.delete(x)};}
    append(...n){this.children.push(...n);}replaceChildren(...n){this.children=n;}setAttribute(k,v){this.attributes[k]=v;}addEventListener(k,v){this.events[k]=v;}focus(){}play(){return Promise.resolve();}querySelectorAll(){return flatten(this).filter(n=>n.tagName==='button');}
  }
  const source=readFileSync(new URL('../production-public/app.js',import.meta.url),'utf8');
  const settle=async()=>{for(let i=0;i<15;i++)await new Promise(r=>setImmediate(r));};
  async function render(){
    const els=new Map();const context=vm.createContext({document:{body:new Element('body'),getElementById(id){for(const n of els.values()){const found=flatten(n).find(n=>n.id===id);if(found)return found;}if(!els.has(id))els.set(id,new Element());return els.get(id);},createElement:tag=>new Element(tag)},window:{addEventListener(){}},location:{pathname:'/',search:''},crypto:{randomUUID},Intl,Date,URLSearchParams,console,
      navigator:{mediaDevices:{getUserMedia:async()=>{cameras++;throw new Error('Simulated denied camera');}}},BarcodeDetector:class{},
      fetch:async(path,opts={})=>{requests.push(path);const h=new Headers(opts.headers);const r=await f.call(path,{cookies:[...jar].map(([k,v])=>k+'='+v).join('; '),csrf:h.get('x-csrf-token')},opts.body?JSON.parse(opts.body):undefined,h.get('idempotency-key')||randomUUID());for(const cookie of r.headers.getSetCookie()){const[k,v]=cookie.split(';')[0].split('=');jar.set(k,v);}return r;}});
    vm.runInContext(source,context);await settle();return{els,run:s=>vm.runInContext(s,context),async click(id,label){const b=flatten(els.get(id)).find(n=>n.tagName==='button'&&text(n).includes(label));assert.ok(b,label);await b.events.click();await settle();}};
  }
  try{
    let h=await render();assert.equal(cameras,0);await h.click('account-content','Continue with Google (test)');assert.equal(cameras,0);
    await h.els.get('home-scan').events.click();assert.equal(cameras,1);assert.match(text(h.els.get('sheet-root')),/Photos/);
    await h.click('rental-flow','Mock scan');assert.match(text(h.els.get('rental-flow')),/10,000\.00/);assert.match(text(h.els.get('rental-flow')),/500\.00/);
    await h.click('rental-flow','Continue to test payment');assert.match(text(h.els.get('rental-flow')),/Google Pay/);
    assert.equal(flatten(h.els.get('rental-flow')).some(n=>n.tagName==='select'),false);
    await h.click('rental-flow','Google Pay');assert.equal(h.run('paymentMethod'),'google_pay');
    await h.click('rental-flow','Pay test deposit');assert.equal(h.run('testState.rental.paymentMethod'),'google_pay');assert.equal(payments(f).find(p=>p.type==='deposit').paymentMethod,'google_pay');assert.match(text(h.els.get('rental-flow')),/Waiting for pickup/);assert.match(text(h.els.get('rental-flow')),/clock has not started/);
    f.advance(600000);f.reopen();h=await render();assert.equal(h.run('testState.rental.startedAt'),null);assert.equal(h.run('testState.rental.totalAmount'),0);assert.match(text(h.els.get('rental-flow')),/Waiting for pickup/);assert.equal(cameras,1);
    await h.click('rental-flow','Simulate pickup');assert.match(text(h.els.get('rental-flow')),/ACTIVE TEST RENTAL/);
    await h.click('rental-flow','Return demo power bank');await h.click('sheet-root','Confirm test return');assert.match(text(h.els.get('sheet-root')),/Test deposit refund/);assert.match(text(h.els.get('sheet-root')),/9,500\.00/);assert.match(text(h.els.get('sheet-root')),/500\.00/);
    const receipt=h.run('testState.rentals[0]');assert.equal(receipt.totalAmount+receipt.refundAmount,receipt.depositPaid);
    f.reopen();h=await render();assert.equal(h.run('testState.rental'),null);assert.match(text(h.els.get('rentals')),/Returned/);assert.equal(h.run('testState.rentals[0].refundAmount'),950000);
    assert.ok(requests.includes('/api/user/test/pickup'));assert.ok(!requests.some(p=>/\/v1\/|\/api\/admin|\/api\/user\/(pay|rent|return)$/.test(p)));
    assert.doesNotMatch(source,/walletBalance|top.up|recharge wallet/i);assert.doesNotMatch(source,/el\(['"]select['"]|createElement\(['"]select['"]/);
  }finally{f.close();rmSync(dir,{recursive:true,force:true});}
});
