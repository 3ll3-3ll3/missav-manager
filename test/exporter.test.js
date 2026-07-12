const test = require('node:test');
const assert = require('node:assert/strict');

const exporter = require('../src/exporter');

test('escapes bookmark HTML and separates not-found rows', () => {
  const ok = exporter.buildOutputRow('ABF-354', 'https://missav.ai/cn/abf-354?a=1&b=2', 'ok', ['A'], ['Drama'], 'A', '', true);
  ok.title = '<Title>';
  const missing = exporter.buildOutputRow('SONE-314', 'https://missav.ai/cn/sone-314', 'not_found', [], [], '', '', true);

  const html = exporter.generateRaindropHTML([ok, missing]);
  assert.match(html, /&lt;Title&gt;/);
  assert.match(html, /a=1&amp;b=2/);
  assert.match(html, /<H3>需要手动核验<\/H3>/);
  assert.deepEqual(missing.finalTags, ['#未知女优', '需要查找']);
});
