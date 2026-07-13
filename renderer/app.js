/**
 * MissAV Manager — 前端主逻辑 v0.1
 * 数据存储使用 SQLite 数据库（替代旧 CSV 读写）
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const DOM = {};
const api = window.electronAPI;
const APPEARANCE_KEY = 'missav_manager_appearance';
const APPEARANCE_VERSION = 3;
const CSV_RECENT_KEY = 'missav_manager_csv_recent';
const VISUAL_PACKS = {
  none: null,
  'neon-rain': { asset: '../assets/visual-packs/midnight/neon-rain.png' },
  'velvet-perfume': { asset: '../assets/visual-packs/midnight/velvet-perfume.png' },
  'vinyl-cocktail': { asset: '../assets/visual-packs/midnight/vinyl-cocktail.png' },
  'city-after-rain': { asset: '../assets/visual-packs/midnight/city-after-rain.png' },
};

const state = {
  outputDirPath: '',
  inputCodes: [],
  results: [],
  isProcessing: false,
  stopRequested: false,
  stats: { total: 0, new: 0, exists: 0, notFound: 0, duplicate: 0 },
  activeTab: 'all',
  history: [],
  dbReady: false,
  libraryTab: 'codes',
  dataMode: 'library',
  activePage: 'process',
  libraryActresses: [],
  libraryCodes: [],
  libraryCodeAllRows: [],
  codeSelected: new Set(),
  selectedCodeId: null,
  codeStatusFilter: 'all',
  codeCollectionFilter: 'all',
  codeCollectionCollapsed: new Set(),
  codeSort: 'recent',
  codePage: 1,
  codePageSize: 160,
  collectionMap: { collection: 'all', tag: '', riskOnly: false },
  reviewDeck: { queue: 'priority', index: 0, done: 0, skipped: 0 },
  importCompare: { text: '', rows: [], policy: 'new_only', filter: 'all', selected: new Set(), metadataByKey: new Map(), sourceLabel: '' },
  libraryGenres: [],
  rawDbTable: 'codes',
  rawDbTables: [],
  rawDbData: null,
  healthReport: null,
  backupRows: [],
  appearance: { theme: 'midnight', visualPack: 'neon-rain', density: 'comfortable', bgImagePath: '', bgDim: 35, version: APPEARANCE_VERSION },
  csv: { filePath: '', headers: [], rows: [], selectedRows: new Set(), focusedRow: null, isRaindrop: false, dirty: false, analysis: null, recent: [] },
};

// ─── 初始化 ──────────────────────────────────────────
function init() {
  DOM.codeInput = $('#codeInput');
  DOM.codeCount = $('#codeCount');
  DOM.tagCollectionPath = $('#tagCollectionPath');
  DOM.outputDirPath = $('#outputDirPath');
  DOM.outputDirPathMirror = $('#outputDirPathMirror');
  DOM.btnSelectOutputDirMirror = $('#btnSelectOutputDirMirror');
  DOM.btnSelectTagFile = $('#btnSelectTagFile');
  DOM.btnSelectOutputDir = $('#btnSelectOutputDir');
  DOM.btnStart = $('#btnStart');
  DOM.btnStop = $('#btnStop');
  DOM.btnClearInput = $('#btnClearInput');
  DOM.btnPasteSample = $('#btnPasteSample');
  DOM.btnImportTextFile = $('#btnImportTextFile');
  DOM.btnImportTextFiles = $('#btnImportTextFiles');
  DOM.btnCopyCodes = $('#btnCopyCodes');
  DOM.btnExportCodeList = $('#btnExportCodeList');
  DOM.inputSourceInfo = $('#inputSourceInfo');
  DOM.dbSummaryMini = $('#dbSummaryMini');
  DOM.btnOpenLibraryFromPanel = $('#btnOpenLibraryFromPanel');
  DOM.themeSelect = $('#themeSelect');
  DOM.visualPackSelect = $('#visualPackSelect');
  DOM.visualPackCards = $$('[data-visual-pack]');
  DOM.uiDensitySelect = $('#uiDensitySelect');
  DOM.btnSelectBgImage = $('#btnSelectBgImage');
  DOM.btnClearBgImage = $('#btnClearBgImage');
  DOM.bgDimRange = $('#bgDimRange');
  DOM.bgDimValue = $('#bgDimValue');
  DOM.backgroundLayer = $('#backgroundLayer');
  DOM.statusDot = document.querySelector('#statusBar .status-dot');
  DOM.statusText = document.querySelector('#statusBar .status-text');
  DOM.statTotal = $('#statTotal');
  DOM.statNew = $('#statNew');
  DOM.statExists = $('#statExists');
  DOM.statNotFound = $('#statNotFound');
  DOM.statDuplicate = $('#statDuplicate');
  DOM.progressContainer = $('#progressContainer');
  DOM.progressFill = $('#progressFill');
  DOM.progressCurrent = $('#progressCurrent');
  DOM.progressTotal = $('#progressTotal');
  DOM.progressPercent = $('#progressPercent');
  DOM.resultBody = $('#resultBody');
  DOM.exportBar = $('#exportBar');
  DOM.btnExportAll = $('#btnExportAll');
  DOM.btnExportHTML = $('#btnExportHTML');
  DOM.btnExportCSV = $('#btnExportCSV');
  DOM.btnOpenFolder = $('#btnOpenFolder');
  DOM.toastContainer = $('#toastContainer');
  DOM.modalHistory = $('#modalHistory');
  DOM.modalHelp = $('#modalHelp');
  DOM.modalLibrary = $('#modalLibrary');
  DOM.libraryContent = $('#libraryContent');
  DOM.librarySearch = $('#librarySearch');
  DOM.dbPathValue = $('#dbPathValue');
  DOM.pageButtons = $$('.nav-btn[data-page]');
  DOM.pagePanels = $$('.app-page[data-page-panel]');
  DOM.dataModeButtons = $$('[data-data-mode]');
  DOM.dataModePanels = $$('[data-data-mode-panel]');
  DOM.csvFileInfo = $('#csvFileInfo');
  DOM.csvDirtyBadge = $('#csvDirtyBadge');
  DOM.csvFilePath = $('#csvFilePath');
  DOM.btnCsvOpen = $('#btnCsvOpen');
  DOM.btnCsvSave = $('#btnCsvSave');
  DOM.btnCsvSaveAs = $('#btnCsvSaveAs');
  DOM.btnCsvBackup = $('#btnCsvBackup');
  DOM.btnCsvAddRow = $('#btnCsvAddRow');
  DOM.btnCsvAddColumn = $('#btnCsvAddColumn');
  DOM.btnCsvDeleteRows = $('#btnCsvDeleteRows');
  DOM.btnCsvNormalizeCodes = $('#btnCsvNormalizeCodes');
  DOM.btnCsvReplace = $('#btnCsvReplace');
  DOM.btnCsvImportDb = $('#btnCsvImportDb');
  DOM.btnCsvValidate = $('#btnCsvValidate');
  DOM.csvSearch = $('#csvSearch');
  DOM.csvStatusFilter = $('#csvStatusFilter');
  DOM.csvTable = $('#csvTable');
  DOM.csvTableHead = $('#csvTableHead');
  DOM.csvTableBody = $('#csvTableBody');
  DOM.csvFooter = $('#csvFooter');
  DOM.csvIssueList = $('#csvIssueList');
  DOM.csvDetailEditor = $('#csvDetailEditor');
  DOM.csvRecentList = $('#csvRecentList');
  DOM.csvMetricRows = $('#csvMetricRows');
  DOM.csvMetricCols = $('#csvMetricCols');
  DOM.csvMetricIssues = $('#csvMetricIssues');
  DOM.csvMetricSelected = $('#csvMetricSelected');

  loadAppearance();
  applyAppearance();
  checkDbReady();
  loadHistory();
  loadCsvRecent();
  bindEvents();
  updateUI();
}

// ─── 外观设置 ────────────────────────────────────────
function loadAppearance() {
  try {
    const saved = JSON.parse(localStorage.getItem(APPEARANCE_KEY) || '{}');
    state.appearance = { ...state.appearance, ...saved };
    if (Number(saved.version || 0) < APPEARANCE_VERSION) {
      state.appearance.theme = 'midnight';
      state.appearance.visualPack = 'neon-rain';
      state.appearance.version = APPEARANCE_VERSION;
      saveAppearance();
    }
  } catch {}
}

function saveAppearance() {
  try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(state.appearance)); } catch {}
}

function switchPage(page) {
  state.activePage = page;
  DOM.pageButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.page === page));
  DOM.pagePanels.forEach(panel => panel.classList.toggle('active', panel.dataset.pagePanel === page));
  if (page === 'library') renderDataWorkbench();
  if (page === 'results') renderTable();
}

function switchDataMode(mode) {
  state.dataMode = mode || 'library';
  DOM.dataModeButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.dataMode === state.dataMode));
  DOM.dataModePanels.forEach(panel => panel.classList.toggle('active', panel.dataset.dataModePanel === state.dataMode));
  renderDataWorkbench();
}

function renderDataWorkbench() {
  if (state.dataMode === 'csv') renderCsvWorkbench();
  else refreshLibrary();
}

function setAppearance(patch) {
  state.appearance = { ...state.appearance, ...patch, version: APPEARANCE_VERSION };
  applyAppearance();
  saveAppearance();
}

function applyAppearance() {
  const a = state.appearance;
  const packKey = VISUAL_PACKS[a.visualPack] ? a.visualPack : 'none';
  const pack = VISUAL_PACKS[packKey];
  document.body.dataset.theme = a.theme || 'midnight';
  document.body.dataset.density = a.density || 'comfortable';
  document.body.style.setProperty('--bg-dim', `${Number(a.bgDim ?? 35)}%`);
  document.body.style.setProperty('--bg-dim-alpha', String(Number(a.bgDim ?? 35) / 100));

  const backgroundUrl = a.bgImagePath
    ? `url("${toFileUrl(a.bgImagePath)}")`
    : pack ? `url("${toAssetUrl(pack.asset)}")` : '';
  if (backgroundUrl) {
    document.body.style.setProperty('--custom-bg', backgroundUrl);
  } else {
    document.body.style.removeProperty('--custom-bg');
  }
  document.body.classList.toggle('has-visual-pack', !a.bgImagePath && Boolean(pack));
  if (a.bgImagePath) {
    document.body.classList.add('has-custom-bg');
  } else {
    document.body.classList.remove('has-custom-bg');
  }

  if (DOM.themeSelect) DOM.themeSelect.value = a.theme || 'midnight';
  if (DOM.visualPackSelect) DOM.visualPackSelect.value = packKey;
  if (DOM.visualPackCards) DOM.visualPackCards.forEach(card => card.classList.toggle('active', card.dataset.visualPack === packKey));
  if (DOM.uiDensitySelect) DOM.uiDensitySelect.value = a.density || 'comfortable';
  if (DOM.bgDimRange) DOM.bgDimRange.value = Number(a.bgDim ?? 35);
  if (DOM.bgDimValue) DOM.bgDimValue.textContent = `${Number(a.bgDim ?? 35)}%`;
}

function toFileUrl(filePath) {
  return 'file:///' + String(filePath || '')
    .replace(/\\/g, '/')
    .split('/')
    .map(part => encodeURIComponent(part))
    .join('/');
}

function toAssetUrl(assetPath) {
  return new URL(assetPath, window.location.href).href;
}

async function selectBackgroundImage() {
  const filePath = await api.openFile({
    title: '选择背景图片',
    filters: [
      { name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (!filePath) return;
  setAppearance({ bgImagePath: filePath });
  toast(`已设置背景图：${fileName(filePath)}`, 'success');
}

function refreshDbSummary() {
  if (!state.dbReady || !DOM.dbSummaryMini) return;
  const stats = api.dbGetStats();
  const bookmarkStats = api.dbGetBookmarkStats();
  DOM.dbSummaryMini.textContent = `${bookmarkStats.count} 收藏 / ${stats.codeCount} 番号 / ${bookmarkStats.collectionCount} Collections`;
  DOM.tagCollectionPath.textContent = `Raindrop 兼容主库 (${bookmarkStats.count} 收藏, ${stats.codeCount} 番号索引)`;
  if (DOM.dbPathValue) DOM.dbPathValue.textContent = api.dbGetPath ? api.dbGetPath() : 'data';
}
// ─── 数据库状态检查 ──────────────────────────────────
async function checkDbReady() {
  let attempts = 0;
  while (!api.dbIsReady() && attempts < 50) { await api.sleep(200); attempts++; }

  if (api.dbIsReady()) {
    state.dbReady = true;
    refreshDbSummary();
    setStatus('就绪 ✓ 数据库已加载', null, null, null);
    updateUI();
  } else {
    const err = api.dbGetError();
    DOM.tagCollectionPath.textContent = '数据库加载失败';
    if (DOM.dbPathValue) DOM.dbPathValue.textContent = '数据库加载失败';
    if (DOM.dbSummaryMini) DOM.dbSummaryMini.textContent = '数据库未就绪';
    setStatus(null, null, null, `数据库错误: ${err}`);
    toast(`数据库初始化失败: ${err}`, 'error');
  }
}
function loadHistory() {
  try { const raw = localStorage.getItem('missav_manager_history'); if (raw) state.history = JSON.parse(raw); } catch {}
}
function saveHistory() {
  try { if (state.history.length > 50) state.history = state.history.slice(-50); localStorage.setItem('missav_manager_history', JSON.stringify(state.history)); } catch {}
}
function addHistory(summary) { state.history.push({ time: new Date().toISOString(), summary }); saveHistory(); }

// ─── 事件绑定 ────────────────────────────────────────
function bindEvents() {
  DOM.btnSelectOutputDir.addEventListener('click', selectOutputDir);
  if (DOM.btnSelectOutputDirMirror) DOM.btnSelectOutputDirMirror.addEventListener('click', selectOutputDir);
  DOM.btnSelectTagFile.addEventListener('click', importCSVToDb);
  DOM.btnStart.addEventListener('click', startProcessing);
  DOM.btnStop.addEventListener('click', stopProcessing);
  DOM.btnClearInput.addEventListener('click', clearAll);
  DOM.btnPasteSample.addEventListener('click', pasteSample);
  DOM.btnImportTextFile.addEventListener('click', () => importTextFile(false));
  if (DOM.btnImportTextFiles) DOM.btnImportTextFiles.addEventListener('click', () => importTextFile(true));
  if (DOM.btnCopyCodes) DOM.btnCopyCodes.addEventListener('click', copyParsedCodes);
  if (DOM.btnExportCodeList) DOM.btnExportCodeList.addEventListener('click', exportCodeList);
  DOM.pageButtons.forEach(btn => btn.addEventListener('click', () => switchPage(btn.dataset.page)));
  if (DOM.dataModeButtons) DOM.dataModeButtons.forEach(btn => btn.addEventListener('click', () => switchDataMode(btn.dataset.dataMode)));
  if (DOM.btnCsvOpen) DOM.btnCsvOpen.addEventListener('click', () => openCsvFile());
  if (DOM.btnCsvSave) DOM.btnCsvSave.addEventListener('click', saveCsvFile);
  if (DOM.btnCsvSaveAs) DOM.btnCsvSaveAs.addEventListener('click', saveCsvAs);
  if (DOM.btnCsvBackup) DOM.btnCsvBackup.addEventListener('click', backupCsvFile);
  if (DOM.btnCsvAddRow) DOM.btnCsvAddRow.addEventListener('click', addCsvRow);
  if (DOM.btnCsvAddColumn) DOM.btnCsvAddColumn.addEventListener('click', addCsvColumn);
  if (DOM.btnCsvDeleteRows) DOM.btnCsvDeleteRows.addEventListener('click', deleteSelectedCsvRows);
  if (DOM.btnCsvNormalizeCodes) DOM.btnCsvNormalizeCodes.addEventListener('click', normalizeCsvCodes);
  if (DOM.btnCsvReplace) DOM.btnCsvReplace.addEventListener('click', batchReplaceCsv);
  if (DOM.btnCsvImportDb) DOM.btnCsvImportDb.addEventListener('click', importWorkbenchCsvToDb);
  if (DOM.btnCsvValidate) DOM.btnCsvValidate.addEventListener('click', () => { analyzeCsv(); renderCsvMeta(); renderCsvTable(); });
  if (DOM.csvSearch) DOM.csvSearch.addEventListener('input', debounce(renderCsvTable, 180));
  if (DOM.csvStatusFilter) DOM.csvStatusFilter.addEventListener('change', renderCsvTable);
  if (DOM.csvTable) DOM.csvTable.addEventListener('input', handleCsvTableInput);
  if (DOM.csvTable) DOM.csvTable.addEventListener('change', handleCsvTableChange);
  if (DOM.csvTable) DOM.csvTable.addEventListener('click', handleCsvTableClick);
  if (DOM.csvTable) DOM.csvTable.addEventListener('focusin', handleCsvTableFocusIn);
  if (DOM.csvDetailEditor) DOM.csvDetailEditor.addEventListener('input', handleCsvDetailInput);
  if (DOM.csvDetailEditor) DOM.csvDetailEditor.addEventListener('change', handleCsvDetailInput);
  if (DOM.csvIssueList) DOM.csvIssueList.addEventListener('click', handleCsvIssueClick);
  if (DOM.csvRecentList) DOM.csvRecentList.addEventListener('click', handleCsvRecentClick);

  $$('.table-tabs .tab-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  DOM.btnExportAll.addEventListener('click', exportAll);
  DOM.btnExportHTML.addEventListener('click', exportHTMLOnly);
  DOM.btnExportCSV.addEventListener('click', exportCSVOnly);
  DOM.btnOpenFolder.addEventListener('click', openOutputFolder);
  DOM.resultBody.addEventListener('click', handleResultTableClick);
  DOM.btnOpenLibraryFromPanel.addEventListener('click', openLibraryModal);
  DOM.themeSelect.addEventListener('change', () => {
    const theme = DOM.themeSelect.value;
    setAppearance({ theme, visualPack: theme === 'midnight' && state.appearance.visualPack === 'none' ? 'neon-rain' : state.appearance.visualPack });
  });
  if (DOM.visualPackSelect) DOM.visualPackSelect.addEventListener('change', () => setAppearance({ visualPack: DOM.visualPackSelect.value }));
  if (DOM.visualPackCards) DOM.visualPackCards.forEach(card => card.addEventListener('click', () => setAppearance({ visualPack: card.dataset.visualPack })));
  DOM.uiDensitySelect.addEventListener('change', () => setAppearance({ density: DOM.uiDensitySelect.value }));
  DOM.btnSelectBgImage.addEventListener('click', selectBackgroundImage);
  DOM.btnClearBgImage.addEventListener('click', () => setAppearance({ bgImagePath: '' }));
  DOM.bgDimRange.addEventListener('input', () => setAppearance({ bgDim: Number(DOM.bgDimRange.value) }));

  DOM.codeInput.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); if (!state.isProcessing) startProcessing(); }
  });
  DOM.codeInput.addEventListener('input', () => { parseInputCodes('手动输入'); updateUI(); });

  $('#btnHistory').addEventListener('click', () => { DOM.modalHistory.style.display = 'flex'; renderHistory(); });
  $('#btnCloseHistory').addEventListener('click', () => { DOM.modalHistory.style.display = 'none'; });
  $('#btnHelp').addEventListener('click', () => { DOM.modalHelp.style.display = 'flex'; });
  $('#btnCloseHelp').addEventListener('click', () => { DOM.modalHelp.style.display = 'none'; });
  $('#btnSettings').addEventListener('click', () => switchPage('settings'));
  const closeLibraryBtn = $('#btnCloseLibrary');
  if (closeLibraryBtn && DOM.modalLibrary) closeLibraryBtn.addEventListener('click', () => { DOM.modalLibrary.style.display = 'none'; });
  $('#btnRefreshLibrary').addEventListener('click', refreshLibrary);
  $('#btnExportDbCSV').addEventListener('click', exportDbCSVFromLibrary);
  DOM.librarySearch.addEventListener('input', debounce(refreshLibrary, 250));
  $$('.library-tabs .tab-btn').forEach(btn => btn.addEventListener('click', () => switchLibraryTab(btn.dataset.libraryTab)));
  DOM.libraryContent.addEventListener('click', handleLibraryAction);
  DOM.libraryContent.addEventListener('change', handleLibraryChange);
  DOM.libraryContent.addEventListener('input', handleLibraryInput);
  DOM.libraryContent.addEventListener('keydown', handleLibraryKeydown);
  DOM.libraryContent.addEventListener('focusout', handleLibraryFocusOut);
  DOM.libraryContent.addEventListener('contextmenu', handleLibraryContextMenu);
  document.addEventListener('click', event => { if (!event.target.closest('.collection-context-menu')) closeCollectionContextMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeCollectionContextMenu(); });
  DOM.modalHistory.addEventListener('click', e => { if (e.target === DOM.modalHistory) DOM.modalHistory.style.display = 'none'; });
  DOM.modalHelp.addEventListener('click', e => { if (e.target === DOM.modalHelp) DOM.modalHelp.style.display = 'none'; });
  if (DOM.modalLibrary) DOM.modalLibrary.addEventListener('click', e => { if (e.target === DOM.modalLibrary) DOM.modalLibrary.style.display = 'none'; });
}

// ─── Raindrop / 旧合集导入 ───────────────────────────
async function importCSVToDb() {
  const filePaths = await api.openFile({
    title: '选择 Raindrop 官方 CSV / HTML 或旧女优 Tag 合集',
    multiSelections: true,
    filters: [{ name: 'Raindrop 与 CSV 文件', extensions: ['csv', 'html', 'htm'] }],
  });
  if (!filePaths || !filePaths.length) return;
  try {
    setStatus(null, '正在导入收藏数据库...', null, null);
    api.dbCreateBackup('before_raindrop_import', 'import');
    const records = [];
    let legacyImported = 0;
    for (const filePath of filePaths) {
      const text = await api.readFile(filePath);
      if (/\.html?$/i.test(filePath)) {
        records.push(...api.parseRaindropHTML(text));
        continue;
      }
      const parsed = api.csvParse(text);
      const headers = new Set((parsed.headers || []).map(header => String(header || '').trim().toLowerCase()));
      if (headers.has('url') && headers.has('title') && headers.has('folder')) records.push(...api.parseRaindropCSV(text));
      else legacyImported += Number(api.dbImportCSV(text)?.imported || 0);
    }
    const result = records.length ? api.dbImportRaindropRecords(records, { mode: 'merge' }) : { imported: 0, updated: 0, codeLinked: 0 };
    const stats = api.dbGetStats();
    refreshDbSummary();
    setStatus('就绪 ✓', null, null, null);
    toast(`导入完成：新增收藏 ${result.imported}，更新 ${result.updated}，同步番号 ${result.codeLinked}，旧合集关系 ${legacyImported}；当前番号索引 ${stats.codeCount}`, 'success');
    await refreshLibrary();
    updateUI();
  } catch (err) { toast(`导入失败: ${err.message}`, 'error'); }
}
// ─── 输出目录选择 ────────────────────────────────────
async function selectOutputDir() {
  const dp = await api.openDirectory({ title: '选择基础输出目录' });
  if (!dp) return;
  state.outputDirPath = dp;
  DOM.outputDirPath.textContent = shortenPath(dp);
  if (DOM.outputDirPathMirror) DOM.outputDirPathMirror.textContent = shortenPath(dp);
  updateUI();
}

// ─── 输入解析 ────────────────────────────────────────
function parseInputCodes(label = '已识别') {
  state.inputCodes = api.parseCodeList(DOM.codeInput.value);
  DOM.codeCount.textContent = `${state.inputCodes.length} 条`;
  if (DOM.inputSourceInfo) DOM.inputSourceInfo.textContent = `${label} · ${state.inputCodes.length} 条`;
}
// ─── UI 更新 ─────────────────────────────────────────
function updateUI() {
  DOM.btnStart.disabled = !(state.inputCodes.length > 0 && state.dbReady && state.outputDirPath && !state.isProcessing);
  DOM.btnSelectTagFile.textContent = state.dbReady ? '导入 CSV' : '等待数据库...';
}

function setStatus(idle, running, done, error) {
  DOM.statusDot.className = 'status-dot';
  if (idle) { DOM.statusDot.classList.add('status-idle'); DOM.statusText.textContent = idle; }
  if (running) { DOM.statusDot.classList.add('status-running'); DOM.statusText.textContent = running; }
  if (done) { DOM.statusDot.classList.add('status-done'); DOM.statusText.textContent = done; }
  if (error) { DOM.statusDot.classList.add('status-error'); DOM.statusText.textContent = error; }
}

function updateStats() {
  DOM.statTotal.textContent = state.stats.total;
  DOM.statNew.textContent = state.stats.new;
  DOM.statExists.textContent = state.stats.exists;
  DOM.statNotFound.textContent = state.stats.notFound;
  DOM.statDuplicate.textContent = state.stats.duplicate;
}

function updateProgress(cur, total) {
  const pct = total > 0 ? Math.round((cur / total) * 100) : 0;
  DOM.progressFill.style.width = `${pct}%`;
  DOM.progressCurrent.textContent = cur;
  DOM.progressTotal.textContent = total;
  DOM.progressPercent.textContent = `${pct}%`;
}

// ─── 表格渲染 ────────────────────────────────────────
function renderTable() {
  const rows = getFilteredResults();
  if (!rows.length) {
    DOM.resultBody.innerHTML = `<tr class="empty-row"><td colspan="7"><div class="empty-state visual-empty-state"><span class="empty-icon">🎯</span><p>输入番号并点击「开始处理」</p></div></td></tr>`;
    return;
  }
  DOM.resultBody.innerHTML = rows.map(r => `
    <tr>
      <td class="col-code">${esc(r.code)}</td>
      <td class="col-url"><a href="#" data-result-url="${esc(r.url)}" title="${esc(r.url)}">${esc(shortUrl(r.url))}</a></td>
      <td class="col-status"><span class="status-badge ${statusClass(r)}">${statusLabel(r)}</span></td>
      <td class="col-actress">${(r.actresses||[]).map(t => `<span class="tag-chip">${esc(t)}</span>`).join('') || '-'}</td>
      <td class="col-genre">${(r.genres||[]).map(t => `<span class="tag-chip">${esc(t)}</span>`).join('') || '-'}</td>
      <td class="col-final">${r.finalTags.map(t => {
        let cls = 'tag-chip';
        if (t === api.UNKNOWN_ACTRESS_TAG) cls += ' tag-unknown';
        if (t === api.NEED_CHECK_TAG) cls += ' tag-needcheck';
        return `<span class="${cls}">${esc(t)}</span>`;
      }).join('') || '-'}</td>
      <td class="col-note">${esc(r.skippedReason || '-')}</td>
    </tr>`).join('');
}

async function handleResultTableClick(event) {
  const link = event.target.closest('[data-result-url]');
  if (!link) return;
  event.preventDefault();
  try {
    await api.openExternal(link.dataset.resultUrl);
  } catch (err) {
    toast(`无法打开链接: ${err.message}`, 'error');
  }
}

function getFilteredResults() {
  switch (state.activeTab) { case 'new': return state.results.filter(r => r.includeInImport && !api.isManualVerifyRow(r)); case 'skipped': return state.results.filter(r => !r.includeInImport); case 'manual': return state.results.filter(r => r.includeInImport && api.isManualVerifyRow(r)); default: return state.results; }
}
function statusClass(r) {
  if (!r.includeInImport) return 'status-skipped';
  switch (r.status) { case 'ok': return 'status-ok'; case 'not_found': return 'status-not_found'; case 'no_actress_found': return 'status-no_actress'; case 'need_manual_check': case 'page_ok_play_unknown': return 'status-manual'; default: return ''; }
}
function statusLabel(r) {
  if (!r.includeInImport) return r.skippedReason || '已跳过';
  switch (r.status) { case 'ok': return '✓ 正常'; case 'not_found': return '✗ 未找到'; case 'no_actress_found': return '⚠ 无女优'; case 'need_manual_check': return '⚠ 可点待核验'; case 'page_ok_play_unknown': return '⚠ 不确定'; default: return r.status; }
}
function switchTab(tab) { state.activeTab = tab; $$('.table-tabs .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab)); renderTable(); }

// ─── 核心处理流程（数据库版） ────────────────────────
async function startProcessing() {
  if (state.isProcessing) return;
  parseInputCodes();
  if (!state.inputCodes.length) { toast('请先输入番号', 'error'); return; }
  if (!state.dbReady) { toast('数据库未就绪，请等待加载完成', 'error'); return; }
  if (!state.outputDirPath) { toast('请先选择输出目录', 'error'); return; }

  state.isProcessing = true; state.stopRequested = false; state.results = [];
  state.stats = { total: 0, new: 0, exists: 0, notFound: 0, duplicate: 0 };

  DOM.btnStart.style.display = 'none'; DOM.btnStop.style.display = 'block';
  DOM.progressContainer.style.display = 'block'; DOM.exportBar.style.display = 'none';
  setStatus(null, '正在处理...', null, null);
  updateStats(); renderTable(); updateProgress(0, state.inputCodes.length);

  // 输入内部去重
  const uniqueCodes = []; const seen = new Set();
  for (const c of state.inputCodes) {
    const key = api.codeComparableKey(c);
    if (seen.has(key)) { state.results.push(api.buildOutputRow(c, '', 'duplicate_in_input', [], [], '', '本次输入重复', false)); state.stats.duplicate++; }
    else { seen.add(key); uniqueCodes.push(c); }
  }
  state.stats.total = state.inputCodes.length;

  // 数据库去重：历史已确认正常的跳过；历史失败/待核验的允许重新抓取修正。
  const toProcess = [];
  for (const c of uniqueCodes) {
    const found = api.dbFindCode(c);
    if (found.found && !['not_found', 'need_manual_check'].includes(found.status)) {
      state.results.push(api.buildOutputRow(found.code || c, found.url || '', 'already_exists', [], [], '', `已存在于数据库`, false));
      state.stats.exists++;
    } else { toProcess.push(c); }
  }
  state.stats.new = toProcess.length;
  updateStats(); renderTable(); updateProgress(0, toProcess.length);
  if (toProcess.length === 0) { finishProcessing(); return; }
  switchPage('results');

  const runId = api.dbCreateRun();

  for (let i = 0; i < toProcess.length; i++) {
    if (state.stopRequested) { setStatus(null, null, null, '已手动停止'); break; }
    const code = toProcess[i];
    setStatus(null, `处理中: ${code} (${i + 1}/${toProcess.length})`, null, null);
    updateProgress(i + 1, toProcess.length);

    const row = await processOneCode(code);
    state.results.push(row);
    if (row.status === 'not_found') state.stats.notFound++;

    // 写入数据库
    if (row.includeInImport) {
      const codeId = api.dbUpsertCode(row.code, row.url, row.status);
      const actressTagsToSave = row.matchedActressTags && row.matchedActressTags.length
        ? row.matchedActressTags
        : (row.matchedActressTag ? [row.matchedActressTag] : []);
      if (actressTagsToSave.length) {
        for (const tag of actressTagsToSave) {
          const aId = api.dbGetOrCreateActressTag(tag);
          if (aId) api.dbLinkActressCode(aId, codeId);
        }
      } else if (row.status === 'not_found' || row.status === 'no_actress_found') {
        const uId = api.dbGetOrCreateActressTag('#未知女优');
        if (uId) api.dbLinkActressCode(uId, codeId);
      }
      for (const g of (row.genres || [])) { api.dbLinkGenreCode(g, codeId); }
    }

    updateStats(); renderTable();
    await api.sleep(900);
  }

  api.dbFinishRun(runId, state.stats);
  refreshDbSummary();
  finishProcessing();
}
async function processOneCode(code) {
  const normalized = api.normalizeCode(code);
  const urls = api.candidateUrls(normalized);
  let bestUrl = urls[0], bestHtml = '', bestStatus = 'not_found';
  let fallbackUrl = urls[0];
  let sawPossiblyReachableUrl = false;

  for (const url of urls) {
    if (state.stopRequested) break;
    try {
      const page = await api.fetchPage(url, { timeout: 12000 });
      const finalUrl = page.finalUrl || url;

      if (page.error) {
        fallbackUrl = finalUrl;
        sawPossiblyReachableUrl = true;
        continue;
      }

      if (page.statusCode === 404 || page.statusCode === 410) {
        continue;
      }

      if (page.statusCode >= 400) {
        fallbackUrl = finalUrl;
        sawPossiblyReachableUrl = true;
        continue;
      }

      fallbackUrl = finalUrl;
      sawPossiblyReachableUrl = true;

      const st = api.checkPageStatus(page.body, normalized, finalUrl);
      if (st === 'not_found') {
        if (bestStatus === 'not_found') {
          bestUrl = finalUrl;
          bestHtml = page.body || '';
          bestStatus = 'need_manual_check';
        }
        continue;
      }

      bestUrl = finalUrl;
      bestHtml = page.body;
      bestStatus = st;
      break;
    } catch {
      fallbackUrl = url;
      sawPossiblyReachableUrl = true;
      continue;
    }
  }

  if (bestStatus === 'not_found' && sawPossiblyReachableUrl) {
    bestUrl = fallbackUrl;
    bestStatus = 'need_manual_check';
  }

  let actresses = [], genres = [];
  if (bestStatus === 'ok' || bestStatus === 'page_ok_play_unknown') { actresses = api.extractActressTags(bestHtml); genres = api.extractGenreTags(bestHtml); }
  else if (bestStatus === 'no_actress_found' || bestStatus === 'need_manual_check') { genres = api.extractGenreTags(bestHtml); }

  const matchedTags = [];
  for (const name of actresses) {
    const match = api.dbSearchActressTag(name);
    const tag = match ? match.tag_name : name;
    if (tag && !matchedTags.includes(tag)) matchedTags.push(tag);
  }

  return api.buildOutputRow(normalized, bestUrl, bestStatus, actresses, genres, matchedTags, '', true);
}
function stopProcessing() { state.stopRequested = true; toast('正在停止...', 'info'); }

function finishProcessing() {
  state.isProcessing = false;
  DOM.btnStart.style.display = 'block'; DOM.btnStop.style.display = 'none'; DOM.exportBar.style.display = 'flex';
  if (state.stopRequested) setStatus(null, null, null, '已停止'); else setStatus(null, null, '处理完成 ✓', null);
  switchPage('results');
  updateStats(); renderTable();
  const summary = `新增 ${state.stats.new} | 跳过 ${state.stats.exists} | 需核验 ${state.stats.notFound} | 重复 ${state.stats.duplicate}`;
  addHistory(summary); toast(summary, 'success');
}

// ─── 导出 ────────────────────────────────────────────
async function exportAll() {
  if (!state.results.length) { toast('无结果可导出', 'error'); return; }
  try {
    const prefix = api.timePrefixToMinute(); const runDir = `${state.outputDirPath}\\${prefix}_missav_import`;
    await api.createDirectory(runDir);
    await api.writeFile(`${runDir}\\${prefix}_missav_raindrop_import.html`, api.generateRaindropHTML(state.results));
    await api.writeFile(`${runDir}\\${prefix}_missav_raindrop_import.csv`, api.generateRaindropCSV(state.results));
    await api.writeFile(`${runDir}\\${prefix}_missav_import_report.csv`, api.generateReportCSV(state.results));
    await api.writeFile(`${runDir}\\${prefix}_女优tag合集.csv`, api.dbExportCSV());
    await api.writeFile(`${runDir}\\${prefix}_missav_backup.json`, api.generateBackupJSON(state.results, [], state.stats));
    toast(`导出成功！→ ${runDir}`, 'success');
    addHistory(`导出: ${prefix}_missav_import`);
    if (confirm('导出完成，打开输出文件夹？')) openOutputFolder();
  } catch (err) { toast(`导出失败: ${err.message}`, 'error'); }
}

async function exportHTMLOnly() {
  try { const prefix = api.timePrefixToMinute(); const runDir = `${state.outputDirPath}\\${prefix}_missav_import`; await api.createDirectory(runDir); await api.writeFile(`${runDir}\\${prefix}_missav_raindrop_import.html`, api.generateRaindropHTML(state.results)); toast('HTML 已导出', 'success'); } catch (err) { toast(`导出失败: ${err.message}`, 'error'); }
}
async function exportCSVOnly() {
  try { const prefix = api.timePrefixToMinute(); const runDir = `${state.outputDirPath}\\${prefix}_missav_import`; await api.createDirectory(runDir); await api.writeFile(`${runDir}\\${prefix}_missav_raindrop_import.csv`, api.generateRaindropCSV(state.results)); toast('CSV 已导出', 'success'); } catch (err) { toast(`导出失败: ${err.message}`, 'error'); }
}
async function openOutputFolder() {
  if (!state.outputDirPath) return;
  try {
    await api.showDirectory(state.outputDirPath);
  } catch (err) {
    toast(`无法打开输出目录: ${err.message}`, 'error');
  }
}

// ─── 本地库管理 ──────────────────────────────────────
async function openLibraryModal() {
  if (!state.dbReady) { toast('数据库未就绪', 'error'); return; }
  switchPage('library');
  switchDataMode('library');
  await refreshLibrary();
}

function switchLibraryTab(tab) {
  state.libraryTab = tab;
  state.codePage = 1;
  const visibleTab = visibleLibraryTab(tab);
  $$('.library-tabs .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.libraryTab === visibleTab));
  refreshLibrary();
}

function visibleLibraryTab(tab) {
  if (['overview', 'map', 'review', 'export', 'health', 'backup', 'raw', 'duplicates', 'runs'].includes(tab)) return 'maintenance';
  if (['actresses', 'genres'].includes(tab)) return 'tags';
  return tab;
}

async function refreshLibrary() {
  if (!state.dbReady || !DOM.libraryContent) return;
  const q = DOM.librarySearch ? DOM.librarySearch.value.trim() : '';
  try {
    if (DOM.librarySearch) {
      DOM.librarySearch.closest('.library-toolbar')?.classList.toggle('library-toolbar-hidden', state.libraryTab === 'dedupe');
      DOM.librarySearch.placeholder = state.libraryTab === 'codes'
        ? '搜索番号、标题、链接、Collection、Tags 或 Note'
        : state.libraryTab === 'tags'
          ? '搜索女优或类型 Tag'
          : '搜索当前维护视图';
    }
    if (state.libraryTab === 'overview') renderLibraryOverview();
    if (state.libraryTab === 'actresses') renderLibraryActresses(q);
    if (state.libraryTab === 'codes') renderLibraryCodes(q);
    if (state.libraryTab === 'dedupe') renderLibraryDedupe();
    if (state.libraryTab === 'tags') renderLibraryTagManager(q);
    if (state.libraryTab === 'maintenance') renderLibraryMaintenance();
    if (state.libraryTab === 'map') renderLibraryCollectionMap(q);
    if (state.libraryTab === 'review') renderLibraryReviewDeck(q);
    if (state.libraryTab === 'export') renderLibraryExportPreview(q);
    if (state.libraryTab === 'health') renderLibraryHealth(q);
    if (state.libraryTab === 'backup') renderLibraryBackups(q);
    if (state.libraryTab === 'genres') renderLibraryGenres(q);
    if (state.libraryTab === 'raw') renderLibraryRaw(q);
    if (state.libraryTab === 'duplicates') renderLibraryDuplicates();
    if (state.libraryTab === 'runs') renderLibraryRuns();
  } catch (err) {
    DOM.libraryContent.innerHTML = `<div class="library-empty">加载失败：${esc(err.message)}</div>`;
  }
}

function renderLibraryDedupe() {
  const report = importCompareSummary();
  const allRows = state.importCompare.rows || [];
  const rows = state.importCompare.filter === 'all' ? allRows : allRows.filter(row => row.classification === state.importCompare.filter);
  const selectedCount = state.importCompare.selected.size;
  DOM.libraryContent.innerHTML = `
    <div class="import-compare-workbench">
      <section class="import-source-panel">
        <div class="workspace-section-head">
          <div><h3>导入新内容</h3><span>支持文本、HTML、Markdown、MissAV 链接与多个文件</span></div>
          <span class="workspace-count">${allRows.length} 条 · ${state.importCompare.metadataByKey.size} 条含完整字段</span>
        </div>
        <textarea class="import-compare-input" data-import-compare-input spellcheck="false" placeholder="粘贴新收集的内容，系统会提取番号并与全部历史库比对">${esc(state.importCompare.text || '')}</textarea>
        <div class="import-source-actions">
          <button class="btn btn-secondary btn-sm" data-action="import-compare-analyze">分析并比对</button>
          <button class="btn btn-outline btn-sm" data-action="import-compare-files">导入文件</button>
          <button class="btn btn-outline btn-sm" data-action="import-compare-from-process">读取处理页</button>
          <button class="btn btn-outline btn-sm" data-action="import-compare-clear">清空</button>
        </div>
        <div class="import-policy-panel">
          <label><span>默认保留规则</span><select data-import-policy>
            <option value="new_only" ${state.importCompare.policy === 'new_only' ? 'selected' : ''}>仅保留全新番号</option>
            <option value="new_and_review" ${state.importCompare.policy === 'new_and_review' ? 'selected' : ''}>全新 + 历史失败/待核验</option>
            <option value="all" ${state.importCompare.policy === 'all' ? 'selected' : ''}>全部保留</option>
          </select></label>
          <p>规则只决定默认勾选，之后仍可逐条修改。</p>
        </div>
      </section>

      <section class="import-result-panel">
        <div class="import-summary-strip">
          <button data-action="import-filter" data-filter="all" class="${state.importCompare.filter === 'all' ? 'active' : ''}"><strong>${report.total}</strong><span>已识别</span></button>
          <button data-action="import-filter" data-filter="new" class="${state.importCompare.filter === 'new' ? 'active' : ''}"><strong>${report.newCount}</strong><span>全新</span></button>
          <button data-action="import-filter" data-filter="existing" class="${state.importCompare.filter === 'existing' ? 'active' : ''}"><strong>${report.existingCount}</strong><span>已收录</span></button>
          <button data-action="import-filter" data-filter="review" class="${state.importCompare.filter === 'review' ? 'active' : ''}"><strong>${report.reviewCount}</strong><span>需复查</span></button>
        </div>
        <div class="import-result-toolbar">
          <span>已选 <strong>${selectedCount}</strong> 条</span>
          <button class="btn btn-outline btn-sm" data-action="import-select-new">仅选全新</button>
          <button class="btn btn-outline btn-sm" data-action="import-select-all">全选</button>
          <button class="btn btn-outline btn-sm" data-action="import-select-none">全不选</button>
        </div>
        <div class="import-compare-list">
          ${rows.length ? rows.slice(0, 3000).map(renderImportCompareRow).join('') : '<div class="library-empty">粘贴或导入内容后点击“分析并比对”</div>'}
          ${rows.length > 3000 ? `<div class="import-list-more">为保持界面流畅，仅显示前 3000 条；所有 ${rows.length} 条仍会参与批量操作。</div>` : ''}
        </div>
        <div class="import-result-actions">
          <button class="btn btn-success" data-action="import-send-process" ${selectedCount ? '' : 'disabled'}>把选中项送到处理页</button>
          <button class="btn btn-secondary" data-action="import-add-history" ${selectedCount ? '' : 'disabled'}>直接加入历史库</button>
        </div>
      </section>
    </div>`;
}

function importCompareSummary() {
  const rows = state.importCompare.rows || [];
  return {
    total: rows.length,
    newCount: rows.filter(row => row.classification === 'new').length,
    existingCount: rows.filter(row => row.classification === 'existing').length,
    reviewCount: rows.filter(row => row.classification === 'review').length,
  };
}

function renderImportCompareRow(row) {
  const checked = state.importCompare.selected.has(row.key);
  const existing = row.existing;
  const labels = {
    new: ['全新', 'import-row-new'],
    existing: ['已收录', 'import-row-existing'],
    review: ['需复查', 'import-row-review'],
  };
  const [label, cls] = labels[row.classification] || labels.new;
  return `<label class="import-compare-row ${cls}">
    <input type="checkbox" data-import-row-key="${esc(row.key)}" ${checked ? 'checked' : ''}>
    <span class="import-code">${esc(row.code)}</span>
    <span class="import-state">${label}</span>
    <span class="import-existing-detail">${existing ? `${esc(existing.code)} · ${esc(statusDisplayLabel(existing.status))}${existing.url ? ' · 有链接' : ''}` : '历史库中没有该番号'}</span>
  </label>`;
}

function statusDisplayLabel(status) {
  return CODE_STATUS_OPTIONS.find(item => item[0] === status)?.[1] || status || '-';
}

function applyImportComparePolicy() {
  const selected = new Set();
  for (const row of state.importCompare.rows || []) {
    const keep = state.importCompare.policy === 'all'
      || row.classification === 'new'
      || (state.importCompare.policy === 'new_and_review' && row.classification === 'review');
    if (keep) selected.add(row.key);
  }
  state.importCompare.selected = selected;
}

async function analyzeImportComparison(text = state.importCompare.text) {
  state.importCompare.text = String(text || '');
  state.importCompare.metadataByKey = extractRaindropMetadataFromCsv(state.importCompare.text);
  const codes = api.parseCodeList(state.importCompare.text);
  const report = api.dbAnalyzeCodeImport(codes);
  state.importCompare.rows = report.rows || [];
  state.importCompare.filter = 'all';
  applyImportComparePolicy();
  await refreshLibrary();
  toast(`已比对 ${report.total || 0} 条：全新 ${report.newCount || 0}，已收录 ${report.existingCount || 0}，需复查 ${report.reviewCount || 0}`, 'success');
}

function extractRaindropMetadataFromCsv(text) {
  const result = new Map();
  const parsed = api.csvParse(String(text || ''));
  const headers = (parsed.headers || []).map(header => String(header || '').trim().toLowerCase());
  const find = names => headers.findIndex(header => names.includes(header));
  const indexes = {
    code: find(['code', '番号', '品番']),
    url: find(['url', 'link', '链接', '网址']),
    title: find(['title', '标题']),
    note: find(['note', '备注']),
    tags: find(['tags', 'tag', '标签']),
    folder: find(['folder', 'collection', '收藏夹', '文件夹']),
    created: find(['created', 'created_at', '创建时间']),
    cover: find(['cover', 'image', '封面']),
    excerpt: find(['excerpt', 'description', '摘要']),
  };
  if (indexes.code < 0 && indexes.url < 0 && indexes.title < 0) return result;

  const value = (row, index) => index >= 0 ? String(row[index] || '').trim() : '';
  for (const row of parsed.rows || []) {
    const explicitCode = value(row, indexes.code);
    const url = value(row, indexes.url);
    const title = value(row, indexes.title);
    const code = api.parseCodeList([explicitCode, url, title].filter(Boolean).join(' '))[0];
    if (!code) continue;
    const key = api.codeComparableKey(code);
    if (!key || result.has(key)) continue;
    result.set(key, {
      code,
      url,
      title,
      note: value(row, indexes.note),
      tags: value(row, indexes.tags),
      folder: value(row, indexes.folder),
      created: value(row, indexes.created),
      cover: value(row, indexes.cover),
      excerpt: value(row, indexes.excerpt),
    });
  }
  return result;
}

async function importComparisonFiles() {
  const paths = await api.openFile({
    title: '选择要比对的文件',
    multiSelections: true,
    filters: [{ name: '文本与数据文件', extensions: ['txt', 'md', 'html', 'htm', 'csv'] }],
  });
  if (!paths || !paths.length) return;
  const chunks = [];
  const metadata = new Map();
  for (const filePath of paths) {
    const text = await api.readFile(filePath, 'utf-8');
    chunks.push(text);
    for (const [key, record] of extractRaindropMetadataFromCsv(text)) if (!metadata.has(key)) metadata.set(key, record);
  }
  state.importCompare.text = chunks.join('\n\n');
  state.importCompare.sourceLabel = `${paths.length} 个文件`;
  await analyzeImportComparison(state.importCompare.text);
  state.importCompare.metadataByKey = metadata;
  await refreshLibrary();
}

function selectedImportCodes() {
  const selected = state.importCompare.selected;
  return (state.importCompare.rows || []).filter(row => selected.has(row.key)).map(row => row.code);
}

async function sendImportSelectionToProcess() {
  const codes = selectedImportCodes();
  if (!codes.length) throw new Error('请先选择要处理的番号');
  DOM.codeInput.value = codes.join('\n');
  parseInputCodes('导入去重');
  switchPage('process');
  toast(`已把 ${codes.length} 条送到处理页`, 'success');
}

async function addImportSelectionToHistory() {
  const codes = selectedImportCodes();
  if (!codes.length) throw new Error('请先选择要加入历史库的番号');
  const newKeys = new Set((state.importCompare.rows || []).filter(row => row.classification === 'new').map(row => row.key));
  if (!codes.some(code => newKeys.has(api.codeComparableKey(code)))) throw new Error('选中项都已存在于历史库，没有需要新增的记录');
  api.dbCreateBackup('historical_import', 'import');
  const records = codes.map(code => state.importCompare.metadataByKey.get(api.codeComparableKey(code)) || { code });
  const result = api.dbImportHistoricalRecords(records);
  await refreshDbSummary();
  await analyzeImportComparison(state.importCompare.text);
  toast(`已加入历史库 ${result.imported} 条，已有 ${result.existing} 条未重复写入`, 'success');
}

function renderLibraryTagManager(q) {
  const actresses = api.dbGetActressLibrary({ search: q, limit: 500 });
  const genres = api.dbGetGenreLibrary({ search: q, limit: 500 });
  DOM.libraryContent.innerHTML = `
    <div class="tag-manager-workbench">
      <section class="tag-manager-section">
        <div class="workspace-section-head"><div><h3>女优 Tags</h3><span>${actresses.length} 个匹配项</span></div><button class="btn btn-secondary btn-sm" data-action="create-actress">新增</button></div>
        <div class="tag-manager-list">${actresses.map(row => `<div class="tag-manager-row"><div><strong>${esc(row.tag_name)}</strong><span>${row.code_count} 条记录 · ${row.sample_codes.slice(0, 4).map(esc).join(' ') || '暂无关联'}</span></div><div><button class="btn btn-outline btn-sm" data-action="rename-tag" data-id="${row.id}" data-name="${esc(row.tag_name)}">重命名</button><button class="btn btn-outline btn-sm" data-action="merge-tag" data-id="${row.id}" data-name="${esc(row.tag_name)}">合并</button><button class="btn btn-danger btn-sm" data-action="delete-tag" data-id="${row.id}" data-name="${esc(row.tag_name)}" data-count="${row.code_count}">删除</button></div></div>`).join('') || '<div class="library-empty">没有匹配的女优 Tag</div>'}</div>
      </section>
      <section class="tag-manager-section">
        <div class="workspace-section-head"><div><h3>类型 Tags</h3><span>${genres.length} 个匹配项</span></div><button class="btn btn-secondary btn-sm" data-action="create-genre">新增</button></div>
        <div class="tag-manager-list">${genres.map(row => `<div class="tag-manager-row"><div><strong>${esc(row.name)}</strong><span>${row.code_count} 条记录 · ${row.sample_codes.slice(0, 4).map(esc).join(' ') || '暂无关联'}</span></div><div><button class="btn btn-outline btn-sm" data-action="rename-genre" data-id="${row.id}" data-name="${esc(row.name)}">重命名</button><button class="btn btn-danger btn-sm" data-action="delete-genre" data-id="${row.id}" data-name="${esc(row.name)}" data-count="${row.code_count}">删除</button></div></div>`).join('') || '<div class="library-empty">没有匹配的类型 Tag</div>'}</div>
      </section>
    </div>`;
}

function renderLibraryMaintenance() {
  const stats = api.dbGetStats();
  const bookmarkStats = api.dbGetBookmarkStats();
  const tools = [
    ['overview', '数据概况', '数量统计与最近处理记录'],
    ['health', '数据体检', '缺链接、缺 Tag、状态矛盾与坏关联'],
    ['backup', '备份恢复', '创建、恢复和管理数据库快照'],
    ['export', '导出预览', '导出 Raindrop 前检查字段与状态'],
    ['duplicates', '疑似重复', '按标准化番号查找重复记录'],
    ['raw', '原始表', '直接维护底层表，仅用于高级修复'],
    ['map', 'Collection 分布', '查看收藏夹、Tags 与缺失字段'],
    ['review', '逐条整理队列', '按风险优先逐条补全旧数据'],
    ['runs', '处理历史', '查看历史处理批次'],
  ];
  DOM.libraryContent.innerHTML = `
    <div class="maintenance-workbench">
      <div class="maintenance-summary"><strong>${bookmarkStats.count}</strong><span>收藏</span><strong>${bookmarkStats.collectionCount}</strong><span>Collections</span><strong>${stats.codeCount}</strong><span>番号索引</span><strong>${bookmarkStats.highlightCount}</strong><span>Highlights</span></div>
      <div class="maintenance-list">${tools.map(([tab, title, desc]) => `<button data-action="maintenance-open" data-tab="${tab}"><span><strong>${title}</strong><small>${desc}</small></span><b>›</b></button>`).join('')}</div>
    </div>`;
}

function renderLibraryOverview() {
  const stats = api.dbGetStats();
  const runs = api.dbGetRecentRuns(5);
  const duplicates = api.dbGetDuplicateCodeGroups();
  DOM.libraryContent.innerHTML = `
    <div class="library-stats-grid">
      <div class="stat-card"><div class="stat-value">${stats.actressCount}</div><div class="stat-label">女优 Tag</div></div>
      <div class="stat-card"><div class="stat-value">${stats.codeCount}</div><div class="stat-label">番号</div></div>
      <div class="stat-card"><div class="stat-value">${stats.linkCount}</div><div class="stat-label">女优关联</div></div>
      <div class="stat-card"><div class="stat-value">${stats.genreCount}</div><div class="stat-label">类型 Tag</div></div>
      <div class="stat-card"><div class="stat-value">${duplicates.length}</div><div class="stat-label">疑似重复组</div></div>
    </div>
    <h3 class="library-section-title">最近处理</h3>
    ${renderRunList(runs)}
  `;
}

function renderLibraryCollectionMap(q) {
  const map = buildCollectionMap(q);
  const st = state.collectionMap;
  DOM.libraryContent.innerHTML = `
    <div class="collection-map-workbench">
      <div class="library-action-bar collection-map-toolbar">
        <button class="btn btn-secondary btn-sm" data-action="map-refresh">刷新地图</button>
        <button class="btn btn-outline btn-sm ${st.riskOnly ? 'active' : ''}" data-action="map-toggle-risk">风险视图</button>
        <button class="btn btn-outline btn-sm" data-action="map-random-review">随机抽查</button>
        <button class="btn btn-outline btn-sm" data-action="map-clear-filters">清除筛选</button>
        <span>Collection ${map.collections.length} 组，当前显示 ${map.visibleRows.length} / ${map.total} 条</span>
      </div>
      <div class="collection-map-layout">
        <aside class="collection-map-sidebar">
          <div class="collection-map-heading"><h3>Collections</h3><span>${map.collections.length} 组</span></div>
          <button class="collection-map-collection ${st.collection === 'all' ? 'active' : ''}" data-action="map-select-collection" data-collection="all">
            <strong>全部收藏</strong><span>${map.total}</span><small>${map.riskTotal} 风险</small>
          </button>
          ${map.collections.map(group => renderCollectionMapCollection(group, st.collection)).join('')}
        </aside>
        <main class="collection-map-main">
          <div class="collection-map-main-head">
            <div><h3>${esc(map.title)}</h3><span>${map.visibleRows.length} 条 · ${map.visibleRiskCount} 条风险 · ${st.tag ? 'Tag: ' + esc(st.tag) : '全部 Tag'}</span></div>
          </div>
          ${renderCollectionMapCards(map.visibleRows)}
        </main>
        <aside class="collection-map-inspector">
          <section class="collection-map-panel">
            <div class="collection-map-heading"><h3>Tag Cloud</h3><span>${map.tags.length} 个</span></div>
            <div class="collection-tag-cloud">${map.tags.slice(0, 42).map(tag => renderCollectionMapTag(tag, st.tag)).join('') || '<div class="library-empty">暂无 Tags</div>'}</div>
          </section>
          <section class="collection-map-panel">
            <div class="collection-map-heading"><h3>整理建议</h3><span>${map.suggestions.length}</span></div>
            ${renderCollectionMapSuggestions(map.suggestions)}
          </section>
        </aside>
      </div>
    </div>`;
}

function buildCollectionMap(q) {
  const dbRows = api.dbGetCodeLibrary({ search: q || '', limit: 5000 });
  const importRows = api.dbGetRaindropImportRows({ includeNoUrl: true });
  const importById = new Map(importRows.map(row => [Number(row.id), row]));
  const rows = dbRows.map(row => enrichCollectionMapRow(row, importById.get(Number(row.id)) || null));
  const groups = new Map();
  const tagCounts = new Map();
  for (const row of rows) {
    const key = row.collectionKey;
    if (!groups.has(key)) groups.set(key, { key, label: row.collectionLabel, rows: [], count: 0, risks: 0, missingTags: 0, missingLinks: 0 });
    const group = groups.get(key);
    group.rows.push(row);
    group.count++;
    if (row.risks.length) group.risks++;
    if (!row.finalTags.length) group.missingTags++;
    if (!row.url) group.missingLinks++;
    for (const tag of row.finalTags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
  }
  const collections = [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const tags = [...tagCounts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  const riskTotal = rows.filter(row => row.risks.length).length;
  if (state.collectionMap.collection !== 'all' && !groups.has(state.collectionMap.collection)) state.collectionMap.collection = 'all';
  const st = state.collectionMap;
  let visibleRows = rows;
  if (st.collection !== 'all') visibleRows = visibleRows.filter(row => row.collectionKey === st.collection);
  if (st.tag) visibleRows = visibleRows.filter(row => row.finalTags.includes(st.tag));
  if (st.riskOnly) visibleRows = visibleRows.filter(row => row.risks.length);
  const activeGroup = st.collection === 'all' ? null : groups.get(st.collection);
  const title = activeGroup ? activeGroup.label : '全部收藏';
  return {
    total: rows.length,
    rows,
    collections,
    tags,
    riskTotal,
    visibleRows,
    visibleRiskCount: visibleRows.filter(row => row.risks.length).length,
    suggestions: collectionMapSuggestions(collections, rows),
    title,
  };
}

function enrichCollectionMapRow(row, item) {
  const finalTags = item?.finalTags || [];
  const explicitCollection = String(row.raindrop_folder || '').trim();
  const collectionLabel = explicitCollection || '未设置 Collection';
  const collectionKey = explicitCollection || '__missing_collection__';
  const title = row.raindrop_title || row.code || 'Untitled';
  const url = String(row.best_url || item?.url || '').trim();
  const risks = [];
  if (!url) risks.push('无链接');
  if (!explicitCollection) risks.push('缺 Collection');
  if (!String(row.raindrop_title || '').trim()) risks.push('默认 Title');
  if (!finalTags.length) risks.push('无 Tags');
  if (!String(row.raindrop_created || '').trim()) risks.push('默认 Created');
  if (row.status === 'not_found') risks.push('未找到状态');
  return { ...row, item, finalTags, collectionLabel, collectionKey, title, url, risks };
}

function renderCollectionMapCollection(group, active) {
  return `<button class="collection-map-collection ${active === group.key ? 'active' : ''}" data-action="map-select-collection" data-collection="${esc(group.key)}">
    <strong>${esc(group.label)}</strong><span>${group.count}</span><small>${group.risks} 风险 · ${group.missingLinks} 无链接</small>
  </button>`;
}

function renderCollectionMapTag(tag, activeTag) {
  const level = Math.min(5, Math.max(1, Math.ceil(Math.log2(tag.count + 1))));
  return `<button class="collection-tag-cloud-item tag-level-${level} ${activeTag === tag.tag ? 'active' : ''}" data-action="map-select-tag" data-tag="${esc(tag.tag)}"><span>${esc(tag.tag)}</span><b>${tag.count}</b></button>`;
}

function renderCollectionMapCards(rows) {
  if (!rows.length) return '<div class="library-empty">当前筛选下没有收藏</div>';
  return `<div class="collection-card-grid">${rows.slice(0, 240).map(renderCollectionMapCard).join('')}${rows.length > 240 ? `<div class="collection-map-more">还有 ${rows.length - 240} 条未显示，可用搜索或筛选缩小范围</div>` : ''}</div>`;
}

function renderCollectionMapCard(row) {
  const cover = String(row.raindrop_cover || '').trim();
  const coverHtml = cover ? `<img src="${esc(cover)}" alt="">` : `<span>${esc(String(row.code || 'M').slice(0, 1))}</span>`;
  return `<article class="collection-card ${row.risks.length ? 'has-risk' : ''}">
    <div class="collection-card-cover">${coverHtml}</div>
    <div class="collection-card-body">
      <div class="collection-card-title"><strong>${esc(row.code)}</strong><span>${esc(row.title)}</span></div>
      <div class="collection-card-meta">${esc(row.collectionLabel)} · ${esc(row.status || 'ok')}</div>
      <div class="collection-card-tags">${row.finalTags.slice(0, 5).map(tag => `<button data-action="map-select-tag" data-tag="${esc(tag)}">${esc(tag)}</button>`).join('') || '<span>无 Tags</span>'}</div>
      ${row.risks.length ? `<div class="collection-card-risks">${row.risks.map(r => `<span>${esc(r)}</span>`).join('')}</div>` : ''}
      <div class="collection-card-actions">
        <button class="btn btn-outline btn-sm" data-action="map-focus-code" data-id="${row.id}" data-code="${esc(row.code)}">编辑</button>
        ${row.url ? `<button class="btn btn-outline btn-sm" data-action="open-url" data-url="${esc(row.url)}">打开</button>` : ''}
      </div>
    </div>
  </article>`;
}

function collectionMapSuggestions(collections, rows) {
  const suggestions = [];
  const missingCollection = rows.filter(row => row.collectionKey === '__missing_collection__').length;
  const missingTags = rows.filter(row => !row.finalTags.length).length;
  const noUrl = rows.filter(row => !row.url).length;
  const notFoundWithUrl = rows.filter(row => row.status === 'not_found' && row.url).length;
  const crowded = collections.filter(group => group.count >= 30).slice(0, 3);
  if (missingCollection) suggestions.push(`${missingCollection} 条没有 Collection，可批量设置为 MissAV_Import 或拆分收藏夹。`);
  if (missingTags) suggestions.push(`${missingTags} 条没有 Tags，可在番号库使用「写入自动 Tags」。`);
  if (noUrl) suggestions.push(`${noUrl} 条没有链接，导出前建议生成或删除。`);
  if (notFoundWithUrl) suggestions.push(`${notFoundWithUrl} 条状态为 not_found 但有链接，建议核验状态。`);
  for (const group of crowded) suggestions.push(`「${group.label}」有 ${group.count} 条，可能适合拆成更细的 Collection。`);
  return suggestions.length ? suggestions : ['当前地图没有明显整理建议，可以随机抽查几条补充 Note/Cover。'];
}

function renderCollectionMapSuggestions(items) {
  return `<div class="collection-map-suggestions">${items.map(item => `<div>${esc(item)}</div>`).join('')}</div>`;
}

async function focusCollectionMapRandom() {
  const map = buildCollectionMap(DOM.librarySearch ? DOM.librarySearch.value.trim() : '');
  const pool = map.visibleRows.length ? map.visibleRows : map.rows;
  if (!pool.length) { toast('没有可抽查的收藏', 'info'); return; }
  const risky = pool.filter(row => row.risks.length);
  const list = risky.length ? risky : pool;
  const pick = list[Math.floor(Math.random() * list.length)];
  await openHealthCode(Number(pick.id), pick.code || '');
}

function renderLibraryReviewDeck(q) {
  const deck = buildReviewDeck(q);
  const st = state.reviewDeck;
  if (st.index >= deck.rows.length) st.index = Math.max(0, deck.rows.length - 1);
  if (st.index < 0) st.index = 0;
  const current = deck.rows[st.index] || null;

  DOM.libraryContent.innerHTML = `
    <div class="review-deck-workbench">
      <div class="library-action-bar review-deck-toolbar">
        <button class="btn btn-secondary btn-sm" data-action="review-refresh">刷新队列</button>
        <label class="code-toolbar-field"><span>队列</span><select data-review-queue="1">${reviewQueueOptionsHtml(st.queue)}</select></label>
        <button class="btn btn-outline btn-sm" data-action="review-prev" ${!current || st.index <= 0 ? 'disabled' : ''}>上一条</button>
        <button class="btn btn-outline btn-sm" data-action="review-next" ${!current || st.index >= deck.rows.length - 1 ? 'disabled' : ''}>下一条</button>
        <button class="btn btn-outline btn-sm" data-action="review-random" ${!deck.rows.length ? 'disabled' : ''}>随机</button>
        <span>已保存 ${Number(st.done || 0)} 条，跳过 ${Number(st.skipped || 0)} 条；当前队列 ${deck.rows.length} / 全库 ${deck.total} 条。</span>
      </div>
      <div class="review-deck-metrics">
        ${reviewDeckMetric('优先处理', deck.stats.priority, '无链接、状态矛盾、缺核心 Tag')}
        ${reviewDeckMetric('链接问题', deck.stats.url, '会影响导出')}
        ${reviewDeckMetric('状态核验', deck.stats.status, 'not_found / 需核验')}
        ${reviewDeckMetric('元数据', deck.stats.metadata, 'Title / Collection / Tags / Created')}
        ${reviewDeckMetric('润色项', deck.stats.polish, 'Note / Cover / Excerpt')}
      </div>
      <div class="review-deck-layout">
        <main class="review-card-stage">${current ? renderReviewCard(current, deck) : renderReviewEmpty(deck)}</main>
        <aside class="review-queue-panel">
          <div class="review-queue-head"><h3>队列预览</h3><span>${deck.rows.length ? `${st.index + 1} / ${deck.rows.length}` : '0 / 0'}</span></div>
          ${renderReviewQueueRail(deck.rows, current)}
        </aside>
      </div>
    </div>`;
}

function buildReviewDeck(q) {
  const dbRows = api.dbGetCodeLibrary({ search: q || '', limit: 5000 });
  state.libraryCodeAllRows = dbRows;
  const importRows = api.dbGetRaindropImportRows({ includeNoUrl: true });
  const importById = new Map(importRows.map(row => [Number(row.id), row]));
  const rows = dbRows.map(row => enrichReviewRow(row, importById.get(Number(row.id)) || null));
  const stats = {
    priority: rows.filter(row => reviewHasPriority(row)).length,
    url: rows.filter(row => row.reviewIssues.some(issue => issue.kind === 'url')).length,
    status: rows.filter(row => row.reviewIssues.some(issue => issue.kind === 'status')).length,
    metadata: rows.filter(row => row.reviewIssues.some(issue => ['title', 'collection', 'tags', 'created'].includes(issue.kind))).length,
    polish: rows.filter(row => row.reviewIssues.some(issue => ['note', 'cover', 'excerpt'].includes(issue.kind))).length,
  };
  const queue = state.reviewDeck.queue || 'priority';
  const visible = rows.filter(row => reviewQueueMatches(row, queue)).sort(reviewSortRows);
  return { total: rows.length, rows: visible, allRows: rows, stats, queue };
}

function enrichReviewRow(row, item) {
  const url = String(row.best_url || item?.url || '').trim();
  const status = String(row.status || 'ok');
  const finalTags = item?.finalTags || raindropExplicitOrAutoTags(row);
  const explicitTags = splitTagInput(row.raindrop_tags);
  const issues = [];
  const add = (kind, severity, message) => issues.push({ kind, severity, message });

  if (!url) add('url', 'danger', '无链接，导出到 Raindrop 时会被排除');
  if (url && status === 'not_found') add('status', 'warn', '存在链接但状态仍是 not_found，建议改为 ok 或重新核验');
  if (status === 'network_error') add('status', 'warn', '网络错误状态，建议重新确认链接');
  if (status === 'need_manual_check') add('status', 'warn', '仍处于需人工核验状态');
  if (status === 'no_actress_found') add('tags', 'warn', '缺少女优 Tag，建议补全后再导出');
  if (!String(row.raindrop_folder || '').trim()) add('collection', 'info', `Collection 将使用默认值：${defaultExportFolder(row)}`);
  if (!String(row.raindrop_title || '').trim()) add('title', 'info', 'Title 当前使用番号作为默认值');
  if (!finalTags.length) add('tags', 'warn', 'Tags 为空，建议补充女优或类型 Tag');
  else if (!explicitTags.length) add('tags', 'info', 'Tags 来自自动生成，保存后可固定到 Raindrop 字段');
  if (!String(row.raindrop_created || '').trim()) add('created', 'info', 'Created 将使用数据库创建时间');
  if (!String(row.raindrop_note || row.raindrop_excerpt || '').trim()) add('note', 'info', '缺少 Note / Excerpt，可补一句备注方便检索');
  if (!String(row.raindrop_cover || '').trim()) add('cover', 'info', '缺少 Cover，Raindrop 中可能没有封面预览');

  return {
    ...row,
    importRow: item,
    url,
    finalTags,
    explicitTags,
    reviewIssues: issues,
    reviewPriority: issues.filter(issue => issue.severity === 'danger' || issue.severity === 'warn').length,
  };
}

function reviewQueueOptionsHtml(current) {
  const options = [
    ['priority', '优先处理'],
    ['url', '链接问题'],
    ['status', '状态核验'],
    ['metadata', '元数据整理'],
    ['polish', '备注封面'],
    ['all', '全部记录'],
  ];
  return options.map(([value, label]) => `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`).join('');
}

function reviewQueueMatches(row, queue) {
  if (queue === 'all') return true;
  if (queue === 'priority') return reviewHasPriority(row);
  if (queue === 'url') return row.reviewIssues.some(issue => issue.kind === 'url');
  if (queue === 'status') return row.reviewIssues.some(issue => issue.kind === 'status');
  if (queue === 'metadata') return row.reviewIssues.some(issue => ['title', 'collection', 'tags', 'created'].includes(issue.kind));
  if (queue === 'polish') return row.reviewIssues.some(issue => ['note', 'cover', 'excerpt'].includes(issue.kind));
  return row.reviewIssues.length > 0;
}

function reviewHasPriority(row) {
  return row.reviewIssues.some(issue => issue.severity === 'danger' || issue.severity === 'warn');
}

function reviewSortRows(a, b) {
  return b.reviewPriority - a.reviewPriority || b.reviewIssues.length - a.reviewIssues.length || Number(b.id || 0) - Number(a.id || 0);
}

function reviewDeckMetric(label, value, note) {
  return `<div class="review-metric-card"><strong>${Number(value || 0)}</strong><span>${esc(label)}</span><small>${esc(note || '')}</small></div>`;
}

function renderReviewEmpty(deck) {
  const label = reviewQueueOptionsHtml(deck.queue).match(/selected>(.*?)<\/option>/)?.[1] || '当前';
  return `<div class="review-empty-card"><h3>${esc(label)}队列已清空</h3><p>可以切换到其他队列继续润色，或直接进入导出预览检查最终 CSV。</p><button class="btn btn-outline btn-sm" data-action="preview-open-codes">打开番号库</button></div>`;
}

function renderReviewQueueRail(rows, current) {
  if (!rows.length) return '<div class="library-empty">当前队列没有记录</div>';
  const start = Math.max(0, Math.min(state.reviewDeck.index - 8, Math.max(0, rows.length - 24)));
  const items = rows.slice(start, start + 24);
  return `<div class="review-queue-list">${items.map((row, i) => {
    const index = start + i;
    const active = current && Number(current.id) === Number(row.id);
    const severity = row.reviewIssues.some(issue => issue.severity === 'danger') ? 'danger' : row.reviewPriority ? 'warn' : 'info';
    return `<button class="review-queue-item ${active ? 'active' : ''} review-queue-${severity}" data-action="review-go-index" data-index="${index}">
      <strong>${esc(row.code || '')}</strong><span>${row.reviewIssues.length} 项</span><small>${esc(row.reviewIssues[0]?.message || '暂无提醒')}</small>
    </button>`;
  }).join('')}${rows.length > 24 ? `<div class="review-queue-more">显示 ${start + 1}-${Math.min(start + 24, rows.length)} / ${rows.length}</div>` : ''}</div>`;
}

function renderReviewCard(row, deck) {
  const id = Number(row.id);
  const title = row.raindrop_title || row.code || 'Untitled';
  const cover = String(row.raindrop_cover || '').trim();
  const coverHtml = cover ? `<img src="${esc(cover)}" alt="">` : `<span>${esc(String(title).slice(0, 1).toUpperCase() || 'M')}</span>`;
  const tagsText = reviewTagTextForRow(row);
  const collectionListId = `review-collections-${id}`;
  const position = deck.rows.length ? `${state.reviewDeck.index + 1} / ${deck.rows.length}` : '0 / 0';

  return `<article class="review-card raindrop-edit-panel" data-review-card-id="${id}" data-code-detail-id="${id}">
    <div class="review-card-top">
      <div class="raindrop-cover-preview review-cover" data-rd-cover>${coverHtml}</div>
      <div class="review-card-heading">
        <span class="review-position">${esc(position)}</span>
        <h3 data-rd-title>${esc(title)}</h3>
        <p data-rd-link>${esc(row.url || row.best_url || 'No link')}</p>
        ${renderReviewIssues(row.reviewIssues)}
      </div>
      <div class="review-card-top-actions">
        <span class="raindrop-dirty-badge" data-detail-dirty-badge>未保存</span>
        ${row.url ? `<button class="btn btn-outline btn-sm" data-action="open-url" data-url="${esc(row.url)}">打开</button>` : ''}
        <button class="btn btn-outline btn-sm" data-action="review-focus-code" data-id="${id}" data-code="${esc(row.code || '')}">番号库</button>
      </div>
    </div>

    <div class="review-quick-actions">
      <button class="btn btn-outline btn-sm" data-action="review-fix-url">生成链接</button>
      <button class="btn btn-outline btn-sm" data-action="review-fix-status-ok">状态 ok</button>
      <button class="btn btn-outline btn-sm" data-action="review-fix-title">标题=番号</button>
      <button class="btn btn-outline btn-sm" data-action="review-fix-collection">默认 Collection</button>
      <button class="btn btn-outline btn-sm" data-action="review-fix-tags">自动 Tags</button>
      <button class="btn btn-outline btn-sm" data-action="review-fix-created">Created=现在</button>
      <button class="btn btn-outline btn-sm" data-action="review-fix-note">生成备注</button>
      <button class="btn btn-outline btn-sm" data-action="review-clear-cover">清空封面</button>
    </div>

    <datalist id="${collectionListId}">${raindropCollectionOptionsHtml()}</datalist>
    <div class="review-form-grid">
      <section class="review-form-section">
        <div class="review-section-head"><h4>Raindrop</h4><span>导入字段</span></div>
        <label class="code-detail-field"><span>Link</span><input data-code-detail-field="best_url" value="${esc(row.url || row.best_url || '')}"></label>
        <label class="code-detail-field"><span>Title</span><input data-code-detail-field="raindrop_title" value="${esc(row.raindrop_title || '')}" placeholder="${esc(row.code || 'Untitled')}"></label>
        <label class="code-detail-field"><span>Collection</span><input data-code-detail-field="raindrop_folder" list="${collectionListId}" value="${esc(row.raindrop_folder || '')}" placeholder="${esc(defaultExportFolder(row))}"></label>
        <label class="code-detail-field"><span>Tags</span>${renderRaindropTagEditor(tagsText)}</label>
        <label class="code-detail-field"><span>Note</span><textarea data-code-detail-field="raindrop_note" spellcheck="false">${esc(row.raindrop_note || '')}</textarea></label>
        <label class="code-detail-field"><span>Created</span><input type="datetime-local" data-code-detail-field="raindrop_created" value="${esc(toDateTimeLocalValue(row.raindrop_created || row.created_at))}"></label>
      </section>

      <section class="review-form-section">
        <div class="review-section-head"><h4>本地库</h4><span>可直接改数据库</span></div>
        <label class="code-detail-field"><span>番号</span><input data-code-detail-field="code" value="${esc(row.code || '')}"></label>
        <label class="code-detail-field"><span>状态</span><select data-code-detail-field="status">${statusOptionsHtml(row.status || 'ok')}</select></label>
        <label class="code-detail-field"><span>女优 Tag</span><textarea data-code-detail-field="actress_tags" spellcheck="false">${esc((row.actress_tags || []).join('\n'))}</textarea></label>
        <label class="code-detail-field"><span>类型 Tag</span><textarea data-code-detail-field="genre_tags" spellcheck="false">${esc((row.genre_tags || []).join('\n'))}</textarea></label>
        <details class="raindrop-extra-panel review-extra-panel">
          <summary>Metadata</summary>
          <label class="code-detail-field"><span>Excerpt</span><textarea data-code-detail-field="raindrop_excerpt" spellcheck="false">${esc(row.raindrop_excerpt || '')}</textarea></label>
          <label class="code-detail-field"><span>Cover</span><input data-code-detail-field="raindrop_cover" value="${esc(row.raindrop_cover || '')}"></label>
          <div class="raindrop-inline-actions">
            <button type="button" class="btn btn-outline btn-sm" data-action="detail-cover-preview">刷新预览</button>
            <button type="button" class="btn btn-outline btn-sm" data-action="detail-cover-clear">清空封面</button>
          </div>
        </details>
      </section>
    </div>

    <div class="review-card-actions">
      <button class="btn btn-success btn-sm" data-action="review-save-next">保存并下一条</button>
      <button class="btn btn-outline btn-sm" data-action="review-save-stay">仅保存</button>
      <button class="btn btn-outline btn-sm" data-action="review-skip">跳过</button>
      <button class="btn btn-outline btn-sm" data-action="detail-revert" data-id="${id}">撤销</button>
      <button class="btn btn-danger btn-sm" data-action="delete-code" data-id="${id}" data-code="${esc(row.code || '')}">删除</button>
    </div>
  </article>`;
}

function reviewTagTextForRow(row) {
  const explicit = splitTagInput(row.raindrop_tags);
  if (explicit.length) return explicit.join('\n');
  return (row.finalTags || []).join('\n');
}

function renderReviewIssues(issues) {
  const list = issues || [];
  if (!list.length) return '<div class="review-issue-list clean"><span>暂无提醒</span></div>';
  return `<div class="review-issue-list">${list.slice(0, 8).map(issue => `<span class="review-issue review-issue-${issue.severity}">${esc(issue.message)}</span>`).join('')}${list.length > 8 ? `<span class="review-issue review-issue-info">还有 ${list.length - 8} 项</span>` : ''}</div>`;
}

function currentReviewPanel() {
  return DOM.libraryContent.querySelector('[data-review-card-id]');
}

function reviewPanelValue(panel, name) {
  return panel?.querySelector(`[data-code-detail-field="${name}"]`)?.value || '';
}

function reviewDefaultCollectionForPanel(panel) {
  return reviewPanelValue(panel, 'status') === 'not_found' ? '需要手动核验' : 'MissAV_Import';
}

function setReviewAutoTags(source) {
  const panel = source.closest('[data-code-detail-id]');
  const status = reviewPanelValue(panel, 'status') || 'ok';
  const actresses = splitTagInput(reviewPanelValue(panel, 'actress_tags'));
  const genres = splitTagInput(reviewPanelValue(panel, 'genre_tags'));
  const tags = [];
  if (actresses.length) tags.push(...actresses);
  else if (['not_found', 'no_actress_found', 'need_manual_check'].includes(status)) tags.push('#未知女优');
  if (status !== 'not_found') tags.push(...genres);
  if (status === 'not_found') tags.push('需要查找');
  setRaindropEditorTags(panel?.querySelector('[data-rd-tag-editor]'), mergeTagLists([], tags));
  markCodeDetailDirty(panel);
}

function setReviewGeneratedNote(source) {
  const panel = source.closest('[data-code-detail-id]');
  const current = reviewPanelValue(panel, 'raindrop_note').trim();
  if (current && !confirm('当前 Note 已有内容，是否覆盖为自动备注？')) return;
  const code = reviewPanelValue(panel, 'code');
  const actresses = splitTagInput(reviewPanelValue(panel, 'actress_tags')).slice(0, 4).join(' / ');
  const genres = splitTagInput(reviewPanelValue(panel, 'genre_tags')).slice(0, 4).join(' / ');
  const parts = [code, actresses, genres].filter(Boolean);
  updateDetailField(source, 'raindrop_note', parts.join(' · '));
}

async function saveReviewCard(advance) {
  const panel = currentReviewPanel();
  if (!panel) throw new Error('没有可保存的整理卡片');
  const id = Number(panel.dataset.reviewCardId);
  const oldIndex = Math.max(0, Number(state.reviewDeck.index || 0));
  const get = name => reviewPanelValue(panel, name);
  api.dbUpdateCodeRecord(id, {
    code: get('code'),
    best_url: get('best_url'),
    status: get('status'),
    raindrop_title: get('raindrop_title'),
    raindrop_excerpt: get('raindrop_excerpt'),
    raindrop_note: get('raindrop_note'),
    raindrop_folder: get('raindrop_folder'),
    raindrop_tags: get('raindrop_tags'),
    raindrop_created: get('raindrop_created'),
    raindrop_cover: get('raindrop_cover'),
  });
  api.dbSetCodeActressTags(id, get('actress_tags'));
  api.dbSetCodeGenreTags(id, get('genre_tags'));
  state.selectedCodeId = id;
  if (advance) {
    state.reviewDeck.done = Number(state.reviewDeck.done || 0) + 1;
    const q = DOM.librarySearch ? DOM.librarySearch.value.trim() : '';
    const nextDeck = buildReviewDeck(q);
    const stillIndex = nextDeck.rows.findIndex(row => Number(row.id) === id);
    if (!nextDeck.rows.length) state.reviewDeck.index = 0;
    else if (stillIndex >= 0) state.reviewDeck.index = Math.min(stillIndex + 1, nextDeck.rows.length - 1);
    else state.reviewDeck.index = Math.min(oldIndex, nextDeck.rows.length - 1);
  }
  await refreshLibrary();
  toast(advance ? '已保存，进入下一条' : '整理卡片已保存', 'success');
}

function fillReviewGeneratedUrl(source) {
  const panel = source.closest('[data-code-detail-id]');
  const code = reviewPanelValue(panel, 'code');
  const urls = api.candidateUrls(code) || [];
  const url = urls[0] || `https://missav.ai/cn/${String(code || '').toLowerCase()}`;
  updateDetailField(source, 'best_url', url);
}

function renderLibraryExportPreview(q) {
  const preview = buildRaindropExportPreview(q);
  DOM.libraryContent.innerHTML = `
    <div class="export-preview-workbench">
      <div class="library-action-bar export-preview-toolbar">
        <button class="btn btn-secondary btn-sm" data-action="preview-refresh">刷新预览</button>
        <button class="btn btn-success btn-sm" data-action="preview-export-csv">导出 CSV</button>
        <button class="btn btn-outline btn-sm" data-action="preview-export-html">导出 HTML</button>
        <button class="btn btn-outline btn-sm" data-action="preview-open-codes">打开番号库</button>
        <span>当前预览受上方搜索框影响，CSV 字段为 folder,url,title,note,tags,created。</span>
      </div>
      <div class="export-preview-metrics">
        ${exportMetricCard('本次扫描', preview.total, '全部匹配记录')}
        ${exportMetricCard('可导出', preview.exportable.length, '存在有效链接')}
        ${exportMetricCard('无链接排除', preview.blocked.length, '不会进入导入文件')}
        ${exportMetricCard('未找到状态', preview.manual.length, '建议人工确认')}
        ${exportMetricCard('提醒项', preview.issues.length, '默认值或缺失字段')}
      </div>
      <div class="export-preview-grid">
        <section class="export-preview-section export-preview-table-section">
          <div class="export-preview-section-header"><h3>CSV 预览</h3><span>显示前 ${Math.min(preview.exportable.length, 80)} / ${preview.exportable.length} 条</span></div>
          ${renderExportPreviewTable(preview.exportable.slice(0, 80))}
        </section>
        <section class="export-preview-section">
          <div class="export-preview-section-header"><h3>问题与提醒</h3><span>${preview.issues.length ? '点击可定位编辑' : '没有发现阻塞项'}</span></div>
          ${renderExportIssueList(preview.issues)}
        </section>
      </div>
    </div>`;
}

function buildRaindropExportPreview(q) {
  const dbRows = api.dbGetCodeLibrary({ search: q || '', limit: 5000 });
  const importRows = api.dbGetRaindropImportRows({ includeNoUrl: true });
  const importById = new Map(importRows.map(row => [Number(row.id), row]));
  const rows = dbRows.map(row => ({ ...row, importRow: importById.get(Number(row.id)) || null }));
  const exportable = [];
  const blocked = [];
  const manual = [];
  const issues = [];

  for (const row of rows) {
    const item = row.importRow || {};
    const url = String(item.url || row.best_url || '').trim();
    const finalTags = item.finalTags || [];
    const title = item.title || row.raindrop_title || row.code;
    const folder = item.folder || row.raindrop_folder || defaultExportFolder(row);
    const created = item.created || '';
    const previewRow = { ...row, item, url, title, folder, finalTags, created };

    if (!url) {
      blocked.push(previewRow);
      issues.push(exportIssue(row, 'danger', '无链接：这条记录不会进入 Raindrop 导入文件'));
      continue;
    }
    exportable.push(previewRow);
    if (row.status === 'not_found') {
      manual.push(previewRow);
      issues.push(exportIssue(row, 'warn', '状态为 not_found 但存在链接，建议人工确认'));
    }
    if (!String(row.raindrop_title || '').trim()) issues.push(exportIssue(row, 'info', 'Title 使用番号作为默认值'));
    if (!String(row.raindrop_folder || '').trim()) issues.push(exportIssue(row, 'info', `Collection 使用默认值：${folder}`));
    if (!String(row.raindrop_tags || '').trim() && finalTags.length) issues.push(exportIssue(row, 'info', 'Tags 使用自动生成值'));
    if (!finalTags.length) issues.push(exportIssue(row, 'warn', 'Tags 为空，建议补充'));
    if (!String(row.raindrop_created || '').trim()) issues.push(exportIssue(row, 'info', 'Created 使用数据库创建时间'));
  }

  return { total: rows.length, rows, exportable, blocked, manual, issues };
}

function defaultExportFolder(row) {
  return row.status === 'not_found' ? '需要手动核验' : 'MissAV_Import';
}

function exportIssue(row, severity, message) {
  return { id: row.id, code: row.code, severity, message };
}

function exportMetricCard(label, value, note) {
  return `<div class="export-metric-card"><strong>${value}</strong><span>${esc(label)}</span><small>${esc(note)}</small></div>`;
}

function renderExportPreviewTable(rows) {
  if (!rows.length) return '<div class="library-empty">没有可导出的记录</div>';
  return `
    <div class="db-table-wrapper export-preview-table-wrapper">
      <table class="library-table export-preview-table">
        <thead><tr><th>番号</th><th>Title</th><th>Collection</th><th>Tags</th><th>Created</th><th>操作</th></tr></thead>
        <tbody>${rows.map(row => `
          <tr>
            <td class="mono">${esc(row.code)}</td>
            <td>${esc(row.title || '')}</td>
            <td>${esc(row.folder || '')}</td>
            <td class="export-tags-cell">${(row.finalTags || []).slice(0, 8).map(tag => `<span class="tag-chip">${esc(tag)}</span>`).join('') || '-'}</td>
            <td class="mono">${esc(row.created || '')}</td>
            <td class="library-actions"><button class="btn btn-outline btn-sm" data-action="preview-focus-code" data-id="${row.id}" data-code="${esc(row.code)}">编辑</button></td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;
}

function renderExportIssueList(issues) {
  if (!issues.length) return '<div class="library-empty">暂无导出问题</div>';
  return `<div class="export-issue-list">${issues.slice(0, 180).map(issue => `
    <button class="export-issue-item export-issue-${issue.severity}" data-action="preview-focus-code" data-id="${issue.id}" data-code="${esc(issue.code)}">
      <strong>${esc(issue.code)}</strong><span>${esc(issue.message)}</span>
    </button>`).join('')}${issues.length > 180 ? `<div class="export-issue-more">还有 ${issues.length - 180} 条未显示，可用搜索框缩小范围</div>` : ''}</div>`;
}

function renderLibraryActresses(q) {
  const rows = api.dbGetActressLibrary({ search: q, limit: 300 });
  state.libraryActresses = rows;
  DOM.libraryContent.innerHTML = `
    <div class="library-action-bar">
      <button class="btn btn-secondary btn-sm" data-action="create-actress">新增女优 Tag</button>
      <span>可重命名、合并、删除；删除会同步移除关联。</span>
    </div>
    ${!rows.length ? '<div class="library-empty">没有匹配的女优 tag</div>' : `
    <table class="library-table">
      <thead><tr><th>ID</th><th>女优 Tag</th><th>收藏数</th><th>番号示例</th><th>操作</th></tr></thead>
      <tbody>${rows.map(r => `
        <tr>
          <td class="mono">${r.id}</td>
          <td>${esc(r.tag_name)}</td>
          <td>${r.code_count}</td>
          <td class="library-codes">${r.sample_codes.map(esc).join(' ') || '-'}</td>
          <td class="library-actions">
            <button class="btn btn-outline btn-sm" data-action="rename-tag" data-id="${r.id}" data-name="${esc(r.tag_name)}">重命名</button>
            <button class="btn btn-outline btn-sm" data-action="merge-tag" data-id="${r.id}" data-name="${esc(r.tag_name)}">合并</button>
            <button class="btn btn-danger btn-sm" data-action="delete-tag" data-id="${r.id}" data-name="${esc(r.tag_name)}" data-count="${r.code_count}">删除</button>
          </td>
        </tr>`).join('')}</tbody>
    </table>`}
  `;
}

function renderLibraryHealth(q) {
  const report = api.dbGetHealthReport({ limit: 160, search: q });
  state.healthReport = report;
  const s = report.summary || {};
  const totalProblems = healthTotalProblems(s);
  DOM.libraryContent.innerHTML = `
    <div class="health-workbench">
      <div class="library-action-bar health-toolbar">
        <button class="btn btn-secondary btn-sm" data-action="health-refresh">重新扫描</button>
        <button class="btn btn-outline btn-sm" data-action="health-fix-no-url">为无链接生成链接</button>
        <button class="btn btn-outline btn-sm" data-action="health-clean-orphans">清理孤立 Tag</button>
        <button class="btn btn-outline btn-sm" data-action="health-clean-relations">清理坏关联</button>
        <button class="btn btn-outline btn-sm" data-action="health-open-filter" data-filter="no_url">查看无链接</button>
        <button class="btn btn-outline btn-sm" data-action="health-open-filter" data-filter="no_actress">查看无女优</button>
        <button class="btn btn-outline btn-sm" data-action="health-open-filter" data-filter="need_manual_check">查看需核验</button>
        <span>本次扫描发现 <strong>${totalProblems}</strong> 个/组待处理项，列表最多显示 ${report.limit} 条样本。</span>
      </div>
      <div class="health-stats-grid">
        ${healthStatCard('无链接', s.noUrl, 'health-warn')}
        ${healthStatCard('无女优', s.noActress, 'health-warn')}
        ${healthStatCard('无类型', s.noGenre, 'health-muted')}
        ${healthStatCard('需人工核验', s.manualStatus, 'health-warn')}
        ${healthStatCard('未找到', s.notFound, 'health-danger')}
        ${healthStatCard('疑似重复组', s.duplicateGroups, 'health-warn')}
        ${healthStatCard('孤立女优', s.orphanActresses, 'health-muted')}
        ${healthStatCard('孤立类型', s.orphanGenres, 'health-muted')}
        ${healthStatCard('坏关联', (s.brokenActressLinks || 0) + (s.brokenGenreLinks || 0), 'health-danger')}
        ${healthStatCard('状态矛盾', s.statusConflict, 'health-danger')}
      </div>
      <div class="health-section-grid">
        ${renderHealthCodeSection('无链接番号', 'noUrl', report.issues.noUrl, '可一键生成 MissAV 候选链接')}
        ${renderHealthCodeSection('缺少女优 Tag', 'noActress', report.issues.noActress, '建议进入详情补全女优 tag')}
        ${renderHealthCodeSection('需人工核验状态', 'manualStatus', report.issues.manualStatus, '这些记录建议重新打开页面确认')}
        ${renderHealthCodeSection('状态/链接矛盾', 'statusConflict', report.issues.statusConflict, '例如 ok 但无链接，或未找到但存在链接')}
        ${renderHealthTagSection('孤立女优 Tag', 'actress', report.issues.orphanActresses)}
        ${renderHealthTagSection('孤立类型 Tag', 'genre', report.issues.orphanGenres)}
        ${renderHealthDuplicateSection(report.issues.duplicates)}
        ${renderHealthRelationSection(report.issues.brokenActressLinks, report.issues.brokenGenreLinks)}
      </div>
    </div>
  `;
}

function healthTotalProblems(summary) {
  return ['noUrl', 'badUrl', 'noActress', 'noGenre', 'manualStatus', 'notFound', 'statusConflict', 'orphanActresses', 'orphanGenres', 'brokenActressLinks', 'brokenGenreLinks', 'duplicateGroups']
    .reduce((sum, key) => sum + Number(summary[key] || 0), 0);
}

function healthStatCard(label, value, tone) {
  return `<div class="health-stat-card ${tone || ''}"><strong>${Number(value || 0)}</strong><span>${esc(label)}</span></div>`;
}

function renderHealthCodeSection(title, key, rows, note) {
  const list = rows || [];
  return `
    <section class="health-section">
      <div class="health-section-header"><h3>${esc(title)}</h3><span>${esc(note || '')}</span></div>
      ${!list.length ? '<div class="library-empty">暂无问题</div>' : `
      <table class="library-table health-table">
        <tbody>${list.map(row => `
          <tr>
            <td class="mono">${esc(row.code)}</td>
            <td>${esc(row.status || '-')}</td>
            <td class="health-url-cell">${row.best_url ? esc(shortUrl(row.best_url)) : '-'}</td>
            <td class="library-actions">
              ${key === 'noUrl' ? `<button class="btn btn-outline btn-sm" data-action="health-generate-url" data-id="${row.id}" data-code="${esc(row.code)}">生成链接</button>` : ''}
              <button class="btn btn-outline btn-sm" data-action="health-focus-code" data-id="${row.id}" data-code="${esc(row.code)}">编辑</button>
            </td>
          </tr>`).join('')}</tbody>
      </table>`}
    </section>`;
}

function renderHealthTagSection(title, type, rows) {
  const list = rows || [];
  return `
    <section class="health-section">
      <div class="health-section-header"><h3>${esc(title)}</h3><span>没有任何番号关联，可以清理</span></div>
      ${!list.length ? '<div class="library-empty">暂无孤立 tag</div>' : `
      <table class="library-table health-table">
        <tbody>${list.map(row => {
          const name = type === 'actress' ? row.tag_name : row.name;
          return `<tr>
            <td class="mono">${row.id}</td>
            <td>${esc(name)}</td>
            <td class="library-actions"><button class="btn btn-danger btn-sm" data-action="health-delete-${type}" data-id="${row.id}" data-name="${esc(name)}">删除</button></td>
          </tr>`;
        }).join('')}</tbody>
      </table>`}
    </section>`;
}

function renderHealthDuplicateSection(groups) {
  const list = groups || [];
  return `
    <section class="health-section health-section-wide">
      <div class="health-section-header"><h3>疑似重复番号</h3><span>按去横杠后的可比 key 聚合</span></div>
      ${!list.length ? '<div class="library-empty">暂无疑似重复</div>' : list.slice(0, 30).map(group => `
        <div class="health-duplicate-group">
          <strong>${esc(group.key)}</strong>
          <div>${group.items.map(item => `<button class="health-code-pill" data-action="health-focus-code" data-id="${item.id}" data-code="${esc(item.code)}">${esc(item.code)}</button>`).join('')}</div>
        </div>`).join('')}
    </section>`;
}

function renderHealthRelationSection(actressLinks, genreLinks) {
  const a = actressLinks || [];
  const g = genreLinks || [];
  return `
    <section class="health-section">
      <div class="health-section-header"><h3>坏关联</h3><span>关联指向已不存在的番号或 tag</span></div>
      ${!a.length && !g.length ? '<div class="library-empty">暂无坏关联</div>' : `
        <div class="health-relation-list">
          ${a.slice(0, 60).map(row => `<div>女优关联：${row.actress_id} -> ${row.code_id}</div>`).join('')}
          ${g.slice(0, 60).map(row => `<div>类型关联：${row.genre_id} -> ${row.code_id}</div>`).join('')}
        </div>`}
    </section>`;
}

async function openHealthCode(id, code) {
  state.libraryTab = 'codes';
  state.selectedCodeId = null;
  state.codeStatusFilter = 'all';
  state.codeCollectionFilter = 'all';
  if (DOM.librarySearch) DOM.librarySearch.value = code || '';
  $$('.library-tabs .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.libraryTab === 'codes'));
  await refreshLibrary();
}
function renderLibraryBackups(q) {
  const stats = api.dbGetStats();
  const backupDir = api.dbGetBackupDirectory();
  const allRows = api.dbListBackups();
  const query = String(q || '').toLowerCase();
  const rows = query
    ? allRows.filter(row => [row.fileName, row.label, row.reason, row.createdAt].some(v => String(v || '').toLowerCase().includes(query)))
    : allRows;
  state.backupRows = rows;
  const latest = allRows[0];

  DOM.libraryContent.innerHTML = `
    <div class="backup-workbench">
      <div class="library-action-bar backup-toolbar">
        <button class="btn btn-secondary btn-sm" data-action="backup-create">创建备份</button>
        <button class="btn btn-outline btn-sm" data-action="backup-refresh">刷新列表</button>
        <button class="btn btn-outline btn-sm" data-action="backup-open-dir">打开备份目录</button>
        <button class="btn btn-outline btn-sm" data-action="backup-export-csv">导出合集 CSV</button>
        <span>恢复备份前会自动创建一份恢复前备份。</span>
      </div>
      <div class="backup-summary-grid">
        <div class="backup-summary-card"><strong>${stats.codeCount}</strong><span>当前番号</span></div>
        <div class="backup-summary-card"><strong>${stats.actressCount}</strong><span>女优 Tag</span></div>
        <div class="backup-summary-card"><strong>${stats.genreCount}</strong><span>类型 Tag</span></div>
        <div class="backup-summary-card"><strong>${allRows.length}</strong><span>备份数量</span></div>
        <div class="backup-summary-card"><strong>${latest ? fmtTime(latest.createdAt) : '-'}</strong><span>最近备份</span></div>
      </div>
      <div class="backup-path-panel">
        <span>备份目录</span><strong>${esc(backupDir)}</strong>
      </div>
      ${!rows.length ? '<div class="library-empty">暂无备份。点击“创建备份”生成第一份快照。</div>' : `
      <div class="db-table-wrapper backup-table-wrapper">
        <table class="library-table backup-table">
          <thead><tr><th>创建时间</th><th>标签</th><th>原因</th><th>大小</th><th>内容概览</th><th>文件</th><th>操作</th></tr></thead>
          <tbody>${rows.map(renderBackupRow).join('')}</tbody>
        </table>
      </div>`}
    </div>
  `;
}

function renderBackupRow(row) {
  const stats = row.stats || {};
  const overview = stats.codeCount === undefined
    ? '-'
    : `${stats.codeCount || 0} 番号 / ${stats.actressCount || 0} 女优 / ${stats.genreCount || 0} 类型`;
  return `
    <tr>
      <td>${esc(fmtTime(row.createdAt))}</td>
      <td>${esc(row.label || '-')}</td>
      <td><span class="backup-reason">${esc(backupReasonLabel(row.reason))}</span></td>
      <td class="mono">${formatBytes(row.size || 0)}</td>
      <td>${esc(overview)}</td>
      <td class="backup-file-cell" title="${esc(row.filePath || '')}">${esc(row.fileName || '')}</td>
      <td class="library-actions">
        <button class="btn btn-outline btn-sm" data-action="backup-restore" data-file="${esc(row.fileName)}">恢复</button>
        <button class="btn btn-outline btn-sm" data-action="backup-copy-path" data-path="${esc(row.filePath || '')}">复制路径</button>
        <button class="btn btn-danger btn-sm" data-action="backup-delete" data-file="${esc(row.fileName)}">删除</button>
      </td>
    </tr>`;
}

function backupReasonLabel(reason) {
  const map = {
    manual: '手动',
    pre_restore: '恢复前',
    auto: '自动',
    import: '导入前',
    bulk_edit: '批量编辑前',
  };
  return map[reason] || reason || '-';
}
function renderLibraryCodes(q) {
  const fetched = api.dbGetBookmarkLibrary({ search: q, limit: 50000 });
  state.libraryCodeAllRows = fetched;
  const collectionTree = buildCodeCollectionTree(api.dbGetBookmarkCollections(), fetched);
  if (state.codeCollectionFilter !== 'all' && state.codeCollectionFilter !== '__unfiled__' && !collectionTree.paths.has(state.codeCollectionFilter)) state.codeCollectionFilter = 'all';

  let rows = filterCodeRows(fetched);
  if (state.codeCollectionFilter !== 'all') rows = rows.filter(row => isWithinSelectedCollection(row, state.codeCollectionFilter));
  rows = sortCodeLibraryRows(rows);
  state.libraryCodes = rows;

  const pageCount = Math.max(1, Math.ceil(rows.length / state.codePageSize));
  state.codePage = Math.min(Math.max(1, state.codePage), pageCount);
  const start = (state.codePage - 1) * state.codePageSize;
  const pageRows = rows.slice(start, start + state.codePageSize);
  const availableIds = new Set(fetched.map(row => Number(row.id)));
  state.codeSelected = new Set([...state.codeSelected].filter(id => availableIds.has(Number(id))));
  if (state.selectedCodeId && !availableIds.has(Number(state.selectedCodeId))) state.selectedCodeId = pageRows[0]?.id || null;
  if (!state.selectedCodeId && pageRows.length) state.selectedCodeId = pageRows[0].id;
  const detailRow = fetched.find(row => Number(row.id) === Number(state.selectedCodeId)) || pageRows[0] || null;

  DOM.libraryContent.innerHTML = `
    <div class="code-workbench">
      <div class="library-action-bar code-primary-toolbar">
        <button class="btn btn-secondary btn-sm" data-action="create-code">新建收藏</button>
        <button class="btn btn-outline btn-sm" data-action="open-import-compare">导入并去重</button>
        <button class="btn btn-outline btn-sm" data-action="code-select-filtered">选择当前范围 ${rows.length}</button>
        <button class="btn btn-outline btn-sm" data-action="code-clear-selection">清空选择</button>
        <button class="btn btn-outline btn-sm" data-action="code-export-raindrop-csv">导出 CSV</button>
        <button class="btn btn-outline btn-sm" data-action="code-export-raindrop-html">导出 HTML</button>
        <label class="code-toolbar-field"><span>筛选</span><select data-code-filter-status="1">
          <option value="all" ${state.codeStatusFilter === 'all' ? 'selected' : ''}>全部</option>
          <option value="favorite" ${state.codeStatusFilter === 'favorite' ? 'selected' : ''}>收藏标记</option>
          <option value="highlights" ${state.codeStatusFilter === 'highlights' ? 'selected' : ''}>有 Highlights</option>
          <option value="has_code" ${state.codeStatusFilter === 'has_code' ? 'selected' : ''}>已识别番号</option>
          <option value="no_code" ${state.codeStatusFilter === 'no_code' ? 'selected' : ''}>普通网页</option>
          <option value="no_url" ${state.codeStatusFilter === 'no_url' ? 'selected' : ''}>无链接</option>
        </select></label>
        <label class="code-toolbar-field"><span>排序</span><select data-code-sort="1">
          <option value="recent" ${state.codeSort === 'recent' ? 'selected' : ''}>最近加入</option>
          <option value="code" ${state.codeSort === 'code' ? 'selected' : ''}>番号 A-Z</option>
          <option value="title" ${state.codeSort === 'title' ? 'selected' : ''}>标题 A-Z</option>
          <option value="collection" ${state.codeSort === 'collection' ? 'selected' : ''}>Collection</option>
        </select></label>
        <span>共 <strong>${rows.length}</strong> 条 · 已选 <strong data-code-selected-count="1">${state.codeSelected.size}</strong></span>
      </div>
      <details class="library-bulk-drawer" ${state.codeSelected.size ? 'open' : ''}>
        <summary>批量编辑选中的 <strong data-code-selected-count="1">${state.codeSelected.size}</strong> 条记录</summary>
        <datalist id="bulk-raindrop-collections">${raindropCollectionOptionsHtml()}</datalist>
        <div class="library-bulk-grid">
          <label class="code-toolbar-field"><span>Collection</span><input data-bulk-rd-collection list="bulk-raindrop-collections" placeholder="MissAV_Import"></label>
          <button class="btn btn-outline btn-sm" data-action="code-bulk-rd-collection">应用</button>
          <label class="code-toolbar-field"><span>Tags</span><input data-bulk-rd-tags placeholder="tag1, tag2"></label>
          <label class="code-toolbar-field"><span>方式</span><select data-bulk-rd-tags-mode><option value="append">追加</option><option value="replace">替换</option><option value="remove">删除</option></select></label>
          <button class="btn btn-outline btn-sm" data-action="code-bulk-rd-tags">应用</button>
          <label class="code-toolbar-field"><span>Created</span><input type="datetime-local" data-bulk-rd-created></label>
          <button class="btn btn-outline btn-sm" data-action="code-bulk-rd-created-now">现在</button>
          <button class="btn btn-outline btn-sm" data-action="code-bulk-rd-created">应用</button>
          <button class="btn btn-outline btn-sm" data-action="code-copy-selected">复制链接/番号</button>
          <button class="btn btn-danger btn-sm" data-action="code-bulk-delete">删除选中</button>
        </div>
      </details>
      <div class="raindrop-library-layout">
        <aside class="collection-sidebar">
          <div class="collection-sidebar-head"><strong>Collections</strong><span>${collectionTree.paths.size}</span><button class="collection-create-btn" data-action="collection-create" title="新建文件夹"><b>+</b><span>新建</span></button></div>
          <button class="collection-filter-item ${state.codeCollectionFilter === 'all' ? 'active' : ''}" data-action="code-filter-collection" data-collection="all" data-collection-context="all" data-collection-kind="all"><span>全部收藏</span><b>${fetched.length}</b></button>
          <button class="collection-filter-item ${state.codeCollectionFilter === '__unfiled__' ? 'active' : ''}" data-action="code-filter-collection" data-collection="__unfiled__" data-collection-context="__unfiled__" data-collection-kind="unfiled"><span>未分类</span><b>${collectionTree.unfiledCount}</b></button>
          <div class="collection-tree">${collectionTree.children.map(node => renderCollectionTreeNode(node, 0)).join('')}</div>
        </aside>
        <section class="raindrop-record-pane">
          <div class="record-pane-head"><span>${rows.length ? `${start + 1}-${Math.min(start + pageRows.length, rows.length)} / ${rows.length}` : '0 条记录'}</span><div><button class="btn btn-outline btn-sm" data-action="code-page" data-page="${state.codePage - 1}" ${state.codePage <= 1 ? 'disabled' : ''}>上一页</button><button class="btn btn-outline btn-sm" data-action="code-page" data-page="${state.codePage + 1}" ${state.codePage >= pageCount ? 'disabled' : ''}>下一页</button></div></div>
          <div class="raindrop-record-list">${pageRows.length ? pageRows.map(renderCodeLibraryItem).join('') : '<div class="library-empty">当前筛选下没有记录</div>'}</div>
        </section>
        ${renderCodeDetailPanel(detailRow)}
      </div>
    </div>`;
}

function codeCollectionKey(row) {
  return String(row.raindrop_folder || '').trim() || '__unfiled__';
}

function collectionPathParts(value) {
  return String(value || '').split(/\s+\/\s+/).map(part => part.trim()).filter(Boolean);
}

function buildCodeCollectionTree(collections, rows) {
  const root = { path: '', name: '', children: new Map(), directCount: 0, totalCount: 0 };
  const paths = new Set();
  const addPath = value => {
    const parts = collectionPathParts(value);
    if (!parts.length) return null;
    let node = root;
    const built = [];
    for (const part of parts) {
      built.push(part);
      const path = built.join(' / ');
      if (!node.children.has(part)) node.children.set(part, { path, name: part, children: new Map(), directCount: 0, totalCount: 0 });
      node = node.children.get(part);
      paths.add(path);
    }
    return node;
  };

  for (const collection of collections || []) addPath(collection.path);
  let unfiledCount = 0;
  for (const row of rows || []) {
    const key = codeCollectionKey(row);
    if (key === '__unfiled__') { unfiledCount++; continue; }
    const node = addPath(key);
    if (node) node.directCount++;
  }
  const finalize = node => {
    const children = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    node.children = children;
    node.totalCount = node.directCount + children.reduce((total, child) => total + finalize(child), 0);
    return node.totalCount;
  };
  finalize(root);
  return { children: root.children, paths, unfiledCount };
}

function isWithinSelectedCollection(row, collection) {
  const key = codeCollectionKey(row);
  if (collection === '__unfiled__') return key === '__unfiled__';
  return key === collection || key.startsWith(`${collection} / `);
}

function renderCollectionTreeNode(node, depth) {
  const hasChildren = node.children.length > 0;
  const collapsed = state.codeCollectionCollapsed.has(node.path);
  const active = state.codeCollectionFilter === node.path;
  return `<div class="collection-tree-node" style="--collection-depth:${depth}">
    <div class="collection-tree-row ${active ? 'active' : ''}" data-collection-context="${esc(node.path)}" data-collection-kind="folder">
      ${hasChildren ? `<button class="collection-toggle" data-action="collection-toggle" data-collection="${esc(node.path)}" title="${collapsed ? '展开子文件夹' : '折叠子文件夹'}" aria-label="${collapsed ? '展开' : '折叠'}">${collapsed ? '▸' : '▾'}</button>` : '<span class="collection-toggle-placeholder"></span>'}
      <button class="collection-tree-select" data-action="code-filter-collection" data-collection="${esc(node.path)}" title="${esc(node.path)}"><span>${esc(node.name)}</span><b>${node.totalCount}</b></button>
      <div class="collection-tree-actions">
        <button data-action="collection-menu-open" data-collection="${esc(node.path)}" data-collection-kind="folder" title="文件夹操作" aria-label="文件夹操作">⋮</button>
      </div>
    </div>
    ${hasChildren && !collapsed ? `<div class="collection-tree-children">${node.children.map(child => renderCollectionTreeNode(child, depth + 1)).join('')}</div>` : ''}
  </div>`;
}

function sortCodeLibraryRows(rows) {
  const next = [...rows];
  if (state.codeSort === 'code') next.sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));
  if (state.codeSort === 'title') next.sort((a, b) => String(a.raindrop_title || a.code).localeCompare(String(b.raindrop_title || b.code), undefined, { numeric: true }));
  if (state.codeSort === 'collection') next.sort((a, b) => String(a.raindrop_folder || '').localeCompare(String(b.raindrop_folder || '')) || String(a.code).localeCompare(String(b.code)));
  return next;
}

function renderCodeLibraryItem(row) {
  const id = Number(row.id);
  const selected = state.codeSelected.has(id);
  const focused = Number(state.selectedCodeId) === id;
  const title = row.raindrop_title || row.code;
  const collection = String(row.raindrop_folder || '').trim() || '未分类';
  const explicitTags = splitTagInput(row.raindrop_tags);
  const tags = explicitTags.length ? explicitTags : [...(row.actress_tags || []), ...(row.genre_tags || [])];
  return `<article class="raindrop-record-item ${selected ? 'is-selected' : ''} ${focused ? 'is-focused' : ''}" data-code-row="${id}">
    <input type="checkbox" data-code-select-row="${id}" ${selected ? 'checked' : ''}>
    <button class="record-main" data-action="code-focus-row" data-id="${id}">
      <strong>${esc(title)}</strong>
      <span class="record-code">${row.code ? `${esc(row.code)} · ` : ''}${esc(collection)}</span>
      <span class="record-link">${esc(row.best_url || 'No link')}</span>
      <span class="record-tags">${tags.slice(0, 4).map(tag => `<i>${esc(tag)}</i>`).join('') || '<i>无 Tags</i>'}</span>
    </button>
    <div class="record-side">
      <button class="record-favorite-btn ${row.favorite ? 'active' : ''}" data-action="bookmark-toggle-favorite" data-id="${id}" data-favorite="${row.favorite ? '1' : '0'}" title="${row.favorite ? '取消收藏标记' : '添加收藏标记'}">★</button>
      ${row.highlights ? '<span class="record-highlight-mark" title="包含 Highlights">H</span>' : ''}
      ${row.best_url ? `<button class="record-open-btn" data-action="open-url" data-url="${esc(row.best_url)}" title="打开链接">↗</button>` : ''}
    </div>
  </article>`;
}

function filterCodeRows(rows) {
  const filter = state.codeStatusFilter || 'all';
  if (filter === 'all') return rows;
  return rows.filter(row => {
    if (filter === 'favorite') return row.favorite === true;
    if (filter === 'highlights') return Boolean(String(row.highlights || '').trim());
    if (filter === 'has_code') return Boolean(String(row.code || '').trim());
    if (filter === 'no_code') return !String(row.code || '').trim();
    if (filter === 'no_url') return !String(row.best_url || '').trim();
    if (filter === 'no_actress') return !(row.actress_tags || []).length;
    if (filter === 'no_genre') return !(row.genre_tags || []).length;
    return String(row.status || '') === filter;
  });
}

function renderCodeTableRow(row) {
  const id = Number(row.id);
  const selected = state.codeSelected.has(id);
  const focused = Number(state.selectedCodeId) === id;
  return `
    <tr data-code-row="${id}" class="${selected ? 'code-row-selected' : ''} ${focused ? 'code-row-focused' : ''}">
      <td class="code-col-check"><input type="checkbox" data-code-select-row="${id}" ${selected ? 'checked' : ''}></td>
      <td class="mono"><button class="code-id-button" data-action="code-focus-row" data-id="${id}">${id}</button></td>
      <td><input class="code-cell-input code-code-input" data-code-cell="code" data-id="${id}" value="${esc(row.code)}"></td>
      <td><input class="code-cell-input code-title-input" data-code-cell="raindrop_title" data-id="${id}" value="${esc(row.raindrop_title || '')}" placeholder="默认用番号" title="${esc(row.raindrop_title || row.code || '')}"></td>
      <td><select class="code-status-select" data-code-cell="status" data-id="${id}">${statusOptionsHtml(row.status || 'ok')}</select></td>
      <td><input class="code-cell-input code-url-input" data-code-cell="best_url" data-id="${id}" value="${esc(row.best_url || '')}" title="${esc(row.best_url || '')}"></td>
      <td class="code-tags-cell">${renderTagChips(row.actress_tags)}</td>
      <td class="code-tags-cell">${renderTagChips(row.genre_tags)}</td>
      <td class="library-actions">
        <button class="btn btn-outline btn-sm" data-action="code-focus-row" data-id="${id}">详情</button>
        ${row.best_url ? `<button class="btn btn-outline btn-sm" data-action="open-url" data-url="${esc(row.best_url)}">打开</button>` : ''}
        <button class="btn btn-danger btn-sm" data-action="delete-code" data-id="${id}" data-code="${esc(row.code)}">删除</button>
      </td>
    </tr>`;
}

function renderCodeDetailPanel(row) {
  if (!row) {
    return `<aside class="code-detail-panel raindrop-edit-panel"><div class="library-empty">选择一条收藏后编辑详情</div></aside>`;
  }
  const tagsText = raindropTagTextForRow(row);
  const title = row.raindrop_title || row.code || row.best_url || 'Untitled';
  const cover = String(row.raindrop_cover || '').trim();
  const coverHtml = cover
    ? `<img src="${esc(cover)}" alt="">`
    : `<span>${esc(String(title).slice(0, 1).toUpperCase() || 'M')}</span>`;
  const collectionListId = `raindrop-collections-${row.id}`;

  return `
    <aside class="code-detail-panel raindrop-edit-panel" data-code-detail-id="${row.id}">
      <div class="raindrop-edit-header">
        <div class="raindrop-cover-preview" data-rd-cover>${coverHtml}</div>
        <div class="raindrop-edit-heading">
          <span>收藏详情</span>
          <h3 data-rd-title>${esc(title)}</h3>
          <p data-rd-link>${esc(row.best_url || 'No link')}</p>
        </div>
        <div class="raindrop-header-actions">
          <span class="raindrop-dirty-badge" data-detail-dirty-badge>未保存</span>
          <label class="favorite-toggle"><input type="checkbox" data-code-detail-field="favorite" ${row.favorite ? 'checked' : ''}><span>★</span></label>
          ${row.best_url ? `<button class="btn btn-outline btn-sm" data-action="open-url" data-url="${esc(row.best_url)}">打开</button>` : ''}
        </div>
      </div>

      <datalist id="${collectionListId}">${raindropCollectionOptionsHtml()}</datalist>
      <div class="raindrop-form">
        <label class="code-detail-field"><span>Title</span><input data-code-detail-field="raindrop_title" value="${esc(row.raindrop_title || '')}" placeholder="${esc(row.code || 'Untitled')}"></label>
        <label class="code-detail-field"><span>Link</span><input data-code-detail-field="best_url" value="${esc(row.best_url || '')}"></label>
        <label class="code-detail-field"><span>Collection</span><input data-code-detail-field="raindrop_folder" list="${collectionListId}" value="${esc(row.raindrop_folder || '')}" placeholder="MissAV_Import"></label>
        <label class="code-detail-field"><span>Tags</span>${renderRaindropTagEditor(tagsText)}</label>
        <label class="code-detail-field"><span>Note</span><textarea data-code-detail-field="raindrop_note" spellcheck="false">${esc(row.raindrop_note || '')}</textarea></label>
        <label class="code-detail-field"><span>Created</span><div class="raindrop-field-row"><input data-code-detail-field="raindrop_created" value="${esc(row.raindrop_created || row.created_at || '')}" placeholder="2026-07-12T10:00:00.000Z"><button type="button" class="btn btn-outline btn-sm" data-action="detail-created-now">现在</button></div></label>
      </div>

      <details class="raindrop-extra-panel">
        <summary>Metadata</summary>
        <label class="code-detail-field"><span>Excerpt</span><textarea data-code-detail-field="raindrop_excerpt" spellcheck="false">${esc(row.raindrop_excerpt || '')}</textarea></label>
        <label class="code-detail-field"><span>Highlights</span><textarea data-code-detail-field="highlights" spellcheck="false">${esc(row.highlights || '')}</textarea></label>
        <label class="code-detail-field"><span>Cover</span><input data-code-detail-field="raindrop_cover" value="${esc(row.raindrop_cover || '')}"></label>
        <label class="code-detail-field"><span>Raindrop ID</span><input data-code-detail-field="raindrop_id" value="${esc(row.raindrop_id || '')}"></label>
        <label class="code-detail-field"><span>Last modified</span><input data-code-detail-field="last_modified" value="${esc(row.last_modified || '')}"></label>
        <div class="raindrop-inline-actions">
          <button type="button" class="btn btn-outline btn-sm" data-action="detail-cover-preview">刷新预览</button>
          <button type="button" class="btn btn-outline btn-sm" data-action="detail-cover-clear">清空封面</button>
        </div>
      </details>

      <details class="raindrop-extra-panel">
        <summary>番号索引${row.code ? ` · ${esc(row.code)}` : ''}</summary>
        <label class="code-detail-field"><span>番号</span><input data-code-detail-field="code" value="${esc(row.code || '')}"></label>
        ${row.source_code_id ? `<label class="code-detail-field"><span>状态</span><select data-code-detail-field="status">${statusOptionsHtml(row.status || 'historical')}</select></label>
        <label class="code-detail-field"><span>女优 Tag</span><textarea data-code-detail-field="actress_tags" spellcheck="false">${esc((row.actress_tags || []).join('\n'))}</textarea></label>
        <label class="code-detail-field"><span>类型 Tag</span><textarea data-code-detail-field="genre_tags" spellcheck="false">${esc((row.genre_tags || []).join('\n'))}</textarea></label>` : '<p class="bookmark-index-note">普通网页收藏无需番号字段；填写番号并保存后会自动加入去重索引。</p>'}
      </details>

      <div class="code-detail-actions raindrop-save-row">
        <button class="btn btn-success btn-sm" data-action="save-code-detail" data-id="${row.id}">保存</button>
        <button class="btn btn-secondary btn-sm" data-action="save-code-detail-next" data-id="${row.id}">保存并下一条</button>
        <button class="btn btn-outline btn-sm" data-action="detail-revert" data-id="${row.id}">撤销</button>
        ${row.code ? `<button class="btn btn-outline btn-sm" data-action="code-fill-detail-url" data-id="${row.id}">生成链接</button>` : ''}
        <button class="btn btn-danger btn-sm" data-action="delete-code" data-id="${row.id}" data-code="${esc(title)}">删除</button>
      </div>
    </aside>`;
}

function raindropTagTextForRow(row) {
  const explicit = splitTagInput(row.raindrop_tags);
  if (explicit.length) return explicit.join('\n');
  const tags = [];
  if ((row.actress_tags || []).length) tags.push(...row.actress_tags);
  else if (['not_found', 'no_actress_found', 'need_manual_check'].includes(row.status)) tags.push('#未知女优');
  if (row.status !== 'not_found') tags.push(...(row.genre_tags || []));
  if (row.status === 'not_found') tags.push('需要查找');
  return mergeTagLists([], tags).join('\n');
}

function renderRaindropTagEditor(value) {
  const tags = splitTagInput(value);
  return `
    <div class="raindrop-tag-editor" data-rd-tag-editor="1">
      <input type="hidden" data-code-detail-field="raindrop_tags" value="${esc(tags.join('\n'))}">
      <div class="raindrop-tag-list" data-rd-tag-list>${tags.map(raindropTagChipHtml).join('')}</div>
      <input class="raindrop-tag-input" data-rd-tag-input="1" placeholder="Add tag">
    </div>`;
}

function raindropTagChipHtml(tag) {
  return `<button type="button" class="raindrop-edit-chip" data-action="rd-tag-remove" data-tag="${esc(tag)}"><span>${esc(tag)}</span><b>x</b></button>`;
}

function raindropCollectionOptionsHtml() {
  const folders = new Set(['MissAV_Import', '需要手动核验']);
  for (const row of state.libraryCodeAllRows || []) {
    const value = String(row.raindrop_folder || '').trim();
    if (value) folders.add(value);
  }
  return [...folders].map(folder => `<option value="${esc(folder)}"></option>`).join('');
}

function toDateTimeLocalValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^\d{10,13}$/.test(text)) {
    const n = Number(text.length === 10 ? text + '000' : text);
    if (Number.isFinite(n)) return dateToLocalInput(new Date(n));
  }
  const match = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
  return match ? `${match[1]}T${match[2]}:${match[3]}` : '';
}

function dateToLocalInput(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

const CODE_STATUS_OPTIONS = [
  ['ok', 'ok'],
  ['historical', '历史收录'],
  ['need_manual_check', '需核验'],
  ['not_found', '未找到'],
  ['no_actress_found', '无女优'],
  ['page_ok_play_unknown', '页面可访问'],
  ['network_error', '网络错误'],
];

function statusOptionsHtml(status) {
  const current = String(status || 'ok');
  return CODE_STATUS_OPTIONS.map(([value, label]) => `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`).join('');
}

function selectedCodeIds() {
  return [...state.codeSelected].map(Number).filter(Boolean);
}

function currentCodePageRows() {
  const start = (Math.max(1, state.codePage) - 1) * state.codePageSize;
  return (state.libraryCodes || []).slice(start, start + state.codePageSize);
}

function selectedCodeRows() {
  const selected = new Set(selectedCodeIds());
  return (state.libraryCodeAllRows || []).filter(row => selected.has(Number(row.id)));
}

function splitTagInput(value) {
  return String(value || '').split(/[\n,，|、;；]+/).map(s => s.trim()).filter(Boolean);
}

function mergeTagLists(current, incoming) {
  const result = [];
  for (const item of [...(current || []), ...incoming]) {
    const name = String(item || '').trim();
    if (name && !result.includes(name)) result.push(name);
  }
  return result;
}

function removeTagList(current, removing) {
  const removeSet = new Set(removing.map(x => String(x).trim()).filter(Boolean));
  return (current || []).filter(tag => !removeSet.has(tag));
}

function updateCodeSelectionUi() {
  const count = state.codeSelected.size;
  $$('[data-code-selected-count]').forEach(el => { el.textContent = count; });
  $$('[data-code-row]').forEach(row => {
    const id = Number(row.dataset.codeRow);
    row.classList.toggle('code-row-selected', state.codeSelected.has(id));
    row.classList.toggle('is-selected', state.codeSelected.has(id));
  });
}

async function selectCodeById(id) {
  state.selectedCodeId = Number(id);
  await refreshLibrary();
}

function ensureSelectedCodes() {
  const ids = selectedCodeIds();
  if (!ids.length) throw new Error('请先勾选要批量处理的番号');
  return ids;
}
function renderLibraryGenres(q) {
  const rows = api.dbGetGenreLibrary({ search: q, limit: 300 });
  state.libraryGenres = rows;
  DOM.libraryContent.innerHTML = `
    <div class="library-action-bar">
      <button class="btn btn-secondary btn-sm" data-action="create-genre">新增类型 Tag</button>
      <span>类型 tag 可重命名或删除；删除会同步移除类型关联。</span>
    </div>
    ${!rows.length ? '<div class="library-empty">没有匹配的类型 tag</div>' : `
    <table class="library-table">
      <thead><tr><th>ID</th><th>类型 Tag</th><th>关联番号</th><th>番号示例</th><th>操作</th></tr></thead>
      <tbody>${rows.map(r => `
        <tr>
          <td class="mono">${r.id}</td>
          <td>${esc(r.name)}</td>
          <td>${r.code_count}</td>
          <td class="library-codes">${r.sample_codes.map(esc).join(' ') || '-'}</td>
          <td class="library-actions">
            <button class="btn btn-outline btn-sm" data-action="rename-genre" data-id="${r.id}" data-name="${esc(r.name)}">重命名</button>
            <button class="btn btn-danger btn-sm" data-action="delete-genre" data-id="${r.id}" data-name="${esc(r.name)}" data-count="${r.code_count}">删除</button>
          </td>
        </tr>`).join('')}</tbody>
    </table>`}
  `;
}

function renderLibraryRaw(q) {
  const tables = api.dbGetEditableTables();
  state.rawDbTables = tables;
  if (!tables.some(t => t.name === state.rawDbTable)) state.rawDbTable = tables[0]?.name || 'codes';
  const data = api.dbGetRawTableRows(state.rawDbTable, { search: q, limit: 700 });
  state.rawDbData = data;
  const tableOptions = tables.map(t => `<option value="${esc(t.name)}" ${t.name === state.rawDbTable ? 'selected' : ''}>${esc(t.label)} · ${esc(t.name)}</option>`).join('');
  DOM.libraryContent.innerHTML = `
    <div class="db-editor-shell">
      <div class="library-action-bar db-editor-toolbar">
        <label class="raw-table-picker"><span>数据表</span><select data-raw-table-select="1">${tableOptions}</select></label>
        <button class="btn btn-secondary btn-sm" data-action="raw-add-row">新增行</button>
        <span>${esc(data.label)}：显示 ${data.rows.length} 行；可编辑列为 ${data.editable.length ? data.editable.map(esc).join(', ') : '无'}</span>
      </div>
      <div class="db-table-wrapper">
        <table class="library-table db-raw-table">
          <thead><tr>${data.columns.map(col => `<th>${esc(col)}${data.pk.includes(col) ? '<small> PK</small>' : ''}</th>`).join('')}<th>操作</th></tr></thead>
          <tbody>${data.rows.length ? data.rows.map(row => renderRawTableRow(data, row)).join('') : `<tr><td colspan="${data.columns.length + 1}"><div class="library-empty">该表暂无记录</div></td></tr>`}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderRawTableRow(data, row) {
  const pk = rawPkForRow(row, data.pk);
  return `<tr>${data.columns.map(col => {
    const value = row[col] ?? '';
    if (data.editable.includes(col)) {
      return `<td><input class="raw-cell-input" data-raw-cell="1" data-raw-column="${esc(col)}" data-raw-pk="${esc(pk)}" value="${esc(value)}"></td>`;
    }
    return `<td><span class="raw-readonly-cell">${esc(value)}</span></td>`;
  }).join('')}<td class="library-actions"><button class="btn btn-danger btn-sm" data-action="raw-delete-row" data-raw-pk="${esc(pk)}">删除</button></td></tr>`;
}

function renderTagChips(tags) {
  return (tags || []).map(t => `<span class="tag-chip">${esc(t)}</span>`).join('') || '-';
}

function rawPkForRow(row, pkCols) {
  const pk = {};
  for (const col of pkCols) pk[col] = row[col];
  return JSON.stringify(pk);
}

function parseJsonAttr(value) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}
function renderLibraryDuplicates() {
  const groups = api.dbGetDuplicateCodeGroups();
  if (!groups.length) { DOM.libraryContent.innerHTML = '<div class="library-empty">没有发现疑似重复番号</div>'; return; }
  DOM.libraryContent.innerHTML = groups.map(g => `
    <div class="duplicate-group">
      <div class="duplicate-key">${esc(g.key)}</div>
      <table class="library-table compact">
        <tbody>${g.items.map(item => `
          <tr>
            <td class="mono">${item.id}</td>
            <td class="mono">${esc(item.code)}</td>
            <td>${esc(item.normalized)}</td>
            <td>${esc(item.status || '-')}</td>
            <td>${item.best_url ? `<button class="btn btn-outline btn-sm" data-action="open-url" data-url="${esc(item.best_url)}">打开</button>` : '-'}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`).join('');
}

function renderLibraryRuns() {
  DOM.libraryContent.innerHTML = renderRunList(api.dbGetRecentRuns(30));
}

function renderRunList(runs) {
  if (!runs || !runs.length) return '<div class="library-empty">暂无处理历史</div>';
  return `
    <table class="library-table">
      <thead><tr><th>ID</th><th>开始</th><th>结束</th><th>输入</th><th>新增</th><th>跳过</th><th>未找到</th><th>重复</th></tr></thead>
      <tbody>${runs.map(r => `
        <tr>
          <td class="mono">${r.id}</td><td>${esc(r.started_at || '')}</td><td>${esc(r.finished_at || '')}</td>
          <td>${r.total}</td><td>${r.new}</td><td>${r.skipped}</td><td>${r.notFound}</td><td>${r.duplicate}</td>
        </tr>`).join('')}</tbody>
    </table>
  `;
}

function closeCollectionContextMenu() {
  document.querySelector('.collection-context-menu')?.remove();
}

function collectionMenuHtml(collection, kind) {
  const common = `
    <button data-action="code-filter-collection" data-collection="${esc(collection)}"><span>打开</span></button>
    <button data-action="collection-select-scope" data-collection="${esc(collection)}"><span>选择当前范围</span></button>`;
  if (kind === 'all') {
    return `${common}<div class="collection-menu-separator"></div><button class="danger" data-action="collection-clear-scope" data-collection="all"><span>清空全部收藏和文件夹</span></button>`;
  }
  if (kind === 'unfiled') {
    return `${common}<div class="collection-menu-separator"></div><button class="danger" data-action="collection-clear-scope" data-collection="__unfiled__"><span>清空未分类收藏</span></button>`;
  }
  return `${common}
    <div class="collection-menu-separator"></div>
    <button data-action="collection-create" data-collection="${esc(collection)}"><span>新建子文件夹</span></button>
    <button data-action="collection-rename" data-collection="${esc(collection)}"><span>重命名</span></button>
    <button class="danger" data-action="collection-delete" data-collection="${esc(collection)}"><span>删除文件夹及内容</span></button>`;
}

function showCollectionContextMenu(collection, kind, x, y) {
  closeCollectionContextMenu();
  const menu = document.createElement('div');
  menu.className = 'collection-context-menu';
  menu.innerHTML = `<div class="collection-context-title">${esc(kind === 'all' ? '全部收藏' : kind === 'unfiled' ? '未分类' : collection)}</div>${collectionMenuHtml(collection, kind)}`;
  menu.addEventListener('click', handleLibraryAction);
  document.body.appendChild(menu);
  const maxLeft = Math.max(8, window.innerWidth - 230);
  const maxTop = Math.max(8, window.innerHeight - 250);
  menu.style.left = `${Math.min(Math.max(8, x), maxLeft)}px`;
  menu.style.top = `${Math.min(Math.max(8, y), maxTop)}px`;
}

function handleLibraryContextMenu(event) {
  const target = event.target.closest('[data-collection-context]');
  if (!target) return;
  event.preventDefault();
  event.stopPropagation();
  showCollectionContextMenu(target.dataset.collectionContext || 'all', target.dataset.collectionKind || 'folder', event.clientX, event.clientY);
}

function rowsForCollectionScope(collection) {
  let rows = filterCodeRows(state.libraryCodeAllRows || []);
  if (collection !== 'all') rows = rows.filter(row => isWithinSelectedCollection(row, collection));
  return rows;
}

async function selectCollectionScope(collection) {
  state.codeCollectionFilter = collection || 'all';
  state.codePage = 1;
  for (const row of rowsForCollectionScope(state.codeCollectionFilter)) state.codeSelected.add(Number(row.id));
  await refreshLibrary();
}

async function clearVirtualCollectionScope(scope) {
  const info = api.dbGetBookmarkScopeInfo(scope);
  if (!info.bookmarkCount && !info.collectionCount) {
    toast(scope === 'all' ? '收藏库和文件夹已经为空' : '未分类中没有收藏', 'info');
    return;
  }
  const message = scope === 'all'
    ? `确认清空全部 ${info.bookmarkCount} 条收藏和 ${info.collectionCount} 个文件夹？\n永久番号索引不会删除。`
    : `确认删除未分类中的 ${info.bookmarkCount} 条收藏？\n永久番号索引不会删除。`;
  if (!confirm(message)) return;
  createBulkEditBackup(scope === 'all' ? 'clear_all_bookmarks' : 'clear_unfiled_bookmarks');
  api.dbDeleteBookmarksByScope(scope);
  state.codeSelected.clear();
  state.selectedCodeId = null;
  state.codeCollectionFilter = 'all';
  state.codeCollectionCollapsed.clear();
  await afterDbWrite(scope === 'all' ? '已清空全部收藏和文件夹' : '已清空未分类收藏');
}

async function handleLibraryAction(event) {
  const btn = event.target.closest('[data-action]');
  if (!btn) {
    const row = event.target.closest('[data-code-row]');
    if (row && !event.target.closest('input, select, textarea')) await selectCodeById(Number(row.dataset.codeRow));
    return;
  }
  const action = btn.dataset.action;
  if (action !== 'collection-menu-open') closeCollectionContextMenu();

  try {
    if (action === 'bookmark-toggle-favorite') {
      const id = Number(btn.dataset.id);
      api.dbUpdateBookmarkRecord(id, { favorite: btn.dataset.favorite !== '1' });
      state.selectedCodeId = id;
      await afterDbWrite(btn.dataset.favorite === '1' ? '已取消收藏标记' : '已添加收藏标记');
      return;
    }

    if (action === 'maintenance-open') {
      switchLibraryTab(btn.dataset.tab || 'maintenance');
      return;
    }

    if (action === 'open-import-compare') {
      switchLibraryTab('dedupe');
      return;
    }

    if (action === 'code-filter-collection') {
      state.codeCollectionFilter = btn.dataset.collection || 'all';
      state.codePage = 1;
      await refreshLibrary();
      return;
    }

    if (action === 'collection-toggle') {
      const path = btn.dataset.collection || '';
      if (state.codeCollectionCollapsed.has(path)) state.codeCollectionCollapsed.delete(path);
      else state.codeCollectionCollapsed.add(path);
      await refreshLibrary();
      return;
    }

    if (action === 'collection-menu-open') {
      event.stopPropagation();
      const rect = btn.getBoundingClientRect();
      showCollectionContextMenu(btn.dataset.collection || 'all', btn.dataset.collectionKind || 'folder', rect.right + 4, rect.top);
      return;
    }

    if (action === 'collection-select-scope') {
      await selectCollectionScope(btn.dataset.collection || 'all');
      return;
    }

    if (action === 'collection-clear-scope') {
      await clearVirtualCollectionScope(btn.dataset.collection || 'all');
      return;
    }

    if (action === 'collection-create') {
      await createCollectionByPrompt(btn.dataset.collection || '');
      return;
    }

    if (action === 'collection-rename') {
      await renameCollectionByPrompt(btn.dataset.collection || '');
      return;
    }

    if (action === 'collection-delete') {
      await deleteCollectionByPrompt(btn.dataset.collection || '');
      return;
    }

    if (action === 'code-page') {
      state.codePage = Math.max(1, Number(btn.dataset.page || 1));
      await refreshLibrary();
      return;
    }

    if (action === 'import-compare-analyze') {
      const input = DOM.libraryContent.querySelector('[data-import-compare-input]');
      await analyzeImportComparison(input?.value || state.importCompare.text);
      return;
    }

    if (action === 'import-compare-files') {
      await importComparisonFiles();
      return;
    }

    if (action === 'import-compare-from-process') {
      state.importCompare.text = DOM.codeInput.value || '';
      await analyzeImportComparison(state.importCompare.text);
      return;
    }

    if (action === 'import-compare-clear') {
      state.importCompare = { text: '', rows: [], policy: 'new_only', filter: 'all', selected: new Set(), metadataByKey: new Map(), sourceLabel: '' };
      await refreshLibrary();
      return;
    }

    if (action === 'import-filter') {
      state.importCompare.filter = btn.dataset.filter || 'all';
      await refreshLibrary();
      return;
    }

    if (action === 'import-select-new') {
      state.importCompare.selected = new Set((state.importCompare.rows || []).filter(row => row.classification === 'new').map(row => row.key));
      await refreshLibrary();
      return;
    }

    if (action === 'import-select-all') {
      state.importCompare.selected = new Set((state.importCompare.rows || []).map(row => row.key));
      await refreshLibrary();
      return;
    }

    if (action === 'import-select-none') {
      state.importCompare.selected.clear();
      await refreshLibrary();
      return;
    }

    if (action === 'import-send-process') {
      await sendImportSelectionToProcess();
      return;
    }

    if (action === 'import-add-history') {
      await addImportSelectionToHistory();
      return;
    }

    if (action === 'open-url') {
      await api.openExternal(btn.dataset.url);
      return;
    }

    if (action === 'rd-tag-remove') {
      removeRaindropTag(btn);
      return;
    }

    if (action === 'detail-revert') {
      await revertCodeDetail(btn);
      return;
    }

    if (action === 'detail-cover-clear') {
      updateDetailField(btn, 'raindrop_cover', '');
      return;
    }

    if (action === 'detail-cover-preview') {
      const panel = btn.closest('[data-code-detail-id]');
      updateRaindropHeaderFromPanel(panel);
      toast('封面预览已刷新', 'success');
      return;
    }

    if (action === 'detail-created-now') {
      updateDetailField(btn, 'raindrop_created', new Date().toISOString());
      return;
    }

    if (action === 'create-actress') {
      const name = prompt('输入新的女优 tag 名称：', '');
      if (!name) return;
      api.dbCreateActressTag(name.trim());
      await afterDbWrite('女优 tag 已新增');
      return;
    }

    if (action === 'rename-tag') {
      const oldName = btn.dataset.name || '';
      const nextName = prompt('输入新的女优 tag 名称：', oldName);
      if (!nextName || nextName === oldName) return;
      api.dbRenameActressTag(Number(btn.dataset.id), nextName.trim());
      await afterDbWrite('重命名完成');
      return;
    }

    if (action === 'merge-tag') {
      const sourceId = Number(btn.dataset.id);
      const sourceName = btn.dataset.name || '';
      const targetInput = prompt(`把「${sourceName}」合并到哪个 tag？请输入目标 tag 名称或 ID：`, '');
      if (!targetInput) return;
      const candidates = api.dbGetActressLibrary({ search: targetInput.trim(), limit: 50 });
      const target = candidates.find(x => String(x.id) === targetInput.trim() || x.tag_name === targetInput.trim()) || candidates[0];
      if (!target) { toast('没有找到目标 tag', 'error'); return; }
      if (!confirm(`确认把「${sourceName}」合并到「${target.tag_name}」？源 tag 会被删除。`)) return;
      api.dbMergeActressTags(sourceId, target.id);
      await afterDbWrite('合并完成');
      return;
    }

    if (action === 'delete-tag') {
      const name = btn.dataset.name || '';
      const count = Number(btn.dataset.count || 0);
      const note = count > 0 ? `，并移除它关联的 ${count} 个番号关系` : '';
      if (!confirm(`确认删除女优 tag「${name}」${note}？`)) return;
      api.dbDeleteActressTag(Number(btn.dataset.id));
      await afterDbWrite('女优 tag 已删除');
      return;
    }

    if (action === 'code-focus-row') {
      await selectCodeById(Number(btn.dataset.id));
      return;
    }

    if (action === 'code-select-filtered') {
      for (const row of state.libraryCodes || []) state.codeSelected.add(Number(row.id));
      await refreshLibrary();
      return;
    }

    if (action === 'code-clear-selection') {
      state.codeSelected.clear();
      updateCodeSelectionUi();
      await refreshLibrary();
      return;
    }

    if (action === 'code-copy-selected') {
      await copySelectedCodeList();
      return;
    }

    if (action === 'code-export-raindrop-csv') {
      await exportLibraryRaindrop('csv');
      return;
    }

    if (action === 'code-export-raindrop-html') {
      await exportLibraryRaindrop('html');
      return;
    }

    if (action === 'map-refresh') {
      await refreshLibrary();
      return;
    }

    if (action === 'map-select-collection') {
      state.collectionMap.collection = btn.dataset.collection || 'all';
      await refreshLibrary();
      return;
    }

    if (action === 'map-select-tag') {
      const tag = btn.dataset.tag || '';
      state.collectionMap.tag = state.collectionMap.tag === tag ? '' : tag;
      await refreshLibrary();
      return;
    }

    if (action === 'map-toggle-risk') {
      state.collectionMap.riskOnly = !state.collectionMap.riskOnly;
      await refreshLibrary();
      return;
    }

    if (action === 'map-clear-filters') {
      state.collectionMap = { collection: 'all', tag: '', riskOnly: false };
      await refreshLibrary();
      return;
    }

    if (action === 'map-random-review') {
      await focusCollectionMapRandom();
      return;
    }

    if (action === 'map-focus-code') {
      await openHealthCode(Number(btn.dataset.id), btn.dataset.code || '');
      return;
    }
    if (action === 'review-refresh') {
      await refreshLibrary();
      return;
    }

    if (action === 'review-prev') {
      state.reviewDeck.index = Math.max(0, Number(state.reviewDeck.index || 0) - 1);
      await refreshLibrary();
      return;
    }

    if (action === 'review-next') {
      state.reviewDeck.index = Number(state.reviewDeck.index || 0) + 1;
      await refreshLibrary();
      return;
    }

    if (action === 'review-skip') {
      state.reviewDeck.skipped = Number(state.reviewDeck.skipped || 0) + 1;
      state.reviewDeck.index = Number(state.reviewDeck.index || 0) + 1;
      await refreshLibrary();
      return;
    }

    if (action === 'review-random') {
      const q = DOM.librarySearch ? DOM.librarySearch.value.trim() : '';
      const deck = buildReviewDeck(q);
      if (!deck.rows.length) { toast('当前队列没有记录', 'info'); return; }
      state.reviewDeck.index = Math.floor(Math.random() * deck.rows.length);
      await refreshLibrary();
      return;
    }

    if (action === 'review-go-index') {
      state.reviewDeck.index = Math.max(0, Number(btn.dataset.index || 0));
      await refreshLibrary();
      return;
    }

    if (action === 'review-focus-code') {
      await openHealthCode(Number(btn.dataset.id), btn.dataset.code || '');
      return;
    }

    if (action === 'review-save-next') {
      await saveReviewCard(true);
      return;
    }

    if (action === 'review-save-stay') {
      await saveReviewCard(false);
      return;
    }

    if (action === 'review-fix-url') {
      fillReviewGeneratedUrl(btn);
      return;
    }

    if (action === 'review-fix-status-ok') {
      updateDetailField(btn, 'status', 'ok');
      return;
    }

    if (action === 'review-fix-title') {
      const panel = btn.closest('[data-code-detail-id]');
      updateDetailField(btn, 'raindrop_title', reviewPanelValue(panel, 'code'));
      return;
    }

    if (action === 'review-fix-collection') {
      updateDetailField(btn, 'raindrop_folder', reviewDefaultCollectionForPanel(btn.closest('[data-code-detail-id]')));
      return;
    }

    if (action === 'review-fix-tags') {
      setReviewAutoTags(btn);
      return;
    }

    if (action === 'review-fix-created') {
      updateDetailField(btn, 'raindrop_created', dateToLocalInput(new Date()));
      return;
    }

    if (action === 'review-fix-note') {
      setReviewGeneratedNote(btn);
      return;
    }

    if (action === 'review-clear-cover') {
      updateDetailField(btn, 'raindrop_cover', '');
      return;
    }

    if (action === 'preview-refresh') {
      await refreshLibrary();
      return;
    }

    if (action === 'preview-export-csv') {
      await exportLibraryRaindrop('csv');
      return;
    }

    if (action === 'preview-export-html') {
      await exportLibraryRaindrop('html');
      return;
    }

    if (action === 'preview-open-codes') {
      switchLibraryTab('codes');
      return;
    }

    if (action === 'preview-focus-code') {
      await openHealthCode(Number(btn.dataset.id), btn.dataset.code || '');
      return;
    }

    if (action === 'code-bulk-status') {
      await bulkUpdateCodeStatus();
      return;
    }

    if (action === 'code-bulk-add-actress') {
      await bulkChangeCodeTags('actress', 'add');
      return;
    }

    if (action === 'code-bulk-remove-actress') {
      await bulkChangeCodeTags('actress', 'remove');
      return;
    }

    if (action === 'code-bulk-add-genre') {
      await bulkChangeCodeTags('genre', 'add');
      return;
    }

    if (action === 'code-bulk-remove-genre') {
      await bulkChangeCodeTags('genre', 'remove');
      return;
    }

    if (action === 'code-bulk-generate-url') {
      await bulkGenerateCodeUrls();
      return;
    }

    if (action === 'code-bulk-normalize') {
      await bulkNormalizeCodes();
      return;
    }

    if (action === 'code-bulk-delete') {
      await bulkDeleteCodes();
      return;
    }

    if (action === 'code-bulk-rd-collection') {
      await bulkApplyRaindropCollection();
      return;
    }

    if (action === 'code-bulk-rd-tags') {
      await bulkApplyRaindropTags();
      return;
    }

    if (action === 'code-bulk-rd-auto-tags') {
      await bulkWriteAutoRaindropTags();
      return;
    }

    if (action === 'code-bulk-rd-created-now') {
      setBulkCreatedNow();
      return;
    }

    if (action === 'code-bulk-rd-created') {
      await bulkApplyRaindropCreated();
      return;
    }

    if (action === 'code-bulk-rd-title') {
      await bulkApplyRaindropTitle();
      return;
    }

    if (action === 'code-bulk-rd-clear') {
      await bulkClearRaindropField();
      return;
    }

    if (action === 'save-code-detail') {
      await saveCodeDetail(Number(btn.dataset.id));
      return;
    }

    if (action === 'save-code-detail-next') {
      await saveCodeDetailAndNext(Number(btn.dataset.id));
      return;
    }

    if (action === 'code-fill-detail-url') {
      await fillDetailUrl(Number(btn.dataset.id));
      return;
    }
    if (action === 'create-code') {
      await createBookmarkByPrompt();
      return;
    }

    if (action === 'edit-code') {
      await editCodeByPrompt(Number(btn.dataset.id));
      return;
    }

    if (action === 'delete-code') {
      const title = btn.dataset.code || '';
      if (!confirm(`确认从本地收藏库删除「${title}」？番号去重索引会继续保留。`)) return;
      api.dbDeleteBookmarkRecord(Number(btn.dataset.id));
      await afterDbWrite('收藏已删除');
      return;
    }

    if (action === 'create-genre') {
      const name = prompt('输入新的类型 tag 名称：', '');
      if (!name) return;
      api.dbCreateGenreTag(name.trim());
      await afterDbWrite('类型 tag 已新增');
      return;
    }

    if (action === 'rename-genre') {
      const oldName = btn.dataset.name || '';
      const nextName = prompt('输入新的类型 tag 名称：', oldName);
      if (!nextName || nextName === oldName) return;
      api.dbRenameGenreTag(Number(btn.dataset.id), nextName.trim());
      await afterDbWrite('类型 tag 已重命名');
      return;
    }

    if (action === 'delete-genre') {
      const name = btn.dataset.name || '';
      const count = Number(btn.dataset.count || 0);
      const note = count > 0 ? `，并移除它关联的 ${count} 个番号关系` : '';
      if (!confirm(`确认删除类型 tag「${name}」${note}？`)) return;
      api.dbDeleteGenreTag(Number(btn.dataset.id));
      await afterDbWrite('类型 tag 已删除');
      return;
    }

    if (action === 'raw-add-row') {
      await addRawRowByPrompt();
      return;
    }

    if (action === 'raw-delete-row') {
      const pk = parseJsonAttr(btn.dataset.rawPk);
      if (!confirm(`确认删除 ${state.rawDbTable} 表中的这条记录？`)) return;
      api.dbDeleteRawRow(state.rawDbTable, pk);
      await afterDbWrite('原始表记录已删除');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function handleLibraryChange(event) {
  const importPolicy = event.target.closest('[data-import-policy]');
  if (importPolicy) {
    state.importCompare.policy = importPolicy.value || 'new_only';
    applyImportComparePolicy();
    await refreshLibrary();
    return;
  }

  const importRow = event.target.closest('[data-import-row-key]');
  if (importRow) {
    const key = importRow.dataset.importRowKey || '';
    if (importRow.checked) state.importCompare.selected.add(key);
    else state.importCompare.selected.delete(key);
    await refreshLibrary();
    return;
  }

  const reviewQueue = event.target.closest('[data-review-queue]');
  if (reviewQueue) {
    state.reviewDeck.queue = reviewQueue.value || 'priority';
    state.reviewDeck.index = 0;
    await refreshLibrary();
    return;
  }
  const codeFilter = event.target.closest('[data-code-filter-status]');
  if (codeFilter) {
    state.codeStatusFilter = codeFilter.value || 'all';
    state.codePage = 1;
    await refreshLibrary();
    return;
  }

  const codeSort = event.target.closest('[data-code-sort]');
  if (codeSort) {
    state.codeSort = codeSort.value || 'recent';
    state.codePage = 1;
    await refreshLibrary();
    return;
  }

  const rowSelect = event.target.closest('[data-code-select-row]');
  if (rowSelect) {
    const id = Number(rowSelect.dataset.codeSelectRow);
    if (rowSelect.checked) {
      state.codeSelected.add(id);
    } else {
      state.codeSelected.delete(id);
    }
    updateCodeSelectionUi();
    return;
  }

  const codeCell = event.target.closest('[data-code-cell]');
  if (codeCell) {
    const id = Number(codeCell.dataset.id);
    const field = codeCell.dataset.codeCell;
    const value = codeCell.value;
    const patch = {};
    patch[field] = value;
    state.selectedCodeId = id;
    api.dbUpdateCodeRecord(id, patch);
    await afterDbWrite('单元格已保存');
    return;
  }

  const tableSelect = event.target.closest('[data-raw-table-select]');
  if (tableSelect) {
    state.rawDbTable = tableSelect.value || 'codes';
    await refreshLibrary();
    return;
  }

  const cell = event.target.closest('[data-raw-cell]');
  if (!cell) return;
  try {
    api.dbUpdateRawCell(state.rawDbTable, parseJsonAttr(cell.dataset.rawPk), cell.dataset.rawColumn, cell.value);
    await afterDbWrite('单元格已保存');
  } catch (err) {
    toast(err.message, 'error');
    await refreshLibrary();
  }
}

function handleLibraryInput(event) {
  const importInput = event.target.closest('[data-import-compare-input]');
  if (importInput) {
    state.importCompare.text = importInput.value;
    return;
  }
  const field = event.target.closest('[data-code-detail-field]');
  if (!field) return;
  const panel = field.closest('[data-code-detail-id]');
  markCodeDetailDirty(panel);
  updateRaindropHeaderFromPanel(panel);
}

async function handleLibraryKeydown(event) {
  if (event.ctrlKey && event.key.toLowerCase() === 's') {
    const panel = event.target.closest('[data-code-detail-id]');
    if (panel) {
      event.preventDefault();
      await saveCodeDetail(Number(panel.dataset.codeDetailId));
      return;
    }
  }
  if (event.ctrlKey && event.key === 'Enter' && event.target.closest('[data-import-compare-input]')) {
    event.preventDefault();
    await analyzeImportComparison(event.target.value);
    return;
  }
  const tagInput = event.target.closest('[data-rd-tag-input]');
  if (!tagInput) return;
  if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
    event.preventDefault();
    addRaindropTagsFromInput(tagInput);
  } else if (event.key === 'Backspace' && !tagInput.value) {
    const editor = tagInput.closest('[data-rd-tag-editor]');
    const tags = getRaindropEditorTags(editor);
    if (tags.length) {
      tags.pop();
      setRaindropEditorTags(editor, tags);
      markCodeDetailDirty(tagInput.closest('[data-code-detail-id]'));
    }
  }
}

function handleLibraryFocusOut(event) {
  const tagInput = event.target.closest('[data-rd-tag-input]');
  if (tagInput) addRaindropTagsFromInput(tagInput);
}

function addRaindropTagsFromInput(input) {
  const incoming = splitTagInput(input.value);
  if (!incoming.length) return false;
  const editor = input.closest('[data-rd-tag-editor]');
  const next = mergeTagLists(getRaindropEditorTags(editor), incoming);
  setRaindropEditorTags(editor, next);
  input.value = '';
  markCodeDetailDirty(input.closest('[data-code-detail-id]'));
  return true;
}

function removeRaindropTag(btn) {
  const editor = btn.closest('[data-rd-tag-editor]');
  const target = btn.dataset.tag || '';
  const next = getRaindropEditorTags(editor).filter(tag => tag !== target);
  setRaindropEditorTags(editor, next);
  markCodeDetailDirty(btn.closest('[data-code-detail-id]'));
}

function getRaindropEditorTags(editor) {
  const hidden = editor?.querySelector('[data-code-detail-field="raindrop_tags"]');
  return splitTagInput(hidden?.value || '');
}

function setRaindropEditorTags(editor, tags) {
  if (!editor) return;
  const normalized = mergeTagLists([], tags || []);
  const hidden = editor.querySelector('[data-code-detail-field="raindrop_tags"]');
  const list = editor.querySelector('[data-rd-tag-list]');
  if (hidden) hidden.value = normalized.join('\n');
  if (list) list.innerHTML = normalized.map(raindropTagChipHtml).join('');
}

function updateDetailField(source, fieldName, value) {
  const panel = source.closest('[data-code-detail-id]');
  const field = panel?.querySelector(`[data-code-detail-field="${fieldName}"]`);
  if (!field) return;
  field.value = value;
  markCodeDetailDirty(panel);
  updateRaindropHeaderFromPanel(panel);
}

async function revertCodeDetail(btn) {
  const panel = btn.closest('[data-code-detail-id]');
  if (panel?.classList.contains('is-dirty') && !confirm('放弃当前未保存修改？')) return;
  await refreshLibrary();
}

function markCodeDetailDirty(panel) {
  if (!panel) return;
  panel.classList.add('is-dirty');
}

function updateRaindropHeaderFromPanel(panel) {
  if (!panel) return;
  const get = name => panel.querySelector(`[data-code-detail-field="${name}"]`)?.value || '';
  const title = get('raindrop_title') || get('code') || 'Untitled';
  const link = get('best_url') || 'No link';
  const titleEl = panel.querySelector('[data-rd-title]');
  const linkEl = panel.querySelector('[data-rd-link]');
  if (titleEl) titleEl.textContent = title;
  if (linkEl) linkEl.textContent = link;
  updateRaindropCoverPreview(panel, get('raindrop_cover'), title);
}

function updateRaindropCoverPreview(panel, cover, title) {
  const target = panel?.querySelector('[data-rd-cover]');
  if (!target) return;
  const url = String(cover || '').trim();
  target.innerHTML = url ? `<img src="${esc(url)}" alt="">` : `<span>${esc(String(title || 'M').slice(0, 1).toUpperCase() || 'M')}</span>`;
}

async function createCodeByPrompt() {
  const code = prompt('番号：', '');
  if (!code) return;
  const url = prompt('链接（可留空）：', '');
  if (url === null) return;
  const status = prompt('状态：', 'ok');
  if (status === null) return;
  const actresses = prompt('女优 tag，多个用逗号、换行或 | 分隔（可留空）：', '');
  if (actresses === null) return;
  const genres = prompt('类型 tag，多个用逗号、换行或 | 分隔（可留空）：', '');
  if (genres === null) return;

  const id = api.dbCreateCodeRecord(code, url, status);
  api.dbSetCodeActressTags(id, actresses);
  api.dbSetCodeGenreTags(id, genres);
  await afterDbWrite('番号已新增');
}

async function createBookmarkByPrompt() {
  const url = prompt('Link（可留空）：', '');
  if (url === null) return;
  const title = prompt('Title：', '');
  if (title === null) return;
  if (!url.trim() && !title.trim()) throw new Error('Title 和 Link 至少填写一项');
  const folder = prompt('Collection：', 'MissAV_Import');
  if (folder === null) return;
  const tags = prompt('Tags，多个用逗号分隔：', '');
  if (tags === null) return;
  const code = api.parseCodeList(`${url}\n${title}`)[0] || '';
  const result = api.dbCreateBookmarkRecord({ url, title, folder, tags, code, created: new Date().toISOString() });
  state.selectedCodeId = result.id || null;
  await afterDbWrite('收藏已新增');
}

function normalizeCollectionInput(value) {
  return String(value || '').replace(/\\/g, '/').split('/').map(part => part.trim()).filter(Boolean).join(' / ');
}

function showTextInputDialog({ title, label, value = '', placeholder = '', submitLabel = '确定' }) {
  return new Promise(resolve => {
    document.querySelector('.app-input-dialog-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'app-input-dialog-overlay';
    overlay.innerHTML = `<form class="app-input-dialog" role="dialog" aria-modal="true">
      <div class="app-input-dialog-head"><h3>${esc(title)}</h3><button type="button" data-dialog-cancel aria-label="关闭">×</button></div>
      <label><span>${esc(label)}</span><input value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off"></label>
      <div class="app-input-dialog-actions"><button type="button" class="btn btn-outline btn-sm" data-dialog-cancel>取消</button><button type="submit" class="btn btn-success btn-sm">${esc(submitLabel)}</button></div>
    </form>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('input');
    const finish = result => { overlay.remove(); resolve(result); };
    overlay.querySelectorAll('[data-dialog-cancel]').forEach(button => button.addEventListener('click', () => finish(null)));
    overlay.addEventListener('click', event => { if (event.target === overlay) finish(null); });
    overlay.querySelector('form').addEventListener('submit', event => { event.preventDefault(); finish(input.value); });
    overlay.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); finish(null); } });
    requestAnimationFrame(() => { input.focus(); input.select(); });
  });
}

function collectionParentPath(value) {
  const parts = collectionPathParts(value);
  return parts.slice(0, -1).join(' / ');
}

function replaceCollectionPath(value, source, target) {
  if (value === source) return target;
  if (String(value || '').startsWith(`${source} / `)) return `${target}${String(value).slice(source.length)}`;
  return value;
}

function updateCollectionPathState(source, target) {
  state.codeCollectionFilter = replaceCollectionPath(state.codeCollectionFilter, source, target);
  state.codeCollectionCollapsed = new Set([...state.codeCollectionCollapsed].map(path => replaceCollectionPath(path, source, target)));
}

async function createCollectionByPrompt(parentPath) {
  const parent = normalizeCollectionInput(parentPath);
  const name = await showTextInputDialog({
    title: parent ? '新建子文件夹' : '新建 Collection',
    label: parent ? `父文件夹：${parent}` : '文件夹名称',
    placeholder: parent ? '输入子文件夹名称' : '例如：待读 / 稍后整理',
    submitLabel: '新建',
  });
  if (name === null) return;
  const child = normalizeCollectionInput(name);
  if (!child) throw new Error('请输入文件夹名称');
  const fullPath = parent ? `${parent} / ${child}` : child;
  const result = api.dbCreateBookmarkCollection(fullPath);
  state.codeCollectionFilter = result.path;
  state.codePage = 1;
  await afterDbWrite(`文件夹已新建：${result.path}`);
}

async function renameCollectionByPrompt(path) {
  const source = normalizeCollectionInput(path);
  if (!source) throw new Error('请选择一个文件夹');
  const name = await showTextInputDialog({
    title: '重命名 Collection',
    label: `当前位置：${source}`,
    value: collectionPathParts(source).at(-1) || '',
    submitLabel: '保存',
  });
  if (name === null) return;
  const nextName = normalizeCollectionInput(name);
  if (!nextName) throw new Error('请输入文件夹名称');
  const parent = collectionParentPath(source);
  const target = parent ? `${parent} / ${nextName}` : nextName;
  const result = api.dbRenameBookmarkCollection(source, target);
  updateCollectionPathState(source, result.path);
  await afterDbWrite(`已重命名 ${result.renamedCollections} 个文件夹，移动 ${result.movedBookmarks} 条收藏`);
}

async function deleteCollectionByPrompt(path) {
  const source = normalizeCollectionInput(path);
  if (!source) throw new Error('请选择一个文件夹');
  const info = api.dbGetBookmarkCollectionInfo(source);
  const message = `确认删除文件夹「${source}」及其 ${info.childCount} 个子文件夹？\n其中 ${info.bookmarkCount} 条收藏会被删除；番号历史索引会继续保留。`;
  if (!confirm(message)) return;
  createBulkEditBackup('delete_collection');
  api.dbDeleteBookmarkCollection(source);
  if (state.codeCollectionFilter === source || state.codeCollectionFilter.startsWith(`${source} / `)) state.codeCollectionFilter = 'all';
  state.codeSelected.clear();
  state.selectedCodeId = null;
  await afterDbWrite(`已删除文件夹及 ${info.bookmarkCount} 条收藏`);
}

async function editCodeByPrompt(id) {
  const row = (state.libraryCodes || []).find(item => Number(item.id) === Number(id));
  if (!row) { toast('没有找到该番号记录', 'error'); return; }
  const code = prompt('番号：', row.code || '');
  if (!code) return;
  const url = prompt('链接：', row.best_url || '');
  if (url === null) return;
  const status = prompt('状态：', row.status || 'ok');
  if (status === null) return;
  const actresses = prompt('女优 tag，多个用逗号、换行或 | 分隔：', (row.actress_tags || []).join(', '));
  if (actresses === null) return;
  const genres = prompt('类型 tag，多个用逗号、换行或 | 分隔：', (row.genre_tags || []).join(', '));
  if (genres === null) return;

  api.dbUpdateCodeRecord(id, { code, best_url: url, status });
  api.dbSetCodeActressTags(id, actresses);
  api.dbSetCodeGenreTags(id, genres);
  await afterDbWrite('番号已更新');
}

async function generateUrlForCode(id, code) {
  const urls = api.candidateUrls(code) || [];
  const url = urls[0] || `https://missav.ai/cn/${String(code || '').toLowerCase()}`;
  api.dbUpdateCodeRecord(id, { best_url: url });
  await afterDbWrite('链接已生成');
}

async function fixHealthNoUrl() {
  const rows = state.healthReport?.issues?.noUrl || [];
  if (!rows.length) { toast('没有无链接番号需要修复', 'info'); return; }
  if (!confirm(`为当前体检样本中的 ${rows.length} 条无链接番号生成/覆盖链接？`)) return;
  for (const row of rows) {
    const urls = api.candidateUrls(row.code) || [];
    const url = urls[0] || `https://missav.ai/cn/${String(row.code || '').toLowerCase()}`;
    api.dbUpdateCodeRecord(row.id, { best_url: url });
  }
  await afterDbWrite('已为无链接番号生成链接');
}

async function cleanHealthOrphans() {
  const s = state.healthReport?.summary || {};
  const total = Number(s.orphanActresses || 0) + Number(s.orphanGenres || 0);
  if (!total) { toast('没有孤立 tag 需要清理', 'info'); return; }
  if (!confirm(`确认清理 ${total} 个孤立 tag？这只会删除没有任何番号关联的 tag。`)) return;
  const result = api.dbCleanupOrphanTags('all');
  await afterDbWrite(`已清理孤立 tag：女优 ${result.actressDeleted}，类型 ${result.genreDeleted}`);
}

async function cleanHealthRelations() {
  const s = state.healthReport?.summary || {};
  const total = Number(s.brokenActressLinks || 0) + Number(s.brokenGenreLinks || 0);
  if (!total) { toast('没有坏关联需要清理', 'info'); return; }
  if (!confirm(`确认清理 ${total} 条坏关联？这只会删除指向不存在记录的关联行。`)) return;
  const result = api.dbCleanupBrokenRelations();
  await afterDbWrite(`已清理坏关联：女优 ${result.actressDeleted}，类型 ${result.genreDeleted}`);
}
async function createManualBackup() {
  const label = prompt('输入备份标签：', 'manual');
  if (label === null) return;
  const backup = api.dbCreateBackup(label.trim() || 'manual', 'manual');
  toast('备份已创建：' + backup.fileName, 'success');
  await refreshLibrary();
}

async function copyText(text) {
  const value = String(text || '');
  if (!value) return;
  if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(value);
  else {
    const ta = document.createElement('textarea');
    ta.value = value;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}
async function saveCodeDetail(id) {
  const panel = DOM.libraryContent.querySelector(`[data-code-detail-id="${id}"]`);
  if (!panel) throw new Error('没有找到详情面板');
  const get = name => panel.querySelector(`[data-code-detail-field="${name}"]`)?.value || '';
  const favorite = panel.querySelector('[data-code-detail-field="favorite"]')?.checked === true;
  const result = api.dbUpdateBookmarkRecord(id, {
    code: get('code'),
    best_url: get('best_url'),
    raindrop_title: get('raindrop_title'),
    raindrop_excerpt: get('raindrop_excerpt'),
    raindrop_note: get('raindrop_note'),
    raindrop_folder: get('raindrop_folder'),
    raindrop_tags: get('raindrop_tags'),
    raindrop_created: get('raindrop_created'),
    raindrop_cover: get('raindrop_cover'),
    highlights: get('highlights'),
    favorite,
    raindrop_id: get('raindrop_id'),
    last_modified: get('last_modified'),
  });
  const sourceCodeId = result?.sourceCodeId;
  if (sourceCodeId) {
    api.dbUpdateCodeRecord(sourceCodeId, {
      code: get('code'), best_url: get('best_url'), status: get('status') || 'historical',
      raindrop_title: get('raindrop_title'), raindrop_excerpt: get('raindrop_excerpt'),
      raindrop_note: get('raindrop_note'), raindrop_folder: get('raindrop_folder'),
      raindrop_tags: get('raindrop_tags'), raindrop_created: get('raindrop_created'),
      raindrop_cover: get('raindrop_cover'),
    });
    api.dbSetCodeActressTags(sourceCodeId, get('actress_tags'));
    api.dbSetCodeGenreTags(sourceCodeId, get('genre_tags'));
  }
  state.selectedCodeId = id;
  await afterDbWrite('详情已保存');
}

async function saveCodeDetailAndNext(id) {
  const orderedIds = (state.libraryCodes || []).map(row => Number(row.id));
  const index = orderedIds.indexOf(Number(id));
  const nextId = index >= 0 ? orderedIds[index + 1] : null;
  await saveCodeDetail(id);
  if (!nextId) {
    toast('已保存，当前已是最后一条', 'success');
    return;
  }
  state.selectedCodeId = nextId;
  const nextIndex = (state.libraryCodes || []).findIndex(row => Number(row.id) === Number(nextId));
  if (nextIndex >= 0) state.codePage = Math.floor(nextIndex / state.codePageSize) + 1;
  await refreshLibrary();
}

async function fillDetailUrl(id) {
  const row = (state.libraryCodeAllRows || []).find(item => Number(item.id) === Number(id));
  if (!row || !row.code) throw new Error('该收藏没有可生成链接的番号');
  const urls = api.candidateUrls(row.code) || [];
  const url = urls[0] || `https://missav.ai/cn/${String(row.code || '').toLowerCase()}`;
  const panel = DOM.libraryContent.querySelector(`[data-code-detail-id="${id}"]`);
  const input = panel?.querySelector('[data-code-detail-field="best_url"]');
  if (input) input.value = url;
  api.dbUpdateBookmarkRecord(id, { best_url: url });
  state.selectedCodeId = id;
  await afterDbWrite('链接已生成');
}

async function copySelectedCodeList() {
  const rows = selectedCodeRows();
  if (!rows.length) throw new Error('请先勾选要复制的收藏');
  const text = rows.map(row => row.code || row.best_url).filter(Boolean).join('\n');
  if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
  else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('已复制 ' + rows.length + ' 条记录', 'success');
}

function createBulkEditBackup(label) {
  return api.dbCreateBackup(label || 'bulk_edit', 'bulk_edit');
}

function selectedCodeRowsForBulk() {
  const ids = ensureSelectedCodes();
  const rows = selectedCodeRows();
  if (!rows.length || rows.length !== ids.length) throw new Error('选中记录已变化，请重新选择');
  return rows;
}

function autoRaindropTagsForRow(row) {
  const tags = [];
  if ((row.actress_tags || []).length) tags.push(...row.actress_tags);
  else if (['not_found', 'no_actress_found', 'need_manual_check'].includes(row.status)) tags.push('#未知女优');
  if (row.status !== 'not_found') tags.push(...(row.genre_tags || []));
  if (row.status === 'not_found') tags.push('需要查找');
  return mergeTagLists([], tags);
}

function raindropExplicitOrAutoTags(row) {
  const explicit = splitTagInput(row.raindrop_tags);
  return explicit.length ? explicit : autoRaindropTagsForRow(row);
}

function bulkValue(selector) {
  return DOM.libraryContent.querySelector(selector)?.value || '';
}

async function bulkApplyRaindropCollection() {
  const rows = selectedCodeRowsForBulk();
  const value = bulkValue('[data-bulk-rd-collection]').trim();
  if (!value) throw new Error('请输入 Collection');
  if (!confirm(`把 ${rows.length} 条选中记录的 Collection 设置为「${value}」？`)) return;
  createBulkEditBackup('bulk_collection');
  for (const row of rows) api.dbUpdateBookmarkRecord(row.id, { raindrop_folder: value });
  await afterDbWrite(`已批量设置 Collection：${rows.length} 条`);
}

async function bulkApplyRaindropTags() {
  const rows = selectedCodeRowsForBulk();
  const tags = splitTagInput(bulkValue('[data-bulk-rd-tags]'));
  const mode = bulkValue('[data-bulk-rd-tags-mode]') || 'append';
  if (!tags.length) throw new Error('请输入要处理的 Tags');
  const label = mode === 'replace' ? '替换' : mode === 'remove' ? '删除' : '追加';
  if (!confirm(`${label} ${rows.length} 条选中记录的 Raindrop Tags？`)) return;
  createBulkEditBackup('bulk_tags');
  for (const row of rows) {
    const current = mode === 'replace' ? [] : raindropExplicitOrAutoTags(row);
    const next = mode === 'remove' ? removeTagList(current, tags) : mergeTagLists(current, tags);
    api.dbUpdateBookmarkRecord(row.id, { raindrop_tags: next.join('\n') });
  }
  await afterDbWrite(`已批量${label} Tags：${rows.length} 条`);
}

async function bulkWriteAutoRaindropTags() {
  const rows = selectedCodeRowsForBulk();
  if (!confirm(`用自动识别的女优/类型 Tag 覆盖 ${rows.length} 条选中记录的 Raindrop Tags？`)) return;
  createBulkEditBackup('bulk_auto_tags');
  for (const row of rows) api.dbUpdateBookmarkRecord(row.id, { raindrop_tags: autoRaindropTagsForRow(row).join('\n') });
  await afterDbWrite(`已写入自动 Tags：${rows.length} 条`);
}

function setBulkCreatedNow() {
  const input = DOM.libraryContent.querySelector('[data-bulk-rd-created]');
  if (input) input.value = dateToLocalInput(new Date());
}

async function bulkApplyRaindropCreated() {
  const rows = selectedCodeRowsForBulk();
  const value = bulkValue('[data-bulk-rd-created]').trim();
  if (!value) throw new Error('请选择 Created 时间');
  if (!confirm(`把 ${rows.length} 条选中记录的 Created 设置为 ${value}？`)) return;
  createBulkEditBackup('bulk_created');
  for (const row of rows) api.dbUpdateBookmarkRecord(row.id, { raindrop_created: value });
  await afterDbWrite(`已批量设置 Created：${rows.length} 条`);
}

async function bulkApplyRaindropTitle() {
  const rows = selectedCodeRowsForBulk();
  const mode = bulkValue('[data-bulk-rd-title-mode]') || 'fill_empty_code';
  if (!confirm(`按当前规则更新 ${rows.length} 条选中记录的 Title？`)) return;
  createBulkEditBackup('bulk_title');
  let changed = 0;
  for (const row of rows) {
    if (mode === 'fill_empty_code' && String(row.raindrop_title || '').trim()) continue;
    const firstActress = (row.actress_tags || []).find(Boolean) || '';
    const fallback = row.code || row.best_url || row.raindrop_title;
    const title = mode === 'code_actress' && row.code && firstActress ? `${row.code} ${firstActress}` : fallback;
    if (!title) continue;
    api.dbUpdateBookmarkRecord(row.id, { raindrop_title: title });
    changed++;
  }
  await afterDbWrite(`已批量更新 Title：${changed} 条`);
}

async function bulkClearRaindropField() {
  const rows = selectedCodeRowsForBulk();
  const field = bulkValue('[data-bulk-rd-clear-field]');
  const allowed = new Set(['raindrop_note', 'raindrop_excerpt', 'raindrop_cover', 'raindrop_created', 'raindrop_tags', 'raindrop_folder', 'raindrop_title']);
  if (!allowed.has(field)) throw new Error('请选择要清空的字段');
  const label = field.replace('raindrop_', '');
  if (!confirm(`清空 ${rows.length} 条选中记录的 ${label}？`)) return;
  createBulkEditBackup('bulk_clear_' + label);
  for (const row of rows) api.dbUpdateBookmarkRecord(row.id, { [field]: '' });
  await afterDbWrite(`已清空 ${label}：${rows.length} 条`);
}

async function bulkUpdateCodeStatus() {
  const ids = ensureSelectedCodes();
  const status = DOM.libraryContent.querySelector('[data-code-bulk-status-value]')?.value || 'ok';
  createBulkEditBackup('bulk_status');
  for (const id of ids) api.dbUpdateCodeRecord(id, { status });
  await afterDbWrite('已批量更新状态');
}

async function bulkChangeCodeTags(kind, mode) {
  const ids = ensureSelectedCodes();
  const isActress = kind === 'actress';
  const label = isActress ? '女优 tag' : '类型 tag';
  const text = prompt(`${mode === 'add' ? '追加' : '移除'}${label}，多个用逗号、换行或 | 分隔：`, '');
  if (!text) return;
  const tags = splitTagInput(text);
  if (!tags.length) return;
  const rows = selectedCodeRows();
  createBulkEditBackup(isActress ? 'bulk_actress_tags' : 'bulk_genre_tags');
  for (const row of rows) {
    const current = isActress ? row.actress_tags : row.genre_tags;
    const next = mode === 'add' ? mergeTagLists(current, tags) : removeTagList(current, tags);
    if (isActress) api.dbSetCodeActressTags(row.id, next.join('\n'));
    else api.dbSetCodeGenreTags(row.id, next.join('\n'));
  }
  await afterDbWrite(`已批量${mode === 'add' ? '追加' : '移除'}${label}`);
}

async function bulkGenerateCodeUrls() {
  const ids = ensureSelectedCodes();
  const rows = selectedCodeRows();
  if (!confirm(`为选中的 ${ids.length} 条番号生成/覆盖链接？`)) return;
  createBulkEditBackup('bulk_generate_url');
  for (const row of rows) {
    const urls = api.candidateUrls(row.code) || [];
    const url = urls[0] || `https://missav.ai/cn/${String(row.code || '').toLowerCase()}`;
    api.dbUpdateCodeRecord(row.id, { best_url: url });
  }
  await afterDbWrite('已批量生成链接');
}

async function bulkNormalizeCodes() {
  const ids = ensureSelectedCodes();
  createBulkEditBackup('bulk_normalize_codes');
  let changed = 0;
  for (const row of selectedCodeRows()) {
    const normalized = api.normalizeCode(row.code);
    if (normalized && normalized !== row.code) {
      api.dbUpdateCodeRecord(row.id, { code: normalized });
      changed++;
    }
  }
  await afterDbWrite('已规范 ' + changed + ' 个番号');
}

async function bulkDeleteCodes() {
  const ids = ensureSelectedCodes();
  if (!confirm(`确认从本地收藏库删除选中的 ${ids.length} 条记录？番号去重索引会继续保留。`)) return;
  createBulkEditBackup('bulk_delete_codes');
  for (const id of ids) api.dbDeleteBookmarkRecord(id);
  state.codeSelected.clear();
  state.selectedCodeId = null;
  await afterDbWrite('已批量删除收藏');
}
async function addRawRowByPrompt() {
  const data = state.rawDbData || api.dbGetRawTableRows(state.rawDbTable, { limit: 1 });
  const row = {};
  for (const col of data.insertable || []) {
    const value = prompt(`新增 ${data.table}.${col}：`, defaultRawValue(data.table, col));
    if (value === null) return;
    row[col] = value;
  }
  api.dbInsertRawRow(data.table, row);
  await afterDbWrite('原始表记录已新增');
}

function defaultRawValue(table, col) {
  if (table === 'codes' && col === 'status') return 'ok';
  if (/_codes$/.test(col)) return '0';
  return '';
}

async function afterDbWrite(message) {
  refreshDbSummary();
  toast(message, 'success');
  await refreshLibrary();
}

async function exportLibraryRaindrop(type) {
  try {
    let dir = state.outputDirPath;
    if (!dir) {
      dir = await api.openDirectory({ title: '选择导出目录' });
      if (!dir) return;
      state.outputDirPath = dir;
      DOM.outputDirPath.textContent = shortenPath(dir);
      if (DOM.outputDirPathMirror) DOM.outputDirPathMirror.textContent = shortenPath(dir);
      updateUI();
    }
    const rows = api.dbExportRaindropRecords();
    if (!rows.length) {
      toast('本地收藏库为空', 'info');
      return;
    }
    const prefix = api.timePrefixToMinute();
    const isHtml = type === 'html';
    const filePath = `${dir}\\${prefix}_raindrop_official_backup.${isHtml ? 'html' : 'csv'}`;
    const content = isHtml ? api.generateOfficialRaindropHTML(rows) : '\ufeff' + api.generateOfficialRaindropCSV(rows);
    await api.writeFile(filePath, content, 'utf-8');
    toast(`已导出：${filePath}`, 'success');
  } catch (err) {
    toast(`Raindrop 导出失败: ${err.message}`, 'error');
  }
}

async function exportDbCSVFromLibrary() {
  await exportLibraryRaindrop('csv');
}

// ─── CSV 工作台 ──────────────────────────────────────
function loadCsvRecent() {
  try { state.csv.recent = JSON.parse(localStorage.getItem(CSV_RECENT_KEY) || '[]'); } catch { state.csv.recent = []; }
}

function saveCsvRecent() {
  try { localStorage.setItem(CSV_RECENT_KEY, JSON.stringify(state.csv.recent.slice(0, 12))); } catch {}
}

function addCsvRecent(filePath) {
  if (!filePath) return;
  state.csv.recent = [filePath, ...state.csv.recent.filter(p => p !== filePath)].slice(0, 12);
  saveCsvRecent();
  renderCsvRecentList();
}

async function confirmCsvDiscard() {
  if (!state.csv.dirty) return true;
  return confirm('当前 CSV 有未保存修改，继续会丢失这些修改。');
}

async function openCsvFile(filePath) {
  if (!(await confirmCsvDiscard())) return;
  const selected = filePath || await api.openFile({
    title: '打开 CSV 文件',
    filters: [
      { name: 'CSV 文件', extensions: ['csv'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (!selected) return;

  try {
    const text = await api.readFile(selected, 'utf-8');
    const parsed = api.csvParse(text);
    state.csv.filePath = selected;
    state.csv.headers = parsed.headers;
    state.csv.rows = parsed.rows;
    state.csv.selectedRows = new Set();
    state.csv.focusedRow = parsed.rows.length ? 0 : null;
    const headerSet = new Set(parsed.headers.map(header => String(header || '').trim().toLowerCase()));
    state.csv.isRaindrop = ['id', 'title', 'note', 'excerpt', 'url', 'folder', 'tags', 'created', 'cover', 'highlights', 'favorite'].every(header => headerSet.has(header));
    state.csv.dirty = false;
    analyzeCsv();
    addCsvRecent(selected);
    renderCsvWorkbench();
    toast('CSV 已打开：' + fileName(selected), 'success');
  } catch (err) {
    toast('打开 CSV 失败: ' + err.message, 'error');
  }
}

function analyzeCsv() {
  state.csv.analysis = api.csvAnalyze(state.csv.headers, state.csv.rows);
}

function renderCsvWorkbench() {
  renderCsvMeta();
  renderCsvTable();
  renderCsvRecentList();
}

function renderCsvMeta() {
  if (!DOM.csvFileInfo) return;
  const loaded = state.csv.headers.length > 0;
  const analysis = state.csv.analysis || api.csvAnalyze(state.csv.headers, state.csv.rows);
  state.csv.analysis = analysis;

  DOM.csvFileInfo.textContent = loaded ? `${fileName(state.csv.filePath)} · ${state.csv.rows.length} 行 / ${state.csv.headers.length} 列` : '未打开 CSV 文件';
  DOM.csvFilePath.textContent = state.csv.filePath || '未选择文件';
  DOM.csvDirtyBadge.textContent = !loaded ? '未载入' : (state.csv.dirty ? '未保存' : '已保存');
  DOM.csvDirtyBadge.classList.toggle('csv-dirty', loaded && state.csv.dirty);
  DOM.csvMetricRows.textContent = state.csv.rows.length;
  DOM.csvMetricCols.textContent = state.csv.headers.length;
  DOM.csvMetricIssues.textContent = analysis.issueCount || 0;
  DOM.csvMetricSelected.textContent = state.csv.selectedRows.size;

  const hasData = loaded;
  [DOM.btnCsvSave, DOM.btnCsvSaveAs, DOM.btnCsvBackup, DOM.btnCsvAddRow, DOM.btnCsvAddColumn, DOM.btnCsvDeleteRows, DOM.btnCsvNormalizeCodes, DOM.btnCsvReplace, DOM.btnCsvImportDb, DOM.btnCsvValidate]
    .forEach(btn => { if (btn) btn.disabled = !hasData; });
  if (DOM.btnCsvSave) DOM.btnCsvSave.disabled = !hasData || !state.csv.dirty || !state.csv.filePath;
  if (DOM.btnCsvDeleteRows) DOM.btnCsvDeleteRows.disabled = !hasData || state.csv.selectedRows.size === 0;

  renderCsvDetailEditor();
  renderCsvIssues();
}

function renderCsvTable() {
  if (!DOM.csvTableHead || !DOM.csvTableBody) return;
  renderCsvMeta();
  if (!state.csv.headers.length) {
    DOM.csvTableHead.innerHTML = '';
    DOM.csvTableBody.innerHTML = '<tr class="empty-row"><td><div class="empty-state visual-empty-state"><span class="empty-icon">CSV</span><p>打开 CSV 后在这里浏览和编辑</p></div></td></tr>';
    DOM.csvFooter.textContent = '未载入数据';
    return;
  }

  const visibleRows = getFilteredCsvRowIndexes();
  const visibleColumns = getCsvVisibleColumnIndexes();
  const issueRows = new Set((state.csv.analysis?.issues || []).map(i => i.row));
  const renderLimit = 1000;
  const rowsToRender = visibleRows.slice(0, renderLimit);
  const allVisibleSelected = rowsToRender.length > 0 && rowsToRender.every(i => state.csv.selectedRows.has(i));

  DOM.csvTableHead.innerHTML = `<tr>
    <th class="csv-check"><input type="checkbox" data-csv-select-visible="1" ${allVisibleSelected ? 'checked' : ''}></th>
    <th class="csv-rownum">#</th>
    ${visibleColumns.map(col => `<th><input class="csv-header-input" data-csv-header-col="${col}" value="${esc(state.csv.headers[col])}" title="列名"></th>`).join('')}
  </tr>`;

  DOM.csvTableBody.innerHTML = rowsToRender.map(rowIndex => {
    const row = state.csv.rows[rowIndex];
    const selected = state.csv.selectedRows.has(rowIndex);
    const classes = [issueRows.has(rowIndex) ? 'csv-row-issue' : '', Number(state.csv.focusedRow) === rowIndex ? 'csv-row-focused' : ''].filter(Boolean).join(' ');
    const cls = classes ? ` class="${classes}"` : '';
    return `<tr${cls} data-csv-row-line="${rowIndex}">
      <td class="csv-check"><input type="checkbox" data-csv-select-row="${rowIndex}" ${selected ? 'checked' : ''}></td>
      <td class="csv-rownum">${rowIndex + 1}</td>
      ${visibleColumns.map(col => `<td><input class="csv-cell-input" data-csv-row="${rowIndex}" data-csv-col="${col}" value="${esc(row[col] ?? '')}"></td>`).join('')}
    </tr>`;
  }).join('');

  const more = visibleRows.length > rowsToRender.length ? `，仅显示前 ${renderLimit} 行` : '';
  DOM.csvFooter.textContent = `显示 ${rowsToRender.length} / ${visibleRows.length} 行，总计 ${state.csv.rows.length} 行${more}`;
}

function getCsvVisibleColumnIndexes() {
  if (!state.csv.isRaindrop) return state.csv.headers.map((_, index) => index);
  const preferred = new Set(['title', 'url', 'folder', 'tags', 'created', 'favorite']);
  return state.csv.headers.map((header, index) => ({ header: String(header || '').trim().toLowerCase(), index })).filter(item => preferred.has(item.header)).map(item => item.index);
}

function renderCsvDetailEditor() {
  if (!DOM.csvDetailEditor) return;
  const rowIndex = Number(state.csv.focusedRow);
  const row = Number.isInteger(rowIndex) ? state.csv.rows[rowIndex] : null;
  if (!state.csv.isRaindrop || !row) {
    DOM.csvDetailEditor.innerHTML = `<div class="library-empty">${state.csv.isRaindrop ? '选择一行后编辑完整 Raindrop 字段' : 'Raindrop 官方 CSV 会在这里显示完整记录详情'}</div>`;
    return;
  }
  const fields = ['id', 'title', 'url', 'folder', 'tags', 'note', 'excerpt', 'created', 'cover', 'highlights', 'favorite'];
  const indexByName = new Map(state.csv.headers.map((header, index) => [String(header || '').trim().toLowerCase(), index]));
  DOM.csvDetailEditor.innerHTML = `<div class="csv-detail-head"><strong>第 ${rowIndex + 1} 行</strong><span>完整官方字段</span></div><div class="csv-detail-fields">${fields.map(field => {
    const col = indexByName.get(field);
    if (col === undefined) return '';
    const value = row[col] ?? '';
    if (['note', 'excerpt', 'highlights'].includes(field)) return `<label><span>${field}</span><textarea data-csv-detail-col="${col}">${esc(value)}</textarea></label>`;
    if (field === 'favorite') return `<label><span>favorite</span><select data-csv-detail-col="${col}"><option value="false" ${String(value).toLowerCase() !== 'true' ? 'selected' : ''}>false</option><option value="true" ${String(value).toLowerCase() === 'true' ? 'selected' : ''}>true</option></select></label>`;
    return `<label><span>${field}</span><input data-csv-detail-col="${col}" value="${esc(value)}"></label>`;
  }).join('')}</div>`;
}

function handleCsvTableClick(event) {
  if (event.target.closest('input, select, textarea, button')) return;
  const row = event.target.closest('[data-csv-row-line]');
  if (!row) return;
  state.csv.focusedRow = Number(row.dataset.csvRowLine);
  renderCsvTable();
}

function handleCsvTableFocusIn(event) {
  const field = event.target.closest('[data-csv-row][data-csv-col]');
  if (!field) return;
  const rowIndex = Number(field.dataset.csvRow);
  if (!Number.isInteger(rowIndex) || !state.csv.rows[rowIndex] || Number(state.csv.focusedRow) === rowIndex) return;
  state.csv.focusedRow = rowIndex;
  DOM.csvTableBody?.querySelectorAll('[data-csv-row-line]').forEach(row => {
    row.classList.toggle('csv-row-focused', Number(row.dataset.csvRowLine) === rowIndex);
  });
  renderCsvDetailEditor();
}

function handleCsvDetailInput(event) {
  const field = event.target.closest('[data-csv-detail-col]');
  const rowIndex = Number(state.csv.focusedRow);
  const col = Number(field?.dataset.csvDetailCol);
  if (!field || !Number.isInteger(rowIndex) || !state.csv.rows[rowIndex] || !Number.isInteger(col)) return;
  state.csv.rows[rowIndex][col] = field.value;
  markCsvDirty(false);
  const tableCell = DOM.csvTableBody?.querySelector(`[data-csv-row="${rowIndex}"][data-csv-col="${col}"]`);
  if (tableCell) tableCell.value = field.value;
}

function getFilteredCsvRowIndexes() {
  const q = (DOM.csvSearch?.value || '').trim().toLowerCase();
  const filter = DOM.csvStatusFilter?.value || 'all';
  const issueRows = new Set((state.csv.analysis?.issues || []).map(i => i.row));
  const favoriteCol = state.csv.headers.findIndex(header => String(header || '').trim().toLowerCase() === 'favorite');
  const highlightsCol = state.csv.headers.findIndex(header => String(header || '').trim().toLowerCase() === 'highlights');
  const urlCol = state.csv.headers.findIndex(header => String(header || '').trim().toLowerCase() === 'url');
  const result = [];

  for (let i = 0; i < state.csv.rows.length; i++) {
    const text = state.csv.rows[i].map(v => String(v || '')).join(' | ');
    const lower = text.toLowerCase();
    if (q && !lower.includes(q)) continue;
    if (filter === 'favorite' && (favoriteCol < 0 || !['true', '1'].includes(String(state.csv.rows[i][favoriteCol] || '').trim().toLowerCase()))) continue;
    if (filter === 'highlights' && (highlightsCol < 0 || !String(state.csv.rows[i][highlightsCol] || '').trim())) continue;
    if (filter === 'missing_url' && (urlCol < 0 || String(state.csv.rows[i][urlCol] || '').trim())) continue;
    if (filter === 'issue' && !issueRows.has(i)) continue;
    result.push(i);
  }
  return result;
}

function handleCsvTableInput(event) {
  const header = event.target.closest('[data-csv-header-col]');
  if (header) {
    const col = Number(header.dataset.csvHeaderCol);
    state.csv.headers[col] = header.value || `Column${col + 1}`;
    markCsvDirty();
    return;
  }

  const cell = event.target.closest('[data-csv-row][data-csv-col]');
  if (!cell) return;
  const row = Number(cell.dataset.csvRow);
  const col = Number(cell.dataset.csvCol);
  if (!state.csv.rows[row]) return;
  state.csv.rows[row][col] = cell.value;
  markCsvDirty(false);
  if (Number(state.csv.focusedRow) === row) {
    const detailField = DOM.csvDetailEditor?.querySelector(`[data-csv-detail-col="${col}"]`);
    if (detailField) detailField.value = cell.value;
  }
}

function handleCsvTableChange(event) {
  const selectVisible = event.target.closest('[data-csv-select-visible]');
  if (selectVisible) {
    const rows = getFilteredCsvRowIndexes().slice(0, 1000);
    for (const rowIndex of rows) {
      if (selectVisible.checked) state.csv.selectedRows.add(rowIndex);
      else state.csv.selectedRows.delete(rowIndex);
    }
    renderCsvTable();
    return;
  }

  const selectRow = event.target.closest('[data-csv-select-row]');
  if (selectRow) {
    const rowIndex = Number(selectRow.dataset.csvSelectRow);
    state.csv.focusedRow = rowIndex;
    if (selectRow.checked) state.csv.selectedRows.add(rowIndex);
    else state.csv.selectedRows.delete(rowIndex);
    renderCsvMeta();
    return;
  }

  if (event.target.closest('[data-csv-row][data-csv-col]') || event.target.closest('[data-csv-header-col]')) {
    analyzeCsv();
    renderCsvMeta();
  }
}

function markCsvDirty(renderMeta = true) {
  if (!state.csv.headers.length) return;
  state.csv.dirty = true;
  if (renderMeta) {
    renderCsvMeta();
    return;
  }
  if (DOM.csvDirtyBadge) {
    DOM.csvDirtyBadge.textContent = '未保存';
    DOM.csvDirtyBadge.classList.add('csv-dirty');
  }
  if (DOM.btnCsvSave) DOM.btnCsvSave.disabled = !state.csv.filePath;
}

async function saveCsvFile() {
  if (!state.csv.filePath) { await saveCsvAs(); return; }
  try {
    analyzeCsv();
    const content = '\ufeff' + api.csvStringify(state.csv.headers, state.csv.rows);
    await api.writeFile(state.csv.filePath, content, 'utf-8');
    state.csv.dirty = false;
    addCsvRecent(state.csv.filePath);
    renderCsvWorkbench();
    toast('CSV 已保存', 'success');
  } catch (err) {
    toast('保存失败: ' + err.message, 'error');
  }
}

async function saveCsvAs() {
  if (!state.csv.headers.length) return;
  const dir = await api.openDirectory({ title: '选择另存目录' });
  if (!dir) return;
  const defaultName = fileName(state.csv.filePath) || 'data.csv';
  let name = prompt('输入文件名：', defaultName);
  if (!name) return;
  if (!/\.csv$/i.test(name)) name += '.csv';
  state.csv.filePath = dir + '\\' + name;
  await saveCsvFile();
}

async function backupCsvFile() {
  if (!state.csv.headers.length) return;
  try {
    const dir = dirName(state.csv.filePath) || state.outputDirPath || await api.openDirectory({ title: '选择备份目录' });
    if (!dir) return;
    const base = baseNameNoExt(state.csv.filePath) || 'csv_backup';
    const filePath = dir + '\\' + base + '_backup_' + api.timePrefixToMinute() + '.csv';
    await api.writeFile(filePath, '\ufeff' + api.csvStringify(state.csv.headers, state.csv.rows), 'utf-8');
    toast('备份已保存：' + fileName(filePath), 'success');
  } catch (err) {
    toast('备份失败: ' + err.message, 'error');
  }
}

function addCsvRow() {
  if (!state.csv.headers.length) return;
  state.csv.rows.push(state.csv.headers.map(() => ''));
  state.csv.selectedRows = new Set([state.csv.rows.length - 1]);
  analyzeCsv();
  markCsvDirty();
  renderCsvTable();
}

function addCsvColumn() {
  if (!state.csv.headers.length) return;
  const name = prompt('新列名：', '新列');
  if (!name) return;
  state.csv.headers.push(name.trim() || `Column${state.csv.headers.length + 1}`);
  state.csv.rows.forEach(row => row.push(''));
  analyzeCsv();
  markCsvDirty();
  renderCsvTable();
}

function deleteSelectedCsvRows() {
  const selected = [...state.csv.selectedRows].sort((a, b) => b - a);
  if (!selected.length) return;
  if (!confirm('确认删除选中的 ' + selected.length + ' 行？')) return;
  for (const rowIndex of selected) state.csv.rows.splice(rowIndex, 1);
  state.csv.selectedRows.clear();
  analyzeCsv();
  markCsvDirty();
  renderCsvTable();
}

function normalizeCsvCodes() {
  if (!state.csv.headers.length) return;
  analyzeCsv();
  const col = state.csv.analysis.codeColumn;
  if (col < 0) { toast('没有识别到番号列，可把列名改成“番号”或“code”', 'error'); return; }
  let changed = 0;
  for (const row of state.csv.rows) {
    const raw = String(row[col] || '').trim();
    if (!raw) continue;
    const normalized = api.normalizeCode(raw);
    if (normalized && normalized !== raw) { row[col] = normalized; changed++; }
  }
  analyzeCsv();
  markCsvDirty();
  renderCsvTable();
  toast('已规范 ' + changed + ' 个番号', 'success');
}

function batchReplaceCsv() {
  if (!state.csv.headers.length) return;
  const needle = prompt('查找内容：', '');
  if (!needle) return;
  const replacement = prompt('替换为：', '');
  if (replacement === null) return;
  const rows = getFilteredCsvRowIndexes();
  let changed = 0;
  for (const rowIndex of rows) {
    const row = state.csv.rows[rowIndex];
    for (let col = 0; col < row.length; col++) {
      const value = String(row[col] || '');
      if (value.includes(needle)) {
        row[col] = value.split(needle).join(replacement);
        changed++;
      }
    }
  }
  analyzeCsv();
  markCsvDirty();
  renderCsvTable();
  toast('已替换 ' + changed + ' 个单元格', 'success');
}

function renderCsvIssues() {
  if (!DOM.csvIssueList) return;
  const issues = state.csv.analysis?.issues || [];
  if (!state.csv.headers.length) {
    DOM.csvIssueList.innerHTML = '<div class="library-empty">暂无校验结果</div>';
    return;
  }
  if (!issues.length) {
    DOM.csvIssueList.innerHTML = '<div class="library-empty">没有发现明显问题</div>';
    return;
  }
  DOM.csvIssueList.innerHTML = issues.slice(0, 120).map(issue => `
    <button class="csv-issue-item csv-issue-${issue.severity}" data-csv-issue-row="${issue.row}">
      <strong>${issue.row + 1} 行</strong><span>${esc(issue.message)}</span>
    </button>`).join('') + (issues.length > 120 ? `<div class="csv-issue-more">还有 ${issues.length - 120} 个问题未显示</div>` : '');
}

function handleCsvIssueClick(event) {
  const item = event.target.closest('[data-csv-issue-row]');
  if (!item) return;
  const rowIndex = Number(item.dataset.csvIssueRow);
  state.csv.selectedRows = new Set([rowIndex]);
  if (DOM.csvStatusFilter) DOM.csvStatusFilter.value = 'issue';
  renderCsvTable();
}

function renderCsvRecentList() {
  if (!DOM.csvRecentList) return;
  if (!state.csv.recent.length) {
    DOM.csvRecentList.innerHTML = '<div class="library-empty">暂无最近文件</div>';
    return;
  }
  DOM.csvRecentList.innerHTML = state.csv.recent.map(p => `<button class="csv-recent-item" data-csv-recent-path="${esc(p)}"><strong>${esc(fileName(p))}</strong><span>${esc(shortenPath(p))}</span></button>`).join('');
}

async function handleCsvRecentClick(event) {
  const item = event.target.closest('[data-csv-recent-path]');
  if (!item) return;
  await openCsvFile(item.dataset.csvRecentPath);
}

async function importWorkbenchCsvToDb() {
  if (!state.csv.headers.length) return;
  const kind = state.csv.isRaindrop ? 'Raindrop 官方收藏' : '旧女优 Tag 合集';
  if (!confirm(`把当前 ${kind} 导入本地收藏数据库？`)) return;
  try {
    api.dbCreateBackup('csv_workbench_import', 'import');
    const text = api.csvStringify(state.csv.headers, state.csv.rows);
    const result = state.csv.isRaindrop
      ? api.dbImportRaindropRecords(api.parseRaindropCSV(text), { mode: 'merge' })
      : api.dbImportCSV(text);
    refreshDbSummary();
    switchDataMode('library');
    toast(state.csv.isRaindrop ? `已导入：新增 ${result.imported}，更新 ${result.updated}` : `已导入旧合集关系 ${result.imported || 0} 条`, 'success');
  } catch (err) {
    toast('导入失败: ' + err.message, 'error');
  }
}

function dirName(filePath) {
  const s = String(filePath || '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i >= 0 ? s.slice(0, i) : '';
}

function baseNameNoExt(filePath) {
  const name = fileName(filePath);
  return name.replace(/\.[^.]+$/, '');
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
async function importTextFile(multi = false) {
  const selected = await api.openFile({
    title: multi ? '批量导入文本、HTML 或 Markdown' : '导入文本、HTML 或 Markdown',
    filters: [
      { name: '文本 / HTML / Markdown', extensions: ['txt', 'html', 'htm', 'md', 'json', 'csv', 'log'] },
      { name: '所有文件', extensions: ['*'] },
    ],
    multiSelections: multi,
  });
  if (!selected) return;

  const filePaths = Array.isArray(selected) ? selected : [selected];
  if (!filePaths.length) return;

  try {
    const chunks = [];
    for (const filePath of filePaths) {
      const text = await api.readFile(filePath, 'utf-8');
      chunks.push(text);
    }
    const current = DOM.codeInput.value.trimEnd();
    DOM.codeInput.value = current ? current + '\n\n' + chunks.join('\n\n') : chunks.join('\n\n');
    parseInputCodes(filePaths.length > 1 ? filePaths.length + ' 个文件' : fileName(filePaths[0]));
    updateUI();
    toast(filePaths.length > 1 ? '已导入 ' + filePaths.length + ' 个文件' : '已导入：' + fileName(filePaths[0]), 'success');
  } catch (err) {
    toast('导入失败: ' + err.message, 'error');
  }
}

async function copyParsedCodes() {
  parseInputCodes('已识别');
  if (!state.inputCodes.length) { toast('没有可复制的番号', 'error'); return; }
  const text = state.inputCodes.join('\n');
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
    else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('已复制 ' + state.inputCodes.length + ' 条', 'success');
  } catch (err) {
    toast('复制失败: ' + err.message, 'error');
  }
}

async function exportCodeList() {
  parseInputCodes('已识别');
  if (!state.inputCodes.length) { toast('没有可保存的番号', 'error'); return; }
  try {
    let dir = state.outputDirPath;
    if (!dir) {
      dir = await api.openDirectory({ title: '选择保存目录' });
      if (!dir) return;
      state.outputDirPath = dir;
      DOM.outputDirPath.textContent = shortenPath(dir);
      if (DOM.outputDirPathMirror) DOM.outputDirPathMirror.textContent = shortenPath(dir);
      updateUI();
    }
    const prefix = api.timePrefixToMinute();
    const filePath = dir + '\\' + prefix + '_parsed_codes.txt';
    await api.writeFile(filePath, state.inputCodes.join('\n'));
    toast('已保存：' + fileName(filePath), 'success');
  } catch (err) {
    toast('保存失败: ' + err.message, 'error');
  }
}
function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
function fileName(filePath) {
  return String(filePath || '').split(/[\\/]/).pop() || String(filePath || '');
}
// ─── 辅助 ────────────────────────────────────────────
function clearAll() {
  DOM.codeInput.value = ''; state.inputCodes = []; state.results = [];
  state.stats = { total: 0, new: 0, exists: 0, notFound: 0, duplicate: 0 };
  DOM.codeCount.textContent = '0 条'; if (DOM.inputSourceInfo) DOM.inputSourceInfo.textContent = '文本 / HTML / TXT / MD'; DOM.exportBar.style.display = 'none'; DOM.progressContainer.style.display = 'none';
  updateStats(); renderTable(); setStatus('就绪', null, null, null); updateUI();
}
function pasteSample() {
  DOM.codeInput.value = 'ABF-354\nSONE-314\nFC2-PPV-4843473\nGDJP-006\nFPRE-216\nEYAN-214\n<div id="message14298">SNIS-786 https://missav.ai/cn/sone-314-chinese-subtitle</div>';
  parseInputCodes('示例数据');
  updateUI();
}
function toast(msg, type) { const el = document.createElement('div'); el.className = `toast toast-${type || 'info'}`; el.textContent = msg; DOM.toastContainer.appendChild(el); setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, 3000); }
function renderHistory() { const c = $('#historyList'); if (!state.history.length) { c.innerHTML = '<p class="empty-state">暂无历史记录</p>'; return; } c.innerHTML = state.history.slice().reverse().map(h => `<div class="history-item"><div class="history-time">${fmtTime(h.time)}</div><div class="history-summary">${h.summary}</div></div>`).join(''); }
function shortenPath(p) { if (!p) return '未选择...'; return p.length <= 40 ? p : '...' + p.slice(-37); }
function shortUrl(u) { try { const x = new URL(u); return x.hostname + x.pathname.slice(0, 50); } catch { return (u||'').slice(0,60); } }
function esc(s) { return String(s??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtTime(iso) { try { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; } catch { return iso; } }
function pad(n) { return String(n).padStart(2,'0'); }

// ─── 启动 ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
























