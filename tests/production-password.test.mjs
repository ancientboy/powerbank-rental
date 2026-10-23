import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../src/production-store.mjs";

test("administrator passwords accept 8 characters and retain verification", async () => {
  const password = "Abcd123!";
  const hash = await hashPassword(password);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword("different", hash), false);
});

test("administrator passwords reject fewer than 8 characters and invalid values", async () => {
  for (const value of ["1234567", "", null, 12345678, "x".repeat(257)]) {
    await assert.rejects(hashPassword(value), /8–256/);
  }
  const password = "x".repeat(256);
  assert.equal(await verifyPassword(password, await hashPassword(password)), true);
});
