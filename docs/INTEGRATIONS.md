# Adapter contracts and fail-closed real-integration gate

**Current status:** simulation logic lives in domain actions and src/scenarios.mjs. src/adapters.mjs provides MockPaymentProvider, MockDeviceProvider, DisabledRealProvider, mock capabilities, and signed-envelope fixture helpers. The pay path checks MOCK charge/partialRefund/query support. The following complete adapter interfaces are target contracts, not a claim all listed methods are already implemented/wired. No PVS legal entity, API URL, signature algorithm, merchant or hardware protocol is asserted. Mock success is not provider evidence.

## Required interfaces

AuthProvider: `start({returnPath,state,nonce,pkceChallenge}) -> authorizationRequest`; `verifyCallback({rawRequest,expectedState,expectedNonce,pkceVerifier}) -> {provider,subject,profile,verifiedAt}`; `revoke({identity})`. Verify signature, iss/aud/exp, single-use state/nonce and exact approved redirect before creating a session. Email never establishes identity equivalence. Separate operator identity and role authorization from customer identity.

PaymentProvider: `capabilities({merchant,instrument,currency,fundingMode})`; `createCheckout({intentId,operationId,idempotencyKey,amountMinor,currency,returnUrl})`; `charge/authorize/capture/release/refund({operationId,originalOperationId?,amountMinor,currency,idempotencyKey})`; `queryOperation({operationId,providerReference?})`; `verifyAndNormalizeWebhook({rawBody,headers})`; `fetchSettlement({period,cursor})`. Unsupported capabilities fail explicitly. Return normalized PENDING/UNKNOWN/SUCCEEDED/FAILED and provider IDs, never infer failure from timeout. Preserve merchant operation ID across safe retries. Ledger changes follow verified results, matching merchant, intent, amount and currency.

DeviceProvider: `inventory({cabinetId})`; `dispense({commandId,cabinetId,slotId,bankId})`; `queryCommand({commandId})`; `verifyAndNormalizeEvent({rawBody,headers})`. ACK, mechanically dispensed and physically collected are distinct facts. Command query must resolve the same operation; UNKNOWN cannot allocate another bank or send a fresh command. Event envelope includes provider namespace/event ID, event type, immutable bank, cabinet/slot, occurred/received times, sequence, payload version, verification and correlation ID. Persist inbox before acknowledge; deduplicate and transactionally emit outbox.

## Required gates, all currently unapproved for live use

1. D01–D20: name a decision owner; record version, approval, date and evidence. Approve prices, tax display, rental limits, funding mode, time authority, terms, retention, refund powers, pilot limits and incident targets. TEST defaults must fail startup for a live deployment.
2. Apple and Google: owners configure approved domains/projects/Services ID and callbacks; credentials through secret management, not chat/repository/browser. Implement real verified server callbacks and session rotation/revocation; run invalid/expired/replayed token and real-device suites. Real operator authentication and privileged action audit are mandatory.
3. PVS: obtain exact official identity/docs and merchant permissions. For each proposed instrument record Argentina/ARS support, checkout/tokenization, authorization/capture/release/charge/refund/partial-refund, webhook, queries, settlement and disputes as VERIFIED/UNSUPPORTED/PENDING with evidence. All real-provider entries currently PENDING; internal MOCK capability flags and UI labels are simulation only. The fixture HMAC is not the unknown PVS signature protocol and must never be presented as its implementation.
4. Hardware: choose supplier/firmware; verify signed events, immutable assets, slot identities, inventory freshness, evidence semantics, command dedupe/query, offline sequencing, full slots, mechanical failure and drift. No device credential/command until authorized.
5. Runtime: remove public mock login/admin/advance/collect/return/reconcile/reset endpoints from live routing. Use explicit production configuration validation that rejects missing approved artifacts and any mock provider. Do not add a production toggle to this demo and assume it is safe.
6. Storage/workers: implement the normalized migration and cross-row concurrency invariants; transactional inbox/outbox, leased workers, bounded backoff and queue alerts, namespace-safe keys, event retention and restoration fence. Run real database concurrency and crash-after-send tests.
7. Acceptance: real sandbox per tool, hardware lab per firmware/slot, security remediation, encrypted backup/restore drill, support ownership, approved pilot and final settlement reconciliation. Only an explicit Go record opens live traffic.

## Capability worksheet

| Integration | Current evidence | Next owner action |
|---|---|---|
| Apple/Google | Synthetic stable subjects; no actual token verification | Identity owner provides approved app/domain setup |
| PVS and all four UI instruments | Internal synthetic operation records only | Payment owner provides official docs and merchant capability proof |
| Device | WsCharge 6.0A offline codec and synthetic fixture inspection; no verified transport | Device owner supplies missing transport/security/evidence specification and approved test cabinet |
| Pricing/legal | TEST_v1 and TEST_TERMS_v1 | Product/finance/legal approve real versions |
| Infrastructure | D1 single-row schema and Node tests | Engineering/operations validate production migration and recovery |

Do not create credentials, accept supplier agreements or send real funds as part of this documentation. Those actions require authorized owners and the applicable confirmation process.

## WsCharge document received

See [WsCharge offline implementation and supplier questions](WSCHARGE.md). The protocol-shaped lab is intentionally separate from simulated rental events. Its output cannot call collect, return, refund or mutate inventory. Real device ingress remains disabled.
