import { access, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
for (const path of [
  "dist/scripts/start.mjs",
  "dist/src/production-api.mjs",
  "dist/production-public/index.html",
  "dist/production-public/customer.css",
  "dist/production-public/admin.html",
])
  await access(path);
const pkg = JSON.parse(await readFile("dist/package.json", "utf8"));
assert.equal(pkg.scripts.start, "node scripts/start.mjs");
try {
  await access("dist/server/index.js");
  assert.fail("Production must not contain the demo Worker");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
console.log("Production build boundary verified");
