import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { openProductionStore } from '../src/production-store.mjs';
import { createProductionAPI } from '../src/production-api.mjs';

// Independent, offline journey review. No real authentication, payments or hardware.
function fixture() {
  const db = openProductionStore(':memory:');
  let time = Date.parse('2026-10-21T12:00:00Z');
  const config = { publicOrigin: 'https://journey.example', secure: true, enableGoogleTestLogin: true, sessionSeconds: 3600, userSessionSeconds: 3600 };
  const api = createProductionAPI({ db, config, now: () => time });
  const call = async (client, path, body, key = randomUUID()) => {
    const r = await api(new Request(config.publicOrigin + path, { method: body === undefined ? 'GET' : 'POST', headers: { origin: config.publicOrigin, cookie: client.cookie || '', 'x-csrf-token': client.csrf || '', 'content-type': 'application/json', 'idempotency-key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const value = { status: r.status, data: await r.json() };
    for (const entry of r.headers.getSetCookie()) {
      const [name, token] = entry.split(';')[0].split('=');
      const jar = new Map((client.cookie || '').split('; ').filter(Boolean).map(s => s.split('=')));
      jar.set(name, token); client.cookie = [...jar].map(([k,v]) => `${k}=${v}`).join('; ');
    }
    return value;
  };
  const ok = async (c, path, body, key) => { const r = await call(c,path,body,key); assert.ok([200,201].includes(r.status), JSON.stringify(r)); return r.data; };
  const signIn = async (c = {}) => { const ch = await ok(c,'/api/user/test-login-challenge'); c.csrf = ch.csrf; c.csrf = (await ok(c,'/api/user/test-login',{})).csrf; c.user = (await ok(c,'/api/user/session')).user; return c; };
  const act = (c, action, body, key) => ok(c,'/api/user/test/'+action,body,key);
  const rent = async c => { const {quote} = await act(c,'quote',{stationId:'DEMO-001'}); return (await act(c,'rent',{quoteId:quote.id})).rental; };
  const admin = role => {
    const id = randomUUID(), token = randomBytes(32).toString('base64url'), csrf = randomUUID();
    db.prepare('INSERT INTO admins VALUES(?,?,?,?,0)').run(id,id,'unused',role);
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(createHash('sha256').update(token).digest('hex'),'admin',id,csrf,time+3600000);
    return {cookie:'voltgo_admin='+token,csrf};
  };
  return {db,call,ok,signIn,act,rent,admin,advance: ms => {time+=ms;}};
}

test('journey: expiry at pickup blocks mutation, same-browser sign-in restores exact paid rental', async t => {
  const f=fixture(); t.after(()=>f.db.close()); const c=await f.signIn(); const identity=c.user.id, r=await f.rent(c);
  await f.act(c,'pay',{rentalId:r.id,outcome:'success'});
  f.advance(3600000);
  assert.equal((await f.call(c,'/api/user/test/pickup',{rentalId:r.id,outcome:'success'})).status,401);
  assert.equal((await f.ok(c,'/api/user/session')).user,null);
  await f.signIn(c); assert.equal(c.user.id,identity);
  const state=await f.act(c,'state'); assert.equal(state.rental.id,r.id); assert.equal(state.rental.status,'awaiting_pickup'); assert.equal(state.rental.startedAt,null); assert.equal(state.rental.totalAmount,0);
  const picked=await f.act(c,'pickup',{rentalId:r.id,outcome:'success'});
  assert.equal(picked.rental.status,'active');
  const result=await f.act(c,'return',{rentalId:r.id}); assert.equal(result.rental.totalAmount,50000); assert.equal(result.rental.refundAmount,950000);
});

test('journey: concurrent distinct quotes cannot create two open rentals or share the next deposit', async t => {
  const f=fixture(); t.after(()=>f.db.close()); const c=await f.signIn();
  const quotes=await Promise.all([1,2].map(()=>f.act(c,'quote',{stationId:'DEMO-001'})));
  const attempts=await Promise.all(quotes.map(({quote})=>f.call(c,'/api/user/test/rent',{quoteId:quote.id})));
  assert.deepEqual(attempts.map(x=>x.status).sort(),[200,409]);
  const r=attempts.find(x=>x.status===200).data.rental;
  await f.act(c,'pay',{rentalId:r.id,outcome:'success'});
  const terminal=await Promise.all([f.call(c,'/api/user/test/pickup',{rentalId:r.id,outcome:'failure'}),f.call(c,'/api/user/test/cancel',{rentalId:r.id})]);
  assert.ok(terminal.every(x=>x.status===200));
  const refunds=f.db.prepare("SELECT data FROM test_records WHERE kind='payment'").all().map(x=>JSON.parse(x.data)).filter(x=>x.type==='refund');
  assert.equal(refunds.length,1); assert.equal(refunds[0].amount,1000000);
  const next=await f.rent(c); assert.equal(next.depositPaid,0); assert.equal(next.status,'pending_payment');
  assert.equal((await f.call(c,'/api/user/test/pickup',{rentalId:next.id,outcome:'success'})).status,409);
});

test('journey: return over deposit preserves balance due and immutable receipt after reauthentication', async t => {
  const f=fixture(); t.after(()=>f.db.close()); const c=await f.signIn(); const r=await f.rent(c);
  await f.act(c,'pay',{rentalId:r.id,outcome:'success',paymentMethod:'bank_transfer'}); await f.act(c,'pickup',{rentalId:r.id,outcome:'success'});
  f.advance(4*24*3600000); await f.signIn(c);
  const done=await f.act(c,'return',{rentalId:r.id});
  assert.equal(done.rental.totalAmount,1200000); assert.equal(done.rental.depositApplied,1000000); assert.equal(done.rental.outstandingAmount,200000); assert.equal(done.rental.refundAmount,0); assert.equal(done.rental.settlementStatus,'review_required'); assert.equal(done.refund,null);
  f.advance(24*3600000); await f.signIn(c);
  assert.deepEqual((await f.act(c,'return',{rentalId:r.id})).rental,done.rental);
  assert.deepEqual((await f.ok(c,'/api/user/rentals')).rentals[0],done.rental);
  assert.equal(f.db.prepare("SELECT count(*) n FROM test_records WHERE kind='payment'").get().n,2);
});

test('journey: support reply/status complete round trip with owner isolation and read-only viewer', async t => {
  const f=fixture(); t.after(()=>f.db.close()); const a=await f.signIn(), b=await f.signIn(), operator=f.admin('operator'), viewer=f.admin('viewer');
  const created=await f.ok(a,'/api/user/support',{message:'My simulated return needs review.'}); const id=created.support.id;
  assert.equal(created.support.testOnly,true);
  assert.deepEqual((await f.ok(b,'/api/user/support')).support,[]);
  const payload={id,status:'in_progress',reply:'We are reviewing your test rental.'};
  assert.equal((await f.call(viewer,'/api/admin/support',payload)).status,403);
  assert.equal((await f.call(a,'/api/admin/support',payload)).status,401);
  await f.ok(operator,'/api/admin/support',payload);
  let ticket=(await f.ok(a,'/api/user/support')).support[0]; assert.equal(ticket.reply,payload.reply); assert.equal(ticket.status,'in_progress');
  await f.ok(operator,'/api/admin/support',{...payload,status:'resolved',reply:'Your simulated refund is recorded.'});
  ticket=(await f.ok(a,'/api/user/support')).support[0]; assert.equal(ticket.status,'resolved'); assert.equal(ticket.reply,'Your simulated refund is recorded.');
  assert.deepEqual((await f.ok(b,'/api/user/support')).support,[]);
  assert.equal((await f.call(operator,'/api/admin/pricing',{currency:'ARS',hourlyRate:1,dailyCap:2,deposit:3})).status,403);
});
