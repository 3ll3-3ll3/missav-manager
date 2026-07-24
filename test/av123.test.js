const test = require('node:test');
const assert = require('node:assert/strict');

const av123 = require('../src/av123');

const searchPage = `<!doctype html><html><head><title>Search: ABF-356 — 123AV</title></head><body>
  <main>
    <h1>Search: ABF-356</h1><div>977个视频</div>
    <h3 class="card__title"><a class="card__link" href="/cn/v/flav-356">FLAV-356 — fuzzy result</a></h3>
    <h3 class="card__title"><a class="card__link" href="/cn/v/abf-356-uncensored-leaked">ABF-356-Uncensored-Leaked — alternate</a></h3>
    <h3 class="card__title"><a class="card__link" href="/cn/v/abf-356">ABF-356 — exact result</a></h3>
  </main>
</body></html>`;

test('builds an encoded read-only search URL', () => {
  assert.equal(av123.buildSearchUrl('abf356'), 'https://123av.com/cn/search?keyword=ABF-356');
  assert.equal(av123.buildDetailUrl('abf356'), 'https://123av.com/cn/v/abf-356');
  assert.deepEqual(av123.buildDetailCandidateUrls('abf356'), [
    'https://123av.com/cn/v/abf-356',
    'https://123av.com/cn/v/abf-356-uncensored-leaked',
    'https://123av.com/cn/v/abf-356-uncensored-leak',
    'https://123av.com/cn/v/abf-356-chinese-subtitle',
    'https://123av.com/cn/v/abf-356-english-subtitle',
    'https://123av.com/cn/v/abf-356-uncensored',
    'https://123av.com/cn/v/abf-356-leaked',
  ]);
});

test('search classification requires exact card evidence and prefers the base detail URL', () => {
  const result = av123.classifyResponse({
    statusCode: 200,
    body: searchPage,
    finalUrl: 'https://123av.com/cn/search?keyword=ABF-356',
  }, 'ABF-356');

  assert.equal(result.status, 'succeeded');
  assert.equal(result.url, 'https://123av.com/cn/v/abf-356');
  assert.equal(result.metadata.responseKind, 'search');
  assert.equal(result.metadata.candidateCount, 2);
  assert.deepEqual(result.metadata.alternateUrls, ['https://123av.com/cn/v/abf-356-uncensored-leaked']);
});

test('detail response after redirect succeeds only with visible code and detail structure', () => {
  const detailHtml = `<!doctype html><html><head><title>ABF-356 — title — 123AV</title></head><body>
    <main><h1>ABF-356 — title</h1><iframe src="about:blank"></iframe>
      <dl><dt>代码</dt><dd>ABF-356</dd><dt>类别</dt><dd><a href="/cn/genres/drama">Drama</a></dd></dl>
      <aside><a class="card__link" href="/cn/v/other-999">OTHER-999 related video</a></aside>
    </main></body></html>`;
  const result = av123.classifyResponse({
    statusCode: 200,
    body: detailHtml,
    finalUrl: 'https://123av.com/cn/v/abf-356',
  }, 'ABF-356', 'https://123av.com/cn/search?keyword=ABF-356');

  assert.equal(result.status, 'succeeded');
  assert.equal(result.metadata.responseKind, 'detail');
  assert.equal(result.url, 'https://123av.com/cn/v/abf-356');
});

test('genuine empty search and fuzzy-only search are not found', () => {
  const empty = av123.classifyResponse({
    statusCode: 200,
    body: '<main><h1>Search: ZZZQW-99999</h1><div>0个视频</div><div>没有符合这些筛选条件的视频。</div></main>',
    finalUrl: 'https://123av.com/cn/search?keyword=ZZZQW-99999',
  }, 'ZZZQW-99999');
  assert.equal(empty.status, 'not_found');

  const fuzzy = av123.classifyResponse({
    statusCode: 200,
    body: '<main><h1>Search: ABF-356</h1><a class="card__link" href="/cn/v/flav-356">FLAV-356 — other</a></main>',
    finalUrl: 'https://123av.com/cn/search?keyword=ABF-356',
  }, 'ABF-356');
  assert.equal(fuzzy.status, 'not_found');
});

test('login-required pages are manual while challenge and rate-limit pages are network errors', () => {
  const login = av123.classifyResponse({
    statusCode: 200,
    body: '<form class="login" action="/cn/login"><input type="password" name="password"></form>',
    finalUrl: 'https://123av.com/cn/login',
  }, 'ABF-356');
  assert.equal(login.status, 'manual');
  assert.equal(login.metadata.responseKind, 'login_required');

  const challenge = av123.classifyResponse({
    statusCode: 200,
    body: '<title>Just a moment...</title><div class="cf-chl-verify">Verify you are human</div>',
    finalUrl: 'https://123av.com/cn/search?keyword=ABF-356',
  }, 'ABF-356');
  assert.equal(challenge.status, 'network_error');
  assert.equal(challenge.metadata.responseKind, 'challenge');

  const limited = av123.classifyResponse({ statusCode: 429, body: 'Too Many Requests', headers: { 'retry-after': '9' } }, 'ABF-356');
  assert.equal(limited.status, 'network_error');
  assert.equal(limited.metadata.retryAfterMs, 9000);
});

test('target code in the requested URL alone is never accepted as a hit', () => {
  const result = av123.classifyResponse({
    statusCode: 200,
    body: '<html><head><title>123AV</title></head><body><main>generic page</main></body></html>',
    finalUrl: 'https://123av.com/cn/v/abf-356',
  }, 'ABF-356');
  assert.notEqual(result.status, 'succeeded');
  assert.equal(result.status, 'not_found');
});

test('lookup metadata is bounded and exposes no HTML, cookie, session, or favorite action', () => {
  const result = av123.classifyResponse({
    statusCode: 200,
    body: `${searchPage}<script>window.sessionSecret = 'do-not-log'</script>`,
    finalUrl: 'https://123av.com/cn/search?keyword=ABF-356',
  }, 'ABF-356');
  const serialized = JSON.stringify(result.metadata).toLowerCase();
  assert.doesNotMatch(serialized, /do-not-log|<html|cookie|session/);
  assert.equal(Object.prototype.hasOwnProperty.call(av123, 'favorite'), false);
  assert.equal(Object.keys(av123).some(key => /favorite|save/i.test(key)), false);
});

test('fetch helper follows bounded redirects without performing account actions', async () => {
  const calls = [];
  const page = await av123.fetchPage('https://123av.com/cn/search?keyword=ABF-356', async url => {
    calls.push(url);
    if (calls.length === 1) return { redirected: true, redirectUrl: 'https://www.123av.com/cn/search?keyword=ABF-356', statusCode: 302 };
    return { redirected: false, statusCode: 200, body: searchPage, finalUrl: url, transport: 'test' };
  });
  assert.equal(calls.length, 2);
  assert.equal(page.statusCode, 200);
  assert.equal(page.transport, 'test');
});
