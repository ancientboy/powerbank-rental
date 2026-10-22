import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testPricing } from '../src/production-test-rental.mjs';
import { openProductionStore } from '../src/production-store.mjs';
import { normalizeCabinetSnapshot, applyNormalizedLabEvent, applyIntegrationScenario, integrationView, resolveIntegrationException, reconcileIntegrationRun, retryIntegrationRefund, createIntegrationAdapter } from '../src/production-integrations.mjs';
const now=Date.parse('2026-10-22T00:00:00Z'), actor={id:'review-owner',role:'owner'};
const throwsStatus=(fn,status)=>assert.throws(fn,error=>error.status===status);
function initial(){return {id:'rental',createdAt:new Date(now).toISOString(),testOnly:true,pricing:{...testPricing},status:'pending_payment',startedAt:null,returnedAt:null,feeAmount:0,settlementStatus:'deposit_held',payment:{status:'pending',amount:1000000},operation:{status:'not_requested'},refund:{status:'not_requested',amount:0},events:[]};}
function event(type,sequence,extra={}){return {id:'event_'+sequence,rentalId:'rental',type,occurredAt:new Date(now).toISOString(),sequence,source:'mock',testOnly:true,...extra};}
test('review: normalized event duplicate/reorder handling is atomic; ACK never bills and refund request is not settlement',()=>{
 const run=initial(); const original=structuredClone(run);
 throwsStatus(()=>applyNormalizedLabEvent(run,event('payment.succeeded',1,{source:'pvs',testOnly:false}),now),400); assert.deepEqual(run,original);
 applyNormalizedLabEvent(run,event('payment.succeeded',1,{rawToken:'must-not-persist'}),now); assert.ok(!JSON.stringify(run).includes('must-not-persist')); applyNormalizedLabEvent(run,event('operation.accepted',2),now);
 assert.equal(run.startedAt,null); assert.equal(run.feeAmount,0); assert.equal(run.status,'awaiting_pickup');
 const accepted=structuredClone(run);
 assert.equal(applyNormalizedLabEvent(run,event('operation.accepted',2),now).duplicate,true); assert.deepEqual(run,accepted);
 throwsStatus(()=>applyNormalizedLabEvent(run,event('operation.failed',2),now),409); assert.deepEqual(run,accepted);
 throwsStatus(()=>applyNormalizedLabEvent(run,event('pickup.confirmed',4),now),409); assert.deepEqual(run,accepted);
 throwsStatus(()=>applyNormalizedLabEvent(run,event('return.confirmed',3),now),409); assert.deepEqual(run,accepted);
 applyNormalizedLabEvent(run,event('pickup.confirmed',3),now); applyNormalizedLabEvent(run,event('return.confirmed',4),now); applyNormalizedLabEvent(run,event('refund.requested',5),now);
 assert.equal(run.refund.status,'pending'); assert.equal(run.settlementStatus,'refund_pending'); assert.equal(run.feeAmount+run.refund.amount,run.payment.amount);
 applyNormalizedLabEvent(run,event('refund.succeeded',6),now); assert.equal(run.settlementStatus,'settled');
 const settled=structuredClone(run); throwsStatus(()=>applyNormalizedLabEvent(run,event('refund.failed',7),now),409); assert.deepEqual(run,settled);
});
test('review: inventory freshness, duplicate banks and future timestamps fail closed',()=>{
 const snapshot={id:'cabinet',source:'mock',testOnly:true,online:true,observedAt:new Date(now).toISOString(),slots:[{slot:1,bankId:'bank',status:'available'}]};
 assert.equal(normalizeCabinetSnapshot(snapshot,now).available,1);
 assert.equal(normalizeCabinetSnapshot(snapshot,now+121000).available,0);
 assert.equal(normalizeCabinetSnapshot({...snapshot,online:false},now).available,0);
 throwsStatus(()=>normalizeCabinetSnapshot({...snapshot,observedAt:new Date(now+1).toISOString()},now),400);
 throwsStatus(()=>normalizeCabinetSnapshot({...snapshot,slots:[...snapshot.slots,{slot:2,bankId:'bank',status:'available'}]},now),400);
 throwsStatus(()=>normalizeCabinetSnapshot({...snapshot,source:'wscharge'},now),400);
});
test('review: mock lab survives restart with scoped replay and annotation-only resolution; no live ledger writes',t=>{
 const dir=mkdtempSync(join(tmpdir(),'review-vendor-'));t.after(()=>rmSync(dir,{recursive:true,force:true})); const path=join(dir,'state.sqlite'); let db=openProductionStore(path);
 throwsStatus(()=>applyIntegrationScenario(db,{scenario:'success',idempotencyKey:'viewer-action',actor:{id:'viewer',role:'viewer'},now}),403);
 const result=applyIntegrationScenario(db,{scenario:'refund-pending',idempotencyKey:'review-scenario',actor,now}); const before=structuredClone(result.run); const exception=result.exceptions[0];
 assert.equal(result.run.refund.status,'pending'); assert.equal(db.prepare('SELECT count(*) n FROM test_rentals').get().n,0); assert.equal(db.prepare("SELECT count(*) n FROM records WHERE kind IN ('payment','rental')").get().n,0);
 assert.deepEqual(resolveIntegrationException(db,{exceptionId:exception.id,note:'Reviewed fixture only',actor,now}).runs[0],before);
 throwsStatus(()=>resolveIntegrationException(db,{exceptionId:exception.id,note:'Replace old note',actor,now}),409);
 db.close(); db=openProductionStore(path); t.after(()=>db.close());
 const replay=applyIntegrationScenario(db,{scenario:'refund-pending',idempotencyKey:'review-scenario',actor,now}); assert.equal(replay.replayed,true); assert.deepEqual(replay.run,before);
 throwsStatus(()=>applyIntegrationScenario(db,{scenario:'success',idempotencyKey:'review-scenario',actor,now}),409);
 assert.equal(integrationView(db,now).runs.length,1); const adapter=createIntegrationAdapter({db,now:()=>now}); assert.equal(adapter.queryRefund(before.refund.id).status,'pending');
 throwsStatus(()=>createIntegrationAdapter({mode:'live',db}),503); throwsStatus(()=>adapter.requestEject(),400); throwsStatus(()=>adapter.requestRefund(),400);
 assert.equal(integrationView(db,now).readiness.pvs.ready,false); assert.equal(integrationView(db,now).readiness.wscharge.ready,false);
});


test('review: reconciliation rejects untrusted or stale results without writes, accepts correlated refund result once',async t=>{
 const db=openProductionStore(':memory:');t.after(()=>db.close());
 const run=applyIntegrationScenario(db,{scenario:'refund-pending',idempotencyKey:'reconcile-initial',actor,now}).run;
 const response={rentalId:run.id,operationId:run.operation.id,refundId:run.refund.id,operationStatus:run.operation.status,refundStatus:'succeeded',observedAt:new Date(now).toISOString(),source:'mock',testOnly:true};
 const options={runId:run.id,idempotencyKey:'reconcile-query',actor,now};
 for(const patch of [{source:'pvs'},{rentalId:'different'},{observedAt:new Date(now-1).toISOString()},{operationStatus:'accepted'}]) {
   await assert.rejects(reconcileIntegrationRun(db,{...options,adapter:{mode:'mock',testOnly:true,queryReconciliation:async()=>({...response,...patch})}}),error=>error.status===409);
   assert.deepEqual(integrationView(db,now).runs[0],run);
 }
 let queries=0;
 const adapter={mode:'mock',testOnly:true,queryReconciliation:async()=>{queries++;return response;}};
 const result=await reconcileIntegrationRun(db,{...options,adapter}); assert.equal(result.run.refund.status,'succeeded');assert.equal(result.run.settlementStatus,'settled');assert.equal(result.run.queries.length,1);
 const replay=await reconcileIntegrationRun(db,{...options,adapter});assert.equal(replay.replayed,true);assert.equal(queries,1);assert.equal(replay.run.events.length,result.run.events.length);
 assert.equal(db.prepare("SELECT count(*) n FROM records WHERE kind IN ('payment','rental')").get().n,0);
});


test('review: mock fees use elapsed hours, not a fixed fee',()=>{
 const run=initial();for(const [i,type] of ['payment.succeeded','operation.accepted','pickup.confirmed'].entries())applyNormalizedLabEvent(run,event(type,i+1),now);
 const later=now+3600001;applyNormalizedLabEvent(run,event('return.confirmed',4,{occurredAt:new Date(later).toISOString()}),later);
 assert.equal(run.feeAmount,100000);assert.equal(run.refund.amount,900000);
});

test('review: failed refunds require query before retry, preserve refund identity and never double settle',async t=>{
 const db=openProductionStore(':memory:');t.after(()=>db.close());const run=applyIntegrationScenario(db,{scenario:'refund-failed',idempotencyKey:'failed-fixture',actor,now}).run;
 const options={runId:run.id,idempotencyKey:'retry-command',actor,now};
 await assert.rejects(retryIntegrationRefund(db,options),error=>error.status===409);
 await reconcileIntegrationRun(db,{...options,idempotencyKey:'query-failure'});
 const accepted=await retryIntegrationRefund(db,options);assert.equal(accepted.run.refund.status,'pending');assert.equal(accepted.run.settlementStatus,'refund_pending');assert.equal(accepted.run.refund.id,run.refund.id);assert.equal(accepted.run.refund.amount,run.refund.amount);assert.equal(accepted.run.commands.length,1);
 const replay=await retryIntegrationRefund(db,options);assert.equal(replay.replayed,true);assert.equal(replay.run.commands.length,1);
 await assert.rejects(retryIntegrationRefund(db,{...options,idempotencyKey:'different-command'}),error=>error.status===409);
 const settled=await reconcileIntegrationRun(db,{...options,idempotencyKey:'query-success'});assert.equal(settled.run.refund.status,'succeeded');assert.equal(settled.run.commands.length,1);assert.equal(settled.run.refund.id,run.refund.id);
 await assert.rejects(retryIntegrationRefund(db,{...options,idempotencyKey:'after-settlement'}),error=>error.status===409);
 assert.equal(db.prepare("SELECT count(*) n FROM records WHERE kind IN ('rental','payment')").get().n,0);
});

test('review: concurrent query cannot overwrite a newer query result',async t=>{
 const db=openProductionStore(':memory:');t.after(()=>db.close());const run=applyIntegrationScenario(db,{scenario:'refund-pending',idempotencyKey:'race-fixture',actor,now}).run;
 let release;const paused=new Promise(resolve=>{release=resolve;});
 const oldQuery=reconcileIntegrationRun(db,{runId:run.id,idempotencyKey:'slow-query',actor,now,adapter:{mode:'mock',testOnly:true,queryReconciliation:()=>paused}});
 const latest=await reconcileIntegrationRun(db,{runId:run.id,idempotencyKey:'fresh-query',actor,now});assert.equal(latest.run.refund.status,'succeeded');
 release({rentalId:run.id,operationId:run.operation.id,refundId:run.refund.id,operationStatus:run.operation.status,refundStatus:'pending',observedAt:new Date(now).toISOString(),source:'mock',testOnly:true});
 await assert.rejects(oldQuery,error=>error.status===409);assert.equal(integrationView(db,now).runs[0].refund.status,'succeeded');assert.equal(integrationView(db,now).runs[0].queries.length,1);
});

test('review: fee beyond deposit remains outstanding, never becomes a negative refund or waived fee',()=>{
 const run=initial();for(const [i,type] of ['payment.succeeded','operation.accepted','pickup.confirmed'].entries())applyNormalizedLabEvent(run,event(type,i+1),now);
 const later=now+96*3600000;applyNormalizedLabEvent(run,event('return.confirmed',4,{occurredAt:new Date(later).toISOString()}),later);
 assert.equal(run.feeAmount,1200000);assert.equal(run.refund.amount,0);assert.equal(run.outstandingAmount,200000);assert.equal(run.depositApplied,1000000);assert.equal(run.settlementStatus,'review_required');
 throwsStatus(()=>applyNormalizedLabEvent(run,event('refund.requested',5,{occurredAt:new Date(later).toISOString()}),later),409);
});
