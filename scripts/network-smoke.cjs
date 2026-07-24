const { app, net } = require('electron');
const fetcher = require('../src/fetcher');
const av123 = require('../src/av123');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');

const av123Mode = process.argv.includes('--123av');
const target = process.argv.find(value => /^https?:\/\//i.test(value)) || (av123Mode
  ? 'https://123av.com/cn/v/abf-356'
  : 'https://missav.ai/cn/jul-991');
const explicitCode = process.argv.find(value => /^--code=/i.test(value));
const pathCode = new URL(target).pathname.split('/').filter(Boolean).pop() || '';
const queryCode = new URL(target).searchParams.get('keyword') || '';
const code = (explicitCode ? explicitCode.slice('--code='.length) : queryCode || pathCode)
  .replace(/-(?:uncensored-leaked|uncensored-leak|chinese-subtitle|english-subtitle|uncensored|leaked)$/i, '')
  .toUpperCase();
const timer = setTimeout(() => {
  console.error(JSON.stringify({ ok: false, target, error: 'smoke timeout' }));
  app.exit(2);
}, 30000);

app.whenReady().then(async () => {
  try {
    const startedAt = Date.now();
    const response = await net.fetch(target, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
      },
    });
    const body = await response.text();
    const elapsedMs = Date.now() - startedAt;
    const classification = (av123Mode ? av123.classifyResponse : fetcher.classifyCandidateResponse)({
      statusCode: response.status,
      body,
      finalUrl: response.url,
    }, code, target);
    console.log(JSON.stringify({
      ok: response.ok,
      target,
      status: response.status,
      finalUrl: response.url,
      redirected: response.url !== target,
      bodyLength: body.length,
      code,
      service: av123Mode ? '123av' : 'missav',
      elapsedMs,
      containsCode: av123Mode ? av123.hasExactCodeEvidence(body, code) : fetcher.hasCodeEvidence(body, code),
      classification: classification.status,
      resultUrl: classification.url || '',
      challengeReason: av123Mode ? av123.accessChallengeReason(body) : fetcher.detectAccessChallenge(body, code),
      actressCount: av123Mode ? undefined : fetcher.extractActressTags(body).length,
      genreCount: av123Mode ? undefined : fetcher.extractGenreTags(body).length,
    }));
    clearTimeout(timer);
    app.exit(response.ok ? 0 : 1);
  } catch (err) {
    console.error(JSON.stringify({ ok: false, target, error: err.message }));
    clearTimeout(timer);
    app.exit(1);
  }
});
