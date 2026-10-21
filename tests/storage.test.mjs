import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { D1Store } from "../src/store.mjs";
import { apply } from "../src/domain.mjs";
function d1(db) {
  return {
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
}
test("D1 real SQLite migration, CAS race, persistence and constraints", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(new URL("../drizzle/0000_demo.sql", import.meta.url), "utf8"),
  );
  const store = new D1Store(d1(db));
  await store.initialize();
  await Promise.all(
    Array.from({ length: 10 }, () =>
      store.transact((s) => {
        s.config.counter = (s.config.counter || 0) + 1;
      }),
    ),
  );
  assert.equal((await store.read()).config.counter, 10);
  const restarted = new D1Store(d1(db));
  assert.equal((await restarted.read()).config.counter, 10);
  assert.throws(() =>
    db.prepare("UPDATE demo_state SET payload = ?").run("bad json"),
  );
  db.close();
});
test("D1 concurrent one-bank contention and per-user active rental guard", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(new URL("../drizzle/0000_demo.sql", import.meta.url), "utf8"),
  );
  const store = new D1Store(d1(db));
  await store.initialize();
  await store.transact((s) => {
    s.stations[0].slots.forEach((x, i) => {
      if (i) x.bankId = null;
    });
  });
  const user1 = {},
    user2 = {};
  await store.transact((s) =>
    apply(s, user1, { action: "login", provider: "google" }),
  );
  await store.transact((s) =>
    apply(s, user2, { action: "login", provider: "apple" }),
  );
  const work = (user) =>
    store.transact((s) => {
      const q = apply(s, user, {
        action: "quote",
        stationId: "station_1",
      }).quote;
      return apply(s, user, {
        action: "rent",
        quoteId: q.id,
        acceptedTerms: true,
      });
    });
  const results = await Promise.allSettled([work(user1), work(user2)]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal((await store.read()).rentals.length, 1);
  db.close();
});
test("different workspace keys isolate state and operator access", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(new URL("../drizzle/0000_demo.sql", import.meta.url), "utf8"),
  );
  const one = new D1Store(d1(db), "browser-one"),
    two = new D1Store(d1(db), "browser-two");
  await one.transact((s) => {
    s.config.rentalsEnabled = false;
    s.clockOffset = 99999;
  });
  assert.equal((await two.read()).config.rentalsEnabled, true);
  assert.equal((await two.read()).clockOffset, 0);
  db.close();
});
