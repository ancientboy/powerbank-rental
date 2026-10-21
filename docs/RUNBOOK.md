# Demo operation and production recovery design

## Start, check and inspect

Use README commands. `npm test` exercises in-process domain/API behavior; `npm run check` checks syntax; `npm run build` packages the Worker. Verify the deployed `/v1/health` plus a bootstrap response and one controlled mock lifecycle before sharing a link. A successful build is not a deployed-health result. The DB binding must exist and the D1 migration must run; otherwise API returns DATABASE_UNAVAILABLE. Use the operator simulation to inspect operations, outbox, timeline, cases and ledger. Do not put private incident information into a public demo.

## Stop new rentals

Operator → stop new rentals with an audit reason; this sets rentalsEnabled=false. Existing users may return and reconcile. A station can be ONLINE/OFFLINE/PAUSED; current code treats PAUSED as not rentable but allows returns if a slot is free. Preserve cases for unknown money/device outcomes. Never fix an unknown by reset, fresh payment key or another dispense command.

## Scenario recovery

Payment pending/unknown: query original simulated payment; no second charge. Dispense unknown: leave asset quarantined and query original command. Confirmed jam/not taken: no rental fee, full deposit refund pending. Returned/refund failed: keep endedAt fixed, retry/query original refund. Wrong bank: investigate the case without ending the current rental. Amount over deposit: review balance due; no automatic extra debit. `reconcile_all` checks only missing internal ledger records. `reconcile_provider` additionally checks synthetic external fixture missing/duplicate/amount/currency discrepancies, not authentic provider settlements. Resolving a case does not repair an operation automatically.

## Demo backup/restore

Local development: stop the process cleanly and use a SQLite-consistent backup (SQLite backup API or a checkpointed, closed database copy), capturing `.local/demo.sqlite`, required WAL state if not checkpointed, and code/migration version in restricted backup storage. Do not copy only an active main SQLite file while WAL writes exist. Checksum and verify the backup by opening an isolated copy. To restore only a mock environment, stop the process, preserve current database and WAL files separately, validate backup integrity/schema, restore the consistent database snapshot, then restart and inspect. Backups contain session hashes and user-entered demo text: protect them and never publish them with source.

Hosted D1: use the approved platform export/snapshot mechanism with operator authorization; capture revision/payload, schema migration and release ID. Advanced backup_export/restore_preview/restore_apply actions are implemented as a server-side configuration/pricing recovery demonstration, not a full database restore or download API. Live mock operations, ledger, inventory, events and idempotency are preserved; missing live operations block replay; the simulated fence remains until synthetic provider reconciliation matches. The plain `restore` action is not implemented. An admin reset is destructive to demonstration history and is not backup recovery. Perform recovery on an isolated copy first. There is no claimed measured RPO/RTO or hosted recovery drill.

## Mandatory external-operation fence for a future live system

1. Disable new rentals and **fence all external writes** (charge, refund, capture, release, dispense). Stop/disable dispatch workers and revoke their dispatch leases. A UI stop-new-rent flag alone is insufficient: this code has a demo action/job fence, not a live external-system fence independent of the restored database.
2. Preserve logs, original database, durable incoming evidence and operation IDs. Continue authenticated event reception into a quarantine/durable intake that will not trigger external writes; preserve user return/support visibility.
3. Restore database/config/migration to an isolated environment. Keep the dispatch fence active. Do not allow recovered old outbox rows to send commands.
4. Independently query supplier/payment facts for the backup-point-to-incident interval and all unresolved operations. Reconcile by merchant operation ID, device command ID and immutable bank, not merely order status.
5. Rebuild missing inbox, operation, ledger and idempotency evidence through reviewed import/repair actions. Preserve original records and append compensating adjustments. Quarantine unresolved assets; never guess timeout means failed.
6. Compare inventory, provider statements, refunds, charge totals, lease state and queue age. Verify restored duplicates cannot cause external effects. Run crash-after-send and old-release/new-schema compatibility tests.
7. Obtain incident owner's documented approval. Resume reads/queries first, then narrowly permitted settlement actions, then device dispatch and finally new rentals. Monitor for unknowns and duplication. Keep rollback and fence available.

A database rollback cannot undo real money or mechanical actions. Never restore an old backup and start all workers blindly. The fence must be an independently effective control outside restored state, or restoring the database could restore its old 'enabled' value.

## Release and rollback

Use expand-contract migrations, retain previous application artifact, back up before migration, and verify old/new schema compatibility. Roll back application/traffic, not external consequences. Current demo schema has no tested forward migration beyond initial creation. Production requires capacity, queue/backoff, alert routing, credential rotation and restore evidence before Go. Agree RPO/RTO, log retention and alert thresholds with owners rather than copying test values.

## Support handoff

Track incident ID, affected rental/operation/command, immutable bank, observed/occurred timestamps, last verified fact, unknowns, owner and next query. Inform the user truthfully: payment pending is not charged confirmation; requested refund is not money received. Production support addresses, on-call rota, suppliers and legal terms are unresolved owner inputs, not invented placeholders.
