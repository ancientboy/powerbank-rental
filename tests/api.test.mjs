import test from "node:test";
import assert from "node:assert/strict";
import { createAPI } from "../src/api.mjs";
import { MemoryStore } from "../src/store.mjs";
async function client(api) {
  let r = await api(new Request("https://demo.test/v1/bootstrap"));
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const data = (await r.json()).data;
  return {
    cookie,
    csrf: data.csrf,
    async post(body, key = crypto.randomUUID(), extra = {}) {
      return api(
        new Request("https://demo.test/v1/actions", {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
            origin: "https://demo.test",
            "x-csrf-token": data.csrf,
            "idempotency-key": key,
            ...extra,
          },
          body: JSON.stringify(body),
        }),
      );
    },
    async get() {
      return api(
        new Request("https://demo.test/v1/bootstrap", { headers: { cookie } }),
      );
    },
  };
}
test("S02 Origin and CSRF protection", async () => {
  const c = await client(createAPI(new MemoryStore()));
  for (const extra of [
    { origin: "https://evil.test" },
    { "x-csrf-token": "bad" },
  ])
    assert.equal(
      (
        await c.post(
          { action: "login", provider: "google" },
          crypto.randomUUID(),
          extra,
        )
      ).status,
      403,
    );
});
test("same key same request replays once; different request conflicts", async () => {
  const store = new MemoryStore(),
    c = await client(createAPI(store));
  const key = crypto.randomUUID(),
    body = { action: "login", provider: "google" };
  assert.equal((await c.post(body, key)).status, 200);
  assert.equal((await (await c.post(body, key)).json()).replayed, true);
  assert.equal((await c.post({ ...body, provider: "apple" }, key)).status, 409);
  assert.equal(store.state.users.length, 1);
});
test("S03 separate demo operator authorization", async () => {
  const api = createAPI(new MemoryStore()),
    a = await client(api),
    b = await client(api);
  await a.post({ action: "admin_login" });
  assert.equal(
    (
      await b.post({
        action: "config",
        rentalsEnabled: false,
        reason: "unauthorized test",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await a.post({
        action: "config",
        rentalsEnabled: false,
        reason: "authorized test",
      })
    ).status,
    200,
  );
});
test("webhook boundary disabled and malformed JSON rejected", async () => {
  const api = createAPI(new MemoryStore());
  const r = await api(
    new Request("https://demo.test/v1/webhooks/payments/pvs", {
      method: "POST",
    }),
  );
  assert.equal(r.status, 503);
});
test("full API journey persists separate physical and money states", async () => {
  const store = new MemoryStore(),
    api = createAPI(store),
    c = await client(api);
  async function act(body) {
    const response = await c.post(body);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  await act({ action: "login", provider: "apple" });
  const q = (await act({ action: "quote", stationId: "station_1" })).result
    .quote;
  const rental = (
    await act({ action: "rent", quoteId: q.id, acceptedTerms: true })
  ).result.rental;
  await act({
    action: "pay",
    rentalId: rental.id,
    method: "apple_pay",
    scenario: "success",
  });
  await act({ action: "collect", rentalId: rental.id, scenario: "success" });
  await act({ action: "advance", minutes: 80 });
  const returned = await act({
    action: "return",
    rentalId: rental.id,
    stationId: "station_2",
  });
  assert.equal(returned.data.rentals[0].physicalStatus, "RETURNED");
  assert.equal(returned.data.rentals[0].refundStatus, "PENDING");
  await act({ action: "reconcile", rentalId: rental.id });
  const recovered = createAPI(
    new MemoryStore(JSON.parse(JSON.stringify(store.state))),
  );
  const final = await recovered(
    new Request("https://demo.test/v1/bootstrap", {
      headers: { cookie: c.cookie },
    }),
  );
  assert.equal((await final.json()).data.rentals[0].financialStatus, "SETTLED");
});
test("restore fence applies through HTTP and suppresses automatic queued jobs", async () => {
  const store = new MemoryStore(),
    api = createAPI(store),
    c = await client(api);
  async function post(body) {
    return (await c.post(body)).json();
  }
  await post({ action: "login", provider: "google" });
  await post({ action: "admin_login" });
  const q = (await post({ action: "quote", stationId: "station_1" })).result
    .quote;
  const r = (await post({ action: "rent", quoteId: q.id, acceptedTerms: true }))
    .result.rental;
  await post({
    action: "pay",
    rentalId: r.id,
    method: "card",
    scenario: "success",
  });
  await post({ action: "collect", rentalId: r.id });
  await post({ action: "return", rentalId: r.id, stationId: "station_2" });
  const backup = (
    await post({ action: "backup_export", reason: "Mock restore regression" })
  ).result.backup;
  const preview = (
    await post({
      action: "restore_preview",
      backupId: backup.id,
      reason: "Mock restore regression",
    })
  ).result.preview;
  await post({
    action: "restore_apply",
    previewId: preview.id,
    reason: "Mock restore regression",
  });
  store.state.clockOffset += 60000;
  const before = (await (await c.get()).json()).data;
  assert.equal(before.rentals[0].refundStatus, "PENDING");
  assert.equal(
    (await c.post({ action: "retry_refund", rentalId: r.id })).status,
    409,
  );
  await post({
    action: "reconcile_provider",
    reason: "Verify external operation history",
  });
  const after = (await (await c.get()).json()).data;
  assert.equal(after.rentals[0].refundStatus, "SUCCEEDED");
});
test("QR server validates anonymous official codes and rejects foreign URL", async () => {
  const c = await client(createAPI(new MemoryStore()));
  assert.equal(
    (await c.post({ action: "resolve", code: "PAL01" })).status,
    200,
  );
  assert.equal(
    (
      await c.post({
        action: "resolve",
        code: "https://evil.test/?station=PAL01",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await c.post({
        action: "resolve",
        code: "https://demo.test/?station=PAL01",
      })
    ).status,
    200,
  );
});
