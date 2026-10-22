import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
const root = new URL('../', import.meta.url);
const source = file => readFile(new URL(file, root), 'utf8');

test('Smile is the visible brand in customer, admin and demo templates', async () => {
  for (const file of ['production-public/index.html', 'production-public/admin.html', 'public/index.html']) {
    const html = await source(file);
    assert.match(html, /<title>Smile ·/);
    assert.match(html, /rel="icon" type="image\/svg\+xml" href="\/smile-mark.svg"/);
    assert.doesNotMatch(html, /voltgo/i);
  }
  const customer = await source('production-public/index.html');
  assert.match(customer, /id="brand-home"[^>]*aria-label="Smile home"/);
  assert.match(customer, /class="brand-mark"[^>]*alt=""[^>]*>Smile<\/button>/);
  for (const id of ['mobile-home', 'mobile-stations', 'mobile-history', 'mobile-profile']) assert.ok(customer.includes(`id="${id}"`));
  assert.match(await source('production-public/admin.js'), /document.title = `Smile ·/);
  assert.match(await source('production-public/app.js'), /Smile support/);
  assert.match(await source('public/app.js'), /aria-label="Smile home"/);
});

test('mark stays vector-only, rounded, gradient and identical between production and demo', async () => {
  const svg = await source('production-public/smile-mark.svg');
  assert.equal(svg, await source('public/smile-mark.svg'));
  assert.match(svg, /viewBox="0 0 96 96"/);
  assert.match(svg, /linearGradient/);
  assert.match(svg, /stroke-linecap="round"/);
  assert.match(svg, /#39ada3/);
  assert.match(svg, /#ffd45b/);
  assert.doesNotMatch(svg, /<image|<script|data:|https?:\/\/(?!www.w3.org)/);
});

test('rebrand keeps existing browser state and authentication namespaces', async () => {
  const app = await source('production-public/app.js');
  assert.match(app, /getItem\('voltgo-login-route'\)/);
  assert.match(app, /getItem\('voltgo-support-draft'\)/);
  assert.match(await source('public/app.js'), /voltgoModal/);
  const api = await source('src/production-api.mjs');
  for (const key of ['voltgo_admin', 'voltgo_user', 'voltgo_oauth', 'voltgo_test_browser']) assert.ok(api.includes(key));
  assert.match(await source('.env.example'), /\/var\/lib\/voltgo\/production.sqlite/);
});

test('production serves branded pages and SVG with correct MIME under its existing CSP', async t => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const dir = await mkdtemp(join(tmpdir(), 'smile-brand-'));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['scripts/start.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PUBLIC_ORIGIN: origin, ALLOW_LOCAL_HTTP: '1', DATABASE_PATH: join(dir, 'test.sqlite'), GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped; } await rm(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start')), 10000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); });
    child.stdout.on('data', data => { if (String(data).includes('server listening')) { clearTimeout(timer); resolve(); } });
  });
  for (const path of ['/', '/admin', '/admin/login']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<title>Smile ·/);
  }
  const response = await fetch(origin + '/smile-mark.svg');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/svg+xml');
  assert.match(response.headers.get('content-security-policy'), /img-src 'self' data:/);
  assert.equal(await response.text(), await source('production-public/smile-mark.svg'));
  const head = await fetch(origin + '/smile-mark.svg', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
