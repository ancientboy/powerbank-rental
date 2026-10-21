import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProductionAPI } from '../src/production-api.mjs';
import { openProductionStore } from '../src/production-store.mjs';
const config = { publicOrigin: 'https://rental.example', secure: true, enableGoogleTestLogin: true, userSessionSeconds: 3600, sessionSeconds: 3600 };
test('test browser identity and session survive database reopen, disabling on startup revokes both', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voltgo-test-login-'));
  let db = openProductionStore(join(dir, 'data.sqlite'));
  let api = createProductionAPI({ db, config });
  const request = (path, cookie = '', csrf, body) => api(new Request(config.publicOrigin + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin: config.publicOrigin, 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  try {
    let r = await request('/api/user/test-login-challenge');
    const browser = r.headers.get('set-cookie').split(';')[0];
    const challenge = await r.json();
    r = await request('/api/user/test-login', browser, challenge.csrf, {});
    const loginCookie = r.headers.get('set-cookie').split(';')[0];
    const initial = await (await request('/api/user/session', loginCookie)).json();
    assert.equal(initial.user.isTest, true);
    db.close(); db = openProductionStore(join(dir, 'data.sqlite')); api = createProductionAPI({ db, config });
    const reopened = await (await request('/api/user/session', loginCookie)).json();
    assert.equal(reopened.user.id, initial.user.id);
    r = await request('/api/user/test-login-challenge', browser);
    const challenge2 = await r.json();
    r = await request('/api/user/test-login', browser + '; ' + loginCookie, challenge2.csrf, {});
    const secondCookie = r.headers.get('set-cookie').split(';')[0];
    const second = await (await request('/api/user/session', secondCookie)).json();
    assert.equal(second.user.id, initial.user.id);
    assert.equal((await (await request('/api/user/session', loginCookie)).json()).user, null, 'login rotates old session when presented');
    api = createProductionAPI({ db, config: { ...config, enableGoogleTestLogin: false } });
    assert.equal(db.prepare("SELECT count(*) n FROM test_login_states").get().n, 0);
    api = createProductionAPI({ db, config });
    assert.equal((await (await request('/api/user/session', secondCookie)).json()).user, null);
    assert.equal(db.prepare("SELECT count(*) n FROM test_users").get().n, 1, 'historical test data retained');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
