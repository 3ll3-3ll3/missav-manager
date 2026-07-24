const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectDir = path.resolve(__dirname, '..');
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'missav-av123-speed-smoke-'));
let activeRequests = 0;
let maxActiveRequests = 0;
let requestCount = 0;
const requestAttempts = new Map();
const requestStartedAt = [];
let detailRequestCount = 0;
let searchRequestCount = 0;
const capturedLogs = [];

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.setPath('userData', path.join(scratchDir, 'user-data'));

ipcMain.handle('app:getPath', (_event, name) => app.getPath(name));
ipcMain.handle('logs:append', (_event, entry) => { capturedLogs.push(entry); return true; });
ipcMain.handle('logs:readRecent', () => '');
ipcMain.handle('logs:getInfo', () => ({ path: '', directory: '', size: 0 }));
ipcMain.handle('fs:exists', (_event, target) => fs.existsSync(target));
ipcMain.handle('fs:createDirectory', (_event, target) => { fs.mkdirSync(target, { recursive: true }); return true; });
ipcMain.handle('fs:writeFile', (_event, target, content, encoding = 'utf-8') => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, encoding);
  return true;
});

ipcMain.handle('net:fetch123av', async (_event, url) => {
  const parsed = new URL(String(url));
  const detailSlug = parsed.pathname.match(/\/v\/([^/]+)/i)?.[1] || '';
  const detailBase = detailSlug.replace(/-(?:uncensored-leaked|uncensored-leak|chinese-subtitle|english-subtitle|uncensored|leaked)$/i, '');
  const code = String(parsed.searchParams.get('keyword') || detailBase).toUpperCase();
  if (detailSlug) detailRequestCount++;
  else searchRequestCount++;
  const attempt = Number(requestAttempts.get(code) || 0) + 1;
  requestAttempts.set(code, attempt);
  requestCount++;
  requestStartedAt.push(Date.now());
  activeRequests++;
  maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
  await new Promise(resolve => setTimeout(resolve, 220));
  activeRequests--;
  const numericPart = Number((code.match(/(\d+)$/) || [])[1] || 0);
  if ([9401, 9501].includes(numericPart) && attempt === 1) {
    return {
      redirected: false,
      statusCode: 429,
      headers: { 'retry-after': '0.05' },
      body: '<html><body><h1>Too many requests</h1></body></html>',
      finalUrl: url,
      transport: 'speed-smoke',
    };
  }
  if (numericPart === 9701 && !/-uncensored-leaked$/i.test(detailSlug)) {
    return {
      redirected: false,
      statusCode: 404,
      headers: {},
      body: '<html><body>Not found</body></html>',
      finalUrl: url,
      transport: 'speed-smoke',
    };
  }
  return {
    redirected: false,
    statusCode: 200,
    headers: {},
    body: `<html><head><title>${code} - speed smoke</title></head><body><main><h1>${code} - speed smoke</h1><iframe src="about:blank"></iframe><dl><dt>代码</dt><dd>${code}</dd><dt>类别</dt><dd><a href="/cn/genres/test">Test</a></dd></dl></main></body></html>`,
    finalUrl: url,
    transport: 'speed-smoke',
  };
});

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(projectDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await window.loadFile(path.join(projectDir, 'renderer', 'index.html'));

  const result = await window.webContents.executeJavaScript(`(async () => {
    for (let i = 0; i < 60 && !state.dbReady; i++) await api.sleep(100);
    if (!state.dbReady) throw new Error('database did not initialize');
    const extreme = processingSpeed.getSiteProfile('av123', 'extreme');

    set123AvRateMode('adaptive');
    set123AvRateCap(16);
    persist123AvLearnedRate(5);
    initializeSpeedRuntime(extreme, 'av123');
    state.speedRuntime.lastRateChangeAt = Date.now() - 5000;
    for (let i = 0; i < processingSpeed.AV123_RATE_CONTROL.firstProbeSuccesses; i++) {
      recordSpeedAttempt({ status: 'succeeded', statusCode: 200 });
    }
    const adaptiveProbeRate = state.speedRuntime.currentRequestsPerSecond;
    recordSpeedAttempt({ status: 'network_error', statusCode: 429 });
    const adaptiveFallback = {
      requestsPerSecond: state.speedRuntime.currentRequestsPerSecond,
      sessionRateCeiling: state.speedRuntime.sessionRateCeiling,
      rateLimitEvents: state.speedRuntime.rateLimitEvents,
      learnedRate: state.av123LearnedRate,
    };
    state.speedRuntime = null;

    persist123AvLearnedRate(5);
    set123AvSpeedPolicy('fixed');
    initializeSpeedRuntime(extreme, 'av123');
    recordSpeedAttempt({ status: 'network_error', statusCode: 429 });
    const fixedRuntime = {
      allowed: getAllowedSpeedConcurrency(),
      adaptive: state.speedRuntime.adaptive,
      pauseRequestsOnPenalty: state.speedRuntime.pauseRequestsOnPenalty,
      currentGapMs: state.speedRuntime.currentGapMs,
      requestsPerSecond: state.speedRuntime.currentRequestsPerSecond,
      circuitOpen: state.speedRuntime.circuitOpenUntil > Date.now(),
    };
    state.speedRuntime = null;

    persist123AvLearnedRate(5);
    set123AvSpeedPolicy('balanced');
    initializeSpeedRuntime(extreme, 'av123');
    recordSpeedAttempt({ status: 'network_error', statusCode: 429 });
    const balancedRuntime = {
      allowed: getAllowedSpeedConcurrency(),
      adaptive: state.speedRuntime.adaptive,
      pauseRequestsOnPenalty: state.speedRuntime.pauseRequestsOnPenalty,
      currentGapMs: state.speedRuntime.currentGapMs,
      requestsPerSecond: state.speedRuntime.currentRequestsPerSecond,
      circuitOpen: state.speedRuntime.circuitOpenUntil > Date.now(),
    };
    state.speedRuntime = null;

    persist123AvLearnedRate(5);
    set123AvSpeedPolicy('staged');
    initializeSpeedRuntime(extreme, 'av123');
    for (let i = 0; i < 8; i++) recordSpeedAttempt({ status: 'network_error', statusCode: 429, metadata: { responseKind: 'network' } });
    const stagedMainAfterWave = {
      allowed: getAllowedSpeedConcurrency(),
      adaptive: state.speedRuntime.adaptive,
      levels: state.speedRuntime.stagedLevels,
      levelIndex: state.speedRuntime.stagedLevelIndex,
      pauseRequestsOnPenalty: state.speedRuntime.pauseRequestsOnPenalty,
      penaltyActive: state.speedRuntime.penaltyUntil > Date.now(),
      requestsPerSecond: state.speedRuntime.currentRequestsPerSecond,
      circuitOpen: state.speedRuntime.circuitOpenUntil > Date.now(),
    };
    advance123AvStagedLevel('smoke_tail');
    const stagedFirstTail = {
      allowed: getAllowedSpeedConcurrency(),
      levelIndex: state.speedRuntime.stagedLevelIndex,
      penaltyActive: state.speedRuntime.penaltyUntil > Date.now(),
    };
    advance123AvStagedLevel('smoke_final_tail');
    const stagedFinalTailAllowed = getAllowedSpeedConcurrency();
    state.speedRuntime = null;

    initializeSpeedRuntime(processingSpeed.getSiteProfile('missav', 'extreme'), 'missav');
    recordSpeedAttempt({ status: 'network_error', statusCode: 429 });
    const missavRuntime = {
      allowed: getAllowedSpeedConcurrency(),
      adaptive: state.speedRuntime.adaptive,
      pauseRequestsOnPenalty: state.speedRuntime.pauseRequestsOnPenalty,
      currentGapMs: state.speedRuntime.currentGapMs,
      requestsPerSecond: state.speedRuntime.currentRequestsPerSecond,
      rateLimitEvents: state.speedRuntime.rateLimitEvents,
      circuitOpen: state.speedRuntime.circuitOpenUntil > Date.now(),
    };
    state.speedRuntime = null;

    persistSiteLearnedRate('missav', 8);
    setSiteRateMode('missav', 'adaptive');
    setSiteRateCap('missav', 16);
    initializeSpeedRuntime(processingSpeed.getSiteProfile('missav', 'extreme'), 'missav');
    for (let i = 0; i < 10; i++) {
      recordSpeedAttempt({ status: 'ok', statusCode: 200, durationMs: 5000 });
    }
    const missavLatencyRuntime = {
      allowed: getAllowedSpeedConcurrency(),
      requestsPerSecond: state.speedRuntime.currentRequestsPerSecond,
      congestionEvents: state.speedRuntime.congestionEvents,
      p95DurationMs: processingSpeed.summarizeRateHealth(state.speedRuntime.recentAttempts).p95DurationMs,
      penaltyActive: state.speedRuntime.penaltyUntil > Date.now(),
    };
    state.speedRuntime = null;

    setSpeedMode('missav', 'smart');
    setSpeedMode('av123', 'extreme');
    set123AvSpeedPolicy('fixed');
    set123AvRateMode('adaptive');
    set123AvRateCap(16);
    persist123AvLearnedRate(5);
    DOM.codeInput.value = Array.from({ length: 32 }, (_, index) => 'QZXA-' + String(9401 + index)).join('\\n');
    state.preparedRunId = null;
    state.preparedInputSignature = '';
    const startedAt = Date.now();
    await startSiteProcessing('av123');
    const elapsedMs = Date.now() - startedAt;
    const runId = Number(state.preparedRunId || state.results[0]?.runId || 0);
    const batch = api.dbGetRun(runId);

    set123AvRateMode('fixed');
    set123AvRateCap(12);
    DOM.codeInput.value = Array.from({ length: 32 }, (_, index) => 'QZXC-' + String(9601 + index)).join('\\n');
    state.preparedRunId = null;
    state.preparedInputSignature = '';
    const highRateStartedAt = Date.now();
    await startSiteProcessing('av123');
    const highRateElapsedMs = Date.now() - highRateStartedAt;
    const highRateRunId = Number(state.preparedRunId || state.results[0]?.runId || 0);
    const highRateBatch = api.dbGetRun(highRateRunId);

    DOM.codeInput.value = 'QZXV-9701';
    state.preparedRunId = null;
    state.preparedInputSignature = '';
    await startSiteProcessing('av123');
    const variantRunId = Number(state.preparedRunId || state.results[0]?.runId || 0);
    const variantBatch = api.dbGetRun(variantRunId);
    const variantTask = variantBatch?.items?.[0]?.tasks?.av123Lookup;

    set123AvSpeedPolicy('staged');
    set123AvRateMode('adaptive');
    set123AvRateCap(16);
    DOM.codeInput.value = Array.from({ length: 32 }, (_, index) => 'QZXB-' + String(9501 + index)).join('\\n');
    state.preparedRunId = null;
    state.preparedInputSignature = '';
    const stagedStartedAt = Date.now();
    await startSiteProcessing('av123');
    const stagedElapsedMs = Date.now() - stagedStartedAt;
    const stagedRunId = Number(state.preparedRunId || state.results[0]?.runId || 0);
    const stagedBatch = api.dbGetRun(stagedRunId);

    set123AvSpeedPolicy('fixed');
    DOM.codeInput.value = Array.from({ length: 32 }, (_, index) => 'QZXB-' + String(9501 + index)).join('\\n');
    state.preparedRunId = null;
    state.preparedInputSignature = '';
    const cacheStartedAt = Date.now();
    await startSiteProcessing('av123');
    const cacheElapsedMs = Date.now() - cacheStartedAt;
    const cacheRunId = Number(state.preparedRunId || state.results[0]?.runId || 0);
    const cacheBatch = api.dbGetRun(cacheRunId);
    return {
      fixedRuntime,
      adaptiveProbeRate,
      adaptiveFallback,
      balancedRuntime,
      stagedMainAfterWave,
      stagedFirstTail,
      stagedFinalTailAllowed,
      missavRuntime,
      missavLatencyRuntime,
      elapsedMs,
      runId,
      runStatus: batch?.status,
      missavSpeedMode: batch?.missavSpeedMode,
      av123SpeedMode: batch?.av123SpeedMode,
      av123SpeedPolicy: batch?.av123SpeedPolicy,
      av123RateMode: batch?.av123RateMode,
      av123RateCap: batch?.av123RateCap,
      succeeded: Number(batch?.stages?.av123Lookup?.statusCounts?.succeeded || 0),
      networkErrors: Number(batch?.stages?.av123Lookup?.statusCounts?.network_error || 0),
      av123Pending: Number(batch?.stages?.av123Lookup?.pending || 0),
      missavQueued: Number(batch?.stages?.missavLookup?.statusCounts?.queued || 0),
      highRateElapsedMs,
      highRateSucceeded: Number(highRateBatch?.stages?.av123Lookup?.statusCounts?.succeeded || 0),
      highRateMode: highRateBatch?.av123RateMode,
      highRateCap: highRateBatch?.av123RateCap,
      variantStatus: variantTask?.status,
      variantUrl: variantTask?.url,
      variantAttempts: Number(variantTask?.attemptCount || 0),
      stagedElapsedMs,
      stagedRunStatus: stagedBatch?.status,
      stagedSucceeded: Number(stagedBatch?.stages?.av123Lookup?.statusCounts?.succeeded || 0),
      stagedNetworkErrors: Number(stagedBatch?.stages?.av123Lookup?.statusCounts?.network_error || 0),
      stagedAv123Pending: Number(stagedBatch?.stages?.av123Lookup?.pending || 0),
      stagedSpeedPolicy: stagedBatch?.av123SpeedPolicy,
      cacheElapsedMs,
      cacheSucceeded: Number(cacheBatch?.stages?.av123Lookup?.statusCounts?.succeeded || 0),
      cacheNetworkErrors: Number(cacheBatch?.stages?.av123Lookup?.statusCounts?.network_error || 0),
      cacheAttemptCounts: cacheBatch?.items?.map(item => Number(item.tasks?.av123Lookup?.attemptCount || 0)),
    };
  })().catch(error => ({ smokeError: error.stack || error.message || String(error) }))`, true);

  if (result.smokeError) throw new Error(result.smokeError);

  assert.equal(result.adaptiveProbeRate, 5.5);
  assert.deepEqual(result.adaptiveFallback, {
    requestsPerSecond: 4.4,
    sessionRateCeiling: 4.95,
    rateLimitEvents: 1,
    learnedRate: 4.4,
  });

  assert.deepEqual(result.fixedRuntime, {
    allowed: 16,
    adaptive: false,
    pauseRequestsOnPenalty: true,
    currentGapMs: 250,
    requestsPerSecond: 4,
    circuitOpen: true,
  });
  assert.deepEqual(result.balancedRuntime, {
    allowed: 8,
    adaptive: true,
    pauseRequestsOnPenalty: false,
    currentGapMs: 250,
    requestsPerSecond: 4,
    circuitOpen: true,
  });
  assert.deepEqual(result.stagedMainAfterWave, {
    allowed: 16,
    adaptive: false,
    levels: [16, 8, 4],
    levelIndex: 0,
    pauseRequestsOnPenalty: true,
    penaltyActive: true,
    requestsPerSecond: 4,
    circuitOpen: true,
  });
  assert.deepEqual(result.stagedFirstTail, {
    allowed: 8,
    levelIndex: 1,
    penaltyActive: true,
  });
  assert.equal(result.stagedFinalTailAllowed, 4);
  assert.equal(result.missavRuntime.allowed, 1);
  assert.equal(result.missavRuntime.adaptive, true);
  assert.equal(result.missavRuntime.pauseRequestsOnPenalty, true);
  assert.equal(result.missavRuntime.requestsPerSecond, 6.4);
  assert.equal(result.missavRuntime.currentGapMs, 157);
  assert.equal(result.missavRuntime.rateLimitEvents, 1);
  assert.equal(result.missavRuntime.circuitOpen, true);
  assert.deepEqual(result.missavLatencyRuntime, {
    allowed: 1,
    requestsPerSecond: 6.56,
    congestionEvents: 1,
    p95DurationMs: 5000,
    penaltyActive: true,
  });
  assert.equal(requestCount, 99);
  assert.ok(maxActiveRequests >= 2 && maxActiveRequests <= 4, `high-rate scheduler concurrency was ${maxActiveRequests}`);
  assert.ok(result.elapsedMs >= 6500 && result.elapsedMs < 12000, `adaptive extreme rate window took ${result.elapsedMs}ms`);
  assert.equal(result.succeeded + result.networkErrors, 32);
  assert.ok(result.networkErrors > 0);
  assert.equal(result.av123Pending, result.networkErrors);
  assert.equal(result.missavQueued, 32);
  assert.ok(result.highRateElapsedMs >= 2000 && result.highRateElapsedMs < 4500, `fixed 12 RPS run took ${result.highRateElapsedMs}ms`);
  assert.equal(result.highRateSucceeded, 32);
  assert.equal(result.highRateMode, 'fixed');
  assert.equal(result.highRateCap, 12);
  assert.equal(result.variantStatus, 'succeeded');
  assert.equal(result.variantUrl, 'https://123av.com/cn/v/qzxv-9701-uncensored-leaked');
  assert.equal(result.variantAttempts, 2);
  assert.equal(result.runStatus, 'paused');
  assert.equal(result.missavSpeedMode, 'smart');
  assert.equal(result.av123SpeedMode, 'extreme');
  assert.equal(result.av123SpeedPolicy, 'fixed');
  assert.equal(result.av123RateMode, 'adaptive');
  assert.equal(result.av123RateCap, 16);
  assert.ok(result.stagedElapsedMs < 18000, `staged retry tail unexpectedly took ${result.stagedElapsedMs}ms`);
  assert.equal(result.stagedRunStatus, 'paused');
  assert.equal(result.stagedSucceeded, 32);
  assert.equal(result.stagedNetworkErrors, 0);
  assert.equal(result.stagedAv123Pending, 0);
  assert.equal(result.stagedSpeedPolicy, 'staged');
  assert.ok(result.cacheElapsedMs < 2500, `cached rerun unexpectedly took ${result.cacheElapsedMs}ms`);
  assert.equal(result.cacheSucceeded, 32);
  assert.equal(result.cacheNetworkErrors, 0);
  assert.ok(result.cacheAttemptCounts.every(count => count === 0));

  const gaps = requestStartedAt.slice(1).map((value, index) => value - requestStartedAt[index]);
  assert.ok(gaps.filter(gap => gap < 65).length <= 2, `request scheduler emitted burst gaps: ${gaps.filter(gap => gap < 65).join(',')}`);
  assert.equal(searchRequestCount, 0);
  assert.equal(detailRequestCount, requestCount);

  process.stdout.write(JSON.stringify({ ...result, requestCount, maxActiveRequests, detailRequestCount, searchRequestCount, minimumGapMs: Math.min(...gaps), scratchDir }, null, 2));
  window.destroy();
  app.quit();
}

run().catch(error => {
  process.stderr.write(error.stack || error.message);
  app.exit(1);
});
