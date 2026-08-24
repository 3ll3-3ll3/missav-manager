import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("构建产物包含私人工作台、开发预览元数据和持久化迁移", async () => {
  const worker = await readFile(new URL("../dist/server/index.js", import.meta.url), "utf8");
  const manifest = JSON.parse(await readFile(new URL("../dist/.openai/hosting.json", import.meta.url), "utf8"));
  const migrations = await readdir(new URL("../dist/.openai/drizzle/", import.meta.url));
  assert.match(worker, /TG 内容工具箱/);
  assert.match(worker, /codex-preview/);
  assert.doesNotMatch(worker, /Starter Project/);
  assert.equal(manifest.d1, "DB");
  assert.ok(migrations.some((file) => file.endsWith(".sql")));
});
