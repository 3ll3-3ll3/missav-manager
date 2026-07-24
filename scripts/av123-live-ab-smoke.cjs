const { app, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const av123 = require('../src/av123');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'missav-av123-live-ab-'));
const codes = process.argv.slice(2).filter(Boolean);
if (!codes.length) codes.push('ABF-356', 'IPTD-543', 'HMN-779');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(scratchDir, 'user-data'));

async function fetchPage(networkSession, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await networkSession.fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': networkSession.getUserAgent(),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
        Referer: 'https://123av.com/',
      },
    });
    const finalUrl = String(response.url || url);
    if (!['123av.com', 'www.123av.com'].includes(new URL(finalUrl).hostname.toLowerCase())) {
      throw new Error(`unexpected redirect host: ${finalUrl}`);
    }
    const headers = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    return {
      statusCode: response.status,
      headers,
      body: await response.text(),
      finalUrl,
      transport: 'electron-persistent-session-live-smoke',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function run() {
  await app.whenReady();
  const networkSession = session.fromPartition('persist:missav-manager-123av-query');
  const results = [];
  for (const code of codes) {
    const normalized = String(code).toUpperCase();
    const startedAt = Date.now();
    const candidates = av123.buildDetailCandidateUrls(normalized);
    let result = null;
    let route = '';
    let requestCount = 0;
    for (let index = 0; index < candidates.length; index++) {
      const detailUrl = candidates[index];
      const page = await fetchPage(networkSession, detailUrl);
      result = av123.classifyResponse(page, normalized, detailUrl);
      route = index === 0 ? 'detail_base' : `detail_variant_${index}`;
      requestCount++;
      if (result.status !== 'not_found') break;
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    results.push({
      code: normalized,
      route,
      requestCount,
      status: result?.status || 'not_found',
      statusCode: result?.statusCode || 0,
      responseKind: result?.metadata?.responseKind || '',
      resultUrl: result?.url || '',
      elapsedMs: Date.now() - startedAt,
      error: result?.error || '',
    });
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  process.stdout.write(JSON.stringify({ results, scratchDir }, null, 2));
  app.quit();
}

run().catch(error => {
  process.stderr.write(error.stack || error.message);
  app.exit(1);
});
