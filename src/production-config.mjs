import { googleConfigured } from "./production-google.mjs";
export function loadConfig(env = process.env) {
  const publicOrigin = env.PUBLIC_ORIGIN;
  if (!publicOrigin)
    throw new Error("PUBLIC_ORIGIN is required; configure your HTTPS domain.");
  const u = new URL(publicOrigin);
  const local =
    env.ALLOW_LOCAL_HTTP === "1" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash ||
    (u.protocol !== "https:" && !(local && u.protocol === "http:"))
  )
    throw new Error(
      "PUBLIC_ORIGIN must be a bare HTTPS origin (or explicitly enabled loopback HTTP).",
    );
  const skew = Number(env.WSCHARGE_MAX_CLOCK_SKEW_SECONDS || 300);
  if (!Number.isSafeInteger(skew) || skew < 30 || skew > 86400) throw new Error("WSCHARGE_MAX_CLOCK_SKEW_SECONDS must be 30–86400");
  return {
    publicOrigin: u.origin,
    secure: u.protocol === "https:",
    databasePath: env.DATABASE_PATH || ".local/production.sqlite",
    host: env.HOST || "127.0.0.1",
    port: Number(env.PORT || 4173),
    googleClientId: env.GOOGLE_CLIENT_ID || "",
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || "",
    enableGoogleTestLogin: env.ENABLE_GOOGLE_TEST_LOGIN === "1",
    wschargeMaxClockSkewSeconds: Number(env.WSCHARGE_MAX_CLOCK_SKEW_SECONDS || 300),
    hardwareRentalEnabled: env.WSCHARGE_HARDWARE_TEST_ENABLED === "1",
    wschargeEnabled: env.WSCHARGE_ENABLED === "1",
    wschargeDispatchEnabled: env.WSCHARGE_ENABLE_DISPATCH === "1",
    wschargeApiToken: env.WSCHARGE_API_TOKEN || "",
    wschargeCallbackToken: env.WSCHARGE_CALLBACK_TOKEN || "",
    wschargeCabinets: (env.WSCHARGE_CABINET_IDS || "").split(",").map(x => x.trim()).filter(Boolean),
    sessionSeconds: 28800,
    userSessionSeconds: 604800,
  };
}
// Fail closed even for partially configured OAuth, including unsupported IP origins.
export function googleTestEnabled(config) {
  return config.enableGoogleTestLogin === true &&
    !config.googleClientId && !config.googleClientSecret;
}
export function readiness(config) {
  return {
    google: {
      ready: googleConfigured(config),
      label: googleConfigured(config)
        ? "Configured"
        : "Not configured",
    },
    googleTest: {
      ready: googleTestEnabled(config),
      label: googleTestEnabled(config)
        ? "TEST sign-in enabled (not Google)"
        : "Test sign-in disabled",
    },
    pvs: { ready: false, label: "Pending integration" },
    wscharge: {
      ready: false,
      label:
        config.hardwareRentalEnabled ? "Supervised physical testing; mock payments only" : config.wschargeEnabled ? "Gateway enabled; supplier verification required, settlement disabled" : "HTTP gateway disabled",
    },
  };
}
