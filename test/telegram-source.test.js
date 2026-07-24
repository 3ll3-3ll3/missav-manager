const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTelegramJson,
  parseTelegramHtml,
  telegramApiMessagesToEnvelopes,
  mergeTelegramEnvelopes,
  parseTelegramExportFiles,
} = require('../src/telegramSource');

test('parses Telegram Desktop JSON group history and ignores personal and Saved Messages in account exports', () => {
  const payload = {
    personal_information: { user_id: 778899 },
    chats: {
      list: [
        {
          name: '番号收集群',
          type: 'private_supergroup',
          id: -100778899,
          messages: [
            {
              id: 101,
              date: '2026-07-20T12:00:00',
              text: ['想看 ', { type: 'bold', text: 'SSIS-469' }, ' ', { type: 'link', text: '详情', href: 'https://missav.ai/cn/ssis-469' }],
            },
            {
              id: 102,
              date: '2026-07-20T12:01:00',
              text: '普通聊天 Office 365 message14298',
            },
          ],
        },
        {
          name: 'Saved Messages',
          type: 'saved_messages',
          messages: [{ id: 3, date: '2026-07-20T12:03:00', text: 'DASS-720' }],
        },
        {
          name: 'Other Chat',
          type: 'personal_chat',
          messages: [{ id: 1, date: '2026-07-20T12:02:00', text: 'ABF-354' }],
        },
      ],
    },
  };

  const messages = parseTelegramJson(payload);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].accountKey, '778899');
  assert.equal(messages[0].chatKey, '-100778899');
  assert.equal(messages[0].sourceLabel, '番号收集群');
  assert.deepEqual(messages[0].codes, ['SSIS-469']);
  assert.deepEqual(messages[1].codes, []);
  assert.equal(messages.some(row => row.codes.includes('ABF-354')), false);
  assert.equal(messages.some(row => row.codes.includes('DASS-720')), false);
  assert.equal(messages[0].text.includes('想看 SSIS-469'), true);
});

test('parses Telegram HTML messages into stable message envelopes', () => {
  const html = `
    <div class="message default clearfix" id="message501">
      <div class="pull_right date details" title="20.07.2026 12:00:00 UTC+08:00">12:00</div>
      <div class="text">番号 <a href="https://123av.com/cn/v/abf-354">ABF-354</a></div>
    </div>
    <div class="message default clearfix" id="message502">
      <div class="pull_right date details" title="20.07.2026 12:01:00 UTC+08:00">12:01</div>
      <div class="text">下一条 SONE-314</div>
    </div>`;

  const messages = parseTelegramHtml(html, { sourceLabel: 'messages.html' });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].messageId, '501');
  assert.deepEqual(messages[0].codes, ['ABF-354']);
  assert.deepEqual(messages[1].codes, ['SONE-314']);
  assert.equal(messages[0].sourceLabel, 'messages.html');
});

test('deduplicates the same group message across API and JSON import', () => {
  const api = telegramApiMessagesToEnvelopes([
    { id: 9001, date: new Date('2026-07-21T08:00:00Z'), message: 'JUQ-999 https://123av.com/cn/v/juq-999' },
  ], { accountKey: '42', chatKey: '-100200', sourceLabel: '番号群' });
  const json = parseTelegramJson({
    personal_information: { user_id: 42 },
    chats: { list: [{
      name: '番号群',
      type: 'private_supergroup',
      id: -100200,
      messages: [
        { id: 9001, date: '2026-07-21T08:00:00Z', text: 'JUQ-999 https://123av.com/cn/v/juq-999' },
      ],
    }] },
  });

  const merged = mergeTelegramEnvelopes([...json, ...api]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sourceType, 'mixed');
  assert.deepEqual(merged[0].codes, ['JUQ-999']);
});

test('collects per-file parse errors without losing valid Telegram exports', () => {
  const result = parseTelegramExportFiles([
    {
      path: 'result.json',
      content: JSON.stringify({ messages: [{ id: 1, date: '2026-07-21T00:00:00Z', text: 'DASS-720' }] }),
    },
    { path: 'broken.json', content: '{not-json' },
    { path: 'messages.html', content: '<div class="message" id="message2"><div class="text">GVH-842</div></div>' },
  ]);

  assert.equal(result.messages.length, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].file, 'broken.json');
  assert.deepEqual(result.messages.flatMap(row => row.codes).sort(), ['DASS-720', 'GVH-842']);
});
