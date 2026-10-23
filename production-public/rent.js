'use strict';
const $=id=>document.getElementById(id),node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
const params=new URL(location.href).searchParams,cabinetId=params.get('cabinet')||'',selectedOrder=params.get('order');
let session=null,state=null,busy=false,reading=null,inventoryRequestedAt=0,offset=0,phase='',receiptId=null;
const money=(n,c='ARS')=>new Intl.NumberFormat('en-AR',{style:'currency',currency:c,currencyDisplay:'code'}).format((n||0)/100);
const labels={pending_payment:'Awaiting confirmation',dispatching:'Releasing',active:'In use',completed:'Returned',cancelled:'Cancelled',review_required:'Needs review'};
const date=t=>t?new Date(t).toLocaleString('en-GB',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
const userError=message=>Object.assign(Error(message),{publicMessage:true});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const friendly=e=>({'Refresh cabinet inventory before borrowing':'Updating station availability. Please try again shortly.','No eligible reported power bank':'No power banks available. Please try another station.','Cabinet or account has an unresolved rental':'This station is processing a rental. Please try again shortly.','Previous dispatch requires reconciliation':'This station needs attention. Please contact support.','Physical dispatch is disabled':'This station is unavailable. Please try again shortly.','Physical rental testing is disabled':'Rentals are currently unavailable.','Quote expired; cancel and create a new order':'Your quote expired. Please confirm your rental again.','Sign in required':'Please sign in again to continue.'}[e.message]||(e.publicMessage?e.message:'We could not confirm the result. Check your rental before trying again.'));
$('cabinet').textContent='Station '+cabinetId;
function message(t){$('notice').textContent=t;}
async function api(path,body,csrf=session?.csrf){const r=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const j=await r.json();if(!r.ok)throw Error(j.error?.message||j.error||'Unable to complete the request. Please check your rental.');return j;}
const post=(action,body={})=>api('/api/user/hardware/'+action,body);
function button(text,fn,secondary=false,id){const b=node('button',text,secondary?'secondary':'primary');b.disabled=busy;if(id)b.id=id;b.onclick=()=>act(fn);return b;}
async function act(fn){if(busy)return;busy=true;message('');render();try{await fn();await load();}catch(e){message(friendly(e));try{await load();}catch{}}finally{busy=false;phase='';render();}}
function setState(next){const previous=state?.rental;state=next;offset=Date.parse(state.serverNow||new Date().toISOString())-Date.now();if(previous&&['active','dispatching'].includes(previous.status)&&!state.rental){const returned=state.rentals.find(r=>r.id===previous.id&&r.status==='completed');if(returned)receiptId=returned.id;}}
async function readState(){setState(await api('/api/user/hardware/state'));}
async function load(){if(reading)return reading;reading=(async()=>{session=await api('/api/user/session');if(session.user)await readState();else state=null;render();})();try{await reading;}finally{reading=null;}}
function cabinet(){return state?.cabinets.find(c=>c.cabinetId===cabinetId);}
async function refreshInventory(){inventoryRequestedAt=Date.now();await post('refresh',{cabinetId});}
async function prepareInventory(){if(!state?.enabled||!state?.authorized||!state.dispatchEnabled||!cabinet()||state.rental&&state.rental.status!=='pending_payment')return;if(cabinet().inventoryState!=='observed'&&Date.now()-inventoryRequestedAt>30000){try{await refreshInventory();}catch(e){message(friendly(e));}}}
async function confirmRental(){
 const pricingBefore=JSON.stringify(state?.rental?.pricing||state?.pricing);
 phase='Checking availability…';render();await load();
 if(!state?.enabled||!state.dispatchEnabled)throw userError('Rentals are unavailable. Please try again shortly.');
 if(state.rental&&state.rental.status!=='pending_payment')return;
 if(state.rental&&state.rental.cabinetId!==cabinetId)throw userError('Please finish your current rental first.');
 const queriedAt=Math.floor((Date.now()+offset)/1000)*1000;await refreshInventory();
 let fresh=false;
 for(let i=0;i<10;i++){await sleep(1000);await readState();const c=cabinet();if(c?.inventoryState==='observed'&&Date.parse(c.inventoryObservedAt)>=queriedAt){fresh=true;break;}}
 if(!fresh)throw userError('The station has not replied. Please try again shortly. No power bank has been released.');
 const c=cabinet();if(c.connection!=='online'||c.busy)throw userError('This station is unavailable. Please try again shortly.');
 if(!c.banks.some(b=>b.batteryPercent>=50))throw userError('No power banks available. Please try another station.');
 let current=state.rental;
 if(current&&Date.now()+offset-Date.parse(current.createdAt)>300000){await post('cancel',{rentalId:current.id});current=null;}
 if(!current){const result=await post('create',{cabinetId});current=result.rental;state.rental=current;}
 if(current.status!=='pending_payment')return;
 if(JSON.stringify(current.pricing)!==pricingBefore){await load();throw userError('Prices have changed. Please review and confirm again.');}
 phase='Starting your rental…';render();
 await post('pay',{rentalId:current.id});
}
function rows(entries){const box=node('dl');for(const[k,v]of entries)box.append(node('dt',k),node('dd',v));return box;}
function duration(r){const end=r.returnedAt?Date.parse(r.returnedAt):Date.now()+offset;const seconds=r.startedAt?Math.max(0,Math.floor((end-Date.parse(r.startedAt))/1000)):0;return [Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(n=>String(n).padStart(2,'0')).join(':');}
function tick(){const r=state?.rental;if(r?.status==='active'&&$('rental-timer'))$('rental-timer').textContent=duration(r);}
function orderDetails(r){return rows([['Rental reference',r.id],['Station',r.cabinetId],['Power bank',r.bankId||'Not released yet'],['Pickup slot',r.slot?'Slot '+r.slot:'—'],['Started',date(r.startedAt)],['Returned',date(r.returnedAt)],['Test deposit',money(r.depositPaid,r.pricing.currency)],['Test fee',money(r.totalAmount,r.pricing.currency)],['Test refund',money(r.refundAmount,r.pricing.currency)],...(r.outstandingAmount>0?[['Balance to review (not charged)',money(r.outstandingAmount,r.pricing.currency)]]:[])]);}
function orderCard(r){const card=node('article',null,'order-card'),top=node('div',null,'order-top');top.append(node('strong',r.slot?'Power bank · Slot '+r.slot:'Power bank rental'),node('span',labels[r.status]||'Needs review','badge '+r.status));card.append(top,node('p','Station '+r.cabinetId+' · '+date(r.startedAt||r.createdAt),'muted'));
 const summary=node('div',null,'order-summary');summary.append(node('span',r.startedAt?'Used '+duration(r):'Timer has not started'),node('strong',money(r.totalAmount,r.pricing.currency)));card.append(summary);
 const detail=node('details');detail.id='detail-'+r.id;detail.open=r.id===selectedOrder;detail.append(node('summary','Rental details'),orderDetails(r));card.append(detail);return card;}
function render(){
 const focused=document.activeElement?.id,opened=[...(document.querySelectorAll?.('details[open]')||[])].map(n=>n.id);
 const root=$('flow');root.replaceChildren();$('history').replaceChildren();
 if(!/^[A-Za-z0-9_-]{1,64}$/.test(cabinetId)){root.append(node('p','This QR code has no valid station ID. Please scan again.'));return;}
 if(!session?.user){$('page-title').textContent='Sign in to rent';root.append(node('p','Your station is saved. Payments are simulated; you will not be charged.','muted'),button('Sign in and continue',async()=>{const c=await api('/api/user/test-login-challenge');await api('/api/user/test-login',{},c.csrf);await load();await prepareInventory();},false,'login'));return;}
 if(!state)return;const c=cabinet(),r=state.rental,card=node('div',null,'card');root.append(card);
 if(!c){card.append(node('p','Station not found. Please scan again.'));return;}
 const receipt=state.rentals.find(x=>x.id===receiptId);
 if(r&&r.status!=='pending_payment'){
  $('page-title').textContent=r.status==='active'?'In use':r.status==='dispatching'?'Releasing your power bank':'Rental needs attention';
  if(r.status==='active'){
   card.append(node('p','Ready! Take your power bank','eyebrow'),node('div','Slot '+r.slot,'slot'),node('p','Time in use','muted'));
   const timer=node('div',duration(r),'timer');timer.id='rental-timer';card.append(timer,rows([['Current test fee',money(r.totalAmount,r.pricing.currency)]]),node('p','Return your power bank to the station when finished. Your timer stops automatically.','help'));
  }else if(r.status==='dispatching'){
   card.append(node('p','Slot '+r.slot,'slot'),node('p',r.confirmationDelayed?'The station is taking longer to reply. Please wait or contact support.':'Watch the station. Your timer starts once release is confirmed.'),node('p','Your timer has not started. Please do not start another rental.','muted'));
  }else card.append(node('h2','Release not yet confirmed'),node('p','Please contact support before starting another rental.'));
  card.append(node('p','Station '+r.cabinetId,'muted'));const support=node('a','Get help','text-link');support.href='/#support';card.append(support);
 }else if(receipt&&!r){$('page-title').textContent='Returned successfully';card.append(node('h2','You are all set'),rows([['Time in use',duration(receipt)],['Test fee',money(receipt.totalAmount,receipt.pricing.currency)],['Test refund',money(receipt.refundAmount,receipt.pricing.currency)]]),node('p','No real charge. Thanks for using Smile!','muted'),button('Rent again',async()=>{receiptId=null;await prepareInventory();}));
 }else{
  $('page-title').textContent='Confirm rental';const p=r?.pricing||state.pricing;
  const available=c.banks.filter(b=>b.batteryPercent>=50).length;
  card.append(node('h2','Your next charge'),node('p',!state.enabled||!state.dispatchEnabled?'Station unavailable':c.busy?'Station is busy':c.connection==='offline'?'Station offline':c.inventoryState!=='observed'?'Checking availability…':available?available+' power bank'+(available===1?'':'s')+' available':'No power banks available','availability'));
  if(p)card.append(rows([['Per started hour',money(p.hourlyRate,p.currency)],['Cap per 24 hours',money(p.dailyCap,p.currency)],['Deposit',money(p.deposit,p.currency)]]));
  card.append(node('p','Test payment — no real charge. Confirm to release a power bank and start your timer.','help'));
  const confirm=button(busy?(phase||'Please wait…'):'Confirm rental',confirmRental,false,'confirm-rental');confirm.disabled=busy||!state.enabled||!state.dispatchEnabled||c.busy;card.append(confirm);
  if(r)card.append(button('Cancel rental',()=>post('cancel',{rentalId:r.id}),true,'cancel-rental'));
 }
 if(!state.rentals.length)$('history').append(node('p','No rentals yet.','muted'));else for(const order of state.rentals)$('history').append(orderCard(order));
 for(const id of opened){const detail=$(id);if(detail)detail.open=true;}if(focused)$(focused)?.focus?.();
}
load().then(prepareInventory).catch(e=>message(friendly(e)));
setInterval(()=>{if(!busy&&!document.hidden)load().then(prepareInventory).catch(e=>message(friendly(e)));},5000);
setInterval(tick,1000);
