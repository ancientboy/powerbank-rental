# ADR-001: dependency-free demo runtime

Status: implemented for simulation; not a production architecture approval. Date: 2026-10-21.

## Decision

Use vanilla HTML/CSS/JavaScript, ES modules and Node's built-in test runner. A build script concatenates domain/store/API/Worker modules and embeds static assets in a Cloudflare-compatible Worker. D1 stores one `demo_state` row per hashed browser-session workspace with revision and JSON payload. Each mutation reads the aggregate, executes a synchronous domain action, and conditionally updates `WHERE revision = old_revision`; up to 12 CAS attempts are allowed, then BUSY_RETRY. MemoryStore serializes transactions and clones state before mutation.

This is intentionally different from the plan's React/Next.js/TypeScript frontend, NestJS modular monolith, independent queue Worker and normalized PostgreSQL. Dependency-free packaging makes a small demonstrable artifact possible without claiming a full framework application exists. A package-lock.json records the dependency-free package. Node 24 is the tested local toolchain. A GitHub Actions workflow is supplied for syntax checks, tests, build and built-Worker smoke verification; it has not been run on an external GitHub runner. Syntax checks are not TypeScript type checks. No production capacity report is implied.

## Transaction and safety boundary

`apply` must remain synchronous and side-effect free with respect to external services: CAS retries can rerun it. No network call, email, payment or hardware command may be inserted inside it. Mock operations and events are data only. Persisted outbox jobs are drained in bounded batches on GET bootstrap/state requests after their due time. This is request-driven mock recovery, not an independently scheduled distributed worker. Explicit reconciliation remains available. Current webhook endpoints fail closed with 503 REAL_PROVIDER_DISABLED.

Each browser workspace shares one aggregate, creating contention, unbounded payload growth and expensive whole-state reads/writes. Session-scoped idempotency records and events have no implemented retention job. GET bootstrap also persists session lookup and can contend with mutations. Local development now uses SQLite/WAL through the same CAS store adapter. Tests exercise actual SQLite, not deployed D1 service concurrency or PostgreSQL.

## Authentication caveat

`login` assigns a fixed synthetic identity per provider. `admin_login` deliberately grants operator simulation without credentials. Cookie/CSRF protections demonstrate browser request boundaries, but cannot make these identities or admin controls secure. These are not real identity accounts. Workspaces are isolated by hashed browser-session cookie, but any visitor can operate/reset their own workspace, and selecting either provider is not proof of identity. Losing the cookie loses access to that workspace. Do not collect real private information. Logout clears identity/role fields but does not rotate/revoke the cookie itself. Production login, RBAC, privileged reauthentication and session revocation are outstanding.

## Migration path

Before live operation: select and pin supported toolchains; separate web/admin/API/worker boundaries; replace JSON aggregate with reviewed PostgreSQL migrations; preserve stable operation IDs and import/audit history; implement transactional outbox, leases, retries and provider-query recovery; enforce database allocation/amount constraints; introduce real identity and admin access; run contract, concurrency, restore, security, sandbox and hardware suites. The reference SQL is design material only, not a migration applied by this application. Switching environment variables cannot enable production safely.
