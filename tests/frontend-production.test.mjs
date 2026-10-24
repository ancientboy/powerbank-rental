import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const root = new URL('../production-public/', import.meta.url);
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.style = {}; this.children = []; this.dataset = {}; this.events = {}; this.attributes = {}; this.value = ''; this.classList = { add() {}, remove() {}, toggle() {} }; }
  append(...nodes) { this.children.push(...nodes); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(name, handler) { this.events[name] = handler; }
  querySelector(tag) { for (const child of this.children) { if (child.tagName === tag) return child; const found = child.querySelector?.(tag); if (found) return found; } return null; }
  focus() {}
  remove() {}
}
const settle = () => new Promise(resolve => setImmediate(resolve));
async function harness(file, pathname, responses) {
  const elements = new Map(); const requests = []; const redirects = [];
  const context = vm.createContext({ document: { getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, createElement(tag) { return new Element(tag); } }, window: { addEventListener() {} }, location: { pathname, hash: '', search: '', replace(path) { redirects.push(path); } }, URLSearchParams, Intl, Date, console, fetch: async (path, options) => { requests.push({ path, options }); const response = responses[path] || {}; return { ok: response.status ? response.status < 400 : true, status: response.status || 200, json: async () => response.body || response }; } });
  vm.runInContext(await readFile(new URL(file, root), 'utf8'), context); await settle(); await settle(); return { context, elements, requests, redirects };
}
const text = node => [node.textContent || '', ...node.children.map(text)].join(' ');
test('production templates use external scripts, no inline events or legacy customer operations', async () => {
  for (const file of ['index.html', 'admin.html']) { const source = await readFile(new URL(file, root), 'utf8'); assert.doesNotMatch(source, /<script(?![^>]*src=)|\son\w+=/i); }
  const customer = await readFile(new URL('index.html', root), 'utf8'); assert.doesNotMatch(customer, /apple|simulate|\/admin|operations/i);
  for (const file of ['app.js', 'admin.js']) assert.doesNotMatch(await readFile(new URL(file, root), 'utf8'), /innerHTML|insertAdjacentHTML|eval\(/);
});
test('customer empty states and missing Google configuration are explicit', async () => {
  const h = await harness('app.js', '/', { '/api/user/session': { user: null, readiness: { google: { ready: false } } }, '/api/user/stations': { stations: [], pricing: { hourlyRate: 15000, dailyCap: 50000, deposit: 100000, currency: 'ARS' } } });
  assert.match(text(h.elements.get('account-content')), /Google sign-in is unavailable/); assert.match(text(h.elements.get('station-list')), /No stations available yet/); assert.match(h.elements.get('pricing').textContent, /150\.00/); assert.equal(h.requests.length, 2);
});
test('customer Google button uses only configured real OAuth endpoint', async () => {
  const h = await harness('app.js', '/', { '/api/user/session': { user: null, readiness: { google: { ready: true } } }, '/api/user/stations': { stations: [] } });
  const link = h.elements.get('account-content').children.find(n => n.tagName === 'a'); assert.equal(link.href, '/auth/google');
});
test('administrator session failure redirects to independent login', async () => {
  const h = await harness('admin.js', '/admin', { '/api/admin/session': { status: 401, body: { error: 'Sign in required' } } }); assert.deepEqual(h.redirects, ['/admin/login']);
});
test('administrator login view does not fetch protected data', async () => { const h = await harness('admin.js', '/admin/login', {}); assert.equal(h.requests.length, 0); });
test('admin dashboard renders all real-data sections and mutations include CSRF', async () => {
  const h = await harness('admin.js', '/admin', { '/api/admin/session': { user: { username: 'ops', role: 'owner' }, csrf: 'csrf-test' }, '/api/admin/dashboard': { stations: [], users: [], rentals: [], payments: [], support: [], audit: [], pricing: { hourlyRate: 12345 }, readiness: {} } });
  assert.deepEqual(h.elements.get('admin-nav').children.filter(node => node.tagName === 'a').map(node => node.dataset.section), ['dashboard', 'queue', 'stations', 'orders', 'payments', 'users', 'support', 'pricing', 'audit', 'integrations']);
  assert.ok(h.elements.get('admin-nav').children.some(node => node.textContent === 'SETTINGS'));
  for (const section of ['stations', 'pricing', 'orders', 'payments', 'users', 'support', 'audit', 'integrations', 'dashboard']) vm.runInContext(`navigate('${section}')`, h.context);
  await vm.runInContext("api('/api/admin/stations', {method:'POST',body:'{}'})", h.context);
  assert.equal(h.requests.at(-1).options.headers['X-CSRF-Token'], 'csrf-test'); assert.equal(h.requests.at(-1).options.credentials, 'same-origin');
});
test('support status uses accessible inline radio choices, never native popup select', async () => {
  for (const file of ['app.js', 'admin.js']) assert.doesNotMatch(await readFile(new URL(file, root), 'utf8'), /el\(['"]select['"]|createElement\(['"]select['"]/);
  const h = await harness('admin.js', '/admin', { '/api/admin/session': { user: { username: 'ops', role: 'owner' }, csrf: 'csrf-test' }, '/api/admin/dashboard': { support: [{id:'case-one',userId:'user-one',message:'Please help',status:'in_progress'}] } });
  vm.runInContext("navigate('support')", h.context);
  const flat = node => [node,...node.children.flatMap(flat)];
  const nodes=flat(h.elements.get('admin-panel')), radios=nodes.filter(node=>node.tagName==='input'&&node.type==='radio');
  assert.equal(radios.length,4);assert.equal(radios.filter(node=>node.checked).length,1);assert.equal(radios.find(node=>node.checked).value,'in_progress');
  assert.ok(nodes.some(node=>node.tagName==='legend'&&node.textContent==='Request status'));assert.ok(!nodes.some(node=>node.tagName==='select'));
});
test('test login is explicit, uses challenge CSRF and renders test account restrictions', async () => {
  const responses = { '/api/user/session': { user: null, readiness: { google: { ready: false }, googleTest: { ready: true } } }, '/api/user/stations': { stations: [] }, '/api/user/test-login-challenge': { csrf: 'test-challenge' }, '/api/user/test-login': { ok: true }, '/api/user/rentals': { rentals: [] }, '/api/user/support': { support: [] } };
  const h = await harness('app.js', '/', responses);
  const button = h.elements.get('account-content').children.find(n => n.textContent === 'Continue with Google (test)');
  assert.ok(button); assert.match(text(h.elements.get('account-content')), /does not sign in to Google/);
  responses['/api/user/session'] = { user: { id: 'test_customer', name: 'Test customer', isTest: true }, csrf: 'session-csrf', readiness: {} };
  await button.events.click();
  const req = h.requests.find(r => r.path === '/api/user/test-login');
  assert.equal(req.options.headers['X-CSRF-Token'], 'test-challenge');
  assert.equal(req.options.body, '{}');
  assert.match(text(h.elements.get('account-content')), /TEST ACCOUNT/);
  assert.match(text(h.elements.get('account-content')), /hardware actions are disabled/);
  assert.ok(h.requests.some(r => r.path === '/api/user/support'));
});

test('real cabinet waiting and slot battery status appear in the customer stations view without rental actions', async () => {
  const device={cabinetId:'CAB_1',connection:'unknown',inventoryState:'waiting',observedBankCount:null,banks:[],rentalsEnabled:false};
  const h=await harness('app.js','/',{'/api/user/session':{user:null,readiness:{}},'/api/user/stations':{stations:[{id:'device:CAB_1',name:'Cabinet CAB_1',active:true,device}]}});
  assert.match(text(h.elements.get('station-list')),/Waiting for device data/);
  assert.doesNotMatch(text(h.elements.get('station-list')),/0 power banks|Rent here/);
  h.context.sample={...device,connection:'offline',inventoryState:'stale',observedBankCount:1,banks:[{slot:2,batteryPercent:77}]};
  vm.runInContext("stationData.stations[0].device=sample; renderStations()",h.context);
  const output=text(h.elements.get('station-list'));
  assert.match(output,/Last reported offline/);assert.match(output,/Inventory outdated/);assert.match(output,/Slot 2 · Reported battery 77%/);assert.doesNotMatch(output,/Rent here/);
});
test('TEST accounts see real cabinet observations separately and only mock stations have rental buttons', async () => {
  const h=await harness('app.js','/',{'/api/user/session':{user:{id:'test_x',isTest:true},readiness:{}},'/api/user/test/stations':{stations:[{id:'DEMO-001',name:'Mock station',active:true,available:3}]},'/api/user/stations':{stations:[{id:'device:CAB_1',name:'Real cabinet',device:{connection:'unknown',inventoryState:'waiting',observedBankCount:null,banks:[]}}]}});
  for(let i=0;i<4;i++)await settle();
  const output=text(h.elements.get('station-list'));assert.match(output,/Smile stations/);assert.match(output,/Waiting for device data/);assert.match(output,/Mock station/);
  const real=h.elements.get('station-list').children.find(n=>text(n).includes('Real cabinet')&&n.tagName==='article');assert.ok(real);assert.equal(real.children.some(n=>n.tagName==='button'),false);
});
test('admin Stations and Overview display configured cabinets, unknown inventory and reported power banks', async () => {
  const device={cabinetId:'CAB_1',connection:'unknown',inventoryState:'waiting',observedBankCount:null,banks:[]};
  const h=await harness('admin.js','/admin',{'/api/admin/session':{user:{role:'viewer'},csrf:'x'},'/api/admin/dashboard':{deviceCabinets:[device],stations:[]}});
  assert.match(text(h.elements.get('admin-panel')),/Cabinets and power banks/);
  vm.runInContext("navigate('stations')",h.context);
  assert.match(text(h.elements.get('admin-panel')),/CAB_1/);assert.match(text(h.elements.get('admin-panel')),/Waiting for device data/);
  h.context.sample={...device,inventoryState:'stale',observedBankCount:1,banks:[{slot:1,bankId:'BANK_1',batteryPercent:75,statusCode:200}]};
  vm.runInContext('data.deviceCabinets=[sample]; render()',h.context);
  const output=text(h.elements.get('admin-panel'));assert.match(output,/BANK_1/);assert.match(output,/Outdated/);assert.match(output,/75/);assert.match(output,/Rentable availability Unknown/);
});

test('cabinet lamps show reported presence and low battery, while stale/offline data never appears available',async()=>{
 const flat=n=>[n,...n.children.flatMap(flat)];
 const device={cabinetId:'CAB_1',connection:'online',inventoryState:'observed',observedBankCount:3,banks:[{slot:8,batteryPercent:20},{slot:3,batteryPercent:100},{slot:4,batteryPercent:85}]};
 const h=await harness('app.js','/',{'/api/user/session':{user:null,readiness:{}},'/api/user/stations':{stations:[{id:'device:CAB_1',name:'Cabinet',active:true,device}]}});
 let nodes=flat(h.elements.get('station-list'));
 assert.equal(nodes.filter(n=>n.className==='cabinet-slot is-present').length,2);assert.equal(nodes.filter(n=>n.className==='cabinet-slot is-low').length,1);
 assert.deepEqual(nodes.filter(n=>n.attributes.role==='listitem').map(n=>n.attributes['aria-label']),['Slot 3, present, reported battery 100 percent','Slot 4, present, reported battery 85 percent','Slot 8, low battery, reported battery 20 percent']);
 assert.match(text(h.elements.get('station-list')),/lights show presence, not availability/);assert.ok(nodes.some(n=>n.tagName==='details'&&n.open!==true));
 for(const sample of [{...device,inventoryState:'stale'},{...device,connection:'offline'}]){
 h.context.sample=sample;vm.runInContext('stationData.stations[0].device=sample; renderStations()',h.context);nodes=flat(h.elements.get('station-list'));
 assert.equal(nodes.filter(n=>n.className==='cabinet-slot is-unknown').length,3);assert.equal(nodes.filter(n=>n.className==='cabinet-slot is-present').length,0);assert.match(text(h.elements.get('station-list')),/Last known slots/);
 }
});

test('station map links use saved coordinates; homepage waits for explicit location, including test accounts', async () => {
  const flat=n=>[n,...n.children.flatMap(flat)];
  const station={id:'s',name:'Store',address:'Street',locationNotes:'Near reception',latitude:-34.6037,longitude:-58.3816,active:true};
  for(const isTest of [false,true]) {
    const h=await harness('app.js','/',{'/api/user/session':{user:isTest?{id:'demo',isTest:true}:null},'/api/user/stations':{stations:[station]},'/api/user/test/stations':{stations:[{id:'demo',name:'Virtual',latitude:10,longitude:10}]}});
    assert.doesNotMatch(text(h.elements.get('home-station')), /Street|Near reception/);
    for(const id of ['station-list']) {
      const links=flat(h.elements.get(id)).filter(n=>n.href?.startsWith('https://www.google.com/maps/'));
      assert.equal(links.length,2);assert.equal(links[0].href,'https://www.google.com/maps/search/?api=1&query=-34.6037%2C-58.3816');
      assert.equal(links[1].href,'https://www.google.com/maps/dir/?api=1&destination=-34.6037%2C-58.3816');assert.equal(links[0].rel,'noopener noreferrer');
      assert.match(text(h.elements.get(id)),/Near reception/);
    }
    for(const coords of [[null,null],['',0],[91,0],[0,181]]) {
      h.context.stationFixture={...station,latitude:coords[0],longitude:coords[1]};
      vm.runInContext("stationData={stations:[stationFixture]};session.user=null;renderStations();",h.context);
      assert.equal(flat(h.elements.get('station-list')).filter(n=>n.href?.includes('google.com/maps')).length,0);
    }
    vm.runInContext('stationFixture.latitude=0;stationFixture.longitude=0;renderStations()',h.context);
    assert.ok(flat(h.elements.get('station-list')).some(n=>n.href?.endsWith('query=0%2C0')));
  }
});

test('station QR loads only after expansion, retains offline/pause warnings, copies exact link and survives rerender', async()=>{
 const id='CAB_QR',url='https://smilepower.shop/rent?cabinet='+id,endpoint='/api/user/station-qr?cabinet='+id;
 const h=await harness('app.js','/',{'/api/user/session':{user:null,readiness:{}},'/api/user/stations':{stations:[{id:'s',name:'My store',cabinetId:id,active:true,device:{cabinetId:id,connection:'offline',inventoryState:'stale',newRentalsPaused:true,banks:[]}}]},[endpoint]:{cabinetId:id,stationName:'My store',url}});
 const flat=n=>[n,...n.children.flatMap(flat)];let panel=h.elements.get('station-list');
 assert.match(text(panel),/Offline/);assert.match(text(panel),/New rentals paused/);assert.ok(!h.requests.some(r=>r.path===endpoint));
 let detail=flat(panel).find(n=>n.tagName==='details'&&text(n).includes('View cabinet QR code'));
 detail.open=true;detail.events.toggle();await settle();await settle();
 assert.equal(h.requests.filter(r=>r.path===endpoint).length,1);let nodes=flat(detail);
 assert.ok(nodes.some(n=>n.tagName==='img'&&n.src===endpoint+'&format=png'));
 assert.ok(nodes.some(n=>n.tagName==='a'&&n.href===endpoint+'&format=png&download=1'));
 assert.ok(nodes.some(n=>n.tagName==='a'&&n.href===url));
 let copied='';h.context.navigator={clipboard:{writeText:async value=>{copied=value;}}};
 await nodes.find(n=>n.textContent==='Copy rental link').events.click();assert.equal(copied,url);assert.match(text(detail),/Rental link copied/);
 delete h.context.navigator;let selected=false;nodes.find(n=>n.tagName==='input').select=()=>{selected=true;};
 await nodes.find(n=>n.textContent==='Copy rental link').events.click();assert.equal(selected,true);assert.match(text(detail),/Select and copy/);
 vm.runInContext('renderStations()',h.context);panel=h.elements.get('station-list');detail=flat(panel).find(n=>n.tagName==='details'&&text(n).includes('View cabinet QR code'));assert.equal(detail.open,true);
 await settle();await settle();nodes=flat(detail);nodes.find(n=>n.tagName==='img').events.error();assert.ok(nodes.find(n=>n.textContent==='Save QR image').hidden);
 assert.equal(h.requests.filter(r=>r.options?.method==='POST').length,0);
});
test('station without cabinet has no QR; failed QR load is explicit and can be retried', async()=>{
 const h=await harness('app.js','/',{'/api/user/session':{user:null,readiness:{}},'/api/user/stations':{stations:[{id:'a',name:'No cabinet',active:true},{id:'b',name:'Bound',cabinetId:'BOUND',active:true}]},'/api/user/station-qr?cabinet=BOUND':{status:404,body:{error:'Station not available'}}});
 const flat=n=>[n,...n.children.flatMap(flat)],panel=h.elements.get('station-list');
 const details=flat(panel).filter(n=>n.tagName==='details'&&text(n).includes('View cabinet QR code'));assert.equal(details.length,1);
 details[0].open=true;details[0].events.toggle();await settle();await settle();assert.match(text(details[0]),/QR code unavailable/);
 details[0].open=false;details[0].events.toggle();details[0].open=true;details[0].events.toggle();await settle();await settle();assert.equal(h.requests.filter(r=>r.path.includes('/station-qr')).length,2);
});

const homeFlat = n => [n, ...n.children.flatMap(homeFlat)];
const homeRental = { id: 'rent-active', cabinetId: 'CAB_ACTIVE', slot: 3, bankId: 'BANK_ONE', status: 'active', startedAt: '2026-10-23T10:00:00Z', durationSeconds: 3900, totalAmount: 10000, pricing: { currency: 'ARS', hourlyRate: 5000 } };
function homeResponses(rentals = [], stations = []) {
  return { '/api/user/session': { user: { id: 'home-user', isTest: false }, csrf: 'csrf' }, '/api/user/rentals': { hardwareRentals: rentals, serverNow: '2026-10-23T11:05:00Z' }, '/api/user/support': { support: [] }, '/api/user/stations': { stations, pricing: { hourlyRate: 99999, currency: 'ARS' } } };
}
test('homepage gives active rental priority, uses its recorded fee, and links to the exact order without mutations', async () => {
  const responses = homeResponses([{ ...homeRental, id: 'pending', status: 'pending_payment' }, homeRental], [{ name: 'Unrelated first station', cabinetId: 'CAB_OTHER' }]);
  const h = await harness('app.js', '/', responses);
  const content = text(h.elements.get('home-current-rental'));
  assert.match(content, /In use/); assert.match(content, /CAB_ACTIVE/); assert.match(content, /Slot 3/); assert.match(content, /1h 5m/);
  assert.doesNotMatch(content, /Unrelated first station/); assert.equal(h.elements.get('home-scan-label').textContent, 'View current rental');
  assert.match(h.elements.get('home-price').textContent, /100\.00/);
  h.context.location.assign = path => h.redirects.push(path);
  vm.runInContext('startRental()', h.context);
  assert.deepEqual(h.redirects, ['/rent?cabinet=CAB_ACTIVE&order=rent-active']);
  assert.equal(h.requests.some(r => r.options?.method === 'POST'), false);
});
test('homepage does not select the first station or ask for location automatically', async () => {
  const h = await harness('app.js', '/', homeResponses([], [{ name: 'Far first station', latitude: 80, longitude: 80 }]));
  assert.doesNotMatch(text(h.elements.get('home-station')), /Far first station/);
  assert.match(text(h.elements.get('home-station')), /Use my location/);
  assert.equal(h.elements.get('home-scan-label').textContent, 'Scan to rent');
});
test('explicit location sorts real stations by distance, accepts zero coordinates, preserves offline status and never uploads coordinates', async () => {
  const stations = [{ name: 'Far', latitude: 1, longitude: 1 }, { name: 'Near', latitude: 0, longitude: 0.01, device: { connection: 'online', inventoryState: 'observed' } }, { name: 'Closest', latitude: 0, longitude: 0, device: { connection: 'offline' } }, { name: 'Invalid', latitude: null, longitude: null }, { name: 'Hidden', active: false, latitude: 0, longitude: 0 }];
  const h = await harness('app.js', '/', homeResponses([], stations)); const before = h.requests.length;
  let options;
  h.context.navigator = { geolocation: { getCurrentPosition(success, failure, opts) { options = opts; success({ coords: { latitude: 0, longitude: 0, accuracy: 10 } }); } } };
  vm.runInContext('locateNearbyStations()', h.context);
  const content = text(h.elements.get('home-station')); assert.match(content, /Closest/); assert.match(content, /0 m away/); assert.match(content, /Offline/);
  assert.doesNotMatch(content, /Near reception|Hidden|Invalid|Far/);
  assert.ok(homeFlat(h.elements.get('home-station')).some(n => n.href?.endsWith('destination=0%2C0')));
  assert.equal(h.requests.length, before); assert.equal(options.timeout, 10000);
  assert.ok(Math.abs(vm.runInContext('stationDistanceKm({latitude:0,longitude:0},{latitude:0,longitude:1})', h.context) - 111.195) < 0.01);
});
test('location denial, timeout, imprecision, and missing mapped stations all retain a browse fallback', async () => {
  const h = await harness('app.js', '/', homeResponses([], [{ name: 'Far', latitude: 10, longitude: 10 }, { name: 'Missing', latitude: null, longitude: null }]));
  for (const code of [1, 3]) {
    h.context.navigator = { geolocation: { getCurrentPosition(success, fail) { fail({ code }); } } };
    vm.runInContext('locateNearbyStations()', h.context);
    assert.match(text(h.elements.get('home-station')), /browse all stations/); assert.match(text(h.elements.get('home-station')), /permission was not granted|Could not find your location/);
  }
  h.context.navigator = { geolocation: { getCurrentPosition(success) { success({ coords: { latitude: 0, longitude: 0, accuracy: 9000 } }); } } };
  vm.runInContext('locateNearbyStations()', h.context); assert.match(text(h.elements.get('home-station')), /not precise enough/);
  h.context.navigator.geolocation.getCurrentPosition = success => success({ coords: { latitude: 0, longitude: 0, accuracy: 20 } });
  vm.runInContext('locateNearbyStations()', h.context); assert.match(text(h.elements.get('home-station')), /No mapped stations found within 5 km/); assert.doesNotMatch(text(h.elements.get('home-station')), /Far|Missing/);
});
test('late geolocation cannot replace a newly active rental; returned rentals restore station discovery', async () => {
  const responses = homeResponses([], [{ name: 'Nearby', latitude: 0, longitude: 0 }]);
  const h = await harness('app.js', '/', responses); let resolve;
  h.context.navigator = { geolocation: { getCurrentPosition(success) { resolve = success; } } };
  vm.runInContext('locateNearbyStations()', h.context);
  responses['/api/user/rentals'].hardwareRentals = [homeRental]; await vm.runInContext('memberData()', h.context);
  resolve({ coords: { latitude: 0, longitude: 0, accuracy: 20 } });
  assert.match(text(h.elements.get('home-current-rental')), /CAB_ACTIVE/); assert.doesNotMatch(text(h.elements.get('home-current-rental')), /Nearby/);
  responses['/api/user/rentals'].hardwareRentals = [{ ...homeRental, status: 'completed' }]; await vm.runInContext('memberData()', h.context);
  assert.equal(h.elements.get('home-current-rental').children.length, 0); assert.match(text(h.elements.get('home-station')), /Nearby/);
});
test('rental load failure retains last rental, while unknown rental state never recommends a new one', async () => {
  const responses = homeResponses([homeRental]); const h = await harness('app.js', '/', responses);
  responses['/api/user/rentals'] = { status: 503 }; await vm.runInContext('memberData()', h.context);
  assert.match(text(h.elements.get('home-current-rental')), /CAB_ACTIVE/); assert.match(text(h.elements.get('home-current-rental')), /last known rental/);
  const unknown = await harness('app.js', '/', responses);
  assert.match(text(unknown.elements.get('home-station')), /rental status could not be loaded/); assert.equal(unknown.elements.get('home-scan-label').textContent, 'Check rental status');
  responses['/api/user/session'] = { user: null }; await vm.runInContext('refreshSession()', h.context);
  assert.equal(h.elements.get('home-current-rental').children.length, 0); assert.doesNotMatch(text(h.elements.get('home-station')), /CAB_ACTIVE/);
});
test('pending, dispatching and review orders precede discovery without claiming active rental time', async () => {
  for (const status of ['pending_payment', 'dispatching', 'review_required']) {
    const h = await harness('app.js', '/', homeResponses([{ ...homeRental, status, startedAt: null }]));
    const content = text(h.elements.get('home-current-rental')); assert.match(content, /CAB_ACTIVE/); assert.doesNotMatch(content, /Rental duration/);
    assert.equal(h.elements.get('home-scan-label').textContent, 'View current rental');
    assert.match(content, status === 'review_required' ? /needs checking/ : /timer starts after release is confirmed/);
  }
});
test('homepage keeps demo rentals on home and never recommends mock stations as nearby', async () => {
  const responses = homeResponses(); responses['/api/user/session'].user.isTest = true;
  responses['/api/user/test/state'] = { rental: { ...homeRental, stationId: 'DEMO-001', stationName: 'Demo station' }, rentals: [], serverNow: '2026-10-23T11:05:00Z' };
  responses['/api/user/test/stations'] = { stations: [{ name: 'Fake nearby', latitude: 0, longitude: 0 }] };
  const h = await harness('app.js', '/', responses);
  assert.match(text(h.elements.get('home-current-rental')), /Demo power bank · TEST/); assert.notEqual(h.context.location.hash, '#scan');
  responses['/api/user/test/state'].rental = null; await vm.runInContext('memberData()', h.context);
  h.context.navigator = { geolocation: { getCurrentPosition(success) { success({ coords: { latitude: 0, longitude: 0, accuracy: 20 } }); } } };
  vm.runInContext('locateNearbyStations()', h.context); assert.doesNotMatch(text(h.elements.get('home-station')), /Fake nearby/); assert.match(text(h.elements.get('home-station')), /No mapped stations/);
});
