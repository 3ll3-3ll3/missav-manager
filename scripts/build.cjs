const { existsSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const isSiteBuild = existsSync(path.resolve("apps/web-site/.openai/hosting.json"));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const desktopCommand = process.platform === "win32"
  ? path.resolve("node_modules/.bin/electron-builder.cmd")
  : path.resolve("node_modules/.bin/electron-builder");
if (isSiteBuild && !existsSync(path.resolve("apps/web-site/node_modules/.bin/vinext"))) {
  const install = spawnSync(npmCommand, ["--prefix", "apps/web-site", "run", "install:ci"], { stdio: "inherit" });
  if (install.error) throw install.error;
  if ((install.status ?? 1) !== 0) process.exit(install.status ?? 1);
}

const command = isSiteBuild ? npmCommand : desktopCommand;
const args = isSiteBuild ? ["--prefix", "apps/web-site", "run", "build"] : ["--win", "--publish", "never"];

const result = spawnSync(command, args, { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
