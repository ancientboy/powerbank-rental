import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { D1Store } from "../src/store.mjs";
import { createAPI } from "../src/api.mjs";
const dir = new URL("../.local/", import.meta.url);
await mkdir(dir, { recursive: true });
const db = new DatabaseSync(new URL("demo.sqlite", dir).pathname);
db.exec("PRAGMA journal_mode=WAL");
const exists = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='demo_state'",
  )
  .get();
if (!exists)
  db.exec(
    await readFile(
      new URL("../drizzle/0000_demo.sql", import.meta.url),
      "utf8",
    ),
  );
const binding = {
  prepare(sql) {
    return {
      bind(...args) {
        return {
          async run() {
            const result = db.prepare(sql).run(...args);
            return { meta: { changes: Number(result.changes) } };
          },
          async first() {
            return db.prepare(sql).get(...args);
          },
        };
      },
    };
  },
};
const api = createAPI((key) => new D1Store(binding, key), { secure: false });
const port = Number(process.env.PORT || 4173);
http
  .createServer(async (req, res) => {
    try {
      const origin = "http://" + req.headers.host;
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith("/v1/")) {
        let chunks = [];
        for await (const c of req) chunks.push(c);
        const response = await api(
          new Request(url, {
            method: req.method,
            headers: req.headers,
            body: ["GET", "HEAD"].includes(req.method)
              ? undefined
              : Buffer.concat(chunks),
          }),
        );
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
      } else {
        const file =
          url.pathname === "/" || !url.pathname.includes(".")
            ? "index.html"
            : url.pathname.slice(1);
        if (!["index.html", "app.js", "style.css", "smile-mark.svg"].includes(file)) {
          res.writeHead(404);
          return res.end();
        }
        res.setHeader(
          "Content-Type",
          file.endsWith("html")
            ? "text/html"
            : file.endsWith("js")
              ? "text/javascript"
              : file.endsWith("svg")
                ? "image/svg+xml"
                : "text/css",
        );
        res.end(await readFile(new URL("../public/" + file, import.meta.url)));
      }
    } catch (e) {
      res.writeHead(500);
      res.end("Server error");
    }
  })
  .listen(port, () =>
    console.log(`Local persisted demo on http://localhost:${port}`),
  );
