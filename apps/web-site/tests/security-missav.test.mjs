import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadModule, projectFile } from "./helpers/bundle.mjs";

const security = await loadModule("lib/security.ts");
const missav = await loadModule("lib/missav.ts");
const referenceTags = (await readFile(projectFile("public/default-reference-tags.txt"), "utf8")).trim().split(/\r?\n/);

test("CSV 公式、HTML 与日志敏感值均被安全处理", () => {
  assert.equal(security.csvSafe("=2+5"), '"\'=2+5"');
  assert.equal(security.csvSafe(" @SUM(A1:A2)"), '"\' @SUM(A1:A2)"');
  assert.equal(security.escapeHtml('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  const redacted = security.redact('token=123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi 电话 +8613812345678 {"session":"session-secret","api_hash":"hash-secret"} tg://login?token=qr-secret');
  assert.doesNotMatch(redacted, /ABCDEFGHIJKLMNOPQRSTUVWXYZ|13812345678|session-secret|hash-secret|qr-secret/);
});

test("默认参考库与交接包一致，并生成未改写核心流程的完整三目录脚本", async () => {
  assert.equal(referenceTags.length, 1553);
  const blocked = referenceTags[0];
  const generated = await missav.generateMissavBrowserScript(["abf_354", "FC2 PPV 2386297"], referenceTags, [blocked], ["测试排除"]);
  assert.deepEqual(generated.codes, ["ABF-354", "FC2-PPV-2386297"]);
  assert.equal(generated.referenceTagCount, 1552);
  assert.match(generated.script, /参考女优Tag命中/);
  assert.match(generated.script, /需要查找/);
  assert.match(generated.script, /const OTHER_FOLDER_NAME = '其他'/);
  assert.match(generated.script, /RAINDROP_EXPORT_BLACKLIST_TAGS = \[\s*"测试排除"/);
  const injected = JSON.parse(generated.script.match(/const REFERENCE_ACTRESS_TAGS = (\[[\s\S]*?\]);/)?.[1] ?? "[]");
  assert.equal(injected.includes(blocked), false);
});

test("网站使用 apps/web-site 内的固定桌面脚本副本", async () => {
  const webScript = await readFile(projectFile("assets/missav-browser-script.txt"), "utf8");
  const desktopScript = await readFile(new URL("../../desktop-v05/src/assets/missav-browser-script.txt", import.meta.url), "utf8");
  assert.equal(webScript, desktopScript);
});

test("Raindrop 预览和导出共用第二层黑名单，排除项仍保留审计", () => {
  const base = {tool:"missav",recordKey:"abf-354",primaryValue:"ABF-354",secondaryValue:"",status:"ready",actressTags:[],genreTags:[],sourceUrl:"",missavUrl:"",av123Url:"",metadata:{},createdAt:"2026-07-20T00:00:00Z",updatedAt:"2026-07-20T00:00:00Z"};
  const rows = [{...base,id:"1",tags:["允许"]},{...base,id:"2",recordKey:"sone-314",primaryValue:"SONE-314",tags:["测试排除"]},{...base,id:"3",recordKey:"ipx-607",primaryValue:"IPX-607",tags:["<img onerror=alert(1)>"]}];
  const result = missav.buildRaindropExport(rows,["测试排除"],"html");
  assert.equal(result.included,2);assert.equal(result.excluded,1);
  assert.equal(result.audits.find(item=>item.id==="2").reason,"第二层黑名单：测试排除");
  assert.doesNotMatch(result.content, /<img onerror/);assert.match(result.content,/&lt;img onerror=alert\(1\)&gt;/);
});

test("Netscape HTML 解析先预览并应用第一层资格取消", () => {
  const html='<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><A HREF="https://missav.ai/cn/abf-354" TAGS="测试女优甲,单体作品">ABF-354</A><DT><A HREF="https://missav.ai/cn/sone-314" TAGS="测试女优乙">SONE-314</A></DL>';
  const result=missav.extractReferenceActressTagsFromHtml(html,["测试女优甲","测试女优乙"],["测试女优乙"]);
  assert.equal(result.bookmarkCount,2);assert.deepEqual(result.tags,["测试女优甲"]);assert.equal(result.blacklistedTagCount,1);
});
