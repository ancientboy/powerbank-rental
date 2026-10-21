/** Provider-independent contracts. These are mock protocols, never PVS protocols. */
export const MOCK_CAPABILITIES = Object.freeze(
  Object.fromEntries(
    ["card", "apple_pay", "google_pay", "bank_transfer"].map((method) => [
      method,
      {
        charge: true,
        partialRefund: true,
        query: true,
        authorize: false,
        capture: false,
        release: false,
        currency: "ARS",
        environment: "MOCK_ONLY",
      },
    ]),
  ),
);
export class DisabledRealProvider {
  constructor(name) {
    this.name = name;
  }
  async execute() {
    throw new Error(
      `${this.name}: real integration is disabled until credentials, capability verification and approval are complete.`,
    );
  }
}
export class MockPaymentProvider {
  constructor(capabilities = MOCK_CAPABILITIES) {
    this.capabilities = capabilities;
  }
  supports(method, type) {
    return !!this.capabilities[method]?.[type];
  }
  charge({ operationId, amountMinor, currency, method, scenario = "success" }) {
    if (
      !this.supports(method, "charge") ||
      !this.supports(method, "partialRefund")
    )
      return { status: "UNSUPPORTED" };
    if (currency !== "ARS" || !/^\d{1,12}$/.test(amountMinor))
      throw new Error("INVALID_MONEY");
    return {
      operationId,
      amountMinor,
      currency,
      status: {
        success: "SUCCEEDED",
        declined: "FAILED",
        pending: "PENDING",
        unknown: "UNKNOWN",
      }[scenario],
      provider: "MOCK_PVS",
    };
  }
  refund({ operationId, chargedMinor, alreadyRefundedMinor, amountMinor }) {
    if (
      BigInt(amountMinor) < 0n ||
      BigInt(amountMinor) + BigInt(alreadyRefundedMinor) > BigInt(chargedMinor)
    )
      throw new Error("REFUND_LIMIT");
    return { operationId, amountMinor, status: "PENDING" };
  }
}
export class MockDeviceProvider {
  dispense(command) {
    return { ...command, status: "ACKNOWLEDGED" };
  }
  query(command, observation) {
    if (command.id !== observation.commandId)
      throw new Error("COMMAND_MISMATCH");
    return observation;
  }
}
function bytes(text) {
  return new TextEncoder().encode(text);
}
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw",
    bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes(text))),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
/** Test-only ingress protocol proving reject/dedupe ordering; not a real vendor API. */
export async function signMockEnvelope(secret, payload) {
  const raw = JSON.stringify(payload);
  return { raw, signature: await hmac(secret, raw) };
}
export async function verifyMockEnvelope(
  secret,
  envelope,
  expected,
  seenIds,
  now,
) {
  const signature = await hmac(secret, envelope.raw);
  if (envelope.signature?.length !== signature.length)
    throw new Error("BAD_SIGNATURE");
  let difference = 0;
  for (let i = 0; i < signature.length; i++)
    difference |= signature.charCodeAt(i) ^ envelope.signature.charCodeAt(i);
  if (difference) throw new Error("BAD_SIGNATURE");
  const event = JSON.parse(envelope.raw);
  if (
    event.provider !== "MOCK_ONLY" ||
    event.merchant !== expected.merchant ||
    event.currency !== expected.currency ||
    event.amountMinor !== expected.amountMinor ||
    event.rentalId !== expected.rentalId
  )
    throw new Error("EVENT_MISMATCH");
  if (
    !event.id ||
    !Number.isSafeInteger(event.sequence) ||
    !Number.isFinite(event.occurredAt) ||
    event.occurredAt > now + 30000
  )
    throw new Error("INVALID_EVENT");
  if (seenIds.includes(event.id)) return { duplicate: true, event };
  seenIds.push(event.id);
  return { duplicate: false, event };
}
