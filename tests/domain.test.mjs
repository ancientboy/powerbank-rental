import test from "node:test";
import assert from "node:assert/strict";
import { seed, apply, bill, publicState, ACTIVE } from "../src/domain.mjs";
import { MemoryStore, D1Store } from "../src/store.mjs";
function fixture() {
  const s = seed(),
    session = {};
  apply(s, session, { action: "login", provider: "google" });
  return { s, session };
}
function rent(f) {
  const q = apply(f.s, f.session, {
    action: "quote",
    stationId: "station_1",
  }).quote;
  return apply(f.s, f.session, {
    action: "rent",
    quoteId: q.id,
    acceptedTerms: true,
  }).rental;
}
function fund(f, r, scenario = "success") {
  apply(f.s, f.session, {
    action: "pay",
    rentalId: r.id,
    method: "card",
    scenario,
  });
}
function collect(f, r, scenario = "success") {
  apply(f.s, f.session, { action: "collect", rentalId: r.id, scenario });
}
function ret(f, r, scenario = "success") {
  apply(f.s, f.session, {
    action: "return",
    rentalId: r.id,
    stationId: "station_2",
    scenario,
  });
}
test("A01/A02 stable provider identity and A04 no email merge", () => {
  const f = fixture();
  const id = f.session.userId;
  apply(f.s, f.session, { action: "login", provider: "google" });
  assert.equal(f.session.userId, id);
  apply(f.s, f.session, { action: "login", provider: "apple" });
  assert.notEqual(f.session.userId, id);
  assert.equal(f.s.users.length, 2);
});
test("A05 ownership enforcement", () => {
  const f = fixture(),
    r = rent(f);
  apply(f.s, f.session, { action: "login", provider: "apple" });
  assert.throws(() => fund(f, r), /Rental not found/);
});
test("Q03 offline station blocked", () => {
  const f = fixture();
  assert.throws(
    () => apply(f.s, f.session, { action: "quote", stationId: "station_4" }),
    /not accepting/,
  );
});
test("Q05 duplicate active rentals prevented", () => {
  const f = fixture();
  rent(f);
  assert.throws(() => rent(f), /already have/);
});
test("Q06 expired quote cannot rent", () => {
  const f = fixture();
  const q = apply(f.s, f.session, {
    action: "quote",
    stationId: "station_1",
  }).quote;
  assert.throws(
    () =>
      apply(
        f.s,
        f.session,
        { action: "rent", quoteId: q.id, acceptedTerms: true },
        q.expiresAt + 1,
      ),
    /expired/,
  );
});
test("P03 declined payment does not dispense", () => {
  const f = fixture(),
    r = rent(f);
  fund(f, r, "declined");
  assert.equal(r.physicalStatus, "AWAITING_FUNDS");
  assert.equal(r.commandStatus, "NONE");
  assert.equal(f.s.ledger.length, 0);
});
for (const scenario of ["pending", "unknown"])
  test(`P06/P07 ${scenario} queried without duplicate charge`, () => {
    const f = fixture(),
      r = rent(f);
    fund(f, r, scenario);
    assert.throws(() => fund(f, r), /Query the original/);
    apply(f.s, f.session, { action: "reconcile", rentalId: r.id });
    assert.equal(r.physicalStatus, "PREPARING");
    assert.equal(f.s.operations.filter((o) => o.type === "CHARGE").length, 1);
    assert.equal(f.s.ledger.length, 1);
  });
test("P08 late payment compensates expired reservation", () => {
  const f = fixture(),
    r = rent(f);
  fund(f, r, "unknown");
  apply(
    f.s,
    f.session,
    { action: "reconcile", rentalId: r.id },
    r.reservationExpiresAt + 1,
  );
  assert.equal(r.physicalStatus, "EXPIRED");
  assert.equal(r.refundMinor, r.pricing.depositMinor);
  assert.equal(r.commandStatus, "NONE");
});
test("D02 acknowledgement is not rental start", () => {
  const f = fixture(),
    r = rent(f);
  fund(f, r);
  assert.equal(r.physicalStatus, "PREPARING");
  assert.equal(r.startedAt, null);
});
test("D03/D04 UNKNOWN stays quarantined and never reissues", () => {
  const f = fixture(),
    r = rent(f);
  fund(f, r);
  collect(f, r, "unknown");
  const command = r.commandId;
  apply(f.s, f.session, { action: "advance", minutes: 10 });
  assert.equal(r.reservationStatus, "QUARANTINED");
  assert.throws(() => collect(f, r), /prepared/);
  apply(f.s, f.session, { action: "reconcile", rentalId: r.id });
  assert.equal(r.commandId, command);
  assert.equal(f.s.outbox.filter((j) => j.type === "DISPENSE").length, 1);
});
test("D05 known jam refunds full without rental fee", () => {
  const f = fixture(),
    r = rent(f);
  fund(f, r);
  collect(f, r, "jammed");
  assert.equal(r.physicalStatus, "NOT_DISPENSED");
  assert.equal(r.refundMinor, r.pricing.depositMinor);
  assert.equal(r.feeMinor, "0");
});
test("D08 collect frees origin slot but battery remains allocated", () => {
  const f = fixture(),
    r = rent(f);
  fund(f, r);
  collect(f, r);
  const t = f.s.stations[0],
    slot = t.slots.find((x) => x.id === r.originSlotId);
  assert.equal(slot.bankId, null);
  assert.equal(slot.lock, null);
  assert.equal(r.reservationStatus, "CONSUMED");
});
test("R01/R04 return is idempotent and no restart", () => {
  const f = fixture(),
    r = rent(f);
  fund(f, r);
  collect(f, r);
  ret(f, r);
  const at = r.endedAt;
  ret(f, r);
  assert.equal(r.endedAt, at);
  assert.equal(f.s.events.filter((e) => e.type === "BANK_RETURNED").length, 1);
  assert.equal(f.s.operations.filter((o) => o.type === "REFUND").length, 1);
  assert.throws(() => collect(f, r), /prepared/);
});
test("R02 user support report never ends rental", () => {
  const f = fixture(),
    r = rent(f);
  fund(f, r);
  collect(f, r);
  apply(f.s, f.session, {
    action: "support",
    rentalId: r.id,
    category: "RETURN_REPORT",
    message: "I returned it but it is still running",
  });
  assert.equal(r.physicalStatus, "ACTIVE");
});
test("R03 wrong bank does not end rental", () => {
  const f = fixture(),
    r = rent(f);
  fund(f, r);
  collect(f, r);
  ret(f, r, "wrong_bank");
  assert.equal(r.physicalStatus, "ACTIVE");
  assert.equal(r.endedAt, null);
});
test("R05 trusted offline occurrence freezes earlier time", () => {
  const f = fixture(),
    r = rent(f);
  fund(f, r);
  collect(f, r);
  apply(f.s, f.session, { action: "advance", minutes: 80 });
  ret(f, r, "offline");
  assert.equal(r.feeMinor, "100000");
  assert.equal(f.s.events[0].offline, true);
});
test("B01 exact boundary arithmetic", () => {
  const p = { rateMinor: "100", capMinor: "0", unitSeconds: 60 };
  for (const [sec, expected] of [
    [0, "0"],
    [59, "100"],
    [60, "100"],
    [61, "200"],
  ])
    assert.equal(bill(p, 0, sec * 1000), expected);
});
test("B02 new pricing does not alter accepted rental", () => {
  const f = fixture(),
    r = rent(f);
  apply(f.s, f.session, { action: "admin_login" });
  apply(f.s, f.session, {
    action: "pricing",
    rateMinor: "99900",
    depositMinor: "2000000",
    capMinor: "900000",
    reason: "Test new pricing version",
  });
  assert.equal(r.pricing.rateMinor, "50000");
});
test("B03 cap and B04 invalid monetary inputs", () => {
  assert.equal(
    bill(
      { rateMinor: "50000", capMinor: "300000", unitSeconds: 3600 },
      0,
      10 * 3600000,
    ),
    "300000",
  );
  assert.throws(
    () => bill({ rateMinor: "1.5", capMinor: "0", unitSeconds: 60 }, 0, 60000),
    /integer/,
  );
});
test("B05 conservation and B06 refund failure cannot resume billing", () => {
  const f = fixture(),
    r = rent(f);
  fund(f, r);
  collect(f, r);
  apply(f.s, f.session, { action: "advance", minutes: 80 });
  ret(f, r, "refund_failed");
  const fee = r.feeMinor;
  assert.equal(
    BigInt(r.feeMinor) + BigInt(r.refundMinor),
    BigInt(r.pricing.depositMinor),
  );
  apply(f.s, f.session, { action: "advance", minutes: 80 });
  assert.equal(r.feeMinor, fee);
  assert.equal(r.physicalStatus, "RETURNED");
  apply(f.s, f.session, { action: "retry_refund", rentalId: r.id });
  assert.equal(r.refundStatus, "SUCCEEDED");
});
test("O01 administrative mutations require role and reason", () => {
  const f = fixture();
  assert.throws(
    () =>
      apply(f.s, f.session, {
        action: "config",
        rentalsEnabled: false,
        reason: "Pause test",
      }),
    /Operator/,
  );
  apply(f.s, f.session, { action: "admin_login" });
  assert.throws(
    () => apply(f.s, f.session, { action: "config", rentalsEnabled: false }),
    /reason/,
  );
});
test("O04 stop new rent still permits returns", () => {
  const f = fixture(),
    r = rent(f);
  fund(f, r);
  collect(f, r);
  apply(f.s, f.session, { action: "admin_login" });
  apply(f.s, f.session, {
    action: "config",
    rentalsEnabled: false,
    reason: "Stop new rent test",
  });
  ret(f, r);
  assert.equal(r.physicalStatus, "RETURNED");
  assert.throws(() => rent(f), /not accepting/);
});
test("O05 reconciliation detects missing internal ledger", () => {
  const f = fixture(),
    r = rent(f);
  fund(f, r);
  f.s.ledger = [];
  apply(f.s, f.session, { action: "admin_login" });
  const result = apply(f.s, f.session, {
    action: "reconcile_all",
    reason: "Check differences",
  });
  assert.equal(result.reconciliation.status, "DIFFERENCES");
});
test("concurrent MemoryStore user rentals serialize", async () => {
  const f = fixture(),
    store = new MemoryStore(f.s);
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      store.transact((s) => rent({ s, session: f.session })),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});
test("server state survives store instance recreation", async () => {
  const f = fixture(),
    r = rent(f);
  fund(f, r);
  const store = new MemoryStore(JSON.parse(JSON.stringify(f.s)));
  const snapshot = await store.read();
  assert.equal(snapshot.rentals[0].id, r.id);
  assert.equal(snapshot.outbox[0].id, r.commandId);
});
test("daily cap charges residual next day without jumping a whole cap", () => {
  const p = { rateMinor: "50000", capMinor: "300000", unitSeconds: 3600 };
  assert.equal(bill(p, 0, 86400000), "300000");
  assert.equal(bill(p, 0, 86400001), "350000");
});
test("durable queued refund resumes after recreation with one ledger effect", async () => {
  const { drainJobs } = await import("../src/domain.mjs");
  const f = fixture(),
    r = rent(f);
  fund(f, r);
  collect(f, r);
  ret(f, r);
  const restored = JSON.parse(JSON.stringify(f.s));
  const future = Date.now() + 10000;
  assert.ok(drainJobs(restored, future) > 0);
  assert.equal(restored.rentals[0].refundStatus, "SUCCEEDED");
  drainJobs(restored, future + 10000);
  assert.equal(restored.ledger.filter((l) => l.type === "REFUND").length, 1);
});
