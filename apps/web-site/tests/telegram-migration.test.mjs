import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/bundle.mjs";

const telegram=await loadModule("lib/telegram.ts");
const migration=await loadModule("lib/migration.ts");

test("Telegram 官方 JSON 保留来源/消息 ID，富文本链接可被展开并去重",()=>{
  const payload={name:"合成频道",id:123,messages:[{id:7,date:"2026-07-20T08:00:00",text:["番号 ",{type:"link",text:"ABF-354",href:"https://missav.ai/cn/abf-354"}]},{id:7,date:"2026-07-20T08:00:00",text:"重复"},{id:8,date:"2026-07-20T08:01:00",text:"没有候选"}]};
  const rows=telegram.parseTelegramOfficialJson(payload);
  assert.equal(rows.length,2);assert.equal(rows[0].messageId,"7");assert.match(rows[0].text,/https:\/\/missav\.ai/);assert.equal(rows[1].text,"没有候选");
});

test("Bot updates 使用全局 update offset，并保留每个来源唯一消息 ID",()=>{
  const parsed=telegram.telegramBotUpdates({result:[{update_id:50,channel_post:{message_id:9,date:1780000000,text:"#alice_test",chat:{id:-1001,title:"测试频道"}}},{update_id:51,message:{message_id:2,date:1780000001,text:"ABF-354",chat:{id:88,title:"测试群"}}}]});
  assert.equal(parsed.nextOffset,52);assert.equal(parsed.messages.length,2);assert.deepEqual(parsed.messages.map(item=>item.messageId),["9","2"]);
});

test("迁移器识别五类工具、坏日期、不安全 URL 与 CSV 公式样本",()=>{
  const good=migration.validateMigrationRecord({tool:"av123",normalizedValue:"DASS-980",primaryUrl:"https://123av.com/cn/v/dass-980",status:"exported"});
  assert.equal(good.record.primaryValue,"DASS-980");assert.equal(good.record.av123Url,"https://123av.com/cn/v/dass-980");
  assert.equal(migration.validateMigrationRecord({tool:"badnews",normalizedValue:"javascript:alert(1)",primaryUrl:"javascript:alert(1)"}).reason,"不安全 URL");
  assert.equal(migration.validateMigrationRecord({tool:"missav",normalizedValue:"IPX-607",primaryUrl:"https://missav.ai/cn/ipx-607",createdAt:"not-a-date"}).reason,"日期无效");
  const formula=migration.validateMigrationRecord({tool:"twitter",normalizedValue:"=2+5",primaryUrl:"https://x.com/formula_test",tags:["@SUM(A1:A2)"]});
  assert.equal(formula.record.primaryValue,"=2+5");
});
