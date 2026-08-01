import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function loadModule(relativePath) {
  const absolute = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..", relativePath);
  const result = await build({
    entryPoints: [absolute], bundle: true, format: "esm", platform: "node", target: "node22", write: false,
    plugins: [{
      name: "raw-text",
      setup(buildApi) {
        buildApi.onResolve({ filter: /\?raw$/ }, (args) => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: "raw-text" }));
        buildApi.onLoad({ filter: /.*/, namespace: "raw-text" }, async (args) => ({ contents: `export default ${JSON.stringify(await readFile(args.path, "utf8"))}`, loader: "js" }));
      },
    }],
  });
  const source = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${Date.now()}-${Math.random()}`);
}

export const projectFile = (relativePath) => new URL(`../../${relativePath}`, import.meta.url);
export const fileUrl = pathToFileURL;
