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

test('does not use the candidate URL alone as code evidence', () => {
  const genericHtml = `<html><body><h1>MissAV</h1><p>${'generic page '.repeat(30)}</p></body></html>`;
  assert.equal(
    fetcher.checkPageStatus(genericHtml, 'ABF-354', 'https://missav.ai/cn/abf-354'),
    'not_found',
  );
});

test('classifies access challenges and rate limits as network errors', () => {
  assert.equal(
    fetcher.checkPageStatus('<html><title>Just a moment...</title><div class="cf-chl-verify">Verify you are human</div></html>', 'ABF-354', 'https://missav.ai/cn/abf-354'),
    'network_error',
  );
  assert.deepEqual(
    fetcher.classifyCandidateResponse({ statusCode: 429, body: 'Too Many Requests', finalUrl: 'https://missav.ai/cn/abf-354' }, 'ABF-354'),
    {
      status: 'network_error',
      url: 'https://missav.ai/cn/abf-354',
      html: '',
      statusCode: 429,
      error: 'HTTP 429',
    },
  );
});

test('does not mistake captcha scripts on a real detail page for a challenge', () => {
  const htmlWithCaptchaScript = detailHtml.replace(
    '</body>',
    '<script src="/cdn-cgi/challenge-platform/scripts/captcha-loader.js"></script></body>',
  );
  assert.equal(
    fetcher.checkPageStatus(htmlWithCaptchaScript, 'ABF-354', 'https://missav.ai/cn/abf-354'),
    'ok',
  );
  assert.equal(fetcher.detectAccessChallenge(htmlWithCaptchaScript, 'ABF-354'), '');
});

test('keeps standalone captcha and access denial pages as network errors', () => {
  const captchaPage = `<html><title>Security check</title><form class="captcha-form">Captcha required</form>${'blocked '.repeat(30)}</html>`;
  assert.equal(
    fetcher.checkPageStatus(captchaPage, 'ABF-354', 'https://missav.ai/cn/abf-354'),
    'network_error',
  );
  assert.equal(fetcher.detectAccessChallenge(captchaPage, 'ABF-354'), 'captcha');
});

test('stops candidate search after any confirmed detail page', () => {
  assert.equal(fetcher.shouldStopCandidateSearch('ok'), true);
  assert.equal(fetcher.shouldStopCandidateSearch('no_actress_found'), true);
  assert.equal(fetcher.shouldStopCandidateSearch('page_ok_play_unknown'), true);
  assert.equal(fetcher.shouldStopCandidateSearch('need_manual_check'), false);
  assert.equal(fetcher.shouldStopCandidateSearch('network_error'), false);
  assert.equal(fetcher.shouldStopCandidateSearch('not_found'), false);
});

test('resolves candidates without inflating manual verification', () => {
  const missing = fetcher.resolveCandidateAttempts([
    { status: 'not_found', url: 'https://missav.ai/cn/abf-354', html: '', statusCode: 404, error: '' },
    { status: 'not_found', url: 'https://missav.ai/dm89/cn/ABF-354', html: '<html>generic</html>', statusCode: 200, error: '' },
  ]);
  assert.equal(missing.status, 'not_found');

  const network = fetcher.resolveCandidateAttempts([
    { status: 'not_found', url: 'https://missav.ai/cn/abf-354', html: '', statusCode: 404, error: '' },
    { status: 'network_error', url: 'https://missav.ai/cn/abf-354-chinese-subtitle', html: '', statusCode: 403, error: 'HTTP 403' },
  ]);
  assert.equal(network.status, 'network_error');

  const verified = fetcher.resolveCandidateAttempts([
    { status: 'need_manual_check', url: 'manual', html: '<p>ABF-354</p>', statusCode: 200, error: '' },
    { status: 'ok', url: 'detail', html: detailHtml, statusCode: 200, error: '' },
  ]);
  assert.equal(verified.status, 'ok');
  assert.equal(verified.url, 'detail');
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
  const timeouts = [];
  const result = await fetcher.fetchPage('https://missav.ai/cn/abf-354', async (url, options) => {
    calls++;
    timeouts.push(options.timeout);
    return { redirected: true, redirectUrl: `${url}?next=${calls}`, statusCode: 302 };
  }, { timeout: 12000 });

  assert.equal(calls, 4);
  assert.deepEqual(timeouts, [12000, 12000, 12000, 12000]);
  assert.equal(result.error, '重定向次数超过限制');
});
