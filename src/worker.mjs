import { D1Store } from "./store.mjs";
import { createAPI } from "./api.mjs";
export function createWorker(assets) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/v1/")) {
        if (!env.DB)
          return Response.json(
            {
              error: {
                code: "DATABASE_UNAVAILABLE",
                message: "Demo database binding is not configured.",
              },
            },
            { status: 503 },
          );
        return createAPI((key) => new D1Store(env.DB, key))(request);
      }
      const key =
        url.pathname === "/" || !url.pathname.includes(".")
          ? "/index.html"
          : url.pathname;
      const asset = assets[key];
      if (!asset) return new Response("Not found", { status: 404 });
      return new Response(asset.body, {
        headers: {
          "Content-Type": asset.type,
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self' https://chatgpt.com; base-uri 'none'; form-action 'self'",
          "Referrer-Policy": "same-origin",
        },
      });
    },
  };
}
