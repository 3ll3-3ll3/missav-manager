const test = require('node:test');
const assert = require('node:assert/strict');

const { parseInputCodeList } = require('../src/inputExtractor');

test('extracts Raindrop CSV codes from meaningful columns and trusted context only', () => {
  const csv = `id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite
1,"GOSE product",,,https://example.com/page,臀模,,2026-01-01,https://example.com/fill_mark_1232.jpg,,false
2,"Sivr 336 #1",,"Video Sivr 336 #1 HQ",https://example.com/watch/123,日本av,,2026-01-01,https://example.com/logo_300.png,,false
3,"Office 365 教程",,,https://example.com/office,学习,,2026-01-01,https://example.com/office_365.png,,false
4,"ABF-356",,,https://123av.com/cn/v/abf-356-uncensored-leaked,日本av,,2026-01-01,https://cdn.example.com/cover.webp,,false
5,"MIUM-1047",,,https://missav.ai/cn/mium-1047-uncensored-leak,MissAV_Import,,2026-01-01,https://cdn.example.com/cover.webp,,false`;

  assert.deepEqual(parseInputCodeList(csv), ['SIVR-336', 'ABF-356', 'MIUM-1047']);
});

test('does not treat promotional tokens inside Raindrop excerpts as codes', () => {
  const csv = `id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite
1,MIDE-767,,"[MOODYZ Campaign 30% OFF]",https://missav.ai/cn/mide-767,日本av,,2026-01-01,https://example.com/cover.jpg,,false
2,ABW-216,,"Prestige 20 周年特别企划",https://missav.ai/cn/abw-216,日本av,,2026-01-01,https://example.com/cover.jpg,,false`;
  assert.deepEqual(parseInputCodeList(csv), ['MIDE-767', 'ABW-216']);
});

test('replays the 59-row user feedback classification without losing confirmed JAV codes', () => {
  const confirmed = ['SIVR-336', 'OFJE-473', 'OFJE-357', 'NSPS-234', 'OFES-022', 'ABF-356', 'JUVR-294', 'KIWVR-849', 'NAMHVR-002', 'OTIM-648', 'SAVR-1069', 'VRKM-1654', 'MIUM-1047'];
  const rejected = [
    'MARK-1232', 'LARGE-301944', 'XV-10', 'ALL-18', 'TMYX-019', 'THREAD-1285447', 'XIUREN-2024', 'NO-8633',
    'PDF-24', 'TELEGRAM-18', 'RJ-01114383', 'LOGO-128', 'JOHREN-18', 'RJ-01393321', 'IEOR-6711', 'FALL-2013',
    'DG-2017', 'PROBABILITY-70', 'STATISTICS-251', 'SPRING-2013', 'PYTHON-100', 'THREAD-1802960', 'OF-21', 'CB-345',
    'RELATED-2479604', 'WXSYNC-2024', 'TPS-128', 'OFFICE-365', 'QQ-44866828', 'GITHUB-2406', 'SERIES-15', 'PRO-18',
    'WEIXIN-40425640', 'TS-12434', 'RESULT-2023', 'TPS-640', 'WEIXIN-37737254', 'QQ-38869359', 'VW-01', 'TPS-110',
    'QQ-22163371', 'LOGO-300', 'POST-247662', 'TS-4646', 'JAVA-11', 'LOGO-192',
  ];
  const header = 'id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite';
  const confirmedRows = confirmed.map((code, index) => `${index + 1},${code},,,https://123av.com/cn/v/${code.toLowerCase()},日本av,,2026-01-01,https://cdn.example.com/cover.webp,,false`);
  const rejectedRows = rejected.map((code, index) => `${index + 100},"普通资料 ${code}",,,https://example.com/thread/${code.toLowerCase()},学习资料,,2026-01-01,https://example.com/assets/${code.toLowerCase()}.jpg,,false`);
  const csv = [header, ...confirmedRows, ...rejectedRows].join('\n');

  assert.deepEqual(parseInputCodeList(csv), confirmed);
});
