import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const source=readFileSync(new URL('../production-public/app.js',import.meta.url),'utf8');
const flat=n=>[n,...n.children.flatMap(flat)];
const words=n=>flat(n).map(n=>n.textContent||'').join(' ');
class Element {
  constructor(tag='div'){this.tagName=tag;this.children=[];this.events={};this.attributes={};this.style={};this.value='';this.classes=new Set();this.classList={add:n=>this.classes.add(n),remove:n=>this.classes.delete(n),toggle:(n,v)=>{if(v===undefined?!this.classes.has(n):v)this.classes.add(n);else this.classes.delete(n);}};}
  append(...n){this.children.push(...n);} replaceChildren(...n){this.children=n;} setAttribute(k,v){this.attributes[k]=v;} addEventListener(k,v){this.events[k]=v;} focus(){} querySelector(tag){return flat(this).find(n=>n.tagName===tag);} querySelectorAll(){return flat(this).filter(n=>n.tagName==='button');}
}
const pricing={currency:'ARS',hourlyRate:50000,dailyCap:300000,deposit:1000000};
const response=(data,status=200)=>({ok:status<400,status,json:async()=>data});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function harness(){
  const nodes=new Map(), events={}, requests=[]; let intercept=null;
  const user={id:'a',name:'Customer A',isTest:true};
  const context=vm.createContext({document:{body:new Element(),getElementById(id){if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);},createElement:t=>new Element(t)},window:{addEventListener:(n,fn)=>events[n]=fn},location:{pathname:'/',search:'',hash:''},crypto:{randomUUID},Intl,Date,URLSearchParams,console,fetch:async(path,opts={})=>{
    requests.push({path,opts});if(intercept){const result=intercept(path,opts);if(result!==undefined)return await result;}
    if(path==='/api/user/session')return response({user,csrf:'csrf-a',readiness:{googleTest:{ready:true}}});
    if(path==='/api/user/test/state')return response({rental:null,rentals:[],serverNow:new Date().toISOString()});
    if(path.endsWith('/stations'))return response({stations:[],pricing});
    return response({rentals:[],support:[]});
  }});
  vm.runInContext(source,context);for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));
  return {nodes,events,requests,run:c=>vm.runInContext(c,context),intercept:fn=>{intercept=fn;}};
}

test('journey controller: late prior-account state cannot repopulate new account',async()=>{
  const h=await harness(), slow=deferred(); h.intercept(path=>path.endsWith('/test/state')?slow.promise:undefined);
  const pending=h.run('loadTestState()');
  h.run("clearMemberState(); session={user:{id:'b',isTest:true},csrf:'csrf-b'};");
  slow.resolve(response({rental:{id:'foreign',status:'pending_payment',pricing},rentals:[],serverNow:new Date().toISOString()})); await pending;
  assert.equal(h.run('testState'),null);assert.doesNotMatch(words(h.nodes.get('rental-flow')),/Choose a test payment/);
});

test('journey controller: newer empty state wins over delayed active state',async()=>{
  const h=await harness(), slow=deferred();let calls=0;
  h.intercept(path=>path.endsWith('/test/state')?(++calls===1?slow.promise:response({rental:null,rentals:[],serverNow:new Date().toISOString()})):undefined);
  const old=h.run('loadTestState()');await h.run('loadTestState()');
  slow.resolve(response({rental:{id:'old',status:'pending_payment',pricing},rentals:[],serverNow:new Date().toISOString()}));await old;
  assert.equal(h.run('testState.rental'),null);assert.match(words(h.nodes.get('rental-flow')),/Start a test rental/);
});

test('journey controller: 401 clears receipt and member data but preserves support draft and return intent',async()=>{
  const h=await harness();h.run("$('support-message').value='Please check my deposit refund.'");h.run("navigate('support'); openSheet('Private receipt');");
  h.intercept(path=>path.endsWith('/support')?response({error:'Sign in required'},401):undefined);
  await assert.rejects(h.run("api('/api/user/support')"));
  assert.equal(h.run('session.user'),null);assert.equal(h.run('testState'),null);assert.equal(h.run('quote'),null);
  assert.equal(h.run('view'),'profile');assert.equal(h.run('afterLogin'),'support');
  assert.equal(h.nodes.get('sheet-root').children.length,0);assert.equal(h.nodes.get('customer-shell').inert,false);
  assert.equal(h.nodes.get('support-message').value,'Please check my deposit refund.');
});

test('journey controller: focus-detected expiry also preserves support draft and return intent',async()=>{
  const h=await harness();h.run("$('support-message').value='My rental refund needs checking.'");h.run("navigate('support')");
  h.intercept(path=>path==='/api/user/session'?response({user:null,readiness:{googleTest:{ready:true}}}):undefined);
  await h.events.focus();
  assert.equal(h.run('session.user'),null);assert.equal(h.nodes.get('support-message').value,'My rental refund needs checking.');assert.equal(h.run('afterLogin'),'support');assert.equal(h.run('view'),'profile');
});

test('journey controller: expired quote is removed before any rental mutation',async()=>{
  const h=await harness();h.run(`quote={id:'expired',expiresAt:'2000-01-01T00:00:00Z',pricing:${JSON.stringify(pricing)}}`);
  const count=h.requests.length;await h.run("transact('rent',{quoteId:quote.id})");
  assert.equal(h.run('quote'),null);assert.equal(h.requests.length,count);assert.match(words(h.nodes.get('rental-flow')),/Start a test rental/);assert.match(h.nodes.get('notice').textContent,/expired/i);
});

test('journey controller: uncertain mutation retry reuses key and restores clickable actions',async()=>{
  const h=await harness();let attempts=0;const keys=[];
  h.intercept((path,opts)=>{if(path.endsWith('/pay')){keys.push(opts.headers['Idempotency-Key']);if(++attempts===1)throw new Error('connection lost');return response({rental:{id:'r',status:'awaiting_pickup',pricing}});}return undefined;});
  await h.run("transact('pay',{rentalId:'r',outcome:'success'})");assert.equal(h.run('busy'),false);
  await h.run("transact('pay',{rentalId:'r',outcome:'success'})");assert.equal(h.run('busy'),false);assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);
  assert.ok(flat(h.nodes.get('rental-flow')).filter(n=>n.tagName==='button').every(n=>!n.disabled));
});

test('journey controller: stale-tab pickup notice follows settled server outcome, not submitted intent',async()=>{
  for(const [requested,status,pickupOutcome,expected,forbidden] of [['failure','active','success',/clock has started|pickup confirmed|already.*active/i,/full.*refunded/i],['success','cancelled','failure',/refund|cancel/i,/clock has started/i]]){
    const h=await harness();
    const rental={id:'r',status,pickupOutcome,pricing,depositPaid:1000000,startedAt:status==='active'?new Date().toISOString():null,totalAmount:0,refundAmount:status==='cancelled'?1000000:0};
    h.intercept(path=>path.endsWith('/pickup')?response({rental}):path.endsWith('/test/state')?response({rental:status==='active'?rental:null,rentals:[rental],serverNow:new Date().toISOString()}):undefined);
    await h.run(`transact('pickup',{rentalId:'r',outcome:'${requested}'})`);
    const notice=h.nodes.get('notice').textContent;assert.match(notice,expected);assert.doesNotMatch(notice,forbidden);
  }
});

test('journey controller: confirmed return stays successful when subsequent state refresh fails',async()=>{
  const h=await harness(); const rental={id:'r',status:'completed',pricing,totalAmount:50000,depositPaid:1000000,depositApplied:50000,refundAmount:950000,refundId:'refund',settlementStatus:'settled'};
  h.intercept(path=>path.endsWith('/return')?response({rental}):path.endsWith('/test/state')?Promise.reject(new Error('connection lost')):undefined);
  await h.run("transact('return',{rentalId:'r'})");
  assert.equal(h.run('testState.rental'),null);assert.equal(h.run('testState.rentals[0].status'),'completed');
  assert.match(words(h.nodes.get('sheet-root')),/Test rental receipt/);
  assert.match(h.nodes.get('notice').textContent,/complete|succeed|confirmed/i);
});
