const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const database = require('../src/database');
const { parseTelegramJson, telegramApiMessagesToEnvelopes } = require('../src/telegramSource');

test('persists Telegram checkpoints and deduplicates API and export messages without storing full text', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'missav-manager-telegram-db-'));
  t.after(() => {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await database.init(dir);
  const sourceKey = 'telegram-api:42:group:-1001001';
  let selected = database.setTelegramGroupSources({
    accountKey: '42',
    accountLabel: 'Test Account',
    groups: [{
      chatKey: '-1001001',
      title: '番号收集群',
      chatType: 'supergroup',
      latestMessageId: 99,
      latestMessageDate: '2026-07-19T23:59:00Z',
    }],
  });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].baselineMessageId, 99);
  assert.equal(selected[0].checkpointMessageId, 99);
  assert.equal(selected[0].isSelected, true);

  const exported = parseTelegramJson({
    personal_information: { user_id: 42 },
    chats: { list: [{
      name: '番号收集群',
      type: 'private_supergroup',
      id: -1001001,
      messages: [
        { id: 100, date: '2026-07-20T00:00:00Z', text: 'SSIS-469' },
        { id: 101, date: '2026-07-20T00:01:00Z', text: 'SONE-314' },
      ],
    }] },
  });
  const first = database.recordTelegramImport({
    sourceKey: 'telegram-export:test-group',
    sourceType: 'export_json',
    sourceLabel: '番号收集群',
    accountKey: '42',
    messages: exported,
  });
  assert.equal(first.newMessageCount, 2);
  assert.equal(first.duplicateMessageCount, 0);
  assert.equal(first.codeCount, 2);
  assert.equal(first.source.checkpointMessageId, 101);

  const api = telegramApiMessagesToEnvelopes([
    { id: 100, date: new Date('2026-07-20T00:00:00Z'), message: 'SSIS-469' },
    { id: 101, date: new Date('2026-07-20T00:01:00Z'), message: 'SONE-314' },
  ], { accountKey: '42', chatKey: '-1001001', sourceLabel: '番号收集群' });
  const second = database.recordTelegramImport({
    sourceKey,
    sourceType: 'api_group',
    sourceLabel: '番号收集群',
    accountKey: '42',
    chatKey: '-1001001',
    chatType: 'supergroup',
    isSelected: true,
    messages: api,
  });
  assert.equal(second.newMessageCount, 0);
  assert.equal(second.duplicateMessageCount, 2);
  assert.equal(second.codeCount, 0);
  assert.deepEqual(second.codes, []);
  assert.equal(second.observedCodeCount, 2);

  const edited = telegramApiMessagesToEnvelopes([
    { id: 101, date: new Date('2026-07-20T00:01:00Z'), editDate: new Date('2026-07-21T00:00:00Z'), message: 'SONE-315' },
  ], { accountKey: '42', chatKey: '-1001001', sourceLabel: '番号收集群' });
  const third = database.recordTelegramImport({
    sourceKey,
    sourceType: 'api_group',
    sourceLabel: '番号收集群',
    accountKey: '42',
    messages: edited,
  });
  assert.equal(third.updatedMessageCount, 1);
  assert.deepEqual(third.codes, ['SONE-315']);

  const partial = database.recordTelegramImport({
    sourceKey,
    sourceType: 'api_group',
    sourceLabel: '番号收集群',
    accountKey: '42',
    checkpointMessageId: 101,
    checkpointComplete: false,
    syncCursorMessageId: 108,
    syncTargetMessageId: 110,
    messages: telegramApiMessagesToEnvelopes([
      { id: 110, date: new Date('2026-07-22T00:10:00Z'), message: 'ABF-354' },
      { id: 109, date: new Date('2026-07-22T00:09:00Z'), message: 'GVH-842' },
      { id: 108, date: new Date('2026-07-22T00:08:00Z'), message: 'ROYD-110' },
    ], { accountKey: '42', chatKey: '-1001001', sourceLabel: '番号收集群' }),
  });
  assert.equal(partial.checkpointComplete, false);
  assert.equal(partial.source.checkpointMessageId, 101);
  assert.equal(partial.source.syncCursorMessageId, 108);
  assert.equal(partial.source.syncTargetMessageId, 110);

  const completed = database.recordTelegramImport({
    sourceKey,
    sourceType: 'api_group',
    sourceLabel: '番号收集群',
    accountKey: '42',
    checkpointMessageId: 110,
    checkpointComplete: true,
    messages: telegramApiMessagesToEnvelopes([
      { id: 107, date: new Date('2026-07-22T00:07:00Z'), message: 'SSIS-470' },
    ], { accountKey: '42', chatKey: '-1001001', sourceLabel: '番号收集群' }),
  });
  assert.equal(completed.source.checkpointMessageId, 110);
  assert.equal(completed.source.syncCursorMessageId, 0);
  assert.equal(completed.source.syncTargetMessageId, 0);
  database.setTelegramGroupSources({ accountKey: '42', groups: [] });
  assert.equal(database.getTelegramGroupSources('42').length, 0);
  selected = database.setTelegramGroupSources({
    accountKey: '42',
    groups: [{
      chatKey: '-1001001',
      title: '番号收集群（改名）',
      chatType: 'supergroup',
      latestMessageId: 999,
    }],
  });
  assert.equal(selected[0].baselineMessageId, 99);
  assert.equal(selected[0].checkpointMessageId, 110);
  assert.equal(selected[0].sourceLabel, '番号收集群（改名）');
  assert.throws(() => database.setTelegramGroupSources({
    accountKey: '42',
    groups: Array.from({ length: 6 }, (_value, index) => ({
      chatKey: String(index + 1),
      title: `群 ${index + 1}`,
    })),
  }), /最多只能选择 5 个/);

  const botGroups = database.setTelegramGroupSources({
    accountKey: 'bot:123456789',
    accountLabel: '@collector_bot',
    sourceType: 'bot_group',
    groups: [{
      chatKey: '-1002002',
      title: '机器人番号群',
      chatType: 'supergroup',
      latestMessageId: 7,
    }],
  });
  assert.equal(botGroups[0].sourceType, 'bot_group');
  assert.equal(botGroups[0].sourceKey, 'telegram-bot:bot:123456789:group:-1002002');
  assert.equal(botGroups[0].baselineMessageId, 7);
  assert.equal(database.getTelegramGroupSources('42').length, 1);
  assert.equal(database.getTelegramGroupSources('bot:123456789', true, 'bot_group').length, 1);
  assert.equal(database.getTelegramGroupSources('bot:123456789', true, 'api_group').length, 0);

  const raw = database.getRawTableRows('telegram_message_refs', { limit: 10 });
  assert.equal(raw.total, 6);
  assert.equal(raw.columns.includes('text'), false);
  assert.equal(raw.columns.includes('content_hash'), true);
  assert.equal(database.getTelegramImportHistory(10).length, 5);
});
