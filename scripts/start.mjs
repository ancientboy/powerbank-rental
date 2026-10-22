import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/production-config.mjs";
import { openProductionStore } from "../src/production-store.mjs";
import { createProductionAPI } from "../src/production-api.mjs";
process.umask(0o077);
const config = loadConfig();
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
  throw new Error("Invalid PORT");
if (!config.secure && !["127.0.0.1", "localhost", "::1"].includes(config.host))
  throw new Error("Local HTTP must bind loopback only");
const db = openProductionStore(config.databasePath),
  api = createProductionAPI({ db, config });
const assets = new Map([
  ["/", "index.html"],
  ["/auth/error", "index.html"],
  ["/admin", "admin.html"],
  ["/admin/", "admin.html"],
  ["/admin/login", "admin.html"],
  ["/app.js", "app.js"],
  ["/admin.js", "admin.js"],
  ["/production.css", "production.css"],
  ["/customer.css", "customer.css"],
  ["/smile-mark.svg", "smile-mark.svg"],
]);
const server = http.createServer(async (req, res) => {
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "Cache-Control": "no-store",
  };
  if (config.secure) headers["Strict-Transport-Security"] = "max-age=31536000";
  try {
    // External origin is configured, never derived from untrusted Host / forwarded headers.
    const url = new URL(req.url, config.publicOrigin);
    if (url.origin !== config.publicOrigin) {
      res.writeHead(400, headers);
      return res.end("Invalid origin");
    }
    let response;
    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/auth/google") ||
      url.pathname === "/health"
    ) {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 16384) {
          res.writeHead(413, headers);
          return res.end("Request too large");
        }
        chunks.push(chunk);
      }
      response = await api(
        new Request(url, {
          method: req.method,
          headers: req.headers,
          body: ["GET", "HEAD"].includes(req.method)
            ? undefined
            : Buffer.concat(chunks),
        }),
      );
    } else if (
      assets.has(url.pathname) &&
      ["GET", "HEAD"].includes(req.method)
    ) {
      const filename = assets.get(url.pathname),
        body = await readFile(
          new URL("../production-public/" + filename, import.meta.url),
        );
      response = new Response(body, {
        headers: {
          "Content-Type": filename.endsWith(".html")
            ? "text/html; charset=utf-8"
            : filename.endsWith(".js")
              ? "text/javascript; charset=utf-8"
              : filename.endsWith(".svg")
                ? "image/svg+xml"
                : "text/css; charset=utf-8",
        },
      });
    } else response = new Response("Not found", { status: 404 });
    const outgoing = { ...headers, ...Object.fromEntries(response.headers) };
    const cookie = response.headers.getSetCookie();
    if (cookie.length) outgoing["set-cookie"] = cookie;
    res.writeHead(response.status, outgoing);
    res.end(
      req.method === "HEAD"
        ? undefined
        : Buffer.from(await response.arrayBuffer()),
    );
  } catch {
    res.writeHead(500, headers);
    res.end("Server error");
  }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(config.port, config.host, () =>
  console.log(
    `Smile production server listening on ${config.host}:${config.port}; external origin ${config.publicOrigin}`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(() => {
      db.close();
      process.exit(0);
    }),
  );
