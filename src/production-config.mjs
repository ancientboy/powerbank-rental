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
  return {
    publicOrigin: u.origin,
    secure: u.protocol === "https:",
    databasePath: env.DATABASE_PATH || ".local/production.sqlite",
    host: env.HOST || "127.0.0.1",
    port: Number(env.PORT || 4173),
    googleClientId: env.GOOGLE_CLIENT_ID || "",
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || "",
    enableGoogleTestLogin: env.ENABLE_GOOGLE_TEST_LOGIN === "1",
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
        ? "Configured; sign-in available"
        : "Awaiting Google OAuth configuration",
    },
    googleTest: {
      ready: googleTestEnabled(config),
      label: googleTestEnabled(config)
        ? "Temporary test sign-in enabled; not Google authentication"
        : "Test sign-in disabled",
    },
    pvs: { ready: false, label: "Integration pending; payments disabled" },
    wscharge: {
      ready: false,
      label:
        "Vendor protocol confirmation and physical testing pending; hardware disabled",
    },
  };
}
