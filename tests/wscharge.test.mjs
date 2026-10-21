import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeWsCharge,
  WS_FIXTURES,
  inspectWsChargeFixture,
} from "../src/wscharge.mjs";
import { createAPI } from "../src/api.mjs";
import { MemoryStore } from "../src/store.mjs";
const fixture = (name) => structuredClone(WS_FIXTURES[name]);
const decode = (f) => decodeWsCharge(f.payload, f);

test("WsCharge explicit fixture profiles preserve raw values and distinguish cabinet/slot", () => {
  for (const name of ["inventory_table", "inventory_example"]) {
    const f = fixture(name),
      o = decode(f);
    assert.deepEqual(o.raw, f.payload);
    assert.equal(o.normalized.cabinetId, "DEMO000000000001");
    assert.equal(o.normalized.banks[0].slot, 3);
    assert.equal(o.normalized.signal, 31);
    assert.equal(o.normalized.freeSlots, null);
    assert.equal(o.normalized.capacity, null);
    assert.equal(o.normalized.inventoryCompleteness, "UNKNOWN");
    assert.deepEqual(o.automaticEffects, []);
    assert.equal(o.authenticated, false);
  }
});
test("WsCharge ambiguous inventory alias rejects; missing entries never prove free slots", () => {
  const f = fixture("inventory_example");
  f.payload.terminalArr[0].L = 4;
  assert.throws(() => decode(f), /Undocumented/);
  f.payload.terminalArr[0].L = 3;
  assert.throws(() => decode(f), /Undocumented/);
  f.payload.terminalArr = [];
  const o = decode(f);
  assert.equal(o.normalized.freeSlots, null);
});
test("WsCharge inventory duplicate slot or bank and invalid battery reject", () => {
  for (const change of [
    (b) => ({ ...b }),
    (b) => ({ ...b, B: "DEMO00000002" }),
    (b) => ({ ...b, E: "04" }),
  ]) {
    const f = fixture("inventory_example");
    f.payload.terminalArr.push(change(f.payload.terminalArr[0]));
    assert.throws(() => decode(f), /Duplicate/);
  }
  const f = fixture("inventory_example");
  f.payload.terminalArr[0].D = 101;
  assert.throws(() => decode(f), /Battery/);
});
test("WsCharge status200 and unknown statuses never authorize pickup/billing", () => {
  for (const name of ["dispense_200", "dispense_unknown"]) {
    const o = decode(fixture(name));
    assert.equal(o.outcome, "UNKNOWN_DISPENSE_EVIDENCE");
    assert.equal(o.liveSendAllowed, false);
    assert.equal(o.eventId, null);
    assert.equal(o.occurredAt, null);
    assert.deepEqual(o.automaticEffects, []);
  }
});
test("WsCharge return remains untrusted without synthesized time/event identity", () => {
  const o = decode(fixture("return_observation"));
  assert.equal(o.outcome, "UNTRUSTED_RETURN_OBSERVATION");
  assert.equal(o.authenticated, false);
  assert.equal(o.occurredAt, null);
  assert.equal(o.eventId, null);
  assert.equal(o.sequence, null);
  assert.deepEqual(o.automaticEffects, []);
});
test("WsCharge rejects unknown fields, code, IDs and incorrect direction", () => {
  const f = fixture("return_observation");
  for (const payload of [
    { ...f.payload, I: 99 },
    { ...f.payload, E: "evil" },
    { ...f.payload, B: "short" },
    { ...f.payload, L: -1 },
    { ...f.payload, occurredAt: 1 },
    { ...f.payload, U: "secret" },
  ])
    assert.throws(() => decodeWsCharge(payload, f));
  assert.throws(() =>
    decodeWsCharge(f.payload, { ...f, direction: "server-to-cabinet" }),
  );
  assert.throws(() => decodeWsCharge(f.payload, { profile: f.profile }));
  assert.throws(() => decodeWsCharge(f.payload, { direction: f.direction }));
});
test("WsCharge preserves conservative encoding profile, rejects coercion", () => {
  const f = fixture("dispense_200");
  for (const L of [3, "3", "-1", "03x", null])
    assert.throws(() => decodeWsCharge({ ...f.payload, L }, f));
  assert.throws(() => decodeWsCharge({ ...f.payload, S: 200 }, f));
  const numeric = { ...f.payload, L: 3, S: 200 };
  assert.equal(
    decodeWsCharge(numeric, { ...f, profile: "table-fields" }).normalized.slot,
    3,
  );
  const inv = fixture("inventory_example");
  for (const X of [31, "1f", "GG", "00", "20"])
    assert.throws(() => decodeWsCharge({ ...inv.payload, X }, inv));
});
test("WsCharge duplicate JSON keys, unsafe object fields, malformed/oversized input reject", () => {
  const f = fixture("cabinet_login");
  for (const raw of [
    '{"I":60,"I":90,"E":"DEMO000000000001"}',
    '{"I":60,"\\u0049":90,"E":"DEMO000000000001"}',
    '{"I":60,"E":"DEMO000000000001","__proto__":{}}',
    "[1]",
    "null",
    "{",
    " ".repeat(8193),
  ])
    assert.throws(() => decodeWsCharge(raw, f));
});
test("WsCharge maintenance is classification only and cannot execute through fixtures", () => {
  for (const I of [80, 81, 67]) {
    const p = { I, E: "DEMO000000000001", ...(I === 80 ? { L: "03" } : {}) };
    const o = decodeWsCharge(p, {
      profile: "example-fields",
      direction: "server-to-cabinet",
    });
    assert.equal(o.maintenance, true);
    assert.equal(o.liveSendAllowed, false);
    assert.deepEqual(o.automaticEffects, []);
    assert.throws(() =>
      inspectWsChargeFixture({ admin: true }, { fixture: String(I) }),
    );
  }
});
test("WsCharge fixture route rejects non-operator and arbitrary supplied protocol actions", async () => {
  const store = new MemoryStore(),
    api = createAPI(store);
  const initial = await api(new Request("https://demo.test/v1/bootstrap"));
  const cookie = initial.headers.get("set-cookie").split(";")[0],
    csrf = (await initial.json()).data.csrf;
  const post = (body) =>
    api(
      new Request("https://demo.test/v1/actions", {
        method: "POST",
        headers: {
          cookie,
          origin: "https://demo.test",
          "content-type": "application/json",
          "x-csrf-token": csrf,
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      }),
    );
  assert.equal(
    (await post({ action: "wscharge_inspect", fixture: "dispense_200" }))
      .status,
    403,
  );
  await post({ action: "login", provider: "google" });
  const quote = (
    await (await post({ action: "quote", stationId: "station_1" })).json()
  ).result.quote;
  const rental = (
    await (
      await post({ action: "rent", quoteId: quote.id, acceptedTerms: true })
    ).json()
  ).result.rental;
  await post({
    action: "pay",
    rentalId: rental.id,
    method: "card",
    scenario: "success",
  });
  await post({ action: "collect", rentalId: rental.id, scenario: "success" });
  await post({ action: "admin_login" });
  assert.equal(store.state.rentals[0].physicalStatus, "ACTIVE");
  const before = await store.read();
  for (const name of Object.keys(WS_FIXTURES)) {
    const r = await post({ action: "wscharge_inspect", fixture: name });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).result.observation.liveSendAllowed, false);
  }
  assert.equal(
    (await post({ action: "wscharge_inspect", fixture: "force_eject" })).status,
    400,
  );
  const after = await store.read();
  // Request bookkeeping is expected. Every business record must be unchanged,
  // including actual outbox, banks, inventory, configuration and active rental.
  delete before.sessions;
  delete before.idempotency;
  delete after.sessions;
  delete after.idempotency;
  assert.deepEqual(after, before);
});
