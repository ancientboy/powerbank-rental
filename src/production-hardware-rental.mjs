// Authenticated customer physical hardware testing. All money is a mock ledger, never a provider call.
import {randomUUID} from 'node:crypto';
import {listRecords,putRecord,transaction,recordAudit} from './production-store.mjs';
import {testPricing,estimateTestRental} from './production-test-rental.mjs';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const iso=t=>new Date(t).toISOString();
export const hardwareOrders=db=>listRecords(db,'hardware_rental');
const save=(db,r)=>putRecord(db,'hardware_rental',r.id,r,r.userId);
const open=r=>!['completed','cancelled'].includes(r.status);
export function hardwareAccess(db,subject){return Boolean(db.prepare('SELECT id FROM users WHERE id=? UNION ALL SELECT id FROM test_users WHERE id=? LIMIT 1').get(subject,subject));}
export function hardwareState(db,config,subject,time,cabinets){
 const rentals=hardwareOrders(db).filter(r=>r.userId===subject).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(r=>({...estimateTestRental(r,time),confirmationDelayed:r.status==='dispatching'&&time-Date.parse(r.dispatchedAt)>30000}));
 return {enabled:config.hardwareRentalEnabled===true,dispatchEnabled:config.wschargeDispatchEnabled===true,authorized:hardwareAccess(db,subject,time),userId:subject,serverNow:iso(time),pricing:testPricing,cabinets:cabinets.map(c=>({...c,banks:c.banks.map(b=>({slot:b.slot,batteryPercent:b.batteryPercent})),busy:hardwareOrders(db).some(r=>r.cabinetId===c.cabinetId&&['dispatching','active','review_required'].includes(r.status))})),rental:rentals.find(open)||null,rentals};
}
export function hardwareAdmin(db,config,time){return {accessMode:'all_signed_in',enabled:config.hardwareRentalEnabled===true,dispatchEnabled:config.wschargeDispatchEnabled===true,requests:listRecords(db,'hardware_test_request').map(r=>({...r,authorized:hardwareAccess(db,r.id,time)})),orders:hardwareOrders(db).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),payments:listRecords(db,'hardware_payment'),testers:listRecords(db,'hardware_tester')};}
export function authorizeHardware(db,actor,body,time){
 if(actor.role!=='owner')fail(403,'Owner role required');
 fail(409,'All signed-in accounts can test by default; individual grants are no longer used');
}
function ledger(db,r,type,amount,time){
 const id=r.id+':'+type; // Stable ledger keys, callback retries cannot duplicate payment/refund.
 putRecord(db,'hardware_payment',id,{id,rentalId:r.id,userId:r.userId,type,amount,currency:r.pricing.currency,provider:'mock',testOnly:true,physicalHardware:true,createdAt:iso(time)},r.userId);
 return id;
}
function finishReturn(db,r,e,time){
 if(e.observedAtSeconds*1000<Date.parse(r.startedAt))return;
 Object.assign(r,estimateTestRental(r,e.observedAtSeconds*1000));
 r.status='completed';r.returnedAt=iso(e.observedAtSeconds*1000);r.returnCabinetId=e.cabinetId;r.returnSlot=e.slot;r.returnEventId=e.id;
 r.depositApplied=Math.min(r.depositPaid,r.totalAmount);r.refundAmount=Math.max(0,r.depositPaid-r.totalAmount);r.outstandingAmount=Math.max(0,r.totalAmount-r.depositPaid);r.settlementStatus=r.outstandingAmount?'review_required':'settled';
 r.settlementId=ledger(db,r,'rental_fee',r.depositApplied,time);r.refundId=ledger(db,r,'refund',r.refundAmount,time);
 const c=listRecords(db,'wscharge_command').find(c=>c.id===r.commandId);
 if(c){c.reconciledAt=iso(time);c.reconciliation='matched_test_order_return';putRecord(db,'wscharge_command',c.id,c);}
 recordAudit(db,r.userId,'hardware.rental.return',r.id,time);
}
export function reconcileHardwareEvent(db,e,time){
 if(e.freshness!=='within_window'||e.observedAtSeconds*1000>time||![65,66].includes(e.code))return;
 const rows=hardwareOrders(db).filter(r=>['dispatching','active','review_required'].includes(r.status)&&r.bankId===e.bankId&&e.observedAtSeconds>=Math.floor(Date.parse(r.dispatchedAt)/1000));
 if(rows.length!==1)return;
 const r=rows[0];
 if(e.code===65){
  if(r.status!=='dispatching'||r.cabinetId!==e.cabinetId||r.slot!==e.slot||Math.abs(e.observedAtSeconds*1000-Date.parse(r.dispatchedAt))>300000)return;
  r.ejectEventId=e.id;r.ejectStatus=e.statusCode;
  if(e.statusCode===200){r.status='active';r.startedAt=iso(e.observedAtSeconds*1000);recordAudit(db,r.userId,'hardware.rental.ejected',r.id,time);if(r.pendingReturn)finishReturn(db,r,r.pendingReturn,time);}
  else r.status='review_required';
 }else if(r.status==='active')finishReturn(db,r,e,time);
 else if(r.status==='dispatching')r.pendingReturn=e;
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
  const r={id:'hardware_'+randomUUID(),userId:subject,cabinetId:body.cabinetId,status:'pending_payment',createdAt:iso(time),pricing:{...testPricing},testOnly:true,physicalHardware:true,depositPaid:0,totalAmount:0,refundAmount:0,settlementStatus:'unpaid'};
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
  if(time-Date.parse(r.createdAt)>300000)fail(409,'Quote expired; cancel and create a new order');
  if(hardwareOrders(db).some(x=>x.id!==r.id&&['dispatching','active','review_required'].includes(x.status)&&(x.cabinetId===r.cabinetId||x.userId===subject)))fail(409,'Cabinet or account has an unresolved rental');
  if(listRecords(db,'wscharge_command').some(c=>c.code===65&&c.cabinetId===r.cabinetId&&!c.reconciledAt))fail(409,'Previous dispatch requires reconciliation');
  const cabinet=cabinets.find(c=>c.cabinetId===r.cabinetId);
  if(cabinet?.connection!=='online'||cabinet.inventoryState!=='observed')fail(409,'Refresh cabinet inventory before borrowing');
  const busyBanks=new Set(hardwareOrders(db).filter(x=>['dispatching','active','review_required'].includes(x.status)).map(x=>x.bankId));
  const lastReturn=hardwareOrders(db).filter(x=>x.cabinetId===r.cabinetId&&x.returnedAt).map(x=>Date.parse(x.returnedAt));
  if(lastReturn.some(t=>Date.parse(cabinet.inventoryObservedAt)<=t))fail(409,'Refresh inventory after the previous return');
  const bank=cabinet.banks.filter(b=>b.batteryPercent>=50&&!busyBanks.has(b.bankId)).sort((a,b)=>b.batteryPercent-a.batteryPercent||a.slot-b.slot)[0];
  if(!bank)fail(409,'No eligible reported power bank');
  Object.assign(r,{slot:bank.slot,bankId:bank.bankId,status:'dispatching',dispatchedAt:iso(time),depositPaid:r.pricing.deposit,settlementStatus:'deposit_held'});
  r.depositPaymentId=ledger(db,r,'deposit',r.depositPaid,time);save(db,r);recordAudit(db,subject,'hardware.rental.dispatch',r.id,time);return true;
 });
 if(!reserved)return {rental:r};
 try{await send({code:65,cabinetId:r.cabinetId,slot:r.slot},r.id,r.id);}catch{
  const latest=hardwareOrders(db).find(x=>x.id===r.id);if(latest.status==='dispatching'){latest.status='review_required';save(db,latest);}
 }
 return {rental:hardwareOrders(db).find(x=>x.id===r.id)};
}
