import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const out = new URL("dist/", root);
await mkdir(new URL("server/", out), { recursive: true });
await mkdir(new URL(".openai/", out), { recursive: true });
const assets = {};
for (const file of ["index.html", "app.js", "style.css", "smile-mark.svg"])
  assets["/" + file] = {
    body: await readFile(new URL("public/" + file, root), "utf8"),
    type: file.endsWith("html")
      ? "text/html; charset=utf-8"
      : file.endsWith("js")
        ? "text/javascript; charset=utf-8"
        : file.endsWith("svg")
          ? "image/svg+xml"
          : "text/css; charset=utf-8",
  };
let bundle = "";
for (const file of [
  "adapters",
  "domain",
  "wscharge",
  "scenarios",
  "store",
  "api",
  "worker",
]) {
  let code = await readFile(new URL("src/" + file + ".mjs", root), "utf8");
  code = code.replace(/^import[\s\S]*?;\s*/gm, "").replace(/\bexport /g, "");
  bundle += "\n" + code;
}
bundle +=
  "\nconst assets=" +
  JSON.stringify(assets) +
  ";\nexport default createWorker(assets);\n";
await writeFile(new URL("server/index.js", out), bundle);
await cp(
  new URL(".openai/hosting.json", root),
  new URL(".openai/hosting.json", out),
);
await cp(new URL("drizzle/", root), new URL(".openai/drizzle/", out), {
  recursive: true,
});
console.log("Built standalone Worker with embedded assets and D1 migrations");
