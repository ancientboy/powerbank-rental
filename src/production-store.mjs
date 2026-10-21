import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCallback);
export async function hashPassword(password) {
  if (
    typeof password !== "string" ||
    password.length < 14 ||
    password.length > 256
  )
    throw new Error("Password must contain 14–256 characters.");
  const salt = randomBytes(32).toString("hex");
  const key = await scrypt(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$32768$${salt}$${key.toString("hex")}`;
}
export async function verifyPassword(password, encoded) {
  if (typeof password !== "string" || password.length > 256) return false;
  const parts = (encoded || "").split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt" || parts[1] !== "32768")
    return false;
  const key = await scrypt(password, parts[2], 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const expected = Buffer.from(parts[3], "hex");
  return expected.length === key.length && timingSafeEqual(key, expected);
}
export function openProductionStore(path) {
  if (path !== ":memory:")
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
  );
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS admins(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','operator','viewer')), disabled INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, google_sub TEXT NOT NULL UNIQUE, email TEXT, name TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('admin','user')), subject TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS oauth_states(state_hash TEXT PRIMARY KEY, binding_hash TEXT NOT NULL, nonce TEXT NOT NULL, verifier TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, id TEXT NOT NULL, owner_id TEXT, data TEXT NOT NULL, PRIMARY KEY(kind,id));
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, created_at TEXT NOT NULL);
  INSERT OR IGNORE INTO schema_migrations VALUES(1,datetime('now'));`);
  return db;
}
export function listRecords(db, kind, owner) {
  return (
    owner === undefined
      ? db.prepare("SELECT data FROM records WHERE kind=?").all(kind)
      : db
          .prepare("SELECT data FROM records WHERE kind=? AND owner_id=?")
          .all(kind, owner)
  ).map((x) => JSON.parse(x.data));
}
export function putRecord(db, kind, id, data, owner = null) {
  db.prepare(
    "INSERT INTO records(kind,id,owner_id,data) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,owner_id=excluded.owner_id",
  ).run(kind, id, owner, JSON.stringify(data));
}
export function recordAudit(db, actor, action, target, now = Date.now()) {
  db.prepare(
    "INSERT INTO audit(actor,action,target,created_at) VALUES(?,?,?,?)",
  ).run(actor, action, target, new Date(now).toISOString());
}
export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
