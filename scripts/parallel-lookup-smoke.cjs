const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectDir = path.resolve(__dirname, '..');
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'missav-site-lookup-smoke-'));
const outputDir = path.join(scratchDir, 'exports');
const requestEvents = [];
let activeRequests = 0;
let maxActiveRequests = 0;
const activeBySite = { missav: 0, av123: 0 };
const maxActiveBySite = { missav: 0, av123: 0 };

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.setPath('userData', path.join(scratchDir, 'user-data'));

ipcMain.handle('app:getPath', (_event, name) => app.getPath(name));
ipcMain.handle('logs:append', () => true);
ipcMain.handle('logs:readRecent', () => '');
ipcMain.handle('logs:getInfo', () => ({ path: '', directory: '', size: 0 }));
ipcMain.handle('fs:exists', (_event, target) => fs.existsSync(target));
ipcMain.handle('fs:createDirectory', (_event, target) => { fs.mkdirSync(target, { recursive: true }); return true; });
ipcMain.handle('fs:writeFile', (_event, target, content, encoding = 'utf-8') => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content, encoding); return true; });

async function fakeRequest(site, url) {
  activeRequests++;
  activeBySite[site]++;
  maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
  maxActiveBySite[site] = Math.max(maxActiveBySite[site], activeBySite[site]);
  requestEvents.push({ site, phase: 'start', url, at: Date.now() });
  await new Promise(resolve => setTimeout(resolve, 220));
  requestEvents.push({ site, phase: 'end', url, at: Date.now() });
  activeBySite[site]--;
  activeRequests--;
}

ipcMain.handle('net:fetch', async (_event, url) => {
  await fakeRequest('missav', url);
  const code = String(url).split('/').pop().replace(/-chinese-subtitle$/i, '').toUpperCase();
  return {
    redirected: false,
    statusCode: 200,
    headers: {},
    body: `<html><body><video src="movie.m3u8"></video><a href="/actresses/test">Test</a><a href="/genres/drama">Drama</a><p>${code} ${'content '.repeat(30)}</p></body></html>`,
    finalUrl: url,
    transport: 'site-smoke',
  };
});

ipcMain.handle('net:fetch123av', async (_event, url) => {
  await fakeRequest('av123', url);
  const parsed = new URL(String(url));
  const detailSlug = parsed.pathname.match(/\/v\/([^/]+)/i)?.[1] || '';
  const code = String(parsed.searchParams.get('keyword') || detailSlug).toUpperCase();
  return {
    redirected: false,
    statusCode: 200,
    headers: {},
    body: detailSlug
      ? `<html><head><title>${code} - site smoke</title></head><body><main><h1>${code} - site smoke</h1><iframe src="about:blank"></iframe><dl><dt>代码</dt><dd>${code}</dd><dt>类别</dt><dd><a href="/cn/genres/test">Test</a></dd></dl></main></body></html>`
      : `<html><body><main><h1>Search: ${code}</h1><div>1个视频</div><h3 class="card__title"><a class="card__link" href="/cn/v/${code.toLowerCase()}">${code} - site smoke</a></h3></main></body></html>`,
    finalUrl: url,
    transport: 'site-smoke',
  };
});

async function run() {
  await app.whenReady();
  fs.mkdirSync(outputDir, { recursive: true });
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
    state.outputDirPath = ${JSON.stringify(outputDir)};
    DOM.codeInput.value = ['QZPA-9101', 'QZPB-9102', 'QZPC-9103', 'QZPD-9104', 'QZPE-9105', 'QZPF-9106', 'QZPG-9107', 'QZPH-9108'].join('\\n');
    setSpeedMode('missav', 'fast');
    setSpeedMode('av123', 'fast');
    setSiteRateMode('missav', 'fixed');
    setSiteRateCap('missav', 8);
    set123AvRateMode('fixed');
    set123AvRateCap(5);
    const missavStartedAt = Date.now();
    await startSiteProcessing('missav');
    const missavElapsedMs = Date.now() - missavStartedAt;
    const runId = Number(state.preparedRunId || state.results[0]?.runId || 0);
    const afterMissav = api.dbGetRun(runId);
    const separatedRun = {
      runId,
      afterMissavStatus: afterMissav?.status,
      afterMissavPending: Number(afterMissav?.lookupPending || 0),
      afterMissavMissavPending: Number(afterMissav?.stages?.missavLookup?.pending || 0),
      afterMissavAv123Queued: Number(afterMissav?.stages?.av123Lookup?.statusCounts?.queued || 0),
      progressCurrent: Number(DOM.progressCurrent.textContent),
      progressTotal: Number(DOM.progressTotal.textContent),
      missavElapsedMs,
      statusesAfterMissav: state.results.map(row => ({
        missav: row.tasks?.missavLookup?.status,
        av123: row.tasks?.av123Lookup?.status,
        favorite: row.tasks?.av123Favorite?.status,
      })),
    };
    const av123StartedAt = Date.now();
    await startSiteProcessing('av123');
    const av123ElapsedMs = Date.now() - av123StartedAt;
    const afterBoth = api.dbGetRun(runId);
    separatedRun.afterBothStatus = afterBoth?.status;
    separatedRun.afterBothPending = Number(afterBoth?.lookupPending || 0);
    separatedRun.av123ElapsedMs = av123ElapsedMs;
    separatedRun.statusesAfterBoth = state.results.map(row => ({
      missav: row.tasks?.missavLookup?.status,
      av123: row.tasks?.av123Lookup?.status,
      favorite: row.tasks?.av123Favorite?.status,
    }));

    DOM.codeInput.value = ['QZRA-9201', 'QZRB-9202', 'QZRC-9203', 'QZRD-9204', 'QZRE-9205', 'QZRF-9206', 'QZRG-9207', 'QZRH-9208', 'QZRI-9209', 'QZRJ-9210', 'QZRK-9211', 'QZRL-9212'].join('\\n');
    state.preparedRunId = null;
    state.preparedInputSignature = '';
    const stoppingRun = startSiteProcessing('missav');
    await api.sleep(320);
    stopProcessing();
    await stoppingRun;
    const pausedRunId = Number(state.preparedRunId || state.results[0]?.runId || 0);
    const pausedRun = api.dbGetRun(pausedRunId);
    const pausedRunningLookups = ['missavLookup', 'av123Lookup'].reduce((sum, key) => sum + Number(pausedRun?.stages?.[key]?.statusCounts?.running || 0), 0);
    const pausedPending = Number(pausedRun?.lookupPending || 0);
    const av123BeforeResume = Number(pausedRun?.stages?.av123Lookup?.statusCounts?.queued || 0);
    await resumeProcessingRun(pausedRunId, 'missav');
    const afterMissavResume = api.dbGetRun(pausedRunId);
    await resumeProcessingRun(pausedRunId, 'av123');
    const resumedRun = api.dbGetRun(pausedRunId);

    const deletionCodes = ['QZSA-9301', 'QZSB-9302', 'QZSC-9303', 'QZSD-9304', 'QZSE-9305', 'QZSF-9306', 'QZSG-9307', 'QZSH-9308', 'QZSI-9309', 'QZSJ-9310', 'QZSK-9311', 'QZSL-9312'];
    DOM.codeInput.value = deletionCodes.join('\\n');
    state.preparedRunId = null;
    state.preparedInputSignature = '';
    const deletingRunPromise = startSiteProcessing('missav');
    await api.sleep(500);
    const deletingRunId = Number(state.currentRunId || 0);
    const deletingRunBefore = api.dbGetRun(deletingRunId);
    const backupCountBefore = api.dbListBackups().length;
    const originalConfirm = window.confirm;
    window.confirm = () => true;
    requestDeleteProcessingRun(deletingRunId);
    window.confirm = originalConfirm;
    await deletingRunPromise;
    const backupCountAfter = api.dbListBackups().length;
    const keptPermanentCodes = deletionCodes.filter(code => api.dbFindCode(code)?.found).length;
    return {
      ...separatedRun,
      recovery: {
        pausedRunId,
        pausedStatus: pausedRun?.status,
        pausedRunningLookups,
        pausedPending,
        av123BeforeResume,
        afterMissavResumeStatus: afterMissavResume?.status,
        afterMissavResumeMissavPending: Number(afterMissavResume?.stages?.missavLookup?.pending || 0),
        afterMissavResumeAv123Queued: Number(afterMissavResume?.stages?.av123Lookup?.statusCounts?.queued || 0),
        resumedStatus: resumedRun?.status,
        resumedPending: Number(resumedRun?.lookupPending || 0),
      },
      activeDeletion: {
        runId: deletingRunId,
        completedBeforeRequest: Number(deletingRunBefore?.completed || 0),
        deleted: api.dbGetRun(deletingRunId) === null,
        backupCreated: backupCountAfter === backupCountBefore + 1,
        keptPermanentCodes,
        resultRowsAfterDelete: state.results.length,
        pendingDeleteRunId: Number(state.pendingDeleteRunId || 0),
        isProcessing: state.isProcessing,
      },
    };
  })()`, true);

  const firstRunEvents = requestEvents.slice(0, 32);
  const firstAv123Start = requestEvents.findIndex(event => event.site === 'av123' && event.phase === 'start');
  const firstRunMissavEnds = requestEvents.filter(event => event.site === 'missav' && event.phase === 'end').slice(0, 8);
  assert.equal(firstRunEvents.slice(0, 16).every(event => event.site === 'missav'), true, '123AV must remain idle while MissAV runs');
  assert.equal(firstRunEvents.slice(16, 32).every(event => event.site === 'av123'), true, 'MissAV must not restart while 123AV runs');
  assert.ok(firstAv123Start >= 16, '123AV started before the user selected it');
  assert.equal(firstRunMissavEnds.length, 8);
  assert.ok(maxActiveRequests <= 4, `site concurrency exceeded fast-mode limit: ${maxActiveRequests}`);
  const firstAv123Starts = requestEvents.filter(event => event.site === 'av123' && event.phase === 'start').slice(0, 8);
  const av123StartGaps = firstAv123Starts.slice(1).map((event, index) => event.at - firstAv123Starts[index].at);
  assert.ok(maxActiveBySite.missav >= 2, 'MissAV selected site did not receive useful concurrency');
  assert.ok(maxActiveBySite.av123 <= 2, `123AV rate scheduler burst to ${maxActiveBySite.av123} simultaneous requests`);
  assert.ok(av123StartGaps.every(gap => gap >= 180), `123AV fixed 5 RPS requests were not globally spaced: ${av123StartGaps.join(',')}`);
  assert.equal(result.afterMissavStatus, 'paused');
  assert.equal(result.afterMissavMissavPending, 0);
  assert.equal(result.afterMissavAv123Queued, 8);
  assert.equal(result.progressCurrent, 8);
  assert.equal(result.progressTotal, 8);
  assert.equal(result.statusesAfterMissav.length, 8);
  assert.ok(result.statusesAfterMissav.every(row => row.missav === 'succeeded' && row.av123 === 'queued' && row.favorite === 'blocked'));
  assert.equal(result.afterBothStatus, 'completed');
  assert.equal(result.afterBothPending, 0);
  assert.ok(result.statusesAfterBoth.every(row => row.missav === 'succeeded' && row.av123 === 'succeeded' && row.favorite === 'ready'));
  assert.equal(result.recovery.pausedStatus, 'paused');
  assert.equal(result.recovery.pausedRunningLookups, 0);
  assert.ok(result.recovery.pausedPending > 0);
  assert.equal(result.recovery.av123BeforeResume, 12);
  assert.equal(result.recovery.afterMissavResumeStatus, 'paused');
  assert.equal(result.recovery.afterMissavResumeMissavPending, 0);
  assert.equal(result.recovery.afterMissavResumeAv123Queued, 12);
  assert.equal(result.recovery.resumedStatus, 'completed');
  assert.equal(result.recovery.resumedPending, 0);
  assert.ok(result.activeDeletion.runId > 0);
  assert.ok(result.activeDeletion.completedBeforeRequest > 0);
  assert.equal(result.activeDeletion.deleted, true);
  assert.equal(result.activeDeletion.backupCreated, true);
  assert.ok(result.activeDeletion.keptPermanentCodes > 0);
  assert.equal(result.activeDeletion.resultRowsAfterDelete, 0);
  assert.equal(result.activeDeletion.pendingDeleteRunId, 0);
  assert.equal(result.activeDeletion.isProcessing, false);

  process.stdout.write(JSON.stringify({
    ...result,
    firstAv123Start,
    maxActiveRequests,
    maxActiveBySite,
    requestStarts: requestEvents.filter(event => event.phase === 'start').map(event => event.site),
    scratchDir,
  }, null, 2));
  window.destroy();
  app.quit();
}

run().catch(error => {
  process.stderr.write(error.stack || error.message);
  app.exit(1);
});
