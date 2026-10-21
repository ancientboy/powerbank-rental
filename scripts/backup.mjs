import { DatabaseSync, backup } from "node:sqlite";
import { resolve } from "node:path";
import { access } from "node:fs/promises";
process.umask(0o077);
const source = resolve(process.env.DATABASE_PATH || ".local/production.sqlite"),
  target = process.argv[2] && resolve(process.argv[2]);
if (!target || source === target)
  throw new Error("Usage: npm run backup -- /secure-backup/new-file.sqlite");
try {
  await access(target);
  throw new Error("Backup target already exists; choose a new filename");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const db = new DatabaseSync(source, { readOnly: true });
try {
  await backup(db, target);
  console.log(
    "Consistent SQLite backup completed. Protect this file as private data.",
  );
} finally {
  db.close();
}
