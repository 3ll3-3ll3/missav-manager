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
  const parsed=telegram.telegramBotUpdates({result:[{update_id:50,channel_post:{message_id:9,date:1780000000,text:"#alice_test",chat:{id:-1001,type:"channel",title:"测试频道"}}},{update_id:51,message:{message_id:2,date:1780000001,text:"ABF-354",chat:{id:88,type:"supergroup",title:"测试群"}}},{update_id:52,edited_message:{message_id:2,date:1780000001,edit_date:1780000100,text:"ABF-355",chat:{id:88,type:"supergroup",title:"测试群"}}},{update_id:53,message:{message_id:7,date:1780000002,text:"private",chat:{id:9,type:"private",first_name:"私聊"}}}]});
  assert.equal(parsed.nextOffset,54);assert.equal(parsed.messages.length,3);assert.deepEqual(parsed.messages.map(item=>item.messageId),["9","2","2"]);
  assert.equal(parsed.messages[2].eventKind,"edited");assert.match(parsed.messages[2].editedAt,/T/);assert.equal(parsed.messages.some(item=>item.sourceKey==="9"),false);
});

test("工具绑定基线与日期范围只向符合条件的消息扇出",()=>{
  assert.equal(telegram.telegramBindingAcceptsMessage({historyMode:"since_now",historyFrom:"",boundAtMessageId:"100"},{messageId:"100",messageDate:"2026-08-01T00:00:00Z"}),false);
  assert.equal(telegram.telegramBindingAcceptsMessage({historyMode:"since_now",historyFrom:"",boundAtMessageId:"100"},{messageId:"101",messageDate:"2026-08-01T00:00:00Z"}),true);
  assert.equal(telegram.telegramBindingAcceptsMessage({historyMode:"from_date",historyFrom:"2026-08-01T00:00:00Z",boundAtMessageId:""},{messageId:"1",messageDate:"2026-07-31T23:59:59Z"}),false);
  assert.equal(telegram.telegramBindingAcceptsMessage({historyMode:"from_date",historyFrom:"2026-08-01T00:00:00Z",boundAtMessageId:""},{messageId:"2",messageDate:"2026-08-01T00:00:00Z"}),true);
});

test("历史与范围读取不会推进连续增量检查点",()=>{
  const history=telegram.telegramSyncCheckpointPlan({mode:"history",checkpoint:500,latestRemoteMessageId:700,messageIds:["100","120"],hasMore:true});
  assert.equal(history.nextCheckpoint,500);assert.equal(history.historyCursor,100);assert.equal(history.incrementalCursor,0);
  const range=telegram.telegramSyncCheckpointPlan({mode:"range",checkpoint:500,latestRemoteMessageId:700,messageIds:["450","480"],hasMore:false});
  assert.equal(range.nextCheckpoint,500);
  const incremental=telegram.telegramSyncCheckpointPlan({mode:"incremental",checkpoint:500,latestRemoteMessageId:700,messageIds:["501","502"],hasMore:true});
  assert.equal(incremental.nextCheckpoint,502);assert.equal(incremental.incrementalCursor,502);assert.equal(incremental.targetId,700);
});

test("迁移器识别五类工具、坏日期、不安全 URL 与 CSV 公式样本",()=>{
  const good=migration.validateMigrationRecord({tool:"av123",normalizedValue:"DASS-980",primaryUrl:"https://123av.com/cn/v/dass-980",status:"exported"});
  assert.equal(good.record.primaryValue,"DASS-980");assert.equal(good.record.av123Url,"https://123av.com/cn/v/dass-980");
  assert.equal(migration.validateMigrationRecord({tool:"badnews",normalizedValue:"javascript:alert(1)",primaryUrl:"javascript:alert(1)"}).reason,"不安全 URL");
  assert.equal(migration.validateMigrationRecord({tool:"missav",normalizedValue:"IPX-607",primaryUrl:"https://missav.ai/cn/ipx-607",createdAt:"not-a-date"}).reason,"日期无效");
  const formula=migration.validateMigrationRecord({tool:"twitter",normalizedValue:"=2+5",primaryUrl:"https://x.com/formula_test",tags:["@SUM(A1:A2)"]});
  assert.equal(formula.record.primaryValue,"=2+5");
});
