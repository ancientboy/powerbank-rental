import { inspectWsChargeFixture } from "./wscharge.mjs";
import {
  SCENARIO_ACTIONS,
  applyScenario,
  assertRestoreFence,
  reconcilePendingTimeline,
} from "./scenarios.mjs";
import {
  apply,
  publicState,
  Fault,
  uid,
  assert,
  drainJobs,
} from "./domain.mjs";
const hash = async (text) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};
export function createAPI(storeOrFactory, { secure = true } = {}) {
  return async function (request) {
    const requestId = uid("req");
    let cookie = null;
    try {
      const url = new URL(request.url);
      assert(
        !request.headers.get("content-length") ||
          Number(request.headers.get("content-length")) <= 12000,
        "BODY_TOO_LARGE",
        "Request is too large.",
        413,
      );
      const match = (request.headers.get("cookie") || "").match(
        /(?:^|;\s*)voltgo_session=([a-f0-9]{64})(?:;|$)/,
      );
      let token = match?.[1];
      if (!token) {
        token =
          crypto.randomUUID().replaceAll("-", "") +
          crypto.randomUUID().replaceAll("-", "");
        cookie = `voltgo_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secure ? "; Secure" : ""}`;
      }
      const tokenHash = await hash(token),
        csrf = await hash(`csrf:${token}`);
      const store =
        typeof storeOrFactory === "function"
          ? storeOrFactory(tokenHash)
          : storeOrFactory;
      const lookup = (s) => {
        let se = s.sessions.find(
          (x) => x.hash === tokenHash && x.expiresAt > Date.now(),
        );
        if (!se) {
          se = {
            hash: tokenHash,
            userId: null,
            admin: false,
            expiresAt: Date.now() + 604800000,
          };
          s.sessions.push(se);
        }
        return se;
      };
      let response;
      if (
        request.method === "GET" &&
        [
          "/v1/bootstrap",
          "/v1/me",
          "/v1/stations",
          "/v1/rentals",
          "/v1/rentals/active",
        ].includes(url.pathname)
      ) {
        response = await store.transact((s) => {
          if (!s.restoreFence?.active) drainJobs(s);
          return {
            data: publicState(s, lookup(s), csrf),
            request_id: requestId,
          };
        });
      } else if (request.method === "GET" && url.pathname === "/v1/health") {
        response = {
          data: { status: "ok", mode: "DEMO", storage: "server-persisted" },
          request_id: requestId,
        };
      } else if (request.method === "POST" && url.pathname === "/v1/actions") {
        assert(
          request.headers.get("origin") === url.origin,
          "CSRF_ORIGIN",
          "Origin verification failed.",
          403,
        );
        assert(
          request.headers.get("content-type")?.startsWith("application/json"),
          "INVALID_CONTENT_TYPE",
          "JSON required.",
          415,
        );
        assert(
          request.headers.get("x-csrf-token") === csrf && match,
          "CSRF_TOKEN",
          "Refresh this page before continuing.",
          403,
        );
        const key = request.headers.get("idempotency-key");
        assert(
          key && /^[\w-]{8,100}$/.test(key),
          "IDEMPOTENCY_REQUIRED",
          "A request key is required.",
          400,
        );
        const text = await request.text();
        assert(
          text.length <= 12000,
          "BODY_TOO_LARGE",
          "Request is too large.",
          413,
        );
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          throw new Fault("INVALID_JSON", "Invalid JSON.", 400);
        }
        assert(
          body && typeof body.action === "string",
          "INVALID_REQUEST",
          "Action required.",
          400,
        );
        if (body.action === "resolve") body.origin = url.origin;
        const digest = await hash(text);
        response = await store.transact((s) => {
          const session = lookup(s);
          session.requests = (session.requests || []).filter(
            (t) => t > Date.now() - 60000,
          );
          assert(
            session.requests.length < 120,
            "RATE_LIMITED",
            "Please wait a moment before retrying.",
            429,
          );
          session.requests.push(Date.now());
          const scope =
            tokenHash +
            ":" +
            (body.action === "login" || body.action === "admin_login"
              ? "auth"
              : session.userId || "anonymous") +
            ":" +
            (session.admin ? "operator" : "user");
          const prev = s.idempotency.find(
            (x) => x.scope === scope && x.key === key,
          );
          if (prev) {
            assert(
              prev.digest === digest,
              "IDEMPOTENCY_CONFLICT",
              "This request key was used for different input.",
            );
            return {
              data: publicState(s, session, csrf),
              result: prev.result,
              replayed: true,
              request_id: requestId,
            };
          }
          assertRestoreFence(s, body);
          const result =
            body.action === "wscharge_inspect"
              ? inspectWsChargeFixture(session, body)
              : SCENARIO_ACTIONS.includes(body.action)
                ? applyScenario(s, session, body)
                : body.action === "reconcile" &&
                    s.rentals.some(
                      (r) => r.id === body.rentalId && r.pendingReturn,
                    )
                  ? reconcilePendingTimeline(s, session, body)
                  : apply(s, session, body);
          s.idempotency.push({
            scope,
            key,
            digest,
            result,
            createdAt: Date.now(),
          });
          return {
            data: publicState(s, session, csrf),
            result,
            request_id: requestId,
          };
        });
      } else if (url.pathname.startsWith("/v1/webhooks/"))
        throw new Fault(
          "REAL_PROVIDER_DISABLED",
          "Real provider integrations are disabled. Use the authenticated demo simulator.",
          503,
        );
      else throw new Fault("NOT_FOUND", "Endpoint not found.", 404);
      return new Response(JSON.stringify(response), {
        headers: { ...headers, ...(cookie ? { "Set-Cookie": cookie } : {}) },
      });
    } catch (error) {
      const status = error instanceof Fault ? error.status : 500;
      return new Response(
        JSON.stringify({
          error: {
            code: error.code || "INTERNAL_ERROR",
            message:
              status === 500
                ? "An internal error occurred. Please refresh and retry."
                : error.message,
            retryable: status >= 500,
          },
          request_id: requestId,
        }),
        {
          status,
          headers: { ...headers, ...(cookie ? { "Set-Cookie": cookie } : {}) },
        },
      );
    }
  };
}
