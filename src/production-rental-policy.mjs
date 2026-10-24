// Integer minor-unit billing. Policies are immutable snapshots on each new order.
const HOUR=3600000,DAY=24*HOUR;
export const hasRentalPolicy=p=>p?.policyVersion===1;
export function rentalFee(p,elapsed){
 const ms=Math.max(0,elapsed),days=Math.floor(ms/DAY),rest=ms%DAY;
 const hours=rest===0?(days===0?1:0):Math.ceil(rest/HOUR);
 return days*Math.min(p.dailyCap,24*p.hourlyRate)+Math.min(hours*p.hourlyRate,p.dailyCap);
}
export function buyoutBoundary(p){
 if(!hasRentalPolicy(p))return null;
 const cap=p.totalCap,dayRate=Math.min(p.dailyCap,24*p.hourlyRate);
 let lo=0,hi=Math.ceil(cap/dayRate)*DAY;
 while(lo<hi){const mid=Math.floor((lo+hi)/2);if(rentalFee(p,mid)>=cap)hi=mid;else lo=mid+1;}
 const deadline=p.maxRentalDays>0?p.maxRentalDays*DAY:Infinity;
 return {elapsed:Math.min(lo,deadline),reason:deadline<lo?'maximum_duration':'total_cap'};
}
export function policyEstimate(r,time){
 const boundary=buyoutBoundary(r.pricing),start=Date.parse(r.startedAt);
 if(!boundary||!Number.isFinite(start))return r;
 const elapsed=Math.max(0,time-start),bounded=Math.min(elapsed,boundary.elapsed);
 return {...r,durationSeconds:Math.floor(bounded/1000),totalAmount:elapsed>=boundary.elapsed?r.pricing.totalCap:Math.min(r.pricing.totalCap,rentalFee(r.pricing,bounded)),buyoutDueAt:new Date(start+boundary.elapsed).toISOString(),buyoutReason:boundary.reason,buyoutWarning:elapsed>=boundary.elapsed*0.8};
}
