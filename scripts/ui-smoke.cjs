const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const telegramSource = require('../src/telegramSource');
const coreService = require('../src/coreService');
const fetcher = require('../src/fetcher');
const av123 = require('../src/av123');
const packageInfo = require('../package.json');

const projectDir = path.resolve(__dirname, '..');
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'missav-ui-smoke-'));
const outputDir = path.join(scratchDir, 'exports');
const multiImportHtmlPath = path.join(scratchDir, 'batch-one.html');
const multiImportTextPath = path.join(scratchDir, 'batch-two.txt');
const screenshotPath = path.join(projectDir, 'artifacts', 'ui-pipeline-results.png');
const av123ScreenshotPath = path.join(projectDir, 'artifacts', 'ui-pipeline-results-123av.png');
const processScreenshotPath = path.join(projectDir, 'artifacts', 'ui-pipeline-input.png');
const homeScreenshotPath = path.join(projectDir, 'artifacts', 'ui-toolbox-home.png');
const toolboxScreenshotPath = path.join(projectDir, 'artifacts', 'ui-toolbox-twitter.png');
const siteScreenshotPath = path.join(projectDir, 'artifacts', 'ui-site-workbench.png');
const siteMissavScreenshotPath = path.join(projectDir, 'artifacts', 'ui-site-workbench-missav.png');
const syncScreenshotPath = path.join(projectDir, 'artifacts', 'ui-raindrop-sync.png');
const batchScreenshotPath = path.join(projectDir, 'artifacts', 'ui-pipeline-batches.png');
const batch123AvScreenshotPath = path.join(projectDir, 'artifacts', 'ui-pipeline-batches-123av.png');
const databaseMaintenanceScreenshotPath = path.join(projectDir, 'artifacts', 'ui-database-maintenance.png');
const databaseEditorScreenshotPath = path.join(projectDir, 'artifacts', 'ui-database-editor.png');
const mobileScreenshotPath = path.join(projectDir, 'artifacts', 'ui-pipeline-mobile.png');
const mobileProcessScreenshotPath = path.join(projectDir, 'artifacts', 'ui-site-workbench-mobile.png');
const mobileSyncScreenshotPath = path.join(projectDir, 'artifacts', 'ui-raindrop-sync-mobile.png');
let activeFavoriteCalls = 0;
let maxActiveFavoriteCalls = 0;
let active123AvLookupCalls = 0;
let lookupFavoriteOverlap = false;
let missavFavoriteOverlap = false;
const favoriteWorkerIds = new Set();
const favoriteExecutors = new Set();
const favoriteAttemptsByCode = new Map();
const autoFavoriteStarts = [];
const raindropRemoteByUrl = new Map();
raindropRemoteByUrl.set('https://missav.ai/cn/abf-354', 4321);
let nextRaindropId = 5000;
let multiImportDialogRequested = false;

fs.writeFileSync(multiImportHtmlPath, '<html><body><p>ABF-354</p><a href="https://missav.ai/cn/gvh-842">GVH-842</a></body></html>', 'utf8');
fs.writeFileSync(multiImportTextPath, 'SSIS-469\nABF-354\n', 'utf8');

// The Codex Windows sandbox cannot create Electron's sandboxed GPU/cache child
// processes. Keep the production window sandboxed; run this isolated harness
// with the GPU in-process so visual regression tests remain deterministic.
app.commandLine.appendSwitch('in-process-gpu');
app.setPath('userData', path.join(scratchDir, 'user-data'));

ipcMain.on('app:get-version-sync', event => {
  event.returnValue = packageInfo.version;
});
ipcMain.on('core:call', (event, payload = {}) => {
  try {
    event.returnValue = {
      ok: true,
      value: coreService.call(String(payload.scope || ''), String(payload.method || ''), payload.args || []),
    };
  } catch (error) {
    event.returnValue = { ok: false, error: error.message || String(error) };
  }
});
ipcMain.handle('app:getPath', (_event, name) => {
  if (name !== 'userData') throw new Error('不允许读取该应用路径');
  return app.getPath(name);
});
ipcMain.handle('database-location:status', () => ({
  directory: path.join(app.getPath('userData'), 'data'),
  databasePath: path.join(app.getPath('userData'), 'data', 'missav_data.db'),
  configured: false,
}));
ipcMain.handle('database-location:change', () => ({ changed: false, canceled: true }));
ipcMain.handle('telegram-bot:status', () => ({
  status: 'disconnected',
  configured: false,
  connected: false,
  encryptionAvailable: true,
  accountKey: '',
  accountLabel: '',
  error: '',
}));
ipcMain.handle('telegram:status', () => ({
  status: 'disconnected',
  configured: false,
  connected: false,
  encryptionAvailable: true,
  accountKey: '',
  accountLabel: '',
  error: '',
}));
ipcMain.handle('logs:append', () => true);
ipcMain.handle('logs:readRecent', () => '');
ipcMain.handle('logs:getInfo', () => ({ path: '', directory: '', size: 0 }));
ipcMain.handle('dialog:openFile', (_event, options = {}) => {
  multiImportDialogRequested = options.multiSelections === true;
  return multiImportDialogRequested ? [multiImportHtmlPath, multiImportTextPath] : multiImportHtmlPath;
});
ipcMain.handle('fs:createDirectory', (_event, target) => { fs.mkdirSync(target, { recursive: true }); return true; });
ipcMain.handle('fs:writeFile', (_event, target, content, encoding = 'utf-8') => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content, encoding); return true; });
ipcMain.handle('fs:readFile', (_event, target, encoding = 'utf-8') => fs.readFileSync(target, encoding));
ipcMain.handle('fs:exists', (_event, target) => fs.existsSync(target));
ipcMain.handle('fs:readDir', (_event, target) => fs.readdirSync(target).map(name => ({ name, isFile: fs.statSync(path.join(target, name)).isFile(), isDirectory: fs.statSync(path.join(target, name)).isDirectory() })));
ipcMain.handle('telegram:parse-export', (_event, paths) => {
  const files = (paths || []).map(filePath => ({ path: filePath, content: fs.readFileSync(filePath, 'utf8') }));
  const parsed = telegramSource.parseTelegramExportFiles(files);
  return {
    ...parsed,
    sourceKey: 'ui-smoke-export',
    sourceType: 'export',
    sourceLabel: `${files.length} 个文件`,
    fileCount: files.length,
  };
});
ipcMain.handle('shell:openExternal', () => true);
ipcMain.handle('shell:openDirectory', () => true);
ipcMain.handle('net:fetch', async (_event, url) => {
  const code = String(url).split('/').pop().replace(/-chinese-subtitle$/i, '').toUpperCase();
  if (activeFavoriteCalls > 0) missavFavoriteOverlap = true;
  await new Promise(resolve => setTimeout(resolve, 25));
  return {
    redirected: false,
    statusCode: 200,
    headers: {},
    body: `<html><body><video src="movie.m3u8"></video><a href="/actresses/test-actress">Test Actress</a><a href="/genres/drama">剧情</a><p>${code} ${'content '.repeat(30)}</p></body></html>`,
    finalUrl: url,
    transport: 'ui-smoke',
  };
});
ipcMain.handle('net:fetch123av', async (_event, url) => {
  const parsed = new URL(String(url));
  const detailSlug = parsed.pathname.match(/\/v\/([^/]+)/i)?.[1] || '';
  const code = detailSlug.replace(/-(?:uncensored-leaked|uncensored-leak|chinese-subtitle|english-subtitle|uncensored|leaked)$/i, '').toUpperCase();
  const stagger = /^(?:AUTO|STOP)-/.test(code) ? Math.max(0, Number(code.split('-')[1]) - 101) * 80 : 0;
  active123AvLookupCalls++;
  await new Promise(resolve => setTimeout(resolve, 45 + stagger));
  active123AvLookupCalls--;
  return {
    redirected: false,
    statusCode: 200,
    headers: {},
    body: `<html><head><title>${code} — UI smoke detail</title></head><body><main><h1>${code} — UI smoke detail</h1><iframe src="about:blank"></iframe><dl><dt>代码</dt><dd>${code}</dd><dt>类别</dt><dd><a href="/cn/genres/test">Test</a></dd></dl><aside><a class="card__link" href="/cn/v/other-999">OTHER-999 related</a></aside></main></body></html>`,
    finalUrl: url,
    transport: 'ui-smoke',
  };
});
ipcMain.handle('net:fetch-page', async (_event, url, options = {}) => fetcher.fetchPage(
  url,
  async targetUrl => {
    const code = String(targetUrl).split('/').pop().replace(/-chinese-subtitle$/i, '').toUpperCase();
    if (activeFavoriteCalls > 0) missavFavoriteOverlap = true;
    await new Promise(resolve => setTimeout(resolve, 25));
    return {
      redirected: false,
      statusCode: 200,
      headers: {},
      body: `<html><body><video src="movie.m3u8"></video><a href="/actresses/test-actress">Test Actress</a><a href="/genres/drama">剧情</a><p>${code} ${'content '.repeat(30)}</p></body></html>`,
      finalUrl: targetUrl,
      transport: 'ui-smoke',
    };
  },
  options,
));
ipcMain.handle('net:fetch123av-page', async (_event, url, options = {}) => av123.fetchPage(
  url,
  async targetUrl => {
    const parsed = new URL(String(targetUrl));
    const detailSlug = parsed.pathname.match(/\/v\/([^/]+)/i)?.[1] || '';
    const code = detailSlug.replace(/-(?:uncensored-leaked|uncensored-leak|chinese-subtitle|english-subtitle|uncensored|leaked)$/i, '').toUpperCase();
    const stagger = /^(?:AUTO|STOP)-/.test(code) ? Math.max(0, Number(code.split('-')[1]) - 101) * 80 : 0;
    active123AvLookupCalls++;
    await new Promise(resolve => setTimeout(resolve, 45 + stagger));
    active123AvLookupCalls--;
    return {
      redirected: false,
      statusCode: 200,
      headers: {},
      body: `<html><head><title>${code} — UI smoke detail</title></head><body><main><h1>${code} — UI smoke detail</h1><iframe src="about:blank"></iframe><dl><dt>代码</dt><dd>${code}</dd><dt>类别</dt><dd><a href="/cn/genres/test">Test</a></dd></dl><aside><a class="card__link" href="/cn/v/other-999">OTHER-999 related</a></aside></main></body></html>`,
      finalUrl: targetUrl,
      transport: 'ui-smoke',
    };
  },
  options,
));
ipcMain.handle('123av-account:open', () => ({
  status: 'ready',
  error: '',
  metadata: { accountLabel: 'ui-smoke-account', responseKind: 'account_ready' },
}));
ipcMain.handle('123av-account:check', () => ({
  status: 'ready',
  error: '',
  metadata: { accountLabel: 'ui-smoke-account', responseKind: 'account_ready' },
}));
ipcMain.handle('123av-account:favorite', async (_event, options) => {
  activeFavoriteCalls++;
  maxActiveFavoriteCalls = Math.max(maxActiveFavoriteCalls, activeFavoriteCalls);
  if (active123AvLookupCalls > 0) lookupFavoriteOverlap = true;
  favoriteWorkerIds.add(Number(options?.workerId || 0));
  favoriteExecutors.add(String(options?.executor || ''));
  const code = String(options?.code || '');
  if (code.startsWith('AUTO-')) autoFavoriteStarts.push(Date.now());
  const attempt = (favoriteAttemptsByCode.get(code) || 0) + 1;
  favoriteAttemptsByCode.set(code, attempt);
  await new Promise(resolve => setTimeout(resolve, 90));
  activeFavoriteCalls--;
  if (code === 'RATE-101' && attempt === 1 && !options?.verifyOnly) {
    return {
      status: 'network_error',
      url: options?.url || '',
      error: '123AV / Cloudflare Error 1015：当前 IP 被临时限速',
      metadata: { responseKind: 'rate_limited', retryAfterMs: 1000, clickAttempted: false },
    };
  }
  if (code === 'AUTO-102' && attempt === 1 && !options?.verifyOnly) {
    return {
      status: 'verify_required',
      url: options?.url || '',
      error: '模拟页面未及时显示已保存',
      metadata: { accountLabel: 'ui-smoke-account', responseKind: 'post_click_timeout', clickAttempted: true },
    };
  }
  return {
    status: code === 'AUTO-102' && attempt > 1 ? 'already_saved' : options?.verifyOnly ? 'already_saved' : 'succeeded',
    url: options?.url || '',
    error: '',
    metadata: { accountLabel: 'ui-smoke-account', responseKind: options?.verifyOnly ? 'detail' : 'saved', clickAttempted: !options?.verifyOnly },
  };
});
ipcMain.handle('chrome-favorite:status', () => ({
  running: true,
  connected: true,
  port: 17831,
  extensionVersion: '1.0.0',
  accountLabel: 'ui-smoke-account',
  queued: 0,
  active: 0,
}));
ipcMain.handle('chrome-favorite:prepare', () => ({
  running: true,
  connected: true,
  port: 17831,
  extensionVersion: '1.0.0',
  accountLabel: 'ui-smoke-account',
  pairingCode: `MMCB1:17831:${'a'.repeat(64)}`,
  extensionPath: path.join(scratchDir, 'chrome-extension'),
}));
ipcMain.handle('raindrop:auth-status', () => ({ configured: true, encryptionAvailable: true }));
ipcMain.handle('raindrop:set-token', () => ({ configured: true, encryptionAvailable: true, account: { id: 77, label: 'ui-raindrop-account' } }));
ipcMain.handle('raindrop:clear-token', () => ({ configured: false, encryptionAvailable: true }));
ipcMain.handle('raindrop:test', () => ({ configured: true, encryptionAvailable: true, account: { id: 77, label: 'ui-raindrop-account' }, rate: { limit: 120, remaining: 119 } }));
ipcMain.handle('raindrop:collections', () => ({ items: [{ id: 10, title: 'JAV', path: 'JAV', parentId: 0, count: 20 }, { id: 11, title: 'MissAV', path: 'JAV / MissAV', parentId: 10, count: 5 }] }));
ipcMain.handle('raindrop:ensure-collections', () => ({
  routing: { missav1: 21, missav2: 22 },
  created: [],
  items: [
    { id: 10, title: 'JAV', path: 'JAV', parentId: 0, count: 20 },
    { id: 11, title: 'MissAV', path: 'JAV / MissAV', parentId: 10, count: 5 },
    { id: 21, title: 'missav1', path: 'missav1', parentId: 0, count: 0 },
    { id: 22, title: 'missav2', path: 'missav2', parentId: 0, count: 0 },
  ],
}));
ipcMain.handle('raindrop:check-urls', (_event, urls) => ({ items: urls.map(url => ({ url, remoteId: raindropRemoteByUrl.get(url) || null })) }));
ipcMain.handle('raindrop:upsert', (_event, options) => {
  const existing = Number(options?.remoteId) || 0;
  const id = existing || nextRaindropId++;
  raindropRemoteByUrl.set(options.payload.link, id);
  return { action: existing ? 'updated' : 'created', item: { id, link: options.payload.link, title: options.payload.title }, rate: { limit: 120, remaining: 100 } };
});
async function run() {
  await app.whenReady();
  await coreService.init({
    dbDir: path.join(app.getPath('userData'), 'data'),
    applicationDir: projectDir,
  });
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    show: false,
    backgroundColor: '#f4fbf6',
    webPreferences: {
      preload: path.join(projectDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 3) process.stderr.write(`[renderer:${level}] ${message} (${sourceId}:${line})\n`);
  });
  await window.loadFile(path.join(projectDir, 'renderer', 'index.html'));
  await new Promise(resolve => setTimeout(resolve, 800));

  const homeResult = await window.webContents.executeJavaScript(`(async () => {
    for (let i = 0; i < 60 && !state.dbReady; i++) await api.sleep(100);
    switchPage('home');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const home = {
      activePage: state.activePage,
      navButtons: document.querySelectorAll('.nav-btn[data-page]').length,
      sidebarToolButtons: document.querySelectorAll('.side-nav [data-open-tool]').length,
      toolCards: document.querySelectorAll('#toolHomeCategories [data-open-tool]').length,
      categories: document.querySelectorAll('.tool-home-category').length,
      toolCount: DOM.homeToolCount?.textContent || '',
      workspaceHidden: DOM.toolWorkspaceBar?.hidden,
    };
    switchPage('tasks');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    home.taskCards = document.querySelectorAll('.task-center-card').length;
    home.taskPage = state.activePage;
    switchPage('settings');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    home.databaseLocationButtons = [DOM.btnOpenDbLocation, DOM.btnChangeDbLocation].filter(Boolean).length;
    home.databaseLocationShown = Boolean(DOM.dbPathValue?.textContent?.includes('user-data'));
    switchPage('home');
    return home;
  })()`);
  window.showInactive();
  window.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 200));
  const homeImage = await window.webContents.capturePage();
  fs.writeFileSync(homeScreenshotPath, homeImage.toPNG());

  const result = await window.webContents.executeJavaScript(`(async () => {
    for (let i = 0; i < 60 && !state.dbReady; i++) await api.sleep(100);
    switchTool('missav');
    await importTextFiles();
    const multiImport = {
      codes: [...state.inputCodes],
      sourceLabel: DOM.inputSourceInfo?.dataset.sourceLabel || DOM.inputSourceInfo?.textContent || '',
      rawHasBothFiles: DOM.codeInput.value.includes('GVH-842') && DOM.codeInput.value.includes('SSIS-469'),
      filteredLines: DOM.filteredCodeOutput.value.split(/\\r?\\n/).filter(Boolean),
    };
    clearAll();
    state.outputDirPath = ${JSON.stringify(outputDir)};
    const uiRunId = api.dbCreateRun({
      name: 'UI 分站点测试',
      sourceType: 'test',
      sourceLabel: '隔离 UI 数据',
      speedMode: 'fast',
      outputDir: state.outputDirPath,
      status: 'paused',
      pipelineVersion: 2,
      items: [
        { code: 'ABF-354', url: 'https://missav.ai/cn/abf-354', status: 'network_error', itemStatus: 'completed', error: '页面触发访问验证', includeInImport: false },
        { code: 'LAFBD-41', url: 'https://missav.ai/cn/lafbd-41', status: 'network_error', itemStatus: 'completed', error: '偶发连接中断', includeInImport: false },
        { code: 'GVH-842', url: 'https://missav.ai/cn/gvh-842', status: 'network_error', itemStatus: 'completed', error: '偶发连接中断', includeInImport: false },
        { code: 'ROYD-110', url: 'https://missav.ai/cn/royd-110', status: 'network_error', itemStatus: 'completed', error: '页面触发访问验证', includeInImport: false },
        { code: 'SONE-314', url: 'https://missav.ai/cn/sone-314', status: 'ok', itemStatus: 'completed', actresses: ['Test_Actress'], genres: ['剧情'], finalTags: ['Test_Actress', '剧情'], includeInImport: true },
        { code: 'SSIS-469', url: 'https://missav.ai/cn/ssis-469', status: 'not_found', itemStatus: 'completed', includeInImport: true },
      ],
    });
    for (let position = 0; position < 3; position++) {
      const code = ['ABF-354', 'LAFBD-41', 'GVH-842'][position];
      api.dbUpdateRunTask(uiRunId, position, '123av', 'lookup', { status: 'succeeded', url: 'https://123av.com/cn/v/' + code.toLowerCase(), error: '' });
    }
    const uiBatch = api.dbGetRun(uiRunId);
    state.preparedRunId = uiRunId;
    state.selectedRunId = uiRunId;
    state.results = uiBatch.items.map(batchItemToResult);
    state.stats = { total: 6, new: 6, exists: 0, notFound: 1, duplicate: 0 };
    DOM.outputDirPath.textContent = state.outputDirPath;
    DOM.outputDirPathMirror.textContent = state.outputDirPath;
    DOM.exportBar.style.display = 'flex';
    switchPage('results');
    await exportByTags();
    await retryResultIndexes([0, 1, 2]);
    DOM.resultTagFilter.value = '剧情';
    renderTable();
    const tagFilteredRows = document.querySelectorAll('[data-result-index]').length;
    DOM.resultTagFilter.value = 'all';
    DOM.resultSort.value = 'code_desc';
    DOM.resultSort.dispatchEvent(new Event('change', { bubbles: true }));
    const firstSortedCode = document.querySelector('[data-result-index] .col-code')?.textContent.trim();
    DOM.resultSort.value = 'original';
    DOM.resultSort.dispatchEvent(new Event('change', { bubbles: true }));
    const first = document.querySelector('[data-result-index="0"] .col-code');
    const second = document.querySelector('[data-result-index="3"] .col-code');
    first.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    second.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    switchPage('results');
    renderTable();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      uiRunId,
      resultCount: state.results.length,
      selectedCount: state.resultSelected.size,
      firstStatus: state.results[0].status,
      retriedStatuses: state.results.slice(0, 3).map(row => row.status),
      tagFilteredRows,
      firstSortedCode,
      remainingNetwork: state.results.filter(row => row.status === 'network_error').length,
      retryButtons: document.querySelectorAll('[data-result-retry-index]').length,
      sheetTables: document.querySelectorAll('.sheet-table').length,
      exportButtons: Boolean(DOM.btnExportCurrent && DOM.btnExportByTags),
      versionBadge: document.querySelector('#versionBadge')?.textContent,
      activePage: state.activePage,
      activePanels: [...document.querySelectorAll('.app-page.active')].map(panel => panel.dataset.pagePanel),
      taskColumns: document.querySelectorAll('#resultTable thead .col-task').length,
      workspaceButtons: document.querySelectorAll('[data-result-workspace]').length,
      activeWorkspace: state.resultWorkspace,
      resultTitle: DOM.resultWorkspaceTitle?.textContent,
      tagFilterVisible: !DOM.resultTagFilter?.hidden,
      firstTasks: Object.fromEntries(RESULT_STAGE_KEYS.map(key => [key, resultTask(state.results[0], key).status])),
      av123Succeeded: state.results.filter(row => resultTask(row, 'av123Lookup').status === 'succeeded').length,
      stageFilterOptions: DOM.resultStageFilter?.options.length || 0,
      deleteBatchVisible: Boolean(DOM.btnDeleteCurrentRun && !DOM.btnDeleteCurrentRun.hidden),
      multiImport,
    };
  })()`);
  window.showInactive();
  await window.webContents.executeJavaScript(`document.querySelectorAll('.toast').forEach(node => node.remove())`);
  await new Promise(resolve => setTimeout(resolve, 300));
  const image = await window.webContents.capturePage();
  fs.writeFileSync(screenshotPath, image.toPNG());
  const av123Result = await window.webContents.executeJavaScript(`(async () => {
    switchResultWorkspace('av123');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const accountCheck = await check123AvAccountStatus({ quiet: true });
    const favoriteIndexes = state.results.map((row, index) => resultTask(row, 'av123Favorite').status === 'ready' ? index : -1).filter(index => index >= 0);
    const originalConfirm = window.confirm;
    window.confirm = () => true;
    set123AvFavoriteConcurrency(2);
    if (favoriteIndexes.length) await run123AvFavoriteIndexes(favoriteIndexes);
    window.confirm = originalConfirm;
    const sortValues = [...DOM.resultSort.options].map(option => option.value);
    DOM.resultStatusFilter.value = 'not_found';
    DOM.resultStatusFilter.dispatchEvent(new Event('change', { bubbles: true }));
    switchResultWorkspace('missav');
    const missavStatusAfterSwitch = DOM.resultStatusFilter.value;
    switchResultWorkspace('av123');
    const restoredAv123Status = DOM.resultStatusFilter.value;
    DOM.resultStatusFilter.value = 'all';
    DOM.resultStatusFilter.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      activeWorkspace: state.resultWorkspace,
      resultTitle: DOM.resultWorkspaceTitle?.textContent,
      taskColumns: document.querySelectorAll('#resultTable thead .col-task').length,
      stageFilterOptions: DOM.resultStageFilter?.options.length || 0,
      sortValues,
      missavStatusAfterSwitch,
      restoredAv123Status,
      actressColumns: document.querySelectorAll('#resultTable thead .col-actress').length,
      tagFilterVisible: !DOM.resultTagFilter?.hidden,
      exportVisible: getComputedStyle(DOM.exportBar).display !== 'none',
      accountStatus: accountCheck?.status,
      accountPanelVisible: !DOM.av123AccountPanel?.hidden,
      accountButtons: document.querySelectorAll('.av123-account-actions button').length,
      favoriteControls: [DOM.btnFavoriteSelected123Av, DOM.btnFavoriteAll123Av, DOM.btnVerifySelected123Av, DOM.btnVerifyAll123Av].filter(Boolean).length,
      favoriteStatuses: favoriteIndexes.map(index => resultTask(state.results[index], 'av123Favorite').status),
      favoriteConcurrency: state.av123FavoriteConcurrency,
    };
  })()`);
  window.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 300));
  const av123Image = await window.webContents.capturePage();
  fs.writeFileSync(av123ScreenshotPath, av123Image.toPNG());
  const processResult = await window.webContents.executeJavaScript(`(async () => {
    switchTool('missav');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      activePage: state.activePage,
      activePanels: [...document.querySelectorAll('.app-page.active')].map(panel => panel.dataset.pagePanel),
      siteProvidersInsideInput: document.querySelectorAll('[data-page-panel="process"] [data-site-provider]').length,
      hasOpenSitesButton: Boolean(DOM.btnOpenSitesFromInput),
      navButtons: document.querySelectorAll('.nav-btn[data-page]').length,
      activeNav: document.querySelector('.tool-stage-btn.active')?.dataset.page,
      activeTool: state.activeTool,
      stageVisible: !DOM.avToolStages.hidden,
    };
  })()`);
  window.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 300));
  const processImage = await window.webContents.capturePage();
  fs.writeFileSync(processScreenshotPath, processImage.toPNG());
  const toolboxResult = await window.webContents.executeJavaScript(`(async () => {
    switchTool('twitter');
    DOM.twitterRawInput.value = '#KeChunYaoll @second_user https://x.com/KeChunYaoll';
    runSimpleToolFilter('twitter');
    const twitter = {
      page: state.activePage,
      names: DOM.twitterNamesOutput.value.split(/\\r?\\n/).filter(Boolean),
      urls: DOM.twitterUrlsOutput.value.split(/\\r?\\n/).filter(Boolean),
      activeTool: state.activeTool,
    };
    switchTool('badnews');
    DOM.badnewsRawInput.value = 'https://bad.news/app https://bad.news/t/123?from=tg https://bad.news/t/123#x https://bad.news/about';
    runSimpleToolFilter('badnews');
    const badnews = {
      page: state.activePage,
      urls: DOM.badnewsUrlsOutput.value.split(/\\r?\\n/).filter(Boolean),
      activeTool: state.activeTool,
    };
    switchTool('missav');
    return { twitter, badnews, returnedTool: state.activeTool };
  })()`);
  await window.webContents.executeJavaScript(`switchTool('twitter')`);
  window.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 250));
  const toolboxImage = await window.webContents.capturePage();
  fs.writeFileSync(toolboxScreenshotPath, toolboxImage.toPNG());
  await window.webContents.executeJavaScript(`switchTool('missav')`);
  const sitesResult = await window.webContents.executeJavaScript(`(async () => {
    switchPage('sites');
    setSpeedMode('missav', 'fast');
    setSpeedMode('av123', 'extreme');
    setMissavSpeedPolicy('balanced');
    set123AvSpeedPolicy('staged');
    setSiteRateMode('missav', 'adaptive');
    setSiteRateCap('missav', 24);
    set123AvRateMode('adaptive');
    set123AvRateCap(24);
    set123AvFavoriteConcurrency(2);
    switchSiteWorkspace('missav');
    const missavVisibleProviders = [...document.querySelectorAll('[data-site-provider]')].filter(card => !card.closest('[data-site-workspace-panel]')?.hidden).map(card => card.dataset.siteProvider);
    switchSiteWorkspace('av123');
    switch123AvSiteTab('favorite');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await refreshChromeFavoriteBridgeStatus();
    return {
      activePage: state.activePage,
      activePanels: [...document.querySelectorAll('.app-page.active')].map(panel => panel.dataset.pagePanel),
      activeNav: document.querySelector('.nav-stage-btn.active')?.dataset.page,
      providerCards: document.querySelectorAll('[data-page-panel="sites"] [data-site-provider]').length,
      catalogButtons: document.querySelectorAll('[data-site-workspace]').length,
      visibleWorkspacePanels: [...document.querySelectorAll('[data-site-workspace-panel]')].filter(panel => !panel.hidden).length,
      activeSiteWorkspace: state.siteWorkspace,
      visibleProviders: [...document.querySelectorAll('[data-site-provider]')].filter(card => !card.closest('[data-site-workspace-panel]')?.hidden).map(card => card.dataset.siteProvider),
      missavVisibleProviders,
      branchCards: document.querySelectorAll('[data-site-operation]').length,
      startButtons: document.querySelectorAll('[data-page-panel="sites"] [id^="btnStart"]').length,
      visibleStopButtons: [...document.querySelectorAll('[id^="btnStopMissav"], [id^="btnStop123Av"]')].filter(button => !button.hidden).length,
      speedPanels: document.querySelectorAll('[data-speed-panel]').length,
      missavSpeed: state.speedModes.missav,
      av123Speed: state.speedModes.av123,
      av123SpeedPolicy: state.av123SpeedPolicy,
      missavSpeedPolicy: state.missavSpeedPolicy,
      missavRateMode: state.missavRateMode,
      missavRateCap: state.missavRateCap,
      av123RateMode: state.av123RateMode,
      av123RateCap: state.av123RateCap,
      activeMissavRateCap: Number(document.querySelector('[data-missav-rate-cap].active')?.dataset.missavRateCap || 0),
      activeRateCap: Number(document.querySelector('[data-av123-rate-cap].active')?.dataset.av123RateCap || 0),
      missavRateSliderMax: Number(DOM.missavRateCap?.max || 0),
      rateSliderMax: Number(DOM.av123RateCap?.max || 0),
      rateControlCount: document.querySelectorAll('.av123-rate-control').length,
      siteTabButtons: document.querySelectorAll('[data-av123-site-tab]').length,
      visibleSiteTabPanels: [...document.querySelectorAll('[data-av123-site-tab-panel]')].filter(panel => !panel.hidden).length,
      activeSiteTab: state.av123SiteTab,
      autoFavoriteToggle: Boolean(DOM.av123AutoFavorite),
      favoriteRuntimePanel: Boolean(DOM.favoriteRuntimePanel),
      independentFavoriteStop: Boolean(DOM.btnStop123AvFavoriteSite),
      favoriteMethodButtons: document.querySelectorAll('[data-av123-favorite-method]').length,
      favoriteMethod: state.av123FavoriteMethod,
      favoriteSpeedButtons: document.querySelectorAll('[data-favorite-concurrency]').length,
      favoriteConcurrency: state.av123FavoriteConcurrency,
      chromeBridgeConnected: state.chromeFavoriteBridge.connected === true,
      chromeBridgePanel: Boolean(DOM.chromeFavoriteBridgePanel),
      chromePrepareButtons: [DOM.btnPrepareChromeFavoriteSite, DOM.btnPrepareChromeFavorite].filter(Boolean).length,
      activeFavoriteConcurrency: Number(document.querySelector('[data-favorite-concurrency].active')?.dataset.favoriteConcurrency || 0),
      activeMissavSpeed: document.querySelector('[data-speed-site="missav"].active')?.dataset.speedMode,
      activeAv123Speed: document.querySelector('[data-speed-site="av123"].active')?.dataset.speedMode,
      missavSpeedDescription: document.querySelector('[data-speed-description="missav"]')?.textContent,
      av123SpeedDescription: document.querySelector('[data-speed-description="av123"]')?.textContent,
      missavSummary: DOM.runMissavStageSummary?.textContent,
      av123Summary: DOM.run123AvStageSummary?.textContent,
      favoriteSpeedDescription: DOM.favoriteSpeedDescription?.textContent,
      appearanceTheme: document.body.dataset.theme,
      appearancePack: state.appearance.visualPack,
      resumableDeleteVisible: Boolean(DOM.btnDeleteResumableBatch && !DOM.resumeBatchPanel.hidden && !DOM.btnDeleteResumableBatch.hidden),
    };
  })()`);
  window.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 300));
  const siteImage = await window.webContents.capturePage();
  fs.writeFileSync(siteScreenshotPath, siteImage.toPNG());
  await window.webContents.executeJavaScript(`switchSiteWorkspace('missav')`);
  window.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 300));
  const siteMissavImage = await window.webContents.capturePage();
  fs.writeFileSync(siteMissavScreenshotPath, siteMissavImage.toPNG());
  const autoFavoriteResult = await window.webContents.executeJavaScript(`(async () => {
    const autoRunId = api.dbCreateRun({
      name: '123AV 自动收藏流式隔离测试',
      sourceType: 'test',
      sourceLabel: '模拟详情页与模拟账号',
      status: 'paused',
      pipelineVersion: 2,
      av123AutoFavorite: true,
      av123FavoriteConcurrency: 2,
      items: [
        { code: 'AUTO-101', itemStatus: 'queued' },
        { code: 'AUTO-102', itemStatus: 'queued' },
        { code: 'AUTO-103', itemStatus: 'queued' },
        { code: 'AUTO-104', itemStatus: 'queued' },
      ],
    });
    state.preparedRunId = autoRunId;
    state.selectedRunId = autoRunId;
    state.results = api.dbGetRun(autoRunId).items.map(batchItemToResult);
    setSpeedMode('av123', 'flying');
    set123AvRateMode('fixed');
    set123AvRateCap(8);
    set123AvFavoriteConcurrency(2);
    set123AvAutoFavorite(true);
    const originalConfirm = window.confirm;
    window.confirm = () => true;
    await runSiteProcessing(api.dbGetRun(autoRunId), 'av123');
    const runtime = state.favoriteRuntime;
    for (let i = 0; i < 30 && !runtime?.active?.size; i++) await api.sleep(10);
    const crossSiteRunId = api.dbCreateRun({
      name: 'MissAV 与 123AV 收藏跨站并行测试',
      sourceType: 'test',
      sourceLabel: '独立站点队列',
      outputDir: ${JSON.stringify(outputDir)},
      status: 'paused',
      pipelineVersion: 2,
      items: [
        { code: 'CROSS-101', itemStatus: 'queued' },
        { code: 'CROSS-102', itemStatus: 'queued' },
      ],
    });
    const favoriteRunningBeforeMissav = runtime?.running === true;
    await runSiteProcessing(api.dbGetRun(crossSiteRunId), 'missav');
    if (runtime?.promise) await runtime.promise;
    const autoRun = api.dbGetRun(autoRunId);
    const result = {
      autoRunId,
      lookupStatuses: autoRun.items.map(item => item.tasks.av123Lookup.status),
      favoriteStatuses: autoRun.items.map(item => item.tasks.av123Favorite.status),
      autoFavorite: autoRun.av123AutoFavorite,
      favoriteConcurrency: autoRun.av123FavoriteConcurrency,
      runtimeAutomatic: runtime?.auto === true,
      runtimeRunning: runtime?.running === true,
      runtimeCompleted: Number(runtime?.completed || 0),
      runtimeTotal: Number(runtime?.total || 0),
      runtimeSucceeded: Number(runtime?.succeeded || 0),
      runtimeAttempts: Number(runtime?.attempts || 0),
      runtimeRetryScheduled: Number(runtime?.retryScheduled || 0),
      runtimeRoundsStarted: Number(runtime?.roundsStarted || 0),
      queryStillIdleAfterFinish: state.isProcessing === false,
      crossSite: {
        favoriteRunningBeforeMissav,
        missavStatuses: api.dbGetRun(crossSiteRunId).items.map(item => item.tasks.missavLookup.status),
      },
    };
    const rateRunId = api.dbCreateRun({
      name: '123AV 1015 自动冷却测试',
      sourceType: 'test',
      sourceLabel: '模拟 Cloudflare 限速页',
      status: 'paused',
      pipelineVersion: 2,
      items: [{ code: 'RATE-101', itemStatus: 'queued' }],
    });
    api.dbUpdateRunTask(rateRunId, 0, '123av', 'lookup', {
      status: 'succeeded',
      url: 'https://123av.com/cn/v/rate-101',
      error: '',
    });
    const rateStartedAt = Date.now();
    const rateRuntime = startFavoriteRuntime(api.dbGetRun(rateRunId).items, {
      runId: rateRunId,
      accountLabel: 'ui-smoke-account',
      concurrency: 2,
      baseGapMs: 100,
      rateLimitCooldownMs: 1000,
      burstLimit: 0,
      burstRestMs: 0,
    });
    if (rateRuntime?.promise) await rateRuntime.promise;
    result.rateLimitRecovery = {
      completed: Number(rateRuntime?.completed || 0),
      succeeded: Number(rateRuntime?.succeeded || 0),
      attempts: Number(rateRuntime?.attempts || 0),
      rateLimitEvents: Number(rateRuntime?.rateLimitEvents || 0),
      finalGapMs: Number(rateRuntime?.currentGapMs || 0),
      elapsedMs: Date.now() - rateStartedAt,
      finalStatus: api.dbGetRun(rateRunId).items[0].tasks.av123Favorite.status,
    };
    const stopRunId = api.dbCreateRun({
      name: '123AV 收藏独立停止隔离测试',
      sourceType: 'test',
      sourceLabel: '模拟查询继续运行',
      status: 'paused',
      pipelineVersion: 2,
      av123AutoFavorite: true,
      av123FavoriteConcurrency: 2,
      items: [
        { code: 'STOP-101', itemStatus: 'queued' },
        { code: 'STOP-102', itemStatus: 'queued' },
        { code: 'STOP-103', itemStatus: 'queued' },
        { code: 'STOP-104', itemStatus: 'queued' },
      ],
    });
    state.preparedRunId = stopRunId;
    state.selectedRunId = stopRunId;
    state.results = api.dbGetRun(stopRunId).items.map(batchItemToResult);
    const stopLookupPromise = runSiteProcessing(api.dbGetRun(stopRunId), 'av123');
    for (let i = 0; i < 30 && !(state.favoriteRuntime?.running && Number(state.favoriteRuntime.runId) === stopRunId); i++) await api.sleep(20);
    await api.sleep(90);
    const lookupRunningBeforeFavoriteStop = state.isProcessing && Number(state.currentRunId) === stopRunId;
    stop123AvFavorite();
    const lookupContinuedAfterFavoriteStop = state.isProcessing && !state.stopRequested && Number(state.currentRunId) === stopRunId;
    const stoppedRuntime = state.favoriteRuntime;
    await stopLookupPromise;
    if (stoppedRuntime?.promise) await stoppedRuntime.promise;
    const stoppedRun = api.dbGetRun(stopRunId);
    result.independentStop = {
      lookupRunningBeforeFavoriteStop,
      lookupContinuedAfterFavoriteStop,
      lookupStatuses: stoppedRun.items.map(item => item.tasks.av123Lookup.status),
      favoriteStatuses: stoppedRun.items.map(item => item.tasks.av123Favorite.status),
      favoriteStopRequested: stoppedRuntime?.stopRequested === true,
      favoriteCompleted: Number(stoppedRuntime?.completed || 0),
      lookupFinishedNormally: state.isProcessing === false && state.stopRequested === false,
    };
    window.confirm = originalConfirm;
    loadProcessingRunResults(${JSON.stringify(result.uiRunId)});
    return result;
  })()`);
  const syncResult = await window.webContents.executeJavaScript(`(async () => {
    switchPage('sync');
    await refreshRaindropSyncPage();
    await testRaindropAccount({ quiet: true });
    state.raindropSync.runId = Number(state.preparedRunId);
    DOM.raindropBatchSelect.value = String(state.preparedRunId);
    state.raindropSync.collectionId = 11;
    DOM.raindropCollectionSelect.value = '11';
    await buildRaindropSyncPlan({ checkRemote: true });
    const preview = {
      create: state.raindropSync.plan.filter(row => row.action === 'create').length,
      update: state.raindropSync.plan.filter(row => row.action === 'update').length,
      skip: state.raindropSync.plan.filter(row => row.action === 'skip').length,
      error: state.raindropSync.plan.filter(row => row.action === 'error').length,
    };
    const originalConfirm = window.confirm;
    window.confirm = () => true;
    await startRaindropSync();
    window.confirm = originalConfirm;
    const run = api.dbGetRun(state.preparedRunId);
    const defaultPreviewHeight = document.querySelector('.raindrop-preview-table-wrap')?.getBoundingClientRect().height || 0;
    setRaindropPreviewExpanded(true);
    const expandedPosition = getComputedStyle(DOM.raindropPreviewPanel).position;
    const expandedPreviewHeight = document.querySelector('.raindrop-preview-table-wrap')?.getBoundingClientRect().height || 0;
    setRaindropPreviewExpanded(false);
    return {
      activePage: state.activePage,
      activePanels: [...document.querySelectorAll('.app-page.active')].map(panel => panel.dataset.pagePanel),
      accountLabel: state.raindropSync.auth.account?.label,
      collectionId: state.raindropSync.collectionId,
      collectionCount: state.raindropSync.collections.length,
      preview,
      taskStatuses: state.raindropSync.plan.map(row => run.items.find(item => item.position === row.position)?.tasks.raindropSync.status),
      remoteRecords: state.raindropSync.plan.map(row => api.dbGetRemoteSyncRecord('raindrop', row.code)).filter(Boolean).length,
      finalActions: state.raindropSync.plan.map(row => row.action),
      progress: DOM.raindropProgressPercent?.textContent,
      startDisabled: DOM.btnStartRaindropSync?.disabled,
      defaultPreviewHeight,
      expandedPosition,
      expandedPreviewHeight,
      previewRestored: !state.raindropSync.previewExpanded && !document.body.classList.contains('raindrop-preview-expanded'),
      tokenType: DOM.raindropTokenInput?.type,
      tokenValue: DOM.raindropTokenInput?.value,
    };
  })()`);
  await window.webContents.executeJavaScript(`document.querySelectorAll('.toast').forEach(node => node.remove())`);
  window.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 300));
  const syncImage = await window.webContents.capturePage();
  fs.writeFileSync(syncScreenshotPath, syncImage.toPNG());
  const batchResult = await window.webContents.executeJavaScript(`(async () => {
    const pausedRunId = api.dbCreateRun({
      name: 'TG 7月21日晚',
      sourceType: 'file',
      sourceLabel: 'raindrop.csv · 2 条',
      speedMode: 'fast',
      outputDir: ${JSON.stringify(outputDir)},
      items: [
        { code: 'ABF-354', status: 'ok', itemStatus: 'completed', url: 'https://missav.ai/cn/abf-354', finalTags: ['Test Actress', '剧情'], includeInImport: true },
        { code: 'DASS-720', status: 'queued', itemStatus: 'queued' },
      ],
      pipelineVersion: 2,
    });
    api.dbSetRunStatus(pausedRunId, 'paused');
    state.selectedRunId = pausedRunId;
    switchPage('library');
    switchLibraryTab('runs');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const batch = api.dbGetRun(pausedRunId);
    return {
      pausedRunId,
      activePage: state.activePage,
      activeLibraryTab: state.libraryTab,
      activePanels: [...document.querySelectorAll('.app-page.active')].map(panel => panel.dataset.pagePanel),
      runStatus: batch.status,
      pending: batch.pending,
      completed: batch.completed,
      listRows: document.querySelectorAll('.batch-list-row').length,
      itemRows: document.querySelectorAll('.batch-items-table tbody tr').length,
      hasResume: Boolean(document.querySelector('[data-action="run-resume"]')),
      hasSource: document.body.textContent.includes('raindrop.csv · 2 条'),
      hasBatchTab: Boolean(document.querySelector('[data-library-tab="runs"].active')),
      pipelineVersion: batch.pipelineVersion,
      pipelineState: batch.pipelineState,
      pipelineTaskCount: batch.pipelineTaskCount,
      pipelineCompleted: batch.pipelineCompleted,
      stageCards: document.querySelectorAll('.pipeline-stage-metric').length,
      branchPanels: document.querySelectorAll('.pipeline-branch-summary').length,
      branchButtons: document.querySelectorAll('.batch-workspace-switch button').length,
      activeWorkspace: state.runDetailWorkspace,
      taskColumns: document.querySelectorAll('.batch-items-table thead .col-task').length,
      deleteButtons: document.querySelectorAll('[data-action="run-delete"]').length,
      firstTasks: Object.fromEntries(RESULT_STAGE_KEYS.map(key => [key, batch.items[0].tasks[key]?.status || 'missing'])),
    };
  })()`);
  window.showInactive();
  await window.webContents.executeJavaScript(`document.querySelectorAll('.toast').forEach(node => node.remove())`);
  window.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 700));
  const batchImage = await window.webContents.capturePage();
  fs.writeFileSync(batchScreenshotPath, batchImage.toPNG());
  const batch123AvResult = await window.webContents.executeJavaScript(`(async () => {
    state.runDetailWorkspace = 'av123';
    await refreshLibrary();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      activeWorkspace: state.runDetailWorkspace,
      taskColumns: document.querySelectorAll('.batch-items-table thead .col-task').length,
      tagColumns: [...document.querySelectorAll('.batch-items-table thead th')].filter(cell => cell.textContent.trim() === 'Tags').length,
      activeButton: document.querySelector('.batch-workspace-switch button.active')?.textContent.trim(),
    };
  })()`);
  window.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 300));
  const batch123AvImage = await window.webContents.capturePage();
  fs.writeFileSync(batch123AvScreenshotPath, batch123AvImage.toPNG());
  const databaseMaintenanceResult = await window.webContents.executeJavaScript(`(async () => {
    switchPage('library');
    switchLibraryTab('backup');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      activePage: state.activePage,
      activeLibraryTab: state.libraryTab,
      resetButton: Boolean(document.querySelector('[data-action="database-reset-all"]')),
      resetText: document.querySelector('.database-reset-panel')?.textContent || '',
      backupButtons: document.querySelectorAll('[data-action^="backup-"]').length,
      inventoryRows: api.dbGetDatabaseInventory().businessRows,
    };
  })()`);
  window.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 300));
  const databaseMaintenanceImage = await window.webContents.capturePage();
  fs.writeFileSync(databaseMaintenanceScreenshotPath, databaseMaintenanceImage.toPNG());
  const databaseEditorResult = await window.webContents.executeJavaScript(`(async () => {
    switchLibraryTab('raw');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const options = [...document.querySelectorAll('[data-raw-table-select] option')].map(option => option.value);
    return {
      activeLibraryTab: state.libraryTab,
      options,
      grouped: document.querySelectorAll('[data-raw-table-select] optgroup').length,
      bulkToolbar: Boolean(document.querySelector('.raw-bulk-toolbar')),
      copyButton: Boolean(document.querySelector('[data-action="raw-copy-scope"]')),
      exportButton: Boolean(document.querySelector('[data-action="raw-export-scope"]')),
      selectColumn: Boolean(document.querySelector('.raw-select-column')),
    };
  })()`);
  window.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 300));
  const databaseEditorImage = await window.webContents.capturePage();
  fs.writeFileSync(databaseEditorScreenshotPath, databaseEditorImage.toPNG());
  window.setSize(430, 900);
  const mobileResult = await window.webContents.executeJavaScript(`(async () => {
    switchPage('results');
    switchResultWorkspace('av123');
    renderTable();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const wrapper = document.querySelector('.table-wrapper');
    return {
      width: window.innerWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      wrapperClientWidth: wrapper?.clientWidth || 0,
      wrapperScrollWidth: wrapper?.scrollWidth || 0,
      wrapperHeight: wrapper?.getBoundingClientRect().height || 0,
      taskColumns: document.querySelectorAll('#resultTable thead .col-task').length,
      stageFilterWidth: DOM.resultStageFilter?.getBoundingClientRect().width || 0,
      searchWidth: DOM.resultSearch?.getBoundingClientRect().width || 0,
    };
  })()`);
  await window.webContents.executeJavaScript(`document.querySelector('.table-wrapper')?.scrollIntoView({ block: 'start' })`);
  window.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 300));
  const mobileImage = await window.webContents.capturePage();
  fs.writeFileSync(mobileScreenshotPath, mobileImage.toPNG());
  const mobileProcessResult = await window.webContents.executeJavaScript(`(async () => {
    switchPage('sites');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    switchSiteWorkspace('av123');
    switch123AvSiteTab('lookup');
    const visiblePanels = [...document.querySelectorAll('[data-site-workspace-panel]')].filter(panel => !panel.hidden);
    const visibleProvider = visiblePanels[0]?.querySelector('[data-site-provider]')?.getBoundingClientRect();
    const visibleStartButton = visiblePanels[0]?.querySelector('#btnStart123Av')?.getBoundingClientRect();
    return {
      pageScrollWidth: document.documentElement.scrollWidth,
      catalogButtons: document.querySelectorAll('[data-site-workspace]').length,
      visiblePanelCount: visiblePanels.length,
      activeSiteWorkspace: state.siteWorkspace,
      visibleProviderWidth: visibleProvider?.width || 0,
      visibleStartButtonWidth: visibleStartButton?.width || 0,
    };
  })()`);
  await window.webContents.executeJavaScript(`document.querySelector('.site-workbench-layout')?.scrollIntoView({ block: 'start' })`);
  window.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 300));
  const mobileProcessImage = await window.webContents.capturePage();
  fs.writeFileSync(mobileProcessScreenshotPath, mobileProcessImage.toPNG());
  const mobileSyncResult = await window.webContents.executeJavaScript(`(async () => {
    switchPage('sync');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const card = document.querySelector('.raindrop-sync-card')?.getBoundingClientRect();
    return {
      pageScrollWidth: document.documentElement.scrollWidth,
      activePage: state.activePage,
      cardWidth: card?.width || 0,
      metricColumns: getComputedStyle(document.querySelector('.raindrop-sync-metrics')).gridTemplateColumns.split(' ').length,
      previewScrollWidth: document.querySelector('.raindrop-preview-table-wrap')?.scrollWidth || 0,
      previewClientWidth: document.querySelector('.raindrop-preview-table-wrap')?.clientWidth || 0,
    };
  })()`);
  window.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 300));
  const mobileSyncImage = await window.webContents.capturePage();
  fs.writeFileSync(mobileSyncScreenshotPath, mobileSyncImage.toPNG());
  const exportedFiles = fs.readdirSync(outputDir, { recursive: true }).map(String);
  if (homeResult.activePage !== 'home' || homeResult.navButtons !== 5 || homeResult.sidebarToolButtons !== 0 || homeResult.toolCards !== 4 || homeResult.categories !== 2 || homeResult.toolCount !== '4' || homeResult.workspaceHidden !== true || homeResult.taskCards !== 5 || homeResult.taskPage !== 'tasks' || homeResult.databaseLocationButtons !== 2 || !homeResult.databaseLocationShown) {
    throw new Error(`Tool home assertion failed: ${JSON.stringify(homeResult)}`);
  }
  if (result.resultCount !== 6 || result.selectedCount !== 2 || result.retriedStatuses.some(status => status !== 'ok') || result.remainingNetwork !== 1 || result.retryButtons !== 1 || result.tagFilteredRows !== 4 || result.firstSortedCode !== 'SSIS-469' || result.versionBadge !== `v${packageInfo.version}` || result.activePage !== 'results' || !result.exportButtons || !result.deleteBatchVisible || result.taskColumns !== 2 || result.stageFilterOptions !== 2 || result.workspaceButtons !== 2 || result.activeWorkspace !== 'missav' || result.resultTitle !== 'MissAV 处理结果' || !result.tagFilterVisible || result.av123Succeeded !== 3 || !multiImportDialogRequested || !result.multiImport.rawHasBothFiles || result.multiImport.sourceLabel !== '2 个文件' || JSON.stringify(result.multiImport.codes) !== JSON.stringify(['ABF-354', 'GVH-842', 'SSIS-469']) || JSON.stringify(result.multiImport.filteredLines) !== JSON.stringify(result.multiImport.codes) || JSON.stringify(result.firstTasks) !== JSON.stringify({ missavLookup: 'succeeded', raindropSync: 'ready', av123Lookup: 'succeeded', av123Favorite: 'ready' })) {
    throw new Error(`UI smoke assertion failed: ${JSON.stringify(result)}`);
  }
  if (av123Result.activeWorkspace !== 'av123' || av123Result.resultTitle !== '123AV 处理结果' || av123Result.taskColumns !== 2 || av123Result.stageFilterOptions !== 2 || av123Result.sortValues.length !== 5 || av123Result.sortValues.some(value => value.startsWith('tag_')) || av123Result.missavStatusAfterSwitch !== 'all' || av123Result.restoredAv123Status !== 'not_found' || av123Result.actressColumns !== 0 || av123Result.tagFilterVisible || av123Result.exportVisible || av123Result.accountStatus !== 'ready' || !av123Result.accountPanelVisible || av123Result.accountButtons !== 3 || av123Result.favoriteControls !== 4 || av123Result.favoriteStatuses.some(status => status !== 'succeeded') || av123Result.favoriteConcurrency !== 1 || maxActiveFavoriteCalls !== 1 || favoriteWorkerIds.size !== 1 || !favoriteWorkerIds.has(0) || favoriteExecutors.size !== 1 || !favoriteExecutors.has('chrome')) {
    throw new Error(`123AV workspace assertion failed: ${JSON.stringify(av123Result)}`);
  }
  if (processResult.activePage !== 'process' || processResult.activePanels.join(',') !== 'process' || processResult.siteProvidersInsideInput !== 0 || !processResult.hasOpenSitesButton || processResult.navButtons !== 5 || processResult.activeNav !== 'process' || processResult.activeTool !== 'missav' || !processResult.stageVisible) {
    throw new Error(`Input page separation assertion failed: ${JSON.stringify(processResult)}`);
  }
  if (JSON.stringify(toolboxResult.twitter.names) !== JSON.stringify(['KeChunYaoll', 'second_user']) || toolboxResult.twitter.urls.length !== 2 || toolboxResult.twitter.page !== 'twitter' || JSON.stringify(toolboxResult.badnews.urls) !== JSON.stringify(['https://bad.news/t/123']) || toolboxResult.badnews.page !== 'badnews' || toolboxResult.returnedTool !== 'missav') {
    throw new Error(`Toolbox UI assertion failed: ${JSON.stringify(toolboxResult)}`);
  }
  if (sitesResult.activePage !== 'sites' || sitesResult.activePanels.join(',') !== 'sites' || sitesResult.providerCards !== 2 || sitesResult.catalogButtons !== 3 || sitesResult.visibleWorkspacePanels !== 1 || sitesResult.activeSiteWorkspace !== 'av123' || sitesResult.visibleProviders.join(',') !== 'av123' || sitesResult.missavVisibleProviders.join(',') !== 'missav' || sitesResult.branchCards !== 2 || sitesResult.startButtons !== 2 || sitesResult.visibleStopButtons !== 0 || !sitesResult.resumableDeleteVisible || sitesResult.speedPanels !== 2 || sitesResult.missavSpeed !== 'fast' || sitesResult.av123Speed !== 'extreme' || sitesResult.missavSpeedPolicy !== 'balanced' || sitesResult.av123SpeedPolicy !== 'staged' || sitesResult.missavRateMode !== 'adaptive' || sitesResult.missavRateCap !== 24 || sitesResult.activeMissavRateCap !== 24 || sitesResult.missavRateSliderMax !== 32 || sitesResult.av123RateMode !== 'adaptive' || sitesResult.av123RateCap !== 24 || sitesResult.activeRateCap !== 24 || sitesResult.rateSliderMax !== 32 || sitesResult.rateControlCount !== 2 || sitesResult.siteTabButtons !== 2 || sitesResult.visibleSiteTabPanels !== 1 || sitesResult.activeSiteTab !== 'favorite' || !sitesResult.autoFavoriteToggle || !sitesResult.favoriteRuntimePanel || !sitesResult.independentFavoriteStop || sitesResult.favoriteMethodButtons !== 3 || sitesResult.favoriteMethod !== 'chrome' || sitesResult.favoriteSpeedButtons !== 1 || sitesResult.favoriteConcurrency !== 1 || sitesResult.activeFavoriteConcurrency !== 1 || !sitesResult.chromeBridgeConnected || !sitesResult.chromeBridgePanel || sitesResult.chromePrepareButtons !== 2 || sitesResult.activeMissavSpeed !== 'fast' || sitesResult.activeAv123Speed !== 'extreme' || !sitesResult.missavSpeedDescription.includes('最高 24.0') || !sitesResult.missavSpeedDescription.includes('连接重置') || !sitesResult.missavSpeedDescription.includes('最低保留一半') || !sitesResult.av123SpeedDescription.includes('最高 24.0') || !sitesResult.av123SpeedDescription.includes('HTTP 429') || !sitesResult.missavSummary.includes('完成') || !sitesResult.av123Summary.includes('完成') || !sitesResult.favoriteSpeedDescription.includes('同一网站') || sitesResult.appearanceTheme !== 'mint' || sitesResult.appearancePack !== 'none') {
    throw new Error(`Site workbench assertion failed: ${JSON.stringify(sitesResult)}`);
  }
  const autoFavoriteIntervals = autoFavoriteStarts.slice(1).map((startedAt, index) => startedAt - autoFavoriteStarts[index]);
  if (autoFavoriteResult.lookupStatuses.some(status => status !== 'succeeded') || autoFavoriteResult.favoriteStatuses.some(status => status !== 'succeeded') || !autoFavoriteResult.autoFavorite || autoFavoriteResult.favoriteConcurrency !== 1 || !autoFavoriteResult.runtimeAutomatic || autoFavoriteResult.runtimeRunning || autoFavoriteResult.runtimeCompleted !== 4 || autoFavoriteResult.runtimeTotal !== 4 || autoFavoriteResult.runtimeSucceeded !== 4 || autoFavoriteResult.runtimeAttempts !== 5 || autoFavoriteResult.runtimeRetryScheduled !== 1 || autoFavoriteResult.runtimeRoundsStarted !== 2 || !autoFavoriteResult.queryStillIdleAfterFinish || autoFavoriteIntervals.length !== 4 || Math.min(...autoFavoriteIntervals) >= 1000 || !autoFavoriteResult.crossSite.favoriteRunningBeforeMissav || !missavFavoriteOverlap || lookupFavoriteOverlap || autoFavoriteResult.crossSite.missavStatuses.some(status => status !== 'succeeded') || autoFavoriteResult.rateLimitRecovery.completed !== 1 || autoFavoriteResult.rateLimitRecovery.succeeded !== 1 || autoFavoriteResult.rateLimitRecovery.attempts !== 2 || autoFavoriteResult.rateLimitRecovery.rateLimitEvents !== 1 || autoFavoriteResult.rateLimitRecovery.finalGapMs !== 0 || autoFavoriteResult.rateLimitRecovery.elapsedMs < 900 || autoFavoriteResult.rateLimitRecovery.finalStatus !== 'succeeded' || autoFavoriteResult.independentStop.lookupRunningBeforeFavoriteStop || autoFavoriteResult.independentStop.lookupContinuedAfterFavoriteStop || autoFavoriteResult.independentStop.lookupStatuses.some(status => status !== 'succeeded') || autoFavoriteResult.independentStop.favoriteStatuses.some(status => !['succeeded', 'ready'].includes(status)) || !autoFavoriteResult.independentStop.favoriteStatuses.includes('ready') || !autoFavoriteResult.independentStop.favoriteStopRequested || autoFavoriteResult.independentStop.favoriteCompleted < 1 || !autoFavoriteResult.independentStop.lookupFinishedNormally) {
    throw new Error(`123AV automatic favorite assertion failed: ${JSON.stringify({ autoFavoriteResult, lookupFavoriteOverlap })}`);
  }
  if (syncResult.activePage !== 'sync' || syncResult.activePanels.join(',') !== 'sync' || syncResult.accountLabel !== 'ui-raindrop-account' || syncResult.collectionId !== 11 || syncResult.collectionCount !== 2 || syncResult.preview.create < 1 || syncResult.preview.update !== 1 || syncResult.preview.error !== 0 || syncResult.taskStatuses.some(status => status !== 'succeeded') || syncResult.remoteRecords !== syncResult.taskStatuses.length || syncResult.finalActions.some(action => !['skip', 'error'].includes(action)) || syncResult.progress !== '100%' || !syncResult.startDisabled || syncResult.defaultPreviewHeight < 400 || syncResult.expandedPosition !== 'fixed' || syncResult.expandedPreviewHeight <= syncResult.defaultPreviewHeight || !syncResult.previewRestored || syncResult.tokenType !== 'password' || syncResult.tokenValue !== '') {
    throw new Error(`Raindrop sync UI assertion failed: ${JSON.stringify(syncResult)}`);
  }
  if (!exportedFiles.some(file => file.endsWith('标签导出索引.csv')) || !exportedFiles.some(file => file.endsWith('剧情.html'))) {
    throw new Error(`Tag export assertion failed: ${JSON.stringify(exportedFiles)}`);
  }
  if (batchResult.activePage !== 'library' || batchResult.activeLibraryTab !== 'runs' || batchResult.activePanels.join(',') !== 'library' || batchResult.runStatus !== 'paused' || batchResult.pending !== 1 || batchResult.completed !== 1 || batchResult.listRows < 2 || batchResult.itemRows !== 2 || !batchResult.hasResume || !batchResult.hasSource || !batchResult.hasBatchTab || batchResult.pipelineVersion !== 2 || batchResult.pipelineState !== 'pending' || batchResult.pipelineTaskCount !== 8 || batchResult.pipelineCompleted !== 1 || batchResult.stageCards !== 4 || batchResult.branchPanels !== 2 || batchResult.branchButtons !== 2 || batchResult.deleteButtons !== 1 || batchResult.activeWorkspace !== 'missav' || batchResult.taskColumns !== 2 || JSON.stringify(batchResult.firstTasks) !== JSON.stringify({ missavLookup: 'succeeded', raindropSync: 'ready', av123Lookup: 'queued', av123Favorite: 'blocked' })) {
    throw new Error(`Batch UI smoke assertion failed: ${JSON.stringify(batchResult)}`);
  }
  if (batch123AvResult.activeWorkspace !== 'av123' || batch123AvResult.taskColumns !== 2 || batch123AvResult.tagColumns !== 0 || batch123AvResult.activeButton !== '123AV 明细') {
    throw new Error(`Batch 123AV workspace assertion failed: ${JSON.stringify(batch123AvResult)}`);
  }
  if (databaseMaintenanceResult.activePage !== 'library' || databaseMaintenanceResult.activeLibraryTab !== 'backup' || !databaseMaintenanceResult.resetButton || !databaseMaintenanceResult.resetText.includes('Windows 安全存储') || databaseMaintenanceResult.backupButtons < 4 || databaseMaintenanceResult.inventoryRows <= 0) {
    throw new Error(`Database maintenance UI assertion failed: ${JSON.stringify(databaseMaintenanceResult)}`);
  }
  if (databaseEditorResult.activeLibraryTab !== 'raw' || !databaseEditorResult.options.includes('site_lookup_cache') || !databaseEditorResult.options.includes('remote_sync_records') || databaseEditorResult.grouped < 5 || !databaseEditorResult.bulkToolbar || !databaseEditorResult.copyButton || !databaseEditorResult.exportButton || !databaseEditorResult.selectColumn) {
    throw new Error(`Database editor UI assertion failed: ${JSON.stringify(databaseEditorResult)}`);
  }
  if (mobileResult.width > 440 || mobileResult.pageScrollWidth > mobileResult.width + 1 || mobileResult.wrapperScrollWidth <= mobileResult.wrapperClientWidth || mobileResult.wrapperHeight < 300 || mobileResult.taskColumns !== 2 || mobileResult.stageFilterWidth < 250 || mobileResult.searchWidth < 250) {
    throw new Error(`Mobile UI smoke assertion failed: ${JSON.stringify(mobileResult)}`);
  }
  if (mobileProcessResult.pageScrollWidth > 417 || mobileProcessResult.catalogButtons !== 3 || mobileProcessResult.visiblePanelCount !== 1 || mobileProcessResult.activeSiteWorkspace !== 'av123' || mobileProcessResult.visibleProviderWidth < 300 || mobileProcessResult.visibleStartButtonWidth < 250) {
    throw new Error(`Mobile process UI assertion failed: ${JSON.stringify(mobileProcessResult)}`);
  }
  if (mobileSyncResult.pageScrollWidth > 417 || mobileSyncResult.activePage !== 'sync' || mobileSyncResult.cardWidth < 340 || mobileSyncResult.metricColumns !== 2 || mobileSyncResult.previewScrollWidth <= mobileSyncResult.previewClientWidth) {
    throw new Error(`Mobile Raindrop sync UI assertion failed: ${JSON.stringify(mobileSyncResult)}`);
  }
  process.stdout.write(JSON.stringify({ homeResult, result, av123Result, processResult, toolboxResult, sitesResult, autoFavoriteResult, lookupFavoriteOverlap, syncResult, batchResult, batch123AvResult, mobileResult, mobileProcessResult, mobileSyncResult, homeScreenshotPath, screenshotPath, av123ScreenshotPath, processScreenshotPath, toolboxScreenshotPath, siteScreenshotPath, siteMissavScreenshotPath, syncScreenshotPath, batchScreenshotPath, batch123AvScreenshotPath, mobileScreenshotPath, mobileProcessScreenshotPath, mobileSyncScreenshotPath, exportedFiles, scratchDir }, null, 2));
  await window.close();
  coreService.close();
  app.quit();
}

run().catch(error => {
  process.stderr.write(error.stack || error.message);
  app.exit(1);
});
