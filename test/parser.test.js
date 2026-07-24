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

test('rejects common product, course and website version tokens', () => {
  assert.deepEqual(parser.parseCodeList('PDF24 Office 365 Java 11 IEOR 6711 Fall 2013 RJ01393321'), []);
});
