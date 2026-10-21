import {
  apply,
  assert,
  uid,
  bill,
  money,
  addAudit,
  addCase,
  nowOf,
} from "./domain.mjs";
export const SCENARIO_ACTIONS = [
  "scenario_return_before_start",
  "scenario_clock_drift",
  "scenario_damaged_return",
  "adjust_return_time",
  "simulate_provider_difference",
  "reconcile_provider",
  "backup_export",
  "restore_preview",
  "restore_apply",
];
const ADMIN = new Set([
  "adjust_return_time",
  "simulate_provider_difference",
  "reconcile_provider",
  "backup_export",
  "restore_preview",
  "restore_apply",
]);
function rental(s, session, id) {
  const r = s.rentals.find(
    (x) => x.id === id && (session.admin || x.userId === session.userId),
  );
  assert(r, "RESOURCE_NOT_FOUND", "Rental not found.", 404);
  return r;
}
function evidence(s, r, type, occurredAt, at, extra = {}) {
  const e = {
    id: uid("event"),
    rentalId: r.id,
    bankId: r.bankId,
    commandId: r.commandId,
    type,
    occurredAt,
    receivedAt: at,
    sequence: s.events.length + 1,
    provider: "TRUSTED_SERVER_SIMULATOR",
    verified: true,
    ...extra,
  };
  s.events.unshift(e);
  s.inbox.push({ id: e.id, processed: true });
  return e;
}
function returnSlot(s, stationId) {
  const t = s.stations.find((x) => x.id === stationId);
  assert(t, "STATION_NOT_FOUND", "Station not found.", 404);
  assert(
    t.status === "ONLINE",
    "STATION_OFFLINE",
    "Choose an online return station.",
  );
  const slot = t.slots.find((x) => !x.bankId && !x.lock);
  assert(slot, "STATION_FULL", "No empty return slot.");
  return { t, slot };
}
export function assertRestoreFence(s, body) {
  if (s.restoreFence?.active)
    assert(
      ![
        "rent",
        "pay",
        "collect",
        "reconcile",
        "retry_refund",
        "refund",
        "config",
        "reset",
        "scenario_return_before_start",
        "adjust_return_time",
      ].includes(body.action),
      "RESTORE_FENCED",
      "Restore recovery is fenced. Run provider reconciliation before resuming commands or payments.",
    );
}
export function reconcilePendingTimeline(s, session, body, at = nowOf(s)) {
  const r = rental(s, session, body.rentalId);
  if (!r.pendingReturn) return null;
  assertRestoreFence(s, body);
  const p = r.pendingReturn;
  assert(
    r.commandId === p.commandId,
    "COMMAND_MISMATCH",
    "Original command no longer matches.",
  );
  assert(
    r.physicalStatus === "DISPENSE_UNKNOWN",
    "INVALID_STATE",
    "Timeline is not pending.",
  );
  const heldSlot = s.stations
    .find((x) => x.id === p.stationId)
    ?.slots.find((x) => x.id === p.slotId);
  assert(
    heldSlot &&
      heldSlot.bankId === r.bankId &&
      heldSlot.lock === `timeline:${r.id}`,
    "RETURN_SLOT_MISMATCH",
    "Pending physical return slot requires review.",
  );
  apply(s, session, { action: "reconcile", rentalId: r.id }, p.collectedAt);
  heldSlot.bankId = null;
  heldSlot.lock = null;
  heldSlot.quarantined = false;
  apply(
    s,
    session,
    { action: "return", rentalId: r.id, stationId: p.stationId },
    p.returnedAt,
  );
  r.timelineStatus = "RECONCILED";
  r.returnEvidenceId = p.eventId;
  r.pendingReturn = null;
  for (const c of s.cases.filter(
    (x) => x.rentalId === r.id && x.category === "TIMELINE_PENDING",
  )) {
    c.status = "RESOLVED";
    c.resolvedAt = at;
  }
  evidence(s, r, "RETURN_TIMELINE_RECONCILED", p.returnedAt, at, {
    originalCommandId: p.commandId,
    returnEvidenceId: p.eventId,
  });
  return { rental: r };
}
function providerRows(s) {
  return s.operations
    .filter((o) => o.status === "SUCCEEDED")
    .map((o) => ({
      id: `mock_external_${o.id}`,
      operationId: o.id,
      type: o.type,
      amountMinor: o.amountMinor,
      currency: o.currency,
      status: o.status,
    }));
}
function compareProvider(s) {
  const internal = s.operations.filter((o) => o.status === "SUCCEEDED");
  const rows = structuredClone(providerRows(s));
  for (const f of s.providerFixtures || []) {
    const i = rows.findIndex((x) => x.operationId === f.operationId);
    if (f.kind === "missing" && i >= 0) rows.splice(i, 1);
    else if (f.kind === "duplicate" && i >= 0)
      rows.push({ ...rows[i], id: `${rows[i].id}_duplicate_${f.id}` });
    else if (f.kind === "amount" && i >= 0)
      rows[i].amountMinor = String(money(rows[i].amountMinor) + 1n);
    else if (f.kind === "currency" && i >= 0) rows[i].currency = "USD";
  }
  const items = [];
  for (const op of internal) {
    const ext = rows.filter((x) => x.operationId === op.id);
    if (!ext.length)
      items.push({ type: "PROVIDER_MISSING", operationId: op.id });
    if (ext.length > 1)
      items.push({ type: "PROVIDER_DUPLICATE", operationId: op.id });
    for (const row of ext) {
      if (row.amountMinor !== op.amountMinor)
        items.push({
          type: "AMOUNT_MISMATCH",
          operationId: op.id,
          internal: op.amountMinor,
          provider: row.amountMinor,
        });
      if (row.currency !== op.currency)
        items.push({
          type: "CURRENCY_MISMATCH",
          operationId: op.id,
          internal: op.currency,
          provider: row.currency,
        });
    }
    if (!s.ledger.some((x) => x.operationId === op.id))
      items.push({ type: "MISSING_LEDGER", operationId: op.id });
  }
  return { items, rows };
}
export function applyScenario(s, session, body, at = nowOf(s)) {
  const { action } = body;
  assert(
    session.userId || session.admin,
    "SESSION_EXPIRED",
    "Please sign in.",
    401,
  );
  assert(
    SCENARIO_ACTIONS.includes(action),
    "UNKNOWN_ACTION",
    "Unknown scenario.",
    400,
  );
  if (ADMIN.has(action)) {
    assert(session.admin, "FORBIDDEN", "Operator access required.", 403);
    assert(
      typeof body.reason === "string" && body.reason.trim().length >= 3,
      "REASON_REQUIRED",
      "Enter an audit reason.",
      400,
    );
  }
  assertRestoreFence(s, body);
  let result = {};
  switch (action) {
    case "scenario_return_before_start": {
      const r = rental(s, session, body.rentalId);
      if (r.pendingReturn) return { rental: r };
      assert(
        ["PREPARING", "DISPENSE_UNKNOWN"].includes(r.physicalStatus),
        "INVALID_STATE",
        "Use a prepared or unknown dispense rental.",
      );
      const { slot: pendingSlot } = returnSlot(s, body.stationId);
      const collectedAt =
        r.mockCollectedAt || Math.max(r.createdAt, at - 60000);
      const e = evidence(s, r, "RETURN_RECEIVED_BEFORE_COLLECTION", at, at, {
        stationId: body.stationId,
        slotId: pendingSlot.id,
        timelineStatus: "PENDING_COLLECTION",
      });
      for (const t of s.stations)
        for (const origin of t.slots)
          if (origin.lock === r.id) origin.bankId = null;
      pendingSlot.bankId = r.bankId;
      pendingSlot.lock = `timeline:${r.id}`;
      pendingSlot.quarantined = true;
      r.mockCollectedAt = collectedAt;
      r.physicalStatus = "DISPENSE_UNKNOWN";
      r.commandStatus = "UNKNOWN";
      r.reservationStatus = "QUARANTINED";
      r.timelineStatus = "PENDING_COLLECTION";
      r.pendingReturn = {
        eventId: e.id,
        commandId: r.commandId,
        collectedAt,
        returnedAt: at,
        stationId: body.stationId,
        slotId: pendingSlot.id,
      };
      addCase(
        s,
        r.id,
        "TIMELINE_PENDING",
        "Return evidence persisted before collection. Query the original command; no new dispense or automatic charge.",
        at,
      );
      result = { rental: r };
      break;
    }
    case "scenario_clock_drift": {
      const r = rental(s, session, body.rentalId);
      assert(
        ["ACTIVE", "OVERDUE"].includes(r.physicalStatus),
        "INVALID_STATE",
        "An active rental is required.",
      );
      const { t, slot } = returnSlot(s, body.stationId);
      const e = evidence(
        s,
        r,
        "RETURN_CLOCK_DRIFT",
        r.startedAt - 3600000,
        at,
        { stationId: t.id, slotId: slot.id, clockTrusted: false },
      );
      slot.bankId = r.bankId;
      slot.quarantined = true;
      slot.lock = `review:${r.id}`;
      r.physicalStatus = "RETURNED";
      r.endedAt = at;
      r.returnStationId = t.id;
      r.financialStatus = "REVIEW_REQUIRED";
      r.billingHold = true;
      r.timelineStatus = "CLOCK_REVIEW";
      r.returnEvidenceId = e.id;
      r.billing = null;
      addCase(
        s,
        r.id,
        "CLOCK_DRIFT",
        "Untrusted device time: physical return accepted, billing held. Operator must review trusted evidence; no automatic fee or refund.",
        at,
      );
      result = { rental: r };
      break;
    }
    case "scenario_damaged_return": {
      const r = rental(s, session, body.rentalId);
      if (r.damageStatus) return { rental: r };
      apply(
        s,
        session,
        { action: "return", rentalId: r.id, stationId: body.stationId },
        at,
      );
      r.damageStatus = "REVIEW_REQUIRED";
      const slot = s.stations
        .flatMap((x) => x.slots)
        .find((x) => x.bankId === r.bankId);
      if (slot) {
        slot.quarantined = true;
        slot.lock = `damage:${r.id}`;
      }
      evidence(s, r, "DAMAGED_RETURN_ACCEPTED", r.endedAt, at);
      addCase(
        s,
        r.id,
        "DAMAGED_BANK",
        "Ordinary rental billing ended at physical return. Damage assessment is separate; no damage charge was made.",
        at,
      );
      result = { rental: r };
      break;
    }
    case "adjust_return_time": {
      const r = rental(s, session, body.rentalId);
      assert(
        r.physicalStatus === "RETURNED" && r.startedAt,
        "INVALID_STATE",
        "A physically returned rental with collection evidence is required.",
      );
      assert(
        Number.isFinite(body.returnedAt) &&
          body.returnedAt >= r.startedAt &&
          body.returnedAt <= (r.adjustedEndedAt || r.endedAt),
        "INVALID_TIME",
        "Trusted return must be between collection and existing return time.",
        400,
      );
      assert(
        typeof body.evidence === "string" && body.evidence.trim().length >= 5,
        "EVIDENCE_REQUIRED",
        "Provide a trusted evidence reference.",
        400,
      );
      if (
        (r.adjustments || []).some(
          (x) =>
            x.evidence === body.evidence && x.returnedAt === body.returnedAt,
        )
      )
        return { rental: r };
      const revisedFee = bill(r.pricing, r.startedAt, body.returnedAt),
        dep = money(r.pricing.depositMinor);
      if (r.billingHold) {
        r.endedAt = body.returnedAt;
        r.feeMinor = revisedFee;
        r.refundMinor = String(
          dep > money(revisedFee) ? dep - money(revisedFee) : 0n,
        );
        r.balanceDueMinor = String(
          money(revisedFee) > dep ? money(revisedFee) - dep : 0n,
        );
        r.refundStatus = "PENDING";
        r.financialStatus = "PENDING";
        r.billingHold = false;
        r.timelineStatus = "REVIEWED";
        r.billing = {
          durationSeconds: Math.ceil((r.endedAt - r.startedAt) / 1000),
          feeMinor: revisedFee,
          depositMinor: r.pricing.depositMinor,
          refundMinor: r.refundMinor,
          currency: "ARS",
          pricingVersion: r.pricing.id,
          finalizedAt: at,
        };
        const op = {
          id: uid("op"),
          rentalId: r.id,
          type: "REFUND",
          amountMinor: r.refundMinor,
          currency: "ARS",
          status: "PENDING",
          provider: "MOCK_PVS",
          createdAt: at,
          attempts: 1,
        };
        s.operations.unshift(op);
        s.outbox.push({
          id: uid("job"),
          rentalId: r.id,
          type: "QUERY_REFUND",
          status: "PENDING",
          createdAt: at,
          attempts: 0,
        });
      } else {
        assert(
          r.refundStatus === "SUCCEEDED",
          "SETTLEMENT_PENDING",
          "Complete the original refund before a post-settlement adjustment.",
        );
        const previousFee = money(r.adjustedFeeMinor || r.feeMinor);
        assert(
          money(revisedFee) <= previousFee,
          "ADJUSTMENT_INCREASE",
          "An earlier correction cannot increase the last adjusted fee.",
        );
        const previousRefund = dep > previousFee ? dep - previousFee : 0n,
          newRefund = dep > money(revisedFee) ? dep - money(revisedFee) : 0n;
        const extra = String(newRefund - previousRefund),
          id = uid("adjustment");
        const adjustment = {
          id,
          rentalId: r.id,
          originalBilling: structuredClone(r.billing),
          returnedAt: body.returnedAt,
          evidence: body.evidence,
          oldFeeMinor: String(previousFee),
          newFeeMinor: revisedFee,
          extraRefundMinor: extra,
          reason: body.reason,
          at,
        };
        (r.adjustments ||= []).push(adjustment);
        (s.billingAdjustments ||= []).push(adjustment);
        r.adjustedFeeMinor = revisedFee;
        r.adjustedEndedAt = body.returnedAt;
        r.effectiveRefundMinor = String(newRefund);
        r.balanceDueMinor = String(
          money(revisedFee) > dep ? money(revisedFee) - dep : 0n,
        );
        r.financialStatus =
          money(r.balanceDueMinor) > 0n ? "REVIEW_REQUIRED" : "SETTLED";
        if (money(extra) > 0n) {
          const op = {
            id: uid("op"),
            rentalId: r.id,
            type: "ADJUSTMENT_REFUND",
            adjustmentId: id,
            amountMinor: extra,
            currency: "ARS",
            status: "SUCCEEDED",
            provider: "MOCK_PVS",
            createdAt: at,
            attempts: 1,
          };
          s.operations.unshift(op);
          s.ledger.unshift({
            id: uid("ledger"),
            operationId: op.id,
            rentalId: r.id,
            type: op.type,
            amountMinor: extra,
            currency: "ARS",
            at,
          });
        }
        result.adjustment = adjustment;
      }
      evidence(s, r, "TRUSTED_RETURN_ADJUSTMENT", body.returnedAt, at, {
        evidence: body.evidence,
        reason: body.reason,
      });
      result.rental = r;
      break;
    }
    case "simulate_provider_difference": {
      assert(
        ["duplicate", "missing", "amount", "currency", "clear"].includes(
          body.kind,
        ),
        "INVALID_SCENARIO",
        "Choose duplicate, missing, amount, currency, or clear.",
        400,
      );
      if (body.kind === "clear") {
        s.providerFixtures = [];
        break;
      }
      const op = s.operations.find(
        (o) =>
          o.status === "SUCCEEDED" &&
          (!body.operationId || o.id === body.operationId),
      );
      assert(op, "OPERATION_NOT_FOUND", "A successful operation is required.");
      const fixture = {
        id: uid("fixture"),
        operationId: op.id,
        kind: body.kind,
        createdAt: at,
      };
      (s.providerFixtures ||= []).push(fixture);
      result.fixture = fixture;
      break;
    }
    case "reconcile_provider": {
      const { items, rows } = compareProvider(s);
      const rec = {
        id: uid("rec"),
        provider: "MOCK_PVS_EXTERNAL_FIXTURE",
        createdAt: at,
        status: items.length ? "DIFFERENCES" : "MATCHED",
        items,
        providerRows: rows,
        operationCount: s.operations.length,
      };
      s.reconciliation.unshift(rec);
      if (s.restoreFence?.active && rec.status === "MATCHED") {
        s.restoreFence.active = false;
        s.restoreFence.reconciledAt = at;
        s.restoreFence.reconciliationId = rec.id;
        s.config.rentalsEnabled = s.restoreFence.previousRentalsEnabled;
      }
      result.reconciliation = rec;
      break;
    }
    case "backup_export": {
      const snapshot = structuredClone(s);
      delete snapshot.backups;
      delete snapshot.restorePreviews;
      delete snapshot.sessions;
      const backup = { id: uid("backup"), createdAt: at, version: 1, snapshot };
      (s.backups ||= []).push(backup);
      result.backup = {
        id: backup.id,
        createdAt: at,
        version: 1,
        rentalCount: s.rentals.length,
        operationCount: s.operations.length,
      };
      break;
    }
    case "restore_preview": {
      const backup = s.backups?.find((x) => x.id === body.backupId);
      assert(
        backup,
        "BACKUP_NOT_FOUND",
        "Choose an existing server-side mock backup.",
        404,
      );
      const missing = backup.snapshot.operations.filter(
        (o) => !s.operations.some((x) => x.id === o.id),
      );
      const preview = {
        id: uid("preview"),
        backupId: backup.id,
        createdAt: at,
        status: missing.length ? "BLOCKED_MISSING_LIVE_OPERATIONS" : "READY",
        missingOperationIds: missing.map((x) => x.id),
        strategy:
          "RESTORE_CONFIGURATION_PRESERVE_LIVE_EFFECTS_RECONCILE_BEFORE_RESUME",
        stale:
          s.operations.length !== backup.snapshot.operations.length ||
          s.events.length !== backup.snapshot.events.length,
        warning:
          "No rollback of live payments, inventory, commands, or idempotency keys. Restores configuration/pricing only; live financial and device state takes precedence.",
      };
      (s.restorePreviews ||= []).push(preview);
      result.preview = preview;
      break;
    }
    case "restore_apply": {
      const preview = s.restorePreviews?.find((x) => x.id === body.previewId);
      assert(
        preview,
        "PREVIEW_REQUIRED",
        "Preview a stored backup first.",
        400,
      );
      assert(
        preview.status === "READY",
        "RESTORE_BLOCKED",
        "Missing live operations require manual recovery; never replay snapshot payments.",
      );
      assert(
        !s.restoreFence?.active,
        "RESTORE_FENCED",
        "Complete the existing restore reconciliation first.",
      );
      assert(
        !preview.appliedAt,
        "RESTORE_ALREADY_APPLIED",
        "This preview has already been applied.",
      );
      const backup = s.backups?.find((x) => x.id === preview.backupId);
      assert(backup, "BACKUP_NOT_FOUND", "Backup unavailable.", 404);
      assert(
        backup.snapshot.operations.every((o) =>
          s.operations.some((x) => x.id === o.id),
        ),
        "RESTORE_BLOCKED",
        "Live operation history changed; preview recovery again.",
      );
      const restoredConfig = structuredClone(backup.snapshot.config);
      s.restoreFence = {
        active: true,
        backupId: preview.backupId,
        previewId: preview.id,
        createdAt: at,
        previousRentalsEnabled: restoredConfig.rentalsEnabled,
        restoredDomains: ["config", "pricingVersions"],
        preservedDomains: [
          "rentals",
          "operations",
          "ledger",
          "outbox",
          "inbox",
          "events",
          "idempotency",
          "stations",
        ],
      };
      s.config = { ...restoredConfig, rentalsEnabled: false };
      s.pricingVersions = structuredClone(backup.snapshot.pricingVersions);
      preview.appliedAt = at;
      result.restoreFence = s.restoreFence;
      break;
    }
  }
  if (ADMIN.has(action))
    addAudit(
      s,
      "DEMO_OPERATOR",
      action,
      body.rentalId || body.backupId || body.previewId || "mock_operations",
      body.reason,
      at,
    );
  return result;
}
