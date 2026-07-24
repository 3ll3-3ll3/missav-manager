const test = require('node:test');
const assert = require('node:assert/strict');

const telegram = require('../src/telegramSource');
const filters = require('../src/toolboxFilters');

test('extracts Twitter handles in first-seen order and builds x.com profiles', () => {
  const rows = filters.extractTwitterProfiles([
    { text: '昵称 #kechunyaoll 与 @Second_User' },
    { text: '重复 #KECHUNYAOLL https://twitter.com/Third3/status/1' },
    { text: '排除 https://x.com/home 和过长 #abcdefghijklmnop' },
  ]);
  assert.deepEqual(rows, [
    { name: 'kechunyaoll', url: 'https://x.com/kechunyaoll' },
    { name: 'Second_User', url: 'https://x.com/Second_User' },
    { name: 'Third3', url: 'https://x.com/Third3' },
  ]);
});

test('keeps only canonical Bad.news post links and removes app links', () => {
  const links = filters.extractBadNewsLinks(`
    https://bad.news/app
    https://bad.news/t/6295976
    https://www.bad.news/t/6295976?from=telegram
    http://bad.news/t/6295984#comments
    https://bad.news/
  `);
  assert.deepEqual(links, [
    'https://bad.news/t/6295976',
    'https://bad.news/t/6295984',
  ]);
});

test('Telegram HTML dates normalize correctly and filter to the selected minute', () => {
  const html = `
    <div class="message default clearfix" id="message1">
      <div class="pull_right date details" title="01.07.2026 00:08:03 UTC+08:00"></div>
      <div class="text">#first_user https://bad.news/t/1</div>
    </div>
    <div class="message default clearfix" id="message2">
      <div class="pull_right date details" title="01.07.2026 00:18:59 UTC+08:00"></div>
      <div class="text">#second_user https://bad.news/t/2</div>
    </div>
    <div class="message default clearfix" id="message3">
      <div class="pull_right date details" title="01.07.2026 00:19:00 UTC+08:00"></div>
      <div class="text">#third_user https://bad.news/t/3</div>
    </div>`;
  const messages = telegram.parseTelegramHtml(html);
  assert.equal(messages[0].messageDate, '2026-06-30T16:08:03.000Z');
  assert.deepEqual(
    filters.extractTwitterProfiles(messages, { start: '2026-07-01T00:08', end: '2026-07-01T00:18' }).map(row => row.name),
    ['first_user', 'second_user'],
  );
  assert.deepEqual(
    filters.extractBadNewsLinks(messages, { start: '2026-07-01T00:18', end: '2026-07-01T00:18' }),
    ['https://bad.news/t/2'],
  );
});

test('messages without a timestamp remain eligible for manual text input', () => {
  const rows = filters.filterMessagesByTime([{ text: '#manual_name', messageDate: '' }], {
    start: '2026-07-01T00:00',
    end: '2026-07-01T01:00',
  });
  assert.equal(rows.length, 1);
  const telegramRows = filters.filterMessagesByTime([
    { text: '#service_message', messageDate: '', sourceType: 'export_html' },
  ], {
    start: '2026-07-01T00:00',
    end: '2026-07-01T01:00',
  });
  assert.equal(telegramRows.length, 0);
});
