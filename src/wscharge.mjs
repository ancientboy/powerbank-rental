/** Offline WsCharge v6.0A codec. No transport, commands or domain effects. */
import { Fault } from "./domain.mjs";

const WS_CODES = {
  60: "CABINET_LOGIN",
  90: "CABINET_OFFLINE",
  64: "INVENTORY",
  65: "DISPENSE_RESPONSE",
  66: "RETURN_OBSERVATION",
  80: "MAINTENANCE_FORCE_EJECT",
  81: "MAINTENANCE_EJECT_ALL",
  67: "MAINTENANCE_RESTART",
};
export const WS_PROFILES = ["table-fields", "example-fields"];
const wsCheck = (condition, message) => {
  if (!condition) throw new Fault("WSCHARGE_INVALID", message, 400);
};
const wsObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
function wsKeys(value, allowed, required) {
  wsCheck(wsObject(value), "A plain JSON object is required.");
  wsCheck(
    Object.keys(value).every((key) => allowed.includes(key)),
    "Undocumented or unsafe field.",
  );
  wsCheck(
    required.every((key) => Object.hasOwn(value, key)),
    "Required protocol field is missing.",
  );
}
function wsId(value, length, label) {
  wsCheck(
    typeof value === "string" &&
      new RegExp(`^[A-Za-z0-9]{${length}}$`).test(value),
    `${label} must use the conservative ${length}-character alphanumeric offline profile.`,
  );
  return value;
}
function wsInteger(value, max, label) {
  wsCheck(
    Number.isInteger(value) && value >= 0 && value <= max,
    `${label} is outside its numeric range.`,
  );
  return value;
}
function wsNumber(value, profile, kind) {
  const max = kind === "slot" ? 65535 : 999;
  if (profile === "table-fields") return wsInteger(value, max, kind);
  wsCheck(
    typeof value === "string" &&
      (kind === "slot" ? /^\d{2}$/ : /^\d{3}$/).test(value),
    `${kind} requires the documented example string shape.`,
  );
  return wsInteger(Number(value), max, kind);
}
// JSON.parse would silently overwrite duplicate keys. Detect them first,
// respecting escaped strings and nested object scopes; reject deep input.
function wsParse(text) {
  wsCheck(
    typeof text === "string" && new TextEncoder().encode(text).length <= 8192,
    "Protocol input exceeds 8192 bytes.",
  );
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      for (; i < text.length; i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === '"') break;
      }
      let key;
      try {
        key = JSON.parse(text.slice(start, i + 1));
      } catch {
        throw new Fault("WSCHARGE_INVALID", "Invalid JSON string.", 400);
      }
      let next = i + 1;
      while (/\s/.test(text[next] || "x")) next++;
      if (text[next] === ":" && stack.at(-1)?.keys) {
        wsCheck(
          !stack.at(-1).keys.has(key),
          "Duplicate JSON key is ambiguous.",
        );
        stack.at(-1).keys.add(key);
      }
    } else if (c === "{" || c === "[") {
      stack.push({ keys: c === "{" ? new Set() : null });
      wsCheck(stack.length <= 5, "Protocol nesting is too deep.");
    } else if (c === "}" || c === "]") stack.pop();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Fault("WSCHARGE_INVALID", "Invalid JSON.", 400);
  }
}
export function decodeWsCharge(input, { direction, profile } = {}) {
  wsCheck(
    ["cabinet-to-server", "server-to-cabinet"].includes(direction),
    "Explicit message direction is required.",
  );
  wsCheck(
    WS_PROFILES.includes(profile),
    "Explicit offline field profile is required.",
  );
  let text;
  try {
    text = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    throw new Fault("WSCHARGE_INVALID", "Input must be finite JSON.", 400);
  }
  const raw = wsParse(text);
  wsCheck(wsObject(raw), "Message must be an object.");
  wsCheck(
    Number.isInteger(raw.I) && Object.hasOwn(WS_CODES, raw.I),
    "Unknown function code.",
  );
  const up = direction === "cabinet-to-server",
    code = raw.I;
  wsCheck(
    up || ![60, 90, 66].includes(code),
    "This function has no documented downlink message.",
  );
  const maintenance = [80, 81, 67].includes(code);
  let allowed = ["I", "E"],
    required = ["I", "E"];
  if ([65, 80, 66].includes(code)) {
    allowed.push("L");
    required.push("L");
  }
  if (up && [65, 66].includes(code)) {
    allowed.push("B");
    required.push("B");
  }
  if (up && [65, 80, 81, 67].includes(code)) {
    allowed.push("S");
    required.push("S");
  }
  if (up && code === 64) {
    allowed.push("K", "X", "S", "terminalArr");
    required.push("K", "X", "terminalArr");
  }
  wsKeys(raw, allowed, required);
  const cabinetId = wsId(raw.E, 16, "Cabinet ID");
  const normalized = { cabinetId };
  if (Object.hasOwn(raw, "L"))
    normalized.slot = wsNumber(raw.L, profile, "slot");
  if (Object.hasOwn(raw, "B")) normalized.bankId = wsId(raw.B, 12, "Bank ID");
  if (Object.hasOwn(raw, "S"))
    normalized.statusCode = wsNumber(raw.S, profile, "status");
  if (up && code === 64) {
    normalized.iotCardId = wsId(raw.K, 20, "IoT card ID");
    if (profile === "table-fields")
      normalized.signal = wsInteger(raw.X, 31, "Signal");
    else {
      wsCheck(
        typeof raw.X === "string" && /^[0-9A-F]{1,2}$/.test(raw.X),
        "Example signal must be uppercase hexadecimal.",
      );
      normalized.signal = parseInt(raw.X, 16);
    }
    wsCheck(
      normalized.signal >= 1 && normalized.signal <= 31,
      "Signal must be 1–31.",
    );
    wsCheck(
      Array.isArray(raw.terminalArr) && raw.terminalArr.length <= 128,
      "Inventory array missing or beyond local safety limit.",
    );
    const slotField = profile === "table-fields" ? "L" : "E";
    const slots = new Set(),
      banks = new Set();
    normalized.banks = raw.terminalArr.map((bank) => {
      // Never silently accept both aliases, even when their values agree.
      wsKeys(bank, ["B", slotField, "D", "S"], ["B", slotField, "D"]);
      const bankId = wsId(bank.B, 12, "Bank ID"),
        slot = wsNumber(bank[slotField], profile, "slot");
      wsCheck(
        !slots.has(slot) && !banks.has(bankId),
        "Duplicate slot or bank is ambiguous.",
      );
      slots.add(slot);
      banks.add(bankId);
      const entry = {
        bankId,
        slot,
        batteryPercent: wsInteger(bank.D, 100, "Battery percent"),
      };
      if (Object.hasOwn(bank, "S"))
        entry.statusCode = wsNumber(bank.S, profile, "status");
      return entry;
    });
    normalized.capacity = null;
    normalized.freeSlots = null;
    normalized.inventoryCompleteness = "UNKNOWN";
  }
  return {
    vendor: "WsCharge",
    documentVersion: "6.0A",
    mode: "OFFLINE_ONLY",
    profile,
    direction,
    code,
    kind: !up ? `COMMAND_SHAPE_${code}` : WS_CODES[code],
    maintenance,
    raw,
    normalized,
    authenticated: false,
    eventId: null,
    occurredAt: null,
    sequence: null,
    outcome:
      up && code === 65
        ? "UNKNOWN_DISPENSE_EVIDENCE"
        : up && code === 66
          ? "UNTRUSTED_RETURN_OBSERVATION"
          : up && Object.hasOwn(raw, "S")
            ? "UNKNOWN_STATUS_SEMANTICS"
            : "UNVERIFIED_OBSERVATION",
    automaticEffects: [],
    liveSendAllowed: false,
    warnings: [
      "No authenticated transport, command correlation, event ID or trusted occurrence time is specified.",
      ...(code === 65
        ? [
            "Status 200 does not establish physical collection or authorize billing.",
          ]
        : []),
      ...(code === 66
        ? [
            "Return observation cannot stop billing, settle or refund without authenticated, correlated evidence and time policy.",
          ]
        : []),
      ...(code === 64
        ? [
            "Missing inventory entries do not establish empty or available slots; the table-field profile is a local interpretation awaiting confirmation.",
          ]
        : []),
      ...(maintenance
        ? [
            "Maintenance message classification only. No execution or serialization for dispatch is exposed.",
          ]
        : []),
    ],
  };
}
const wsCabinet = "DEMO000000000001",
  wsBank = "DEMO00000001",
  wsCard = "DEMO0000000000000001";
export const WS_FIXTURES = Object.freeze({
  inventory_example: {
    profile: "example-fields",
    direction: "cabinet-to-server",
    payload: {
      I: 64,
      E: wsCabinet,
      K: wsCard,
      X: "1F",
      terminalArr: [{ B: wsBank, E: "03", D: 80 }],
    },
  },
  inventory_table: {
    profile: "table-fields",
    direction: "cabinet-to-server",
    payload: {
      I: 64,
      E: wsCabinet,
      K: wsCard,
      X: 31,
      terminalArr: [{ B: wsBank, L: 3, D: 80, S: 200 }],
    },
  },
  dispense_200: {
    profile: "example-fields",
    direction: "cabinet-to-server",
    payload: { I: 65, E: wsCabinet, L: "03", B: wsBank, S: "200" },
  },
  dispense_unknown: {
    profile: "example-fields",
    direction: "cabinet-to-server",
    payload: { I: 65, E: wsCabinet, L: "03", B: wsBank, S: "599" },
  },
  return_observation: {
    profile: "example-fields",
    direction: "cabinet-to-server",
    payload: { I: 66, E: wsCabinet, L: "03", B: wsBank },
  },
  cabinet_login: {
    profile: "table-fields",
    direction: "cabinet-to-server",
    payload: { I: 60, E: wsCabinet },
  },
  cabinet_offline: {
    profile: "table-fields",
    direction: "cabinet-to-server",
    payload: { I: 90, E: wsCabinet },
  },
});
export function inspectWsChargeFixture(session, body) {
  if (!session.admin)
    throw new Fault(
      "FORBIDDEN",
      "Enter the simulated operator session first.",
      403,
    );
  wsCheck(
    typeof body.fixture === "string" &&
      Object.hasOwn(WS_FIXTURES, body.fixture),
    "Choose a known synthetic fixture.",
  );
  const fixture = WS_FIXTURES[body.fixture];
  return {
    synthetic: true,
    fixture: body.fixture,
    observation: decodeWsCharge(fixture.payload, fixture),
  };
}
