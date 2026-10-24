import test from 'node:test';
import assert from 'node:assert/strict';
import {rentalFee,buyoutBoundary,policyEstimate} from '../src/production-rental-policy.mjs';
const p={policyVersion:1,hourlyRate:50000,dailyCap:300000,totalCap:1000000,maxRentalDays:0};
test('daily billing uses rental-relative 24 hours and no extra hour at exact boundary',()=>{assert.equal(rentalFee(p,86400000),300000);assert.equal(rentalFee(p,86400001),350000);assert.equal(rentalFee({...p,dailyCap:2000000},86400000),1200000);});
test('amount cap and time limit use the earlier deadline and never exceed cap',()=>{assert.deepEqual(buyoutBoundary({...p,totalCap:100000,maxRentalDays:3}),{elapsed:3600001,reason:'total_cap'});assert.deepEqual(buyoutBoundary({...p,maxRentalDays:1}),{elapsed:86400000,reason:'maximum_duration'});const e=policyEstimate({status:'active',startedAt:new Date(0).toISOString(),pricing:p},100*86400000);assert.equal(e.totalAmount,1000000);assert.equal(e.durationSeconds,73*3600);});
