import test from 'node:test';
import assert from 'node:assert/strict';
import {openProductionStore} from '../src/production-store.mjs';
import {createProductionAPI} from '../src/production-api.mjs';
function setup(){
 const db=openProductionStore(':memory:');let time=Date.now(),number=0,exchanges=0;
 const config={publicOrigin:'https://rental.example',secure:true,sessionSeconds:3600,userSessionSeconds:3600,googleClientId:'example.apps.googleusercontent.com',googleClientSecret:'test-only'};
 const google={beginGoogle:async()=>{const state='state-'+(++number);return {state,nonce:'nonce',verifier:'verifier',url:'https://accounts.google.com/o/oauth2/v2/auth?state='+state};},exchangeGoogle:async()=>{exchanges++;return {sub:'google-user',email:'user@example.test',name:'User'};}};
 const api=createProductionAPI({db,config,google,now:()=>time});
 const request=(path,cookie='')=>api(new Request(config.publicOrigin+path,{headers:{cookie}}));
 return {db,request,advance:()=>time+=600001,exchanges:()=>exchanges};
}
async function begin(s,path){const r=await s.request(path);assert.equal(r.status,303);return {state:new URL(r.headers.get('location')).searchParams.get('state'),cookie:r.headers.get('set-cookie').split(';')[0]};}
const finish=(s,f,extra='')=>s.request('/auth/google/callback?state='+f.state+'&code=example'+extra,f.cookie);
test('Google callback returns to the scanned cabinet only after bound login and consumes intent',async()=>{
 const s=setup();try{
  const f=await begin(s,'/auth/google?cabinet=CAB_123');
  const wrong=await finish(s,{...f,cookie:'voltgo_oauth=wrong'});assert.match(wrong.headers.get('location'),/google_failed/);assert.equal(s.exchanges(),0);
  const r=await finish(s,f);assert.equal(r.headers.get('location'),'/rent?cabinet=CAB_123');
  assert.ok(r.headers.getSetCookie().some(c=>c.startsWith('voltgo_user=')));
  assert.equal(s.db.prepare('SELECT count(*) n FROM oauth_return_paths').get().n,0);
  const replay=await finish(s,f);assert.match(replay.headers.get('location'),/google_failed/);assert.equal(s.exchanges(),1);
 }finally{s.db.close();}
});
test('Google return cannot be used as an external redirect or altered during callback',async()=>{
 const s=setup();try{for(const cabinet of ['https://evil.test','//evil.test','CAB?next=evil','a'.repeat(65),'']){
  const f=await begin(s,'/auth/google?returnTo=https://evil.test&cabinet='+encodeURIComponent(cabinet));
  const r=await finish(s,f,'&cabinet=CHANGED&returnTo=https://evil.test');assert.equal(r.headers.get('location'),'/');
 }}finally{s.db.close();}
});
test('expired and cancelled Google flows do not create a session and clean rental intent',async()=>{
 const s=setup();try{
  let f=await begin(s,'/auth/google?cabinet=CAB_123');s.advance();
  assert.match((await finish(s,f)).headers.get('location'),/google_failed/);
  f=await begin(s,'/auth/google?cabinet=CAB_123');
  assert.match((await finish(s,f,'&error=access_denied')).headers.get('location'),/google_failed/);
  assert.equal(s.exchanges(),0);assert.equal(s.db.prepare('SELECT count(*) n FROM oauth_return_paths').get().n,0);
 }finally{s.db.close();}
});
