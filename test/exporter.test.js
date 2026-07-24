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

test('routes genuine page uncertainty to review and excludes network failures', () => {
  const uncertain = exporter.buildOutputRow('ABF-355', 'https://missav.ai/cn/abf-355', 'need_manual_check', [], [], '', '', true);
  const network = exporter.buildOutputRow('ABF-356', 'https://missav.ai/cn/abf-356', 'network_error', [], [], '', 'HTTP 429', false);

  assert.equal(exporter.isManualVerifyRow(uncertain), true);
  assert.equal(exporter.isManualVerifyRow(network), false);
  const html = exporter.generateRaindropHTML([uncertain, network]);
  assert.match(html, /ABF-355/);
  assert.doesNotMatch(html, /ABF-356/);
});

test('builds deterministic tag export groups and safe Windows file names', () => {
  const first = exporter.buildOutputRow('ABF-354', 'https://missav.ai/cn/abf-354', 'ok', ['A'], ['剧情'], ['A', '剧情'], '', true);
  const second = exporter.buildOutputRow('SONE-314', 'https://missav.ai/cn/sone-314', 'ok', ['B'], ['剧情'], ['B', '剧情'], '', true);
  const network = exporter.buildOutputRow('ABF-999', 'https://missav.ai/cn/abf-999', 'network_error', [], [], [], '网络错误', false);
  const groups = exporter.buildTagExportGroups([first, second, network]);

  assert.deepEqual(groups.map(group => [group.tag, group.rows.length]), [['剧情', 2], ['A', 1], ['B', 1]]);
  assert.equal(exporter.safeExportFileName('A/B:*?'), 'A_B___');
  assert.equal(exporter.safeExportFileName('CON'), '_CON');
  const index = exporter.generateTagExportIndexCSV(groups);
  assert.match(index, /"剧情",2,"剧情\.html","剧情\.csv"/);
  assert.doesNotMatch(index, /ABF-999/);
});
