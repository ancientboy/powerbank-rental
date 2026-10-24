# Physical rental operations

The hardware flow uses real cabinets and a **mock** financial ledger. This change
adds concurrency, recovery, and support handling; it does not enable live payments.

## Multiple customers

An account may have one open rental. A cabinet serializes release commands while
a release is awaiting confirmation (up to 60 seconds). Once release is confirmed,
other accounts may rent its other reported banks after a fresh inventory query.
Active rentals hold the bank identity. Unconfirmed/review orders hold both their
bank and original slot. A returned bank may be rented again after a post-return
inventory observation. Unreconciled standalone maintenance/test commands still
block their cabinet until explicitly reconciled. Sending retries never dispatches
again for the same order, including across a service restart.

## Exceptions

The server checks stored rentals every 15 seconds and at authenticated hardware /
admin requests. After 60 seconds without release confirmation, the order enters
`review_required`, retaining its reservation and deposit record. Unpaid quotes
expire after five minutes. These transitions also run after restart; they do not
contact the supplier or send a new release. A late valid successful release
callback can activate the order; matching return callbacks settle it once.

Administrators use **Work queue → Review order** or **Orders → Physical rentals →
View / handle order**. Owners and operators can:

- Refresh inventory (query only), recheck saved authenticated callbacks, or add a
  handling note. No release command is available here.
- Confirm no release and cancel: wait at least 60 seconds, verify the bank is in
  its original slot using fresh post-dispatch inventory, and document the check.
  The mock deposit is refunded once. Do not cancel an unknown outcome without
  checking the actual device/supplier outcome; inventory is not release telemetry.
- Confirm a missing return: verify the matching bank in fresh inventory and add a
  note. The fallback return time is the inventory observation, explicitly marked
  `operator_verified_inventory`, not an invented earlier return time. Fees and
  refunds remain mock records. A later callback does not duplicate settlement.
- Acknowledge a completed balance review: record a note and clear the work item.
  This does not waive, debit, or otherwise change the outstanding amount.

A late successful release after a reviewed cancellation reopens an exception and
holds the bank again without reversing the refund. Its subsequent return does not
charge a fee. Stale order status, stale inventory and viewer-role mutations fail.
All handling records include operator, note, action, before/after state and time.

## Customer support

**Get help with rental** links the authenticated user's physical order to a support
case. General help also remains available. Requests and replies are durable,
owner-scoped and retry-safe; a user cannot attach another account's order.

The admin **Support** inbox shows messages and reply history, links to the physical
order, and supports Open / In progress / Resolved. Any customer follow-up reopens
the case. **Work queue** includes open support and physical rental exceptions.
While the admin Support page is visible, a separate poll every 10 seconds updates counts
and offers inbox/review links without replacing an unfinished reply. The customer
support page checks for replies every 10 seconds when the user is not typing.
These are in-app updates only: no email, SMS, push or Telegram messages are sent.

## Validation boundary

Automated and isolated-browser checks cover overlapping rentals, reservation
conflicts, duplicate commands/callbacks, timeouts and late callbacks, reviewed
cancellation / return recovery, roles, CSRF, order ownership and the support reply
round trip. No physical release or real payment is issued during deployment.
Two-account onsite borrowing and return is the remaining physical acceptance test.


## Pricing caps and buyout (policy version 1)

The owner configures hourly price, each rolling 24-hour cap, deposit, total cap/buyout price,
and maximum rental days on **Pricing**. Zero days disables time-based buyout. The initial
fallback total cap equals the deposit; no fixed buyout days are assumed. Total cap is positive,
at least one hour, and no greater than the deposit. Physical rentals now use these settings;
the virtual demo still uses its isolated illustrative pricing. Existing orders retain their
original snapshots, including legacy orders without this policy. Pending quotes retain their
snapshot for their five-minute validity period. The confirmation screen shows the terms.

Billing starts only at a successful release callback. A day means 24 elapsed hours, not a
calendar date. At the earlier of the first billed amount reaching the total cap and the
configured days, the order becomes `bought_out`, billing ends at that exact cutoff, and the
mock deposit covers the **inclusive** buyout total. Prior rent is not added again. An excess
deposit is refunded. No real payment provider is called. The 15-second maintenance task and
startup recovery process due orders even with no browser open; delayed processing retains
the original cutoff. All settlement ledger keys are stable and transactional.

`endedAt` is distinct from `returnedAt`. A bought-out bank remains unavailable until a real
return callback or operator-verified inventory establishes its return. Other banks and the
customer's next rental are not blocked by a settled buyout. Returned bought-out banks enter
Work queue for settlement review; duplicate callbacks cannot create another charge. A late
accepted callback proving return before buyout allows the operator to record a note and
refund the difference once via a separate correction ledger, retaining the original entries.
A return after buyout does not automatically reverse the agreed buyout; support reviews it.

An open/in-progress linked support request or post-release inventory showing the bank still
in a cabinet holds automatic buyout for review. Fees and displayed billing duration remain
capped. Resolving the ticket alone does not settle it: the operator must explicitly resume
automatic buyout or confirm return using device evidence. Unconfirmed/failed releases and
legacy rentals never auto-buyout. UI reminders appear after 80% of the available rental time;
no email, SMS or push delivery is claimed. Real money settlement remains a later integration.

## Support closure and customer pricing

Support has a direct Close ticket action, including unanswered or duplicate cases. It
preserves the conversation and audit record, removes the case from the open queue, and
does not send a public reply. Draft replies must be sent or cleared first. Reopen ticket
and a customer follow-up restore the open state. Optimistic versions, CSRF and support
role checks apply. Closing support does not close or settle its associated rental.

The customer homepage and station list read the same effective pricing as the hardware
rental flow, including for test accounts. Simulated DEMO-001 rates remain separately
labelled. Refresh and the existing 30-second visible-page poll fetch new rates; if live
pricing cannot be loaded the UI shows no price rather than a demo fallback. Existing
rentals retain their price snapshots.


## Station locations and Google Maps

In Admin → Stations, add a store name, full street address, cabinet ID and the entrance's latitude/longitude in decimal degrees. Optional entrance/floor notes appear to customers. Detected unassigned cabinets can fill the ID; this associates a location and does not authorize new hardware or dispatch commands. One cabinet cannot be assigned to two stations.

Preview the map pin before saving. Blank coordinates are allowed for incomplete setup, but customers see “Map location not configured yet” and no map links. Configured active stations expose Google Maps search and directions links on Home and Stations, including for test accounts browsing real cabinets. Demo stations never get these links. These are external Google Maps URLs, not an embedded map or GPS tracker; no API key or customer location collection is needed. Reference: https://developers.google.com/maps/documentation/urls/get-started

Update the saved station on relocation. Saving coordinates does not verify the physical placement; the installer must check the pin at the store entrance. Existing rental price snapshots are unaffected.

Support reminders and Refresh inbox are rendered only inside Support. Leaving Support removes the reminder and stops notification polling; late responses cannot recreate it on another page. Reply drafts are preserved during notification polling.

## Per-cabinet pause and station operations

Stations → Cabinets and power banks → **Pause new rentals / Resume new rentals**.
Owner and operator roles must provide an internal handling note. The setting is
stored by cabinet ID even when store information has not yet been registered.
Stale edits conflict; changes retain actor and before/after audit snapshots.

The server checks pause before new quotes, before reserving an unpaid order and
before a new code 65 command. Refreshing inventory, inspecting orders, accepting
callbacks and settling returns continue. A command already sent cannot be
recalled. Resume does not bypass fresh inventory, ownership or reservation checks.
The public UI shows the pause but never exposes the internal handling note.
Station Active still controls listing; it is not the pause switch.

Station editing also accepts opening hours (informational, not automatic
scheduling), return/full-cabinet instructions and a confirmed total slot count.
Leave slot count empty if unconfirmed. Reported bank count does not prove that
other slots are physically empty or usable for return. Store access and opening
hours still constrain physical returns during a software pause.

## Repeatable concurrency verification

Run `node --test tests/hardware-concurrency.test.mjs` with Node 24.
The test binds a random loopback HTTP port, uses a disposable on-disk SQLite WAL
database and replaces all supplier network calls with a gated in-process mock.
It never accesses production data or cabinets.

50 accounts compete across 10 cabinets in five waves, sending 300 HTTP requests.
Expected results: 50 distinct physical reservations/commands, 100 temporary busy
responses (409), 50 completed orders and 150 mock ledger rows (deposit, rental
fee and refund per order). Retries and duplicate callbacks must not increase
those counts. Pause all cabinets, reopen the database/API, then return all banks;
orders must remain private to their owners and settle exactly once.
Latency includes mock command gates; it is not a production capacity guarantee.
This test exercises one Node process, not multiple application workers.

## PostgreSQL migration boundary

Current JSON records and synchronous DatabaseSync transactions remain SQLite.
Do not run this application against a shared SQLite file across machines or
claim that adding application workers alone implements multi-instance safety.
Before production scaling, introduce an asynchronous PostgreSQL repository,
explicit indexed order/reservation/ledger tables, database uniqueness constraints,
row locks for bank allocation, durable command dispatch/outcome reconciliation,
and idempotent callback handling across workers. Test at least two application
processes against the same PostgreSQL database, including restart/failure races.

Migration requires a consistent backup, rehearsal import and row/amount checks,
a controlled write cutover and a verified rollback strategy. Existing order
pricing snapshots and test/live labels must survive. Installing PostgreSQL alone
or replacing a connection string is not that migration. External notifications,
scheduled off-site backups and physical multi-account acceptance are separate
remaining launch work.

## Cabinet QR labels

In **Stations**, saving a station with a cabinet ID makes a QR card available
immediately. Existing supplier-configured cabinets are included even before a
store is assigned. Each card provides a preview, PNG and SVG downloads, a rental
page link, and **Print label** (browser printing or Save as PDF).

Codes contain the configured `PUBLIC_ORIGIN` plus `/rent?cabinet=<ID>`.
They never contain credentials, prices, addresses, order IDs, or dispatch commands.
They are generated locally on the application server without a third-party QR
service or an extra database image record. Updating a location, price, or pause
state does not change the code. Changing the cabinet ID requires a new label;
retired IDs are not automatically redirected to a replacement cabinet.

The download/metadata endpoint `/api/admin/cabinet-qr` requires an active admin
session (including read-only admins) and accepts only saved station bindings or
configured cabinet IDs. New or changed bindings must match `[A-Za-z0-9_-]{1,64}`,
consistent with the rental page. Legacy invalid bindings can still have their
other details edited, but show an actionable QR warning. No store binding alone
enables supplier access or hardware dispatch.

Labels are 80 mm wide on an A4 print sheet. Print at 100% scale, turn off browser
headers and footers, keep the four-module white margin clear, and verify the
printed code against the cabinet before service. PNG uses integer module scaling;
SVG is suitable for professional label layouts. Scanning opens a page only; the
existing login, rental confirmation and device checks still apply. An offline or
paused cabinet keeps its code and its existing rental restrictions.

The encoder is the MIT-licensed Project Nayuki v1.8.0 release, vendored with its
license and upstream SHA-256 in `src/vendor/qrcodegen.source.json`. Generated PNG
and SVG are independently decoded using the existing jsQR decoder in tests.

Customer Station cards also offer **View cabinet QR code**, with lazy loading,
PNG saving, a copyable rental link (manual selection fallback if clipboard access
is denied), and direct navigation to the same rental page. These controls only
perform GET requests. Offline and paused warnings remain visible; all rental
checks remain on the existing rental API. The public `/api/user/station-qr`
endpoint only serves cabinets in the current customer station listing, including
allowlisted devices awaiting location setup. Inactive/hidden stations return 404,
even when their image was previously generated. Admin QR access is unchanged.

## Home rental context

Home prioritizes the signed-in customer's current hardware rental and links to
its order and the existing Stations page for returns. Without a current rental,
Scan to rent remains the primary action. Nearby recommendations require explicit
location permission and valid station coordinates; the first station in the list
is never an implicit recommendation. Location is kept in browser memory, expires
after five minutes, and recommendations are limited to five kilometres.

## Multi-account scan integration verification

Run `node --test tests/hardware-concurrency.test.mjs tests/hardware-frontend.test.mjs tests/multi-account-scan.test.mjs` with Node 24.

The scan integration test decodes two actual generated QR PNGs with jsQR, checks
the customer scan parser, and runs the rental page controller for six independent
signed-in accounts against the real loopback HTTP API and disposable SQLite.
It covers competing confirmations, double clicks, six lost payment responses,
page reload recovery, missing inventory replies, cross-account order rejection,
duplicate release/return callbacks, and returns after a database/API restart with
new lending paused. Expected totals are six completed rentals, six release
commands and eighteen mock ledger entries with matching fees and refunds.

The DOM, login sessions, supplier and payments are synthetic. This verifies
software integration, not a phone camera, real Google authorization, physical
hardware or live payment processing. No production database or credentials are
used. This targeted group passed all 11 tests on 2026-10-24.
