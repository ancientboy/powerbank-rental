import test from "node:test";
import assert from "node:assert/strict";
import {
  MockPaymentProvider,
  DisabledRealProvider,
  signMockEnvelope,
  verifyMockEnvelope,
} from "../src/adapters.mjs";
import { seed, apply } from "../src/domain.mjs";
test("P09 unsupported payment capability fails closed before charge", () => {
  const s = seed(),
    se = {};
  apply(s, se, { action: "login", provider: "google" });
  apply(s, se, { action: "admin_login" });
  apply(s, se, {
    action: "capability",
    method: "bank_transfer",
    partialRefund: false,
    reason: "Test unsupported partial refunds",
  });
  const q = apply(s, se, { action: "quote", stationId: "station_1" }).quote;
  const r = apply(s, se, {
    action: "rent",
    quoteId: q.id,
    acceptedTerms: true,
  }).rental;
  assert.throws(
    () =>
      apply(s, se, { action: "pay", rentalId: r.id, method: "bank_transfer" }),
    /cannot support/,
  );
  assert.equal(s.operations.length, 0);
});
test("P10 refund bound and authorization not falsely supported", () => {
  const p = new MockPaymentProvider();
  assert.equal(p.supports("card", "authorize"), false);
  assert.throws(
    () =>
      p.refund({
        operationId: "a",
        chargedMinor: "100",
        alreadyRefundedMinor: "90",
        amountMinor: "11",
      }),
    /REFUND_LIMIT/,
  );
  assert.equal(
    p.refund({
      operationId: "a",
      chargedMinor: "100",
      alreadyRefundedMinor: "90",
      amountMinor: "10",
    }).status,
    "PENDING",
  );
});
test("P04/P05 mock signed event duplicate20 times one effect, wrong signature/amount/currency rejects", async () => {
  const secret = "fixture-only-not-a-real-provider-secret";
  const event = {
    id: "e1",
    provider: "MOCK_ONLY",
    merchant: "demo",
    currency: "ARS",
    amountMinor: "100",
    rentalId: "r1",
    sequence: 1,
    occurredAt: 1000,
  };
  const envelope = await signMockEnvelope(secret, event),
    seen = [];
  let effects = 0;
  for (let i = 0; i < 20; i++) {
    const r = await verifyMockEnvelope(secret, envelope, event, seen, 1000);
    if (!r.duplicate) effects++;
  }
  assert.equal(effects, 1);
  await assert.rejects(
    () =>
      verifyMockEnvelope(
        secret,
        { ...envelope, signature: "x" },
        event,
        [],
        1000,
      ),
    /BAD_SIGNATURE/,
  );
  for (const patch of [
    { currency: "USD" },
    { amountMinor: "101" },
    { merchant: "other" },
  ])
    await assert.rejects(
      () =>
        verifyMockEnvelope(secret, envelope, { ...event, ...patch }, [], 1000),
      /EVENT_MISMATCH/,
    );
});
test("real providers never perform an unconfigured operation", async () => {
  await assert.rejects(
    () => new DisabledRealProvider("PVS").execute(),
    /disabled/,
  );
});
