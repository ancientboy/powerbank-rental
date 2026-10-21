# WsCharge 6.0A: offline protocol implementation

Evidence: user-supplied **WsCharge Api.pdf**, version 6.0A, dated 2024-09-18, 13 physical PDF pages. The original PDF and extracted text are not copied into the repository, Site or deployment. The following is an implementation analysis, not a certified vendor integration.

## Implemented boundary

- `src/wscharge.mjs`: pure, bounded JSON validation and normalization. Direction and field profile are required. It preserves original JSON values, distinguishes cabinet identity from slot identity, rejects duplicate keys/slots/banks, unknown fields and ambiguous aliases.
- `decodeWsCharge` is a local offline decoder only. It has no socket, HTTP client, credential handling, executable outbound serializer or domain mutation.
- `inspectWsChargeFixture` accepts only a predefined synthetic fixture name in an authenticated **simulated operator session**. `/v1/actions` retains CSRF, origin, idempotency and session checks. There is no raw device ingress endpoint and no user-entered provider payload feature.
- Operations → **WsCharge offline** exposes synthetic inventory, borrow response, return, startup and offline announcements. Fixture identifiers are invented DEMO values, not real cabinet, bank or IoT card identifiers.
- Codes 80, 81 and 67 are classified by the decoder for review only. No force-eject, eject-all or restart execution control exists.
- The existing rental simulator remains a separate, explicitly synthetic evidence source. Decoding a WsCharge response never calls `collect`, `return`, settlement, refund, or updates station availability.

## Explicit profiles, not auto-detection

The inventory table on physical p8 names slot `L`; the example on p9 uses `terminalArr[].E`. Top-level `E` remains the cabinet ID. The local `table-fields` profile interprets array entries using numeric `L`; the local `example-fields` profile uses two-digit string `E`. Both keys together are rejected, including equal values. The table does not fully define the array envelope or status placement, so the table-inspired profile requires supplier confirmation.

Table fields describe numeric slot/status and signal; examples use zero-padded slot strings, status string `200`, and hexadecimal signal `1F`. The profiles do not coerce across these formats. Original values remain available in the normalized result. Slot range is the documented UInt16 range; no capacity or actual valid slot allocation is inferred. Conservative local ID rules require alphanumeric cabinet16/bank12/IoT20; character-set support must be confirmed rather than silently widened.

The decoder caps input at 8192 UTF-8 bytes, nesting at5 levels, and inventory at128 entries. These are local defensive limits, not supplier capacity claims. Empty arrays or missing bank records never prove that a slot is free: capacity, free slots and inventory completeness remain unknown. A missing `S` in the inventory example is not treated as success.

## Evidence semantics and page references

| Document reference | Field/message | Safe interpretation |
|---|---|---|
| p4 §1.1 | E/L/B | Cabinet, slot and immutable bank are distinct identities; U is not documented authentication. |
| p7 §2.1 | I60 | Cabinet startup announcement, not customer/OAuth login or authenticated transport. |
| p7–8 §2.2 | I90 | Unverified offline observation; heartbeat and disconnection detection unspecified. |
| p8–9 §2.3 | I64 | Inventory report/query shape, not a command-status or collection proof. |
| p9–10 §2.4 | I65/S200 | Response semantics unknown. No physical pickup, timer start, reservation release or retry authority. Non200 is also not a known-safe failure. |
| p10 §2.5 | I66 | Untrusted return observation. No event identity, trusted occurrence time or sequence; no automatic billing stop/refund from this codec. |
| p10–13 §2.6–2.8 | I80/I81/I67 | Maintenance-only shape recognition, no real execution. |

Every decoded result has `authenticated:false`, `eventId:null`, `occurredAt:null`, `sequence:null`, `liveSendAllowed:false` and an empty `automaticEffects` array. These are deliberately missing facts, not generated substitutes for supplier evidence.

## Supplier questions needed before live development

1. **Server integration:** direct-device protocol or existing cloud gateway? Provide transport/protocol, production and sandbox host/port/URL, framing, TLS, authentication, server/device binding and tenant/service-U rules. Do not put secrets into ordinary chat or this repository. “Ws” does not establish WebSocket transport.
2. **Compatibility:** supported cabinet models and firmware, latest protocol revision, sandbox/simulator and an explicitly approved test cabinet, slot and power bank.
3. **Inventory:** resolve L versus nested E, numeric versus string/hex encoding, complete slot capacity, empty/fault/locked/charging states, and exact meaning/placement of S. Confirm ID character sets and field lengths.
4. **Borrow evidence:** exactly when is I65/S200 emitted? Separate received, mechanical eject, physically removed and not-taken/jam states. Provide full success/error catalogue, sensor behavior and partial-failure semantics.
5. **Command lifecycle:** correlation/deduplication identity, query of an original command, timeout and safe retry rules, and response-loss behavior. Do not substitute I64 state comparison or maintenance eject for authoritative original-command resolution.
6. **Return evidence:** authentication/signature, unique event identity, occurrence timestamp/time zone/clock drift, sequence, ACK/retry, offline buffering and reconnect backfill, duplicate replay across multiple rentals, and cross-cabinet rules.
7. **Operations:** heartbeat/freshness thresholds, offline detection, replay retention, reconnect reconciliation, tenant isolation and incident procedure.

If the confirmed transport requires inbound raw TCP or MQTT, a separate authenticated gateway may be necessary because Sites runs an HTTP Worker. Do not choose a transport or create a public webhook until its official security and ingress contract is available. No PVS, Apple or Google capability is established by this device document.

## Verification

The new test suite covers all fixture profiles, ambiguous aliases, duplicate JSON keys and inventory identities, strict encodings/ranges, malformed/oversized input, forbidden direction, unsupported fields/codes, maintenance classification, operator authorization, and absence of rental/ledger/inventory effects. The built Worker smoke exercises the packaged offline route and verifies existing settled rental data is unchanged. This does not replace real firmware, transport, hardware or mobile/browser validation.
