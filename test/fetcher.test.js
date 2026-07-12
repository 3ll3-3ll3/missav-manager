const test = require('node:test');
const assert = require('node:assert/strict');

const fetcher = require('../src/fetcher');

const detailHtml = `
  <html><body>
    <video src="movie.m3u8"></video>
    <a href="/actresses/example"> Example Actress </a>
    <a href="/genres/drama"> Drama </a>
    <a href="/genres/vpn"> VPN </a>
    <p>ABF-354 ${'content '.repeat(30)}</p>
  </body></html>
`;

test('classifies a detail page and extracts clean metadata', () => {
  assert.equal(fetcher.checkPageStatus(detailHtml, 'ABF-354', 'https://missav.ai/cn/abf-354'), 'ok');
  assert.deepEqual(fetcher.extractActressTags(detailHtml), ['Example_Actress']);
  assert.deepEqual(fetcher.extractGenreTags(detailHtml), ['Drama']);
});

test('does not classify short matching content as missing', () => {
  assert.equal(
    fetcher.checkPageStatus('<p>ABF-354</p>', 'ABF-354', 'https://missav.ai/cn/abf-354'),
    'need_manual_check',
  );
});

test('preserves transport errors returned by the main process', async () => {
  const result = await fetcher.fetchPage('https://missav.ai/cn/abf-354', async () => ({
    statusCode: 0,
    body: '',
    finalUrl: 'https://missav.ai/cn/abf-354',
    error: 'network unavailable',
  }));

  assert.equal(result.error, 'network unavailable');
  assert.equal(result.statusCode, 0);
});

test('stops after three redirects', async () => {
  let calls = 0;
  const result = await fetcher.fetchPage('https://missav.ai/cn/abf-354', async url => {
    calls++;
    return { redirected: true, redirectUrl: `${url}?next=${calls}`, statusCode: 302 };
  });

  assert.equal(calls, 4);
  assert.equal(result.error, '重定向次数超过限制');
});
