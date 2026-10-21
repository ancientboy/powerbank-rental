# Domain and simulator invariants

Implemented physical states: AWAITING_FUNDS → PREPARING → ACTIVE → RETURNED. Alternatives: DISPENSE_UNKNOWN (quarantined until query), NOT_DISPENSED (confirmed failure/full refund obligation), CANCELLED, EXPIRED, OVERDUE (over seven elapsed days). ACTIVE eligibility list includes awaiting/preparing/unknown/active/overdue; one such rental per synthetic user. Financial state is independently PENDING, SETTLED or REVIEW_REQUIRED; a returned bank never resumes ordinary billing because its refund failed.

Payment statuses include CREATED, FAILED, PENDING, UNKNOWN, SUCCEEDED. Commands use NONE, ACKNOWLEDGED, UNKNOWN, FAILED, SUCCEEDED. Refunds use NONE, PENDING, FAILED, SUCCEEDED (reconciliation also recognizes UNKNOWN). These are simplified string fields and guarded actions, not a complete independently typed production state-machine library.

## Current test rules, not approved commercial terms

Seed TEST_v1 uses ARS minor units: rate 50000 per 3600 seconds, deposit 1000000, cap 300000 per elapsed 86400-second block. Positive fractional duration rounds up to a whole second, then to a whole unit. Zero duration costs zero. Arithmetic uses BigInt; accepted monetary inputs are 1–12 decimal digits, nonnegative. Cap is applied separately to full elapsed 86400-second periods and the residual partial period, **not Buenos Aires local calendar days**. At 24 hours plus one second the TEST fee is 350000 rather than immediately jumping to two full caps. No configured free period or tax model is implemented. Pricing updates retain unit duration/currency and append a snapshot; rate/deposit must be positive, cap >= rate. Quotes and reservations each last five minutes.

Each rental stores its accepted price snapshot and TEST_TERMS_v1 consent. Amount above the deposit creates a balance-due review case, not a second debit. Fee below deposit creates the remaining refund obligation. The ledger is append-style in ordinary actions with one entry per operation, but not a full double-entry accounting ledger and reset clears it.

## Enforced demo behavior

- Server resolves price and inventory; a quote cannot override money using client fields.
- Reservation locks a bank's current slot. Collection removes it from the slot and releases slot lock while the rental retains bank identity.
- UNKNOWN dispense keeps the reservation quarantined; repeated collect is rejected and reconciliation retains command ID.
- Payment received after reservation expiry does not dispense; it creates full refund obligation.
- Decline and ACK alone do not start rental time. Simulated BANK_COLLECTED does.
- Return finds an empty slot, matches the rental's bank, freezes endedAt and creates one refund operation. Duplicate return is inert; wrong_bank creates a case.
- Offline fixture uses max(startedAt, current simulated time minus 15 minutes). This is a deterministic fixture, not validated clock evidence.
- Stop-new-rent blocks quote/rent while returns and reconciliation remain available.

## Deliberate gaps

No authentic provider webhook verification, trusted hardware clocks, real authorization/capture expiry, verified real instrument capabilities, independently scheduled outbox dispatch or stale-inventory TTL enforcement exists. Mock adapters check selected capabilities and signed fixture envelopes; advanced scenarios implement synthetic delayed-start return buffering, clock-drift billing holds, damaged-return quarantine and append-only post-settlement correction examples. These are not authentic provider ingress or complete production accounting. Expiry is evaluated when actions run. GET state requests drain due QUERY_PAYMENT and QUERY_REFUND mock jobs (default due after 8 seconds; batch limit 20), with bounded error backoff/dead-letter states. No scheduled Worker hook is wired, so idle workspaces do not progress without requests. FAILED refunds are marked for review rather than auto-success. Station coordinates/hours and availability are fictional fixtures, not current real businesses. Admin case resolution does not by itself repair money or hardware facts. Deletion requests do not erase or anonymize records. These boundaries must remain visible during acceptance.
