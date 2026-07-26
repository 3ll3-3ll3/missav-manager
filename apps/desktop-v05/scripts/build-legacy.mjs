import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const directory = path.dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [path.join(directory, "legacy-entry.cjs")],
  outfile: path.join(directory, "../src/generated/legacyBundle.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: false,
  legalComments: "none",
  banner: { js: "// Generated from the tested v0.4.5 business-rule modules. Do not hand-edit." },
});
