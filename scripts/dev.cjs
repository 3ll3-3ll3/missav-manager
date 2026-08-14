const { spawnSync } = require("node:child_process");
const path = require("node:path");

const forwarded = process.argv.slice(2);
const isSitePreview = forwarded.some((value) => value === "--host" || value.startsWith("--host="));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const electronCommand = path.resolve(
  "node_modules/.bin",
  process.platform === "win32" ? "electron.cmd" : "electron",
);
const result = isSitePreview
  ? spawnSync(npmCommand, ["--prefix", "apps/web-site", "run", "dev", "--", ...forwarded], { stdio: "inherit" })
  : spawnSync(electronCommand, [".", "--dev", ...forwarded], { stdio: "inherit" });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
