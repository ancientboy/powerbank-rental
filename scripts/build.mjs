import { cp, mkdir, rm } from "node:fs/promises";
const root = new URL("../", import.meta.url),
  out = new URL("dist/", root);
await mkdir(out, { recursive: true });
// Formal deployment never includes the legacy Worker/demo artifact.
await rm(new URL("server/", out), { recursive: true, force: true });
await rm(new URL(".openai/", out), { recursive: true, force: true });
for (const dir of ["src", "scripts", "production-public", "docs"])
  await cp(new URL(dir + "/", root), new URL(dir + "/", out), {
    recursive: true,
  });
for (const file of ["package.json", "package-lock.json", "README.md"])
  await cp(new URL(file, root), new URL(file, out));
console.log(
  "Built Node 24 production package. Run npm start with PUBLIC_ORIGIN and durable DATABASE_PATH. Legacy demo is not served.",
);
