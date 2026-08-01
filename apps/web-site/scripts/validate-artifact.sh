#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${SITES_ENV_READY:-}" != "1" ]]; then
  exec "${script_dir}/sites-env.sh" -- "$0" "$@"
fi

worker="${SITES_PROJECT_ROOT}/dist/server/index.js"
hosting="${SITES_PROJECT_ROOT}/dist/.openai/hosting.json"

[[ -f "${worker}" ]] || {
  echo "Missing Sites Worker entry: dist/server/index.js" >&2
  exit 66
}
[[ -f "${hosting}" ]] || {
  echo "Missing packaged Sites manifest: dist/.openai/hosting.json" >&2
  exit 66
}

node --input-type=module - "${worker}" "${hosting}" <<'NODE'
import { readFile } from "node:fs/promises";

const [workerPath, hostingPath] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(hostingPath, "utf8"));
const source = await readFile(workerPath, "utf8");
if (!/export\s*\{[^}]*\bas\s+default\b[^}]*\}/s.test(source) && !/export\s+default\s+/s.test(source))
  throw new Error("dist/server/index.js must expose an ESM default Worker export");
if (manifest.d1 !== "DB") throw new Error("dist hosting manifest must bind D1 as DB");
NODE

echo "Validated Sites artifact: ESM Worker export, D1 binding, and hosting manifest are present."
