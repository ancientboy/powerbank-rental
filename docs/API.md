# Implemented API contract (demo v1)

Source of truth: `src/api.mjs`, `src/domain.mjs` and `src/scenarios.mjs`. These are **not** the plan's resource-oriented routes. There is no generated TypeScript client or complete OpenAPI conformance claim.

## Transport

GET state routes drain due mock jobs before returning. GET `/v1/bootstrap`, `/v1/me`, `/v1/stations`, `/v1/rentals`, `/v1/rentals/active` all return the same full filtered state envelope, not distinct paginated resources. GET `/v1/health` returns `{data:{status:"ok",mode:"DEMO",storage:"server-persisted"},request_id}`; this is not an end-to-end database/queue probe.

POST `/v1/actions` requires JSON `{action: string, ...fields}`, exact same-origin Origin, session cookie, `X-CSRF-Token` from bootstrap and `Idempotency-Key` matching `[\w-]{8,100}`. Secure hosted cookie is HttpOnly, SameSite=Strict, path `/`, seven-day lifetime; local dev omits Secure. All successful actions currently return HTTP 200.

Success: `{data, result, request_id}`. Replay adds `replayed:true`, returns original result plus current public state. Idempotency scope combines session-token hash, current user (or auth scope for login/admin_login) and current operator/user role; payload digest is exact raw JSON text (even whitespace/key-order changes conflict). Same scope/key with changed bytes returns 409 IDEMPOTENCY_CONFLICT. Retain key and identical bytes after uncertain responses. A new session is a new scope.

Error: `{error:{code,message,retryable},request_id}`; no implemented `current_state`/allowed-actions fields. Retryable is mechanically status >=500, so REAL_PROVIDER_DISABLED is also flagged retryable despite requiring integration work. Typical codes include SESSION_EXPIRED (401), FORBIDDEN/CSRF_ORIGIN/CSRF_TOKEN (403), RESOURCE_NOT_FOUND (404), domain conflicts (409), INVALID_REQUEST/MONEY/TIME (400), INVALID_CONTENT_TYPE (415), PAYMENT_METHOD_UNAVAILABLE (422), RATE_LIMITED (429), BUSY_RETRY (503). Body limit is 12,000 text characters after read, plus advertised Content-Length check; this is not a streaming byte-limit implementation. Successful state transactions retain a per-session 120/minute request log; failed transactions do not commit that log, so it is not a complete abuse defense.

All `/v1/webhooks/*` paths reject with 503 REAL_PROVIDER_DISABLED. Other routes return 404. There are no live callback, unlock, card-entry, receipt-file or production admin routes.

## Action fields

Fields below are exact camelCase. Optional fields are marked `?`. Unknown extra fields are generally ignored, not rejected by a strict JSON schema. Most actions return an empty `result`; use `data` for updated state.

| action | Fields | Access / result |
|---|---|---|
| login | provider: apple or google; scenario?: cancelled | Public demo; result.user; cancelled returns AUTH_CANCELLED |
| logout | none | Clears user and operator flags |
| admin_login | none | Public, intentionally insecure operator simulation |
| admin_logout | none | Clears operator flag |
| resolve | code: manual station code or same-origin URL with station query parameter | Public; server sets origin, validates code; result.station |
| quote | stationId | Session; result.quote; 5-minute snapshot |
| rent | quoteId, acceptedTerms: true | Session; owned valid quote; result.rental |
| pay | rentalId, method: card/apple_pay/google_pay/bank_transfer, scenario?: success/declined/pending/unknown | Owned rental; simulation only |
| collect | rentalId, scenario?: success/jammed/unknown/not_taken | Owned PREPARING rental; simulation evidence only |
| reconcile | rentalId | Owned rental; deterministically resolves simulated pending payment, unknown dispense or refund |
| return | rentalId, stationId, scenario?: success/offline/wrong_bank/refund_failed | Owned ACTIVE/OVERDUE; simulator, not user proof of real return |
| retry_refund | rentalId | Alias to reconcile, not a provider refund API |
| cancel | rentalId | AWAITING_FUNDS without pending/unknown money |
| advance | minutes: integer 1..10080 | Any signed-in demo user/operator; current browser-workspace clock |
| support | message: 5..2000 characters, rentalId?, category? | Owned rental if provided; result.case |
| delete_account | none | Records request, not deletion; result.deletion |
| capability | method, partialRefund: boolean, reason | Operator; disables/enables a MOCK partial-refund capability, never real provider capability |
| station_update | stationId, status: ONLINE/OFFLINE/PAUSED, reason | Operator simulation |
| config | rentalsEnabled: boolean, reason | Operator simulation |
| pricing | rateMinor, depositMinor, capMinor (integer strings), reason | Operator; appends TEST version |
| resolve_case | caseId, reason | Operator; marks resolved |
| reconcile_all | reason | Operator; checks successful operations missing internal ledger; result.reconciliation |
| return_review | rentalId, stationId, returnedAt (epoch ms), evidence (at least 5 chars), reason | Operator; reviewed simulated return; requires known start and valid time |
| refund | rentalId, amountMinor, reason | Operator; retry only exact computed refundable balance, finalized physical outcome, not already succeeded |
| reset | reason | Operator; resets current browser workspace, retains users/sessions |

Operator mutations above require reason with at least three trimmed characters. `restore` is not implemented and returns UNKNOWN_ACTION. There is no supported API for importing backups or discretionary additional refunds; `refund` only retries the computed balance.

## Public state

`mode,user,admin,stations,pricing,rentals,activeRental,cases,csrf,serverTime,config,adminData`. Stations expose available/emptySlots and hide slot internals. Rentals are filtered by session user. `adminData` is null unless simulated admin, then includes audit, operations, events, cases, rentals, stations, price versions, reconciliation, ledger, outbox and minimally projected users. Monetary values are minor-unit decimal strings; times are epoch milliseconds. No production authorization guarantee follows from these demo projections.

## Advanced simulation actions

All use the same POST `/v1/actions`, ownership, CSRF and idempotency envelope. Operator actions require `reason` (at least three trimmed characters). They are simulator controls, never evidence of an actual bank or payment.

| action | Exact fields | Access / behavior |
|---|---|---|
| scenario_return_before_start | rentalId, stationId | Owned prepared/unknown rental; persists return before delayed collection; subsequent reconcile reconstructs original command timeline |
| scenario_clock_drift | rentalId, stationId | Owned active rental; physical return, quarantined asset, billingHold and CLOCK_REVIEW |
| scenario_damaged_return | rentalId, stationId | Owned active rental; stops ordinary billing, quarantines bank, separate damage case, no damage charge |
| adjust_return_time | rentalId, returnedAt, evidence, reason | Operator; trusted earlier time in valid interval; resolves billing hold or appends post-settlement adjustment; preserves original finalized bill |
| simulate_provider_difference | kind: duplicate/missing/amount/currency/clear, operationId?, reason | Operator; modifies synthetic external statement fixture |
| reconcile_provider | reason | Operator; compares synthetic statement/operations/ledger; returns result.reconciliation; clears demo restore fence only if MATCHED |
| backup_export | reason | Operator; server-side mock snapshot; returns result.backup metadata, not a downloadable full database export |
| restore_preview | backupId, reason | Operator; returns result.preview; blocks missing live operations; explains configuration-only restore strategy |
| restore_apply | previewId, reason | Operator; applies preview once, restores only config/pricing, retains live money/device/idempotency facts, activates restoreFence and stops new rentals |

A restore fence blocks specified simulated monetary/dispense actions and bootstrap job draining. It is not an independently enforced external-provider disaster-recovery fence. `adminData` also includes advanced backup/preview/fence/adjustment data as implemented; consult source rather than assuming these fields are a permanent production API.

### Final inventory and polling additions

`adminData.inventory` contains station slots, bank identities, allocation locks and quarantine flags. `inventory_review {stationId, slotId, evidence, reason}` requires the demo operator role and releases only inspected `review:` or `damage:` quarantine locks, never active rental locks. Station status can also be `STALE`, which blocks new quotes. Active/order pages poll bootstrap every six seconds while visible; financial/device truth still comes from server-side job processing.
