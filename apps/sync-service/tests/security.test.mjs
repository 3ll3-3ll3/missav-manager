import test from "node:test";
import assert from "node:assert/strict";
import { extractBearer, normalizePairingCode, redactError, safeLimit } from "../src/index.mjs";

test("配对码只保留安全的大写字符", () => {
  assert.equal(normalizePairingCode("ab-cd 23!xy"), "ABCD23XY");
});

test("设备 Bearer 解析不接受其他认证格式", () => {
  assert.equal(extractBearer(new Request("https://sync.test", { headers: { authorization: "Bearer tgds_example" } })), "tgds_example");
  assert.equal(extractBearer(new Request("https://sync.test", { headers: { authorization: "Basic abc" } })), "");
});

test("错误输出清除 token、session 和密码", () => {
  const result = redactError("token=abc session=def password=ghi Authorization: Bearer xyz");
  assert.doesNotMatch(result, /abc|def|ghi|xyz/);
  assert.match(result, /REDACTED/);
});

test("分页上限不能被客户端放大", () => {
  assert.equal(safeLimit("99999"), 500);
  assert.equal(safeLimit("0"), 1);
  assert.equal(safeLimit("bad"), 200);
});
