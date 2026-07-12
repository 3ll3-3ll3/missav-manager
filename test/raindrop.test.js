const test = require('node:test');
const assert = require('node:assert/strict');

const raindrop = require('../src/raindrop');

test('round-trips the official Raindrop CSV columns', () => {
  const records = [{
    raindrop_id: '123', title: 'Title, quoted', note: 'Note', excerpt: 'Excerpt',
    url: 'https://example.com/?a=1&b=2', folder: 'Root / Child', tags: 'alpha,beta',
    created: '2026-07-12T10:00:00.000Z', cover: 'https://example.com/cover.jpg',
    highlights: 'First\nSecond', favorite: true,
  }];
  const parsed = raindrop.parseRaindropCSV(raindrop.generateRaindropCSV(records));
  assert.deepEqual(parsed, records);
});

test('parses and generates nested Raindrop bookmark HTML', () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n<DT><H3 ADD_DATE="1781656556">Root</H3>\n<DL><p>\n<DT><H3>Child</H3>\n<DL><p>\n<DT><A HREF="https://example.com/?a=1&amp;b=2" ADD_DATE="1781656572" LAST_MODIFIED="1781656573" TAGS="alpha,beta" DATA-COVER="cover.jpg" DATA-IMPORTANT="true">A &amp; B</A>\n<DD>Note text\n<DD><blockquote COLOR="undefined" ADD_DATE="1781656573">Highlight</blockquote>\n</DL><p>\n</DL><p>\n</DL><p>`;
  const parsed = raindrop.parseRaindropHTML(html);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].folder, 'Root / Child');
  assert.equal(parsed[0].url, 'https://example.com/?a=1&b=2');
  assert.equal(parsed[0].favorite, true);
  assert.equal(parsed[0].note, 'Note text');
  assert.equal(parsed[0].highlights, 'Highlight');

  const regenerated = raindrop.generateRaindropHTML(parsed);
  assert.match(regenerated, /<H3[^>]*>Root<\/H3>/);
  assert.match(regenerated, /DATA-IMPORTANT="true"/);
  assert.match(regenerated, /<blockquote[^>]*>Highlight<\/blockquote>/);
});
