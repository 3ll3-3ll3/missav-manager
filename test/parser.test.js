const test = require('node:test');
const assert = require('node:assert/strict');

const parser = require('../src/parser');

test('normalizes standard and FC2 codes', () => {
  assert.equal(parser.normalizeCode('abf354'), 'ABF-354');
  assert.equal(parser.normalizeCode('FC2 4625027'), 'FC2-PPV-4625027');
  assert.equal(
    parser.normalizeCode('https://missav.ai/dm96/cn/FC2-4625027'),
    'FC2-PPV-4625027',
  );
});

test('extracts codes in source order while filtering common HTML noise', () => {
  const input = `
    <div id="message14298">ABF-354</div>
    https://missav.ai/cn/sone-314-chinese-subtitle
    FC2 PPV 4625027
    <span class="media_video">ABF354</span>
  `;

  assert.deepEqual(parser.parseCodeList(input), [
    'ABF-354',
    'SONE-314',
    'FC2-PPV-4625027',
  ]);
});

test('generates unique candidate URLs for a normalized code', () => {
  const urls = parser.candidateUrls('ABF354');
  assert.equal(urls[0], 'https://missav.ai/cn/abf-354');
  assert.equal(new Set(urls).size, urls.length);
});

test('ignores ordinary web URLs and image asset names while accepting trusted AV URLs', () => {
  const input = `
    https://hostloc.com/thread-1285447-1-1.html
    https://example.com/assets/mark_1232.jpg
    https://docs.github.com/assets/cb-345/images/copilot.png
    https://123av.com/cn/v/393otim-648-uncensored-leaked
    https://missav.ai/cn/ofes-022-uncensored-leak
  `;
  assert.deepEqual(parser.parseCodeList(input), ['OTIM-648', 'OFES-022']);
});

test('accepts the MissAV ws mirror and ignores Telegram media dimensions and file sizes', () => {
  const input = `
    <div class="status details">800×540, 161.2 KB</div>
    <div class="status details">90x122, 1.4 MB</div>
    <a href="https://missav.ws/fft-041-uncensored-leak?utm_source=telegram">详情</a>
    <a href="https://missav.ws/best-004">可信详情页中的特殊前缀</a>
  `;
  assert.deepEqual(parser.parseCodeList(input), ['FFT-041', 'BEST-004']);
  assert.deepEqual(parser.parseCodeList('真正的独立番号 KB-123'), ['KB-123']);
});

test('rejects common product, course, media and website version tokens', () => {
  assert.deepEqual(parser.parseCodeList('PDF24 Office 365 Java 11 IEOR 6711 Fall 2013 RJ01393321 PRO-18 YOUPORN-51 TV-20 TV-1920'), []);
  assert.deepEqual(parser.parseCodeList('CHANNEL\n23:15\nABF\n369'), []);
});

test('rejects Telegram site, date, time, age and suffix noise while keeping nearby real codes', () => {
  const input = `
    Whos.tv 17.07.2026 00:50:02
    View Results Page Powered by Whos.tv 23:19
    MissAV Daily 16.07.2026 14:22:16
    ▶️ SIRO-5690-UNCENSORED-LEAK 13:48
    KNMB-026 完全生猛风格 @ Miiro 18岁
    OPKT-037 禁忌怀孕 Ayami 23岁
    MIDE-589 MARRION 16分钟前
    DVAJ-609 アリスJAPAN 13分钟前
    鲍鱼云 @baoyuyun 24.06.2026 名称: MIFD-070
    OPEN-0604 正规影片标题
  `;
  assert.deepEqual(parser.parseCodeList(input), [
    'SIRO-5690',
    'KNMB-026',
    'OPKT-037',
    'MIDE-589',
    'DVAJ-609',
    'MIFD-070',
    'OPEN-0604',
  ]);
});
