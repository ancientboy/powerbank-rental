// Authenticated customer physical hardware testing. All money is a mock ledger, never a provider call.
import {assertNewRentalAllowed} from './production-cabinet-control.mjs';
import {randomUUID} from 'node:crypto';
import {listRecords,putRecord,transaction,recordAudit} from './production-store.mjs';
import {testPricing,estimateTestRental} from './production-test-rental.mjs';
import {hasRentalPolicy,policyEstimate} from './production-rental-policy.mjs';
export function hardwarePricing(db){
 const saved=JSON.parse(db.prepare("SELECT data FROM settings WHERE key='pricing'").get()?.data||'null');
 const p=saved||testPricing;
 return {...p,totalCap:p.totalCap??p.deposit,maxRentalDays:p.maxRentalDays??0,policyVersion:1,testOnly:true,version:p.policyVersion===1?p.version:p.version+'-policy1'};
}
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const iso=t=>new Date(t).toISOString();
export const hardwareOrders=db=>listRecords(db,'hardware_rental');
const save=(db,r)=>putRecord(db,'hardware_rental',r.id,r,r.userId);
const open=r=>!['completed','cancelled','bought_out'].includes(r.status);
// Reservations survive restarts. Only a release in flight serializes the cabinet;
// an uncertain outcome holds its bank and slot, never every other bank.
export function blockingHardwareCommand(db,c,cabinetId,slot=null){
 if(c.code!==65||c.cabinetId!==cabinetId||c.reconciledAt)return false;
 const r=c.rentalId&&hardwareOrders(db).find(r=>r.id===c.rentalId);
 if(!r)return true; // Standalone/legacy commands still need explicit reconciliation.
 return r.status==='dispatching'||(r.status==='review_required'&&(slot===null?false:r.slot===slot));
}
export function availableHardwareBanks(db,cabinet){
 const held=hardwareOrders(db).filter(r=>['dispatching','active','review_required'].includes(r.status)||r.status==='bought_out'&&!r.returnedAt);
 return cabinet.banks.filter(b=>b.batteryPercent>=50&&!held.some(r=>r.bankId===b.bankId||r.cabinetId===cabinet.cabinetId&&r.slot===b.slot&&!['active','bought_out'].includes(r.status)));
}
export function maintainHardware(db,time=Date.now()){
 return transaction(db,()=>{
  let changed=0;
  for(const r of hardwareOrders(db)){
   if(r.status==='active'&&hasRentalPolicy(r.pricing)){
    const estimate=policyEstimate(r,time);
    if(time>=Date.parse(estimate.buyoutDueAt)){
     const disputed=listRecords(db,'support').some(t=>t.rentalId===r.id&&['open','in_progress'].includes(t.status));
     const observed=listRecords(db,'wscharge_inventory').some(i=>i.observedAtSeconds*1000>Date.parse(r.startedAt)&&i.banks?.some(b=>b.bankId===r.bankId));
     if(disputed||observed){
      if(!r.buyoutReview){r.buyoutReview=true;r.reviewReason=disputed?'buyout_support_review':'buyout_return_evidence';r.reviewAt=iso(time);save(db,r);recordAudit(db,'system','hardware.rental.buyout_review',r.id,time);changed++;}
     }else if(!r.buyoutReview){finishBuyout(db,r,estimate,time);save(db,r);changed++;}
    }
    continue;
   }
   if(r.status==='dispatching'&&time-Date.parse(r.dispatchedAt)>=60000){
    r.status='review_required';r.reviewReason='release_confirmation_timeout';r.reviewAt=iso(time);
   }else if(r.status==='pending_payment'&&time-Date.parse(r.createdAt)>300000){
    r.status='cancelled';r.cancelledAt=iso(time);r.cancellationReason='unpaid_quote_expired';
   }else continue;
   save(db,r);recordAudit(db,'system','hardware.rental.'+r.status,r.id,time);changed++;
  }
  return changed;
 });
}
export function hardwareAccess(db,subject){return Boolean(db.prepare('SELECT id FROM users WHERE id=? UNION ALL SELECT id FROM test_users WHERE id=? LIMIT 1').get(subject,subject));}
export function hardwareState(db,config,subject,time,cabinets){
 const rentals=hardwareOrders(db).filter(r=>r.userId===subject).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(r=>({...estimateTestRental(r,time),confirmationDelayed:r.status==='dispatching'&&time-Date.parse(r.dispatchedAt)>30000}));
 return {enabled:config.hardwareRentalEnabled===true,dispatchEnabled:config.wschargeDispatchEnabled===true,authorized:hardwareAccess(db,subject,time),userId:subject,serverNow:iso(time),pricing:hardwarePricing(db),cabinets:cabinets.map(c=>({...c,banks:c.banks.map(b=>({slot:b.slot,batteryPercent:b.batteryPercent})),availableSlots:availableHardwareBanks(db,c).map(b=>b.slot),availableCount:availableHardwareBanks(db,c).length,busy:hardwareOrders(db).some(r=>r.cabinetId===c.cabinetId&&r.status==='dispatching')||listRecords(db,'wscharge_command').some(cmd=>blockingHardwareCommand(db,cmd,c.cabinetId))})),rental:rentals.find(open)||null,rentals};
}
export function hardwareAdmin(db,config,time){return {accessMode:'all_signed_in',enabled:config.hardwareRentalEnabled===true,dispatchEnabled:config.wschargeDispatchEnabled===true,requests:listRecords(db,'hardware_test_request').map(r=>({...r,authorized:hardwareAccess(db,r.id,time)})),orders:hardwareOrders(db).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),payments:listRecords(db,'hardware_payment'),testers:listRecords(db,'hardware_tester')};}
export function authorizeHardware(db,actor,body,time){
 if(actor.role!=='owner')fail(403,'Owner role required');
 fail(409,'All signed-in accounts can test by default; individual grants are no longer used');
}
function ledger(db,r,type,amount,time){
 const id=r.id+':'+type; // Stable ledger keys, callback retries cannot duplicate payment/refund.
 const existing=listRecords(db,'hardware_payment').find(p=>p.id===id);
 if(existing){if(existing.amount!==amount)fail(409,'Ledger amount conflict requires review');return id;}
 putRecord(db,'hardware_payment',id,{id,rentalId:r.id,userId:r.userId,type,amount,currency:r.pricing.currency,provider:'mock',testOnly:true,physicalHardware:true,createdAt:iso(time)},r.userId);
 return id;
}
function finishBuyout(db,r,estimate,time){
 Object.assign(r,estimate);r.status='bought_out';r.endedAt=estimate.buyoutDueAt;r.boughtOutAt=estimate.buyoutDueAt;r.processedAt=iso(time);
 r.depositApplied=Math.min(r.depositPaid,r.totalAmount);r.refundAmount=Math.max(0,r.depositPaid-r.totalAmount);r.outstandingAmount=Math.max(0,r.totalAmount-r.depositPaid);
 r.settlementStatus=r.testOnly?'settled':'review_required';
 if(r.testOnly){r.settlementId=ledger(db,r,'rental_fee',r.depositApplied,time);r.refundId=ledger(db,r,'refund',r.refundAmount,time);}
 recordAudit(db,'system','hardware.rental.buyout',r.id,time,{after:r});
}
function recordBuyoutReturn(db,r,e,time){
 if(r.returnedAt||e.observedAtSeconds*1000<Date.parse(r.startedAt))return;
 r.returnedAt=iso(e.observedAtSeconds*1000);r.returnCabinetId=e.cabinetId;r.returnSlot=e.slot;r.returnEventId=e.id;
 r.settlementStatus='review_required';r.reviewReason='return_after_buyout';r.reviewAt=iso(time);delete r.settlementReviewedAt;
 const c=listRecords(db,'wscharge_command').find(c=>c.id===r.commandId);
 if(c){c.reconciledAt=iso(time);c.reconciliation='returned_after_buyout';putRecord(db,'wscharge_command',c.id,c);}
 recordAudit(db,'system','hardware.rental.buyout_return',r.id,time);
}
function finishReturn(db,r,e,time){
 if(e.observedAtSeconds*1000<Date.parse(r.startedAt))return;
 const estimated=estimateTestRental(r,e.observedAtSeconds*1000);
 if(!r.lateReleaseAt&&!r.buyoutReview&&estimated.buyoutDueAt&&e.observedAtSeconds*1000>=Date.parse(estimated.buyoutDueAt)){finishBuyout(db,r,estimated,time);recordBuyoutReturn(db,r,e,time);return;}
 Object.assign(r,estimated);
 delete r.buyoutReview;delete r.reviewReason;
 if(r.lateReleaseAt){r.totalAmount=0;r.durationSeconds=Math.max(0,Math.floor(e.observedAtSeconds-Date.parse(r.startedAt)/1000));}
 r.endedAt=iso(Math.min(e.observedAtSeconds*1000,Date.parse(r.buyoutDueAt)||Infinity));
 r.status='completed';r.returnedAt=iso(e.observedAtSeconds*1000);r.returnCabinetId=e.cabinetId;r.returnSlot=e.slot;r.returnEventId=e.id;
 r.depositApplied=Math.min(r.depositPaid,r.totalAmount);r.refundAmount=Math.max(0,r.depositPaid-r.totalAmount);r.outstandingAmount=Math.max(0,r.totalAmount-r.depositPaid);r.settlementStatus=r.outstandingAmount?'review_required':'settled';
 r.settlementId=ledger(db,r,'rental_fee',r.depositApplied,time);r.refundId=ledger(db,r,'refund',r.refundAmount,time);
 const c=listRecords(db,'wscharge_command').find(c=>c.id===r.commandId);
 if(c){c.reconciledAt=iso(time);c.reconciliation='matched_test_order_return';putRecord(db,'wscharge_command',c.id,c);}
 recordAudit(db,r.userId,'hardware.rental.return',r.id,time);
}
export function reconcileHardwareEvent(db,e,time){
 if(e.freshness!=='within_window'||e.observedAtSeconds*1000>time||![65,66].includes(e.code))return;
 if(e.code===66){
  const bought=hardwareOrders(db).filter(r=>r.status==='bought_out'&&!r.returnedAt&&r.bankId===e.bankId&&e.observedAtSeconds*1000>=Date.parse(r.startedAt));
  if(bought.length===1){recordBuyoutReturn(db,bought[0],e,time);save(db,bought[0]);return;}
 }
 const rows=hardwareOrders(db).filter(r=>['dispatching','active','review_required'].includes(r.status)&&r.bankId===e.bankId&&e.observedAtSeconds>=Math.floor(Date.parse(r.dispatchedAt)/1000));
 if(rows.length===0&&e.code===65&&e.statusCode===200){
  // A late success after an operator cancellation is new evidence, not a replay
  // of a payment. Quarantine this bank again without taking back the refund.
  const closed=hardwareOrders(db).filter(r=>r.status==='cancelled'&&r.cancellationReason==='operator_verified_no_release'&&r.bankId===e.bankId&&r.cabinetId===e.cabinetId&&r.slot===e.slot&&e.observedAtSeconds>=Math.floor(Date.parse(r.dispatchedAt)/1000));
  const candidate=closed.sort((a,b)=>b.dispatchedAt.localeCompare(a.dispatchedAt))[0];
  if(candidate){candidate.status='review_required';candidate.reviewReason='release_after_cancellation';candidate.reviewAt=iso(time);candidate.lateReleaseAt=iso(e.observedAtSeconds*1000);candidate.startedAt=candidate.lateReleaseAt;candidate.ejectEventId=e.id;save(db,candidate);recordAudit(db,'system','hardware.rental.late_release',candidate.id,time);}
  return;
 }
 if(rows.length!==1)return;
 const r=rows[0];
 if(e.code===65){
  if(!['dispatching','review_required'].includes(r.status)||r.startedAt||r.cabinetId!==e.cabinetId||r.slot!==e.slot)return;
  r.ejectEventId=e.id;r.ejectStatus=e.statusCode;
  if(e.statusCode===200){r.status='active';delete r.reviewReason;r.releaseConfirmedAt=iso(time);r.startedAt=iso(e.observedAtSeconds*1000);recordAudit(db,r.userId,'hardware.rental.ejected',r.id,time);if(r.pendingReturn)finishReturn(db,r,r.pendingReturn,time);}
  else {r.status='review_required';r.reviewReason='release_failed';r.reviewAt=iso(time);}
 }else if(r.status==='active'||r.lateReleaseAt)finishReturn(db,r,e,time);
 else if(['dispatching','review_required'].includes(r.status))r.pendingReturn=e;
 save(db,r);
}
export function reconcileManualCommand(db,actor,id,time){
 if(actor.role!=='owner')fail(403,'Owner role required');
 return transaction(db,()=>{
 const c=listRecords(db,'wscharge_command').find(c=>c.id===id&&c.code===65);
 if(!c||c.rentalId)fail(409,'Only a standalone supervised command can use this reconciliation');
 if(c.reconciledAt)return {ok:true};
 const events=listRecords(db,'wscharge_event').filter(e=>e.cabinetId===c.cabinetId&&e.slot===c.slot&&e.freshness==='within_window');
 const borrowed=events.find(e=>e.code===65&&e.statusCode===200&&e.candidateCommandIds?.includes(c.id));
 const returned=borrowed&&events.find(e=>e.code===66&&e.bankId===borrowed.bankId&&e.observedAtSeconds>borrowed.observedAtSeconds);
 const inv=listRecords(db,'wscharge_inventory').find(e=>e.cabinetId===c.cabinetId);
 if(!returned||!inv||inv.observedAtSeconds<=returned.observedAtSeconds||time-inv.observedAtSeconds*1000>120000||!inv.banks.some(b=>b.bankId===returned.bankId&&b.slot===returned.slot))fail(409,'Need matched successful ejection, return and fresh post-return inventory');
 c.reconciledAt=iso(time);c.reconciliation='owner_reviewed_return_and_inventory';putRecord(db,'wscharge_command',c.id,c);recordAudit(db,actor.id,'hardware.manual.reconcile',c.id,time);return {ok:true};
 });
}
export async function handleHardware({db,config,subject,action,body,time,cabinets,send}){
 if(config.hardwareRentalEnabled!==true)fail(503,'Physical rental testing is disabled');
 if(action==='request'){
  return {ok:true,authorized:hardwareAccess(db,subject)};
 }
 if(!hardwareAccess(db,subject,time))fail(401,'Sign in to test physical rentals');
 if(action==='refresh'){
  if(!config.wschargeCabinets.includes(body.cabinetId))fail(404,'Cabinet not found');
  return send({code:64,cabinetId:body.cabinetId},'hw-inventory-'+randomUUID());
 }
 if(action==='create')return transaction(db,()=>{
  const existing=hardwareOrders(db).find(r=>r.userId===subject&&open(r));if(existing){if(existing.cabinetId!==body.cabinetId)fail(409,'Finish current rental first');return {rental:existing};}
  if(!config.wschargeCabinets.includes(body.cabinetId))fail(404,'Cabinet not found');
  assertNewRentalAllowed(db,body.cabinetId);
  if(body.pricingVersion&&body.pricingVersion!==hardwarePricing(db).version)fail(409,'Prices changed. Review the current rental terms.');
  const r={id:'hardware_'+randomUUID(),userId:subject,cabinetId:body.cabinetId,status:'pending_payment',createdAt:iso(time),pricing:hardwarePricing(db),testOnly:true,physicalHardware:true,depositPaid:0,totalAmount:0,refundAmount:0,settlementStatus:'unpaid'};
  save(db,r);recordAudit(db,subject,'hardware.rental.create',r.id,time);return {rental:r};
 });
 const r=hardwareOrders(db).find(r=>r.id===body.rentalId&&r.userId===subject);if(!r)fail(404,'Rental not found');
 if(action==='cancel')return transaction(db,()=>{Object.assign(r,hardwareOrders(db).find(x=>x.id===r.id));if(r.status!=='pending_payment')fail(409,'Only an unpaid, undispatched order can be cancelled');r.status='cancelled';save(db,r);return {rental:r};});
 if(action!=='pay')fail(404,'Not found');
 if(r.status!=='pending_payment')return {rental:r}; // Retry/status checks never issue another command.
 if(!config.wschargeDispatchEnabled)fail(503,'Physical dispatch is disabled');
 const reserved=transaction(db,()=>{
  Object.assign(r,hardwareOrders(db).find(x=>x.id===r.id));
  if(r.status!=='pending_payment')return false;
  assertNewRentalAllowed(db,r.cabinetId);
  if(time-Date.parse(r.createdAt)>300000)fail(409,'Quote expired; cancel and create a new order');
  if(hardwareOrders(db).some(x=>x.id!==r.id&&['dispatching','active','review_required'].includes(x.status)&&(x.userId===subject||x.cabinetId===r.cabinetId&&x.status==='dispatching')))fail(409,'Cabinet or account has an unresolved rental');
  if(listRecords(db,'wscharge_command').some(c=>blockingHardwareCommand(db,c,r.cabinetId)))fail(409,'Previous dispatch requires reconciliation');
  const cabinet=cabinets.find(c=>c.cabinetId===r.cabinetId);
  if(cabinet?.connection!=='online'||cabinet.inventoryState!=='observed')fail(409,'Refresh cabinet inventory before borrowing');
  const lastReturn=hardwareOrders(db).filter(x=>x.cabinetId===r.cabinetId&&x.returnedAt).map(x=>Date.parse(x.returnedAt));
  if(lastReturn.some(t=>Date.parse(cabinet.inventoryObservedAt)<=t))fail(409,'Refresh inventory after the previous return');
  const bank=availableHardwareBanks(db,cabinet).sort((a,b)=>b.batteryPercent-a.batteryPercent||a.slot-b.slot)[0];
  if(!bank)fail(409,'No eligible reported power bank');
  Object.assign(r,{slot:bank.slot,bankId:bank.bankId,status:'dispatching',dispatchedAt:iso(time),depositPaid:r.pricing.deposit,settlementStatus:'deposit_held'});
  r.depositPaymentId=ledger(db,r,'deposit',r.depositPaid,time);save(db,r);recordAudit(db,subject,'hardware.rental.dispatch',r.id,time);return true;
 });
 if(!reserved)return {rental:r};
 try{await send({code:65,cabinetId:r.cabinetId,slot:r.slot},r.id,r.id);}catch{
  const latest=hardwareOrders(db).find(x=>x.id===r.id);if(latest.status==='dispatching'){latest.status='review_required';latest.reviewReason='dispatch_outcome_unknown';latest.reviewAt=iso(time);save(db,latest);}
 }
 return {rental:hardwareOrders(db).find(x=>x.id===r.id)};
}

// These operations never send a release command or call a money provider.
// Operators must supply a note and current device evidence; stale views conflict.
export function resolveHardwareOrder(db,actor,body,time,cabinets){
 if(!['owner','operator'].includes(actor.role))fail(403,'Your role cannot perform this action');
 if(!['recheck','confirm_return','cancel_unreleased','note','acknowledge_balance','resume_buyout','refund_buyout_difference'].includes(body.action))fail(400,'Unknown resolution action');
 if(typeof body.note!=='string'||body.note.trim().length<5||body.note.length>2000)fail(400,'Provide a handling note (5–2000 characters)');
 return transaction(db,()=>{
  let r=hardwareOrders(db).find(x=>x.id===body.rentalId);if(!r)fail(404,'Rental not found');
  if(body.expectedStatus!==r.status)fail(409,'Order changed. Refresh before handling it.');
  const before={...r};
  if(body.action==='resume_buyout'){
   if(r.status!=='active'||!r.buyoutReview)fail(409,'Only a held buyout can resume');
   if(listRecords(db,'support').some(t=>t.rentalId===r.id&&['open','in_progress'].includes(t.status)))fail(409,'Resolve related support requests first');
   if(listRecords(db,'wscharge_inventory').some(i=>i.observedAtSeconds*1000>Date.parse(r.startedAt)&&i.banks?.some(b=>b.bankId===r.bankId)))fail(409,'Return evidence exists. Confirm the return instead');
   delete r.buyoutReview;delete r.reviewReason;
  }else if(body.action==='refund_buyout_difference'){
   if(!r.testOnly||r.status!=='bought_out'||!r.returnedAt||r.buyoutRefundId)fail(409,'A returned mock buyout without adjustment is required');
   if(Date.parse(r.returnedAt)>=Date.parse(r.boughtOutAt))fail(409,'Return was after the buyout deadline; no automatic difference refund');
   const fee=policyEstimate({...r,status:'active'},Date.parse(r.returnedAt)).totalAmount;
   const difference=r.depositApplied-fee;if(difference<0)fail(409,'Invalid refund difference');
   r.buyoutRefundId=ledger(db,r,'buyout_adjustment_refund',difference,time);r.originalBuyoutAmount=r.totalAmount;r.totalAmount=fee;r.depositApplied=fee;r.refundAmount+=difference;r.status='completed';r.endedAt=r.returnedAt;r.durationSeconds=Math.floor((Date.parse(r.returnedAt)-Date.parse(r.startedAt))/1000);r.settlementStatus='settled';delete r.reviewReason;
  }else if(body.action==='recheck'){
   if(!['dispatching','active','review_required','bought_out'].includes(r.status))fail(409,'Only an open rental or buyout can be rechecked');
   const events=listRecords(db,'wscharge_event').filter(e=>e.bankId===r.bankId).sort((a,b)=>a.observedAtSeconds-b.observedAtSeconds||a.code-b.code);
   for(const e of events)reconcileHardwareEvent(db,e,time);
   r=hardwareOrders(db).find(x=>x.id===r.id);
  }else if(body.action==='acknowledge_balance'){
   if(!['completed','bought_out'].includes(r.status)||r.settlementStatus!=='review_required')fail(409,'Only a completed settlement review can be acknowledged');
   r.settlementReviewedAt=iso(time);r.settlementReviewedBy=actor.id;
  }else if(body.action!=='note'){
   if(!r.testOnly)fail(409,'Live payments require provider reconciliation');
   if(body.action==='cancel_unreleased'&&(!['dispatching','review_required'].includes(r.status)||r.startedAt))fail(409,'Only an unconfirmed release can be cancelled');
   if(body.action==='confirm_return'&&!(r.status==='active'||r.status==='bought_out'&&!r.returnedAt||r.status==='review_required'&&r.lateReleaseAt))fail(409,'Only an active rental can be returned');
   if(body.action==='cancel_unreleased'&&time-Date.parse(r.dispatchedAt)<60000)fail(409,'Wait for release confirmation before reviewing');
   const evidence=cabinets.find(c=>c.connection==='online'&&c.inventoryState==='observed'&&time-Date.parse(c.inventoryObservedAt)<=120000&&Date.parse(c.inventoryObservedAt)>Math.max(Date.parse(r.dispatchedAt),Date.parse(r.startedAt)||0)&&c.banks.some(b=>b.bankId===r.bankId&&(body.action!=='cancel_unreleased'||c.cabinetId===r.cabinetId&&b.slot===r.slot)));
   if(!evidence)fail(409,'Refresh inventory: the matching bank must be reported in a cabinet after this rental');
   if(body.action==='confirm_return'){
    // A lost return notification cannot establish an earlier return time. Use the
    // inventory observation, make the basis visible, and retain the operator note.
    (r.status==='bought_out'?recordBuyoutReturn:finishReturn)(db,r,{id:'inventory:'+evidence.cabinetId+':'+evidence.inventoryObservedAt,observedAtSeconds:Date.parse(evidence.inventoryObservedAt)/1000,cabinetId:evidence.cabinetId,slot:evidence.banks.find(b=>b.bankId===r.bankId).slot},time);
    r.returnTimeSource='operator_verified_inventory';
   }else{
    r.status='cancelled';r.cancelledAt=iso(time);r.cancellationReason='operator_verified_no_release';r.totalAmount=0;r.refundAmount=r.depositPaid;r.depositApplied=0;r.settlementStatus='refunded';
    r.refundId=ledger(db,r,'refund',r.refundAmount,time);
    const cmd=listRecords(db,'wscharge_command').find(c=>c.id===r.commandId);
    if(cmd){cmd.reconciledAt=iso(time);cmd.reconciliation='operator_verified_no_release';putRecord(db,'wscharge_command',cmd.id,cmd);}
   }
   r.resolutionEvidence={inventoryObservedAt:evidence.inventoryObservedAt,cabinetId:evidence.cabinetId,bankId:r.bankId};
  }
  r.handlingHistory=[...(r.handlingHistory||[]),{id:randomUUID(),action:body.action,note:body.note.trim(),actorId:actor.id,actorRole:actor.role,createdAt:iso(time),beforeStatus:before.status,afterStatus:r.status}];
  if(['completed','cancelled','active'].includes(r.status)&&!r.buyoutReview)delete r.reviewReason;
  save(db,r);recordAudit(db,actor.id,'hardware.rental.handle',r.id,time,{before,after:r});
  return {rental:r};
 });
}
