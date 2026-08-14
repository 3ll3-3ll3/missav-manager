import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { loadModule } from "./helpers/bundle.mjs";

const rulesUrl = new URL("../lib/rules.ts", import.meta.url);
const transformed = ts.transpileModule(await readFile(rulesUrl, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
});
const rules = await import(
  `data:text/javascript;base64,${Buffer.from(transformed.outputText).toString("base64")}`
);
const telegram = await loadModule("lib/telegram.ts");
const exporter = await loadModule("lib/tool-export.ts");

const documents = (text) => [{ name: "sample.txt", text }];
const primary = (tool, text) =>
  rules
    .processDocuments(tool, documents(text))
    .results.map((row) => row.primaryValue);

test("复刻推特博主过滤：保持首次出现顺序并排除传送门、短标签和 bot", () => {
  assert.deepEqual(
    primary(
      "twitter",
      [
        "昵称 #kechunyaoll 与 @Second_User",
        "重复 #KECHUNYAOLL https://twitter.com/Third3/status/1",
        "蛇 #xxxxshe0 #黑丝 #jk",
        "传送门 #chuansongmen520 博主： @m1stedoll",
        "机器人 @haha6693_bot",
      ].join("\n"),
    ),
    ["kechunyaoll", "Second_User", "Third3", "xxxxshe0", "m1stedoll"],
  );
});

test("推特规则不把常见成人主题标签和带数字变体当成账号", () => {
  assert.deepEqual(primary("twitter", "Se #sex80000 #nsfw #porno2026"), []);
  assert.deepEqual(primary("twitter", "#sex80000 但明确账号是 @real_creator"), [
    "real_creator",
  ]);
});

test("只保留 Bad.news 主题链接并规范化去重", () => {
  assert.deepEqual(
    primary(
      "badnews",
      "https://bad.news/app https://bad.news/t/6295976 https://www.bad.news/t/6295976?from=tg http://bad.news/t/6295984#comments",
    ),
    ["https://bad.news/t/6295976", "https://bad.news/t/6295984"],
  );
});

test("海角链接只接受 v0.5.13 分类和数字 html 页面", () => {
  assert.deepEqual(
    primary(
      "haijiao",
      "https://www.haijiaolove.xyz/hjsz/127766.html http://haijiaolove.xyz/hjjd/58198.html?from=tg https://haijiaolove.xyz/original https://haijiaolove.xyz/hjmz/58488.html/",
    ),
    [
      "https://www.haijiaolove.xyz/hjsz/127766.html",
      "https://www.haijiaolove.xyz/hjjd/58198.html",
      "https://www.haijiaolove.xyz/hjmz/58488.html",
    ],
  );
});

test("MissAV 番号规范化、降噪和可信 URL 行为与桌面基线一致", () => {
  assert.deepEqual(
    rules.parseCodeList(`
    <div id="message14298">ABF-354</div>
    https://missav.ai/cn/sone-314-chinese-subtitle
    FC2 PPV 4625027
    https://hostloc.com/thread-1285447-1-1.html
    https://example.com/assets/mark_1232.jpg
    https://123av.com/cn/v/393otim-648-uncensored-leaked
    PDF24 Office 365 Java 11 IEOR 6711 Fall 2013 RJ01393321
  `),
    ["ABF-354", "SONE-314", "FC2-PPV-4625027", "OTIM-648"],
  );
});

test("123AV 只生成本地番号任务，可信详情链接仅来自实际输入", () => {
  const output = rules.processDocuments(
    "av123",
    documents(
      "ABF-354 https://123av.com/cn/v/sone-314-chinese-subtitle PDF24 Office 365",
    ),
  );
  assert.deepEqual(
    output.results.map((row) => ({
      code: row.primaryValue,
      url: row.secondaryValue,
      status: row.status,
    })),
    [
      { code: "ABF-354", url: "", status: "task_ready" },
      {
        code: "SONE-314",
        url: "https://123av.com/cn/v/sone-314-chinese-subtitle",
        status: "task_ready",
      },
    ],
  );
  assert.equal(
    output.results.some((row) =>
      /queried|favorite|已查询|已收藏/i.test(String(row.status)),
    ),
    false,
  );
});

test("Telegram UTC 偏移时间按桌面规则归一化", () => {
  assert.equal(
    rules.parseTelegramDate("01.07.2026 00:18:59 UTC+08:00").toISOString(),
    "2026-06-30T16:18:59.000Z",
  );
});

test("Telegram 富文本、图片说明、按钮和网页预览中的隐藏链接都会进入工具规则", () => {
  const botText = telegram.telegramMessageText({
    caption: "点这里查看原帖",
    caption_entities: [
      { type: "text_link", url: "https://bad.news/t/6295976?from=bot" },
    ],
    reply_markup: {
      inline_keyboard: [
        [{ text: "备用入口", url: "https://bad.news/t/6295984" }],
      ],
    },
  });
  assert.deepEqual(primary("badnews", botText), [
    "https://bad.news/t/6295976",
    "https://bad.news/t/6295984",
  ]);

  const personalText = telegram.telegramMessageText({
    message: "海角正文",
    entities: [{ url: "https://www.haijiaolove.xyz/hjsz/127766.html?tg=1" }],
    replyMarkup: {
      rows: [{ buttons: [{ url: "https://bad.news/t/6295999" }] }],
    },
    media: { webpage: { url: "https://bad.news/t/6296000" } },
  });
  assert.deepEqual(primary("badnews", personalText), [
    "https://bad.news/t/6295999",
    "https://bad.news/t/6296000",
  ]);
  assert.deepEqual(primary("haijiao", personalText), [
    "https://www.haijiaolove.xyz/hjsz/127766.html",
  ]);
});

test("Bot 秒时间戳与毫秒时间戳都归一化，不再产生 Invalid Date", () => {
  assert.equal(telegram.telegramDate("1786665600"), "2026-08-14T00:00:00.000Z");
  assert.equal(
    telegram.telegramDate("1786665600000"),
    "2026-08-14T00:00:00.000Z",
  );
  assert.equal(telegram.telegramDate("not-a-date"), "");
});

test("规范化与去重保留首次来源、原始值和附加来源审计", () => {
  const output = rules.processDocuments("badnews", [
    {
      name: "first.txt",
      text: "http://www.bad.news/t/6297001?from=first",
      sourceKind: "telegram_api",
      sourceName: "来源 A",
      connectionId: "telegram-personal",
      sourceId: "source-a",
      messageId: "101",
      messageDate: "2026-08-14T01:02:03.000Z",
    },
    {
      name: "second.txt",
      text: "https://bad.news/t/6297001#again",
      sourceKind: "telegram_api",
      sourceName: "来源 B",
      connectionId: "telegram-personal",
      sourceId: "source-b",
      messageId: "202",
      messageDate: "2026-08-14T01:03:03.000Z",
    },
  ]);
  assert.equal(output.results.length, 1);
  assert.equal(output.results[0].primaryValue, "https://bad.news/t/6297001");
  assert.equal(output.results[0].source, "来源 A");
  assert.equal(output.results[0].metadata.sourceId, "source-a");
  assert.equal(output.results[0].metadata.messageId, "101");
  assert.equal(
    output.results[0].metadata.originalValue,
    "http://www.bad.news/t/6297001?from=first",
  );
  assert.equal(output.results[0].metadata.sourceCount, 2);
  assert.deepEqual(output.results[0].metadata.additionalSourceIds, [
    "source-b:202",
  ]);
  assert.equal(output.stats.candidateCount, 2);
  assert.equal(output.stats.resultCount, 1);
  assert.equal(output.stats.duplicateCount, 1);
});

test("时间范围覆盖结束分钟，排除无时间 Telegram，同时保留普通手动文本", () => {
  const output = rules.processDocuments(
    "badnews",
    [
      {
        name: "inside.txt",
        text: "https://bad.news/t/6297101",
        sourceKind: "telegram_api",
        messageDate: "2026-08-14T12:34:59.999",
      },
      {
        name: "outside.txt",
        text: "https://bad.news/t/6297102",
        sourceKind: "telegram_api",
        messageDate: "2026-08-14T12:35:00.000",
      },
      {
        name: "undated-api.txt",
        text: "https://bad.news/t/6297103",
        sourceKind: "telegram_api",
      },
      {
        name: "manual.txt",
        text: "https://bad.news/t/6297104",
        sourceKind: "manual_file",
      },
    ],
    "2026-08-14T12:34",
    "2026-08-14T12:34",
  );
  assert.deepEqual(
    output.results.map((row) => row.primaryValue),
    ["https://bad.news/t/6297101", "https://bad.news/t/6297104"],
  );
  assert.equal(output.stats.parsedMessageCount, 4);
  assert.equal(output.stats.inRangeMessageCount, 2);
});

test("单文件失败不丢成功文件，统计区分解析失败、规则排除和空结果", () => {
  const output = rules.processDocuments("badnews", [
    { name: "broken.json", text: "{not valid json" },
    {
      name: "good.txt",
      text: "https://bad.news/app https://bad.news/t/6297201",
    },
  ]);
  assert.deepEqual(
    output.results.map((row) => row.primaryValue),
    ["https://bad.news/t/6297201"],
  );
  assert.equal(output.stats.inputFileCount, 2);
  assert.equal(output.stats.parsedFileCount, 1);
  assert.equal(output.stats.failedFileCount, 1);
  assert.equal(output.stats.candidateCount, 2);
  assert.equal(output.stats.ruleExcludedCount, 1);
  assert.match(output.fileOutcomes[0].error, /JSON/);
});

test("纯文本、CSV 与 123AV 任务导出共享同一结果范围且不输出空行", () => {
  const rows = rules.processDocuments(
    "av123",
    documents(
      "ABF-354 https://123av.com/cn/v/sone-314-chinese-subtitle ABF354",
    ),
  ).results;
  assert.equal(
    exporter.toolFieldText("av123", rows, "primary"),
    "ABF-354\r\nSONE-314",
  );
  assert.equal(
    exporter.toolFieldText("av123", rows, "secondary"),
    "https://123av.com/cn/v/sone-314-chinese-subtitle",
  );
  const csv = exporter.toolCsv("av123", rows);
  assert.match(
    csv,
    /^\uFEFFcode,url,status,error,source,message_id,message_date,imported_at\r?\n/,
  );
  assert.equal(csv.split(/\r?\n/).length, rows.length + 1);
  const tasks = exporter.av123TaskCsv(rows, "run-1");
  assert.match(tasks, /^\uFEFFtask_id,code,url,status\r?\n/);
  assert.match(tasks, /"run-1:abf354","ABF-354","","task_ready"/);
});

test("Telegram 逐消息空结果与规则异常互不阻塞", () => {
  const base = {
    links: [],
    messageDate: "2026-08-14T00:00:00.000Z",
    sourceType: "telegram_api",
    source: "测试频道",
    sourceKind: "telegram_api",
    sourceName: "测试频道",
    connectionId: "telegram-personal",
    sourceId: "source-1",
    eventKind: "message",
  };
  const output = rules.processMessages("badnews", [
    { ...base, messageId: "1", text: "没有目标链接" },
    { ...base, messageId: "2", text: "会触发隔离异常", links: null },
    { ...base, messageId: "3", text: "https://bad.news/t/6297301" },
  ]);
  assert.deepEqual(
    output.messageResults.map((row) => [row.messageId, row.status]),
    [
      ["1", "processed_empty"],
      ["2", "error"],
      ["3", "processed"],
    ],
  );
  assert.deepEqual(
    output.results.map((row) => row.primaryValue),
    ["https://bad.news/t/6297301"],
  );
  assert.equal(output.stats.errorCount, 1);
});
