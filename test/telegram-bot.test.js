const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeBotToken,
  redactBotSecrets,
  parseBotUpdates,
  TelegramBotService,
} = require('../src/telegramBot');

const TEST_TOKEN = '123456789:AAExampleBotToken_abcdefghijklmnopqrstuvwxyz';

test('validates and redacts Telegram Bot tokens', () => {
  assert.equal(normalizeBotToken(` ${TEST_TOKEN} `), TEST_TOKEN);
  assert.throws(() => normalizeBotToken('not-a-token'), /格式无效/);
  assert.doesNotMatch(redactBotSecrets(`request https://api.telegram.org/bot${TEST_TOKEN}/getMe failed`, TEST_TOKEN), /AAExample/);
});

test('converts group Bot API updates into stable message envelopes and ignores private chats', () => {
  const parsed = parseBotUpdates([
    {
      update_id: 101,
      message: {
        message_id: 10,
        date: 1784780000,
        chat: { id: -100200300, type: 'supergroup', title: '番号收集群', username: 'codes_group' },
        text: '今天收藏 SSIS-123、ABW-001 https://example.com/info',
        entities: [{ type: 'url', offset: 23, length: 24 }],
      },
    },
    {
      update_id: 102,
      edited_message: {
        message_id: 10,
        date: 1784780000,
        edit_date: 1784780100,
        chat: { id: -100200300, type: 'supergroup', title: '番号收集群' },
        text: '今天收藏 SSIS-124',
      },
    },
    {
      update_id: 103,
      channel_post: {
        message_id: 88,
        date: 1784780200,
        chat: { id: -100900800, type: 'channel', title: '番号频道' },
        caption: '新片 MIDV-777',
        caption_entities: [{ type: 'text_link', offset: 0, length: 2, url: 'https://missav.ai/cn/midv-777' }],
      },
    },
    {
      update_id: 104,
      message: {
        message_id: 1,
        date: 1784780300,
        chat: { id: 42, type: 'private', first_name: 'Private' },
        text: 'IPX-999',
      },
    },
  ], { accountKey: 'bot:123456789' });

  assert.equal(parsed.updateCount, 4);
  assert.equal(parsed.lastUpdateId, 104);
  assert.equal(parsed.nextOffset, 105);
  assert.equal(parsed.groups.length, 2);
  const group = parsed.messageGroups.find(row => row.chatKey === '-100200300');
  assert.equal(group.messages.length, 2);
  assert.deepEqual(group.messages[0].codes, ['SSIS-123', 'ABW-001']);
  assert.deepEqual(group.messages[1].codes, ['SSIS-124']);
  assert.equal(group.messages[0].dedupeKey, 'telegram:bot:123456789:-100200300:10');
  const channel = parsed.messageGroups.find(row => row.chatKey === '-100900800');
  assert.deepEqual(channel.messages[0].codes, ['MIDV-777']);
  assert.deepEqual(channel.messages[0].links, ['https://missav.ai/cn/midv-777']);
});

test('connects, securely stores and fetches Bot API updates without logging the token', async () => {
  let stored = null;
  const logs = [];
  const requests = [];
  const service = new TelegramBotService({
    readSecret: () => stored,
    writeSecret: value => { stored = { ...value }; },
    clearSecret: () => { stored = null; },
    request: async (method, payload, token) => {
      requests.push({ method, payload, token });
      if (method === 'getMe') {
        return { id: 123456789, is_bot: true, first_name: 'Collector', username: 'collector_bot' };
      }
      return [{
        update_id: 9,
        message: {
          message_id: 3,
          date: 1784780000,
          chat: { id: -10022, type: 'group', title: '测试群' },
          text: 'SONE-100',
        },
      }];
    },
    log: (level, event, data) => logs.push({ level, event, data }),
  });

  const connected = await service.connect(TEST_TOKEN);
  assert.equal(connected.status, 'ready');
  assert.equal(connected.accountKey, 'bot:123456789');
  assert.equal(stored.token, TEST_TOKEN);
  const result = await service.getUpdates({ offset: 5, limit: 50 });
  assert.equal(result.updateCount, 1);
  assert.equal(result.messageGroups[0].messages[0].codes[0], 'SONE-100');
  assert.equal(requests[1].payload.offset, 5);
  assert.equal(requests[1].payload.timeout, 0);
  assert.doesNotMatch(JSON.stringify(logs), /AAExampleBotToken/);

  service.clear();
  assert.equal(stored, null);
  assert.equal(service.status().configured, false);
});

test('redacts a Bot Token included in transport errors', async () => {
  const service = new TelegramBotService({
    readSecret: () => null,
    writeSecret: () => {},
    request: async () => {
      throw new Error(`fetch https://api.telegram.org/bot${TEST_TOKEN}/getMe failed`);
    },
  });
  await assert.rejects(() => service.connect(TEST_TOKEN), error => {
    assert.doesNotMatch(error.message, /AAExampleBotToken/);
    return true;
  });
});
