const icons = {
  bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z"/>',
  scan: '<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3M8 12h8"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/>',
  arrow: '<path d="m9 5 7 7-7 7"/>',
  back: '<path d="m14 5-7 7 7 7"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  shield:
    '<path d="m12 2 8 3v7c0 5-8 10-8 10S4 17 4 12V5l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M2 10h20M6 15h4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 4 3c-1 .5-1 1-1 2m0 3h.01"/>',
  battery:
    '<rect x="4" y="5" width="14" height="14" rx="3"/><path d="M21 10v4M8 9v6m4-6v6"/>',
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V10Z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-7M3 3v6h6m3-3v6l4 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  logout: '<path d="M9 4H4v16h5m6-12 4 4-4 4m-7-4h11"/>',
  bank: '<path d="m3 7 9-5 9 5H3Zm2 3v8m7-8v8m7-8v8M3 21h18"/>',
  refresh:
    '<path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5m-4 8a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/>',
  cable: '<path d="M8 2v4m8-4v4M6 6h12v3a6 6 0 0 1-12 0V6Zm6 9v7"/>',
  external:
    '<path d="M14 3h7v7m0-7L10 14M10 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.bolt}</svg>`;
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const money = (v) =>
  new Intl.NumberFormat("en-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 2,
  })
    .format(Number(v || 0) / 100)
    .replace("ARS", "ARS ");
const date = (v) =>
  v
    ? new Date(v).toLocaleString("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
const lab = {
  backupId: null,
  previewId: null,
  restoreSummary: null,
  restoreFence: false,
};
let state = null,
  quote = null,
  selectedMethod = "card",
  busy = false,
  view = "home",
  viewId = null,
  adminTab = "overview",
  camera = null,
  scanTimer = null,
  serverOffset = 0;
const app = document.querySelector("#app");
const pendingKeys = new Map();
let actionRevision = 0;
const timestamp = (v) =>
  typeof v === "number" || /^\d+$/.test(String(v)) ? Number(v) : Date.parse(v);
function toast(t) {
  const el = document.querySelector("#toast");
  el.textContent = t;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 4500);
}
async function load() {
  const r = await fetch("/v1/bootstrap", { credentials: "same-origin" });
  const j = await r.json();
  if (!r.ok)
    throw Error(j.error?.message || "Could not connect. Please try again.");
  state = j.data;
  serverOffset = Number(state.serverTime) - Date.now() || 0;
  return state;
}
async function act(action, payload = {}) {
  if (busy) return null;
  busy = true;
  actionRevision += 1;
  document
    .querySelectorAll("[data-act],button[type=submit]")
    .forEach((b) => (b.disabled = true));
  try {
    const body = JSON.stringify({ action, ...payload });
    const requestKey =
      pendingKeys.get(body) ||
      (crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    pendingKeys.set(body, requestKey);
    const r = await fetch("/v1/actions", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": state.csrf,
        "Idempotency-Key": requestKey,
      },
      body,
    });
    const j = await r.json();
    if (!r.ok)
      throw Error(
        j.error?.message ||
          j.message ||
          "This action could not be completed. Please try again.",
      );
    pendingKeys.delete(body);
    state = j.data;
    serverOffset = Number(state.serverTime) - Date.now() || 0;
    return j.result || j.data?.result || {};
  } catch (e) {
    toast(e.message);
    return null;
  } finally {
    busy = false;
    render();
  }
}
function go(page, id) {
  if (modalHistoryClosing) { queuedNavigation = [page, id]; queuedModal = null; return; }
  while (modalContext) closeModal({ navigation: true });
  stopCamera();
  view = page;
  viewId = id || null;
  location.hash = page + (id ? "/" + encodeURIComponent(id) : "");
  render();
  window.scrollTo({ top: 0, behavior: "instant" });
}
function station(id) {
  return (
    state.stations.find((s) => s.id === id) ||
    state.stations[0] || {
      name: "Station",
      address: "",
      available: 0,
      emptySlots: 0,
    }
  );
}
function rental() {
  return (
    state.rentals.find((r) => r.id === viewId) ||
    state.activeRental ||
    state.rentals[0]
  );
}
function badge(status) {
  return `<span class="pill ${/OFFLINE|FAILED|CANCEL/.test(status) ? "offline" : /PENDING|UNKNOWN|REVIEW|STALE|QUARANTINED|DIFFERENCES|PAUSED/.test(status) ? "warning" : ""}">${esc(
    String(status || "Ready")
      .replaceAll("_", " ")
      .toLowerCase(),
  )}</span>`;
}
function header() {
  return `<header class="header"><button class="brand" data-go="home" aria-label="Smile home"><img class="brand-mark" src="/smile-mark.svg" alt="" width="38" height="38">Smile</button><nav class="nav" aria-label="Main"><button data-go="home" class="${view === "home" ? "current" : ""}">Rent a power bank</button><button data-go="stations" class="${view === "stations" ? "current" : ""}">Find a station</button><button data-go="history" class="${view === "history" ? "current" : ""}">My rentals</button><button data-go="support">Get help</button></nav><button class="avatar" data-go="profile" aria-label="Your account">${state.user ? esc(state.user.name?.charAt(0) || "D") : icon("user")}</button></header>`;
}
function footer() {
  return `<footer class="footer"><span>© 2026 Smile · Demo experience</span><div class="footer-links"><button data-modal="terms">Demo terms</button><button data-modal="privacy">Privacy</button><button data-go="guide">Demo guide</button><button data-go="admin">Operations ↗</button></div></footer><nav class="mobile-bottom" aria-label="Mobile navigation">${[
    ["home", "scan", "Rent"],
    ["stations", "pin", "Stations"],
    ["history", "history", "Rentals"],
    ["profile", "user", "Account"],
  ]
    .map(
      ([p, i, t]) =>
        `<button data-go="${p}" class="${view === p ? "current" : ""}">${icon(i)}${t}</button>`,
    )
    .join("")}</nav>`;
}
function head(title, sub, back = "home") {
  return `<div class="page-head"><button class="back" data-go="${back}">${icon("back")} Back</button><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ""}</div>`;
}
function qr() {
  return `<div class="qr-art"><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i><svg viewBox="0 0 90 90" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M2 2h28v28H2V2Zm7 7v14h14V9H9ZM60 2h28v28H60V2Zm7 7v14h14V9H67ZM2 60h28v28H2V60Zm7 7v14h14V67H9Z"/><path d="M38 2h10v10H38zm0 19h10v17H31v10H12V38H2v10h10v10h27V48h9V30h10V20H48zm20 18h11v9H58zm20 0h10v19H68V48h10zM39 59h10v10h10V58h10v20H58v10H48V78h-9zm39 9h10v20H68V78h10z"/></svg></div>`;
}
function stationSummary(s) {
  return `<div class="station-line"><div class="icon-box">${icon("pin")}</div><div class="grow"><h3>${esc(s.name)}</h3><p class="small muted">${esc(s.address)}</p></div>${badge(s.status)}</div>`;
}
function home() {
  const s = state.stations[0],
    p = state.pricing;
  return `<section class="hero"><div class="hero-copy"><p class="eyebrow"><span class="dot"></span> POWER YOUR EVERYDAY</p><h1>Scan.<br>Charge.<br><span>Go.</span></h1><p class="hero-sub">A little power. A lot more freedom.<br>Rent a power bank. Keep your day going.</p><div class="compatibility"><span>${icon("cable")} USB-C</span><span>${icon("bolt")} Lightning</span><span>${icon("battery")} Ready when you are</span></div><div class="desktop-note">${icon("shield")} No subscriptions. Just power, on your terms.</div></div><div class="scan-card"><div class="scan-top"><span>${icon("bolt")} YOUR NEXT CHARGE STARTS HERE</span><span>01 / 03</span></div>${qr()}<h3>Find the QR code on the station</h3><p>Scan it. Grab a power bank. You're good to go.</p><button class="btn" data-go="${state.activeRental ? "active" : "scan"}">${icon(state.activeRental ? "battery" : "scan")}${state.activeRental ? "View current rental" : "Scan to rent"}${icon("arrow")}</button><button class="text-button" data-go="scan">Or enter a station code</button></div></section>${!state.config.rentalsEnabled ? '<div class="notice warning">New rentals are temporarily paused. Existing rentals and returns are still available.</div>' : ""}<section class="below-hero"><div class="station-feature"><div class="section-heading"><h2>A little closer to a full battery</h2><button class="text-button" data-go="stations">All stations ↗</button></div>${s ? stationSummary(s) : "<p>No stations available</p>"}<div class="inline-stats"><span><strong>${s?.available || 0}</strong> ready to rent</span><span><strong>${s?.emptySlots || 0}</strong> return slots</span><span>Updated ${date(s?.updatedAt || state.serverTime)}</span></div></div><div class="mini-card"><div><p class="eyebrow">SIMPLE TEST PRICING</p><p class="price-big">${money(p.rateMinor)} <small>/ hour</small></p></div><p class="small muted" style="margin-top:8px">Refundable test deposit ${money(p.depositMinor)}.<br>Illustrative only. You won't be charged.</p></div></section>`;
}
function scan() {
  return `<section class="page">${head("A quick scan.<br>A full day ahead.", "Scan the code on a station, or enter it below.")}<div class="scan-view"><video id="camera" playsinline muted></video>${qr()}</div><div class="split" style="margin-top:15px"><button class="btn secondary" data-act="camera">${icon("scan")}Open camera</button><button class="btn primary" data-act="demo_scan">Try demo station</button></div><p class="small muted" style="margin-top:12px">Camera access is optional. In this demo, a station code works just as well.</p><form id="scan-form"><label class="input-label" for="station-code">Station code</label><input class="input" id="station-code" name="code" placeholder="${esc(state.stations[0]?.code || "VG-PAL-001")}" autocomplete="off" required><button type="submit" class="btn wide" style="margin-top:14px">Continue ${icon("arrow")}</button></form><div class="notice">${icon("shield")} Only station codes in this demo are accepted. Unknown QR links won't be opened.</div></section>`;
}
function login() {
  return `<section class="page">${head("Good to have<br>you here.", "A quick sign-in, and you’re one step closer to a charge.", "scan")}<div class="panel center"><div class="large-icon">${icon("bolt")}</div><h2>Less login.<br>More living.</h2><p class="small muted" style="margin-top:14px">Try the full journey with a simulated account.<br>No Apple or Google credentials needed.</p><div class="button-stack"><button class="btn" data-act="login" data-provider="apple"><strong style="font-size:20px">●</strong> Continue with Apple · Demo</button><button class="btn secondary" data-act="login" data-provider="google"><strong style="font-size:20px;color:#4285f4">G</strong> Continue with Google · Demo</button></div></div><p class="small muted center">Simulation only. Real identity providers are not connected.<br>Read the <button class="text-button" data-modal="terms">demo terms</button> and <button class="text-button" data-modal="privacy">privacy notice</button>.</p></section>`;
}
function quotePage() {
  if (!quote)
    return `<section class="page">${head("Let’s find your station.", "Your quote needs refreshing.")}<button class="btn primary wide" data-go="scan">Choose a station</button></section>`;
  const s = station(quote.stationId),
    p = quote.pricing;
  return `<section class="page">${head("Your next charge.", "Everything you need to know before you go.", "scan")}<div class="steps"><i class="on"></i><i></i><i></i></div><div class="panel">${stationSummary(s)}<div class="inline-stats"><span><strong>${s.available}</strong> power banks available</span><span>USB-C · Lightning</span></div></div><div class="panel"><p class="eyebrow">TEST PRICING · ${esc(p.id || state.pricing.id)}</p><div class="row"><span class="label">Rental rate</span><strong>${money(p.rateMinor)} / hour</strong></div><div class="row"><span class="label">Refundable deposit</span><strong>${money(p.depositMinor)}</strong></div><div class="row"><span class="label">Daily cap</span><strong>${money(p.capMinor)}</strong></div><div class="row total"><span>Test amount to pay</span><span>${money(p.depositMinor)}</span></div><p class="small muted" style="margin-top:12px">Billed by each started hour after simulated pickup. The rental fee is deducted from your test deposit; any remainder is refunded. These are test rules, not commercial prices.</p></div><p class="small muted">Quote expires ${date(quote.expiresAt)}. No real money will move.</p><label class="check-label"><input type="checkbox" id="accept-terms"> <span>I agree to the <button class="text-button" style="padding:0" data-modal="terms">demo rental terms</button> and test pricing. I understand this is a simulation.</span></label><button class="btn primary wide" data-act="rent">Choose payment method ${icon("arrow")}</button></section>`;
}
const methods = [
  ["card", "card", "Debit / credit card", "Simulated card · no card details"],
  ["apple_pay", "shield", "Apple Pay", "Simulated wallet payment"],
  ["google_pay", "shield", "Google Pay", "Simulated wallet payment"],
  ["bank_transfer", "bank", "Bank transfer", "Simulated instant transfer"],
];
function payment() {
  const available = methods.filter(
    ([id]) => state.capabilities?.[id]?.partialRefund !== false,
  );
  if (!available.some(([id]) => id === selectedMethod))
    selectedMethod = available[0]?.[0] || "";
  const r = rental();
  if (!r) return emptyRental();
  return `<section class="page">${head("Pick your way<br>to pay.", "Secure in principle. Simulated for this demo.", "active")}<div class="steps"><i class="on"></i><i class="on"></i><i></i></div><div class="panel"><div class="row" style="padding:0"><span class="label">Refundable test deposit</span><strong class="price-big">${money(r.pricing.depositMinor)}</strong></div></div>${methods.map(([id, i, n, s]) => `<button class="payment-option ${selectedMethod === id ? "selected" : ""}" data-method="${id}" ${state.capabilities?.[id]?.partialRefund === false ? "disabled" : ""}><div class="icon-box">${icon(i)}</div><div class="grow"><strong>${n}</strong><span class="small muted">${state.capabilities?.[id]?.partialRefund === false ? "Unavailable · required partial refunds unsupported" : s}</span></div><span class="radio"></span></button>`).join("")}${scenarioSettings("payment", demoSelections.payment)}<div class="notice">${icon("shield")} This button runs a payment simulator. Do not enter real payment information. PVS is not connected.</div><button class="btn primary wide" ${!selectedMethod ? "disabled" : ""} data-act="pay" data-id="${esc(r.id)}">Simulate payment · ${money(r.pricing.depositMinor)} ${icon("arrow")}</button><button class="text-button" style="display:block;margin:12px auto" data-act="cancel" data-id="${esc(r.id)}">Cancel this rental</button></section>`;
}
function activePage() {
  const r = rental();
  if (!r) return emptyRental();
  if (r.physicalStatus === "RETURNED") return receipt(r);
  if (/CANCELLED|FAILED|NOT_DISPENSED|EXPIRED/.test(r.physicalStatus))
    return receipt(r);
  if (["ACTIVE", "OVERDUE"].includes(r.physicalStatus)) {
    const s = station(r.stationId);
    return `<section class="page">${head("You’re all<br>charged up.", "A little power. Wherever your day takes you.")}<div class="panel lime center"><p class="eyebrow">${icon("bolt")} RENTAL IN PROGRESS</p><div class="timer" id="timer" data-start="${esc(r.startedAt)}">${duration(r.startedAt)}</div><p class="timer-sub">Time since confirmed demo pickup</p><div class="battery-illustration">${icon("bolt")}</div><h3 style="margin-bottom:5px">Power bank ${esc(r.bankId)}</h3><p class="small">Return to any available demo station.</p></div><div class="panel"><div class="row"><span class="label">Picked up at</span><strong>${esc(s.name)}</strong></div><div class="row"><span class="label">Estimated rental fee</span><strong>${money(r.estimatedFeeMinor)}</strong></div><div class="row"><span class="label">Test rate</span><strong>${money(r.pricing.rateMinor)} / hour</strong></div><div class="row"><span class="label">Deposit paid</span><strong>${money(r.pricing.depositMinor)}</strong></div></div><button class="btn wide" data-go="stations">${icon("pin")} Find a return station ${icon("arrow")}</button><div class="split" style="margin-top:12px"><button class="btn secondary" data-act="advance">${icon("clock")}Skip 80 demo minutes</button><button class="btn secondary" data-go="support">Need a hand?</button></div><p class="small muted center" style="margin-top:15px">The server determines final time and fees. Refreshing will not lose this rental.</p></section>`;
  }
  if (
    r.physicalStatus === "PREPARING" ||
    r.physicalStatus === "DISPENSE_UNKNOWN"
  ) {
    return `<section class="page">${head("Your power bank<br>is almost ready.", "Payment is confirmed by the demo server.", "home")}<div class="steps"><i class="on"></i><i class="on"></i><i class="on"></i></div><div class="panel center"><div class="battery-illustration">${icon("bolt")}</div><h2>Pick up. Plug in. Go.</h2><p class="small muted" style="margin-top:14px">${esc(station(r.stationId).name)}<br>Follow the light on the station and gently take your power bank.</p>${r.commandStatus ? `<div style="margin-top:15px">${badge(r.commandStatus)}</div>` : ""}</div><div class="notice">${icon("info")} No physical station is connected. The action below sends simulated device evidence, not a real dispense command.</div>${scenarioSettings("pickup", demoSelections.pickup)}<button class="btn primary wide" ${r.physicalStatus === "DISPENSE_UNKNOWN" ? "disabled" : ""} style="margin-top:16px" data-act="collect" data-id="${esc(r.id)}">Simulate device pickup ${icon("arrow")}</button>${r.commandStatus === "UNKNOWN" ? `<button class="btn secondary wide" style="margin-top:10px" data-act="reconcile" data-id="${esc(r.id)}">Check original command</button>` : ""}</section>`;
  }
  return `<section class="page">${head("Your rental<br>is waiting.", "Complete the next step below.")}<div class="panel">${stationSummary(station(r.stationId))}<div class="row"><span class="label">Payment</span>${badge(r.paymentStatus)}</div><div class="row"><span class="label">Rental</span>${badge(r.physicalStatus)}</div></div>${/PENDING|UNKNOWN/.test(r.paymentStatus) ? `<div class="notice warning">${icon("clock")} The payment result is still being checked. Do not start a second payment.</div><button class="btn primary wide" data-act="reconcile" data-id="${esc(r.id)}">Check payment status ${icon("refresh")}</button>` : `<button class="btn primary wide" data-go="payment" data-id="${esc(r.id)}">${/DECLINED|FAILED/.test(r.paymentStatus) ? "Try payment again" : "Continue to payment"} ${icon("arrow")}</button>`}<button class="text-button" data-go="support">Something wrong? Get help</button></section>`;
}
function duration(start) {
  const sec = Math.max(
    0,
    Math.floor((Date.now() + serverOffset - timestamp(start)) / 1000),
  );
  return [Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60]
    .map((v) => String(v).padStart(2, "0"))
    .join(":");
}
function stationsPage() {
  const r = state.activeRental;
  return `<section class="page">${head(["ACTIVE", "OVERDUE"].includes(r?.physicalStatus) ? "A good place<br>to power down." : "Power around<br>the corner.", ["ACTIVE", "OVERDUE"].includes(r?.physicalStatus) ? "Choose an available slot, then simulate your return." : "Demo stations in Buenos Aires. No location access needed.")}<div class="map-art" aria-label="Illustrative map, not live navigation"><div class="map-pin">${icon("bolt")}</div><span class="map-label">Buenos Aires · Illustrative map</span></div><div class="section-heading"><h3>${state.stations.length} demo stations</h3><button class="text-button" data-act="refresh">Refresh inventory ↻</button></div><div class="station-list">${state.stations.map((s) => `<article class="station-item">${stationSummary(s)}<div class="inline-stats"><span><strong>${s.available}</strong> to rent</span><span><strong>${s.emptySlots}</strong> empty slots</span><span>${esc(s.hours)}</span></div><p class="small muted" style="margin-top:9px">Inventory updated ${date(s.updatedAt || state.serverTime)}</p><div class="actions">${["ACTIVE", "OVERDUE"].includes(r?.physicalStatus) ? `<button class="btn primary tiny" data-return-station="${esc(s.id)}" ${s.status !== "ONLINE" || s.emptySlots < 1 ? "disabled" : ""}>Return here ${icon("arrow")}</button>` : `<button class="btn primary tiny" data-choose-station="${esc(s.id)}" ${s.status !== "ONLINE" || s.available < 1 ? "disabled" : ""}>Rent here ${icon("arrow")}</button>`}<button class="btn secondary tiny" data-station-info="${esc(s.id)}">Station details</button></div></article>`).join("")}</div><p class="small muted" style="margin-top:15px">Inventory comes from the demo server. Addresses and hours are illustrative, not a real service directory.</p></section>`;
}
function receipt(r) {
  const returned = r.physicalStatus === "RETURNED";
  return `<section class="page">${head(returned ? "Returned.<br>Day well powered." : "Your rental details.", returned ? "Device return confirmed. Your rental timer has stopped." : "A clear record of your demo rental.", "history")}<div class="panel center"><div class="large-icon">${icon(returned ? "check" : "info")}</div><p class="eyebrow">${returned ? "RENTAL COMPLETE" : "RENTAL STATUS"}</p><h2>${r.billingHold ? "Under review" : money(r.adjustedFeeMinor ?? r.feeMinor)}</h2><p class="small muted" style="margin-top:7px">${r.billingHold ? "Return received · billing under review" : r.adjustedFeeMinor !== undefined ? "Adjusted test rental fee" : "Total test rental fee"}</p><div style="margin-top:15px">${badge(r.physicalStatus)} ${badge(r.financialStatus)}</div><div class="receipt-line"></div><div class="row"><span class="label">Deposit paid</span><strong>${money(r.paymentStatus === "SUCCEEDED" ? r.pricing?.depositMinor : 0)}</strong></div><div class="row"><span class="label">Original rental fee</span><strong>${r.billingHold ? "Awaiting trusted time" : money(r.feeMinor)}</strong></div><div class="row"><span class="label">Deposit refund</span><strong>${r.billingHold ? "Not calculated" : money(r.refundMinor)}</strong></div><div class="row"><span class="label">Refund status</span>${badge(r.refundStatus || "NOT_APPLICABLE")}</div>${r.adjustedFeeMinor !== undefined ? `<div class="row"><span class="label">Adjusted rental fee</span><strong>${money(r.adjustedFeeMinor)}</strong></div>${(r.adjustments || []).map((a) => `<div class="row"><span class="label">Additional refund</span><strong>${money(a.extraRefundMinor)}</strong></div>`).join("")}<p class="small muted">Correction preserves the original bill. Reviewed return: ${date(r.adjustedEndedAt)}.</p>` : ""}${Number(r.balanceDueMinor) > 0 ? `<div class="row"><span class="label">Balance under review</span><strong>${money(r.balanceDueMinor)}</strong></div><p class="small muted">No additional charge has been made. A review case is open.</p>` : ""}</div>${r.billingHold ? `<div class="notice warning">${icon("clock")} Physical return is accepted. The device clock was untrusted, so billing and refund calculations are on hold until an operator reviews trusted timing evidence. No final fee has been assessed.</div>` : ""}${/PENDING|FAILED|UNKNOWN/.test(r.refundStatus || "") ? `<div class="notice warning">${icon("clock")} ${returned ? "Your power bank is returned." : "Your rental did not start."} ${r.refundStatus === "FAILED" ? "The simulated refund failed. Retry below or contact support." : "The simulated refund is processing. No further rental billing is running."}</div><button class="btn primary wide" data-act="${r.refundStatus === "FAILED" ? "retry_refund" : "reconcile"}" data-id="${esc(r.id)}">${r.refundStatus === "FAILED" ? "Retry demo refund" : "Check refund status"}</button>` : ""}<div class="panel" style="margin-top:18px"><h3>Trip details</h3><div class="row"><span class="label">From</span><strong>${esc(station(r.stationId).name)}</strong></div>${r.returnStationId ? `<div class="row"><span class="label">To</span><strong>${esc(station(r.returnStationId).name)}</strong></div>` : ""}<div class="row"><span class="label">Pickup</span><span>${date(r.startedAt)}</span></div><div class="row"><span class="label">Returned</span><span>${date(r.endedAt)}</span></div><div class="row"><span class="label">Payment method</span><span>${esc((r.method || "Not selected").replaceAll("_", " "))}</span></div><div class="row"><span class="label">Price version</span><span>${esc(r.pricing?.id)}</span></div><p class="order-id" style="margin-top:16px">Rental ${esc(r.id)}</p></div><div class="split"><button class="btn secondary" data-go="support" data-id="${esc(r.id)}">Need help?</button><button class="btn primary" data-go="home">Back to home ${icon("arrow")}</button></div></section>`;
}
function emptyRental() {
  return `<section class="page">${head("A little power<br>is waiting.", "You don’t have a rental in progress.")}<button class="btn primary wide" data-go="scan">Scan to rent ${icon("scan")}</button></section>`;
}
function history() {
  return `<section class="page">${head("Your little<br>power trips.", "Every rental, all in one place.")}<div class="panel">${!state.user ? `<div class="empty">${icon("user")}<p>Sign in to see your demo rentals.</p><button class="btn primary" data-go="login">Sign in</button></div>` : !state.rentals.length ? `<div class="empty">${icon("history")}<h3 style="margin-top:15px">Your story starts with a scan.</h3><p>Your completed and active rentals will appear here.</p><button class="btn primary" data-go="scan">Start your first rental</button></div>` : state.rentals.map((r) => `<button class="list-button" data-go="${["AWAITING_FUNDS", "PREPARING", "DISPENSE_UNKNOWN", "ACTIVE", "OVERDUE"].includes(r.physicalStatus) ? "active" : "order"}" data-id="${esc(r.id)}"><div class="icon-box lime">${icon("bolt")}</div><div class="grow"><strong>${esc(station(r.stationId).name)}</strong><span class="small muted">${date(r.createdAt)}<br>${esc(r.physicalStatus.replaceAll("_", " "))}</span></div><strong>${money(r.feeMinor)}</strong>${icon("arrow")}</button>`).join("")}</div></section>`;
}
function profile() {
  return `<section class="page">${head("Your space.<br>Your pace.", "Manage your demo account.")}<div class="panel"><div class="station-line"><div class="icon-box lime">${icon("user")}</div><div><h3>${esc(state.user?.name || "Hello, explorer")}</h3><p class="small muted">${state.user ? `Simulated ${esc(state.user.provider)} account` : "Sign in when you’re ready to rent."}</p></div></div>${!state.user ? '<button class="btn primary wide" style="margin-top:20px" data-go="login">Sign in to get started</button>' : ""}</div><div class="panel">${[
    ["history", "history", "My rentals", "Your past and current charges"],
    ["stations", "pin", "Find a station", "Pick up here. Return over there."],
    ["support", "help", "Help & support", "A little help goes a long way"],
    [
      "admin",
      "shield",
      "Demo operations",
      "Explore the station & rental dashboard",
    ],
  ]
    .map(
      ([p, i, t, s]) =>
        `<button class="list-button" data-go="${p}">${icon(i)}<div class="grow"><strong>${t}</strong><span class="small muted">${s}</span></div>${icon("arrow")}</button>`,
    )
    .join(
      "",
    )}</div>${state.user ? '<button class="btn secondary wide" data-act="logout">Sign out of demo</button><button class="text-button" style="display:block;margin:15px auto" data-act="delete_request">Request demo account deletion</button>' : ""}<p class="small muted center" style="margin-top:20px">No real identity, payment, or location data is needed.</p></section>`;
}
function support() {
  return `<section class="page">${head("A little help?<br>We’re right here.", "Create a demo support case, or explore the answers below.")}<div class="panel"><form id="support-form"><label class="input-label" for="category" style="margin-top:0">What can we help with?</label><select id="category" class="input" name="category"><option value="rental">Rental or pickup issue</option><option value="return">Return not detected</option><option value="payment">Payment or refund</option><option value="account">Account / data request</option><option value="general">Something else</option></select><label class="input-label" for="message">Tell us what happened</label><textarea id="message" class="input" name="message" placeholder="Please use fictional details. Never include passwords or card information." required minlength="5" maxlength="2000"></textarea><button type="submit" class="btn primary wide" style="margin-top:16px">Create demo support case ${icon("arrow")}</button></form><p class="small muted" style="margin-top:12px">Stored in this demo only. No live support team is contacted.</p></div>${state.cases?.length ? `<div class="panel"><h3>Your support cases</h3>${state.cases.map((c) => `<div class="row"><div><strong>${esc(c.category)}</strong><p class="small muted">${esc(c.message)}</p><p class="order-id">${esc(c.id)}</p></div>${badge(c.status)}</div>`).join("")}</div>` : ""}<div class="panel"><h3>A few helpful answers</h3>${[
    [
      "How do I return it?",
      "Open Stations, choose an online station with an empty slot and use “Return here”. In the demo, an explicit simulated device event confirms the return.",
    ],
    [
      "When does billing stop?",
      "Only when the server accepts valid return evidence. A report of a missing return opens a case, and does not invent a device confirmation.",
    ],
    [
      "Where is my deposit?",
      "The test rental fee is deducted from the test deposit. The remaining refund may be pending or failed independently of the physical return. Check your order for its exact status.",
    ],
  ]
    .map(
      ([q, a]) =>
        `<details style="padding:13px 0;border-top:1px solid var(--line)"><summary style="font-size:13px;cursor:pointer">${q}</summary><p class="small muted" style="margin-top:10px">${a}</p></details>`,
    )
    .join("")}</div></section>`;
}
function table(headers, rows) {
  return `<div class="admin-table"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.length ? rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${headers.length}" class="muted">Nothing here yet. Try a demo rental first.</td></tr>`}</tbody></table></div>`;
}
function wsChargeLab() {
  const inspected = lab.wscharge;
  const fixtures = [
    ["inventory_example", "Inventory · example E / hexadecimal signal"],
    ["inventory_table", "Inventory · table-inspired L / numeric signal"],
    ["dispense_200", "Borrow response · status 200 is not pickup proof"],
    ["dispense_unknown", "Borrow response · unknown status"],
    ["return_observation", "Return · untrusted observation only"],
    ["cabinet_login", "Cabinet startup announcement"],
    ["cabinet_offline", "Cabinet offline announcement"],
  ];
  return `<div class="notice warning">WsCharge 6.0A · OFFLINE PROTOCOL LAB. No live connection, device command, rental update, billing or refund is performed.</div><div class="panel"><h3>Inspect a synthetic message</h3><p class="small muted">These fictional fixtures exercise the supplied document’s field shapes, not a live supplier service. Choose an explicit profile: the inventory table uses L, while its example uses nested E for the slot. Neither profile is certified by the supplier.</p><form id="wscharge-form"><label class="input-label">Synthetic message<select class="input" name="fixture">${fixtures.map(([key, name]) => `<option value="${key}" ${inspected?.fixture === key ? "selected" : ""}>${name}</option>`).join("")}</select></label><button class="btn primary" type="submit" style="margin-top:16px">Inspect offline fixture</button></form></div>${inspected ? `<div class="panel"><p class="eyebrow">${esc(inspected.observation.outcome)}</p><h3>No automatic business effect</h3><ul class="small muted" style="padding-left:18px;line-height:1.8">${inspected.observation.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul><details open style="margin-top:18px"><summary>Normalized observation and preserved raw values</summary><pre class="protocol-json">${esc(JSON.stringify(inspected, null, 2))}</pre></details></div>` : ""}<div class="panel"><h3>Required before real integration</h3><ul class="small muted" style="padding-left:18px;line-height:1.9"><li>Transport, server address, authentication, encryption and device binding.</li><li>Firmware / model, inventory encoding, complete slot state and error codes.</li><li>Whether borrow status 200 proves physical collection; command identity, timeout and safe retry rules.</li><li>Authenticated return identity, occurrence time, sequence, replay and offline buffering rules.</li><li>Approved test cabinet and controlled hardware validation.</li></ul><p class="small muted" style="margin-top:12px">Maintenance codes 80 / 81 / 67 are classification-only in the codec. No maintenance execution controls are exposed. This is not PVS documentation.</p></div>`;
}
function guide() {
  return `<section class="page">${head("A clear path.<br>From scan to return.", "Your guide to this working simulation.")}<div class="panel lime"><p class="eyebrow">WHAT YOU’RE TRYING</p><h2>Real application.<br>Simulated integrations.</h2><p class="small" style="margin-top:14px">Orders, inventory, pricing, event evidence, support cases and audit records are handled by the demo server. Apple / Google identities, PVS-style payments, wallets, bank transfers, refunds and station hardware are simulated. No money moves and no real power bank is dispensed.</p></div><div class="panel"><h3>Walk the complete journey</h3><ol class="small muted" style="padding-left:20px;line-height:2"><li>Tap Scan to rent, then Try demo station (or enter a listed station code).</li><li>Choose a simulated Apple or Google account.</li><li>Review test pricing and accept the demo terms.</li><li>Choose a payment tool. The standard successful outcome is already selected.</li><li>Simulate device pickup. The rental timer starts from server-confirmed evidence.</li><li>Optionally skip 80 demo minutes to test billing.</li><li>Find a return station, then simulate device return.</li><li>Check the refund status. Open My rentals to inspect the receipt.</li></ol><button class="btn primary wide" data-go="scan">Try the full journey ${icon("arrow")}</button></div><div class="panel"><h3>Try the failure paths</h3><p class="small muted">Open Simulation settings to choose a different outcome. Payment: try declined, pending or unknown. Pending results are checked using the original operation, without another charge.</p><p class="small muted" style="margin-top:12px">Pickup: try a jammed slot, unknown device response or a return arriving before pickup evidence. Use the reconciliation button to check the original timeline.</p><p class="small muted" style="margin-top:12px">Return: try a wrong power bank, delayed offline evidence, an untrusted device clock, a damaged bank or a failed refund. Physical return and financial completion are separate states.</p><p class="small muted" style="margin-top:12px">Operations → Simulation lab: review earlier return evidence, disable payment capabilities, inject provider mismatches, or rehearse a fenced demo recovery.</p></div><div class="panel"><h3>Test pricing, not commercial pricing</h3><div class="row"><span class="label">Current hourly test rate</span><strong>${money(state.pricing.rateMinor)}</strong></div><div class="row"><span class="label">Refundable test deposit</span><strong>${money(state.pricing.depositMinor)}</strong></div><div class="row"><span class="label">Test daily cap</span><strong>${money(state.pricing.capMinor)}</strong></div><p class="small muted" style="margin-top:12px">Each started hour is charged after trusted pickup evidence. Existing orders preserve their accepted price version. Final billing is calculated on the server.</p></div><div class="panel"><h3>What still gates a real launch?</h3><ul class="small muted" style="padding-left:18px;line-height:1.9"><li>Approved brand, legal entity, pricing, terms, privacy policy and support channels.</li><li>Real Apple and Google credentials, verified domains and callback testing.</li><li>Verified PVS provider identity, merchant onboarding, ARS capabilities and payment sandbox / production certification.</li><li>WsCharge protocol under offline review; authenticated transport, confirmed event semantics and physical fault testing still required.</li><li>Production deployment, access controls, independent security review, backups, monitoring and controlled pilot approval.</li></ul><p class="small muted">Passing this simulation does not certify production readiness or vendor capability.</p></div><button class="btn secondary wide" data-go="support">Questions or a demo issue? ${icon("help")}</button></section>`;
}
function simulationLab(d) {
  lab.restoreFence = !!d.restoreFence?.active;
  if (!lab.backupId && d.backups?.length)
    lab.backupId = d.backups[d.backups.length - 1].id;
  const returned = (d.rentals || []).filter(
    (r) =>
      r.physicalStatus === "RETURNED" &&
      r.startedAt &&
      r.endedAt &&
      (r.billingHold || r.refundStatus === "SUCCEEDED"),
  );
  const operations = (d.operations || []).filter(
    (o) => o.status === "SUCCEEDED",
  );
  return `<div class="notice warning">${icon("info")} A controlled test environment, not production recovery tooling. Every operator change needs a reason. No live funds or physical devices are involved.</div>${lab.restoreFence ? `<div class="notice warning">Recovery fence is active. Clear any injected provider differences, then run “Compare provider records”. Commands and payments remain paused until the result is MATCHED.</div>` : ""}
  <div class="panel"><p class="eyebrow">01 · TRUSTED EVIDENCE</p><h3>Review an earlier return</h3><p class="small muted">Apply reviewed evidence that a completed rental ended earlier. The original financial history is retained; adjustments use compensation records.</p>
  ${returned.length ? `<form id="lab-adjust-form"><label class="input-label">Returned rental<select class="input" name="rentalId">${returned.map((r) => `<option value="${esc(r.id)}">${esc(r.id)} · ${money(r.feeMinor)}</option>`).join("")}</select></label><div class="split"><label class="input-label">Minutes earlier (0 confirms recorded time)<input class="input" name="minutes" type="number" min="0" max="10080" value="0" required></label><label class="input-label">Evidence reference<input class="input" name="evidence" minlength="5" placeholder="DEMO-device-log-001" required></label></div><label class="input-label">Review reason<input class="input" name="reason" minlength="5" placeholder="Reviewed delayed device return evidence" required></label><button class="btn primary" type="submit" style="margin-top:15px">Record reviewed correction</button></form>` : `<div class="notice">Complete a demo rental first to test an earlier-return adjustment.</div>`}</div>
  <div class="panel"><p class="eyebrow">PAYMENT CAPABILITIES</p><h3>Exercise an unsupported payment tool</h3><p class="small muted">This test deposit flow needs partial refunds. Disable this capability to verify the payment tool becomes unavailable instead of pretending success.</p><form id="lab-capability-form"><div class="split"><label class="input-label">Payment tool<select class="input" name="method">${methods.map(([id, i, n]) => `<option value="${id}">${n}</option>`).join("")}</select></label><label class="input-label">Partial refunds<select class="input" name="partialRefund"><option value="false">Unsupported</option><option value="true">Supported</option></select></label></div><label class="input-label">Reason<input class="input" name="reason" minlength="5" placeholder="Test unsupported partial refund behavior" required></label><button class="btn secondary" style="margin-top:15px" type="submit">Update mock capability</button></form></div>
  <div class="panel"><p class="eyebrow">02 · PAYMENT RECONCILIATION</p><h3>Find a provider discrepancy</h3><p class="small muted">Inject a mismatch into simulated provider records, then compare them against the internal ledger. This does not use PVS data.</p><form id="lab-provider-form"><label class="input-label">Discrepancy<select class="input" name="kind"><option value="duplicate">Duplicate provider entry</option><option value="missing">Missing provider entry</option><option value="amount">Amount mismatch</option><option value="currency">Currency mismatch</option><option value="clear">Clear injected discrepancies</option></select></label><label class="input-label">Financial operation<select class="input" name="operationId"><option value="">Choose automatically</option>${operations.map((o) => `<option value="${esc(o.id)}">${esc(o.type)} · ${money(o.amountMinor)} · ${esc(o.id)}</option>`).join("")}</select></label><label class="input-label">Reason<input class="input" name="reason" minlength="5" placeholder="Exercise reconciliation detection in the demo" required></label><button class="btn secondary" type="submit" style="margin-top:15px">Inject demo discrepancy</button></form><button class="btn primary" style="margin-top:15px" data-admin-action="reconcile_provider">Compare provider records ${icon("refresh")}</button></div>
  ${
    (d.reconciliation || []).length
      ? table(
          ["Check", "Status", "Finding"],
          d.reconciliation
            .slice(-10)
            .reverse()
            .map((v) => [
              esc(v.id || v.operationId || "Provider check"),
              badge(v.status || v.type || v.kind || "REVIEW"),
              esc(
                v.message || v.reason || v.kind || v.type || "See audit record",
              ),
            ]),
        )
      : ""
  }
  <div class="panel" style="margin-top:18px"><p class="eyebrow">03 · CONTROLLED RECOVERY</p><h3>Demo backup & restore rehearsal</h3><p class="small muted">Create a server-side demo snapshot, preview recovery, then apply only that preview. This is not a production backup guarantee. New rentals may be paused while records are reconciled.</p><div class="button-stack"><button class="btn secondary" data-admin-action="backup_export">1. Create demo backup</button><button class="btn secondary" data-admin-action="restore_preview" ${lab.backupId ? "" : "disabled"}>2. Preview selected backup</button><button class="btn danger" data-admin-action="restore_apply" ${lab.previewId && lab.restoreSummary?.status === "READY" ? "" : "disabled"}>3. Apply reviewed demo restore</button></div>${lab.backupId ? `<p class="small muted" style="margin-top:13px">Selected backup: ${esc(lab.backupId)}</p>` : ""}${lab.previewId ? `<div class="notice warning">Preview ${esc(lab.previewId)}: ${esc(lab.restoreSummary?.status)}. ${esc(lab.restoreSummary?.warning || "Current external effects are preserved; no financial operations are replayed.")}</div>` : ""}</div>`;
}
function admin() {
  if (!state.admin)
    return `<section class="page">${head("The other side<br>of the charge.", "A separate, simulated operator session.")}<div class="panel center"><div class="large-icon">${icon("shield")}</div><h2>Demo operations</h2><p class="small muted" style="margin:15px 0 22px">Manage demo stations, inspect rentals, review exceptions and audit every change. No real administrator credentials are required.</p><button class="btn primary wide" data-act="admin_login">Enter simulated operator session ${icon("arrow")}</button></div><div class="notice warning">${icon("info")} This simulated operator console is not a production admin system. Never enter confidential information.</div></section>`;
  const d = state.adminData || {},
    rs = d.rentals || [],
    sts = d.stations || state.stations,
    cs = d.cases || [];
  let content = "";
  if (adminTab === "overview") {
    content = `<div class="stats-grid"><div class="stat"><span>DEMO RENTALS</span><strong>${rs.length}</strong><span>All time</span></div><div class="stat"><span>CHARGING NOW</span><strong>${rs.filter((r) => r.physicalStatus === "ACTIVE").length}</strong><span>Active power banks</span></div><div class="stat"><span>ONLINE STATIONS</span><strong>${sts.filter((s) => s.status === "ONLINE").length}/${sts.length}</strong><span>Serving demo customers</span></div><div class="stat"><span>OPEN CASES</span><strong>${cs.filter((c) => c.status !== "RESOLVED").length}</strong><span>Awaiting review</span></div></div><div class="panel"><div class="section-heading"><div><h3>Rental availability</h3><p class="small muted">Pause new rentals without blocking returns or refunds.</p></div>${badge(state.config.rentalsEnabled ? "ENABLED" : "PAUSED")}</div><button class="btn ${state.config.rentalsEnabled ? "secondary" : "primary"}" data-admin-action="config">${state.config.rentalsEnabled ? "Pause new rentals" : "Enable new rentals"}</button></div><div class="panel"><h3>Provider reconciliation</h3><p class="small muted">Check outstanding simulated payment, device and refund operations. Uses existing operation identities, not duplicate charges.</p><button class="btn secondary" style="margin-top:16px" data-admin-action="reconcile_all">${icon("refresh")}Run demo reconciliation</button></div>${table(
      ["Rental", "Physical status", "Financial status"],
      rs
        .slice(-6)
        .reverse()
        .map((r) => [
          esc(r.id),
          badge(r.physicalStatus),
          badge(r.financialStatus),
        ]),
    )}`;
  }
  if (adminTab === "stations")
    content = table(
      ["Station", "Inventory", "Status", "Change status"],
      sts.map((s) => [
        `${esc(s.name)}<br><span class="small muted">${esc(s.code)} · ${esc(s.address)}</span>`,
        `${s.available} ready / ${s.emptySlots} empty`,
        badge(s.status),
        `<select class="input" data-admin-station="${esc(s.id)}" aria-label="Status for ${esc(s.name)}">${["ONLINE", "OFFLINE", "PAUSED", "STALE"].map((v) => `<option ${v === s.status ? "selected" : ""}>${v}</option>`).join("")}</select>`,
      ]),
    );
  if (adminTab === "inventory") {
    const inventory = d.inventory || [];
    content =
      `<div class="notice">${icon("info")} Battery identifiers follow the physical asset, not its original slot. Empty slots may belong to a currently rented bank; live rental reservations cannot be released here.</div>` +
      table(
        ["Station / cabinet", "Slot", "Power bank", "Availability", "Review"],
        inventory.flatMap((t) =>
          (t.slots || []).map((slot) => [
            `${esc(t.name)}<br><span class="small muted">${esc(t.code)}</span>`,
            esc(slot.id),
            esc(slot.bankId || "Empty"),
            badge(
              slot.quarantined
                ? "QUARANTINED"
                : slot.lock
                  ? "RESERVED"
                  : slot.bankId
                    ? "AVAILABLE"
                    : "EMPTY",
            ),
            slot.quarantined && /^(review|damage):/.test(slot.lock || "")
              ? `<button class="btn tiny secondary" data-inventory-station="${esc(t.id)}" data-slot="${esc(slot.id)}">Inspect & release</button>`
              : slot.lock
                ? `<span class="small muted">${esc(slot.lock)}</span>`
                : "—",
          ]),
        ),
      ) +
      `<div style="margin-top:22px">${table(
        ["On-rental asset", "Rental", "Status"],
        rs
          .filter((r) =>
            ["ACTIVE", "OVERDUE", "DISPENSE_UNKNOWN"].includes(
              r.physicalStatus,
            ),
          )
          .map((r) => [esc(r.bankId), esc(r.id), badge(r.physicalStatus)]),
      )}</div>`;
  }
  if (adminTab === "rentals")
    content = table(
      ["Rental / power bank", "State", "Payment / refund", "Fee", "Actions"],
      rs
        .slice()
        .reverse()
        .map((r) => [
          `${esc(r.id)}<br><span class="small muted">${esc(r.bankId || "Not assigned")}</span>`,
          badge(r.physicalStatus),
          `${badge(r.paymentStatus)}<br>${badge(r.refundStatus || "NONE")}`,
          money(r.feeMinor),
          `<button class="btn tiny secondary" data-admin-action="reconcile" data-id="${esc(r.id)}">Recheck</button>`,
        ]),
    );
  if (adminTab === "payments")
    content = table(
      ["Operation", "Rental", "Type", "Status", "Amount"],
      (d.operations || [])
        .slice()
        .reverse()
        .map((o) => [
          esc(o.id),
          esc(o.rentalId),
          esc(o.type || o.kind),
          badge(o.status),
          money(o.amountMinor),
        ]),
    );
  if (adminTab === "cases")
    content = table(
      ["Case", "Details", "Status", "Review"],
      cs
        .slice()
        .reverse()
        .map((c) => [
          esc(c.id),
          `${esc(c.category)}<br><span class="small muted">${esc(c.message)}</span>`,
          badge(c.status),
          c.status === "RESOLVED"
            ? "Reviewed"
            : `<button class="btn tiny primary" data-admin-action="resolve_case" data-id="${esc(c.id)}">Resolve case</button>`,
        ]),
    );
  if (adminTab === "audit")
    content = table(
      ["Time", "Actor", "Action", "Reason / evidence"],
      (d.audit || [])
        .slice()
        .reverse()
        .map((a) => [
          date(a.createdAt || a.at),
          esc(a.actorId || a.actor || "System"),
          esc(a.action),
          esc(a.reason || JSON.stringify(a.details || {})),
        ]),
    );
  if (adminTab === "settings")
    content = `<div class="panel"><h3>Versioned test pricing</h3><p class="small muted">Creates a new test price version. Existing rentals keep their original snapshot. Amounts are integer minor units (100 = ARS 1).</p><form id="pricing-form"><div class="split"><div><label class="input-label">Hourly rate (minor units)<input class="input" name="rateMinor" value="${esc(state.pricing.rateMinor)}" type="number" min="1" required></label></div><div><label class="input-label">Deposit (minor units)<input class="input" name="depositMinor" value="${esc(state.pricing.depositMinor)}" type="number" min="1" required></label></div></div><label class="input-label">Daily cap (minor units)<input class="input" name="capMinor" value="${esc(state.pricing.capMinor)}" type="number" min="1" required></label><label class="input-label">Reason<input class="input" name="reason" placeholder="Why are you changing the demo rate?" required minlength="5"></label><button class="btn primary" type="submit" style="margin-top:15px">Create test pricing version</button></form></div><div class="panel"><h3>Demo environment only</h3><p class="small muted">Apple, Google, PVS payments, station devices and refunds use simulators. No production credentials or real charges are supported.</p></div>${table(
      ["Version", "Rate", "Deposit", "Cap"],
      (d.pricingVersions || []).map((p) => [
        esc(p.id),
        money(p.rateMinor),
        money(p.depositMinor),
        money(p.capMinor),
      ]),
    )}`;
  if (adminTab === "simulation") content = simulationLab(d);
  if (adminTab === "wscharge") content = wsChargeLab();
  return `<section class="page wide-page"><div class="section-heading"><div class="page-head"><p class="eyebrow">SIMULATED OPERATOR WORKSPACE</p><h1>Good energy.<br>Clear operations.</h1></div><button class="btn secondary tiny" data-act="admin_logout">Exit operations</button></div><div class="tabs" role="tablist">${["overview", "stations", "inventory", "rentals", "payments", "cases", "audit", "settings", "simulation", "wscharge"].map((t) => `<button role="tab" aria-selected="${t === adminTab}" class="${t === adminTab ? "selected" : ""}" data-tab="${t}">${t === "simulation" ? "Simulation lab" : t === "wscharge" ? "WsCharge offline" : t.charAt(0).toUpperCase() + t.slice(1)}</button>`).join("")}</div>${content}</section>`;
}
function render() {
  if (!state) {
    app.innerHTML =
      '<div class="loading"><div class="spinner"></div>Getting a little power ready…</div>';
    return;
  }
  const currentRentalId = state.activeRental?.id || null;
  if (demoSelections.rentalId !== currentRentalId) {
    Object.assign(demoSelections, { rentalId: currentRentalId, payment: "success", pickup: "success" });
  }
  const pages = {
    home,
    scan,
    login,
    quote: quotePage,
    payment,
    active: activePage,
    stations: stationsPage,
    history,
    order: () => (rental() ? receipt(rental()) : emptyRental()),
    profile,
    support,
    guide,
    admin,
  };
  app.innerHTML = `<div class="layout">${header()}<main>${(pages[view] || home)()}</main>${footer()}</div>`;
  enhanceSelects(app);
  document.title = `Smile · ${view === "home" ? "Scan. Charge. Go." : view.charAt(0).toUpperCase() + view.slice(1)}`;
}
const scenarioOptions = {
  payment: [
    ["success", "Payment succeeds", "Continue with a confirmed test payment."],
    ["declined", "Payment declined", "Try the recovery path without a charge."],
    ["pending", "Still processing", "Check the same payment again later."],
    ["unknown", "Response interrupted", "Keep the result unknown until it is checked."],
  ],
  pickup: [
    ["success", "Power bank collected", "Start the rental after simulated pickup evidence."],
    ["jammed", "Slot is stuck", "Test a jammed slot and the refund flow."],
    ["unknown", "Response interrupted", "Keep the original command under review."],
    ["not_taken", "Not collected", "Test a power bank that was not taken."],
    ["return_before_start", "Events arrive out of order", "Receive a return before the pickup evidence."],
  ],
  return: [
    ["success", "Standard return", "Stop the timer. Process the remaining test deposit."],
    ["offline", "Delayed return", "Use simulated offline return evidence."],
    ["wrong_bank", "Different power bank", "Reject a return that does not match this rental."],
    ["refund_failed", "Refund needs attention", "Confirm the return, then test a failed refund."],
    ["scenario_clock_drift", "Device time needs review", "Confirm the return and hold billing for review."],
    ["scenario_damaged_return", "Damaged power bank", "Stop rental billing and flag a separate review."],
  ],
};
const demoSelections = { rentalId: null, payment: "success", pickup: "success" };
function scenarioSettings(kind, selected = "success") {
  const options = scenarioOptions[kind];
  const current = options.find(([value]) => value === selected) || options[0];
  return `<details class="simulation-settings" ${selected !== "success" ? "open" : ""}><summary><span>${icon("info")}<span><strong>Simulation settings</strong><small data-scenario-summary>${selected === "success" ? "Optional · test a different outcome" : esc(current[1])}</small></span></span><span class="settings-chevron">${icon("arrow")}</span></summary><div class="simulation-content"><p>For testing only. Choosing an outcome does not submit anything.</p><fieldset class="scenario-options"><legend class="sr-only">${esc(kind)} simulation outcome</legend>${options.map(([value, title, description]) => `<label class="scenario-card"><input type="radio" name="${kind === "return" ? "scenario" : kind + "-scenario"}" data-scenario-kind="${kind}" value="${esc(value)}" ${value === current[0] ? "checked" : ""}><span class="scenario-copy"><strong>${esc(title)}</strong><small>${esc(description)}</small></span><span class="scenario-mark" aria-hidden="true">${icon("check")}</span></label>`).join("")}</fieldset></div></details>`;
}
let modalContext = null;
let modalHistoryClosing = false;
let queuedModal = null;
let queuedNavigation = null;
const modalStack = [];
let selectorTarget = null;
function modal(title, body, options = {}) {
  if (modalHistoryClosing) { queuedModal = [title, body, options]; return; }
  const root = document.querySelector("#modal-root");
  if (modalContext && options.nested) {
    modalStack.push({ nodes: [...root.childNodes], opener: document.activeElement, historyState: window.history.state });
    root.replaceChildren();
    window.history.pushState({ ...window.history.state, voltgoModal: true }, "", location.href);
  }
  // Keep one scroll lock even when a nested choice sheet is opened.
  if (!modalContext) {
    modalContext = {
      opener: document.activeElement,
      scrollY: window.scrollY,
      bodyStyles: {
        position: document.body.style.position,
        top: document.body.style.top,
        width: document.body.style.width,
        overflow: document.body.style.overflow,
      },
      appInert: app.inert,
      historyState: window.history.state,
    };
    document.body.style.position = "fixed";
    document.body.style.top = `-${modalContext.scrollY}px`;
    document.body.style.width = "100%";
    document.body.style.overflow = "hidden";
    app.inert = true;
    window.history.pushState({ ...window.history.state, voltgoModal: true }, "", location.href);
  }
  document.querySelector("#modal-root").innerHTML =
    `<div class="modal-overlay"><section class="modal ${options.kind === "return" ? "return-sheet" : ""}" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1"><div class="sheet-handle" aria-hidden="true"></div><button class="close" data-close aria-label="Close dialog">×</button>${options.kind === "return" ? `<div class="sheet-icon">${icon("battery")}</div><p class="eyebrow">DEMO RETURN</p>` : ""}<h2 id="dialog-title">${title}</h2>${body}</section></div>`;
  enhanceSelects(root);
  document.querySelector(".modal")?.focus({ preventScroll: true });
}
function closeModal({ fromHistory = false, navigation = false } = {}) {
  if (modalHistoryClosing && !fromHistory && !navigation) return;
  if (!modalContext) return;
  if (modalStack.length) {
    const parent = modalStack.pop();
    document.querySelector("#modal-root").replaceChildren(...parent.nodes);
    if (parent.opener?.isConnected) parent.opener.focus({ preventScroll: true });
    if (!fromHistory && window.history.state?.voltgoModal) {
      if (navigation) window.history.replaceState(parent.historyState, "", location.href);
      else { modalHistoryClosing = true; window.history.back(); }
    }
    return;
  }
  const previous = modalContext;
  modalContext = null;
  document.querySelector("#modal-root").innerHTML = "";
  Object.assign(document.body.style, previous.bodyStyles);
  app.inert = previous.appInert;
  window.scrollTo({ top: previous.scrollY, behavior: "instant" });
  if (previous.opener?.isConnected) previous.opener.focus({ preventScroll: true });
  if (!fromHistory && window.history.state?.voltgoModal) {
    // Explicit navigation replaces the synthetic entry; dismissal uses browser Back.
    if (navigation) window.history.replaceState(previous.historyState, "", location.href);
    else { modalHistoryClosing = true; window.history.back(); }
  }
}
function enhanceSelects(container) {
  container.querySelectorAll("select:not([data-customized])").forEach(select => {
    select.dataset.customized = "true";
    select.classList.add("native-select-value");
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");
    const label = select.labels?.[0] || select.closest("label");
    const labelText = label ? [...label.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(" ") : "";
    const title = select.getAttribute("aria-label") || labelText || "Choose an option";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "custom-select-trigger input";
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-label", title);
    button.dataset.customSelect = "true";
    button.disabled = select.disabled;
    const update = () => {
      button.setAttribute("aria-label", `${title}: ${select.selectedOptions[0]?.textContent || "Choose an option"}`);
      button.innerHTML = `<span>${esc(select.selectedOptions[0]?.textContent || "Choose an option")}</span><span aria-hidden="true">${icon("arrow")}</span>`;
    };
    update();
    select.addEventListener("change", update);
    button.addEventListener("click", () => {
      if (busy) return;
      selectorTarget = { select, button };
      const choices = [...select.options].map((option, index) => `<label class="scenario-card"><input type="radio" name="picker-value" value="${index}" ${option.selected ? "checked" : ""} ${option.disabled ? "disabled" : ""}><span class="scenario-copy"><strong>${esc(option.textContent)}</strong></span><span class="scenario-mark" aria-hidden="true">${icon("check")}</span></label>`).join("");
      modal(esc(title), `<p class="sheet-subtitle">Choose an option below.</p><fieldset class="scenario-options picker-options"><legend class="sr-only">${esc(title)}</legend>${choices}</fieldset><div class="sheet-actions"><button class="btn primary wide" type="button" data-apply-picker>Use selection ${icon("check")}</button><button class="btn sheet-cancel wide" type="button" data-close>Cancel</button></div>`, { nested: Boolean(modalContext) });
    });
    select.insertAdjacentElement("afterend", button);
  });
}
function applyPicker() {
  const chosen = document.querySelector('.modal input[name="picker-value"]:checked');
  const target = selectorTarget;
  if (!chosen || !target) return;
  const option = target.select.options[Number(chosen.value)];
  if (!option || option.disabled) return;
  closeModal({ navigation: true });
  selectorTarget = null;
  target.select.value = option.value;
  target.select.dispatchEvent(new Event("change", { bubbles: true }));
}
function trapDialogFocus(event) {
  const dialog = document.querySelector(".modal");
  if (!dialog) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeModal();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...dialog.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex="0"]')].filter(el => el.getClientRects().length > 0 && !el.closest('[hidden]'));
  const first = focusable[0], last = focusable.at(-1);
  if (!first) { event.preventDefault(); dialog.focus(); return; }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
    event.preventDefault(); first.focus();
  }
}
function infoModal(type) {
  if (type === "terms")
    modal(
      "Demo rental terms",
      "<p>This is a functional demonstration, not a live rental service. All stations, accounts, payments and device events are simulated.</p><p>Test pricing is shown before each rental. Billing starts only after simulated device pickup evidence is accepted and stops after simulated return evidence is accepted. Each started hour is charged using the stored test pricing version, subject to the displayed cap.</p><p>The test deposit is not real money. A return can be confirmed while a simulated refund is still processing. No actual payment, refund timing or physical service is promised.</p><p>Production pricing, legal terms, real identity providers, PVS and hardware are not approved or connected.</p>",
    );
  else
    modal(
      "Your privacy in this demo",
      "<p>Use fictional information only. This demo stores simulated account, rental, station, support and operation records on its demo server. Session cookies keep your demo session active.</p><p>Do not submit passwords, payment card details, government identifiers or other confidential data. No real Apple or Google login is requested. Camera access is optional and used locally for scanning; camera frames are not uploaded.</p><p>To request account or data assistance, create a demo support case. A production privacy and retention policy must be approved before real service begins.</p>",
    );
}
async function chooseStation(id) {
  if (state.activeRental) {
    go("active", state.activeRental.id);
    return;
  }
  sessionStorage.setItem("stationIntent", id);
  if (!state.user) {
    go("login");
    return;
  }
  const result = await act("quote", { stationId: id });
  if (result) {
    quote = result.quote;
    go("quote");
  }
}
function stopCamera() {
  if (camera) {
    camera.getTracks().forEach((t) => t.stop());
    camera = null;
  }
  clearInterval(scanTimer);
}
async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast(
      "Camera unavailable in this browser. Enter the station code instead.",
    );
    return;
  }
  try {
    camera = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    const video = document.querySelector("#camera");
    if (!video) {
      stopCamera();
      return;
    }
    video.srcObject = camera;
    await video.play();
    if ("BarcodeDetector" in window) {
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      scanTimer = setInterval(async () => {
        try {
          const codes = await detector.detect(video);
          if (codes.length) {
            const value = codes[0].rawValue;
            stopCamera();
            const result = await act("resolve", { code: value });
            if (result?.station) await chooseStation(result.station.id);
          }
        } catch {}
      }, 900);
    } else
      toast(
        "Camera is open. Automatic QR decoding is unsupported here; use a station code.",
      );
  } catch {
    toast(
      "Camera access was not available. You can still enter a station code.",
    );
  }
}
async function adminAction(action, id, extra = {}) {
  modal(
    "Confirm demo operation",
    `<p>This changes only simulated records and will be saved in the audit log.</p><form id="admin-action-form" data-action="${esc(action)}" data-id="${esc(id || "")}" data-extra="${esc(JSON.stringify(extra))}"><label class="input-label" for="admin-reason">Reason for this change</label><input class="input" id="admin-reason" name="reason" required minlength="5" placeholder="Describe why this operation is needed"><button class="btn primary wide" type="submit" style="margin-top:17px">Confirm demo operation</button></form>`,
  );
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button,a");
  if (!b) return;
  if (b.hasAttribute("data-close")) return closeModal();
  if (b.hasAttribute("data-apply-picker")) return applyPicker();
  if (b.dataset.go) return go(b.dataset.go, b.dataset.id);
  if (b.dataset.modal) return infoModal(b.dataset.modal);
  if (b.dataset.method) {
    selectedMethod = b.dataset.method;
    return render();
  }
  if (b.dataset.tab) {
    adminTab = b.dataset.tab;
    return render();
  }
  if (b.dataset.chooseStation) return chooseStation(b.dataset.chooseStation);
  if (b.dataset.stationInfo) {
    const s = station(b.dataset.stationInfo);
    return modal(
      esc(s.name),
      `<p>${esc(s.address)}<br>${esc(s.area)} · ${esc(s.hours)}</p><p>Station code: <strong>${esc(s.code)}</strong><br>${s.available} power banks available · ${s.emptySlots} return slots<br>Status: ${esc(s.status)}</p><p>This is a fictional demo station. This address is not a confirmed physical rental location.</p>`,
    );
  }
  if (b.dataset.returnStation) {
    const s = station(b.dataset.returnStation);
    return modal(
      "Ready to return?",
      `<p class="sheet-subtitle">One last step, then you’re all set.</p><div class="return-station"><span class="return-station-icon">${icon("pin")}</span><div><strong>${esc(s.name)}</strong><span>${esc(s.address)}</span></div></div><div class="return-step"><span>1</span><p>Insert your power bank into an empty slot until it locks.</p></div><div class="return-step"><span>2</span><p>Wait for confirmation before leaving the station.</p></div><form id="return-form" data-station="${esc(s.id)}">${scenarioSettings("return")}<p class="sheet-demo-note">${icon("shield")} Demo only. No real station is connected.</p><div class="sheet-actions"><button class="btn primary wide" type="submit">Confirm demo return ${icon("check")}</button><button class="btn sheet-cancel wide" type="button" data-close>Not yet</button></div></form>`,
      { kind: "return" },
    );
  }
  if (b.dataset.inventoryStation)
    return modal(
      "Review quarantined power bank",
      `<p>Only release after simulated inspection and trusted evidence review. This does not release active rental reservations.</p><form id="inventory-review-form" data-station="${esc(b.dataset.inventoryStation)}" data-slot="${esc(b.dataset.slot)}"><label class="input-label">Inspection evidence<input class="input" name="evidence" required minlength="5" placeholder="DEMO-inspection-log-001"></label><label class="input-label">Review reason<input class="input" name="reason" required minlength="5" placeholder="Inspected returned bank and verified safe availability"></label><button class="btn primary wide" type="submit" style="margin-top:15px">Record inspection & release demo slot</button></form>`,
    );
  if (b.dataset.adminAction)
    return adminAction(b.dataset.adminAction, b.dataset.id);
  const a = b.dataset.act;
  if (!a) return;
  if (a === "camera") return openCamera();
  if (a === "demo_scan")
    return chooseStation(
      state.stations.find((s) => s.status === "ONLINE" && s.available > 0)
        ?.id || state.stations[0]?.id,
    );
  if (a === "refresh") {
    try {
      await load();
      render();
      toast("Demo inventory updated.");
    } catch (e) {
      toast(e.message);
    }
    return;
  }
  if (a === "login") {
    const res = await act("login", { provider: b.dataset.provider });
    if (res) {
      const intent = sessionStorage.getItem("stationIntent");
      if (intent) await chooseStation(intent);
      else go("home");
    }
    return;
  }
  if (a === "rent") {
    if (!document.querySelector("#accept-terms")?.checked)
      return toast("Please accept the demo terms and test pricing first.");
    const res = await act("rent", { quoteId: quote.id, acceptedTerms: true });
    if (res) {
      sessionStorage.removeItem("stationIntent");
      go("payment", state.activeRental?.id);
    }
    return;
  }
  if (a === "pay") {
    const res = await act("pay", {
      rentalId: b.dataset.id,
      method: selectedMethod,
      scenario: demoSelections.payment,
    });
    if (res) go("active", b.dataset.id);
    return;
  }
  if (a === "collect") {
    const scenario = demoSelections.pickup;
    const res = await act(
      scenario === "return_before_start"
        ? "scenario_return_before_start"
        : "collect",
      {
        rentalId: b.dataset.id,
        stationId: rental().stationId,
        scenario,
      },
    );
    if (res) go("active", b.dataset.id);
    return;
  }
  if (["reconcile", "retry_refund", "cancel"].includes(a)) {
    const res = await act(a, { rentalId: b.dataset.id });
    if (res) {
      toast(
        a === "cancel"
          ? "Demo rental cancelled."
          : "Status checked with the demo server.",
      );
      go(a === "cancel" ? "history" : "active", b.dataset.id);
    }
    return;
  }
  if (a === "advance") {
    if (await act("advance", { minutes: 80 }))
      toast("Demo clock advanced by 80 minutes.");
    return;
  }
  if (a === "delete_request") {
    const result = await act("delete_account", {});
    if (result)
      modal(
        "Account deletion request",
        `<p>${result.deletion?.status === "BLOCKED_OPEN_OBLIGATIONS" ? "Please complete outstanding rentals and financial obligations before requesting deletion." : "Your demo account deletion request was recorded. Records needed for rental and payment traceability are not automatically erased."}</p>`,
      );
    return;
  }
  if (a === "logout") {
    if (await act("logout")) go("home");
    return;
  }
  if (a === "admin_login" || a === "admin_logout") {
    if (await act(a)) go(a === "admin_login" ? "admin" : "home");
    return;
  }
});
document.addEventListener("change", (e) => {
  const kind = e.target.dataset.scenarioKind;
  if (kind && scenarioOptions[kind]?.some(([value]) => value === e.target.value)) {
    if (kind !== "return") demoSelections[kind] = e.target.value;
    const summary = e.target.closest(".simulation-settings")?.querySelector("[data-scenario-summary]");
    if (summary) summary.textContent = e.target.value === "success" ? "Optional · test a different outcome" : scenarioOptions[kind].find(([value]) => value === e.target.value)[1];
  }
  if (e.target.dataset.adminStation)
    adminAction("station_update", e.target.dataset.adminStation, {
      status: e.target.value,
    });
});
document.addEventListener("submit", async (e) => {
  const f = e.target;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(f));
  if (f.id === "wscharge-form") {
    const result = await act("wscharge_inspect", { fixture: data.fixture });
    if (result) {
      lab.wscharge = result;
      render();
    }
    return;
  }
  if (f.id === "scan-form") {
    const result = await act("resolve", { code: data.code.trim() });
    if (result?.station) return chooseStation(result.station.id);
    return;
  }
  if (f.id === "support-form") {
    const res = await act("support", {
      ...data,
      rentalId: viewId || state.activeRental?.id || undefined,
    });
    if (res) toast("Demo support case created. You can find it below.");
    return;
  }
  if (f.id === "return-form") {
    const id = state.activeRental?.id;
    if (!id) return toast("No active rental to return.");
    const payload = {
      rentalId: id,
      stationId: f.dataset.station,
      scenario: data.scenario,
    };
    closeModal({ navigation: true });
    if (
      await act(
        data.scenario.startsWith("scenario_") ? data.scenario : "return",
        payload,
      )
    ) {
      go("active", id);
      if (payload.scenario === "scenario_clock_drift")
        toast(
          "Physical return accepted. Device time is untrusted; billing is held for review.",
        );
      if (payload.scenario === "scenario_damaged_return")
        toast("Return confirmed. Billing stopped; damage review is separate.");
      if (payload.scenario === "wrong_bank")
        toast(
          "Unmatched power bank: rental remains active. A demo support case was opened.",
        );
    }
    return;
  }
  if (f.id === "inventory-review-form") {
    const payload = {
      stationId: f.dataset.station,
      slotId: f.dataset.slot,
      ...data,
    };
    closeModal({ navigation: true });
    if (await act("inventory_review", payload))
      toast("Inspection recorded and demo slot released.");
    return;
  }
  if (f.id === "lab-capability-form") {
    if (
      await act("capability", {
        method: data.method,
        partialRefund: data.partialRefund === "true",
        reason: data.reason,
      })
    )
      toast(
        "Demo payment capability updated. Unsupported tools are disabled at checkout.",
      );
    return;
  }
  if (f.id === "lab-adjust-form") {
    const selected = (state.adminData?.rentals || []).find(
      (r) => r.id === data.rentalId,
    );
    if (!selected) return toast("Choose a returned rental first.");
    const returnedAt = Number(selected.endedAt) - Number(data.minutes) * 60000;
    if (returnedAt < Number(selected.startedAt))
      return toast(
        "The corrected return must be after pickup. Choose fewer minutes.",
      );
    const result = await act("adjust_return_time", {
      rentalId: data.rentalId,
      returnedAt,
      evidence: data.evidence,
      reason: data.reason,
    });
    if (result)
      toast(
        "Reviewed return time recorded with compensating financial entries.",
      );
    return;
  }
  if (f.id === "lab-provider-form") {
    if (
      await act("simulate_provider_difference", {
        kind: data.kind,
        ...(data.operationId ? { operationId: data.operationId } : {}),
        reason: data.reason,
      })
    )
      toast(
        "Demo provider discrepancy injected. Run reconciliation to inspect it.",
      );
    return;
  }
  if (f.id === "pricing-form") {
    if (await act("pricing", data))
      toast("A new test pricing version has been created.");
    return;
  }
  if (f.id === "admin-action-form") {
    const a = f.dataset.action,
      id = f.dataset.id;
    const payload = {
      ...JSON.parse(f.dataset.extra || "{}"),
      reason: data.reason,
    };
    if (a === "station_update") payload.stationId = id;
    if (a === "resolve_case") payload.caseId = id;
    if (a === "reconcile") payload.rentalId = id;
    if (a === "config") payload.rentalsEnabled = !state.config.rentalsEnabled;
    if (a === "restore_preview") payload.backupId = lab.backupId;
    if (a === "restore_apply") payload.previewId = lab.previewId;
    closeModal({ navigation: true });
    const result = await act(a, payload);
    if (result) {
      if (a === "backup_export") {
        lab.backupId = result.backupId || result.backup?.id;
        lab.previewId = null;
      }
      if (a === "restore_preview") {
        lab.previewId = result.previewId || result.preview?.id;
        lab.restoreSummary = result.preview || result;
      }
      if (a === "restore_apply") {
        lab.previewId = null;
        lab.restoreSummary = null;
        lab.restoreFence = true;
      }
      if (
        a === "reconcile_provider" &&
        result.reconciliation?.status === "MATCHED"
      )
        lab.restoreFence = false;
      render();
      toast("Demo operation recorded in the audit log.");
    }
    return;
  }
});
document.addEventListener("keydown", trapDialogFocus);
document.querySelector("#modal-root").addEventListener("click", (event) => {
  if (event.target.classList.contains("modal-overlay")) closeModal();
});
window.addEventListener("popstate", () => {
  if (modalContext && !modalHistoryClosing) closeModal({ fromHistory: true });
  modalHistoryClosing = false;
  // Forward must never resurrect a dismissed confirmation or execute an action.
  if (!modalContext && window.history.state?.voltgoModal) {
    const { voltgoModal, ...rest } = window.history.state;
    window.history.replaceState(rest, "", location.href);
  }
  if (queuedNavigation) {
    const next = queuedNavigation;
    queuedNavigation = null;
    queuedModal = null;
    go(...next);
  } else if (queuedModal) {
    const next = queuedModal;
    queuedModal = null;
    modal(...next);
  }
});
window.addEventListener("hashchange", () => {
  while (modalContext) closeModal({ fromHistory: true });
  const [page, id] = location.hash.slice(1).split("/");
  view = page || "home";
  viewId = id ? decodeURIComponent(id) : null;
  stopCamera();
  render();
});
window.addEventListener("pagehide", () => { stopCamera(); queuedModal = null; queuedNavigation = null; while (modalContext) closeModal({ navigation: true }); });
setInterval(() => {
  const el = document.querySelector("#timer");
  if (el) el.textContent = duration(el.dataset.start);
}, 1000);
// Poll only read-only rental views. Server evidence, never client timers, advances state.
let statusRefreshPending = false;
const rentalStatusSignature = (r) =>
  JSON.stringify(
    r
      ? {
          id: r.id,
          physical: r.physicalStatus,
          financial: r.financialStatus,
          payment: r.paymentStatus,
          refund: r.refundStatus,
          command: r.commandStatus,
          billingHold: r.billingHold,
          timeline: r.timelineStatus,
          fee: r.feeMinor,
          adjustedFee: r.adjustedFeeMinor,
          refundMinor: r.refundMinor,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
        }
      : null,
  );
setInterval(async () => {
  if (
    !state ||
    busy ||
    statusRefreshPending ||
    document.visibilityState !== "visible" ||
    !["active", "order"].includes(view) ||
    document.querySelector(".modal-overlay")
  )
    return;
  const originalView = view,
    originalId = viewId,
    originalRevision = actionRevision;
  const before = rentalStatusSignature(rental());
  statusRefreshPending = true;
  try {
    const response = await fetch("/v1/bootstrap", {
      credentials: "same-origin",
    });
    if (!response.ok) return;
    const payload = await response.json();
    // A user action or navigation may have begun while the read was in flight.
    if (
      busy ||
      actionRevision !== originalRevision ||
      view !== originalView ||
      viewId !== originalId ||
      document.querySelector(".modal-overlay")
    )
      return;
    state = payload.data;
    serverOffset = Number(state.serverTime) - Date.now() || 0;
    if (rentalStatusSignature(rental()) !== before) render();
  } catch {
    // Keep the last confirmed state on a transient network failure.
  } finally {
    statusRefreshPending = false;
  }
}, 6000);
async function boot() {
  render();
  try {
    await load();
    const [page, id] = location.hash.slice(1).split("/");
    view = page || "home";
    viewId = id ? decodeURIComponent(id) : null;
    render();
  } catch (e) {
    app.innerHTML = `<div class="loading"><h2>A little connection trouble.</h2><p>${esc(e.message)}</p><button class="btn primary" id="retry-load">Try again</button></div>`;
    document.querySelector("#retry-load").onclick = boot;
  }
}
boot();
