const test = require('node:test');
const assert = require('node:assert/strict');

const csvTools = require('../src/csvTools');

test('round-trips quoted CSV values and duplicate headers', () => {
  const parsed = csvTools.parseCSV('\ufeffcode,note,note\r\nABF-354,"line 1\nline 2","a ""quote"""');
  assert.deepEqual(parsed.headers, ['code', 'note', 'note_2']);
  assert.deepEqual(parsed.rows, [['ABF-354', 'line 1\nline 2', 'a "quote"']]);

  const reparsed = csvTools.parseCSV(csvTools.stringifyCSV(parsed.headers, parsed.rows));
  assert.deepEqual(reparsed, parsed);
});

test('reports each row in a duplicate group once and keeps issueCount accurate', () => {
  const analysis = csvTools.analyzeCSV(
    ['code', 'url'],
    [
      ['ABF-354', 'https://missav.ai/cn/abf-354'],
      ['ABF354', 'https://missav.ai/cn/abf-354'],
      ['abf-354', 'https://missav.ai/cn/abf-354'],
    ],
  );

  const duplicates = analysis.issues.filter(issue => issue.type === 'duplicate_code');
  assert.equal(duplicates.length, 3);
  assert.deepEqual(duplicates.map(issue => issue.row).sort(), [0, 1, 2]);
  assert.equal(analysis.issueCount, analysis.issues.length);
});

test('repairs unquoted multiline fields in official Raindrop exports', () => {
  const text = [
    'id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite',
    '123,Title,Note,First excerpt line',
    '',
    'Second excerpt line,https://example.com,Root,"alpha,beta",2026-07-12T10:00:00.000Z,,,false',
    '124,Next title,,,https://example.org,Archive,,2026-07-12T11:00:00.000Z,,,true',
  ].join('\r\n');
  const parsed = csvTools.parseCSV(text);

  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0][3], 'First excerpt line\n\nSecond excerpt line');
  assert.equal(parsed.rows[0][4], 'https://example.com');
  assert.equal(parsed.rows[0][6], 'alpha,beta');
  assert.equal(parsed.rows[0][10], 'false');
  assert.equal(parsed.rows[1][0], '124');
});
