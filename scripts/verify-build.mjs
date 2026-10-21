import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
const { default: worker } = await import("../dist/server/index.js");
const db = new DatabaseSync(":memory:");
db.exec(
  await readFile(
    new URL("../dist/.openai/drizzle/0000_demo.sql", import.meta.url),
    "utf8",
  ),
);
const DB = {
  prepare(sql) {
    return {
      bind(...args) {
        return {
          async run() {
            const r = db.prepare(sql).run(...args);
            return { meta: { changes: Number(r.changes) } };
          },
          async first() {
            return db.prepare(sql).get(...args);
          },
        };
      },
    };
  },
};
const home = await worker.fetch(new Request("https://demo.test/"), { DB });
assert.equal(home.status, 200);
assert.match(await home.text(), /DEMO EXPERIENCE/);
assert.ok(home.headers.get("content-security-policy"));
const bootstrap = await worker.fetch(
  new Request("https://demo.test/v1/bootstrap"),
  { DB },
);
assert.equal(bootstrap.status, 200);
const cookie = bootstrap.headers.get("set-cookie").split(";")[0],
  data = (await bootstrap.json()).data;
assert.equal(data.mode, "DEMO");
const post = (body) =>
  worker.fetch(
    new Request("https://demo.test/v1/actions", {
      method: "POST",
      headers: {
        cookie,
        origin: "https://demo.test",
        "content-type": "application/json",
        "x-csrf-token": data.csrf,
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    }),
    { DB },
  );
assert.equal((await post({ action: "login", provider: "google" })).status, 200);
const q = await (
  await post({ action: "quote", stationId: "station_1" })
).json();
assert.ok(q.result.quote.id);
const rental = await (
  await post({
    action: "rent",
    quoteId: q.result.quote.id,
    acceptedTerms: true,
  })
).json();
assert.equal(rental.result.rental.physicalStatus, "AWAITING_FUNDS");
const rentalId = rental.result.rental.id;
for (const body of [
  { action: "pay", rentalId, method: "card", scenario: "success" },
  { action: "collect", rentalId, scenario: "success" },
  { action: "advance", minutes: 80 },
  { action: "return", rentalId, stationId: "station_2" },
  { action: "reconcile", rentalId },
]) {
  const response = await post(body);
  assert.equal(response.status, 200, await response.clone().text());
}
const finalResponse = await worker.fetch(
  new Request("https://demo.test/v1/bootstrap", { headers: { cookie } }),
  { DB },
);
const final = (await finalResponse.json()).data.rentals[0];
assert.equal(final.physicalStatus, "RETURNED");
assert.equal(final.financialStatus, "SETTLED");
assert.equal(final.feeMinor, "100000");
assert.equal(final.refundMinor, "900000");
const otherResponse = await worker.fetch(
  new Request("https://demo.test/v1/bootstrap"),
  { DB },
);
assert.equal((await otherResponse.json()).data.rentals.length, 0);
const missing = await worker.fetch(
  new Request("https://demo.test/v1/bootstrap"),
  {},
);
assert.equal(missing.status, 503);
assert.equal((await post({ action: "admin_login" })).status, 200);
for (const fixture of [
  "inventory_example",
  "dispense_200",
  "return_observation",
]) {
  const inspected = await post({ action: "wscharge_inspect", fixture });
  assert.equal(inspected.status, 200);
  const result = (await inspected.json()).result;
  assert.equal(result.synthetic, true);
  assert.equal(result.observation.liveSendAllowed, false);
  assert.deepEqual(result.observation.automaticEffects, []);
}
const unchanged = await worker.fetch(
  new Request("https://demo.test/v1/bootstrap", { headers: { cookie } }),
  { DB },
);
assert.deepEqual((await unchanged.json()).data.rentals[0], final);
const js = await worker.fetch(new Request("https://demo.test/app.js"), { DB });
assert.match(await js.text(), /WsCharge offline/);
db.close();
console.log(
  "Standalone Worker artifact + embedded assets + packaged D1 migration + API journey + offline WsCharge inspection verified.",
);
