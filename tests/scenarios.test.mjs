import test from "node:test";
import assert from "node:assert/strict";
import { seed, apply, drainJobs } from "../src/domain.mjs";
import {
  applyScenario,
  reconcilePendingTimeline,
  assertRestoreFence,
} from "../src/scenarios.mjs";
function fixture({ collect = true } = {}) {
  const at = 1800000000000,
    s = seed(at),
    session = {};
  apply(s, session, { action: "login", provider: "google" }, at);
  const q = apply(
    s,
    session,
    { action: "quote", stationId: "station_1" },
    at,
  ).quote;
  const r = apply(
    s,
    session,
    { action: "rent", quoteId: q.id, acceptedTerms: true },
    at,
  ).rental;
  apply(s, session, { action: "pay", rentalId: r.id, method: "card" }, at);
  if (collect) apply(s, session, { action: "collect", rentalId: r.id }, at);
  return { s, session, r, at };
}
function admin(f) {
  f.session.admin = true;
  return { reason: "Verified trusted simulator evidence" };
}
function run(f, action, body = {}, at = f.at + 60000) {
  return applyScenario(
    f.s,
    f.session,
    { action, rentalId: f.r.id, ...body },
    at,
  );
}
test("R09 out-of-order return persists pending evidence then uses original command", () => {
  const f = fixture({ collect: false }),
    command = f.r.commandId;
  run(f, "scenario_return_before_start", { stationId: "station_2" });
  assert.equal(f.r.timelineStatus, "PENDING_COLLECTION");
  assert.equal(f.r.startedAt, null);
  assert.equal(f.s.events[0].type, "RETURN_RECEIVED_BEFORE_COLLECTION");
  assert.equal(f.s.operations.length, 1);
  const restored = JSON.parse(JSON.stringify(f.s));
  f.s = restored;
  f.r = restored.rentals[0];
  reconcilePendingTimeline(
    f.s,
    f.session,
    { action: "reconcile", rentalId: f.r.id },
    f.at + 120000,
  );
  assert.equal(f.r.physicalStatus, "RETURNED");
  assert.equal(f.r.timelineStatus, "RECONCILED");
  assert.equal(f.r.commandId, command);
  assert.equal(f.s.outbox.filter((x) => x.type === "DISPENSE").length, 1);
  assert.equal(
    f.s.events.filter((x) => x.type === "RETURN_RECEIVED_BEFORE_COLLECTION")
      .length,
    1,
  );
  assert.equal(f.s.operations.filter((x) => x.type === "CHARGE").length, 1);
  assert.equal(
    reconcilePendingTimeline(f.s, f.session, {
      action: "reconcile",
      rentalId: f.r.id,
    }),
    null,
  );
});
test("R06 drift closes physical rental but holds billing and quarantines bank", () => {
  const f = fixture();
  run(f, "scenario_clock_drift", { stationId: "station_2" });
  assert.equal(f.r.physicalStatus, "RETURNED");
  assert.equal(f.r.financialStatus, "REVIEW_REQUIRED");
  assert.equal(f.r.billingHold, true);
  assert.equal(f.r.billing, null);
  assert.equal(f.s.operations.filter((x) => x.type === "REFUND").length, 0);
  drainJobs(f.s, f.at + 3600000);
  assert.equal(f.s.operations.length, 1);
  assert.ok(
    f.s.stations[1].slots.some(
      (x) => x.bankId === f.r.bankId && x.quarantined && x.lock,
    ),
  );
  run(
    f,
    "adjust_return_time",
    { ...admin(f), returnedAt: f.at + 30000, evidence: "trusted/server/clock" },
    f.at + 90000,
  );
  assert.equal(f.r.billingHold, false);
  assert.equal(f.r.feeMinor, "50000");
  assert.equal(f.r.refundStatus, "PENDING");
});
test("R07 damaged bank ends ordinary billing without damage debit", () => {
  const f = fixture();
  run(f, "scenario_damaged_return", { stationId: "station_2" }, f.at + 3600000);
  assert.equal(f.r.physicalStatus, "RETURNED");
  assert.equal(f.r.feeMinor, "50000");
  assert.equal(f.r.damageStatus, "REVIEW_REQUIRED");
  assert.ok(f.s.cases.some((x) => x.category === "DAMAGED_BANK"));
  const count = f.s.operations.length;
  run(f, "scenario_damaged_return", { stationId: "station_2" }, f.at + 7200000);
  assert.equal(f.s.operations.length, count);
  assert.equal(f.r.feeMinor, "50000");
  assert.equal(f.s.operations.filter((x) => x.type === "CHARGE").length, 1);
});
test("B07 post-settlement earlier evidence appends adjustment/refund and preserves original billing", () => {
  const f = fixture();
  apply(
    f.s,
    f.session,
    { action: "return", rentalId: f.r.id, stationId: "station_2" },
    f.at + 7200000,
  );
  apply(
    f.s,
    f.session,
    { action: "reconcile", rentalId: f.r.id },
    f.at + 7200001,
  );
  const billing = structuredClone(f.r.billing),
    ledger = structuredClone(f.s.ledger),
    oldEnd = f.r.endedAt,
    refund = structuredClone(f.s.operations.find((x) => x.type === "REFUND"));
  const body = {
    ...admin(f),
    returnedAt: f.at + 1800000,
    evidence: "trusted/offline/earlier",
  };
  const { adjustment } = run(f, "adjust_return_time", body, f.at + 7300000);
  assert.equal(adjustment.extraRefundMinor, "50000");
  assert.deepEqual(f.r.billing, billing);
  assert.equal(f.r.endedAt, oldEnd);
  assert.deepEqual(
    f.s.operations.find((x) => x.id === refund.id),
    refund,
  );
  for (const row of ledger)
    assert.deepEqual(
      f.s.ledger.find((x) => x.id === row.id),
      row,
    );
  assert.equal(
    f.s.operations.filter((x) => x.type === "ADJUSTMENT_REFUND").length,
    1,
  );
  run(f, "adjust_return_time", body, f.at + 7400000);
  assert.equal(
    f.s.operations.filter((x) => x.type === "ADJUSTMENT_REFUND").length,
    1,
  );
  assert.equal(f.r.adjustments.length, 1);
});
for (const [kind, type] of [
  ["duplicate", "PROVIDER_DUPLICATE"],
  ["missing", "PROVIDER_MISSING"],
  ["amount", "AMOUNT_MISMATCH"],
  ["currency", "CURRENCY_MISMATCH"],
])
  test(`O05 provider fixture ${kind} detected independently`, () => {
    const f = fixture(),
      auth = admin(f),
      original = structuredClone(f.s.operations);
    run(f, "simulate_provider_difference", { ...auth, kind });
    const result = run(f, "reconcile_provider", auth);
    assert.equal(result.reconciliation.status, "DIFFERENCES");
    assert.ok(result.reconciliation.items.some((x) => x.type === type));
    assert.deepEqual(f.s.operations, original);
    run(f, "simulate_provider_difference", { ...auth, kind: "clear" });
    assert.equal(
      run(f, "reconcile_provider", auth).reconciliation.status,
      "MATCHED",
    );
  });
test("O02 stale backup recovery preserves effects, fences execution, then reconciles before resume", () => {
  const f = fixture(),
    auth = admin(f);
  const { backup } = run(f, "backup_export", auth);
  apply(
    f.s,
    f.session,
    { action: "return", rentalId: f.r.id, stationId: "station_2" },
    f.at + 3600000,
  );
  apply(
    f.s,
    f.session,
    { action: "reconcile", rentalId: f.r.id },
    f.at + 3600001,
  );
  const ops = structuredClone(f.s.operations),
    ledger = structuredClone(f.s.ledger),
    jobs = structuredClone(f.s.outbox);
  const { preview } = run(f, "restore_preview", {
    ...auth,
    backupId: backup.id,
  });
  assert.equal(preview.stale, true);
  run(f, "restore_apply", { ...auth, previewId: preview.id });
  assert.equal(f.s.config.rentalsEnabled, false);
  assert.equal(f.s.restoreFence.active, true);
  assert.throws(() => assertRestoreFence(f.s, { action: "pay" }), /fenced/);
  assert.throws(
    () => assertRestoreFence(f.s, { action: "reconcile" }),
    /fenced/,
  );
  assert.deepEqual(f.s.operations, ops);
  assert.deepEqual(f.s.ledger, ledger);
  assert.deepEqual(f.s.outbox, jobs);
  assert.equal(f.r.physicalStatus, "RETURNED");
  run(f, "simulate_provider_difference", { ...auth, kind: "duplicate" });
  run(f, "reconcile_provider", auth);
  assert.equal(f.s.restoreFence.active, true);
  run(f, "simulate_provider_difference", { ...auth, kind: "clear" });
  run(f, "reconcile_provider", auth);
  assert.equal(f.s.restoreFence.active, false);
  assert.equal(f.s.config.rentalsEnabled, true);
  assert.doesNotThrow(() => assertRestoreFence(f.s, { action: "pay" }));
  assert.throws(
    () => run(f, "restore_apply", { ...auth, previewId: preview.id }),
    /already been applied/,
  );
});
test("backup missing live operation refuses replay recovery", () => {
  const f = fixture(),
    auth = admin(f),
    { backup } = run(f, "backup_export", auth);
  f.s.operations = [];
  const { preview } = run(f, "restore_preview", {
    ...auth,
    backupId: backup.id,
  });
  assert.equal(preview.status, "BLOCKED_MISSING_LIVE_OPERATIONS");
  assert.throws(
    () => run(f, "restore_apply", { ...auth, previewId: preview.id }),
    /never replay/,
  );
});
test("advanced admin mutations require role and audit reason; owned scenarios reject other user", () => {
  const f = fixture();
  assert.throws(
    () => run(f, "backup_export", { reason: "test reason" }),
    /Operator/,
  );
  f.session.admin = true;
  assert.throws(() => run(f, "backup_export"), /reason/);
  f.session.admin = false;
  f.session.userId = "someone_else";
  assert.throws(
    () => run(f, "scenario_damaged_return", { stationId: "station_2" }),
    /not found/,
  );
});
test("restore applies backed-up configuration while maintaining immutable accepted price", () => {
  const f = fixture(),
    auth = admin(f);
  f.s.config.testSetting = "original";
  const { backup } = run(f, "backup_export", auth);
  f.s.config.testSetting = "changed";
  apply(
    f.s,
    f.session,
    {
      action: "pricing",
      rateMinor: "75000",
      depositMinor: "1000000",
      capMinor: "300000",
      ...auth,
    },
    f.at + 120000,
  );
  const originalRentalPrice = structuredClone(f.r.pricing);
  const { preview } = run(f, "restore_preview", {
    ...auth,
    backupId: backup.id,
  });
  run(f, "restore_apply", { ...auth, previewId: preview.id });
  assert.equal(f.s.config.testSetting, "original");
  assert.equal(f.s.pricingVersions.length, 1);
  assert.deepEqual(f.r.pricing, originalRentalPrice);
  assert.equal(f.s.restoreFence.active, true);
  assert.throws(
    () =>
      run(f, "adjust_return_time", {
        ...auth,
        returnedAt: f.at,
        evidence: "server/evidence",
      }),
    /fenced/,
  );
});
test("pending out-of-order return holds actual slot and reconciles even when all other return slots fill", () => {
  const f = fixture({ collect: false });
  run(f, "scenario_return_before_start", { stationId: "station_2" });
  const t = f.s.stations[1],
    held = t.slots.find((x) => x.id === f.r.pendingReturn.slotId);
  assert.equal(held.bankId, f.r.bankId);
  assert.equal(held.lock, `timeline:${f.r.id}`);
  assert.equal(
    f.s.stations.flatMap((x) => x.slots).filter((x) => x.bankId === f.r.bankId)
      .length,
    1,
  );
  for (const slot of t.slots)
    if (!slot.bankId) slot.bankId = `another_${slot.id}`;
  reconcilePendingTimeline(
    f.s,
    f.session,
    { action: "reconcile", rentalId: f.r.id },
    f.at + 120000,
  );
  assert.equal(f.r.physicalStatus, "RETURNED");
  assert.equal(held.bankId, f.r.bankId);
  assert.equal(held.lock, null);
  assert.equal(
    f.s.stations.flatMap((x) => x.slots).filter((x) => x.bankId === f.r.bankId)
      .length,
    1,
  );
});
