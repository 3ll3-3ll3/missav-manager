import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const rulesUrl = new URL("../lib/rules.ts", import.meta.url);
const transformed = ts.transpileModule(await readFile(rulesUrl, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const rules = await import(`data:text/javascript;base64,${Buffer.from(transformed.outputText).toString("base64")}`);

const documents = (text) => [{ name: "sample.txt", text }];
const primary = (tool, text) => rules.processDocuments(tool, documents(text)).results.map((row) => row.primaryValue);

test("复刻推特博主过滤：保持首次出现顺序并排除传送门、短标签和 bot", () => {
  assert.deepEqual(primary("twitter", [
    "昵称 #kechunyaoll 与 @Second_User",
    "重复 #KECHUNYAOLL https://twitter.com/Third3/status/1",
    "蛇 #xxxxshe0 #黑丝 #jk",
    "传送门 #chuansongmen520 博主： @m1stedoll",
    "机器人 @haha6693_bot",
  ].join("\n")), ["kechunyaoll", "Second_User", "Third3", "xxxxshe0", "m1stedoll"]);
});

test("推特规则不把常见成人主题标签和带数字变体当成账号", () => {
  assert.deepEqual(primary("twitter", "Se #sex80000 #nsfw #porno2026"), []);
  assert.deepEqual(primary("twitter", "#sex80000 但明确账号是 @real_creator"), ["real_creator"]);
});

test("只保留 Bad.news 主题链接并规范化去重", () => {
  assert.deepEqual(primary("badnews", "https://bad.news/app https://bad.news/t/6295976 https://www.bad.news/t/6295976?from=tg http://bad.news/t/6295984#comments"), [
    "https://bad.news/t/6295976", "https://bad.news/t/6295984",
  ]);
});

test("海角链接只接受 v0.5.13 分类和数字 html 页面", () => {
  assert.deepEqual(primary("haijiao", "https://www.haijiaolove.xyz/hjsz/127766.html http://haijiaolove.xyz/hjjd/58198.html?from=tg https://haijiaolove.xyz/original https://haijiaolove.xyz/hjmz/58488.html/"), [
    "https://www.haijiaolove.xyz/hjsz/127766.html",
    "https://www.haijiaolove.xyz/hjjd/58198.html",
    "https://www.haijiaolove.xyz/hjmz/58488.html",
  ]);
});

test("MissAV 番号规范化、降噪和可信 URL 行为与桌面基线一致", () => {
  assert.deepEqual(rules.parseCodeList(`
    <div id="message14298">ABF-354</div>
    https://missav.ai/cn/sone-314-chinese-subtitle
    FC2 PPV 4625027
    https://hostloc.com/thread-1285447-1-1.html
    https://example.com/assets/mark_1232.jpg
    https://123av.com/cn/v/393otim-648-uncensored-leaked
    PDF24 Office 365 Java 11 IEOR 6711 Fall 2013 RJ01393321
  `), ["ABF-354", "SONE-314", "FC2-PPV-4625027", "OTIM-648"]);
});

test("Telegram UTC 偏移时间按桌面规则归一化", () => {
  assert.equal(rules.parseTelegramDate("01.07.2026 00:18:59 UTC+08:00").toISOString(), "2026-06-30T16:18:59.000Z");
});
