import test from 'node:test';
import assert from 'node:assert/strict';
import { openProductionStore, putRecord } from '../src/production-store.mjs';
import { wschargeCabinets, customerStations, receiveWscharge } from '../src/production-wscharge.mjs';
import { createProductionAPI } from '../src/production-api.mjs';
const now = Date.parse('2026-10-23T10:00:00Z');
const token = 'synthetic-only-device-status-token';
const config = { publicOrigin:'https://rental.example', wschargeEnabled:true, wschargeApiToken:token, wschargeCallbackToken:token, wschargeCabinets:['CAB_1'], wschargeDispatchEnabled:false };
async function notify(db, code, offset=0, extra={}) {
  return receiveWscharge(db,config,new Request(config.publicOrigin+'/api/integrations/wscharge/notify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,I:code,E:'CAB_1',timestamp:String((now+offset)/1000),...extra})}),now+Math.max(offset,0));
}
test('configured cabinet is visible without station metadata but never implies inventory or online', t => {
  const db=openProductionStore(':memory:');t.after(()=>db.close());
  const [d]=wschargeCabinets(db,config,now);
  assert.equal(d.connection,'unknown');assert.equal(d.inventoryState,'waiting');assert.equal(d.observedBankCount,null);assert.equal(d.rentableAvailable,null);
  const [s]=customerStations(db,config,now);assert.equal(s.locationPending,true);assert.equal(s.address,'');assert.equal(s.device.rentalsEnabled,false);
  assert.deepEqual(customerStations(db,{...config,wschargeEnabled:false},now),[]);
});
test('public endpoint exposes sanitized slot battery observations, not internal device IDs, tokens or events', async t => {
  const db=openProductionStore(':memory:');t.after(()=>db.close());
  await notify(db,64,0,{terminalArr:[{B:'PRIVATE_BANK_ID',L:'01',D:81}],K:'PrivateSIM'});
  const api=createProductionAPI({db,config,now:()=>now});
  const response=await api(new Request(config.publicOrigin+'/api/user/stations'));
  assert.equal(response.status,200);const data=await response.json();const d=data.stations[0].device;
  assert.equal(d.inventoryState,'observed');assert.equal(d.connection,'online');assert.equal(d.observedBankCount,1);
  assert.deepEqual(d.banks,[{slot:1,batteryPercent:81}]);assert.equal(d.rentableAvailable,null);
  assert.doesNotMatch(JSON.stringify(data),/PRIVATE_BANK_ID|PrivateSIM|synthetic-only|candidateCommandIds|actorId/);
  assert.equal(wschargeCabinets(db,config,now)[0].banks[0].bankId,'PRIVATE_BANK_ID');
});
test('stale, offline and post-inventory device changes invalidate freshness without discarding the historical sample', async t => {
  const db=openProductionStore(':memory:');t.after(()=>db.close());
  await notify(db,64,0,{terminalArr:[{B:'BANK_1',L:1,D:81}]});
  assert.equal(wschargeCabinets(db,config,now+120001)[0].inventoryState,'stale');
  assert.equal(wschargeCabinets(db,config,now+120001)[0].connection,'unknown');
  await notify(db,66,1000,{L:2,B:'BANK_2'});
  assert.equal(wschargeCabinets(db,config,now+1000)[0].inventoryState,'stale');
  await notify(db,90,2000);
  const d=wschargeCabinets(db,config,now+2000)[0];assert.equal(d.connection,'offline');assert.equal(d.inventoryState,'stale');assert.equal(d.banks.length,1);
  await notify(db,64,3000,{terminalArr:[]});
  const fresh=wschargeCabinets(db,config,now+3000)[0];assert.equal(fresh.connection,'online');assert.equal(fresh.inventoryState,'observed');assert.equal(fresh.observedBankCount,0);assert.equal(fresh.rentableAvailable,null);
});
test('future or outside-window observations cannot produce a current station status', async t => {
  const db=openProductionStore(':memory:');t.after(()=>db.close());
  putRecord(db,'wscharge_event','future',{cabinetId:'CAB_1',code:60,observedAtSeconds:(now+1000)/1000,freshness:'within_window'});
  putRecord(db,'wscharge_event','old',{cabinetId:'CAB_1',code:60,observedAtSeconds:(now-1000)/1000,freshness:'outside_window'});
  assert.equal(wschargeCabinets(db,config,now)[0].connection,'unknown');
});
test('station association preserves metadata, hides disabled locations and avoids duplicate fallback cabinets', t => {
  const db=openProductionStore(':memory:');t.after(()=>db.close());
  putRecord(db,'station','s1',{id:'s1',name:'Actual location',address:'Known address',cabinetId:'CAB_1',active:true});
  let stations=customerStations(db,config,now);assert.equal(stations.length,1);assert.equal(stations[0].name,'Actual location');assert.equal(stations[0].device.inventoryState,'waiting');
  putRecord(db,'station','s1',{id:'s1',name:'Actual location',cabinetId:'CAB_1',active:false});
  assert.deepEqual(customerStations(db,config,now),[]);
  assert.equal(wschargeCabinets(db,config,now).length,1);
});
