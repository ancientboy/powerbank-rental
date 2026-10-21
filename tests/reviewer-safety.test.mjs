import test from "node:test";
import assert from "node:assert/strict";
import { createAPI } from "../src/api.mjs";
import { MemoryStore } from "../src/store.mjs";
import { apply, seed, drainJobs, bill } from "../src/domain.mjs";
async function client(api) {
  const response = await api(new Request("https://demo.test/v1/bootstrap"));
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const { data } = await response.json();
  return async (body, key = crypto.randomUUID()) =>
    api(
      new Request("https://demo.test/v1/actions", {
        method: "POST",
        headers: {
          cookie,
          origin: "https://demo.test",
          "content-type": "application/json",
          "x-csrf-token": data.csrf,
          "idempotency-key": key,
        },
        body: JSON.stringify(body),
      }),
    );
}
test("reviewer A05 idempotency replay after identity switch cannot reveal another user rental", async () => {
  const post = await client(createAPI(new MemoryStore()));
  await post({ action: "login", provider: "google" });
  const quote = (
    await (await post({ action: "quote", stationId: "station_1" })).json()
  ).result.quote;
  const key = crypto.randomUUID(),
    body = { action: "rent", quoteId: quote.id, acceptedTerms: true };
  assert.equal((await post(body, key)).status, 200);
  await post({ action: "login", provider: "apple" });
  const replay = await post(body, key);
  const payload = await replay.json();
  assert.ok(
    replay.status >= 400 || !payload.result?.rental,
    "Cached result must not return a rental owned by the previous identity",
  );
});
test("reviewer A05 unrelated support cases are isolated between demo identities", () => {
  const state = seed(),
    google = {},
    apple = {};
  apply(state, google, { action: "login", provider: "google" });
  apply(state, apple, { action: "login", provider: "apple" });
  const first = apply(state, google, {
    action: "support",
    category: "GENERAL",
    message: "Google account question",
  }).case;
  const second = apply(state, apple, {
    action: "support",
    category: "GENERAL",
    message: "Apple account question",
  }).case;
  assert.notEqual(
    first.id,
    second.id,
    "Unrelated users cannot share/overwrite a no-rental support case",
  );
  assert.equal(first.userId, google.userId);
});
test("reviewer duplicate successful payment attempts never create multiple charges or dispense operations", async () => {
  const store = new MemoryStore(),
    post = await client(createAPI(store));
  await post({ action: "login", provider: "google" });
  const q = (
    await (await post({ action: "quote", stationId: "station_1" })).json()
  ).result.quote;
  const r = (
    await (
      await post({ action: "rent", quoteId: q.id, acceptedTerms: true })
    ).json()
  ).result.rental;
  const key = crypto.randomUUID(),
    body = {
      action: "pay",
      rentalId: r.id,
      method: "card",
      scenario: "success",
    };
  const responses = await Promise.all(
    Array.from({ length: 20 }, () => post(body, key)),
  );
  assert.ok(responses.every((r) => r.status === 200));
  assert.equal(
    store.state.operations.filter((o) => o.type === "CHARGE").length,
    1,
  );
  assert.equal(store.state.ledger.filter((o) => o.type === "CHARGE").length, 1);
  assert.equal(
    store.state.outbox.filter((o) => o.type === "DISPENSE").length,
    1,
  );
});
test("reviewer failed transaction never persists partial expired-state mutation", async () => {
  const store = new MemoryStore();
  await assert.rejects(
    store.transact((s) => {
      s.config.rentalsEnabled = false;
      throw Error("fault before commit");
    }),
  );
  assert.equal((await store.read()).config.rentalsEnabled, true);
});
test("reviewer D08 bank B returns into bank A origin slot and can be rented while A remains active", () => {
  const s = seed(),
    a = {},
    b = {};
  apply(s, a, { action: "login", provider: "google" });
  apply(s, b, { action: "login", provider: "apple" });
  function start(user, stationId) {
    const q = apply(s, user, { action: "quote", stationId }).quote;
    const r = apply(s, user, {
      action: "rent",
      quoteId: q.id,
      acceptedTerms: true,
    }).rental;
    apply(s, user, { action: "pay", rentalId: r.id, method: "card" });
    apply(s, user, { action: "collect", rentalId: r.id });
    return r;
  }
  const ra = start(a, "station_1"),
    rb = start(b, "station_2");
  apply(s, b, { action: "return", rentalId: rb.id, stationId: "station_1" });
  const originalSlot = s.stations[0].slots.find(
    (x) => x.id === ra.originSlotId,
  );
  assert.equal(originalSlot.bankId, rb.bankId);
  const rc = start(b, "station_1");
  assert.equal(rc.bankId, rb.bankId);
  assert.notEqual(rc.bankId, ra.bankId);
  assert.equal(ra.physicalStatus, "ACTIVE");
});

test("reviewer late-payment manual query preserves newly created refund recovery job", () => {
  const s = seed(),
    user = {};
  apply(s, user, { action: "login", provider: "google" });
  const q = apply(s, user, { action: "quote", stationId: "station_1" }).quote;
  const r = apply(s, user, {
    action: "rent",
    quoteId: q.id,
    acceptedTerms: true,
  }).rental;
  apply(s, user, {
    action: "pay",
    rentalId: r.id,
    method: "card",
    scenario: "unknown",
  });
  const late = r.reservationExpiresAt + 1;
  apply(s, user, { action: "reconcile", rentalId: r.id }, late);
  assert.equal(r.physicalStatus, "EXPIRED");
  assert.equal(r.refundStatus, "PENDING");
  assert.equal(
    s.outbox.find((j) => j.type === "QUERY_REFUND").status,
    "PENDING",
  );
  drainJobs(s, late + 9000);
  assert.equal(r.refundStatus, "SUCCEEDED");
  assert.equal(s.ledger.filter((l) => l.type === "REFUND").length, 1);
});
test("reviewer API integrates out-of-order return reconciliation without a second command", async () => {
  const store = new MemoryStore(),
    post = await client(createAPI(store));
  async function act(body) {
    const response = await post(body);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  await act({ action: "login", provider: "google" });
  const q = (await act({ action: "quote", stationId: "station_1" })).result
    .quote;
  const r = (await act({ action: "rent", quoteId: q.id, acceptedTerms: true }))
    .result.rental;
  await act({ action: "pay", rentalId: r.id, method: "card" });
  await act({
    action: "scenario_return_before_start",
    rentalId: r.id,
    stationId: "station_2",
  });
  const result = await act({ action: "reconcile", rentalId: r.id });
  assert.equal(result.data.rentals[0].physicalStatus, "RETURNED");
  assert.equal(
    store.state.outbox.filter((x) => x.type === "DISPENSE").length,
    1,
  );
});
test("reviewer API clock-review hold does not display calculated received-time fee", async () => {
  const post = await client(createAPI(new MemoryStore()));
  async function act(body) {
    const response = await post(body);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  await act({ action: "login", provider: "google" });
  const q = (await act({ action: "quote", stationId: "station_1" })).result
    .quote;
  const r = (await act({ action: "rent", quoteId: q.id, acceptedTerms: true }))
    .result.rental;
  await act({ action: "pay", rentalId: r.id, method: "card" });
  await act({ action: "collect", rentalId: r.id });
  await act({ action: "advance", minutes: 80 });
  const result = await act({
    action: "scenario_clock_drift",
    rentalId: r.id,
    stationId: "station_2",
  });
  assert.equal(result.data.rentals[0].billingHold, true);
  assert.equal(
    result.data.rentals[0].estimatedFeeMinor,
    null,
    "Untrusted time has no valid fee estimate until evidence review",
  );
});
