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

test('learns Twitter profile tags from the supplied Telegram export structure without promotional false positives', () => {
  const rows = filters.extractTwitterProfiles([
    { text: '𝓊𝓃𝒹𝓇ℯ𝓈𝓈 #kechunyaoll' },
    { text: '困困熊 #milkooyy #mistedoll #wink_xc 完整版' },
    { text: '蛇💫\n #xxxxshe0\n\nWataa💦💦\n #黑丝 #jk' },
    { text: '传送门\n #chuansongmen520\n\n在下咪任缝！ 博主：\n @m1stedoll' },
    { text: '哼哼nn\n @OuOpyhh\n\n法修散打' },
    { text: '24小时机器人自助进群\n @haha6693_bot\n频道随时有可能被封禁' },
  ]);
  assert.deepEqual(rows, [
    { name: 'kechunyaoll', url: 'https://x.com/kechunyaoll' },
    { name: 'milkooyy', url: 'https://x.com/milkooyy' },
    { name: 'mistedoll', url: 'https://x.com/mistedoll' },
    { name: 'wink_xc', url: 'https://x.com/wink_xc' },
    { name: 'xxxxshe0', url: 'https://x.com/xxxxshe0' },
    { name: 'm1stedoll', url: 'https://x.com/m1stedoll' },
    { name: 'OuOpyhh', url: 'https://x.com/OuOpyhh' },
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

test('keeps only canonical Haijiao content posts and removes ads, index pages, and unrelated hosts', () => {
  const rows = filters.extractHaijiaoLinks([
    {
      text: [
        '嫂子内容 https://www.haijiaolove.xyz/hjsz/127766.html',
        '姐弟内容 http://haijiaolove.xyz/hjjd/58198.html?from=tg#video',
        '搜索广告 https://t.me/jisou?start=a_2110726373',
      ].join('\n'),
      links: [
        'https://www.haijiaolove.xyz/hjsz/127766.html',
        'https://www.haijiaolove.xyz/jdsp',
      ],
    },
    {
      text: [
        '栏目页 https://www.haijiaolove.xyz/original',
        '旧站 https://haijiao.com/post/details?pid=123',
        '伪装域名 https://www.haijiaolove.xyz.evil.example/hjsz/999.html',
        '母子内容 https://www.haijiaolove.xyz/hjmz/58488.html/',
      ].join('\n'),
    },
  ]);
  assert.deepEqual(rows, [
    'https://www.haijiaolove.xyz/hjsz/127766.html',
    'https://www.haijiaolove.xyz/hjjd/58198.html',
    'https://www.haijiaolove.xyz/hjmz/58488.html',
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
  assert.deepEqual(
    filters.extractHaijiaoLinks([
      { ...messages[0], text: 'https://www.haijiaolove.xyz/hjjd/101.html' },
      { ...messages[1], text: 'https://www.haijiaolove.xyz/hjsz/102.html' },
      { ...messages[2], text: 'https://www.haijiaolove.xyz/hjmz/103.html' },
    ], { start: '2026-07-01T00:18', end: '2026-07-01T00:18' }),
    ['https://www.haijiaolove.xyz/hjsz/102.html'],
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
