import { MOCK_CAPABILITIES, MockPaymentProvider } from "./adapters.mjs";
export const ACTIVE = [
  "AWAITING_FUNDS",
  "PREPARING",
  "DISPENSE_UNKNOWN",
  "ACTIVE",
  "OVERDUE",
];
export class Fault extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export function assert(ok, code, message, status = 409) {
  if (!ok) throw new Fault(code, message, status);
}
export const uid = (prefix) => `${prefix}_${crypto.randomUUID()}`;
export const money = (value) => {
  assert(
    typeof value === "string" && /^\d{1,12}$/.test(value),
    "INVALID_MONEY",
    "Use a non-negative minor-unit integer string.",
    400,
  );
  return BigInt(value);
};
export function bill(pricing, start, end) {
  assert(end >= start, "INVALID_TIME", "Return precedes rental start.", 400);
  const seconds = Math.max(0, Math.ceil((end - start) / 1000));
  const units = Math.ceil(seconds / pricing.unitSeconds);
  const raw = BigInt(units) * money(pricing.rateMinor);
  const cap = money(pricing.capMinor);
  if (cap === 0n) return String(raw);
  const fullDays = Math.floor(seconds / 86400);
  const remainder = seconds % 86400;
  const fullDayRaw =
    BigInt(Math.ceil(86400 / pricing.unitSeconds)) * money(pricing.rateMinor);
  const remainderRaw =
    BigInt(Math.ceil(remainder / pricing.unitSeconds)) *
    money(pricing.rateMinor);
  return String(
    BigInt(fullDays) * (fullDayRaw < cap ? fullDayRaw : cap) +
      (remainderRaw < cap ? remainderRaw : cap),
  );
}
export function seed(now = Date.now()) {
  const stationData = [
    [
      "PAL01",
      "Palermo Social Club",
      "Honduras 4929, Palermo",
      "Palermo",
      -34.588,
      -58.43,
    ],
    [
      "REC02",
      "Recoleta Coffee House",
      "Av. Santa Fe 1860, Recoleta",
      "Recoleta",
      -34.594,
      -58.397,
    ],
    [
      "MIC03",
      "Microcentro Hub",
      "Av. Corrientes 520, Microcentro",
      "Microcentro",
      -34.603,
      -58.373,
    ],
    [
      "SAN04",
      "San Telmo Market",
      "Defensa 963, San Telmo",
      "San Telmo",
      -34.618,
      -58.372,
    ],
  ];
  return {
    version: 1,
    capabilities: structuredClone(MOCK_CAPABILITIES),
    clockOffset: 0,
    config: { rentalsEnabled: true, mode: "DEMO" },
    users: [],
    sessions: [],
    quotes: [],
    rentals: [],
    operations: [],
    events: [],
    inbox: [],
    outbox: [],
    cases: [],
    audit: [],
    ledger: [],
    reconciliation: [],
    idempotency: [],
    consents: [],
    deletionRequests: [],
    pricingVersions: [
      {
        id: "TEST_v1",
        rateMinor: "50000",
        depositMinor: "1000000",
        capMinor: "300000",
        unitSeconds: 3600,
        currency: "ARS",
        status: "TEST_ACTIVE",
        createdAt: now,
      },
    ],
    stations: stationData.map((s, i) => ({
      id: `station_${i + 1}`,
      code: s[0],
      name: s[1],
      address: s[2],
      area: s[3],
      lat: s[4],
      lng: s[5],
      hours: "Daily · 08:00–23:00 (demo)",
      status: i === 3 ? "OFFLINE" : "ONLINE",
      capacity: 8,
      slots: Array.from({ length: 8 }, (_, j) => ({
        id: `slot_${i}_${j}`,
        bankId: j < 5 ? `bank_${i}_${j}` : null,
        lock: null,
      })),
      updatedAt: now,
    })),
  };
}
export const nowOf = (s) => Date.now() + s.clockOffset;
export function addAudit(
  s,
  actor,
  action,
  target,
  reason,
  at,
  before = null,
  after = null,
) {
  s.audit.unshift({
    id: uid("audit"),
    actor,
    action,
    target,
    reason,
    at,
    before,
    after,
  });
}
export function addCase(s, rentalId, category, message, at) {
  const existing = rentalId
    ? s.cases.find(
        (c) =>
          c.rentalId === rentalId &&
          c.category === category &&
          c.status === "OPEN",
      )
    : null;
  if (existing) return existing;
  const c = {
    id: uid("case"),
    rentalId,
    category,
    message,
    status: "OPEN",
    createdAt: at,
  };
  s.cases.unshift(c);
  return c;
}
function owned(s, session, id) {
  const r = s.rentals.find(
    (r) => r.id === id && (r.userId === session.userId || session.admin),
  );
  assert(r, "RESOURCE_NOT_FOUND", "Rental not found.", 404);
  return r;
}
function station(s, id) {
  const t = s.stations.find((t) => t.id === id);
  assert(t, "STATION_NOT_FOUND", "Station not found.", 404);
  return t;
}
function release(s, r) {
  for (const t of s.stations)
    for (const slot of t.slots) if (slot.lock === r.id) slot.lock = null;
  r.reservationStatus = "RELEASED";
}
function operation(s, r, type, amount, status, at) {
  let op = s.operations.find((o) => o.rentalId === r.id && o.type === type);
  if (op) return op;
  op = {
    id: uid("op"),
    rentalId: r.id,
    type,
    amountMinor: amount,
    currency: "ARS",
    status,
    provider: "MOCK_PVS",
    createdAt: at,
    attempts: 1,
  };
  s.operations.unshift(op);
  return op;
}
function ledger(s, op, at) {
  if (s.ledger.some((l) => l.operationId === op.id)) return;
  s.ledger.unshift({
    id: uid("ledger"),
    operationId: op.id,
    rentalId: op.rentalId,
    type: op.type,
    amountMinor: op.amountMinor,
    currency: "ARS",
    at,
  });
}
function event(s, r, type, at, extra = {}) {
  const id = uid("event");
  const e = {
    id,
    rentalId: r.id,
    bankId: r.bankId,
    type,
    occurredAt: at,
    receivedAt: nowOf(s),
    sequence: s.events.length + 1,
    provider: "TRUSTED_SERVER_SIMULATOR",
    verified: true,
    ...extra,
  };
  s.events.unshift(e);
  s.inbox.push({ id, processed: true });
  return e;
}
function refund(s, r, amount, at, status = "PENDING") {
  r.refundMinor = amount;
  r.refundStatus = status;
  r.financialStatus = status === "SUCCEEDED" ? "SETTLED" : "PENDING";
  const op = operation(s, r, "REFUND", amount, status, at);
  if (status === "SUCCEEDED") ledger(s, op, at);
  s.outbox.push({
    id: uid("job"),
    rentalId: r.id,
    type: "QUERY_REFUND",
    status: status === "SUCCEEDED" ? "DONE" : "PENDING",
    createdAt: at,
    attempts: 0,
  });
}
function settle(s, r, at, failed = false) {
  r.feeMinor = bill(r.pricing, r.startedAt, r.endedAt);
  const fee = money(r.feeMinor),
    dep = money(r.pricing.depositMinor);
  r.balanceDueMinor = String(fee > dep ? fee - dep : 0n);
  refund(
    s,
    r,
    String(dep > fee ? dep - fee : 0n),
    at,
    failed ? "FAILED" : "PENDING",
  );
  if (fee > dep) {
    r.financialStatus = "REVIEW_REQUIRED";
    addCase(
      s,
      r.id,
      "BALANCE_DUE",
      "Rental fee exceeds demo deposit. No extra debit was made.",
      at,
    );
  }
  r.billing = {
    durationSeconds: Math.ceil((r.endedAt - r.startedAt) / 1000),
    feeMinor: r.feeMinor,
    depositMinor: r.pricing.depositMinor,
    refundMinor: r.refundMinor,
    currency: "ARS",
    pricingVersion: r.pricing.id,
    finalizedAt: at,
  };
}
function confirmFunds(s, r, at) {
  assert(
    r.physicalStatus === "AWAITING_FUNDS",
    "INVALID_STATE",
    "This payment is no longer awaiting confirmation.",
  );
  const op = operation(s, r, "CHARGE", r.pricing.depositMinor, "SUCCEEDED", at);
  op.status = "SUCCEEDED";
  ledger(s, op, at);
  r.paymentStatus = "SUCCEEDED";
  if (at > r.reservationExpiresAt) {
    r.physicalStatus = "EXPIRED";
    release(s, r);
    refund(s, r, r.pricing.depositMinor, at);
    return;
  }
  r.physicalStatus = "PREPARING";
  r.commandId ||= uid("cmd");
  r.commandStatus = "ACKNOWLEDGED";
  event(s, r, "PAYMENT_CONFIRMED", at);
  s.outbox.push({
    id: r.commandId,
    rentalId: r.id,
    type: "DISPENSE",
    status: "ACKNOWLEDGED",
    createdAt: at,
    attempts: 1,
  });
}
function collect(s, r, at) {
  r.physicalStatus = "ACTIVE";
  r.commandStatus = "SUCCEEDED";
  r.startedAt ||= at;
  r.reservationStatus = "CONSUMED";
  for (const t of s.stations)
    for (const slot of t.slots)
      if (slot.lock === r.id) {
        slot.bankId = null;
        slot.lock = null;
      }
  event(s, r, "BANK_COLLECTED", r.startedAt);
  const job = s.outbox.find((x) => x.id === r.commandId);
  if (job) job.status = "DONE";
}
function expire(s, at) {
  for (const r of s.rentals) {
    if (
      r.physicalStatus === "AWAITING_FUNDS" &&
      at > r.reservationExpiresAt &&
      !["PENDING", "UNKNOWN"].includes(r.paymentStatus)
    ) {
      r.physicalStatus = "EXPIRED";
      release(s, r);
    }
    if (r.physicalStatus === "ACTIVE" && at - r.startedAt > 7 * 86400000)
      r.physicalStatus = "OVERDUE";
  }
}
export function apply(s, session, body, at = nowOf(s)) {
  const { action } = body;
  expire(s, at);
  let result = {};
  const adminActions = [
    "station_update",
    "config",
    "pricing",
    "resolve_case",
    "reconcile_all",
    "reset",
    "refund",
    "return_review",
    "capability",
    "inventory_review",
  ];
  if (adminActions.includes(action)) {
    assert(session.admin, "FORBIDDEN", "Operator access required.", 403);
    assert(
      typeof body.reason === "string" && body.reason.trim().length >= 3,
      "REASON_REQUIRED",
      "Enter an audit reason.",
      400,
    );
  }
  if (
    !["login", "admin_login", "logout", "admin_logout", "resolve"].includes(
      action,
    )
  )
    assert(
      session.userId || session.admin,
      "SESSION_EXPIRED",
      "Please sign in.",
      401,
    );
  switch (action) {
    case "login": {
      assert(
        ["apple", "google"].includes(body.provider),
        "INVALID_PROVIDER",
        "Choose Apple or Google.",
        400,
      );
      if (body.scenario === "cancelled")
        throw new Fault("AUTH_CANCELLED", "Sign-in cancelled.", 400);
      const subject = `demo:${body.provider}:owner`;
      let u = s.users.find(
        (u) => u.provider === body.provider && u.subject === subject,
      );
      if (!u) {
        u = {
          id: uid("user"),
          name: body.provider === "apple" ? "Alex Apple" : "Alex Google",
          provider: body.provider,
          subject,
          createdAt: at,
        };
        s.users.push(u);
      }
      session.userId = u.id;
      result.user = u;
      break;
    }
    case "logout":
      session.userId = null;
      session.admin = false;
      break;
    case "admin_login":
      session.admin = true;
      addAudit(
        s,
        "DEMO_OPERATOR",
        "DEMO_OPERATOR_LOGIN",
        "session",
        "Explicit operator simulation",
        at,
      );
      break;
    case "admin_logout":
      session.admin = false;
      break;
    case "resolve": {
      const input = String(body.code || "").trim();
      let code = input;
      if (/^https?:/i.test(input)) {
        let u;
        try {
          u = new URL(input);
        } catch {
          throw new Fault("INVALID_QR", "Invalid station QR.", 400);
        }
        assert(
          u.origin === body.origin,
          "INVALID_QR",
          "This QR does not belong to this demo.",
          400,
        );
        code = u.searchParams.get("station") || "";
      }
      assert(
        /^[A-Z0-9]{5}$/.test(code),
        "INVALID_QR",
        "Enter an official demo station code.",
        400,
      );
      const t = s.stations.find((t) => t.code === code);
      assert(t, "STATION_NOT_FOUND", "Station code not found.", 404);
      result.station = { id: t.id, code: t.code };
      break;
    }
    case "quote": {
      const t = station(s, body.stationId);
      assert(
        t.status === "ONLINE" && s.config.rentalsEnabled,
        "STATION_UNAVAILABLE",
        "This station is not accepting new rentals.",
      );
      assert(
        t.slots.some((x) => x.bankId && !x.lock),
        "NO_INVENTORY",
        "No charged power banks are available.",
      );
      const q = {
        id: uid("quote"),
        stationId: t.id,
        userId: session.userId,
        pricing: structuredClone(s.pricingVersions.at(-1)),
        expiresAt: at + 300000,
        createdAt: at,
      };
      s.quotes.push(q);
      result.quote = q;
      break;
    }
    case "rent": {
      assert(
        body.acceptedTerms === true,
        "TERMS_REQUIRED",
        "Accept the demo rental terms.",
        400,
      );
      const q = s.quotes.find(
        (q) => q.id === body.quoteId && q.userId === session.userId,
      );
      assert(q, "QUOTE_NOT_FOUND", "Please refresh your quote.", 404);
      assert(
        at <= q.expiresAt,
        "QUOTE_EXPIRED",
        "Your quote expired. Please get a new quote.",
      );
      assert(
        !s.rentals.some(
          (r) =>
            r.userId === session.userId && ACTIVE.includes(r.physicalStatus),
        ),
        "ACTIVE_RENTAL_EXISTS",
        "You already have an active rental.",
      );
      const t = station(s, q.stationId);
      assert(
        s.config.rentalsEnabled && t.status === "ONLINE",
        "RENTALS_PAUSED",
        "New rentals are paused.",
      );
      const slot = t.slots.find((x) => x.bankId && !x.lock);
      assert(
        slot,
        "INVENTORY_CONFLICT",
        "That power bank is no longer available.",
      );
      const r = {
        id: uid("rental"),
        userId: session.userId,
        stationId: t.id,
        bankId: slot.bankId,
        originSlotId: slot.id,
        physicalStatus: "AWAITING_FUNDS",
        financialStatus: "PENDING",
        paymentStatus: "CREATED",
        refundStatus: "NONE",
        feeMinor: "0",
        refundMinor: "0",
        balanceDueMinor: "0",
        createdAt: at,
        startedAt: null,
        endedAt: null,
        pricing: structuredClone(q.pricing),
        reservationExpiresAt: at + 300000,
        reservationStatus: "HELD",
        commandStatus: "NONE",
      };
      slot.lock = r.id;
      s.rentals.unshift(r);
      s.consents.push({
        userId: session.userId,
        rentalId: r.id,
        version: "TEST_TERMS_v1",
        at,
      });
      result.rental = r;
      break;
    }
    case "pay": {
      const r = owned(s, session, body.rentalId);
      assert(
        r.physicalStatus === "AWAITING_FUNDS",
        "INVALID_STATE",
        "Rental is not awaiting payment.",
      );
      assert(
        !["PENDING", "UNKNOWN"].includes(r.paymentStatus),
        "PAYMENT_PENDING",
        "Query the original payment instead of paying again.",
      );
      assert(
        ["card", "apple_pay", "google_pay", "bank_transfer"].includes(
          body.method,
        ),
        "PAYMENT_METHOD_UNAVAILABLE",
        "Unsupported demo payment method.",
        422,
      );
      const provider = new MockPaymentProvider(s.capabilities);
      assert(
        provider.supports(body.method, "charge") &&
          provider.supports(body.method, "partialRefund") &&
          provider.supports(body.method, "query"),
        "CAPABILITY_NOT_SUPPORTED",
        "This demo method cannot support the required deposit and partial refund flow.",
        422,
      );
      r.method = body.method;
      const scenario = body.scenario || "success";
      assert(
        ["success", "declined", "pending", "unknown"].includes(scenario),
        "INVALID_SCENARIO",
        "Unknown payment scenario.",
        400,
      );
      const op = operation(
        s,
        r,
        "CHARGE",
        r.pricing.depositMinor,
        "CREATED",
        at,
      );
      if (scenario === "declined") {
        op.status = "FAILED";
        r.paymentStatus = "FAILED";
      } else if (["pending", "unknown"].includes(scenario)) {
        op.status = scenario.toUpperCase();
        r.paymentStatus = scenario.toUpperCase();
        s.outbox.push({
          id: uid("job"),
          rentalId: r.id,
          type: "QUERY_PAYMENT",
          status: "PENDING",
          createdAt: at,
          attempts: 0,
        });
      } else confirmFunds(s, r, at);
      break;
    }
    case "collect": {
      const r = owned(s, session, body.rentalId);
      assert(
        r.physicalStatus === "PREPARING",
        "INVALID_STATE",
        "Only a prepared rental can receive collection evidence.",
      );
      const sc = body.scenario || "success";
      assert(
        ["success", "jammed", "unknown", "not_taken"].includes(sc),
        "INVALID_SCENARIO",
        "Unknown device scenario.",
        400,
      );
      if (sc === "success") collect(s, r, at);
      else if (sc === "unknown") {
        r.physicalStatus = "DISPENSE_UNKNOWN";
        r.commandStatus = "UNKNOWN";
        r.reservationStatus = "QUARANTINED";
        r.mockCollectedAt = at;
        addCase(
          s,
          r.id,
          "DEVICE_UNKNOWN",
          "Dispense outcome unknown. Query the original command; do not dispense again.",
          at,
        );
      } else {
        r.physicalStatus = "NOT_DISPENSED";
        r.commandStatus = "FAILED";
        release(s, r);
        refund(s, r, r.pricing.depositMinor, at);
        addCase(
          s,
          r.id,
          "NOT_DISPENSED",
          sc === "jammed"
            ? "Slot jam confirmed; full deposit refund pending."
            : "Power bank not collected; retained in station.",
          at,
        );
      }
      break;
    }
    case "reconcile": {
      const r = owned(s, session, body.rentalId);
      const resolvedType = ["PENDING", "UNKNOWN"].includes(r.paymentStatus)
        ? "QUERY_PAYMENT"
        : ["PENDING", "FAILED", "UNKNOWN"].includes(r.refundStatus)
          ? "QUERY_REFUND"
          : null;
      if (["PENDING", "UNKNOWN"].includes(r.paymentStatus))
        confirmFunds(s, r, at);
      else if (r.physicalStatus === "DISPENSE_UNKNOWN") {
        collect(s, r, r.mockCollectedAt || at);
        for (const c of s.cases.filter(
          (c) => c.rentalId === r.id && c.category === "DEVICE_UNKNOWN",
        ))
          c.status = "RESOLVED";
      } else if (["PENDING", "FAILED", "UNKNOWN"].includes(r.refundStatus)) {
        r.refundStatus = "SUCCEEDED";
        r.financialStatus =
          money(r.balanceDueMinor || "0") > 0n ? "REVIEW_REQUIRED" : "SETTLED";
        const op = s.operations.find(
          (o) => o.rentalId === r.id && o.type === "REFUND",
        );
        if (op) {
          op.status = "SUCCEEDED";
          ledger(s, op, at);
        }
      }
      for (const j of s.outbox.filter(
        (j) => j.rentalId === r.id && j.type === resolvedType,
      )) {
        j.status = "DONE";
        j.attempts++;
      }
      event(s, r, "QUERY_RECONCILED", at);
      break;
    }
    case "return": {
      const r = owned(s, session, body.rentalId);
      if (r.physicalStatus === "RETURNED") {
        result.rental = r;
        break;
      }
      assert(
        ["ACTIVE", "OVERDUE"].includes(r.physicalStatus),
        "INVALID_STATE",
        "There is no active power bank to return.",
      );
      const t = station(s, body.stationId);
      assert(
        t.status !== "OFFLINE" || body.scenario === "offline",
        "STATION_OFFLINE",
        "Choose an online return station.",
      );
      const slot = t.slots.find((x) => !x.bankId && !x.lock);
      assert(slot, "STATION_FULL", "This station has no empty return slots.");
      if (body.scenario === "wrong_bank") {
        addCase(
          s,
          r.id,
          "WRONG_BANK",
          "Simulator received an unmatched bank. Your rental remains active.",
          at,
        );
        event(s, r, "UNMATCHED_BANK", at, { bankId: "unknown_bank" });
        break;
      }
      r.physicalStatus = "RETURNED";
      r.endedAt =
        body.scenario === "offline"
          ? Math.max(r.startedAt, at - 15 * 60000)
          : at;
      r.returnStationId = t.id;
      r.reservationStatus = "RELEASED";
      slot.bankId = r.bankId;
      event(s, r, "BANK_RETURNED", r.endedAt, {
        stationId: t.id,
        slotId: slot.id,
        offline: body.scenario === "offline",
      });
      settle(s, r, at, body.scenario === "refund_failed");
      break;
    }
    case "retry_refund":
      return apply(s, session, { ...body, action: "reconcile" }, at);
    case "cancel": {
      const r = owned(s, session, body.rentalId);
      assert(
        r.physicalStatus === "AWAITING_FUNDS" &&
          !["UNKNOWN", "PENDING"].includes(r.paymentStatus),
        "CANNOT_CANCEL",
        "Cannot cancel an unknown payment or dispense. Query its outcome first.",
      );
      r.physicalStatus = "CANCELLED";
      r.financialStatus = "SETTLED";
      release(s, r);
      break;
    }
    case "advance": {
      assert(
        Number.isInteger(body.minutes) &&
          body.minutes >= 1 &&
          body.minutes <= 10080,
        "INVALID_TIME",
        "Advance between 1 and 10080 minutes.",
        400,
      );
      s.clockOffset += body.minutes * 60000;
      expire(s, nowOf(s));
      break;
    }
    case "support": {
      assert(
        typeof body.message === "string" &&
          body.message.trim().length >= 5 &&
          body.message.length <= 2000,
        "INVALID_MESSAGE",
        "Describe the issue in 5–2000 characters.",
        400,
      );
      if (body.rentalId) owned(s, session, body.rentalId);
      const c = addCase(
        s,
        body.rentalId || null,
        body.category || "GENERAL",
        body.message,
        at,
      );
      c.userId = session.userId;
      result.case = c;
      break;
    }
    case "return_review": {
      const r = owned(s, session, body.rentalId);
      assert(
        ["ACTIVE", "OVERDUE", "DISPENSE_UNKNOWN"].includes(r.physicalStatus),
        "INVALID_STATE",
        "Rental has no unresolved physical return.",
      );
      assert(
        body.evidence && String(body.evidence).length >= 5,
        "EVIDENCE_REQUIRED",
        "A reference to reviewed evidence is required.",
        400,
      );
      assert(
        Number.isFinite(body.returnedAt) &&
          body.returnedAt <= at &&
          body.returnedAt >= (r.startedAt || r.createdAt),
        "INVALID_TIME",
        "Provide a valid reviewed return time.",
        400,
      );
      assert(
        r.startedAt,
        "TIMELINE_REVIEW",
        "Collection evidence must be reconciled first.",
      );
      const t = station(s, body.stationId);
      const slot = t.slots.find((x) => !x.bankId && !x.lock);
      assert(slot, "STATION_FULL", "No matching empty slot is available.");
      r.physicalStatus = "RETURNED";
      r.endedAt = body.returnedAt;
      r.returnStationId = t.id;
      slot.bankId = r.bankId;
      release(s, r);
      event(s, r, "MANUAL_RETURN_REVIEW", r.endedAt, {
        evidence: body.evidence,
        reason: body.reason,
      });
      settle(s, r, at);
      addAudit(s, "DEMO_OPERATOR", action, r.id, body.reason, at, null, {
        evidence: body.evidence,
        returnedAt: body.returnedAt,
      });
      break;
    }
    case "refund": {
      const r = owned(s, session, body.rentalId);
      assert(
        ["RETURNED", "NOT_DISPENSED", "EXPIRED"].includes(r.physicalStatus),
        "INVALID_STATE",
        "Only finalized physical outcomes can be refunded.",
      );
      assert(
        r.refundStatus !== "SUCCEEDED",
        "REFUND_ALREADY_COMPLETE",
        "Refund already completed.",
      );
      assert(
        money(body.amountMinor) === money(r.refundMinor),
        "REFUND_LIMIT",
        "Only the computed refundable balance can be retried.",
      );
      apply(s, session, { action: "retry_refund", rentalId: r.id }, at);
      addAudit(s, "DEMO_OPERATOR", action, r.id, body.reason, at);
      break;
    }
    case "delete_account": {
      const blocked = s.rentals.some(
        (r) =>
          r.userId === session.userId &&
          (ACTIVE.includes(r.physicalStatus) ||
            r.financialStatus !== "SETTLED"),
      );
      const d = {
        id: uid("deletion"),
        userId: session.userId,
        status: blocked ? "BLOCKED_OPEN_OBLIGATIONS" : "REQUESTED",
        createdAt: at,
      };
      s.deletionRequests.push(d);
      result.deletion = d;
      break;
    }
    case "capability": {
      assert(
        s.capabilities[body.method],
        "INVALID_METHOD",
        "Unknown method.",
        400,
      );
      assert(
        typeof body.partialRefund === "boolean",
        "INVALID_REQUEST",
        "Use a boolean.",
        400,
      );
      s.capabilities[body.method].partialRefund = body.partialRefund;
      addAudit(s, "DEMO_OPERATOR", action, body.method, body.reason, at);
      break;
    }
    case "inventory_review": {
      const t = station(s, body.stationId);
      const slot = t.slots.find((x) => x.id === body.slotId);
      assert(slot, "SLOT_NOT_FOUND", "Slot not found.", 404);
      assert(
        slot.quarantined && /^(review|damage):/.test(slot.lock || ""),
        "INVALID_STATE",
        "Only a reviewed quarantined returned bank can be released.",
      );
      assert(
        typeof body.evidence === "string" && body.evidence.length >= 5,
        "EVIDENCE_REQUIRED",
        "Provide a completed inspection reference.",
        400,
      );
      const prior = { ...slot };
      slot.quarantined = false;
      slot.lock = null;
      t.updatedAt = at;
      addAudit(s, "DEMO_OPERATOR", action, slot.id, body.reason, at, prior, {
        ...slot,
        evidence: body.evidence,
      });
      break;
    }
    case "station_update": {
      const t = station(s, body.stationId);
      assert(
        ["ONLINE", "OFFLINE", "PAUSED", "STALE"].includes(body.status),
        "INVALID_STATUS",
        "Invalid station status.",
        400,
      );
      const before = t.status;
      t.status = body.status;
      t.updatedAt = at;
      addAudit(
        s,
        "DEMO_OPERATOR",
        action,
        t.id,
        body.reason,
        at,
        before,
        t.status,
      );
      break;
    }
    case "config": {
      assert(
        typeof body.rentalsEnabled === "boolean",
        "INVALID_REQUEST",
        "Use a boolean.",
        400,
      );
      const old = s.config.rentalsEnabled;
      s.config.rentalsEnabled = body.rentalsEnabled;
      addAudit(
        s,
        "DEMO_OPERATOR",
        action,
        "rentalsEnabled",
        body.reason,
        at,
        old,
        body.rentalsEnabled,
      );
      break;
    }
    case "pricing": {
      const rate = money(body.rateMinor),
        dep = money(body.depositMinor),
        cap = money(body.capMinor);
      assert(
        rate > 0n && dep > 0n && cap >= rate,
        "INVALID_PRICE",
        "Use positive deposit/rate and cap at least the hourly rate.",
        400,
      );
      const p = {
        ...s.pricingVersions.at(-1),
        id: `TEST_v${s.pricingVersions.length + 1}`,
        rateMinor: body.rateMinor,
        depositMinor: body.depositMinor,
        capMinor: body.capMinor,
        createdAt: at,
      };
      s.pricingVersions.push(p);
      addAudit(s, "DEMO_OPERATOR", action, p.id, body.reason, at, null, p);
      break;
    }
    case "resolve_case": {
      const c = s.cases.find((c) => c.id === body.caseId);
      assert(c, "CASE_NOT_FOUND", "Case not found.", 404);
      c.status = "RESOLVED";
      c.resolution = body.reason;
      c.resolvedAt = at;
      addAudit(s, "DEMO_OPERATOR", action, c.id, body.reason, at);
      break;
    }
    case "reconcile_all": {
      const items = s.operations
        .filter(
          (o) =>
            o.status === "SUCCEEDED" &&
            !s.ledger.some((l) => l.operationId === o.id),
        )
        .map((o) => ({
          operationId: o.id,
          type: "MISSING_LEDGER",
          amountMinor: o.amountMinor,
        }));
      const run = {
        id: uid("rec"),
        createdAt: at,
        status: items.length ? "DIFFERENCES" : "MATCHED",
        items,
        operationCount: s.operations.length,
        provider: "MOCK_PVS",
      };
      s.reconciliation.unshift(run);
      addAudit(s, "DEMO_OPERATOR", action, run.id, body.reason, at);
      result.reconciliation = run;
      break;
    }
    case "reset": {
      const sessions = s.sessions;
      const fresh = seed(at);
      fresh.sessions = sessions;
      fresh.users = s.users;
      Object.assign(s, fresh);
      addAudit(s, "DEMO_OPERATOR", action, "demo_workspace", body.reason, at);
      break;
    }
    default:
      throw new Fault("UNKNOWN_ACTION", "Unknown action.", 400);
  }
  return result;
}
export function publicState(s, session, csrf) {
  const now = nowOf(s);
  const stationView = (t) => ({
    ...t,
    slots: undefined,
    available: t.slots.filter((x) => x.bankId && !x.lock).length,
    emptySlots: t.slots.filter((x) => !x.bankId && !x.lock).length,
  });
  const rentals = s.rentals
    .filter((r) => r.userId === session.userId)
    .map((r) => ({
      ...r,
      estimatedFeeMinor: r.billingHold
        ? null
        : r.startedAt
          ? bill(r.pricing, r.startedAt, r.endedAt || now)
          : "0",
    }));
  return {
    mode: "DEMO",
    user: s.users.find((u) => u.id === session.userId)
      ? (({ subject, ...u }) => u)(s.users.find((u) => u.id === session.userId))
      : null,
    admin: !!session.admin,
    stations: s.stations.map(stationView),
    pricing: s.pricingVersions.at(-1),
    rentals,
    activeRental:
      rentals.find((r) => ACTIVE.includes(r.physicalStatus)) || null,
    cases: s.cases.filter(
      (c) =>
        c.userId === session.userId || rentals.some((r) => r.id === c.rentalId),
    ),
    csrf,
    serverTime: now,
    config: s.config,
    capabilities: s.capabilities,
    adminData: session.admin
      ? {
          inventory: s.stations.map((t) => ({
            ...stationView(t),
            slots: t.slots,
          })),
          backups: (s.backups || []).map(({ snapshot, ...b }) => b),
          restorePreviews: s.restorePreviews || [],
          restoreFence: s.restoreFence || null,
          billingAdjustments: s.billingAdjustments || [],
          providerFixtures: s.providerFixtures || [],
          audit: s.audit,
          operations: s.operations,
          events: s.events,
          cases: s.cases,
          rentals: s.rentals,
          stations: s.stations.map(stationView),
          pricingVersions: s.pricingVersions,
          reconciliation: s.reconciliation,
          ledger: s.ledger,
          outbox: s.outbox,
          users: s.users.map(({ subject, ...u }) => u),
        }
      : null,
  };
}

// Request/cron-driven durable mock worker. Every effect and job update commits in
// the same aggregate CAS. No external provider calls are made or retried here.
export function drainJobs(s, at = nowOf(s), limit = 20) {
  let processed = 0;
  for (const job of s.outbox) {
    if (processed >= limit) break;
    if (
      job.status !== "PENDING" ||
      (job.nextAttemptAt || job.createdAt + 8000) > at
    )
      continue;
    const r = s.rentals.find((r) => r.id === job.rentalId);
    if (!r) {
      job.status = "DEAD_LETTER";
      continue;
    }
    job.attempts = (job.attempts || 0) + 1;
    try {
      if (
        job.type === "QUERY_PAYMENT" &&
        ["PENDING", "UNKNOWN"].includes(r.paymentStatus)
      ) {
        confirmFunds(s, r, at);
      } else if (job.type === "QUERY_REFUND" && r.refundStatus === "PENDING") {
        r.refundStatus = "SUCCEEDED";
        r.financialStatus =
          money(r.balanceDueMinor || "0") > 0n ? "REVIEW_REQUIRED" : "SETTLED";
        const op = s.operations.find(
          (o) => o.rentalId === r.id && o.type === "REFUND",
        );
        if (op) {
          op.status = "SUCCEEDED";
          ledger(s, op, at);
        }
        event(s, r, "REFUND_CONFIRMED", at);
      } else if (job.type === "QUERY_REFUND" && r.refundStatus === "FAILED") {
        job.status = "REVIEW_REQUIRED";
        addCase(
          s,
          r.id,
          "REFUND_FAILED",
          "Refund needs operator review before retry.",
          at,
        );
        continue;
      }
      job.status = "DONE";
      job.completedAt = at;
      processed++;
    } catch (error) {
      job.error = error.code || "WORKER_ERROR";
      job.nextAttemptAt = at + Math.min(300000, 1000 * 2 ** job.attempts);
      if (job.attempts >= 5) {
        job.status = "DEAD_LETTER";
        addCase(
          s,
          r.id,
          "WORKER_REVIEW",
          "Repeated mock recovery error requires review.",
          at,
        );
      }
    }
  }
  return processed;
}
