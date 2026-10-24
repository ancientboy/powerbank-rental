import {cabinetControl,assertNewRentalAllowed} from './production-cabinet-control.mjs';
import {reconcileHardwareEvent,blockingHardwareCommand} from './production-hardware-rental.mjs';
/** WsCharge HTTP gateway. Supplier command acceptance is never physical pickup.
 * Callback POST/JSON, shared token and Unix-second freshness are a local ingress
 * contract requiring supplier confirmation, not a claimed vendor signature scheme.
 */
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { listRecords, putRecord, transaction, recordAudit } from './production-store.mjs';
export const WSCHARGE_ENDPOINT = 'https://powerbank.cnwoshi.com/DeviceReceive/receive';
export const WSCHARGE_NOTIFY_PATH = '/api/integrations/wscharge/notify';
const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
const hash = value => createHash('sha256').update(value).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const iso = time => new Date(time).toISOString();
const canonical = value => JSON.stringify(value, (key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k,v[k]])) : v);
const get = (db, kind, id) => { const r = db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,id); return r ? JSON.parse(r.data) : null; };
const secretOK = s => typeof s === 'string' && s.length >= 16 && s.length <= 1024 && /^[\x21-\x7E]+$/.test(s);
const configured = c => c.wschargeEnabled === true && secretOK(c.wschargeApiToken) && secretOK(c.wschargeCallbackToken) && Array.isArray(c.wschargeCabinets) && c.wschargeCabinets.length > 0 && c.wschargeCabinets.every(identifier);
function allowed(c, cabinetId) {
  if (!configured(c)) fail(503, 'WsCharge gateway is not configured');
  if (!identifier(cabinetId) || !c.wschargeCabinets.includes(cabinetId)) fail(403, 'Cabinet is not allowlisted');
}
export function wschargeStatus(config) {
  return { enabled: config.wschargeEnabled === true, configured: configured(config), dispatchEnabled: configured(config) && config.wschargeDispatchEnabled === true, callbackPath: WSCHARGE_NOTIFY_PATH, callbackContract: 'GET/empty POST connectivity probe; POST form-data or JSON notifications with body token and Unix-seconds timestamp', automaticSettlement: false, maintenanceCommands: false };
}
export function wschargeView(db, config, time = Date.now()) {
  const recent = kind => listRecords(db,kind).sort((a,b) => String(b.receivedAt || b.createdAt).localeCompare(String(a.receivedAt || a.createdAt))).slice(0,200);
  const connections=listRecords(db,'wscharge_event').filter(e=>[60,90].includes(e.code) && e.freshness==='within_window' && e.observedAtSeconds*1000<=time).sort((a,b)=>b.observedAtSeconds-a.observedAtSeconds || b.code-a.code);
  return { ...wschargeStatus(config), serverNow: iso(time), commands: recent('wscharge_command'), events: recent('wscharge_event'), inventory: recent('wscharge_inventory').map(r => {
    const connection=connections.find(e=>e.cabinetId===r.cabinetId);
    const offline=connection?.code===90 && connection.observedAtSeconds>=r.observedAtSeconds;
    return {...r, stale: offline || time - r.observedAtSeconds * 1000 > 120000, observedConnection: offline ? 'offline' : connection?.code===60 ? 'online' : 'unknown', available: null, completeness: 'unknown'};
  }) };

}
// Read-only device projections. Configuration alone never implies online or rentable.
export function wschargeCabinets(db, config, time = Date.now()) {
  const events = listRecords(db, 'wscharge_event').filter(e => e.freshness === 'within_window' && e.observedAtSeconds * 1000 <= time);
  const inventory = listRecords(db, 'wscharge_inventory');
  return [...new Set(config.wschargeCabinets || [])].map(cabinetId => {
    const rows = events.filter(e => e.cabinetId === cabinetId).sort((a,b) => b.observedAtSeconds - a.observedAtSeconds || b.code - a.code);
    const connectionEvent = rows.find(e => [60,64,90].includes(e.code));
    const latest = rows[0];
    const sample = inventory.find(e => e.cabinetId === cabinetId && e.observedAtSeconds * 1000 <= time);
    const offline = connectionEvent?.code === 90;
    const connection = offline ? 'offline' : connectionEvent && time - connectionEvent.observedAtSeconds * 1000 <= 120000 ? 'online' : 'unknown';
    const changed = sample && rows.some(e => [65,66,80,81,67,90].includes(e.code) && e.observedAtSeconds >= sample.observedAtSeconds);
    const stale = Boolean(sample && (time - sample.observedAtSeconds * 1000 > 120000 || changed || offline));
    const station=listRecords(db,'station').find(s=>s.cabinetId===cabinetId);
    return { cabinetId, newRentalsPaused:cabinetControl(db,cabinetId).paused, station:station?{name:station.name,openingHours:station.openingHours||'',returnInstructions:station.returnInstructions||'',capacity:station.capacity??null}:null, gatewayEnabled: config.wschargeEnabled === true,
      connection: config.wschargeEnabled ? connection : 'unknown',
      inventoryState: !sample ? 'waiting' : stale || !config.wschargeEnabled ? 'stale' : 'observed',
      lastObservedAt: latest ? iso(latest.observedAtSeconds * 1000) : null,
      inventoryObservedAt: sample ? iso(sample.observedAtSeconds * 1000) : null,
      observedBankCount: sample ? sample.banks.length : null,
      banks: (sample?.banks || []).map(b => ({ slot: b.slot, bankId: b.bankId, batteryPercent: b.batteryPercent, statusCode: b.statusCode ?? null })),
      rentableAvailable: null, rentalsEnabled: false };
  });
}
export function customerStations(db, config, time = Date.now()) {
  const cabinets = wschargeCabinets(db, config, time);
  const stations = listRecords(db, 'station');
  const publicDevice = d => d ? { ...d, banks: d.banks.map(b => ({ slot: b.slot, batteryPercent: b.batteryPercent })) } : null;
  const result = stations.filter(s => s.active).map(s => ({ ...s, device: publicDevice(cabinets.find(c => c.cabinetId === s.cabinetId)) }));
  // Show allowlisted cabinets awaiting location setup without inventing a station/address.
  if (config.wschargeEnabled) for (const d of cabinets) {
    if (!stations.some(s => s.cabinetId === d.cabinetId)) result.push({ id: 'device:' + d.cabinetId, cabinetId: d.cabinetId,
      name: 'Cabinet ' + d.cabinetId, address: '', active: true, locationPending: true, device: publicDevice(d) });
  }
  return result;
}
function number(value, min, max, label) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value)<min || Number(value)>max) fail(400, 'Invalid ' + label);
  return Number(value);
}
function parseEvent(body, time, maxSkewSeconds = 300) {
  if (!body || Array.isArray(body) || typeof body !== 'object') fail(400,'JSON object required');
  if (![60,90,64,65,66,80,81,67].includes(body.I) || !identifier(body.E)) fail(400,'Invalid callback code or cabinet');
  const fields = ['I','E','timestamp','token', ...({60:[],90:[],64:['K','X','terminalArr','S'],65:['L','B','S'],66:['L','B'],80:['L','S'],81:['S'],67:['S']}[body.I])];
  if (Object.keys(body).some(k=>!fields.includes(k))) fail(400,'Undocumented callback field for this code');
  const timestamp = number(body.timestamp,1,9999999999,'Unix-seconds timestamp');
  const freshness = Math.abs(time - timestamp * 1000) <= maxSkewSeconds * 1000 ? 'within_window' : 'outside_window';
  const event = { code:body.I, cabinetId:body.E, observedAtSeconds:timestamp, freshness };
  if ([65,66,80].includes(body.I)) event.slot=number(body.L,1,128,'slot');
  if ([65,66].includes(body.I)) { if (!identifier(body.B)) fail(400,'Invalid bank identifier'); event.bankId=body.B; }
  if ([65,80,81,67].includes(body.I)) event.statusCode=number(body.S,0,999,'status');
  if (body.I===64) {
    if (body.K !== undefined && (typeof body.K !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(body.K))) fail(400,'Invalid IoT identifier');
    if (body.S !== undefined) event.statusCode=number(body.S,0,999,'inventory status');
    if (!Array.isArray(body.terminalArr) || body.terminalArr.length>128) fail(400,'Invalid inventory');
    const slots=new Set(), banks=new Set();
    event.banks=body.terminalArr.map(input=>{
      if (!input || typeof input!=='object' || Array.isArray(input)) fail(400,'Invalid inventory bank');
      const b={};
      for(const key of Object.keys(input)) {
        const field=key.trim();
        if (!['B','L','D','S'].includes(field) || Object.hasOwn(b,field)) fail(400,'Unknown or colliding inventory field');
        b[field]=input[key];
      }
      if (!identifier(b.B)) fail(400,'Invalid inventory bank');
      const slot=number(b.L,1,128,'inventory slot');
      if (slots.has(slot)||banks.has(b.B)) fail(400,'Duplicate inventory slot or bank');
      slots.add(slot);banks.add(b.B);
      const bank={bankId:b.B,slot,batteryPercent:number(b.D,0,100,'battery percentage')};
      if (b.S!==undefined) bank.statusCode=number(b.S,0,999,'bank status');
      return bank;
    });
    if (body.X!==undefined) {
      const signal=typeof body.X==='string' && /^[0-9A-Fa-f]{1,2}$/.test(body.X) ? parseInt(body.X,16) : body.X;
      event.signal=number(signal,1,31,'signal');
    }
    // IoT SIM identifier K is intentionally not retained.
  }
  return event;
}
// Reject duplicate JSON keys rather than silently authenticating/recording a
// different interpretation from a proxy or supplier. Depth is bounded as well.
function parseCallbackJSON(raw) {
  const stack=[];
  for(let i=0;i<raw.length;i++) {
    const c=raw[i];
    if(c==='"') {
      const start=i++;
      for(;i<raw.length;i++) { if(raw[i]==='\\')i++;else if(raw[i]==='"')break; }
      let next=i+1;while(/\s/.test(raw[next]||'x'))next++;
      if(raw[next]===':' && stack.at(-1)?.keys) {
        const key=JSON.parse(raw.slice(start,i+1));
        if(stack.at(-1).keys.has(key))fail(400,'Duplicate callback field');
        stack.at(-1).keys.add(key);
      }
    } else if(c==='{' || c==='[') {
      stack.push({keys:c==='{'?new Set():null});
      if(stack.length>5)fail(400,'Callback nesting too deep');
    } else if(c==='}' || c===']') stack.pop();
  }
  return JSON.parse(raw);
}
async function parseCallbackForm(raw, contentType) {
  let form;
  try { form=await new Response(raw,{headers:{'content-type':contentType}}).formData(); }
  catch { fail(400,'Invalid callback form'); }
  const body=Object.create(null), slots=new Map();let count=0;
  for(const [key,value] of form) {
    if(++count>520 || typeof value!=='string') fail(400,'Invalid callback form field');
    const nested=/^terminalArr\[(0|[1-9]\d{0,2})\]\[(B|L|D|S)\]$/.exec(key);
    if(nested) {
      const index=Number(nested[1]);if(index>=128)fail(400,'Invalid inventory index');
      if(!slots.has(index))slots.set(index,Object.create(null));
      const bank=slots.get(index);if(Object.hasOwn(bank,nested[2]))fail(400,'Duplicate callback field');
      bank[nested[2]]=value;
    } else {
      if(Object.hasOwn(body,key))fail(400,'Duplicate callback field');
      body[key]=value;
    }
  }
  if(slots.size) {
    if(Object.hasOwn(body,'terminalArr'))fail(400,'Conflicting inventory encodings');
    body.terminalArr=[...slots].sort((a,b)=>a[0]-b[0]).map(([index,bank],i)=>{
      if(index!==i)fail(400,'Non-contiguous inventory indices');return bank;
    });
  } else if(Object.hasOwn(body,'terminalArr')) {
    try { body.terminalArr=parseCallbackJSON(body.terminalArr); }
    catch { fail(400,'Invalid inventory JSON'); }
  }
  if(Object.hasOwn(body,'I'))body.I=number(body.I,0,999,'function code');
  return body;
}
export async function receiveWscharge(db, config, req, time = Date.now()) {
  if (!configured(config)) fail(503,'WsCharge callback intake is disabled');
  if(new URL(req.url).search)fail(400,'Callback parameters must be in the request body');
  const probe=()=>({code:200,probe:true,received:false});
  // Supplier checks reachability before sending the authenticated notification.
  // A probe never creates an event, changes inventory, or acknowledges device data.
  if(req.method==='GET')return probe();
  if(req.method!=='POST')fail(405,'GET probe or POST notification required');
  const raw=await req.text();
  if(Buffer.byteLength(raw)>16384)fail(413,'Callback too large');
  if(raw.length===0)return probe();
  const contentType=req.headers.get('content-type')||'';
  const mediaType=contentType.split(';')[0].trim().toLowerCase();
  let body;
  if(mediaType==='application/json') {
    try { body=parseCallbackJSON(raw); } catch { fail(400,'Invalid callback JSON'); }
  } else if(['multipart/form-data','application/x-www-form-urlencoded'].includes(mediaType)) {
    body=await parseCallbackForm(raw,contentType);
    if(Object.keys(body).length===0)return probe();
  } else fail(415,'JSON or form-data required');
  const token=body?.token;
  if (typeof token!=='string' || !timingSafeEqual(Buffer.from(hash(token)),Buffer.from(hash(config.wschargeCallbackToken)))) fail(401,'Callback authentication failed');
  allowed(config,body.E);
  const event=parseEvent(body,time,config.wschargeMaxClockSkewSeconds || 300);
  const { freshness: _freshness, ...identity } = event;
  const id=hash(canonical(identity));
  return transaction(db,()=>{
    const previous=get(db,'wscharge_event',id);
    if (previous) return {code:200,received:true,duplicate:true};
    const candidates=event.freshness === 'outside_window' ? [] : listRecords(db,'wscharge_command').filter(c=>c.cabinetId===event.cabinetId && c.code===event.code && (event.slot===undefined || c.slot===event.slot) && Math.abs(Date.parse(c.createdAt)-event.observedAtSeconds*1000)<=300000).map(c=>c.id);
    const saved={...event,id,receivedAt:iso(time),authentication:'shared_token',trustedForSettlement:false,disposition:'observation_only',candidateCommandIds:candidates};
    putRecord(db,'wscharge_event',id,saved);
    reconcileHardwareEvent(db,saved,time);
    if (event.code===64 && event.freshness === 'within_window' && event.observedAtSeconds * 1000 <= time) {
      const prior=get(db,'wscharge_inventory',event.cabinetId);
      if (!prior || prior.observedAtSeconds<event.observedAtSeconds) putRecord(db,'wscharge_inventory',event.cabinetId,saved);
    }
    return {code:200,received:true,duplicate:false};
  });
}
export async function sendWschargeCommand({db,config,actor,body,idempotencyKey,time=Date.now(),fetchImpl=fetch,rentalId=null}) {
  if (actor?.role!=='owner') fail(403,'Owner role required');
  if (!body || Object.keys(body).some(k=>!['code','cabinetId','slot'].includes(k)) || ![64,65].includes(body.code)) fail(400,'Only inventory query 64 or controlled pickup 65 is supported');
  allowed(config,body.cabinetId);
  if (body.code===65 && config.wschargeDispatchEnabled!==true) fail(403,'Physical dispatch is disabled');
  const slot=body.code===65 ? number(body.slot,1,128,'slot') : null;
  if (body.code===64 && body.slot!==undefined) fail(400,'Inventory query has no slot');
  if (typeof idempotencyKey!=='string' || !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) fail(400,'Valid Idempotency-Key required');
  const key=hash(actor.id+'\n'+idempotencyKey), fingerprint=hash(canonical({code:body.code,cabinetId:body.cabinetId,slot}));
  const previous=get(db,'wscharge_command_key',key);
  if (previous) {
    if (previous.fingerprint!==fingerprint) fail(409,'Idempotency key already used for a different command');
    return {command:get(db,'wscharge_command',previous.commandId),replayed:true};
  }
  const command=transaction(db,()=>{
    if(body.code===65)assertNewRentalAllowed(db,body.cabinetId);
    if (body.code===65 && listRecords(db,'wscharge_command').some(c=>rentalId?blockingHardwareCommand(db,c,body.cabinetId,slot):c.code===65 && c.cabinetId===body.cabinetId && !c.reconciledAt)) fail(409,'Prior pickup command requires manual supplier reconciliation; automatic re-dispatch is blocked');
    const c={id:randomUUID(),code:body.code,cabinetId:body.cabinetId,slot,createdAt:iso(time),actorId:actor.id,status:'unknown',physicalPickupConfirmed:false};
    if(rentalId){
      const r=get(db,'hardware_rental',rentalId);
      if(body.code!==65||!r||r.userId!==actor.id||r.status!=='dispatching'||r.commandId||r.cabinetId!==c.cabinetId||r.slot!==slot)fail(409,'Invalid rental reservation');
      c.rentalId=rentalId;r.commandId=c.id;putRecord(db,'hardware_rental',r.id,r,r.userId);
    }
    putRecord(db,'wscharge_command',c.id,c);putRecord(db,'wscharge_command_key',key,{fingerprint,commandId:c.id});
    recordAudit(db,actor.id,'wscharge.command.attempt',c.id,time);return c;
  });
  const form=new FormData();form.set('token',config.wschargeApiToken);form.set('E',command.cabinetId);form.set('I',String(command.code));if(slot!==null)form.set('L',String(slot));
  try {
    const response=await fetchImpl(WSCHARGE_ENDPOINT,{method:'POST',body:form,redirect:'error',signal:AbortSignal.timeout(8000)});
    // Bound and sanitize response; never persist supplier text which can echo credentials.
    const reader=response.body?.getReader();let bytes=0,parts=[];
    if(reader)for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>16384){await reader.cancel();throw new Error('oversized');}parts.push(value);}
    let result;try{result=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{result=null;}
    command.httpStatus=response.status;
    if(response.ok && result?.code===200)command.status='accepted';
    // Rejection and transport errors remain uncertain: no blind retry or billing.
  } catch { command.status='unknown'; }
  Object.assign(command,{...get(db,'wscharge_command',command.id),status:command.status,httpStatus:command.httpStatus});
  putRecord(db,'wscharge_command',command.id,command);
  return {command,replayed:false};
}
