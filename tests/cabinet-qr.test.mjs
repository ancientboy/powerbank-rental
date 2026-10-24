import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { inflateSync, crc32 } from 'node:zlib';
import vm from 'node:vm';
import { openProductionStore, putRecord } from '../src/production-store.mjs';
import { createProductionAPI } from '../src/production-api.mjs';
const decoder = { module: { exports: {} }, exports: {} };
vm.runInNewContext(readFileSync(new URL('../production-public/jsQR.js', import.meta.url), 'utf8'), decoder);
const jsQR = decoder.module.exports;
const config = { publicOrigin: 'https://smilepower.shop', secure: true, sessionSeconds: 3600, wschargeCabinets: ['TDMB081675764251'] };
function fixture(t, role = 'owner') {
  const db = openProductionStore(':memory:'); t.after(() => db.close());
  db.prepare('INSERT INTO admins VALUES(?,?,?,?,0)').run('qr-admin','qr-admin','unused',role);
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(createHash('sha256').update(token).digest('hex'),'admin','qr-admin','qr-csrf',Date.now()+3600000);
  const api = createProductionAPI({db,config});
  const request = (path, {auth=true, body, host}={}) => api(new Request(config.publicOrigin+path,{method:body?'POST':'GET',headers:{ ...(auth?{cookie:'voltgo_admin='+token}:{}), ...(host?{host}:{}), ...(body?{'content-type':'application/json',origin:config.publicOrigin,'x-csrf-token':'qr-csrf'}:{})},body:body?JSON.stringify(body):undefined}));
  return {db, request};
}
function decodePng(bytes) {
  const b = Buffer.from(bytes); assert.equal(b.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  let width, height, data=[];
  for (let pos=8;pos<b.length;) {
    const length=b.readUInt32BE(pos), type=b.toString('ascii',pos+4,pos+8), part=b.subarray(pos+8,pos+8+length);
    assert.equal(b.readUInt32BE(pos+8+length),crc32(b.subarray(pos+4,pos+8+length)));
    if(type==='IHDR'){width=part.readUInt32BE(0);height=part.readUInt32BE(4);assert.equal(part[8],8);assert.equal(part[9],0);}
    if(type==='IDAT')data.push(part);pos+=length+12;
  }
  const raw=inflateSync(Buffer.concat(data)), pixels=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++){assert.equal(raw[y*(width+1)],0);for(let x=0;x<width;x++){const value=raw[y*(width+1)+x+1],i=(y*width+x)*4;pixels[i]=pixels[i+1]=pixels[i+2]=value;pixels[i+3]=255;if(x<48||y<48||x>=width-48||y>=height-48)assert.equal(value,255);}}
  return jsQR(pixels,width,height)?.data;
}
function decodeSvg(svg) {
  const size=Number(svg.match(/viewBox="0 0 (\d+)/)[1]),scale=8,width=size*scale;
  const pixels=new Uint8ClampedArray(width*width*4).fill(255);
  for(const match of svg.matchAll(/M(\d+),(\d+)h1v1h-1z/g)){
    const x=Number(match[1]),y=Number(match[2]);assert.ok(x>=4&&x<size-4&&y>=4&&y<size-4);
    for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++){const i=((y*scale+dy)*width+x*scale+dx)*4;pixels[i]=pixels[i+1]=pixels[i+2]=0;}
  }
  return jsQR(pixels,width,width)?.data;
}
test('configured cabinet produces independently decodable PNG and SVG with stable formal URL', async t=>{
  const {db,request}=fixture(t); const before=db.prepare('SELECT count(*) AS n FROM records').get().n;
  for(const format of ['png','svg']){
    const r=await request('/api/admin/cabinet-qr?cabinet=TDMB081675764251&format='+format+'&download=1',{host:'attacker.example'});
    assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.match(r.headers.get('content-disposition'),/attachment; filename="Smile-TDMB081675764251-QR/);
    const decoded=format==='png'?decodePng(await r.arrayBuffer()):decodeSvg(await r.text());
    assert.equal(decoded,'https://smilepower.shop/rent?cabinet=TDMB081675764251');
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM records').get().n,before);
});
test('saving a cabinet binding automatically enables QR; location edits keep it identical', async t=>{
  const {request}=fixture(t);const draft={name:'Store',address:'A street',cabinetId:'NEW_Cab-123',active:true};
  let r=await request('/api/admin/stations',{body:draft});assert.equal(r.status,200);const saved=await r.json();
  const path='/api/admin/cabinet-qr?cabinet=NEW_Cab-123';
  const metadata=await(await request(path)).json();assert.equal(metadata.deviceConfigured,false);assert.equal(metadata.stationName,'Store');
  const before=await(await request(path+'&format=png')).arrayBuffer();assert.equal(decodePng(before),'https://smilepower.shop/rent?cabinet=NEW_Cab-123');
  r=await request('/api/admin/stations',{body:{...saved,name:'Moved',address:'B street',active:false}});assert.equal(r.status,200);
  const after=await(await request(path+'&format=png')).arrayBuffer();assert.deepEqual(Buffer.from(before),Buffer.from(after));
  assert.equal((await request('/api/admin/stations',{body:draft})).status,409);
});
test('QR reads require admin authentication, allow viewer, and reject unknown or invalid IDs/formats', async t=>{
  const {request}=fixture(t,'viewer'),base='/api/admin/cabinet-qr?cabinet=';
  assert.equal((await request(base+'TDMB081675764251',{auth:false})).status,401);
  assert.equal((await request(base+'TDMB081675764251')).status,200);
  assert.equal((await request(base+'UNKNOWN')).status,404);
  for(const id of ['', 'a'.repeat(65), '../etc', 'A%0D%0AB', 'A%26evil']) assert.equal((await request(base+id)).status,400);
  assert.equal((await request(base+'TDMB081675764251&format=html')).status,400);
});
test('new bindings must be scannable; existing legacy IDs remain editable without silently changing labels', async t=>{
  const {db,request}=fixture(t);const draft={name:'Store',address:'A street',active:true};
  for(const id of ['a'.repeat(65),'has space','bad/path'])assert.equal((await request('/api/admin/stations',{body:{...draft,cabinetId:id}})).status,400);
  putRecord(db,'station','legacy',{...draft,id:'legacy',cabinetId:'old invalid'});
  assert.equal((await request('/api/admin/stations',{body:{...draft,id:'legacy',cabinetId:'old invalid',address:'Updated'}})).status,200);
  assert.equal((await request('/api/admin/cabinet-qr?cabinet=old%20invalid')).status,400);
});
test('maximum-length cabinet ID preserves exact case and punctuation after decoding', async t=>{
  const {db,request}=fixture(t);const id='Ab_9-'.repeat(12)+'AB12';
  putRecord(db,'station','long',{id:'long',name:'Long ID',cabinetId:id});
  assert.equal(decodePng(await(await request('/api/admin/cabinet-qr?cabinet='+id+'&format=png')).arrayBuffer()),config.publicOrigin+'/rent?cabinet='+id);
});

test('public QR matches admin image exactly, exposes no admin metadata and cannot access hidden cabinets', async t=>{
  const {db,request}=fixture(t);
  putRecord(db,'station','visible',{id:'visible',name:'Public store',cabinetId:'TDMB081675764251',active:true});
  const path='/api/user/station-qr?cabinet=TDMB081675764251';
  const info=await(await request(path,{auth:false})).json();
  assert.deepEqual(Object.keys(info).sort(),['cabinetId','stationName','url']);
  assert.equal(info.url,'https://smilepower.shop/rent?cabinet=TDMB081675764251');
  const publicImage=await(await request(path+'&format=png',{auth:false})).arrayBuffer();
  const adminImage=await(await request('/api/admin/cabinet-qr?cabinet=TDMB081675764251&format=png')).arrayBuffer();
  assert.deepEqual(Buffer.from(publicImage),Buffer.from(adminImage));assert.equal(decodePng(publicImage),info.url);
  putRecord(db,'station','visible',{id:'visible',name:'Hidden store',cabinetId:'TDMB081675764251',active:false});
  // A cached image must not bypass the current visibility check.
  assert.equal((await request(path+'&format=png',{auth:false})).status,404);
  assert.equal((await request(path,{auth:false})).status,404);
  assert.equal((await request('/api/admin/cabinet-qr?cabinet=TDMB081675764251&format=png')).status,200);
  assert.equal((await request('/api/user/station-qr?cabinet=UNKNOWN',{auth:false})).status,404);
  assert.equal((await request('/api/user/station-qr?cabinet=bad%2Fpath',{auth:false})).status,400);
});
test('public QR exists for an active bound station before supplier setup, and performs no rental writes', async t=>{
  const {db,request}=fixture(t);
  putRecord(db,'station','new',{id:'new',name:'New store',cabinetId:'NEW_QR',active:true});
  const before=JSON.stringify(db.prepare('SELECT * FROM records ORDER BY kind,id').all());
  assert.equal((await request('/api/user/station-qr?cabinet=NEW_QR&format=png&download=1',{auth:false})).status,200);
  assert.equal((await request('/api/user/station-qr?cabinet=NEW_QR&format=svg',{auth:false})).status,400);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM records ORDER BY kind,id').all()),before);
});
