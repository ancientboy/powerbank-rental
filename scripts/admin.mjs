import {
  openProductionStore,
  hashPassword,
  recordAudit,
  transaction,
} from "../src/production-store.mjs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
process.umask(0o077);
const [operation, username, role = "owner"] = process.argv.slice(2);
if (
  !["create", "reset-password", "disable"].includes(operation) ||
  !username ||
  !/^[a-z0-9._-]{3,100}$/.test(username) ||
  !["owner", "operator", "viewer"].includes(role)
)
  throw new Error(
    "Usage: npm run admin -- create|reset-password|disable username [owner|operator|viewer]",
  );
if (!process.stdin.isTTY)
  throw new Error(
    "Run the admin command from an interactive trusted server terminal. Passwords must not be passed via command arguments or files.",
  );
const db = openProductionStore(
  process.env.DATABASE_PATH || ".local/production.sqlite",
);
const current = db
  .prepare("SELECT * FROM admins WHERE username=?")
  .get(username);
if (operation === "create" && current)
  throw new Error("Administrator already exists");
if (operation !== "create" && !current)
  throw new Error("Administrator not found");
const rl = createInterface({ input: process.stdin, output: process.stdout });
if (
  (await rl.question(
    `${operation} administrator ${username}${operation === "create" ? " with role " + role : ""}? Type YES: `,
  )) !== "YES"
) {
  rl.close();
  db.close();
  process.exit(1);
}
rl.close();
async function password(prompt) {
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    function cleanup() {
      process.stdin.off("data", read);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    }
    function read(chunk) {
      for (const c of chunk.toString()) {
        if (c === "\u0003") {
          cleanup();
          reject(new Error("Cancelled"));
          return;
        }
        if (c === "\r" || c === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (c === "\u007f") value = value.slice(0, -1);
        else if (c >= " ") value += c;
      }
    }
    process.stdin.on("data", read);
  });
}
let hash;
if (operation !== "disable") {
  const first = await password("New password (8–256 characters, hidden): ");
  if (first !== (await password("Repeat password (hidden): ")))
    throw new Error("Passwords do not match");
  hash = await hashPassword(first);
}
transaction(db, () => {
  if (operation === "create") {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO admins(id,username,password_hash,role) VALUES(?,?,?,?)",
    ).run(id, username, hash, role);
    recordAudit(db, "offline-cli", "admin.create", id);
  } else {
    db.prepare(
      operation === "disable"
        ? "UPDATE admins SET disabled=1 WHERE id=?"
        : "UPDATE admins SET password_hash=? WHERE id=?",
    ).run(...(operation === "disable" ? [current.id] : [hash, current.id]));
    db.prepare("DELETE FROM sessions WHERE kind='admin' AND subject=?").run(
      current.id,
    );
    recordAudit(db, "offline-cli", "admin." + operation, current.id);
  }
});
db.close();
console.log(
  "Administrator updated. No password was printed or saved in plaintext.",
);
