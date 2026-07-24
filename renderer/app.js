/**
 * MissAV Manager — 前端主逻辑
 * 数据存储使用 SQLite 数据库（替代旧 CSV 读写）
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const DOM = {};
const api = window.electronAPI;
const APP_VERSION = api.appVersion || '0.3.0';
const TOOL_MANIFESTS = Object.freeze(api.listTools?.() || []);
const TOOL_BY_ID = new Map(TOOL_MANIFESTS.map(tool => [tool.id, tool]));
const processingSpeed = window.ProcessingSpeed;
const processingEta = window.ProcessingEta;
const LEGACY_SPEED_MODE_KEY = 'missav_manager_speed_mode';
const SITE_SPEED_MODE_KEYS = Object.freeze({
  missav: 'missav_manager_speed_mode_missav',
  av123: 'missav_manager_speed_mode_av123',
});
const AV123_SPEED_POLICY_KEY = 'missav_manager_av123_speed_policy';
const MISSAV_SPEED_POLICY_KEY = 'missav_manager_missav_speed_policy';
const AV123_SPEED_POLICY_MIGRATION_KEY = 'missav_manager_av123_speed_policy_v2';
const AV123_RATE_MODE_KEY = 'missav_manager_av123_rate_mode';
const AV123_RATE_CAP_KEY = 'missav_manager_av123_rate_cap';
const AV123_LEARNED_RATE_KEY = 'missav_manager_av123_learned_rate';
const MISSAV_RATE_MODE_KEY = 'missav_manager_missav_rate_mode';
const MISSAV_RATE_CAP_KEY = 'missav_manager_missav_rate_cap';
const MISSAV_LEARNED_RATE_KEY = 'missav_manager_missav_learned_rate';
const AV123_FAVORITE_CONCURRENCY_KEY = 'missav_manager_av123_favorite_concurrency';
const AV123_AUTO_FAVORITE_KEY = 'missav_manager_av123_auto_favorite';
const AV123_FAVORITE_METHOD_KEY = 'missav_manager_av123_favorite_method';
const AV123_APP_RECOVERY_DELAY_MS = 10000;
// Favorite windows hide page-load latency, but every detail navigation still
// counts against the same Cloudflare/IP quota. Keep one global launch stream.
const AV123_SITE_TAB_KEY = 'missav_manager_av123_site_tab';
const SITE_WORKSPACE_KEY = 'missav_manager_site_workspace';
const RAINDROP_COLLECTION_KEY = 'missav_manager_raindrop_collection';
const TOOLBOX_BINDINGS_KEY = 'tg_content_toolbox_group_bindings';
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

function logEvent(level, event, data = {}) {
  try {
    const pending = api.logAppend?.({ level, event, data });
    if (pending?.catch) pending.catch(() => {});
  } catch {}
}

window.addEventListener('error', event => {
  logEvent('error', 'renderer_error', { message: event.message || '', file: event.filename || '', line: event.lineno || 0, column: event.colno || 0 });
});
window.addEventListener('unhandledrejection', event => {
  logEvent('error', 'renderer_unhandled_rejection', { message: event.reason?.message || String(event.reason || '') });
});

const state = {
  outputDirPath: '',
  inputCodes: [],
  results: [],
  isProcessing: false,
  stopRequested: false,
  speedModes: { missav: 'smart', av123: 'turbo' },
  missavRateMode: 'adaptive',
  missavRateCap: 16,
  missavLearnedRate: 8,
  missavSpeedPolicy: 'stable',
  av123SpeedPolicy: 'staged',
  av123RateMode: 'adaptive',
  av123RateCap: 16,
  av123LearnedRate: 5,
  av123FavoriteConcurrency: 1,
  av123FavoriteMethod: 'chrome',
  chromeFavoriteBridge: { running: false, connected: false, pairingCode: '', extensionPath: '', lastSeenAt: 0 },
  av123AutoFavorite: false,
  av123SiteTab: 'lookup',
  favoriteRuntime: null,
  speedRuntime: null,
  currentRunId: null,
  preparedRunId: null,
  preparedInputSignature: '',
  selectedRunId: null,
  resumableRun: null,
  pendingDeleteRunId: null,
  activeLookupSite: '',
  sitePerformance: { missav: null, av123: null },
  stats: { total: 0, new: 0, exists: 0, notFound: 0, duplicate: 0 },
  processingTiming: {
    status: 'idle',
    startedAt: 0,
    activeItems: new Map(),
    concurrency: 1,
    speedLabel: '',
    site: '',
    total: 0,
    completed: 0,
    durations: [],
    timer: null,
  },
  activeTab: 'all',
  resultWorkspace: 'missav',
  resultStageByWorkspace: { missav: 'missavLookup', av123: 'av123Lookup' },
  resultTabByWorkspace: { missav: 'all', av123: 'all' },
  resultStatusByWorkspace: { missav: 'all', av123: 'all' },
  resultSortByWorkspace: { missav: 'original', av123: 'original' },
  activeAccountAction: '',
  av123Account: { status: 'unknown', accountLabel: '', detail: '收藏使用本地 Chrome 已登录账号' },
  runDetailWorkspace: 'missav',
  resultSelected: new Set(),
  resultSelectionAnchor: null,
  history: [],
  dbReady: false,
  libraryTab: 'codes',
  dataMode: 'library',
  activePage: 'home',
  activeTool: '',
  activeAvTool: 'missav',
  toolboxBindings: { twitter: '', badnews: '', missav: '', av123: '' },
  toolbox: {
    twitter: { raw: '', messages: [], sourceLabel: '', results: [] },
    badnews: { raw: '', messages: [], sourceLabel: '', results: [] },
  },
  avToolSessions: {
    missav: { raw: '', sourceLabel: '手动输入', preparedRunId: null, preparedInputSignature: '', timeStart: '', timeEnd: '' },
    av123: { raw: '', sourceLabel: '手动输入', preparedRunId: null, preparedInputSignature: '', timeStart: '', timeEnd: '' },
  },
  siteWorkspace: 'missav',
  libraryActresses: [],
  libraryCodes: [],
  libraryCodeAllRows: [],
  libraryCodeTotal: 0,
  codeSelected: new Set(),
  codeSelectionAnchorId: null,
  selectedCodeId: null,
  codeStatusFilter: 'all',
  codeSort: 'recent',
  codePage: 1,
  codePageSize: 160,
  collectionMap: { collection: 'all', tag: '', riskOnly: false },
  reviewDeck: { queue: 'priority', index: 0, done: 0, skipped: 0 },
  importCompare: { text: '', rows: [], policy: 'new_only', filter: 'all', selected: new Set(), metadataByKey: new Map(), sourceLabel: '' },
  libraryGenres: [],
  rawDbTable: 'codes',
  rawDbPage: 1,
  rawDbPageSize: 200,
  rawDbTables: [],
  rawDbData: null,
  rawDbSelected: new Set(),
  rawDbSelectionAnchor: null,
  healthReport: null,
  backupRows: [],
  appearance: { theme: 'mint', visualPack: 'none', density: 'comfortable', bgImagePath: '', bgDim: 35, version: APPEARANCE_VERSION },
  csv: { filePath: '', headers: [], rows: [], selectedRows: new Set(), focusedRow: null, isRaindrop: false, dirty: false, analysis: null, recent: [] },
  raindropSync: {
    auth: { configured: false, encryptionAvailable: false, account: null },
    collections: [],
    collectionId: -1,
    routingCollections: { missav1: null, missav2: null },
    runId: null,
    plan: [],
    running: false,
    stopRequested: false,
    previewExpanded: false,
    progress: { completed: 0, total: 0, errors: 0 },
  },
  telegram: {
    panel: 'bot',
    bot: {
      auth: { status: 'disconnected', configured: false, connected: false, encryptionAvailable: false, accountKey: '', accountLabel: '', error: '' },
      running: false,
      stopRequested: false,
      groupsLoading: false,
      availableGroups: [],
      selectedGroupKeys: new Set(),
      groupSources: [],
      progress: { fetched: 0, limit: 0 },
    },
    auth: { status: 'disconnected', configured: false, connected: false, encryptionAvailable: false, accountKey: '', accountLabel: '', error: '' },
    authEpoch: 0,
    authKind: '',
    running: false,
    stopRequested: false,
    groupsLoading: false,
    availableGroups: [],
    selectedGroupKeys: new Set(),
    groupSources: [],
    progress: { fetched: 0, limit: 0 },
    preview: { codes: [], messageCount: 0, newMessageCount: 0, duplicateMessageCount: 0, updatedMessageCount: 0, errorCount: 0 },
    history: [],
  },
};

// ─── 初始化 ──────────────────────────────────────────
function init() {
  logEvent('info', 'renderer_init', { version: APP_VERSION });
  const versionBadge = $('#versionBadge');
  if (versionBadge) versionBadge.textContent = `v${APP_VERSION}`;
  DOM.codeInput = $('#codeInput');
  DOM.codeCount = $('#codeCount');
  DOM.filteredCodeOutput = $('#filteredCodeOutput');
  DOM.filteredCodeCount = $('#filteredCodeCount');
  DOM.librarySectionPath = $('#librarySectionPath');
  DOM.outputDirPath = $('#outputDirPath');
  DOM.outputDirPathMirror = $('#outputDirPathMirror');
  DOM.btnSelectOutputDirMirror = $('#btnSelectOutputDirMirror');
  DOM.btnSelectTagFile = $('#btnSelectTagFile');
  DOM.btnSelectOutputDir = $('#btnSelectOutputDir');
  DOM.btnStartMissav = $('#btnStartMissav');
  DOM.btnStopMissav = $('#btnStopMissav');
  DOM.btnStart123Av = $('#btnStart123Av');
  DOM.btnStop123Av = $('#btnStop123Av');
  DOM.btnClearInput = $('#btnClearInput');
  DOM.btnPasteSample = $('#btnPasteSample');
  DOM.btnOpenSitesFromInput = $('#btnOpenSitesFromInput');
  DOM.btnImportTextFile = $('#btnImportTextFile');
  DOM.btnCopyCodes = $('#btnCopyCodes');
  DOM.btnExportCodeList = $('#btnExportCodeList');
  DOM.inputSourceInfo = $('#inputSourceInfo');
  DOM.avInputTitle = $('#avInputTitle');
  DOM.toolWorkspaceBar = $('#toolWorkspaceBar');
  DOM.toolWorkspaceTitle = $('#toolWorkspaceTitle');
  DOM.btnBackToolHome = $('#btnBackToolHome');
  DOM.avToolStages = $('#avToolStages');
  DOM.toolHomeCategories = $('#toolHomeCategories');
  DOM.homeToolCount = $('#homeToolCount');
  DOM.homeRunningCount = $('#homeRunningCount');
  DOM.telegramSyncWarning = $('#telegramSyncWarning');
  DOM.telegramSyncWarningText = $('#telegramSyncWarningText');
  DOM.taskCenterBadge = $('#taskCenterBadge');
  DOM.taskMissavStatus = $('#taskMissavStatus');
  DOM.task123Status = $('#task123Status');
  DOM.taskFavoriteStatus = $('#taskFavoriteStatus');
  DOM.taskRaindropStatus = $('#taskRaindropStatus');
  DOM.taskTelegramStatus = $('#taskTelegramStatus');
  DOM.avGroupBindingLabel = $('#avGroupBindingLabel');
  DOM.avGroupBinding = $('#avGroupBinding');
  DOM.avTimeStart = $('#avTimeStart');
  DOM.avTimeEnd = $('#avTimeEnd');
  DOM.btnAvSyncGroup = $('#btnAvSyncGroup');
  DOM.avGroupBindingStatus = $('#avGroupBindingStatus');
  DOM.twitterGroupBinding = $('#twitterGroupBinding');
  DOM.twitterTimeStart = $('#twitterTimeStart');
  DOM.twitterTimeEnd = $('#twitterTimeEnd');
  DOM.twitterRawInput = $('#twitterRawInput');
  DOM.twitterNamesOutput = $('#twitterNamesOutput');
  DOM.twitterUrlsOutput = $('#twitterUrlsOutput');
  DOM.twitterResultCount = $('#twitterResultCount');
  DOM.twitterSourceStatus = $('#twitterSourceStatus');
  DOM.btnTwitterSyncGroup = $('#btnTwitterSyncGroup');
  DOM.btnTwitterImportFiles = $('#btnTwitterImportFiles');
  DOM.btnTwitterFilter = $('#btnTwitterFilter');
  DOM.btnTwitterClear = $('#btnTwitterClear');
  DOM.btnCopyTwitterNames = $('#btnCopyTwitterNames');
  DOM.btnCopyTwitterUrls = $('#btnCopyTwitterUrls');
  DOM.btnSaveTwitterResults = $('#btnSaveTwitterResults');
  DOM.badnewsGroupBinding = $('#badnewsGroupBinding');
  DOM.badnewsTimeStart = $('#badnewsTimeStart');
  DOM.badnewsTimeEnd = $('#badnewsTimeEnd');
  DOM.badnewsRawInput = $('#badnewsRawInput');
  DOM.badnewsUrlsOutput = $('#badnewsUrlsOutput');
  DOM.badnewsResultCount = $('#badnewsResultCount');
  DOM.badnewsSourceStatus = $('#badnewsSourceStatus');
  DOM.btnBadnewsSyncGroup = $('#btnBadnewsSyncGroup');
  DOM.btnBadnewsImportFiles = $('#btnBadnewsImportFiles');
  DOM.btnBadnewsFilter = $('#btnBadnewsFilter');
  DOM.btnBadnewsClear = $('#btnBadnewsClear');
  DOM.btnCopyBadnewsUrls = $('#btnCopyBadnewsUrls');
  DOM.btnSaveBadnewsResults = $('#btnSaveBadnewsResults');
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
  DOM.batchName = $('#batchName');
  DOM.resumeBatchPanel = $('#resumeBatchPanel');
  DOM.resumeBatchName = $('#resumeBatchName');
  DOM.resumeBatchSummary = $('#resumeBatchSummary');
  DOM.btnResumeMissavBatch = $('#btnResumeMissavBatch');
  DOM.btnResume123AvBatch = $('#btnResume123AvBatch');
  DOM.btnDeleteResumableBatch = $('#btnDeleteResumableBatch');
  DOM.runMissavStageSummary = $('#runMissavStageSummary');
  DOM.run123AvStageSummary = $('#run123AvStageSummary');
  DOM.runMissavTiming = $('#runMissavTiming');
  DOM.run123AvTiming = $('#run123AvTiming');
  DOM.siteOperationCards = $$('[data-site-operation]');
  DOM.siteWorkspaceButtons = $$('[data-site-workspace]');
  DOM.siteWorkspacePanels = $$('[data-site-workspace-panel]');
  DOM.siteMissavCatalogSummary = $('#siteMissavCatalogSummary');
  DOM.site123AvCatalogSummary = $('#site123AvCatalogSummary');
  DOM.siteBatchCatalogSummary = $('#siteBatchCatalogSummary');
  DOM.speedModeButtons = $$('[data-speed-site][data-speed-mode]');
  DOM.speedModeBadges = $$('[data-speed-badge]');
  DOM.speedModeDescriptions = $$('[data-speed-description]');
  DOM.missavSpeedPolicy = $('#missavSpeedPolicy');
  DOM.av123SpeedPolicy = $('#av123SpeedPolicy');
  DOM.missavRateMode = $('#missavRateMode');
  DOM.missavRateCap = $('#missavRateCap');
  DOM.missavRateCapValue = $('#missavRateCapValue');
  DOM.missavRateCapButtons = $$('[data-missav-rate-cap]');
  DOM.missavRateDescription = $('#missavRateDescription');
  DOM.missavRateLive = $('#missavRateLive');
  DOM.av123RateMode = $('#av123RateMode');
  DOM.av123RateCap = $('#av123RateCap');
  DOM.av123RateCapValue = $('#av123RateCapValue');
  DOM.av123RateCapButtons = $$('[data-av123-rate-cap]');
  DOM.av123RateDescription = $('#av123RateDescription');
  DOM.av123RateLive = $('#av123RateLive');
  DOM.favoriteConcurrencyButtons = $$('[data-favorite-concurrency]');
  DOM.favoriteMethodButtons = $$('[data-av123-favorite-method]');
  DOM.favoriteSpeedPanel = $('#favoriteSpeedPanel');
  DOM.favoriteSpeedDescription = $('#favoriteSpeedDescription');
  DOM.av123SiteTabButtons = $$('[data-av123-site-tab]');
  DOM.av123SiteTabPanels = $$('[data-av123-site-tab-panel]');
  DOM.av123AutoFavorite = $('#av123AutoFavorite');
  DOM.favoriteAutoTogglePanel = $('#favoriteAutoTogglePanel');
  DOM.siteAv123AccountControl = $('#siteAv123AccountControl');
  DOM.appFavoriteStabilityPanel = $('#appFavoriteStabilityPanel');
  DOM.favoriteExportPanel = $('#favoriteExportPanel');
  DOM.btnExport123AvFavoriteSite = $('#btnExport123AvFavoriteSite');
  DOM.siteAv123AccountStatus = $('#siteAv123AccountStatus');
  DOM.siteAv123AccountDetail = $('#siteAv123AccountDetail');
  DOM.btnOpen123AvAccountSite = $('#btnOpen123AvAccountSite');
  DOM.btnCheck123AvAccountSite = $('#btnCheck123AvAccountSite');
  DOM.btnPrepareChromeFavoriteSite = $('#btnPrepareChromeFavoriteSite');
  DOM.chromeFavoriteBridgePanel = $('#chromeFavoriteBridgePanel');
  DOM.chromeFavoriteBridgeStatus = $('#chromeFavoriteBridgeStatus');
  DOM.chromeFavoriteBridgeDetail = $('#chromeFavoriteBridgeDetail');
  DOM.btnCopyChromePairing = $('#btnCopyChromePairing');
  DOM.favoriteRuntimePanel = $('#favoriteRuntimePanel');
  DOM.favoriteRuntimeStatus = $('#favoriteRuntimeStatus');
  DOM.favoriteRuntimeRate = $('#favoriteRuntimeRate');
  DOM.favoriteRuntimeProgressFill = $('#favoriteRuntimeProgressFill');
  DOM.favoriteRuntimeSummary = $('#favoriteRuntimeSummary');
  DOM.favoriteRuntimeEta = $('#favoriteRuntimeEta');
  DOM.btnStop123AvFavoriteSite = $('#btnStop123AvFavoriteSite');
  DOM.progressContainer = $('#progressContainer');
  DOM.progressFill = $('#progressFill');
  DOM.progressCurrent = $('#progressCurrent');
  DOM.progressTotal = $('#progressTotal');
  DOM.progressPercent = $('#progressPercent');
  DOM.resultBody = $('#resultBody');
  DOM.resultTable = $('#resultTable');
  DOM.resultTableHead = $('#resultTableHead');
  DOM.resultWorkspaceTitle = $('#resultWorkspaceTitle');
  DOM.resultTabs = $('#resultTabs');
  DOM.resultWorkspaceButtons = $$('[data-result-workspace]');
  DOM.resultMissavWorkspaceSummary = $('#resultMissavWorkspaceSummary');
  DOM.result123AvWorkspaceSummary = $('#result123AvWorkspaceSummary');
  DOM.av123AccountPanel = $('#av123AccountPanel');
  DOM.av123AccountStatus = $('#av123AccountStatus');
  DOM.av123AccountDetail = $('#av123AccountDetail');
  DOM.btnOpen123AvAccount = $('#btnOpen123AvAccount');
  DOM.btnCheck123AvAccount = $('#btnCheck123AvAccount');
  DOM.btnPrepareChromeFavorite = $('#btnPrepareChromeFavorite');
  DOM.resultBatchSummary = $('#resultBatchSummary');
  DOM.resultSearch = $('#resultSearch');
  DOM.resultStatusFilter = $('#resultStatusFilter');
  DOM.resultStageFilter = $('#resultStageFilter');
  DOM.resultTagFilter = $('#resultTagFilter');
  DOM.resultSort = $('#resultSort');
  DOM.resultRangeSummary = $('#resultRangeSummary');
  DOM.resultSelectVisible = $('#resultSelectVisible');
  DOM.btnSelectVisibleResults = $('#btnSelectVisibleResults');
  DOM.btnClearResultSelection = $('#btnClearResultSelection');
  DOM.btnCopyResultTSV = $('#btnCopyResultTSV');
  DOM.btnRetrySelectedResults = $('#btnRetrySelectedResults');
  DOM.btnRetryAllNetworkResults = $('#btnRetryAllNetworkResults');
  DOM.btnStopResults = $('#btnStopResults');
  DOM.btnDeleteCurrentRun = $('#btnDeleteCurrentRun');
  DOM.btnFavoriteSelected123Av = $('#btnFavoriteSelected123Av');
  DOM.btnFavoriteAll123Av = $('#btnFavoriteAll123Av');
  DOM.btnVerifySelected123Av = $('#btnVerifySelected123Av');
  DOM.btnVerifyAll123Av = $('#btnVerifyAll123Av');
  DOM.btnStop123AvFavorite = $('#btnStop123AvFavorite');
  DOM.exportBar = $('#exportBar');
  DOM.btnExportAll = $('#btnExportAll');
  DOM.btnExportCurrent = $('#btnExportCurrent');
  DOM.btnExportByTags = $('#btnExportByTags');
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
  DOM.btnOpenDbLocation = $('#btnOpenDbLocation');
  DOM.btnChangeDbLocation = $('#btnChangeDbLocation');
  DOM.pageButtons = $$('.nav-btn[data-page], .tool-stage-btn[data-page]');
  DOM.pagePanels = $$('.app-page[data-page-panel]');
  DOM.telegramPanelButtons = $$('[data-telegram-panel]');
  DOM.telegramPanelContents = $$('[data-telegram-panel-content]');
  DOM.telegramSourceStateBadge = $('#telegramSourceStateBadge');
  DOM.telegramBotAccountSummary = $('#telegramBotAccountSummary');
  DOM.telegramBotToken = $('#telegramBotToken');
  DOM.btnTelegramBotConnect = $('#btnTelegramBotConnect');
  DOM.btnTelegramBotConnectStored = $('#btnTelegramBotConnectStored');
  DOM.btnTelegramBotClear = $('#btnTelegramBotClear');
  DOM.btnTelegramBotFather = $('#btnTelegramBotFather');
  DOM.btnTelegramBotDiscover = $('#btnTelegramBotDiscover');
  DOM.btnTelegramBotSaveGroups = $('#btnTelegramBotSaveGroups');
  DOM.telegramBotGroupSearch = $('#telegramBotGroupSearch');
  DOM.telegramBotGroupSelectionCount = $('#telegramBotGroupSelectionCount');
  DOM.telegramBotGroupPicker = $('#telegramBotGroupPicker');
  DOM.telegramBotSelectedSources = $('#telegramBotSelectedSources');
  DOM.telegramBotSyncLimit = $('#telegramBotSyncLimit');
  DOM.btnTelegramBotSync = $('#btnTelegramBotSync');
  DOM.btnTelegramBotStopSync = $('#btnTelegramBotStopSync');
  DOM.telegramBotSyncProgress = $('#telegramBotSyncProgress');
  DOM.telegramAccountSummary = $('#telegramAccountSummary');
  DOM.telegramApiId = $('#telegramApiId');
  DOM.telegramApiHash = $('#telegramApiHash');
  DOM.telegramPhone = $('#telegramPhone');
  DOM.btnTelegramStartQrAuth = $('#btnTelegramStartQrAuth');
  DOM.btnTelegramStartAuth = $('#btnTelegramStartAuth');
  DOM.btnTelegramApiDocs = $('#btnTelegramApiDocs');
  DOM.btnTelegramConnectStored = $('#btnTelegramConnectStored');
  DOM.btnTelegramLogout = $('#btnTelegramLogout');
  DOM.telegramQrLogin = $('#telegramQrLogin');
  DOM.telegramQrImage = $('#telegramQrImage');
  DOM.telegramQrCountdown = $('#telegramQrCountdown');
  DOM.btnTelegramCancelQr = $('#btnTelegramCancelQr');
  DOM.telegramPhoneFallback = $('#telegramPhoneFallback');
  DOM.telegramAuthChallenge = $('#telegramAuthChallenge');
  DOM.telegramAuthPrompt = $('#telegramAuthPrompt');
  DOM.telegramAuthValue = $('#telegramAuthValue');
  DOM.btnTelegramSubmitAuth = $('#btnTelegramSubmitAuth');
  DOM.btnTelegramCancelAuth = $('#btnTelegramCancelAuth');
  DOM.btnTelegramLoadGroups = $('#btnTelegramLoadGroups');
  DOM.btnTelegramSaveGroups = $('#btnTelegramSaveGroups');
  DOM.telegramGroupSearch = $('#telegramGroupSearch');
  DOM.telegramGroupSelectionCount = $('#telegramGroupSelectionCount');
  DOM.telegramGroupPicker = $('#telegramGroupPicker');
  DOM.telegramSelectedSources = $('#telegramSelectedSources');
  DOM.telegramSyncLimit = $('#telegramSyncLimit');
  DOM.telegramSyncSince = $('#telegramSyncSince');
  DOM.telegramSyncLookback = $('#telegramSyncLookback');
  DOM.btnTelegramSync = $('#btnTelegramSync');
  DOM.btnTelegramStopSync = $('#btnTelegramStopSync');
  DOM.telegramSyncProgress = $('#telegramSyncProgress');
  DOM.btnTelegramImportFiles = $('#btnTelegramImportFiles');
  DOM.btnTelegramImportDirectory = $('#btnTelegramImportDirectory');
  DOM.telegramExportStatus = $('#telegramExportStatus');
  DOM.telegramImportSummary = $('#telegramImportSummary');
  DOM.telegramMetricMessages = $('#telegramMetricMessages');
  DOM.telegramMetricNew = $('#telegramMetricNew');
  DOM.telegramMetricDuplicate = $('#telegramMetricDuplicate');
  DOM.telegramMetricUpdated = $('#telegramMetricUpdated');
  DOM.telegramMetricCodes = $('#telegramMetricCodes');
  DOM.telegramCodePreview = $('#telegramCodePreview');
  DOM.btnTelegramUseCodes = $('#btnTelegramUseCodes');
  DOM.telegramHistoryList = $('#telegramHistoryList');
  DOM.raindropSyncStateBadge = $('#raindropSyncStateBadge');
  DOM.raindropAccountStatus = $('#raindropAccountStatus');
  DOM.raindropTokenInput = $('#raindropTokenInput');
  DOM.btnSaveRaindropToken = $('#btnSaveRaindropToken');
  DOM.btnTestRaindropAccount = $('#btnTestRaindropAccount');
  DOM.btnClearRaindropToken = $('#btnClearRaindropToken');
  DOM.btnOpenRaindropTokenDocs = $('#btnOpenRaindropTokenDocs');
  DOM.raindropBatchStatus = $('#raindropBatchStatus');
  DOM.raindropBatchSelect = $('#raindropBatchSelect');
  DOM.raindropCollectionSelect = $('#raindropCollectionSelect');
  DOM.raindropCollectionLabel = $('#raindropCollectionLabel');
  DOM.raindropRoutingNote = $('#raindropRoutingNote');
  DOM.btnRefreshRaindropCollections = $('#btnRefreshRaindropCollections');
  DOM.raindropMetricEligible = $('#raindropMetricEligible');
  DOM.raindropMetricCreate = $('#raindropMetricCreate');
  DOM.raindropMetricUpdate = $('#raindropMetricUpdate');
  DOM.raindropMetricSkip = $('#raindropMetricSkip');
  DOM.raindropMetricError = $('#raindropMetricError');
  DOM.raindropPlanTitle = $('#raindropPlanTitle');
  DOM.raindropPlanDetail = $('#raindropPlanDetail');
  DOM.btnPreviewRaindropSync = $('#btnPreviewRaindropSync');
  DOM.btnStartRaindropSync = $('#btnStartRaindropSync');
  DOM.btnStopRaindropSync = $('#btnStopRaindropSync');
  DOM.raindropSyncProgress = $('#raindropSyncProgress');
  DOM.raindropProgressText = $('#raindropProgressText');
  DOM.raindropProgressPercent = $('#raindropProgressPercent');
  DOM.raindropProgressFill = $('#raindropProgressFill');
  DOM.raindropPreviewBody = $('#raindropPreviewBody');
  DOM.raindropPreviewPanel = $('#raindropPreviewPanel');
  DOM.btnToggleRaindropPreviewSize = $('#btnToggleRaindropPreviewSize');
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

  renderIcons();
  loadAppearance();
  applyAppearance();
  checkDbReady();
  loadHistory();
  loadCsvRecent();
  loadSpeedSettings();
  loadSiteWorkspace();
  loadRaindropSyncSettings();
  loadToolboxSettings();
  bindEvents();
  setupTelegramEvents();
  initializeToolboxUI();
  updateUI();
  window.setInterval(updateTelegramQrCountdown, 1000);
  void initializeTelegramConnection();
  void initializeTelegramBotConnection();
  if (state.av123FavoriteMethod === 'chrome') void refreshChromeFavoriteBridgeStatus();
}

// ─── 外观设置 ────────────────────────────────────────
function loadAppearance() {
  try {
    const saved = JSON.parse(localStorage.getItem(APPEARANCE_KEY) || '{}');
    state.appearance = { ...state.appearance, ...saved };
    if (Number(saved.version || 0) < APPEARANCE_VERSION) {
      if (!saved.theme) state.appearance.theme = 'mint';
      if (!saved.visualPack) state.appearance.visualPack = 'none';
      state.appearance.version = APPEARANCE_VERSION;
      saveAppearance();
    }
  } catch {}
}

function saveAppearance() {
  try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(state.appearance)); } catch {}
}

function loadToolboxSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(TOOLBOX_BINDINGS_KEY) || '{}');
    for (const kind of TOOL_MANIFESTS.map(tool => tool.id)) {
      state.toolboxBindings[kind] = String(saved?.[kind] || '');
    }
  } catch {}
}

function saveToolboxBindings() {
  try { localStorage.setItem(TOOLBOX_BINDINGS_KEY, JSON.stringify(state.toolboxBindings)); } catch {}
}

function toolboxGroupRows() {
  const rows = [
    ...(state.telegram.bot.groupSources || []),
    ...(state.telegram.groupSources || []),
  ];
  const unique = new Map();
  for (const row of rows) {
    const sourceKey = String(row?.sourceKey || '');
    if (sourceKey && !unique.has(sourceKey)) unique.set(sourceKey, row);
  }
  return [...unique.values()];
}

function refreshToolboxGroupOptions() {
  const rows = toolboxGroupRows();
  const render = (select, kind) => {
    if (!select) return;
    const selected = state.toolboxBindings[kind] || '';
    const known = rows.some(row => row.sourceKey === selected);
    const missing = selected && !known
      ? `<option value="${esc(selected)}">原绑定群组当前未连接</option>`
      : '';
    select.innerHTML = `<option value="">不绑定，只用手动输入</option>${missing}${rows.map(row => {
      const provider = row.sourceType === 'bot_group' ? 'Bot' : '用户 API';
      return `<option value="${esc(row.sourceKey)}">${esc(row.sourceLabel || row.chatKey)} · ${provider}</option>`;
    }).join('')}`;
    select.value = selected;
  };
  render(DOM.twitterGroupBinding, 'twitter');
  render(DOM.badnewsGroupBinding, 'badnews');
  render(DOM.avGroupBinding, state.activeAvTool);
}

function setToolboxBinding(kind, sourceKey) {
  if (!TOOL_BY_ID.has(kind)) return;
  state.toolboxBindings[kind] = String(sourceKey || '');
  saveToolboxBindings();
  refreshToolboxGroupOptions();
  const row = toolboxGroupRows().find(item => item.sourceKey === state.toolboxBindings[kind]);
  toast(row ? `${toolLabel(kind)} 已绑定：${row.sourceLabel}` : `${toolLabel(kind)} 已改为仅手动输入`, 'success');
}

function toolLabel(kind) {
  return TOOL_BY_ID.get(kind)?.label || kind;
}

function saveActiveAvToolSession() {
  const kind = state.activeAvTool;
  const session = state.avToolSessions[kind];
  if (!session || !DOM.codeInput) return;
  session.raw = DOM.codeInput.value;
  session.sourceLabel = DOM.inputSourceInfo?.dataset.sourceLabel || DOM.inputSourceInfo?.textContent || '手动输入';
  session.preparedRunId = state.preparedRunId;
  session.preparedInputSignature = state.preparedInputSignature;
  session.timeStart = DOM.avTimeStart?.value || '';
  session.timeEnd = DOM.avTimeEnd?.value || '';
}

function loadAvToolSession(kind) {
  const session = state.avToolSessions[kind];
  if (!session) return;
  state.preparedRunId = session.preparedRunId || null;
  state.preparedInputSignature = session.preparedInputSignature || '';
  DOM.codeInput.value = session.raw || '';
  if (DOM.avTimeStart) DOM.avTimeStart.value = session.timeStart || '';
  if (DOM.avTimeEnd) DOM.avTimeEnd.value = session.timeEnd || '';
  parseInputCodes(session.sourceLabel || '手动输入');
  if (session.preparedRunId) {
    const run = api.dbGetRun(Number(session.preparedRunId));
    if (run) {
      state.selectedRunId = run.id;
      state.results = (run.items || []).map(batchItemToResult);
      state.stats = statsFromBatch(run);
    }
  } else {
    state.results = [];
    state.stats = { total: state.inputCodes.length, new: state.inputCodes.length, exists: 0, notFound: 0, duplicate: 0 };
  }
}

function updateToolboxNavigation() {
  const isAv = ['missav', 'av123'].includes(state.activeTool);
  const manifest = TOOL_BY_ID.get(state.activeTool);
  const inToolWorkspace = Boolean(manifest && manifest.pages.includes(state.activePage));
  if (DOM.toolWorkspaceBar) DOM.toolWorkspaceBar.hidden = !inToolWorkspace;
  if (DOM.toolWorkspaceTitle) DOM.toolWorkspaceTitle.textContent = manifest?.label || '—';
  if (DOM.avToolStages) DOM.avToolStages.hidden = !isAv;
  document.querySelectorAll('[data-missav-stage]').forEach(node => { node.hidden = state.activeAvTool !== 'missav'; });
  if (DOM.avInputTitle) DOM.avInputTitle.textContent = `${toolLabel(state.activeAvTool)} 番号输入`;
  if (DOM.avGroupBindingLabel) DOM.avGroupBindingLabel.textContent = `${toolLabel(state.activeAvTool)} 绑定 Telegram 群组`;
  if (DOM.avGroupBindingStatus) DOM.avGroupBindingStatus.textContent = `当前只把绑定群组的消息送入 ${toolLabel(state.activeAvTool)}；同一群可以同时绑定另一个工具。`;
  refreshToolboxGroupOptions();
  DOM.pageButtons?.forEach(button => {
    button.classList.toggle('active', button.dataset.page === state.activePage);
  });
}

function switchTool(kind) {
  const next = TOOL_BY_ID.has(kind) ? kind : 'twitter';
  if (['missav', 'av123'].includes(state.activeTool)) saveActiveAvToolSession();
  state.activeTool = next;
  if (['missav', 'av123'].includes(next)) {
    state.activeAvTool = next;
    loadAvToolSession(next);
    switchSiteWorkspace(next);
    switchResultWorkspace(next);
    switchPage('process');
  } else {
    switchPage(next);
  }
  updateToolboxNavigation();
  updateUI();
  renderTable();
}

function initializeToolboxUI() {
  renderToolHome();
  runSimpleToolFilter('twitter');
  runSimpleToolFilter('badnews');
  refreshToolboxGroupOptions();
  updateToolboxNavigation();
  updateTaskCenter();
}

function renderToolHome() {
  if (!DOM.toolHomeCategories) return;
  DOM.toolHomeCategories.innerHTML = window.ToolShell.buildToolHomeHtml(TOOL_MANIFESTS);
  if (DOM.homeToolCount) DOM.homeToolCount.textContent = String(TOOL_MANIFESTS.length);
  renderIcons();
}

function formatTaskProgress(site) {
  if (!state.isProcessing || state.activeLookupSite !== site) return '空闲';
  const completed = Number(state.processingTiming.completed || 0);
  const total = Number(state.processingTiming.total || 0);
  return total ? `运行中 · ${completed}/${total}` : '运行中';
}

function updateTelegramSyncWarning() {
  if (!DOM.telegramSyncWarning) return;
  const sources = (state.telegram.bot.groupSources || []).filter(source => source.isSelected !== false);
  if (!state.telegram.bot.auth.configured || !sources.length) {
    DOM.telegramSyncWarning.hidden = true;
    return;
  }
  const latest = Math.max(0, ...sources.map(source => new Date(source.lastSyncAt || 0).getTime()).filter(Number.isFinite));
  const ageHours = latest ? (Date.now() - latest) / 3600000 : Infinity;
  const warning = ageHours >= 20;
  DOM.telegramSyncWarning.hidden = !warning;
  if (warning && DOM.telegramSyncWarningText) {
    DOM.telegramSyncWarningText.textContent = Number.isFinite(ageHours)
      ? `距离上次 Bot 同步约 ${Math.floor(ageHours)} 小时，请手动同步以降低消息过期风险。`
      : '已绑定 Bot 群组但还没有同步记录，请手动执行一次同步。';
  }
}

function updateTaskCenter() {
  const missav = formatTaskProgress('missav');
  const av123 = formatTaskProgress('av123');
  const favorite = state.favoriteRuntime?.running
    ? `运行中 · ${Number(state.favoriteRuntime.completed || 0)}/${Number(state.favoriteRuntime.total || 0)}`
    : '空闲';
  const raindrop = state.raindropSync.running
    ? `运行中 · ${Number(state.raindropSync.progress.completed || 0)}/${Number(state.raindropSync.progress.total || 0)}`
    : '空闲';
  const telegramRunning = state.telegram.running || state.telegram.bot.running;
  const telegram = telegramRunning ? '同步中' : '空闲';
  if (DOM.taskMissavStatus) DOM.taskMissavStatus.textContent = missav;
  if (DOM.task123Status) DOM.task123Status.textContent = av123;
  if (DOM.taskFavoriteStatus) DOM.taskFavoriteStatus.textContent = favorite;
  if (DOM.taskRaindropStatus) DOM.taskRaindropStatus.textContent = raindrop;
  if (DOM.taskTelegramStatus) DOM.taskTelegramStatus.textContent = telegram;
  const statuses = { twitter: '空闲', badnews: '空闲', missav, av123 };
  if (state.favoriteRuntime?.running) statuses.av123 = '收藏运行中';
  document.querySelectorAll('[data-tool-status]').forEach(node => {
    node.textContent = statuses[node.dataset.toolStatus] || '空闲';
    node.classList.toggle('is-running', node.textContent !== '空闲');
  });
  const runningCount = [missav, av123, favorite, raindrop, telegram].filter(value => value !== '空闲').length;
  if (DOM.homeRunningCount) DOM.homeRunningCount.textContent = String(runningCount);
  if (DOM.taskCenterBadge) DOM.taskCenterBadge.textContent = runningCount ? `${runningCount} 项运行中` : '全部空闲';
  updateTelegramSyncWarning();
}

function switchPage(page) {
  if (page !== 'sync' && state.raindropSync.previewExpanded) setRaindropPreviewExpanded(false);
  state.activePage = page;
  DOM.pageButtons.forEach(btn => {
    const active = btn.dataset.tool
      ? btn.dataset.tool === state.activeTool
      : btn.dataset.page === page;
    btn.classList.toggle('active', active);
  });
  DOM.pagePanels.forEach(panel => panel.classList.toggle('active', panel.dataset.pagePanel === page));
  if (page === 'library') renderDataWorkbench();
  if (page === 'results') renderTable();
  if (page === 'sync') void refreshRaindropSyncPage();
  if (page === 'sources') void refreshTelegramSourcePage();
  updateToolboxNavigation();
}

function normalizeSiteWorkspace(workspace) {
  return ['missav', 'av123', 'batch'].includes(workspace) ? workspace : 'missav';
}

function switchSiteWorkspace(workspace, options = {}) {
  state.siteWorkspace = normalizeSiteWorkspace(workspace);
  DOM.siteWorkspaceButtons?.forEach(button => {
    const active = button.dataset.siteWorkspace === state.siteWorkspace;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  DOM.siteWorkspacePanels?.forEach(panel => {
    const active = panel.dataset.siteWorkspacePanel === state.siteWorkspace;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });
  if (options.persist !== false) {
    try { localStorage.setItem(SITE_WORKSPACE_KEY, state.siteWorkspace); } catch {}
  }
}

function loadSiteWorkspace() {
  let saved = 'missav';
  try { saved = localStorage.getItem(SITE_WORKSPACE_KEY) || 'missav'; } catch {}
  switchSiteWorkspace(saved, { persist: false });
  let av123Tab = 'lookup';
  try { av123Tab = localStorage.getItem(AV123_SITE_TAB_KEY) || 'lookup'; } catch {}
  switch123AvSiteTab(av123Tab, { persist: false });
}

function switch123AvSiteTab(tab, options = {}) {
  state.av123SiteTab = tab === 'favorite' ? 'favorite' : 'lookup';
  DOM.av123SiteTabButtons?.forEach(button => {
    const active = button.dataset.av123SiteTab === state.av123SiteTab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  DOM.av123SiteTabPanels?.forEach(panel => {
    const active = panel.dataset.av123SiteTabPanel === state.av123SiteTab;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });
  if (options.persist !== false) {
    try { localStorage.setItem(AV123_SITE_TAB_KEY, state.av123SiteTab); } catch {}
  }
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
  document.body.dataset.theme = a.theme || 'mint';
  document.body.dataset.density = a.density || 'comfortable';
  if (pack) document.body.dataset.visualPack = packKey;
  else delete document.body.dataset.visualPack;
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

  if (DOM.themeSelect) DOM.themeSelect.value = a.theme || 'mint';
  if (DOM.visualPackSelect) DOM.visualPackSelect.value = packKey;
  if (DOM.visualPackCards) DOM.visualPackCards.forEach(card => card.classList.toggle('active', card.dataset.visualPack === packKey));
  if (DOM.uiDensitySelect) DOM.uiDensitySelect.value = a.density || 'comfortable';
  if (DOM.bgDimRange) DOM.bgDimRange.value = Number(a.bgDim ?? 35);
  if (DOM.bgDimValue) DOM.bgDimValue.textContent = `${Number(a.bgDim ?? 35)}%`;
}

function renderIcons() {
  if (!window.lucide) return;
  window.lucide.createIcons({
    attrs: {
      'aria-hidden': 'true',
      'stroke-width': 1.9,
    },
  });
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

function simpleToolRange(kind) {
  const prefix = kind === 'twitter' ? 'twitter' : 'badnews';
  return {
    start: DOM[`${prefix}TimeStart`]?.value || '',
    end: DOM[`${prefix}TimeEnd`]?.value || '',
  };
}

function appendUniqueToolMessages(target, messages) {
  const seen = new Set((target.messages || []).map(message =>
    String(message?.contentHash || `${message?.accountKey || ''}:${message?.chatKey || ''}:${message?.messageId || ''}:${message?.text || ''}`)));
  for (const message of messages || []) {
    const key = String(message?.contentHash || `${message?.accountKey || ''}:${message?.chatKey || ''}:${message?.messageId || ''}:${message?.text || ''}`);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    target.messages.push(message);
  }
}

function runSimpleToolFilter(kind) {
  const tool = state.toolbox[kind];
  if (!tool) return [];
  const prefix = kind === 'twitter' ? 'twitter' : 'badnews';
  const input = DOM[`${prefix}RawInput`];
  if (input) tool.raw = input.value;
  const range = simpleToolRange(kind);
  const combined = [
    ...(tool.messages || []),
    ...(tool.raw ? [{ text: tool.raw, links: [], sourceType: 'manual' }] : []),
  ];
  if (kind === 'twitter') {
    tool.results = api.extractTwitterProfiles(combined, range);
    if (DOM.twitterNamesOutput) DOM.twitterNamesOutput.value = tool.results.map(row => row.name).join('\n');
    if (DOM.twitterUrlsOutput) DOM.twitterUrlsOutput.value = tool.results.map(row => row.url).join('\n');
    if (DOM.twitterResultCount) DOM.twitterResultCount.textContent = `${tool.results.length} 位博主`;
  } else {
    tool.results = api.extractBadNewsLinks(combined, range);
    if (DOM.badnewsUrlsOutput) DOM.badnewsUrlsOutput.value = tool.results.join('\n');
    if (DOM.badnewsResultCount) DOM.badnewsResultCount.textContent = `${tool.results.length} 条链接`;
  }
  const extent = api.telegramMessageTimeExtent(tool.messages || []);
  const status = DOM[`${prefix}SourceStatus`];
  if (status) {
    const time = range.start || range.end ? ' · 已按所选分钟范围过滤' : '';
    status.textContent = tool.messages.length
      ? `${tool.sourceLabel || 'Telegram / 文件'} · ${tool.messages.length} 条消息，其中 ${extent.dated} 条有时间${time} · 结果仅保留在当前会话`
      : `${tool.raw ? '手动内容' : '当前会话尚无输入'}${time} · 结果不会写入永久数据库`;
  }
  return tool.results;
}

function clearSimpleTool(kind) {
  const label = toolLabel(kind);
  if (!confirm(`清空 ${label} 当前会话的输入和结果？这不会影响 Telegram 来源或其他工具。`)) return;
  state.toolbox[kind] = { raw: '', messages: [], sourceLabel: '', results: [] };
  const prefix = kind === 'twitter' ? 'twitter' : 'badnews';
  if (DOM[`${prefix}RawInput`]) DOM[`${prefix}RawInput`].value = '';
  runSimpleToolFilter(kind);
}

async function copyToolboxText(value, label) {
  const text = String(value || '').trim();
  if (!text) { toast(`没有可复制的${label}`, 'error'); return; }
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制${label}，共 ${text.split(/\r?\n/).filter(Boolean).length} 行`, 'success');
  } catch (error) {
    toast(`复制失败：${error.message}`, 'error');
  }
}

async function ensureToolboxOutputDirectory() {
  if (state.outputDirPath && await api.fileExists(state.outputDirPath)) return state.outputDirPath;
  const directory = await api.openDirectory({ title: '选择工具结果保存目录' });
  if (!directory) return '';
  state.outputDirPath = directory;
  if (DOM.outputDirPath) DOM.outputDirPath.textContent = shortenPath(directory);
  if (DOM.outputDirPathMirror) DOM.outputDirPathMirror.textContent = shortenPath(directory);
  return directory;
}

async function saveTwitterToolResults() {
  const rows = runSimpleToolFilter('twitter');
  if (!rows.length) { toast('没有可导出的推特博主', 'error'); return; }
  const directory = await ensureToolboxOutputDirectory();
  if (!directory) return;
  const prefix = api.timePrefixToMinute();
  await Promise.all([
    api.writeFile(`${directory}\\${prefix}_推特博主名.txt`, rows.map(row => row.name).join('\n')),
    api.writeFile(`${directory}\\${prefix}_推特主页链接.txt`, rows.map(row => row.url).join('\n')),
  ]);
  toast(`已导出 ${rows.length} 位博主的两个 TXT`, 'success');
}

async function saveBadnewsToolResults() {
  const rows = runSimpleToolFilter('badnews');
  if (!rows.length) { toast('没有可导出的 Bad.news 帖子链接', 'error'); return; }
  const directory = await ensureToolboxOutputDirectory();
  if (!directory) return;
  const filePath = `${directory}\\${api.timePrefixToMinute()}_badnews帖子链接.txt`;
  await api.writeFile(filePath, rows.join('\n'));
  toast(`已导出 ${rows.length} 条 Bad.news 帖子链接`, 'success');
}

async function importSimpleToolFiles(kind) {
  const paths = await api.openFile({
    title: `为${toolLabel(kind)}选择一个或多个文件`,
    multiSelections: true,
    filters: [
      { name: 'Telegram / 文本 / 网页文件', extensions: ['html', 'htm', 'json', 'txt', 'md', 'csv', 'log'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  const files = Array.isArray(paths) ? paths : paths ? [paths] : [];
  if (!files.length) return;
  const tool = state.toolbox[kind];
  const structured = files.filter(filePath => /\.html?$|\.json$/i.test(filePath));
  const parsedPaths = new Set();
  if (structured.length) {
    const parsed = await api.parseTelegramExport(structured);
    if (parsed?.messages?.length) {
      appendUniqueToolMessages(tool, parsed.messages);
      structured.forEach(filePath => parsedPaths.add(filePath));
    }
  }
  const rawParts = [];
  for (const filePath of files) {
    if (parsedPaths.has(filePath)) continue;
    rawParts.push(await api.readFile(filePath, 'utf-8'));
  }
  if (rawParts.length) {
    const current = String(tool.raw || '').trimEnd();
    tool.raw = [current, rawParts.join('\n\n')].filter(Boolean).join('\n\n');
  }
  tool.sourceLabel = `${files.length} 个文件`;
  const input = kind === 'twitter' ? DOM.twitterRawInput : DOM.badnewsRawInput;
  if (input) input.value = tool.raw;
  const results = runSimpleToolFilter(kind);
  toast(`${toolLabel(kind)}已导入 ${files.length} 个文件，过滤出 ${results.length} 条结果`, 'success');
}

function avToolRange(kind) {
  const session = state.avToolSessions[kind];
  return {
    start: kind === state.activeAvTool ? (DOM.avTimeStart?.value || '') : (session?.timeStart || ''),
    end: kind === state.activeAvTool ? (DOM.avTimeEnd?.value || '') : (session?.timeEnd || ''),
  };
}

function appendMessagesToAvTool(kind, messages, sourceLabel) {
  const session = state.avToolSessions[kind];
  if (!session) return 0;
  session.messageKeys ||= new Set();
  const filtered = api.filterTelegramMessagesByTime(messages || [], avToolRange(kind));
  const added = [];
  for (const message of filtered) {
    const key = String(message?.contentHash || `${message?.accountKey || ''}:${message?.chatKey || ''}:${message?.messageId || ''}`);
    if (!key || session.messageKeys.has(key)) continue;
    session.messageKeys.add(key);
    const block = [message?.text, ...(message?.links || [])].filter(Boolean).join('\n');
    if (block) added.push(block);
  }
  if (!added.length) return 0;
  if (kind === state.activeAvTool) saveActiveAvToolSession();
  session.raw = [String(session.raw || '').trimEnd(), added.join('\n\n')].filter(Boolean).join('\n\n');
  session.sourceLabel = sourceLabel || 'Telegram 群组';
  if (kind === state.activeAvTool) {
    DOM.codeInput.value = session.raw;
    parseInputCodes(session.sourceLabel);
    saveActiveAvToolSession();
    updateUI();
  }
  return added.length;
}

function dispatchToolboxMessages(result = {}) {
  const sourceKey = String(result.sourceKey || '');
  const messages = (result.messages || []).map(message => ({
    ...message,
    sourceType: message.sourceType || result.sourceType || 'telegram',
  }));
  if (!sourceKey || !messages.length) return;
  for (const kind of ['twitter', 'badnews']) {
    if (state.toolboxBindings[kind] !== sourceKey) continue;
    const tool = state.toolbox[kind];
    appendUniqueToolMessages(tool, messages);
    tool.sourceLabel = result.sourceLabel || 'Telegram 群组';
    runSimpleToolFilter(kind);
  }
  for (const kind of ['missav', 'av123']) {
    if (state.toolboxBindings[kind] === sourceKey) {
      appendMessagesToAvTool(kind, messages, result.sourceLabel || 'Telegram 群组');
    }
  }
}

async function syncToolboxBinding(kind) {
  const sourceKey = state.toolboxBindings[kind];
  if (!sourceKey) { toast(`请先为 ${toolLabel(kind)} 绑定 Telegram 群组`, 'error'); return; }
  const source = toolboxGroupRows().find(row => row.sourceKey === sourceKey) || api.dbGetTelegramSource?.(sourceKey);
  if (!source) { toast('原绑定群组当前不可用，请到 Telegram 来源重新连接', 'error'); return; }
  if (source.sourceType === 'bot_group') await syncTelegramBotGroups();
  else await syncTelegramGroups([source.chatKey]);
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
  DOM.dbSummaryMini.textContent = `${stats.codeCount} 番号 / ${stats.actressCount} 女优 Tags / ${stats.genreCount} 类型 Tags`;
  DOM.librarySectionPath.textContent = `永久番号库（${stats.codeCount} 条记录）`;
  void refreshDatabaseLocationDisplay();
}

async function refreshDatabaseLocationDisplay() {
  if (!DOM.dbPathValue || !api.getDatabaseLocation) return;
  try {
    const location = await api.getDatabaseLocation();
    DOM.dbPathValue.textContent = location.directory || location.databasePath || '未配置';
    DOM.dbPathValue.dataset.directory = location.directory || '';
  } catch {
    DOM.dbPathValue.textContent = api.dbGetPath ? api.dbGetPath() : 'data';
  }
}

async function changeDatabaseLocation() {
  const busy = state.isProcessing || state.favoriteRuntime?.running || state.raindropSync.running
    || state.telegram.running || state.telegram.bot.running;
  if (busy) {
    toast('请先停止正在运行的查询、收藏或同步任务，再迁移数据库', 'warning');
    return;
  }
  try {
    const result = await api.changeDatabaseLocation();
    if (result?.changed) {
      toast('数据库已安全复制，软件正在重启…', 'success');
      if (DOM.btnChangeDbLocation) DOM.btnChangeDbLocation.disabled = true;
    }
  } catch (error) {
    toast(`更改数据库位置失败：${error.message}`, 'error');
  }
}

async function openDatabaseLocation() {
  try {
    const location = await api.getDatabaseLocation();
    if (location?.directory) await api.showDirectory(location.directory);
  } catch (error) {
    toast(`无法打开数据库目录：${error.message}`, 'error');
  }
}
// ─── 数据库状态检查 ──────────────────────────────────
async function checkDbReady() {
  let attempts = 0;
  while (!api.dbIsReady() && attempts < 50) { await api.sleep(200); attempts++; }

  if (api.dbIsReady()) {
    state.dbReady = true;
    refreshDbSummary();
    refreshResumableBatchPanel();
    logEvent('info', 'database_ready', api.dbGetStats());
    setStatus('就绪 ✓ 数据库已加载', null, null, null);
    updateUI();
  } else {
    const err = api.dbGetError();
    logEvent('error', 'database_failed', { error: err });
    DOM.librarySectionPath.textContent = '数据库加载失败';
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

function refreshResumableBatchPanel() {
  if (!state.dbReady || !DOM.resumeBatchPanel) return;
  const batch = api.dbGetResumableRun?.() || null;
  state.resumableRun = batch;
  DOM.resumeBatchPanel.hidden = !batch;
  if (!batch) { updateOperationSummaries(); updateSiteRunControls(); updateRunDeleteControls(); return; }
  DOM.resumeBatchName.textContent = batch.name || `批次 #${batch.id}`;
  const missavPending = lookupStagePending(batch, 'missavLookup');
  const av123Pending = lookupStagePending(batch, 'av123Lookup');
  DOM.resumeBatchSummary.textContent = `MissAV 待 ${missavPending} · 123AV 待 ${av123Pending} · ${runStatusLabel(batch.status)}`;
  DOM.btnResumeMissavBatch.hidden = missavPending <= 0;
  DOM.btnResumeMissavBatch.disabled = state.isProcessing || missavPending <= 0;
  DOM.btnResumeMissavBatch.dataset.runId = String(batch.id);
  DOM.btnResume123AvBatch.hidden = av123Pending <= 0;
  DOM.btnResume123AvBatch.disabled = state.isProcessing || Boolean(state.favoriteRuntime?.running) || av123Pending <= 0;
  DOM.btnResume123AvBatch.dataset.runId = String(batch.id);
  if (DOM.btnDeleteResumableBatch) DOM.btnDeleteResumableBatch.dataset.runId = String(batch.id);
  updateOperationSummaries();
  updateSiteRunControls();
  updateRunDeleteControls();
}

function normalizeSpeedSite(site) {
  return site === 'av123' ? 'av123' : 'missav';
}

function speedModeForSite(site) {
  const siteKey = normalizeSpeedSite(site);
  return processingSpeed.normalizeMode(state.speedModes?.[siteKey]);
}

function normalize123AvSpeedPolicy(policy) {
  return processingSpeed.normalize123AvPolicy(policy);
}

function normalizeMissavSpeedPolicy(policy) {
  return processingSpeed.normalizeMissavPolicy(policy);
}

function normalize123AvRateMode(mode) {
  return processingSpeed.normalizeSiteRateMode('av123', mode);
}

function normalize123AvRateCap(value) {
  return processingSpeed.normalizeSiteRateCap('av123', value);
}

function normalize123AvLearnedRate(value) {
  return processingSpeed.normalizeSiteLearnedRate('av123', value);
}

function normalizeSiteRateMode(site, mode) {
  return processingSpeed.normalizeSiteRateMode(normalizeSpeedSite(site), mode);
}

function normalizeSiteRateCap(site, value) {
  return processingSpeed.normalizeSiteRateCap(normalizeSpeedSite(site), value);
}

function normalizeSiteLearnedRate(site, value) {
  return processingSpeed.normalizeSiteLearnedRate(normalizeSpeedSite(site), value);
}

function siteRateSettings(site) {
  const siteKey = normalizeSpeedSite(site);
  return siteKey === 'av123'
    ? { mode: normalizeSiteRateMode(siteKey, state.av123RateMode), cap: normalizeSiteRateCap(siteKey, state.av123RateCap), learned: normalizeSiteLearnedRate(siteKey, state.av123LearnedRate) }
    : { mode: normalizeSiteRateMode(siteKey, state.missavRateMode), cap: normalizeSiteRateCap(siteKey, state.missavRateCap), learned: normalizeSiteLearnedRate(siteKey, state.missavLearnedRate) };
}

function currentSpeedSettings() {
  return {
    missavSpeedMode: speedModeForSite('missav'),
    av123SpeedMode: speedModeForSite('av123'),
    missavSpeedPolicy: normalizeMissavSpeedPolicy(state.missavSpeedPolicy),
    missavRateMode: normalizeSiteRateMode('missav', state.missavRateMode),
    missavRateCap: normalizeSiteRateCap('missav', state.missavRateCap),
    av123SpeedPolicy: normalize123AvSpeedPolicy(state.av123SpeedPolicy),
    av123RateMode: normalize123AvRateMode(state.av123RateMode),
    av123RateCap: normalize123AvRateCap(state.av123RateCap),
    av123AutoFavorite: Boolean(state.av123AutoFavorite),
    av123FavoriteConcurrency: 1,
  };
}

function persistPreparedSpeedSettings() {
  if (!state.dbReady || !state.preparedRunId || !api.dbSetRunSpeedSettings) return;
  const batch = api.dbGetRun(Number(state.preparedRunId));
  if (!batch || Number(batch.lookupPending || 0) <= 0) return;
  api.dbSetRunSpeedSettings(batch.id, currentSpeedSettings());
}

function applyBatchSpeedSettings(batch) {
  if (!batch) return;
  state.speedModes = {
    missav: processingSpeed.normalizeMode(batch.missavSpeedMode || batch.speedMode || speedModeForSite('missav')),
    av123: processingSpeed.normalizeMode(batch.av123SpeedMode || batch.speedMode || speedModeForSite('av123')),
  };
  state.missavRateMode = normalizeSiteRateMode('missav', batch.missavRateMode || state.missavRateMode);
  state.missavRateCap = normalizeSiteRateCap('missav', batch.missavRateCap || state.missavRateCap);
  state.missavSpeedPolicy = normalizeMissavSpeedPolicy(batch.missavSpeedPolicy || state.missavSpeedPolicy);
  state.av123SpeedPolicy = normalize123AvSpeedPolicy(batch.av123SpeedPolicy || state.av123SpeedPolicy);
  state.av123RateMode = normalize123AvRateMode(batch.av123RateMode || state.av123RateMode);
  state.av123RateCap = normalize123AvRateCap(batch.av123RateCap || state.av123RateCap);
  state.av123AutoFavorite = batch.av123AutoFavorite === true;
  state.av123FavoriteConcurrency = 1;
  updateSpeedModeUI();
}

function loadSpeedSettings() {
  try {
    const legacyMode = processingSpeed.normalizeMode(localStorage.getItem(LEGACY_SPEED_MODE_KEY));
    state.speedModes = {
      missav: processingSpeed.normalizeMode(localStorage.getItem(SITE_SPEED_MODE_KEYS.missav) || legacyMode),
      av123: processingSpeed.normalizeMode(localStorage.getItem(SITE_SPEED_MODE_KEYS.av123) || 'turbo'),
    };
    state.missavSpeedPolicy = normalizeMissavSpeedPolicy(localStorage.getItem(MISSAV_SPEED_POLICY_KEY));
    const savedPolicy = localStorage.getItem(AV123_SPEED_POLICY_KEY);
    const policyMigrated = localStorage.getItem(AV123_SPEED_POLICY_MIGRATION_KEY) === '1';
    state.av123SpeedPolicy = !policyMigrated && savedPolicy === 'fixed' ? 'staged' : normalize123AvSpeedPolicy(savedPolicy);
    if (!policyMigrated) {
      localStorage.setItem(AV123_SPEED_POLICY_KEY, state.av123SpeedPolicy);
      localStorage.setItem(AV123_SPEED_POLICY_MIGRATION_KEY, '1');
    }
    state.missavRateMode = normalizeSiteRateMode('missav', localStorage.getItem(MISSAV_RATE_MODE_KEY));
    state.missavRateCap = normalizeSiteRateCap('missav', localStorage.getItem(MISSAV_RATE_CAP_KEY));
    state.missavLearnedRate = normalizeSiteLearnedRate('missav', localStorage.getItem(MISSAV_LEARNED_RATE_KEY));
    state.av123RateMode = normalize123AvRateMode(localStorage.getItem(AV123_RATE_MODE_KEY));
    state.av123RateCap = normalize123AvRateCap(localStorage.getItem(AV123_RATE_CAP_KEY));
    state.av123LearnedRate = normalize123AvLearnedRate(localStorage.getItem(AV123_LEARNED_RATE_KEY));
    state.av123FavoriteConcurrency = 1;
    localStorage.setItem(AV123_FAVORITE_CONCURRENCY_KEY, '1');
    state.av123AutoFavorite = localStorage.getItem(AV123_AUTO_FAVORITE_KEY) === '1';
    state.av123FavoriteMethod = normalize123AvFavoriteMethod(localStorage.getItem(AV123_FAVORITE_METHOD_KEY));
  } catch {
    state.speedModes = { missav: 'smart', av123: 'turbo' };
    state.missavRateMode = 'adaptive';
    state.missavRateCap = processingSpeed.MISSAV_RATE_CONTROL.defaultCap;
    state.missavLearnedRate = processingSpeed.MISSAV_RATE_CONTROL.defaultLearnedRate;
    state.missavSpeedPolicy = 'stable';
    state.av123SpeedPolicy = 'staged';
    state.av123RateMode = 'adaptive';
    state.av123RateCap = processingSpeed.AV123_RATE_CONTROL.defaultCap;
    state.av123LearnedRate = processingSpeed.AV123_RATE_CONTROL.defaultLearnedRate;
    state.av123FavoriteConcurrency = 1;
    state.av123AutoFavorite = false;
    state.av123FavoriteMethod = 'chrome';
  }
  updateSpeedModeUI();
}

function setSpeedMode(site, mode, options = {}) {
  if (state.isProcessing) return;
  const siteKey = normalizeSpeedSite(site);
  state.speedModes[siteKey] = processingSpeed.normalizeMode(mode);
  if (options.persist !== false) {
    try { localStorage.setItem(SITE_SPEED_MODE_KEYS[siteKey], state.speedModes[siteKey]); } catch {}
    persistPreparedSpeedSettings();
  }
  updateSpeedModeUI();
}

function set123AvSpeedPolicy(policy, options = {}) {
  if (state.isProcessing) return;
  state.av123SpeedPolicy = normalize123AvSpeedPolicy(policy);
  if (options.persist !== false) {
    try { localStorage.setItem(AV123_SPEED_POLICY_KEY, state.av123SpeedPolicy); } catch {}
    persistPreparedSpeedSettings();
  }
  updateSpeedModeUI();
}

function setMissavSpeedPolicy(policy, options = {}) {
  if (state.isProcessing) return;
  state.missavSpeedPolicy = normalizeMissavSpeedPolicy(policy);
  if (options.persist !== false) {
    try { localStorage.setItem(MISSAV_SPEED_POLICY_KEY, state.missavSpeedPolicy); } catch {}
    persistPreparedSpeedSettings();
  }
  updateSpeedModeUI();
}

function persistSiteLearnedRate(site, value) {
  const siteKey = normalizeSpeedSite(site);
  const normalized = normalizeSiteLearnedRate(siteKey, value);
  if (siteKey === 'av123') state.av123LearnedRate = normalized;
  else state.missavLearnedRate = normalized;
  const key = siteKey === 'av123' ? AV123_LEARNED_RATE_KEY : MISSAV_LEARNED_RATE_KEY;
  try { localStorage.setItem(key, String(normalized)); } catch {}
}

function persist123AvLearnedRate(value) {
  persistSiteLearnedRate('av123', value);
}

function applySiteRateSettingsToRuntime(site) {
  const siteKey = normalizeSpeedSite(site);
  const runtime = state.speedRuntime;
  if (!runtime || runtime.site !== siteKey) return;
  const settings = siteRateSettings(siteKey);
  const cap = settings.cap;
  const rateMode = settings.mode;
  runtime.rateMode = rateMode;
  runtime.targetRequestsPerSecond = cap;
  runtime.rateWindowLimit = Math.max(1, Math.ceil(cap * runtime.rateWindowMs / 1000));
  if (rateMode === 'fixed') {
    runtime.sessionRateCeiling = cap;
    runtime.currentRequestsPerSecond = cap;
    runtime.rateSuccessesAtLevel = 0;
    runtime.lastRateChangeAt = Date.now();
  } else {
    runtime.sessionRateCeiling = runtime.rateLimitEvents > 0
      ? Math.min(cap, Number(runtime.sessionRateCeiling || cap))
      : cap;
    runtime.currentRequestsPerSecond = Math.min(cap, runtime.currentRequestsPerSecond);
  }
  runtime.currentGapMs = Math.ceil(1000 / Math.max(0.1, runtime.currentRequestsPerSecond));
  renderProcessingForecast();
}

function apply123AvRateSettingsToRuntime() {
  applySiteRateSettingsToRuntime('av123');
}

function setSiteRateMode(site, mode, options = {}) {
  const siteKey = normalizeSpeedSite(site);
  const normalized = normalizeSiteRateMode(siteKey, mode);
  if (siteKey === 'av123') state.av123RateMode = normalized;
  else state.missavRateMode = normalized;
  if (options.persist !== false) {
    const key = siteKey === 'av123' ? AV123_RATE_MODE_KEY : MISSAV_RATE_MODE_KEY;
    try { localStorage.setItem(key, normalized); } catch {}
    persistPreparedSpeedSettings();
  }
  applySiteRateSettingsToRuntime(siteKey);
  updateSpeedModeUI();
}

function setSiteRateCap(site, value, options = {}) {
  const siteKey = normalizeSpeedSite(site);
  const normalized = normalizeSiteRateCap(siteKey, value);
  if (siteKey === 'av123') state.av123RateCap = normalized;
  else state.missavRateCap = normalized;
  if (options.persist !== false) {
    const key = siteKey === 'av123' ? AV123_RATE_CAP_KEY : MISSAV_RATE_CAP_KEY;
    try { localStorage.setItem(key, String(normalized)); } catch {}
    persistPreparedSpeedSettings();
  }
  applySiteRateSettingsToRuntime(siteKey);
  updateSpeedModeUI();
}

function set123AvRateMode(mode, options = {}) { setSiteRateMode('av123', mode, options); }
function set123AvRateCap(value, options = {}) { setSiteRateCap('av123', value, options); }

function set123AvFavoriteConcurrency(value, options = {}) {
  if (state.favoriteRuntime?.running) return;
  state.av123FavoriteConcurrency = 1;
  if (options.persist !== false) {
    try { localStorage.setItem(AV123_FAVORITE_CONCURRENCY_KEY, String(state.av123FavoriteConcurrency)); } catch {}
    persistPreparedSpeedSettings();
  }
  updateSpeedModeUI();
}

function normalize123AvFavoriteMethod(value) {
  return ['chrome', 'app', 'export'].includes(value) ? value : 'chrome';
}

function effective123AvFavoriteConcurrency() {
  if (state.av123FavoriteMethod === 'export') return 0;
  return 1;
}

function favoriteExecutorOptions() {
  return { executor: state.av123FavoriteMethod === 'app' ? 'app' : 'chrome' };
}

function set123AvFavoriteMethod(value, options = {}) {
  if (state.favoriteRuntime?.running) return;
  state.av123FavoriteMethod = normalize123AvFavoriteMethod(value);
  if (options.persist !== false) {
    try { localStorage.setItem(AV123_FAVORITE_METHOD_KEY, state.av123FavoriteMethod); } catch {}
  }
  const detail = state.av123FavoriteMethod === 'app'
    ? 'APP 内独立账号窗口 · 固定 1 路串行'
    : state.av123FavoriteMethod === 'export'
      ? '仅生成 TXT / CSV，不访问账号'
      : '收藏使用本地 Chrome 已登录账号';
  state.av123Account = { status: 'unknown', accountLabel: '', detail };
  updateSpeedModeUI();
  render123AvAccountState();
  updateResultSelectionUi();
  if (state.av123FavoriteMethod === 'chrome') void refreshChromeFavoriteBridgeStatus();
}


function set123AvAutoFavorite(enabled, options = {}) {
  if (state.av123FavoriteMethod === 'export' || state.favoriteRuntime?.running || (state.isProcessing && state.activeLookupSite === 'av123')) return;
  state.av123AutoFavorite = Boolean(enabled);
  if (options.persist !== false) {
    try { localStorage.setItem(AV123_AUTO_FAVORITE_KEY, state.av123AutoFavorite ? '1' : '0'); } catch {}
    persistPreparedSpeedSettings();
  }
  if (DOM.av123AutoFavorite) DOM.av123AutoFavorite.checked = state.av123AutoFavorite;
}

function speedDescription(site, profile) {
  const siteKey = normalizeSpeedSite(site);
  const settings = siteRateSettings(siteKey);
  const cap = settings.cap.toFixed(1);
  const learned = Math.min(settings.learned, settings.cap).toFixed(1);
  const rateText = settings.mode === 'fixed'
    ? `固定目标 ${cap} 请求/秒`
    : `从已学习的约 ${learned} 请求/秒开始，稳定时逐级探到最高 ${cap}`;
  if (siteKey === 'missav') {
    const candidates = profile.fullSearch ? '完整检查候选' : '只查主地址';
    const policyText = state.missavSpeedPolicy === 'fixed'
      ? '保持工作路，错误留到结果页重跑。'
      : state.missavSpeedPolicy === 'balanced'
        ? '异常时最低保留一半工作路。'
        : '延迟或错误升高时自动保护。';
    return `MissAV 使用 ${profile.maxConcurrency} 个工作路并${candidates}；${rateText}。自动模式同时观察真实延迟、超时、连接重置和验证页，拥塞时平滑回退。${policyText}`;
  }
  const tail = state.av123SpeedPolicy === 'staged'
    ? '错误项在主轮后单独收尾。'
    : state.av123SpeedPolicy === 'balanced'
      ? '网络异常时保留较多工作路。'
      : '网络错误保留到结果页手动重跑。';
  return `123AV 使用 ${profile.maxConcurrency} 个工作路隐藏延迟；${rateText}。请求始终平滑发送，首个 HTTP 429 会立即暂停并回退到本轮稳定区间。${tail}`;
}

function updateSiteRateUI(site) {
  const siteKey = normalizeSpeedSite(site);
  const settings = siteRateSettings(siteKey);
  const is123Av = siteKey === 'av123';
  const modeElement = is123Av ? DOM.av123RateMode : DOM.missavRateMode;
  const capElement = is123Av ? DOM.av123RateCap : DOM.missavRateCap;
  const capValueElement = is123Av ? DOM.av123RateCapValue : DOM.missavRateCapValue;
  const buttons = is123Av ? DOM.av123RateCapButtons : DOM.missavRateCapButtons;
  const descriptionElement = is123Av ? DOM.av123RateDescription : DOM.missavRateDescription;
  const liveElement = is123Av ? DOM.av123RateLive : DOM.missavRateLive;
  if (modeElement) modeElement.value = settings.mode;
  if (capElement) capElement.value = String(settings.cap);
  if (capValueElement) capValueElement.textContent = `${Number(settings.cap).toFixed(0)} 请求/秒`;
  buttons?.forEach(button => {
    const selected = Number(is123Av ? button.dataset.av123RateCap : button.dataset.missavRateCap);
    const active = selected === Number(settings.cap);
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  if (descriptionElement) {
    const start = Math.min(settings.learned, settings.cap).toFixed(1);
    descriptionElement.textContent = settings.mode === 'adaptive'
      ? `自动模式从约 ${start} 请求/秒起步，按真实延迟和完成速度升速；超时、连接重置、验证页或 429 会降速。同一批次最高 ${settings.cap}。`
      : `固定模式以 ${settings.cap} 请求/秒平滑发送；硬超时仍生效，HTTP 429 仍会紧急冷却。`;
  }
  if (liveElement && (!state.isProcessing || state.activeLookupSite !== siteKey)) {
    const start = settings.mode === 'adaptive' ? Math.min(settings.learned, settings.cap) : settings.cap;
    liveElement.textContent = settings.mode === 'adaptive'
      ? `预计从 ${Number(start).toFixed(1)} RPS 开始 · 调度上限 ${Number(settings.cap).toFixed(1)} RPS`
      : `调度目标 ${Number(settings.cap).toFixed(1)} RPS · 运行后显示实际请求完成速度`;
  }
}

function updateSpeedModeUI() {
  if (!processingSpeed) return;
  if (DOM.speedModeButtons) DOM.speedModeButtons.forEach(button => {
    const siteKey = normalizeSpeedSite(button.dataset.speedSite);
    const profile = processingSpeed.getSiteProfile(siteKey, speedModeForSite(siteKey));
    const active = button.dataset.speedMode === profile.key;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.disabled = state.isProcessing;
  });
  if (DOM.speedModeBadges) DOM.speedModeBadges.forEach(badge => {
    const siteKey = normalizeSpeedSite(badge.dataset.speedBadge);
    badge.textContent = processingSpeed.getSiteProfile(siteKey, speedModeForSite(siteKey)).badge;
  });
  if (DOM.speedModeDescriptions) DOM.speedModeDescriptions.forEach(description => {
    const siteKey = normalizeSpeedSite(description.dataset.speedDescription);
    description.textContent = speedDescription(siteKey, processingSpeed.getSiteProfile(siteKey, speedModeForSite(siteKey)));
  });
  if (DOM.av123SpeedPolicy) {
    DOM.av123SpeedPolicy.value = state.av123SpeedPolicy;
    DOM.av123SpeedPolicy.disabled = state.isProcessing;
  }
  if (DOM.missavSpeedPolicy) {
    DOM.missavSpeedPolicy.value = state.missavSpeedPolicy;
    DOM.missavSpeedPolicy.disabled = state.isProcessing;
  }
  updateSiteRateUI('missav');
  updateSiteRateUI('av123');
  const favoriteMethod = normalize123AvFavoriteMethod(state.av123FavoriteMethod);
  const chromeMethod = favoriteMethod === 'chrome';
  const appMethod = favoriteMethod === 'app';
  const exportMethod = favoriteMethod === 'export';
  DOM.favoriteMethodButtons?.forEach(button => {
    const active = button.dataset.av123FavoriteMethod === favoriteMethod;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.disabled = Boolean(state.favoriteRuntime?.running);
  });
  if (DOM.siteAv123AccountControl) DOM.siteAv123AccountControl.hidden = exportMethod;
  if (DOM.chromeFavoriteBridgePanel) DOM.chromeFavoriteBridgePanel.hidden = !chromeMethod;
  if (DOM.appFavoriteStabilityPanel) DOM.appFavoriteStabilityPanel.hidden = !appMethod;
  if (DOM.favoriteExportPanel) DOM.favoriteExportPanel.hidden = !exportMethod;
  if (DOM.favoriteSpeedPanel) DOM.favoriteSpeedPanel.hidden = !chromeMethod;
  if (DOM.favoriteAutoTogglePanel) DOM.favoriteAutoTogglePanel.hidden = exportMethod;
  if (DOM.favoriteRuntimePanel) DOM.favoriteRuntimePanel.hidden = exportMethod && !state.favoriteRuntime?.running;
  DOM.favoriteConcurrencyButtons?.forEach(button => {
    const active = Number(button.dataset.favoriteConcurrency) === state.av123FavoriteConcurrency;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.disabled = Boolean(state.favoriteRuntime?.running);
  });
  if (DOM.favoriteSpeedDescription) {
    DOM.favoriteSpeedDescription.textContent = '123AV 收藏固定单路执行；MissAV 与以后其他网站使用各自独立队列，可以同时工作。同一网站异常不会暂停其他网站。';
  }
  if (DOM.av123AutoFavorite) {
    DOM.av123AutoFavorite.checked = state.av123AutoFavorite;
    DOM.av123AutoFavorite.disabled = exportMethod || Boolean(state.favoriteRuntime?.running) || (state.isProcessing && state.activeLookupSite === 'av123');
  }
  const openLabel = appMethod ? '打开 APP 账号窗口' : '打开本地 Chrome';
  const checkLabel = appMethod ? '检查 APP 登录' : '检查登录';
  [DOM.btnOpen123AvAccountSite, DOM.btnOpen123AvAccount].forEach(button => {
    const span = button?.querySelector('span');
    if (span) span.textContent = openLabel;
  });
  [DOM.btnCheck123AvAccountSite, DOM.btnCheck123AvAccount].forEach(button => {
    const span = button?.querySelector('span');
    if (span) span.textContent = checkLabel;
  });
  [DOM.btnPrepareChromeFavoriteSite, DOM.btnPrepareChromeFavorite].forEach(button => {
    if (button) button.hidden = !chromeMethod;
  });
  if (DOM.btnOpen123AvAccountSite) DOM.btnOpen123AvAccountSite.hidden = exportMethod;
  if (DOM.btnCheck123AvAccountSite) DOM.btnCheck123AvAccountSite.hidden = exportMethod;
}

// ─── 事件绑定 ────────────────────────────────────────
function bindEvents() {
  DOM.btnSelectOutputDir.addEventListener('click', selectOutputDir);
  if (DOM.btnSelectOutputDirMirror) DOM.btnSelectOutputDirMirror.addEventListener('click', selectOutputDir);
  if (DOM.btnOpenDbLocation) DOM.btnOpenDbLocation.addEventListener('click', openDatabaseLocation);
  if (DOM.btnChangeDbLocation) DOM.btnChangeDbLocation.addEventListener('click', changeDatabaseLocation);
  if (DOM.btnSelectTagFile) DOM.btnSelectTagFile.addEventListener('click', importCSVToDb);
  DOM.btnStartMissav.addEventListener('click', () => startSiteProcessing('missav'));
  DOM.btnStopMissav.addEventListener('click', stopProcessing);
  DOM.btnStart123Av.addEventListener('click', () => startSiteProcessing('av123'));
  DOM.btnStop123Av.addEventListener('click', stopProcessing);
  if (DOM.btnResumeMissavBatch) DOM.btnResumeMissavBatch.addEventListener('click', () => resumeProcessingRun(Number(DOM.btnResumeMissavBatch.dataset.runId || 0), 'missav'));
  if (DOM.btnResume123AvBatch) DOM.btnResume123AvBatch.addEventListener('click', () => resumeProcessingRun(Number(DOM.btnResume123AvBatch.dataset.runId || 0), 'av123'));
  if (DOM.btnDeleteResumableBatch) DOM.btnDeleteResumableBatch.addEventListener('click', () => requestDeleteProcessingRun(Number(DOM.btnDeleteResumableBatch.dataset.runId || 0)));
  if (DOM.speedModeButtons) DOM.speedModeButtons.forEach(button => button.addEventListener('click', () => setSpeedMode(button.dataset.speedSite, button.dataset.speedMode)));
  if (DOM.missavSpeedPolicy) DOM.missavSpeedPolicy.addEventListener('change', () => setMissavSpeedPolicy(DOM.missavSpeedPolicy.value));
  if (DOM.av123SpeedPolicy) DOM.av123SpeedPolicy.addEventListener('change', () => set123AvSpeedPolicy(DOM.av123SpeedPolicy.value));
  if (DOM.missavRateMode) DOM.missavRateMode.addEventListener('change', () => setSiteRateMode('missav', DOM.missavRateMode.value));
  if (DOM.missavRateCap) {
    DOM.missavRateCap.addEventListener('input', () => {
      if (DOM.missavRateCapValue) DOM.missavRateCapValue.textContent = `${Number(DOM.missavRateCap.value).toFixed(0)} 请求/秒`;
    });
    DOM.missavRateCap.addEventListener('change', () => setSiteRateCap('missav', DOM.missavRateCap.value));
  }
  DOM.missavRateCapButtons?.forEach(button => button.addEventListener('click', () => setSiteRateCap('missav', button.dataset.missavRateCap)));
  if (DOM.av123RateMode) DOM.av123RateMode.addEventListener('change', () => set123AvRateMode(DOM.av123RateMode.value));
  if (DOM.av123RateCap) {
    DOM.av123RateCap.addEventListener('input', () => {
      if (DOM.av123RateCapValue) DOM.av123RateCapValue.textContent = `${Number(DOM.av123RateCap.value).toFixed(0)} 请求/秒`;
    });
    DOM.av123RateCap.addEventListener('change', () => set123AvRateCap(DOM.av123RateCap.value));
  }
  DOM.av123RateCapButtons?.forEach(button => button.addEventListener('click', () => set123AvRateCap(button.dataset.av123RateCap)));
  DOM.siteWorkspaceButtons?.forEach(button => button.addEventListener('click', () => switchSiteWorkspace(button.dataset.siteWorkspace)));
  DOM.av123SiteTabButtons?.forEach(button => button.addEventListener('click', () => switch123AvSiteTab(button.dataset.av123SiteTab)));
  DOM.favoriteMethodButtons?.forEach(button => button.addEventListener('click', () => set123AvFavoriteMethod(button.dataset.av123FavoriteMethod)));
  DOM.favoriteConcurrencyButtons?.forEach(button => button.addEventListener('click', () => set123AvFavoriteConcurrency(button.dataset.favoriteConcurrency)));
  if (DOM.av123AutoFavorite) DOM.av123AutoFavorite.addEventListener('change', () => set123AvAutoFavorite(DOM.av123AutoFavorite.checked));
  if (DOM.btnOpen123AvAccountSite) DOM.btnOpen123AvAccountSite.addEventListener('click', open123AvAccountWindow);
  if (DOM.btnCheck123AvAccountSite) DOM.btnCheck123AvAccountSite.addEventListener('click', () => check123AvAccountStatus());
  if (DOM.btnPrepareChromeFavoriteSite) DOM.btnPrepareChromeFavoriteSite.addEventListener('click', prepareChromeFavoriteExtension);
  if (DOM.btnCopyChromePairing) DOM.btnCopyChromePairing.addEventListener('click', copyChromeFavoritePairingCode);
  if (DOM.btnExport123AvFavoriteSite) DOM.btnExport123AvFavoriteSite.addEventListener('click', () => export123AvFavoriteIndexes(favoriteActionIndexes(['ready', 'network_error', 'manual', 'not_logged_in', 'failed', 'verify_required'])));
  if (DOM.btnStop123AvFavoriteSite) DOM.btnStop123AvFavoriteSite.addEventListener('click', stop123AvFavorite);
  DOM.btnClearInput.addEventListener('click', clearAll);
  DOM.btnPasteSample.addEventListener('click', pasteSample);
  if (DOM.btnOpenSitesFromInput) DOM.btnOpenSitesFromInput.addEventListener('click', () => switchPage('sites'));
  DOM.btnImportTextFile.addEventListener('click', importTextFiles);
  if (DOM.btnCopyCodes) DOM.btnCopyCodes.addEventListener('click', copyParsedCodes);
  if (DOM.btnExportCodeList) DOM.btnExportCodeList.addEventListener('click', exportCodeList);
  DOM.pageButtons.forEach(btn => btn.addEventListener('click', () => {
    if (btn.dataset.tool) switchTool(btn.dataset.tool);
    else switchPage(btn.dataset.page);
  }));
  if (DOM.btnBackToolHome) DOM.btnBackToolHome.addEventListener('click', () => switchPage('home'));
  document.addEventListener('click', event => {
    const toolButton = event.target.closest('[data-open-tool]');
    if (toolButton) {
      switchTool(toolButton.dataset.openTool);
      if (toolButton.dataset.openStage) switchPage(toolButton.dataset.openStage);
      return;
    }
    const pageTarget = event.target.closest('[data-page-target]');
    if (pageTarget) switchPage(pageTarget.dataset.pageTarget);
  });
  if (DOM.twitterGroupBinding) DOM.twitterGroupBinding.addEventListener('change', () => setToolboxBinding('twitter', DOM.twitterGroupBinding.value));
  if (DOM.badnewsGroupBinding) DOM.badnewsGroupBinding.addEventListener('change', () => setToolboxBinding('badnews', DOM.badnewsGroupBinding.value));
  if (DOM.avGroupBinding) DOM.avGroupBinding.addEventListener('change', () => setToolboxBinding(state.activeAvTool, DOM.avGroupBinding.value));
  if (DOM.twitterRawInput) DOM.twitterRawInput.addEventListener('input', () => runSimpleToolFilter('twitter'));
  if (DOM.badnewsRawInput) DOM.badnewsRawInput.addEventListener('input', () => runSimpleToolFilter('badnews'));
  [DOM.twitterTimeStart, DOM.twitterTimeEnd].forEach(input => input?.addEventListener('change', () => runSimpleToolFilter('twitter')));
  [DOM.badnewsTimeStart, DOM.badnewsTimeEnd].forEach(input => input?.addEventListener('change', () => runSimpleToolFilter('badnews')));
  if (DOM.avTimeStart) DOM.avTimeStart.addEventListener('change', saveActiveAvToolSession);
  if (DOM.avTimeEnd) DOM.avTimeEnd.addEventListener('change', saveActiveAvToolSession);
  if (DOM.btnTwitterSyncGroup) DOM.btnTwitterSyncGroup.addEventListener('click', () => syncToolboxBinding('twitter'));
  if (DOM.btnBadnewsSyncGroup) DOM.btnBadnewsSyncGroup.addEventListener('click', () => syncToolboxBinding('badnews'));
  if (DOM.btnAvSyncGroup) DOM.btnAvSyncGroup.addEventListener('click', () => syncToolboxBinding(state.activeAvTool));
  if (DOM.btnTwitterImportFiles) DOM.btnTwitterImportFiles.addEventListener('click', () => importSimpleToolFiles('twitter'));
  if (DOM.btnBadnewsImportFiles) DOM.btnBadnewsImportFiles.addEventListener('click', () => importSimpleToolFiles('badnews'));
  if (DOM.btnTwitterFilter) DOM.btnTwitterFilter.addEventListener('click', () => runSimpleToolFilter('twitter'));
  if (DOM.btnBadnewsFilter) DOM.btnBadnewsFilter.addEventListener('click', () => runSimpleToolFilter('badnews'));
  if (DOM.btnTwitterClear) DOM.btnTwitterClear.addEventListener('click', () => clearSimpleTool('twitter'));
  if (DOM.btnBadnewsClear) DOM.btnBadnewsClear.addEventListener('click', () => clearSimpleTool('badnews'));
  if (DOM.btnCopyTwitterNames) DOM.btnCopyTwitterNames.addEventListener('click', () => copyToolboxText(DOM.twitterNamesOutput?.value, '博主名'));
  if (DOM.btnCopyTwitterUrls) DOM.btnCopyTwitterUrls.addEventListener('click', () => copyToolboxText(DOM.twitterUrlsOutput?.value, '主页链接'));
  if (DOM.btnCopyBadnewsUrls) DOM.btnCopyBadnewsUrls.addEventListener('click', () => copyToolboxText(DOM.badnewsUrlsOutput?.value, 'Bad.news 链接'));
  if (DOM.btnSaveTwitterResults) DOM.btnSaveTwitterResults.addEventListener('click', saveTwitterToolResults);
  if (DOM.btnSaveBadnewsResults) DOM.btnSaveBadnewsResults.addEventListener('click', saveBadnewsToolResults);
  DOM.telegramPanelButtons?.forEach(button => button.addEventListener('click', () => switchTelegramPanel(button.dataset.telegramPanel)));
  if (DOM.btnTelegramBotConnect) DOM.btnTelegramBotConnect.addEventListener('click', connectTelegramBot);
  if (DOM.btnTelegramBotConnectStored) DOM.btnTelegramBotConnectStored.addEventListener('click', () => connectStoredTelegramBot());
  if (DOM.btnTelegramBotClear) DOM.btnTelegramBotClear.addEventListener('click', clearTelegramBot);
  if (DOM.btnTelegramBotFather) DOM.btnTelegramBotFather.addEventListener('click', () => api.openExternal('https://t.me/BotFather'));
  if (DOM.btnTelegramBotDiscover) DOM.btnTelegramBotDiscover.addEventListener('click', discoverTelegramBotGroups);
  if (DOM.btnTelegramBotSaveGroups) DOM.btnTelegramBotSaveGroups.addEventListener('click', saveTelegramBotGroupSources);
  if (DOM.telegramBotGroupSearch) DOM.telegramBotGroupSearch.addEventListener('input', renderTelegramBotGroups);
  if (DOM.telegramBotGroupPicker) DOM.telegramBotGroupPicker.addEventListener('change', handleTelegramBotGroupSelection);
  if (DOM.btnTelegramBotSync) DOM.btnTelegramBotSync.addEventListener('click', syncTelegramBotGroups);
  if (DOM.btnTelegramBotStopSync) DOM.btnTelegramBotStopSync.addEventListener('click', stopTelegramBotGroups);
  if (DOM.btnTelegramStartQrAuth) DOM.btnTelegramStartQrAuth.addEventListener('click', startTelegramQrAuthorization);
  if (DOM.btnTelegramStartAuth) DOM.btnTelegramStartAuth.addEventListener('click', startTelegramAuthorization);
  if (DOM.btnTelegramApiDocs) DOM.btnTelegramApiDocs.addEventListener('click', () => api.openExternal('https://my.telegram.org/apps'));
  if (DOM.btnTelegramConnectStored) DOM.btnTelegramConnectStored.addEventListener('click', connectStoredTelegram);
  if (DOM.btnTelegramLogout) DOM.btnTelegramLogout.addEventListener('click', logoutTelegram);
  if (DOM.btnTelegramSubmitAuth) DOM.btnTelegramSubmitAuth.addEventListener('click', submitTelegramAuthorization);
  if (DOM.btnTelegramCancelAuth) DOM.btnTelegramCancelAuth.addEventListener('click', cancelTelegramAuthorization);
  if (DOM.btnTelegramCancelQr) DOM.btnTelegramCancelQr.addEventListener('click', cancelTelegramAuthorization);
  if (DOM.btnTelegramLoadGroups) DOM.btnTelegramLoadGroups.addEventListener('click', () => loadTelegramGroups());
  if (DOM.btnTelegramSaveGroups) DOM.btnTelegramSaveGroups.addEventListener('click', saveTelegramGroupSources);
  if (DOM.telegramGroupSearch) DOM.telegramGroupSearch.addEventListener('input', renderTelegramGroups);
  if (DOM.telegramGroupPicker) DOM.telegramGroupPicker.addEventListener('change', handleTelegramGroupSelection);
  if (DOM.telegramSelectedSources) DOM.telegramSelectedSources.addEventListener('click', event => {
    const button = event.target.closest('[data-telegram-sync-group]');
    if (button) void syncTelegramGroups([decodeURIComponent(button.dataset.telegramSyncGroup || '')]);
  });
  if (DOM.telegramAuthValue) DOM.telegramAuthValue.addEventListener('keydown', event => {
    if (event.key === 'Enter') void submitTelegramAuthorization();
  });
  if (DOM.btnTelegramSync) DOM.btnTelegramSync.addEventListener('click', () => syncTelegramGroups());
  if (DOM.btnTelegramStopSync) DOM.btnTelegramStopSync.addEventListener('click', stopTelegramGroups);
  if (DOM.btnTelegramImportFiles) DOM.btnTelegramImportFiles.addEventListener('click', importTelegramExportFiles);
  if (DOM.btnTelegramImportDirectory) DOM.btnTelegramImportDirectory.addEventListener('click', importTelegramExportDirectory);
  if (DOM.btnTelegramUseCodes) DOM.btnTelegramUseCodes.addEventListener('click', useTelegramCodes);
  if (DOM.btnSaveRaindropToken) DOM.btnSaveRaindropToken.addEventListener('click', saveRaindropToken);
  if (DOM.btnTestRaindropAccount) DOM.btnTestRaindropAccount.addEventListener('click', () => testRaindropAccount());
  if (DOM.btnClearRaindropToken) DOM.btnClearRaindropToken.addEventListener('click', clearRaindropToken);
  if (DOM.btnOpenRaindropTokenDocs) DOM.btnOpenRaindropTokenDocs.addEventListener('click', () => api.openExternal('https://developer.raindrop.io/v1/authentication/token'));
  if (DOM.btnRefreshRaindropCollections) DOM.btnRefreshRaindropCollections.addEventListener('click', () => loadRaindropCollections({ force: true }));
  if (DOM.raindropBatchSelect) DOM.raindropBatchSelect.addEventListener('change', () => selectRaindropRun(DOM.raindropBatchSelect.value));
  if (DOM.raindropCollectionSelect) DOM.raindropCollectionSelect.addEventListener('change', selectRaindropCollection);
  if (DOM.btnPreviewRaindropSync) DOM.btnPreviewRaindropSync.addEventListener('click', () => buildRaindropSyncPlan({ checkRemote: true }));
  if (DOM.btnStartRaindropSync) DOM.btnStartRaindropSync.addEventListener('click', startRaindropSync);
  if (DOM.btnStopRaindropSync) DOM.btnStopRaindropSync.addEventListener('click', stopRaindropSync);
  if (DOM.btnToggleRaindropPreviewSize) DOM.btnToggleRaindropPreviewSize.addEventListener('click', () => setRaindropPreviewExpanded(!state.raindropSync.previewExpanded));
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

  if (DOM.resultTabs) DOM.resultTabs.addEventListener('click', event => {
    const button = event.target.closest('[data-tab]');
    if (button) switchTab(button.dataset.tab);
  });
  if (DOM.resultWorkspaceButtons) DOM.resultWorkspaceButtons.forEach(button => button.addEventListener('click', () => switchResultWorkspace(button.dataset.resultWorkspace)));
  if (DOM.btnOpen123AvAccount) DOM.btnOpen123AvAccount.addEventListener('click', open123AvAccountWindow);
  if (DOM.btnCheck123AvAccount) DOM.btnCheck123AvAccount.addEventListener('click', check123AvAccountStatus);
  if (DOM.btnPrepareChromeFavorite) DOM.btnPrepareChromeFavorite.addEventListener('click', prepareChromeFavoriteExtension);

  DOM.btnExportAll.addEventListener('click', exportAll);
  DOM.btnExportCurrent.addEventListener('click', exportCurrentScope);
  DOM.btnExportByTags.addEventListener('click', exportByTags);
  DOM.btnExportHTML.addEventListener('click', exportHTMLOnly);
  DOM.btnExportCSV.addEventListener('click', exportCSVOnly);
  DOM.btnOpenFolder.addEventListener('click', openOutputFolder);
  DOM.resultBody.addEventListener('click', handleResultTableClick);
  DOM.resultTable.addEventListener('click', handleResultHeaderClick);
  DOM.resultSearch.addEventListener('input', debounce(renderTable, 160));
  DOM.resultStatusFilter.addEventListener('change', () => {
    state.resultStatusByWorkspace[state.resultWorkspace] = DOM.resultStatusFilter.value;
    renderTable();
  });
  if (DOM.resultStageFilter) DOM.resultStageFilter.addEventListener('change', () => {
    state.resultStageByWorkspace[state.resultWorkspace] = DOM.resultStageFilter.value;
    renderTable();
  });
  DOM.resultTagFilter.addEventListener('change', renderTable);
  DOM.resultSort.addEventListener('change', () => {
    state.resultSortByWorkspace[state.resultWorkspace] = DOM.resultSort.value;
    renderTable();
  });
  DOM.resultTable.addEventListener('change', event => {
    if (event.target.id === 'resultSelectVisible') toggleVisibleResultSelection();
  });
  DOM.btnSelectVisibleResults.addEventListener('click', selectVisibleResults);
  DOM.btnClearResultSelection.addEventListener('click', clearResultSelection);
  DOM.btnCopyResultTSV.addEventListener('click', copyResultTSV);
  DOM.btnRetrySelectedResults.addEventListener('click', () => retryNetworkErrorsForStage([...state.resultSelected]));
  DOM.btnRetryAllNetworkResults.addEventListener('click', () => retryNetworkErrorsForStage(networkErrorIndexesForStage()));
  DOM.btnStopResults.addEventListener('click', stopProcessing);
  if (DOM.btnDeleteCurrentRun) DOM.btnDeleteCurrentRun.addEventListener('click', () => requestDeleteProcessingRun(Number(DOM.btnDeleteCurrentRun.dataset.runId || 0)));
  if (DOM.btnFavoriteSelected123Av) DOM.btnFavoriteSelected123Av.addEventListener('click', () => run123AvFavoriteIndexes([...state.resultSelected]));
  if (DOM.btnFavoriteAll123Av) DOM.btnFavoriteAll123Av.addEventListener('click', () => run123AvFavoriteIndexes(favoriteActionIndexes(['ready'])));
  if (DOM.btnVerifySelected123Av) DOM.btnVerifySelected123Av.addEventListener('click', () => run123AvFavoriteIndexes([...state.resultSelected], { verifyOnly: true }));
  if (DOM.btnVerifyAll123Av) DOM.btnVerifyAll123Av.addEventListener('click', () => run123AvFavoriteIndexes(favoriteActionIndexes(['verify_required']), { verifyOnly: true }));
  if (DOM.btnStop123AvFavorite) DOM.btnStop123AvFavorite.addEventListener('click', stop123AvFavorite);
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

  DOM.codeInput.addEventListener('input', () => {
    if (!state.isProcessing) state.preparedRunId = null;
    parseInputCodes('手动输入');
    saveActiveAvToolSession();
    updateUI();
  });

  $('#btnHistory').addEventListener('click', () => { switchPage('library'); switchLibraryTab('runs'); });
  $('#btnCloseHistory').addEventListener('click', () => { DOM.modalHistory.style.display = 'none'; });
  $('#btnHelp').addEventListener('click', () => { DOM.modalHelp.style.display = 'flex'; });
  $('#btnCloseHelp').addEventListener('click', () => { DOM.modalHelp.style.display = 'none'; });
  $('#btnSettings').addEventListener('click', () => switchPage('settings'));
  const closeLibraryBtn = $('#btnCloseLibrary');
  if (closeLibraryBtn && DOM.modalLibrary) closeLibraryBtn.addEventListener('click', () => { DOM.modalLibrary.style.display = 'none'; });
  $('#btnRefreshLibrary').addEventListener('click', refreshLibrary);
  const btnExportDbCSV = $('#btnExportDbCSV');
  if (btnExportDbCSV) btnExportDbCSV.addEventListener('click', exportDbCSVFromLibrary);
  DOM.librarySearch.addEventListener('input', debounce(refreshLibrary, 250));
  $$('.library-tabs .tab-btn').forEach(btn => btn.addEventListener('click', () => switchLibraryTab(btn.dataset.libraryTab)));
  DOM.libraryContent.addEventListener('click', handleLibraryAction);
  DOM.libraryContent.addEventListener('change', handleLibraryChange);
  DOM.libraryContent.addEventListener('input', handleLibraryInput);
  DOM.libraryContent.addEventListener('keydown', handleLibraryKeydown);
  DOM.libraryContent.addEventListener('focusout', handleLibraryFocusOut);
  DOM.libraryContent.addEventListener('contextmenu', handleLibraryContextMenu);
  document.addEventListener('click', event => { if (!event.target.closest('.collection-context-menu')) closeCollectionContextMenu(); });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    closeCollectionContextMenu();
    if (state.raindropSync.previewExpanded) setRaindropPreviewExpanded(false);
  });
  DOM.modalHistory.addEventListener('click', e => { if (e.target === DOM.modalHistory) DOM.modalHistory.style.display = 'none'; });
  DOM.modalHelp.addEventListener('click', e => { if (e.target === DOM.modalHelp) DOM.modalHelp.style.display = 'none'; });
  if (DOM.modalLibrary) DOM.modalLibrary.addEventListener('click', e => { if (e.target === DOM.modalLibrary) DOM.modalLibrary.style.display = 'none'; });
}

// ─── Telegram 消息来源 ───────────────────────────────
function setupTelegramEvents() {
  api.onTelegramState?.(next => {
    const becameReady = next?.status === 'ready' && state.telegram.auth.status !== 'ready';
    state.telegram.auth = { ...state.telegram.auth, ...(next || {}) };
    renderTelegramSource();
    if (becameReady && state.activePage === 'sources' && state.telegram.panel === 'api'
      && !state.telegram.availableGroups.length && !state.telegram.groupsLoading) {
      void loadTelegramGroups({ silent: true });
    }
  });
  api.onTelegramProgress?.(progress => {
    state.telegram.progress = { ...state.telegram.progress, ...(progress || {}) };
    renderTelegramSource();
  });
}

function switchTelegramPanel(panel) {
  state.telegram.panel = ['bot', 'api', 'export'].includes(panel) ? panel : 'bot';
  DOM.telegramPanelButtons?.forEach(button => {
    const active = button.dataset.telegramPanel === state.telegram.panel;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  DOM.telegramPanelContents?.forEach(content => {
    const active = content.dataset.telegramPanelContent === state.telegram.panel;
    content.classList.toggle('active', active);
    content.hidden = !active;
  });
  renderTelegramSource();
}

function telegramAuthKind(status) {
  const match = String(status || '').match(/^waiting_(code|password|email|email_code|recaptcha)$/);
  return match?.[1] || '';
}

function telegramAuthLabel(kind, hint = '') {
  const labels = {
    code: 'Telegram 验证码',
    password: '两步验证密码',
    email: '邮箱地址',
    email_code: '邮箱验证码',
    recaptcha: 'reCAPTCHA 验证结果',
  };
  return [labels[kind] || '授权信息', String(hint || '').trim()].filter(Boolean).join(' · ');
}

function telegramStatusText(auth) {
  const labels = {
    disconnected: auth.configured ? '会话已保存，尚未连接' : '未配置',
    connecting: '正在连接',
    waiting_qr: '等待手机扫码确认',
    authorizing: '正在验证',
    ready: `已连接${auth.accountLabel ? ` · ${auth.accountLabel}` : ''}`,
    listing_groups: '正在加载群组',
    syncing: `正在读取${auth.accountLabel ? ` · ${auth.accountLabel}` : ''}`,
    expired: '会话已失效',
    error: '连接异常',
  };
  if (telegramAuthKind(auth.status)) return telegramAuthLabel(telegramAuthKind(auth.status), auth.hint);
  return labels[auth.status] || String(auth.status || '未连接');
}

function telegramBotStatusText(auth) {
  const labels = {
    disconnected: auth.configured ? '机器人已保存，尚未连接' : '未配置机器人',
    connecting: '正在连接机器人',
    ready: `机器人已连接${auth.accountLabel ? ` · ${auth.accountLabel}` : ''}`,
    error: '机器人连接异常',
  };
  return labels[auth.status] || String(auth.status || '未连接');
}

function telegramAnyRunning() {
  return Boolean(state.telegram.running || state.telegram.bot.running);
}

function renderTelegramBotSource() {
  const bot = state.telegram.bot;
  const auth = bot.auth || {};
  const ready = auth.status === 'ready' && auth.connected;
  const busy = auth.status === 'connecting' || bot.groupsLoading || telegramAnyRunning();
  const statusText = telegramBotStatusText(auth);
  if (DOM.telegramBotAccountSummary) {
    const details = [statusText];
    if (auth.error) details.push(auth.error);
    if (auth.encryptionAvailable === false) details.push('Windows 安全存储不可用');
    DOM.telegramBotAccountSummary.textContent = details.join(' · ');
  }
  if (DOM.telegramBotToken) {
    DOM.telegramBotToken.disabled = busy || ready;
    DOM.telegramBotToken.placeholder = auth.configured ? '已安全保存，可留空' : '从 @BotFather 复制，只需填写一次';
  }
  if (DOM.btnTelegramBotConnect) DOM.btnTelegramBotConnect.disabled = busy || ready;
  if (DOM.btnTelegramBotConnectStored) DOM.btnTelegramBotConnectStored.disabled = busy || !auth.configured;
  if (DOM.btnTelegramBotClear) DOM.btnTelegramBotClear.disabled = busy || !auth.configured;
  if (DOM.btnTelegramBotDiscover) DOM.btnTelegramBotDiscover.disabled = !ready || busy;
  if (DOM.btnTelegramBotSaveGroups) {
    DOM.btnTelegramBotSaveGroups.disabled = !ready || busy || !bot.availableGroups.length;
  }
  if (DOM.telegramBotGroupSearch) DOM.telegramBotGroupSearch.disabled = !ready || bot.groupsLoading;
  if (DOM.btnTelegramBotSync) DOM.btnTelegramBotSync.disabled = !ready || telegramAnyRunning() || !bot.groupSources.length;
  if (DOM.btnTelegramBotStopSync) DOM.btnTelegramBotStopSync.hidden = !bot.running;
  if (DOM.telegramBotSyncLimit) DOM.telegramBotSyncLimit.disabled = bot.running;
  if (DOM.telegramBotSyncProgress) {
    DOM.telegramBotSyncProgress.textContent = bot.running
      ? `已接收 ${Number(bot.progress.fetched || 0)} / 最多 ${Number(bot.progress.limit || 0)} 条更新`
      : ready
        ? bot.groupSources.length
          ? `已绑定 ${bot.groupSources.length} 个机器人来源；点击后手动增量同步`
          : '请先在群里发送识别消息，再发现并保存来源'
        : statusText;
  }
  renderTelegramBotGroups();
}

function renderTelegramSource() {
  const auth = state.telegram.auth;
  const kind = telegramAuthKind(auth.status);
  state.telegram.authKind = kind;
  const waitingQr = auth.status === 'waiting_qr';
  const busyAuth = ['connecting', 'waiting_qr', 'authorizing', 'listing_groups'].includes(auth.status) || Boolean(kind);
  const ready = ['ready', 'syncing', 'listing_groups'].includes(auth.status);
  const statusText = telegramStatusText(auth);
  if (DOM.telegramSourceStateBadge) {
    DOM.telegramSourceStateBadge.textContent = state.telegram.panel === 'bot'
      ? telegramBotStatusText(state.telegram.bot.auth)
      : state.telegram.panel === 'export'
        ? '官方导出文件'
        : statusText;
  }
  if (DOM.telegramAccountSummary) {
    const details = [statusText];
    if (auth.error) details.push(auth.error);
    if (auth.waitSeconds) details.push(`需等待 ${auth.waitSeconds} 秒`);
    if (auth.encryptionAvailable === false) details.push('Windows 安全存储不可用');
    DOM.telegramAccountSummary.textContent = details.join(' · ');
  }
  if (DOM.btnTelegramStartQrAuth) DOM.btnTelegramStartQrAuth.disabled = busyAuth || ready || telegramAnyRunning();
  if (DOM.btnTelegramStartAuth) DOM.btnTelegramStartAuth.disabled = busyAuth || ready || telegramAnyRunning();
  if (DOM.btnTelegramConnectStored) DOM.btnTelegramConnectStored.disabled = busyAuth || telegramAnyRunning() || !auth.configured;
  if (DOM.btnTelegramLogout) DOM.btnTelegramLogout.disabled = busyAuth || telegramAnyRunning() || !auth.configured;
  if (DOM.telegramApiId) {
    DOM.telegramApiId.disabled = busyAuth || ready || telegramAnyRunning();
    DOM.telegramApiId.placeholder = auth.configured ? '已安全保存，可留空' : '例如 12345678';
  }
  if (DOM.telegramApiHash) {
    DOM.telegramApiHash.disabled = busyAuth || ready || telegramAnyRunning();
    DOM.telegramApiHash.placeholder = auth.configured ? '已安全保存，可留空' : '32 位字符串';
  }
  if (DOM.telegramPhone) DOM.telegramPhone.disabled = busyAuth || ready || telegramAnyRunning();
  if (DOM.telegramQrLogin) DOM.telegramQrLogin.hidden = !waitingQr;
  if (DOM.telegramQrImage) {
    if (waitingQr && auth.qrDataUrl) DOM.telegramQrImage.src = auth.qrDataUrl;
    else DOM.telegramQrImage.removeAttribute('src');
  }
  updateTelegramQrCountdown();
  if (DOM.telegramAuthChallenge) DOM.telegramAuthChallenge.hidden = !kind;
  if (kind && DOM.telegramAuthPrompt) {
    DOM.telegramAuthPrompt.textContent = kind === 'recaptcha'
      ? 'Telegram 要求官方客户端级 reCAPTCHA；当前 APP 无法安全代填。请取消授权并改用“官方导出文件”，或稍后换网络重试。'
      : telegramAuthLabel(kind, auth.hint);
  }
  if (kind && DOM.telegramAuthValue) {
    DOM.telegramAuthValue.closest('label').hidden = kind === 'recaptcha';
    if (DOM.btnTelegramSubmitAuth) DOM.btnTelegramSubmitAuth.hidden = kind === 'recaptcha';
    DOM.telegramAuthValue.type = kind === 'password' ? 'password' : kind === 'email' ? 'email' : 'text';
    DOM.telegramAuthValue.autocomplete = kind === 'password' ? 'current-password' : kind.includes('code') ? 'one-time-code' : 'off';
    if (kind !== 'recaptcha' && document.activeElement !== DOM.telegramAuthValue) DOM.telegramAuthValue.focus();
  } else {
    if (DOM.telegramAuthValue) DOM.telegramAuthValue.closest('label').hidden = false;
    if (DOM.btnTelegramSubmitAuth) DOM.btnTelegramSubmitAuth.hidden = false;
  }
  if (DOM.btnTelegramLoadGroups) DOM.btnTelegramLoadGroups.disabled = !ready || telegramAnyRunning() || state.telegram.groupsLoading;
  if (DOM.btnTelegramSaveGroups) {
    DOM.btnTelegramSaveGroups.disabled = !ready || telegramAnyRunning() || state.telegram.groupsLoading || !state.telegram.availableGroups.length;
  }
  if (DOM.telegramGroupSearch) DOM.telegramGroupSearch.disabled = !ready || state.telegram.groupsLoading;
  if (DOM.btnTelegramSync) DOM.btnTelegramSync.disabled = !ready || telegramAnyRunning() || !state.telegram.groupSources.length;
  if (DOM.btnTelegramStopSync) DOM.btnTelegramStopSync.hidden = !state.telegram.running;
  if (DOM.telegramSyncLimit) DOM.telegramSyncLimit.disabled = state.telegram.running;
  if (DOM.telegramSyncSince) DOM.telegramSyncSince.disabled = state.telegram.running;
  if (DOM.telegramSyncLookback) DOM.telegramSyncLookback.disabled = state.telegram.running;
  if (DOM.telegramSyncProgress) {
    DOM.telegramSyncProgress.textContent = state.telegram.running
      ? `${state.telegram.progress.groupTitle || '当前群组'}（${Number(state.telegram.progress.groupIndex || 1)}/${Number(state.telegram.progress.groupTotal || 1)}）· 已读取 ${Number(state.telegram.progress.fetched || 0)} / 最多 ${Number(state.telegram.progress.limit || 0)} 条`
      : ready
        ? state.telegram.groupSources.length
          ? `已绑定 ${state.telegram.groupSources.length} 个来源；默认只读取绑定后的新增消息`
          : '请先加载群组并保存最多 5 个增量来源'
        : statusText;
  }
  const preview = state.telegram.preview;
  if (DOM.telegramMetricMessages) DOM.telegramMetricMessages.textContent = String(preview.messageCount || 0);
  if (DOM.telegramMetricNew) DOM.telegramMetricNew.textContent = String(preview.newMessageCount || 0);
  if (DOM.telegramMetricDuplicate) DOM.telegramMetricDuplicate.textContent = String(preview.duplicateMessageCount || 0);
  if (DOM.telegramMetricUpdated) DOM.telegramMetricUpdated.textContent = String(preview.updatedMessageCount || 0);
  if (DOM.telegramMetricCodes) DOM.telegramMetricCodes.textContent = String(preview.codes?.length || 0);
  if (DOM.telegramCodePreview) DOM.telegramCodePreview.value = (preview.codes || []).join('\n');
  if (DOM.btnTelegramUseCodes) DOM.btnTelegramUseCodes.disabled = !(preview.codes || []).length;
  renderTelegramBotSource();
  renderTelegramGroups();
  renderTelegramHistory();
  refreshToolboxGroupOptions();
}

function updateTelegramQrCountdown() {
  if (!DOM.telegramQrCountdown || state.telegram.auth.status !== 'waiting_qr') return;
  if (!state.telegram.auth.qrDataUrl) {
    DOM.telegramQrCountdown.textContent = '正在生成二维码…';
    return;
  }
  const remaining = Number(state.telegram.auth.qrExpiresAt || 0) - Date.now();
  DOM.telegramQrCountdown.textContent = remaining > 0
    ? `二维码约 ${Math.ceil(remaining / 1000)} 秒后自动刷新`
    : '二维码正在自动刷新…';
}

function telegramGroupTypeLabel(type) {
  return {
    group: '普通群组',
    supergroup: '超级群组',
    channel: '频道',
  }[String(type || '')] || '群组';
}

function telegramBotCursorSourceKey(accountKey) {
  return `telegram-bot:${String(accountKey || '').trim()}:updates`;
}

function getTelegramBotCursor(accountKey) {
  if (!accountKey) return null;
  try { return api.dbGetTelegramSource(telegramBotCursorSourceKey(accountKey)); } catch { return null; }
}

function mergeTelegramBotGroups(groups) {
  const merged = new Map((state.telegram.bot.availableGroups || []).map(group => [String(group.chatKey || ''), group]));
  for (const group of groups || []) {
    const key = String(group?.chatKey || '');
    if (!key) continue;
    const existing = merged.get(key);
    merged.set(key, existing && Number(existing.latestMessageId || 0) > Number(group.latestMessageId || 0)
      ? { ...group, ...existing }
      : { ...existing, ...group });
  }
  state.telegram.bot.availableGroups = [...merged.values()].sort((left, right) =>
    String(left.title || '').localeCompare(String(right.title || '')));
}

function renderTelegramBotGroups() {
  const bot = state.telegram.bot;
  const selected = bot.selectedGroupKeys || new Set();
  if (DOM.telegramBotGroupSelectionCount) DOM.telegramBotGroupSelectionCount.textContent = `${selected.size} / 5`;
  if (DOM.telegramBotGroupPicker) {
    const query = String(DOM.telegramBotGroupSearch?.value || '').trim().toLowerCase();
    const rows = (bot.availableGroups || []).filter(group =>
      !query
      || String(group.title || '').toLowerCase().includes(query)
      || String(group.username || '').toLowerCase().includes(query));
    if (bot.groupsLoading) {
      DOM.telegramBotGroupPicker.innerHTML = '<div class="telegram-history-empty">正在从机器人更新队列发现群组…</div>';
    } else if (!bot.availableGroups.length) {
      DOM.telegramBotGroupPicker.innerHTML = '<div class="telegram-history-empty">在每个群里发送一条识别消息，然后点击“发现群组”</div>';
    } else if (!rows.length) {
      DOM.telegramBotGroupPicker.innerHTML = '<div class="telegram-history-empty">没有匹配的已发现群组</div>';
    } else {
      DOM.telegramBotGroupPicker.innerHTML = rows.map(group => {
        const checked = selected.has(String(group.chatKey || ''));
        const disabled = telegramAnyRunning() || (!checked && selected.size >= 5);
        return `<label class="telegram-group-option${checked ? ' selected' : ''}">
          <input type="checkbox" data-telegram-bot-group-key="${encodeURIComponent(String(group.chatKey || ''))}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
          <span class="telegram-group-option-main">
            <strong>${esc(group.title || '未命名群组')}</strong>
            <small>${esc([group.username ? `@${group.username}` : '', telegramGroupTypeLabel(group.chatType), `ID ${group.chatKey}`, `最新 #${Number(group.latestMessageId || 0)}`].filter(Boolean).join(' · '))}</small>
          </span>
          <span class="telegram-group-option-status">${checked ? '已选择' : '未选择'}</span>
        </label>`;
      }).join('');
    }
  }
  if (DOM.telegramBotSelectedSources) {
    const rows = bot.groupSources || [];
    if (!rows.length) {
      DOM.telegramBotSelectedSources.innerHTML = '<div class="telegram-history-empty">尚未绑定机器人增量来源</div>';
    } else {
      DOM.telegramBotSelectedSources.innerHTML = rows.map(source => {
        const meta = [
          telegramGroupTypeLabel(source.chatType),
          `首次基线 #${Number(source.baselineMessageId || 0)}`,
          `消息游标 #${Number(source.checkpointMessageId || 0)}`,
          source.lastSyncAt ? `上次 ${source.lastSyncAt}` : '尚未同步',
          source.lastError ? `异常：${source.lastError}` : '',
        ].filter(Boolean).join(' · ');
        return `<div class="telegram-selected-source">
          <span><strong>${esc(source.sourceLabel || source.chatKey || 'Telegram 群组')}</strong><small>${esc(meta)}</small></span>
          <span class="badge">随全部来源同步</span>
        </div>`;
      }).join('');
    }
  }
}

function handleTelegramBotGroupSelection(event) {
  const input = event.target.closest('[data-telegram-bot-group-key]');
  if (!input) return;
  const chatKey = decodeURIComponent(input.dataset.telegramBotGroupKey || '');
  const selected = new Set(state.telegram.bot.selectedGroupKeys || []);
  if (input.checked) {
    if (selected.size >= 5) {
      input.checked = false;
      toast('最多只能选择 5 个 Telegram 群组', 'error');
      return;
    }
    selected.add(chatKey);
  } else {
    selected.delete(chatKey);
  }
  state.telegram.bot.selectedGroupKeys = selected;
  renderTelegramBotGroups();
}

async function connectTelegramBot() {
  if (telegramAnyRunning()) return;
  const token = DOM.telegramBotToken?.value.trim() || '';
  if (!token) {
    toast('请粘贴 @BotFather 提供的完整 Bot Token', 'error');
    return;
  }
  state.telegram.bot.auth = { ...state.telegram.bot.auth, status: 'connecting', connected: false, error: '' };
  renderTelegramSource();
  try {
    state.telegram.bot.auth = { ...state.telegram.bot.auth, ...(await api.connectTelegramBot({ token })) };
    if (DOM.telegramBotToken) DOM.telegramBotToken.value = '';
    const accountKey = state.telegram.bot.auth.accountKey;
    state.telegram.bot.groupSources = api.dbGetTelegramGroupSources(accountKey, true, 'bot_group');
    state.telegram.bot.selectedGroupKeys = new Set(state.telegram.bot.groupSources.map(source => String(source.chatKey || '')));
    renderTelegramSource();
    toast(`机器人已连接：${state.telegram.bot.auth.accountLabel || accountKey}`, 'success');
  } catch (error) {
    if (DOM.telegramBotToken) DOM.telegramBotToken.value = '';
    state.telegram.bot.auth = { ...state.telegram.bot.auth, status: 'error', connected: false, error: error.message || String(error) };
    renderTelegramSource();
    toast(`机器人连接失败：${error.message}`, 'error');
  }
}

async function connectStoredTelegramBot(options = {}) {
  if (telegramAnyRunning()) return;
  state.telegram.bot.auth = { ...state.telegram.bot.auth, status: 'connecting', connected: false, error: '' };
  renderTelegramSource();
  try {
    state.telegram.bot.auth = { ...state.telegram.bot.auth, ...(await api.connectTelegramBotStored()) };
    const accountKey = state.telegram.bot.auth.accountKey;
    state.telegram.bot.groupSources = api.dbGetTelegramGroupSources(accountKey, true, 'bot_group');
    state.telegram.bot.selectedGroupKeys = new Set(state.telegram.bot.groupSources.map(source => String(source.chatKey || '')));
    renderTelegramSource();
    if (!options.silent) toast(`已连接保存的机器人：${state.telegram.bot.auth.accountLabel || accountKey}`, 'success');
  } catch (error) {
    state.telegram.bot.auth = { ...state.telegram.bot.auth, status: 'error', connected: false, error: error.message || String(error) };
    renderTelegramSource();
    if (!options.silent) toast(`保存的机器人连接失败：${error.message}`, 'error');
  }
}

async function clearTelegramBot() {
  if (telegramAnyRunning()) return;
  if (!confirm('清除本机加密保存的 Bot Token？已记录的消息历史和番号不会删除。')) return;
  try {
    state.telegram.bot.auth = { ...state.telegram.bot.auth, ...(await api.clearTelegramBot()) };
    state.telegram.bot.availableGroups = [];
    state.telegram.bot.groupSources = [];
    state.telegram.bot.selectedGroupKeys = new Set();
    renderTelegramSource();
    toast('本机 Bot Token 已清除，历史数据仍保留', 'success');
  } catch (error) {
    toast(`清除机器人失败：${error.message}`, 'error');
  }
}

async function initializeTelegramBotConnection() {
  try {
    state.telegram.bot.auth = { ...state.telegram.bot.auth, ...(await api.getTelegramBotStatus()) };
    renderTelegramSource();
    if (state.telegram.bot.auth.configured && state.telegram.bot.auth.status !== 'ready') {
      await connectStoredTelegramBot({ silent: true });
    }
  } catch (error) {
    state.telegram.bot.auth = { ...state.telegram.bot.auth, status: 'error', connected: false, error: error.message || String(error) };
    renderTelegramSource();
  }
}

async function discoverTelegramBotGroups() {
  const bot = state.telegram.bot;
  if (bot.groupsLoading || telegramAnyRunning() || bot.auth.status !== 'ready') return;
  bot.groupsLoading = true;
  renderTelegramSource();
  try {
    const cursor = getTelegramBotCursor(bot.auth.accountKey);
    const lastUpdateId = Math.max(0, Number(cursor?.checkpointMessageId) || 0);
    const result = await api.discoverTelegramBotGroups({
      offset: lastUpdateId > 0 ? lastUpdateId + 1 : 0,
      limit: 100,
    });
    mergeTelegramBotGroups(result.groups || []);
    bot.groupSources = api.dbGetTelegramGroupSources(bot.auth.accountKey, true, 'bot_group');
    bot.selectedGroupKeys = new Set(bot.groupSources.map(source => String(source.chatKey || '')));
    const pending = Number(result.updateCount || 0);
    toast(result.groups?.length
      ? `发现 ${result.groups.length} 个有新消息的群组；当前队列 ${pending} 条更新`
      : '尚未发现群组：请确认机器人已加入群、隐私模式已关闭，并在群里发送一条普通消息', result.groups?.length ? 'success' : 'info');
  } catch (error) {
    toast(`发现机器人群组失败：${error.message}`, 'error');
  } finally {
    bot.groupsLoading = false;
    renderTelegramSource();
  }
}

async function saveTelegramBotGroupSources() {
  const bot = state.telegram.bot;
  if (telegramAnyRunning() || bot.groupsLoading) return;
  const accountKey = bot.auth.accountKey;
  if (!accountKey) {
    toast('请先连接 Telegram 机器人', 'error');
    return;
  }
  const available = new Map((bot.availableGroups || []).map(group => [String(group.chatKey || ''), group]));
  const groups = [...bot.selectedGroupKeys].map(chatKey => available.get(chatKey)).filter(Boolean);
  if (groups.length !== bot.selectedGroupKeys.size) {
    toast('部分已选群组不在本次发现列表中，请重新发现后选择', 'error');
    return;
  }
  try {
    bot.groupSources = api.dbSetTelegramGroupSources({
      accountKey,
      accountLabel: bot.auth.accountLabel || '',
      sourceType: 'bot_group',
      groups,
    });
    bot.selectedGroupKeys = new Set(bot.groupSources.map(source => String(source.chatKey || '')));
    renderTelegramSource();
    toast(groups.length
      ? `已保存 ${groups.length} 个机器人来源；从保存后的新消息开始处理`
      : '已停用全部机器人来源', 'success');
  } catch (error) {
    toast(`保存机器人群组失败：${error.message}`, 'error');
  }
}

async function syncTelegramBotGroups() {
  const bot = state.telegram.bot;
  if (telegramAnyRunning()) return;
  const accountKey = bot.auth.accountKey;
  if (!accountKey || bot.auth.status !== 'ready') {
    toast('请先连接 Telegram 机器人', 'error');
    return;
  }
  let sources = [];
  try { sources = api.dbGetTelegramGroupSources(accountKey, true, 'bot_group'); } catch {}
  if (!sources.length) {
    toast('请先发现群组并保存至少一个机器人来源', 'error');
    return;
  }
  const sourceMap = new Map(sources.map(source => [String(source.chatKey || ''), source]));
  const cursorKey = telegramBotCursorSourceKey(accountKey);
  const cursor = getTelegramBotCursor(accountKey);
  const initialUpdateId = Math.max(0, Number(cursor?.checkpointMessageId) || 0);
  const initialDrain = initialUpdateId === 0;
  const limit = Math.max(1, Number(DOM.telegramBotSyncLimit?.value || 500));
  let offset = initialUpdateId > 0 ? initialUpdateId + 1 : 0;
  let fetched = 0;
  let batchCount = 0;
  let failed = '';
  bot.running = true;
  bot.stopRequested = false;
  bot.progress = { fetched: 0, limit };
  state.telegram.preview = { codes: [], messageCount: 0, newMessageCount: 0, duplicateMessageCount: 0, updatedMessageCount: 0, errorCount: 0 };
  renderTelegramSource();

  try {
    while (!bot.stopRequested && fetched < limit) {
      const pageLimit = Math.min(100, limit - fetched);
      const result = await api.fetchTelegramBotUpdates({ offset, limit: pageLimit });
      const updateCount = Number(result.updateCount || 0);
      if (!updateCount) break;

      for (const group of result.messageGroups || []) {
        const source = sourceMap.get(String(group.chatKey || ''));
        if (!source) continue;
        const messages = (group.messages || []).filter(message =>
          !initialDrain || Number(message.messageId || 0) > Number(source.baselineMessageId || 0));
        if (!messages.length) continue;
        await persistTelegramImport({
          sourceKey: `telegram-bot:${accountKey}:group:${group.chatKey}`,
          sourceType: 'bot_group',
          sourceLabel: source.sourceLabel || group.title || `Telegram ${group.chatKey}`,
          accountKey,
          accountLabel: bot.auth.accountLabel || '',
          chatKey: group.chatKey,
          chatType: source.chatType || group.chatType || 'group',
          isSelected: true,
          baselineMessageId: Number(source.baselineMessageId || 0),
          checkpointMessageId: Math.max(0, ...messages.map(message => Number(message.messageId) || 0)),
          checkpointDate: messages.at(-1)?.messageDate || '',
          checkpointComplete: true,
          messages,
          errors: [],
        }, { append: true });
      }

      const lastUpdateId = Math.max(0, Number(result.lastUpdateId) || 0);
      if (lastUpdateId <= 0) break;
      api.dbUpsertTelegramSource({
        sourceKey: cursorKey,
        sourceType: 'bot_cursor',
        accountKey,
        accountLabel: bot.auth.accountLabel || '',
        sourceLabel: 'Telegram Bot 全局更新游标',
        checkpointMessageId: lastUpdateId,
        checkpointDate: new Date().toISOString(),
        status: 'ready',
        lastError: '',
        lastSyncAt: new Date().toISOString(),
      });
      fetched += updateCount;
      batchCount++;
      offset = lastUpdateId + 1;
      bot.progress = { fetched, limit };
      renderTelegramSource();
      if (updateCount < pageLimit) break;
    }
  } catch (error) {
    failed = error.message || String(error);
  } finally {
    for (const source of sources) {
      try {
        api.dbUpsertTelegramSource({
          ...source,
          sourceType: 'bot_group',
          isSelected: true,
          status: failed ? 'error' : 'ready',
          lastError: failed,
          lastSyncAt: new Date().toISOString(),
        });
      } catch {}
    }
    bot.running = false;
    try {
      bot.groupSources = api.dbGetTelegramGroupSources(accountKey, true, 'bot_group');
      state.telegram.history = api.dbGetTelegramImportHistory(30);
    } catch {}
  }

  const preview = state.telegram.preview;
  const stopped = bot.stopRequested ? ' · 已停止' : '';
  const errorText = failed ? ` · 异常：${failed}` : '';
  if (DOM.telegramImportSummary) {
    DOM.telegramImportSummary.textContent = `机器人接收 ${fetched} 条更新（${batchCount} 批）；新增消息 ${preview.newMessageCount}，重复 ${preview.duplicateMessageCount}，更新 ${preview.updatedMessageCount}；产出 ${preview.codes.length} 个新番号${stopped}${errorText}`;
  }
  renderTelegramSource();
  if (failed) toast(`机器人同步未完成：${failed}`, 'error');
  else toast(`机器人同步完成：新消息 ${preview.newMessageCount}，新番号 ${preview.codes.length}${stopped}`, 'success');
}

function stopTelegramBotGroups() {
  if (!state.telegram.bot.running) return;
  state.telegram.bot.stopRequested = true;
  if (DOM.telegramBotSyncProgress) DOM.telegramBotSyncProgress.textContent = '将在当前最多 100 条更新安全写入并保存游标后停止';
}

function renderTelegramGroups() {
  const selected = state.telegram.selectedGroupKeys || new Set();
  if (DOM.telegramGroupSelectionCount) DOM.telegramGroupSelectionCount.textContent = `${selected.size} / 5`;
  if (DOM.telegramGroupPicker) {
    const query = String(DOM.telegramGroupSearch?.value || '').trim().toLowerCase();
    const rows = (state.telegram.availableGroups || []).filter(group =>
      !query
      || String(group.title || '').toLowerCase().includes(query)
      || String(group.username || '').toLowerCase().includes(query));
    if (state.telegram.groupsLoading) {
      DOM.telegramGroupPicker.innerHTML = '<div class="telegram-history-empty">正在从 Telegram 加载群组…</div>';
    } else if (!state.telegram.availableGroups.length) {
      DOM.telegramGroupPicker.innerHTML = '<div class="telegram-history-empty">连接账号后点击“加载/刷新群组”</div>';
    } else if (!rows.length) {
      DOM.telegramGroupPicker.innerHTML = '<div class="telegram-history-empty">没有匹配的群组</div>';
    } else {
      DOM.telegramGroupPicker.innerHTML = rows.map(group => {
        const checked = selected.has(String(group.chatKey));
        const disabled = state.telegram.running || (!checked && selected.size >= 5);
        const badges = [
          telegramGroupTypeLabel(group.chatType),
          group.owned ? '你创建的' : group.admin ? '管理员' : '',
          group.archived ? '已归档' : '',
        ].filter(Boolean);
        return `<label class="telegram-group-option${checked ? ' selected' : ''}">
          <input type="checkbox" data-telegram-group-key="${encodeURIComponent(String(group.chatKey || ''))}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
          <span class="telegram-group-option-main">
            <strong>${esc(group.title || '未命名群组')}</strong>
            <small>${esc([group.username ? `@${group.username}` : '', ...badges, `ID ${group.chatKey}`].filter(Boolean).join(' · '))}</small>
          </span>
          <span class="telegram-group-option-status">${checked ? '已选择' : '未选择'}</span>
        </label>`;
      }).join('');
    }
  }
  if (DOM.telegramSelectedSources) {
    const rows = state.telegram.groupSources || [];
    if (!rows.length) {
      DOM.telegramSelectedSources.innerHTML = '<div class="telegram-history-empty">尚未绑定增量来源</div>';
    } else {
      DOM.telegramSelectedSources.innerHTML = rows.map(source => {
        const checkpoint = Number(source.checkpointMessageId || 0);
        const baseline = Number(source.baselineMessageId || 0);
        const meta = [
          telegramGroupTypeLabel(source.chatType),
          `基线 #${baseline}`,
          `游标 #${checkpoint}`,
          source.lastSyncAt ? `上次 ${source.lastSyncAt}` : '尚未同步',
          source.lastError ? `异常：${source.lastError}` : '',
        ].filter(Boolean).join(' · ');
        return `<div class="telegram-selected-source">
          <span><strong>${esc(source.sourceLabel || source.chatKey || 'Telegram 群组')}</strong><small>${esc(meta)}</small></span>
          <button class="btn btn-outline btn-sm" type="button" data-telegram-sync-group="${encodeURIComponent(String(source.chatKey || ''))}" ${state.telegram.running ? 'disabled' : ''}>同步此群</button>
        </div>`;
      }).join('');
    }
  }
}

function handleTelegramGroupSelection(event) {
  const input = event.target.closest('[data-telegram-group-key]');
  if (!input) return;
  const chatKey = decodeURIComponent(input.dataset.telegramGroupKey || '');
  const selected = new Set(state.telegram.selectedGroupKeys || []);
  if (input.checked) {
    if (selected.size >= 5) {
      input.checked = false;
      toast('最多只能选择 5 个 Telegram 群组', 'error');
      return;
    }
    selected.add(chatKey);
  } else {
    selected.delete(chatKey);
  }
  state.telegram.selectedGroupKeys = selected;
  renderTelegramGroups();
}

async function loadTelegramGroups(options = {}) {
  if (state.telegram.groupsLoading || telegramAnyRunning()) return;
  if (!['ready', 'listing_groups', 'syncing'].includes(state.telegram.auth.status)) {
    if (!options.silent) toast('请先连接 Telegram 账号', 'error');
    return;
  }
  state.telegram.groupsLoading = true;
  renderTelegramSource();
  try {
    const result = await api.listTelegramGroups();
    state.telegram.availableGroups = result.groups || [];
    state.telegram.groupSources = api.dbGetTelegramGroupSources(result.accountKey || state.telegram.auth.accountKey);
    state.telegram.selectedGroupKeys = new Set(state.telegram.groupSources.map(source => String(source.chatKey || '')));
    state.telegram.auth = {
      ...state.telegram.auth,
      status: 'ready',
      accountKey: result.accountKey || state.telegram.auth.accountKey,
      accountLabel: result.accountLabel || state.telegram.auth.accountLabel,
      error: '',
    };
    if (!options.silent) toast(`已加载 ${state.telegram.availableGroups.length} 个群组/频道`, 'success');
  } catch (error) {
    state.telegram.auth = { ...state.telegram.auth, status: 'error', error: error.message || String(error) };
    if (!options.silent) toast(`加载 Telegram 群组失败：${error.message}`, 'error');
  } finally {
    state.telegram.groupsLoading = false;
    renderTelegramSource();
  }
}

async function saveTelegramGroupSources() {
  if (telegramAnyRunning() || state.telegram.groupsLoading) return;
  const accountKey = state.telegram.auth.accountKey;
  if (!accountKey) {
    toast('请先连接 Telegram 账号', 'error');
    return;
  }
  const available = new Map((state.telegram.availableGroups || []).map(group => [String(group.chatKey || ''), group]));
  const groups = [...state.telegram.selectedGroupKeys].map(chatKey => available.get(chatKey)).filter(Boolean);
  if (groups.length !== state.telegram.selectedGroupKeys.size) {
    toast('部分已选群组不在当前列表中，请刷新后重新选择', 'error');
    return;
  }
  try {
    state.telegram.groupSources = api.dbSetTelegramGroupSources({
      accountKey,
      accountLabel: state.telegram.auth.accountLabel || '',
      groups,
    });
    state.telegram.selectedGroupKeys = new Set(state.telegram.groupSources.map(source => String(source.chatKey || '')));
    renderTelegramSource();
    toast(groups.length ? `已保存 ${groups.length} 个增量来源；首次同步不会扫描旧历史` : '已停用全部 Telegram 增量来源', 'success');
  } catch (error) {
    toast(`保存 Telegram 群组失败：${error.message}`, 'error');
  }
}

function renderTelegramHistory() {
  if (!DOM.telegramHistoryList) return;
  const rows = state.telegram.history || [];
  if (!rows.length) {
    DOM.telegramHistoryList.innerHTML = '<div class="telegram-history-empty">暂无记录</div>';
    return;
  }
  DOM.telegramHistoryList.innerHTML = rows.map(row => `
    <div class="telegram-history-row">
      <strong title="${esc(row.sourceLabel || row.sourceType)}">${esc(row.sourceLabel || row.sourceType || 'Telegram')}</strong>
      <span>${esc(row.finishedAt || row.startedAt || '')}</span>
      <span>新 ${Number(row.newMessageCount || 0)} / 重 ${Number(row.duplicateMessageCount || 0)}</span>
      <span>番号 ${Number(row.codeCount || 0)}${row.errorCount ? ` / 错 ${Number(row.errorCount)}` : ''}</span>
    </div>`).join('');
}

async function refreshTelegramSourcePage() {
  switchTelegramPanel(state.telegram.panel);
  const authEpoch = state.telegram.authEpoch;
  try {
    const auth = await api.getTelegramStatus();
    if (authEpoch === state.telegram.authEpoch) {
      state.telegram.auth = { ...state.telegram.auth, ...auth };
    }
  } catch (error) {
    if (authEpoch === state.telegram.authEpoch) {
      state.telegram.auth = { ...state.telegram.auth, status: 'error', error: error.message || String(error) };
    }
  }
  try {
    state.telegram.bot.auth = { ...state.telegram.bot.auth, ...(await api.getTelegramBotStatus()) };
  } catch (error) {
    state.telegram.bot.auth = { ...state.telegram.bot.auth, status: 'error', connected: false, error: error.message || String(error) };
  }
  try {
    state.telegram.history = api.dbGetTelegramImportHistory(30);
  } catch {
    state.telegram.history = [];
  }
  if (state.telegram.auth.accountKey) {
    try {
      state.telegram.groupSources = api.dbGetTelegramGroupSources(state.telegram.auth.accountKey);
      state.telegram.selectedGroupKeys = new Set(state.telegram.groupSources.map(source => String(source.chatKey || '')));
    } catch {
      state.telegram.groupSources = [];
    }
  }
  if (state.telegram.bot.auth.accountKey) {
    try {
      state.telegram.bot.groupSources = api.dbGetTelegramGroupSources(state.telegram.bot.auth.accountKey, true, 'bot_group');
      state.telegram.bot.selectedGroupKeys = new Set(state.telegram.bot.groupSources.map(source => String(source.chatKey || '')));
    } catch {
      state.telegram.bot.groupSources = [];
    }
  }
  renderTelegramSource();
  if (state.telegram.panel === 'api' && state.telegram.auth.status === 'ready' && !state.telegram.availableGroups.length) {
    await loadTelegramGroups({ silent: true });
  }
}

async function initializeTelegramConnection() {
  const authEpoch = state.telegram.authEpoch;
  try {
    const auth = await api.getTelegramStatus();
    if (authEpoch !== state.telegram.authEpoch) return;
    state.telegram.auth = { ...state.telegram.auth, ...auth };
    renderTelegramSource();
    if (auth.configured && auth.status !== 'ready') {
      await connectStoredTelegram({ silent: true, loadGroups: false });
    }
  } catch (error) {
    state.telegram.auth = { ...state.telegram.auth, status: 'error', error: error.message || String(error) };
    renderTelegramSource();
  }
}

async function startTelegramQrAuthorization() {
  const apiId = DOM.telegramApiId?.value.trim() || '';
  const apiHash = DOM.telegramApiHash?.value.trim() || '';
  state.telegram.authEpoch++;
  state.telegram.auth = { ...state.telegram.auth, status: 'connecting', connected: false, error: '', hint: '正在生成登录二维码' };
  renderTelegramSource();
  try {
    const auth = await api.startTelegramQrAuthorization({ apiId, apiHash });
    state.telegram.auth = { ...state.telegram.auth, ...auth };
    if (DOM.telegramApiHash) DOM.telegramApiHash.value = '';
    renderTelegramSource();
  } catch (error) {
    state.telegram.auth = { ...state.telegram.auth, status: 'error', connected: false, error: error.message || String(error), hint: '' };
    renderTelegramSource();
    toast(`Telegram 扫码登录启动失败：${error.message}`, 'error');
  }
}

async function startTelegramAuthorization() {
  const apiId = DOM.telegramApiId?.value.trim() || '';
  const apiHash = DOM.telegramApiHash?.value.trim() || '';
  const phoneNumber = DOM.telegramPhone?.value.trim() || '';
  state.telegram.authEpoch++;
  state.telegram.auth = { ...state.telegram.auth, status: 'connecting', connected: false, error: '', hint: '正在启动验证码登录' };
  renderTelegramSource();
  try {
    const auth = await api.startTelegramAuthorization({ apiId, apiHash, phoneNumber });
    state.telegram.auth = { ...state.telegram.auth, ...auth };
    if (DOM.telegramApiHash) DOM.telegramApiHash.value = '';
    if (DOM.telegramPhone) DOM.telegramPhone.value = '';
    renderTelegramSource();
  } catch (error) {
    state.telegram.auth = { ...state.telegram.auth, status: 'error', connected: false, error: error.message || String(error), hint: '' };
    renderTelegramSource();
    toast(`Telegram 登录启动失败：${error.message}`, 'error');
  }
}

async function submitTelegramAuthorization() {
  const kind = state.telegram.authKind;
  const value = DOM.telegramAuthValue?.value || '';
  if (!kind || !value.trim()) {
    toast('请填写当前授权步骤所需内容', 'error');
    return;
  }
  try {
    await api.submitTelegramAuthorization({ kind, value });
    if (DOM.telegramAuthValue) DOM.telegramAuthValue.value = '';
  } catch (error) {
    toast(`Telegram 授权失败：${error.message}`, 'error');
  }
}

async function cancelTelegramAuthorization() {
  state.telegram.authEpoch++;
  try {
    state.telegram.auth = { ...state.telegram.auth, ...(await api.cancelTelegramAuthorization()) };
    if (DOM.telegramAuthValue) DOM.telegramAuthValue.value = '';
    renderTelegramSource();
  } catch (error) {
    toast(`取消授权失败：${error.message}`, 'error');
  }
}

async function connectStoredTelegram(options = {}) {
  state.telegram.authEpoch++;
  try {
    state.telegram.auth = { ...state.telegram.auth, status: 'connecting', error: '' };
    renderTelegramSource();
    state.telegram.auth = { ...state.telegram.auth, ...(await api.connectTelegramStored()) };
    renderTelegramSource();
    if (state.telegram.auth.status === 'ready' && options.loadGroups !== false && state.activePage === 'sources') {
      await loadTelegramGroups({ silent: true });
    }
  } catch (error) {
    state.telegram.auth = { ...state.telegram.auth, status: 'error', error: error.message || String(error) };
    renderTelegramSource();
    if (!options.silent) toast(`Telegram 连接失败：${error.message}`, 'error');
  }
}

async function logoutTelegram() {
  if (!confirm('退出 Telegram API 会话并清除本机加密会话？之后需要重新扫码或使用验证码登录。')) return;
  state.telegram.authEpoch++;
  try {
    state.telegram.auth = { ...state.telegram.auth, ...(await api.logoutTelegram()) };
    state.telegram.availableGroups = [];
    state.telegram.groupSources = [];
    state.telegram.selectedGroupKeys = new Set();
    renderTelegramSource();
    toast('Telegram 本机会话已清除', 'success');
  } catch (error) {
    toast(`Telegram 退出失败：${error.message}`, 'error');
  }
}

async function persistTelegramImport(result, options = {}) {
  dispatchToolboxMessages(result);
  const recorded = api.dbRecordTelegramImport({
    sourceKey: result.sourceKey,
    sourceType: result.sourceType,
    sourceLabel: result.sourceLabel,
    accountKey: result.accountKey || '',
    accountLabel: result.accountLabel || '',
    chatKey: result.chatKey || '',
    chatType: result.chatType || '',
    isSelected: result.isSelected === true,
    baselineMessageId: result.baselineMessageId || 0,
    checkpointMessageId: result.checkpointMessageId || 0,
    checkpointDate: result.checkpointDate || '',
    checkpointComplete: result.checkpointComplete !== false,
    syncCursorMessageId: result.syncCursorMessageId || 0,
    syncTargetMessageId: result.syncTargetMessageId || 0,
    messages: result.messages || [],
    errors: result.errors || [],
  });
  const previous = options.append ? state.telegram.preview : null;
  state.telegram.preview = previous ? {
    codes: [...new Set([...(previous.codes || []), ...(recorded.codes || [])])],
    messageCount: Number(previous.messageCount || 0) + Number(recorded.messageCount || 0),
    newMessageCount: Number(previous.newMessageCount || 0) + Number(recorded.newMessageCount || 0),
    duplicateMessageCount: Number(previous.duplicateMessageCount || 0) + Number(recorded.duplicateMessageCount || 0),
    updatedMessageCount: Number(previous.updatedMessageCount || 0) + Number(recorded.updatedMessageCount || 0),
    errorCount: Number(previous.errorCount || 0) + Number(recorded.errorCount || 0),
  } : {
    codes: recorded.codes || [],
    messageCount: recorded.messageCount || 0,
    newMessageCount: recorded.newMessageCount || 0,
    duplicateMessageCount: recorded.duplicateMessageCount || 0,
    updatedMessageCount: recorded.updatedMessageCount || 0,
    errorCount: recorded.errorCount || 0,
  };
  state.telegram.history = api.dbGetTelegramImportHistory(30);
  if (DOM.telegramImportSummary) {
    const stopped = result.stopped ? ' · 已按你的要求停止' : '';
    const pending = result.hasMore ? ' · 当前群仍有未读段，下次从断点继续' : '';
    DOM.telegramImportSummary.textContent = `读取 ${recorded.messageCount} 条；新增 ${recorded.newMessageCount}，重复 ${recorded.duplicateMessageCount}，更新 ${recorded.updatedMessageCount}；产出 ${recorded.codes.length} 个新番号${pending}${stopped}`;
  }
  renderTelegramSource();
  return recorded;
}

async function syncTelegramGroups(targetChatKeys = []) {
  if (telegramAnyRunning()) return;
  const accountKey = state.telegram.auth.accountKey;
  if (!accountKey) {
    toast('请先连接 Telegram 账号', 'error');
    return;
  }
  let sources = [];
  try { sources = api.dbGetTelegramGroupSources(accountKey); } catch {}
  const targets = new Set((targetChatKeys || []).map(value => String(value || '')).filter(Boolean));
  if (targets.size) sources = sources.filter(source => targets.has(String(source.chatKey || '')));
  if (!sources.length) {
    toast(targets.size ? '所选群组尚未绑定，请刷新并保存来源' : '请先选择并保存至少一个 Telegram 群组', 'error');
    return;
  }
  state.telegram.running = true;
  state.telegram.stopRequested = false;
  state.telegram.preview = { codes: [], messageCount: 0, newMessageCount: 0, duplicateMessageCount: 0, updatedMessageCount: 0, errorCount: 0 };
  const limit = Number(DOM.telegramSyncLimit?.value || 500);
  const since = DOM.telegramSyncSince?.value || '';
  const lookback = Number(DOM.telegramSyncLookback?.value || 20);
  let completedGroups = 0;
  let failedGroups = 0;
  state.telegram.progress = { fetched: 0, limit, groupIndex: 1, groupTotal: sources.length, groupTitle: sources[0]?.sourceLabel || 'Telegram 群组' };
  renderTelegramSource();
  for (let index = 0; index < sources.length; index++) {
    if (state.telegram.stopRequested) break;
    const source = sources[index];
    state.telegram.progress = {
      fetched: 0,
      limit,
      groupIndex: index + 1,
      groupTotal: sources.length,
      groupTitle: source.sourceLabel || source.chatKey || 'Telegram 群组',
    };
    renderTelegramSource();
    try {
      const result = await api.syncTelegramGroup({
        chatKey: source.chatKey,
        limit,
        since,
        ignoreBaseline: Boolean(since),
        lookback,
        baselineMessageId: Number(source.baselineMessageId || 0),
        checkpointMessageId: Number(source.checkpointMessageId || 0),
        syncCursorMessageId: Number(source.syncCursorMessageId || 0),
        syncTargetMessageId: Number(source.syncTargetMessageId || 0),
      });
      await persistTelegramImport(result, { append: true });
      completedGroups++;
      if (result.stopped) {
        state.telegram.stopRequested = true;
        break;
      }
    } catch (error) {
      failedGroups++;
      try {
        api.dbUpsertTelegramSource({
          ...source,
          sourceType: 'api_group',
          isSelected: true,
          status: 'error',
          lastError: error.message || String(error),
          lastSyncAt: new Date().toISOString(),
        });
      } catch {}
      if (/需等待\s*\d+\s*秒|FLOOD_/i.test(error.message || '')) {
        state.telegram.stopRequested = true;
        toast(`Telegram 限流：${error.message}`, 'error');
        break;
      }
    }
  }
  state.telegram.running = false;
  try {
    state.telegram.groupSources = api.dbGetTelegramGroupSources(accountKey);
    state.telegram.history = api.dbGetTelegramImportHistory(30);
  } catch {}
  const preview = state.telegram.preview;
  const stopped = state.telegram.stopRequested ? ' · 已停止' : '';
  const failed = failedGroups ? ` · ${failedGroups} 个群异常` : '';
  if (DOM.telegramImportSummary) {
    DOM.telegramImportSummary.textContent = `已同步 ${completedGroups}/${sources.length} 个群；读取 ${preview.messageCount} 条，新增 ${preview.newMessageCount}，重复 ${preview.duplicateMessageCount}，更新 ${preview.updatedMessageCount}；产出 ${preview.codes.length} 个新番号${failed}${stopped}`;
  }
  renderTelegramSource();
  toast(`Telegram 增量同步完成：新消息 ${preview.newMessageCount}，新番号 ${preview.codes.length}${failed}`, failedGroups ? 'info' : 'success');
}

async function stopTelegramGroups() {
  if (!state.telegram.running) return;
  state.telegram.stopRequested = true;
  try {
    await api.stopTelegramSync();
    if (DOM.telegramSyncProgress) DOM.telegramSyncProgress.textContent = '正在停止当前群；已读取内容仍会保存断点，后续群不会启动';
  } catch (error) {
    toast(`停止同步失败：${error.message}`, 'error');
  }
}

async function importTelegramExportFiles() {
  const paths = await api.openFile({
    title: '选择 Telegram 官方导出的 JSON 或 HTML',
    multiSelections: true,
    filters: [{ name: 'Telegram 导出文件', extensions: ['json', 'html', 'htm'] }],
  });
  if (!paths?.length) return;
  await importTelegramExportPaths(paths);
}

async function importTelegramExportDirectory() {
  const directory = await api.openDirectory({ title: '选择 Telegram 官方导出文件夹' });
  if (!directory) return;
  await importTelegramExportPaths([directory]);
}

async function importTelegramExportPaths(paths) {
  if (state.telegram.running) return;
  state.telegram.running = true;
  if (DOM.telegramExportStatus) DOM.telegramExportStatus.textContent = '正在解析导出文件…';
  renderTelegramSource();
  try {
    const result = await api.parseTelegramExport(paths);
    const recorded = await persistTelegramImport(result);
    if (DOM.telegramExportStatus) {
      DOM.telegramExportStatus.textContent = `${result.fileCount || paths.length} 个文件 · ${recorded.messageCount} 条消息 · ${recorded.errorCount} 个文件异常`;
    }
    toast(`Telegram 导入完成：新增消息 ${recorded.newMessageCount}，新番号 ${recorded.codes.length}`, recorded.errorCount ? 'info' : 'success');
  } catch (error) {
    if (DOM.telegramExportStatus) DOM.telegramExportStatus.textContent = `导入失败：${error.message}`;
    toast(`Telegram 导入失败：${error.message}`, 'error');
  } finally {
    state.telegram.running = false;
    renderTelegramSource();
  }
}

function useTelegramCodes() {
  const codes = state.telegram.preview.codes || [];
  if (!codes.length) return;
  if (!['missav', 'av123'].includes(state.activeTool)) switchTool(state.activeAvTool || 'missav');
  if (DOM.codeInput.value.trim() && !confirm(`用本次 ${codes.length} 个新番号替换“番号处理”中的现有输入？`)) return;
  DOM.codeInput.value = codes.join('\n');
  state.preparedRunId = null;
  parseInputCodes('Telegram 群组新增');
  updateUI();
  switchPage('process');
  toast(`已送入番号处理：${state.inputCodes.length} 条`, 'success');
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
function parseInputCodes(label = '') {
  const rawInput = DOM.codeInput.value;
  const isRaindropCsv = /^\uFEFF?id\s*,\s*title\s*,\s*note\s*,\s*excerpt\s*,\s*url\s*,\s*folder\s*,/i.test(rawInput);
  const sourceLabel = label || DOM.inputSourceInfo?.dataset.sourceLabel || '已识别';
  state.inputCodes = api.parseCodeList(rawInput);
  const parsedSignature = state.inputCodes.map(code => api.codeComparableKey(code)).join('|');
  if (!state.isProcessing && state.preparedInputSignature && parsedSignature !== state.preparedInputSignature) {
    state.preparedRunId = null;
    state.preparedInputSignature = '';
    state.sitePerformance = { missav: null, av123: null };
  }
  DOM.codeCount.textContent = `${state.inputCodes.length} 条`;
  if (DOM.filteredCodeOutput) DOM.filteredCodeOutput.value = state.inputCodes.join('\n');
  if (DOM.filteredCodeCount) DOM.filteredCodeCount.textContent = `${state.inputCodes.length} 条 · 一行一个${isRaindropCsv ? ' · 已忽略 ID/封面/普通网址/摘要噪声' : ''}`;
  if (DOM.inputSourceInfo) {
    DOM.inputSourceInfo.dataset.sourceLabel = sourceLabel;
    DOM.inputSourceInfo.textContent = `${sourceLabel} · ${state.inputCodes.length} 条${isRaindropCsv ? ' · Raindrop 结构化过滤' : ''}`;
  }
}
// ─── UI 更新 ─────────────────────────────────────────
function updateUI() {
  if (DOM.btnSelectTagFile) DOM.btnSelectTagFile.textContent = state.dbReady ? '导入 CSV' : '等待数据库...';
  if (DOM.batchName) DOM.batchName.disabled = state.isProcessing;
  if (DOM.btnResumeMissavBatch) DOM.btnResumeMissavBatch.disabled = state.isProcessing || lookupStagePending(state.resumableRun, 'missavLookup') <= 0;
  if (DOM.btnResume123AvBatch) DOM.btnResume123AvBatch.disabled = state.isProcessing || lookupStagePending(state.resumableRun, 'av123Lookup') <= 0;
  updateSiteRunControls();
  updateRunDeleteControls();
  updateSpeedModeUI();
  updateOperationSummaries();
  render123AvAccountState();
  renderFavoriteRuntime();
  updateTaskCenter();
}

function loadedResultRunId() {
  const ids = [...new Set(state.results.map(row => Number(row?.runId || 0)).filter(Boolean))];
  if (ids.length === 1) return ids[0];
  return Number(state.selectedRunId || state.preparedRunId || 0);
}

function updateRunDeleteControls() {
  const activeRunId = Number(state.currentRunId || 0);
  const activeFavoriteRunId = state.favoriteRuntime?.running ? Number(state.favoriteRuntime.runId || 0) : 0;
  const pendingDeleteId = Number(state.pendingDeleteRunId || 0);
  const updateButton = (button, runId, idleLabel) => {
    if (!button) return;
    const id = Number(runId || 0);
    button.hidden = !id;
    button.dataset.runId = id ? String(id) : '';
    const isActive = (state.isProcessing && activeRunId === id) || (activeFavoriteRunId && activeFavoriteRunId === id);
    const isPending = pendingDeleteId === id;
    const otherOperationActive = (state.isProcessing && activeRunId !== id) || (activeFavoriteRunId && activeFavoriteRunId !== id);
    button.disabled = !id || isPending || otherOperationActive;
    const label = button.querySelector('span');
    if (label) label.textContent = isPending ? '正在停止并删除…' : isActive ? '停止并删除批次' : idleLabel;
  };
  updateButton(DOM.btnDeleteResumableBatch, state.resumableRun?.id, '删除批次');
  updateButton(DOM.btnDeleteCurrentRun, loadedResultRunId(), '删除整个批次');
}

function lookupStagePending(batch, key) {
  const stage = batch?.stages?.[key];
  return Number(stage?.statusCounts?.queued || 0) + Number(stage?.statusCounts?.running || 0);
}

function preparedRunForControls() {
  if (!state.preparedRunId || !state.dbReady) return null;
  return api.dbGetRun(Number(state.preparedRunId)) || null;
}

function updateSiteRunControls() {
  if (!DOM.btnStartMissav || !DOM.btnStart123Av) return;
  const batch = preparedRunForControls();
  const canCreate = state.inputCodes.length > 0 && state.dbReady;
  const missavPending = batch ? lookupStagePending(batch, 'missavLookup') : 0;
  const av123Pending = batch ? lookupStagePending(batch, 'av123Lookup') : 0;
  const missavActive = state.isProcessing && state.activeLookupSite === 'missav';
  const av123Active = state.isProcessing && state.activeLookupSite === 'av123';
  const av123FavoriteActive = Boolean(state.favoriteRuntime?.running);
  const performanceText = site => {
    const perf = state.sitePerformance[site];
    if (!perf) return '';
    const elapsed = processingEta?.formatDuration(perf.elapsedMs) || `${Math.round(perf.elapsedMs / 1000)} 秒`;
    const rate = perf.elapsedMs > 0 ? (perf.completed * 1000 / perf.elapsedMs).toFixed(perf.completed * 1000 / perf.elapsedMs >= 10 ? 0 : 1) : '0';
    return `本次 ${perf.completed} 条 / ${elapsed} · ${rate} 条/秒`;
  };

  DOM.btnStartMissav.disabled = state.isProcessing || (batch ? missavPending <= 0 : !canCreate || !state.outputDirPath);
  DOM.btnStart123Av.disabled = state.isProcessing || av123FavoriteActive || (batch ? av123Pending <= 0 : !canCreate);
  DOM.btnStartMissav.querySelector('span').textContent = batch
    ? missavPending > 0 ? `继续 MissAV (${missavPending})` : 'MissAV 已完成'
    : '开始 MissAV';
  DOM.btnStart123Av.querySelector('span').textContent = batch
    ? av123Pending > 0 ? `继续 123AV (${av123Pending})` : '123AV 已完成'
    : '开始 123AV';
  DOM.btnStopMissav.hidden = !missavActive;
  DOM.btnStop123Av.hidden = !av123Active;

  if (!missavActive && DOM.runMissavTiming) {
    DOM.runMissavTiming.textContent = batch
      ? missavPending > 0 ? `${performanceText('missav') ? `${performanceText('missav')} · ` : ''}待处理 ${missavPending} 条` : performanceText('missav') || '查询已完成'
      : '未启动 · 独享所选速度档位';
  }
  if (!av123Active && DOM.run123AvTiming) {
    DOM.run123AvTiming.textContent = av123FavoriteActive
      ? '账号收藏运行中 · 同站查询需等待'
      : batch
      ? av123Pending > 0 ? `${performanceText('av123') ? `${performanceText('av123')} · ` : ''}待处理 ${av123Pending} 条` : performanceText('av123') || '查询已完成'
      : '未启动 · 独享所选速度档位';
  }
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

function initializeSpeedRuntime(profile, site = state.activeLookupSite) {
  const siteKey = normalizeSpeedSite(site);
  const runtimePolicy = processingSpeed.getRuntimePolicy(siteKey, profile.key, siteKey === 'av123' ? state.av123SpeedPolicy : state.missavSpeedPolicy);
  const rateSettings = siteRateSettings(runtimePolicy.site);
  const rateMode = rateSettings.mode;
  const targetRequestsPerSecond = rateSettings.cap;
  const initialRequestsPerSecond = rateMode === 'adaptive'
    ? processingSpeed.getSiteAdaptiveStartRate(runtimePolicy.site, targetRequestsPerSecond, rateSettings.learned)
    : targetRequestsPerSecond;
  const rateWindowMs = Math.max(1000, Number(profile.rateWindowMs || 10000));
  state.speedRuntime = {
    profile,
    ...runtimePolicy,
    successStreak: 0,
    currentGapMs: Math.ceil(1000 / Math.max(0.1, initialRequestsPerSecond)),
    penaltyUntil: 0,
    lastRequestAt: 0,
    activeWorkers: 0,
    activeByBranch: {},
    waitingByBranch: {},
    lastGrantedBranch: '',
    gate: Promise.resolve(),
    stagedLevelIndex: 0,
    recentRateLimits: [],
    rateMode,
    targetRequestsPerSecond,
    currentRequestsPerSecond: initialRequestsPerSecond,
    sessionRateCeiling: targetRequestsPerSecond,
    lastStableRequestsPerSecond: rateSettings.learned,
    rateWindowMs,
    rateWindowLimit: Math.max(1, Math.ceil(targetRequestsPerSecond * rateWindowMs / 1000)),
    rateLimitCooldownMs: Math.max(1000, Number(profile.rateLimitCooldownMs || 10500)),
    requestStarts: [],
    circuitOpenUntil: 0,
    rateRecoveryStreak: 0,
    rateSuccessesAtLevel: 0,
    lastRateChangeAt: Date.now(),
    rateLimitEvents: 0,
    congestionEvents: 0,
    congestionOpenUntil: 0,
    lastHealthBackoffAt: 0,
    recentAttempts: [],
    completedRequests: 0,
    requestCompletions: [],
    cacheHits: 0,
  };
}

function actualRequestCompletionRate(runtime, now = Date.now()) {
  if (!runtime) return 0;
  const windowMs = 5000;
  runtime.requestCompletions = (runtime.requestCompletions || []).filter(timestamp => timestamp >= now - windowMs);
  if (!runtime.requestCompletions.length) return 0;
  const first = Math.min(...runtime.requestCompletions);
  const observedMs = Math.max(1000, Math.min(windowMs, now - first + 250));
  return runtime.requestCompletions.length * 1000 / observedMs;
}

function getAllowedSpeedConcurrency() {
  const runtime = state.speedRuntime;
  if (!runtime) return 1;
  const profile = runtime.profile;
  if (runtime.policy === 'staged' && runtime.stagedLevels?.length) {
    return runtime.stagedLevels[Math.min(runtime.stagedLevelIndex, runtime.stagedLevels.length - 1)];
  }
  if (!runtime.adaptive) return profile.maxConcurrency;
  if (Date.now() < runtime.penaltyUntil) return runtime.minimumConcurrency;
  return runtime.successStreak >= profile.rampAfterSuccesses
    ? profile.maxConcurrency
    : profile.initialConcurrency;
}

async function acquireSpeedWorkerSlot(hasWork, branch = 'default') {
  const runtime = state.speedRuntime;
  const branchKey = String(branch || 'default');
  if (runtime) runtime.waitingByBranch[branchKey] = Number(runtime.waitingByBranch[branchKey] || 0) + 1;
  try {
    while (!state.stopRequested && hasWork()) {
      const otherBranchWaiting = runtime && Object.entries(runtime.waitingByBranch)
        .some(([key, count]) => key !== branchKey && Number(count) > 0);
      const fairTurn = !runtime || !otherBranchWaiting || runtime.lastGrantedBranch !== branchKey;
      if (!runtime || (runtime.activeWorkers < getAllowedSpeedConcurrency() && fairTurn)) {
        if (runtime) {
          runtime.activeWorkers++;
          runtime.activeByBranch[branchKey] = Number(runtime.activeByBranch[branchKey] || 0) + 1;
          runtime.lastGrantedBranch = branchKey;
        }
        return true;
      }
      await api.sleep(40);
    }
    return false;
  } finally {
    if (runtime) runtime.waitingByBranch[branchKey] = Math.max(0, Number(runtime.waitingByBranch[branchKey] || 0) - 1);
  }
}

function releaseSpeedWorkerSlot(branch = 'default') {
  const runtime = state.speedRuntime;
  if (runtime) {
    const branchKey = String(branch || 'default');
    runtime.activeWorkers = Math.max(0, runtime.activeWorkers - 1);
    runtime.activeByBranch[branchKey] = Math.max(0, Number(runtime.activeByBranch[branchKey] || 0) - 1);
  }
}

async function waitForRequestPermit() {
  const runtime = state.speedRuntime;
  if (!runtime) return;
  const previous = runtime.gate;
  const task = previous.then(async () => {
    while (!state.stopRequested) {
      const now = Date.now();
      let nextAt = Math.max(runtime.lastRequestAt + runtime.currentGapMs, runtime.pauseRequestsOnPenalty ? runtime.penaltyUntil : 0);
      if (runtime.targetRequestsPerSecond > 0) {
        const rate = Math.max(0.1, Number(runtime.currentRequestsPerSecond || runtime.targetRequestsPerSecond || 1));
        const minimumGapMs = Math.ceil(1000 / rate);
        runtime.currentGapMs = minimumGapMs;
        runtime.requestStarts = runtime.requestStarts.filter(timestamp => timestamp > now - runtime.rateWindowMs);
        const proportionalLimit = Math.max(1, Math.floor(rate * runtime.rateWindowMs / 1000));
        const windowLimit = Math.min(runtime.rateWindowLimit, proportionalLimit);
        nextAt = Math.max(nextAt, runtime.circuitOpenUntil || 0);
        if (runtime.requestStarts.length >= windowLimit) {
          nextAt = Math.max(nextAt, runtime.requestStarts[0] + runtime.rateWindowMs);
        }
      }
      const waitMs = Math.max(0, nextAt - now);
      if (!waitMs) break;
      await api.sleep(Math.min(waitMs, 250));
    }
    if (state.stopRequested) return;
    runtime.lastRequestAt = Date.now();
    if (runtime.targetRequestsPerSecond > 0) runtime.requestStarts.push(runtime.lastRequestAt);
  });
  runtime.gate = task.catch(() => {});
  await task;
}

function isSiteRateLimitAttempt(attempt) {
  if (!attempt || attempt.status !== 'network_error') return false;
  const challenge = String(attempt.metadata?.challenge || '').toLowerCase();
  return Number(attempt.statusCode || 0) === 429
    || challenge.includes('rate_limit')
    || /http\s*429|too many requests|请求过于频繁/i.test(String(attempt.error || ''));
}

function isSiteCongestionAttempt(attempt) {
  if (!attempt || attempt.status !== 'network_error') return false;
  const text = `${attempt.error || ''} ${attempt.metadata?.challenge || ''}`.toLowerCase();
  return attempt.timedOut === true
    || Number(attempt.statusCode || 0) === 403
    || /timeout|timed out|超时|econnreset|connection reset|socket hang up|aborted|cloudflare|challenge|captcha|验证/.test(text);
}

function recordSiteRateAttempt(runtime, attempt) {
  if (!runtime) return false;
  const siteKey = normalizeSpeedSite(runtime.site);
  const control = processingSpeed.getSiteRateControl(siteKey);
  const now = Date.now();
  runtime.recentAttempts.push({
    completedAt: now,
    durationMs: Math.max(0, Number(attempt?.durationMs || attempt?.metadata?.durationMs || 0)),
    networkError: attempt?.status === 'network_error',
  });
  runtime.recentAttempts = runtime.recentAttempts
    .filter(sample => Number(sample.completedAt || 0) >= now - 30000)
    .slice(-80);

  if (isSiteRateLimitAttempt(attempt)) {
    const retryAfterMs = Math.max(0, Number(attempt.metadata?.retryAfterMs || 0));
    const firstInWave = now >= Number(runtime.circuitOpenUntil || 0);
    if (firstInWave) {
      const cooldownMs = retryAfterMs || runtime.rateLimitCooldownMs;
      const failedRequestsPerSecond = Math.max(1, Number(runtime.currentRequestsPerSecond || runtime.targetRequestsPerSecond || 1));
      const fallbackRequestsPerSecond = processingSpeed.getSiteRateLimitFallback(siteKey, failedRequestsPerSecond);
      const failedSessionCeiling = processingSpeed.getSiteSessionCeilingAfterLimit(siteKey, failedRequestsPerSecond);
      runtime.circuitOpenUntil = now + cooldownMs;
      runtime.penaltyUntil = Math.max(runtime.penaltyUntil, runtime.circuitOpenUntil);
      runtime.currentRequestsPerSecond = Math.min(runtime.targetRequestsPerSecond, fallbackRequestsPerSecond);
      runtime.currentGapMs = Math.ceil(1000 / Math.max(0.1, runtime.currentRequestsPerSecond));
      if (runtime.rateMode === 'adaptive') {
        runtime.sessionRateCeiling = Math.min(runtime.sessionRateCeiling, failedSessionCeiling, runtime.targetRequestsPerSecond);
      }
      runtime.lastStableRequestsPerSecond = runtime.currentRequestsPerSecond;
      runtime.rateRecoveryStreak = 0;
      runtime.rateSuccessesAtLevel = 0;
      runtime.lastRateChangeAt = now;
      runtime.rateLimitEvents++;
      persistSiteLearnedRate(siteKey, Math.min(siteRateSettings(siteKey).learned, runtime.currentRequestsPerSecond));
      logEvent('warn', `${siteKey}_rate_limit_circuit_opened`, {
        site: siteKey,
        statusCode: Number(attempt.statusCode || 0),
        cooldownMs,
        retryAfterMs,
        rateMode: runtime.rateMode,
        failedRequestsPerSecond,
        targetRequestsPerSecond: runtime.targetRequestsPerSecond,
        nextRequestsPerSecond: runtime.currentRequestsPerSecond,
        sessionRateCeiling: runtime.sessionRateCeiling,
        queuedRequestsWillPause: true,
      });
    } else if (retryAfterMs > 0) {
      runtime.circuitOpenUntil = Math.max(runtime.circuitOpenUntil, now + retryAfterMs);
      runtime.penaltyUntil = Math.max(runtime.penaltyUntil, runtime.circuitOpenUntil);
    }
    return true;
  }

  const health = processingSpeed.summarizeRateHealth(runtime.recentAttempts, now, 15000);
  const congestionAttempt = isSiteCongestionAttempt(attempt);
  const unhealthy = processingSpeed.shouldBackoffRateHealth(siteKey, health, runtime.profile.timeoutMs);
  if (runtime.rateMode === 'adaptive'
    && (congestionAttempt || unhealthy)
    && now >= Number(runtime.congestionOpenUntil || 0)
    && now - Number(runtime.lastHealthBackoffAt || 0) >= control.congestionCooldownMs) {
    const previous = Math.max(control.minimum, Number(runtime.currentRequestsPerSecond || runtime.targetRequestsPerSecond || control.defaultLearnedRate));
    const next = processingSpeed.getSiteCongestionFallback(siteKey, previous);
    runtime.currentRequestsPerSecond = Math.min(runtime.targetRequestsPerSecond, next);
    runtime.currentGapMs = Math.ceil(1000 / Math.max(0.1, runtime.currentRequestsPerSecond));
    runtime.congestionOpenUntil = now + control.congestionCooldownMs;
    runtime.penaltyUntil = Math.max(runtime.penaltyUntil, runtime.congestionOpenUntil);
    runtime.lastHealthBackoffAt = now;
    runtime.lastRateChangeAt = now;
    runtime.rateSuccessesAtLevel = 0;
    runtime.rateRecoveryStreak = 0;
    runtime.congestionEvents++;
    persistSiteLearnedRate(siteKey, Math.min(siteRateSettings(siteKey).learned, runtime.currentRequestsPerSecond));
    logEvent('warn', `${siteKey}_request_rate_backed_off`, {
      site: siteKey,
      reason: congestionAttempt ? 'network_congestion' : 'latency_health',
      previousRequestsPerSecond: previous,
      nextRequestsPerSecond: runtime.currentRequestsPerSecond,
      targetRequestsPerSecond: runtime.targetRequestsPerSecond,
      p50DurationMs: Math.round(health.p50DurationMs),
      p95DurationMs: Math.round(health.p95DurationMs),
      errorRate: Number(health.errorRate.toFixed(3)),
      completionRate: Number(health.completionRate.toFixed(2)),
    });
  }

  if (attempt && attempt.status !== 'network_error' && Date.now() >= Number(runtime.circuitOpenUntil || 0)) {
    runtime.rateRecoveryStreak++;
    runtime.rateSuccessesAtLevel++;
    const adaptive = runtime.rateMode === 'adaptive';
    const ceiling = adaptive
      ? Math.min(runtime.targetRequestsPerSecond, runtime.sessionRateCeiling)
      : runtime.targetRequestsPerSecond;
    const requiredSuccesses = runtime.rateLimitEvents > 0
      ? control.postLimitProbeSuccesses
      : control.firstProbeSuccesses;
    const requiredStableMs = runtime.rateLimitEvents > 0
      ? control.postLimitProbeStableMs
      : control.firstProbeStableMs;
    const healthAllowsProbe = !unhealthy
      && Number(health.errorRate || 0) < 0.08
      && (!health.p95DurationMs || Number(health.p95DurationMs) < control.latencyHighWaterMs * 0.82);
    if (runtime.currentRequestsPerSecond < ceiling
      && runtime.rateSuccessesAtLevel >= requiredSuccesses
      && now - runtime.lastRateChangeAt >= requiredStableMs
      && healthAllowsProbe) {
      const previous = runtime.currentRequestsPerSecond;
      runtime.lastStableRequestsPerSecond = previous;
      persistSiteLearnedRate(siteKey, previous);
      const fullStep = processingSpeed.getSiteProbeStep(siteKey, previous);
      const step = adaptive ? fullStep : Math.max(0.25, Number((fullStep / 2).toFixed(2)));
      runtime.currentRequestsPerSecond = Math.min(ceiling, Number((previous + step).toFixed(2)));
      runtime.rateRecoveryStreak = 0;
      runtime.rateSuccessesAtLevel = 0;
      runtime.lastRateChangeAt = now;
      logEvent('info', adaptive ? `${siteKey}_request_rate_probed` : `${siteKey}_request_rate_recovered`, {
        site: siteKey,
        previousRequestsPerSecond: previous,
        nextRequestsPerSecond: runtime.currentRequestsPerSecond,
        targetRequestsPerSecond: runtime.targetRequestsPerSecond,
        sessionRateCeiling: runtime.sessionRateCeiling,
        rateMode: runtime.rateMode,
      });
    } else if (runtime.currentRequestsPerSecond >= ceiling && runtime.rateSuccessesAtLevel >= requiredSuccesses) {
      runtime.lastStableRequestsPerSecond = runtime.currentRequestsPerSecond;
      persistSiteLearnedRate(siteKey, runtime.currentRequestsPerSecond);
      runtime.rateSuccessesAtLevel = 0;
      runtime.lastRateChangeAt = now;
    }
  }
  return false;
}

function recordSpeedAttempt(attempt) {
  const runtime = state.speedRuntime;
  if (!runtime) return;
  const completedAt = Date.now();
  runtime.completedRequests = Number(runtime.completedRequests || 0) + 1;
  runtime.requestCompletions = [...(runtime.requestCompletions || []), completedAt]
    .filter(timestamp => timestamp >= completedAt - 5000)
    .slice(-200);
  const handledRateLimit = recordSiteRateAttempt(runtime, attempt);
  if (handledRateLimit) {
    state.processingTiming.concurrency = getAllowedSpeedConcurrency();
    return;
  }
  if (!runtime.adaptive) return;
  if (processingSpeed.isBackoffAttempt(attempt)) {
    runtime.successStreak = 0;
    if (runtime.site === 'av123' && runtime.policy === 'balanced' && runtime.profile.maxConcurrency >= 6) {
      runtime.currentGapMs = runtime.profile.requestGapMs;
      runtime.penaltyUntil = Date.now() + 1800;
    } else {
      runtime.currentGapMs = Math.min(2400, Math.max(450, Math.round((runtime.currentGapMs || 250) * 1.8)));
      runtime.penaltyUntil = Date.now() + Math.max(1800, runtime.currentGapMs * 3);
    }
    logEvent('warn', 'speed_auto_backoff', {
      mode: runtime.profile.key,
      site: runtime.site,
      policy: runtime.policy,
      minimumConcurrency: runtime.minimumConcurrency,
      delayMs: runtime.currentGapMs,
      statusCode: attempt.statusCode || 0,
      error: attempt.error || '',
    });
  } else {
    runtime.successStreak++;
    if (runtime.successStreak % 8 === 0) {
      runtime.currentGapMs = Math.max(runtime.profile.requestGapMs, Math.round(runtime.currentGapMs * 0.75));
    }
  }
  state.processingTiming.concurrency = getAllowedSpeedConcurrency();
}

function advance123AvStagedLevel(reason = 'retry_round') {
  const runtime = state.speedRuntime;
  if (!runtime || runtime.site !== 'av123' || runtime.policy !== 'staged' || !runtime.stagedLevels?.length) return getAllowedSpeedConcurrency();
  const previous = runtime.stagedLevelIndex;
  runtime.stagedLevelIndex = Math.min(runtime.stagedLevelIndex + 1, runtime.stagedLevels.length - 1);
  runtime.currentGapMs = Math.max(runtime.profile.requestGapMs, runtime.stagedLevelIndex >= 2 ? 160 : 70);
  const cooldownMs = runtime.stagedLevelIndex >= 2 ? 5000 : 2500;
  runtime.penaltyUntil = Math.max(runtime.penaltyUntil, Date.now() + cooldownMs);
  runtime.recentRateLimits = [];
  const concurrency = getAllowedSpeedConcurrency();
  logEvent('info', 'av123_staged_level_advanced', {
    reason,
    fromConcurrency: runtime.stagedLevels[previous],
    toConcurrency: concurrency,
    cooldownMs,
  });
  state.processingTiming.concurrency = concurrency;
  return concurrency;
}

function setForecastText(selector, value) {
  $$(selector).forEach(element => { element.textContent = value; });
}

function clearProcessingForecastTimer() {
  if (state.processingTiming.timer) window.clearInterval(state.processingTiming.timer);
  state.processingTiming.timer = null;
}

function beginProcessingForecast(total, status = 'running', profile = null, site = state.activeLookupSite) {
  const siteKey = normalizeSpeedSite(site);
  const selectedProfile = profile || processingSpeed.getSiteProfile(siteKey, speedModeForSite(siteKey));
  clearProcessingForecastTimer();
  state.processingTiming = {
    status,
    startedAt: Date.now(),
    activeItems: new Map(),
    concurrency: selectedProfile.initialConcurrency,
    speedLabel: selectedProfile.label,
    site: siteKey,
    total: Math.max(0, Number(total) || 0),
    completed: 0,
    durations: [],
    timer: window.setInterval(renderProcessingForecast, 1000),
  };
  renderProcessingForecast();
}

function markProcessingItemStarted(index) {
  state.processingTiming.activeItems.set(index, Date.now());
  renderProcessingForecast();
}

function recordProcessingItem(index, durationMs, completed) {
  const value = Number(durationMs);
  if (Number.isFinite(value) && value > 0) state.processingTiming.durations.push(value);
  state.processingTiming.completed = Math.min(state.processingTiming.total, Math.max(0, Number(completed) || 0));
  state.processingTiming.activeItems.delete(index);
  renderProcessingForecast();
}

function finishProcessingForecast(status) {
  clearProcessingForecastTimer();
  state.processingTiming.status = status;
  state.processingTiming.activeItems.clear();
  renderProcessingForecast();
}

function resetProcessingForecast() {
  clearProcessingForecastTimer();
  state.processingTiming = {
    status: 'idle',
    startedAt: 0,
    activeItems: new Map(),
    concurrency: 1,
    speedLabel: '',
    site: '',
    total: 0,
    completed: 0,
    durations: [],
    timer: null,
  };
  $$('[data-processing-forecast]').forEach(panel => { panel.hidden = true; });
}

function renderProcessingForecast() {
  const timing = state.processingTiming;
  const visible = timing.status !== 'idle';
  $$('[data-processing-forecast]').forEach(panel => { panel.hidden = !visible; });
  if (!visible || !processingEta) return;

  const now = Date.now();
  const elapsedMs = timing.startedAt ? Math.max(0, now - timing.startedAt) : 0;
  const activeStarts = [...timing.activeItems.values()];
  const currentElapsedMs = activeStarts.length ? Math.max(0, now - Math.min(...activeStarts)) : 0;
  const concurrency = state.speedRuntime ? getAllowedSpeedConcurrency() : timing.concurrency;
  timing.concurrency = concurrency;
  const averageMs = processingEta.averageDuration(timing.durations);
  const remainingMs = processingEta.estimateRemainingMs({
    total: timing.total,
    completed: timing.completed,
    durations: timing.durations,
    currentElapsedMs,
    concurrency,
  });

  let stateLabel = `${timing.completed}/${timing.total}`;
  let remainingLabel = processingEta.formatDuration(remainingMs);
  let finishLabel = remainingMs == null ? '计算中…' : processingEta.formatFinishTime(now + remainingMs, now);
  let note = timing.durations.length
    ? `${timing.speedLabel}模式 · 当前 ${concurrency} 路并发 · 根据最近 ${Math.min(20, timing.durations.length)} 条估算`
    : '完成首条记录后开始估算';
  if (['missav', 'av123'].includes(timing.site) && state.speedRuntime) {
    const currentRate = Number(state.speedRuntime.currentRequestsPerSecond || 0).toFixed(1);
    const rateCap = Number(state.speedRuntime.targetRequestsPerSecond || 0).toFixed(1);
    const itemRate = elapsedMs > 0 ? (timing.completed * 1000 / elapsedMs).toFixed(1) : '0.0';
    const actualRequestRate = actualRequestCompletionRate(state.speedRuntime, now).toFixed(1);
    const cacheHits = Number(state.speedRuntime.cacheHits || 0);
    const rateModeLabel = state.speedRuntime.rateMode === 'adaptive' ? '自动探速' : '固定目标';
    const cooldownMs = Math.max(0, Number(state.speedRuntime.circuitOpenUntil || 0) - now);
    const rateLive = timing.site === 'av123' ? DOM.av123RateLive : DOM.missavRateLive;
    note = cooldownMs > 0
      ? `${timing.speedLabel}模式 · 限流冷却剩余 ${Math.ceil(cooldownMs / 1000)} 秒 · 恢复后约 ${currentRate} 请求/秒`
      : `${timing.speedLabel}模式 · ${concurrency} 个工作路 · ${rateModeLabel} ${currentRate}/${rateCap} RPS · 实际请求 ${actualRequestRate} RPS · 番号 ${itemRate}/秒${cacheHits ? ` · 缓存 ${cacheHits}` : ''}`;
    if (rateLive) {
      rateLive.textContent = cooldownMs > 0
        ? `限流冷却 ${Math.ceil(cooldownMs / 1000)} 秒 · 恢复 ${currentRate} RPS`
        : `调度目标 ${currentRate} RPS · 实际请求 ${actualRequestRate} RPS · 番号 ${itemRate}/秒${cacheHits ? ` · 缓存 ${cacheHits}` : ''}`;
    }
  }

  if (timing.status === 'preparing') {
    stateLabel = '准备中';
    remainingLabel = '计算中…';
    finishLabel = '计算中…';
    note = '正在完成历史去重并准备处理队列';
  } else if (timing.status === 'stopping') {
    stateLabel = '正在停止';
    note = '当前网络请求结束后停止';
  } else if (timing.status === 'stopped') {
    stateLabel = '已停止';
    remainingLabel = '已停止';
    finishLabel = '—';
    note = `已完成 ${timing.completed}/${timing.total} 条`;
  } else if (timing.status === 'done') {
    stateLabel = '已完成';
    remainingLabel = '0 秒';
    finishLabel = '已完成';
    note = `本次共完成 ${timing.completed}/${timing.total} 条`;
  }

  setForecastText('[data-eta-state]', stateLabel);
  const siteLabel = timing.site === 'missav' ? 'MissAV ' : timing.site === 'av123' ? '123AV ' : timing.site === 'favorite' ? '123AV 收藏' : '当前站点';
  setForecastText('[data-eta-site]', siteLabel);
  setForecastText('[data-eta-remaining]', remainingLabel);
  setForecastText('[data-eta-finish]', finishLabel);
  setForecastText('[data-eta-elapsed]', processingEta.formatDuration(elapsedMs));
  setForecastText('[data-eta-average]', averageMs == null ? '计算中…' : processingEta.formatDuration(averageMs));
  setForecastText('[data-eta-note]', note);
  const siteTiming = timing.site === 'missav' ? DOM.runMissavTiming : timing.site === 'av123' ? DOM.run123AvTiming : null;
  if (siteTiming) {
    const rateLabel = ['missav', 'av123'].includes(timing.site) && state.speedRuntime
      ? ` · ${Number(state.speedRuntime.currentRequestsPerSecond || 0).toFixed(1)} 请求/秒`
      : '';
    siteTiming.textContent = `${stateLabel} · 预计剩余 ${remainingLabel} · 当前 ${concurrency} 路${rateLabel}`;
  }
}

// ─── 表格渲染 ────────────────────────────────────────
const RESULT_STAGE_KEYS = ['missavLookup', 'raindropSync', 'av123Lookup', 'av123Favorite'];
const RESULT_WORKSPACES = {
  missav: {
    key: 'missav',
    title: 'MissAV 处理结果',
    stages: ['missavLookup', 'raindropSync'],
    lookupStage: 'missavLookup',
    stageOptions: [['missavLookup', 'MissAV 查询'], ['raindropSync', 'Raindrop 同步']],
    tabs: [['all', '全部'], ['new', '新增'], ['skipped', '已跳过'], ['manual', '需核验']],
    sortOptions: [['original', '原始顺序'], ['code_asc', '番号 A-Z'], ['code_desc', '番号 Z-A'], ['status_asc', '状态排序'], ['status_desc', '状态倒序'], ['tag_asc', '标签排序'], ['tag_desc', '标签倒序']],
    searchPlaceholder: '搜索番号、MissAV 链接、状态、标签或备注',
    sheetKey: 'processing-results-missav-v1',
  },
  av123: {
    key: 'av123',
    title: '123AV 处理结果',
    stages: ['av123Lookup', 'av123Favorite'],
    lookupStage: 'av123Lookup',
    stageOptions: [['av123Lookup', '123AV 查询'], ['av123Favorite', '123AV 收藏']],
    tabs: [['all', '全部'], ['found', '已查到'], ['not_found', '未找到'], ['attention', '异常']],
    sortOptions: [['original', '原始顺序'], ['code_asc', '番号 A-Z'], ['code_desc', '番号 Z-A'], ['status_asc', '状态排序'], ['status_desc', '状态倒序']],
    searchPlaceholder: '搜索番号、123AV 链接、状态或备注',
    sheetKey: 'processing-results-123av-v1',
  },
};

function activeResultWorkspace() {
  return RESULT_WORKSPACES[state.resultWorkspace] || RESULT_WORKSPACES.missav;
}

function render123AvAccountState() {
  if (!DOM.av123AccountPanel) return;
  const account = state.av123Account || {};
  const status = String(account.status || 'unknown');
  const labels = {
    unknown: '未检查',
    checking: '检查中',
    ready: '已登录',
    running: '正在执行',
    not_logged_in: '未登录',
    manual: '需要人工验证',
    network_error: '网络异常',
  };
  const statusLabel = labels[status] || '状态未知';
  const fallbackDetail = state.av123FavoriteMethod === 'app'
    ? 'APP 内独立账号窗口 · 固定 1 路串行'
    : state.av123FavoriteMethod === 'export'
      ? '仅生成 TXT / CSV，不访问账号'
      : '收藏使用本地 Chrome 已登录账号';
  const detail = account.detail || (account.accountLabel ? `账号 ${account.accountLabel}` : fallbackDetail);
  DOM.av123AccountStatus.textContent = statusLabel;
  DOM.av123AccountDetail.textContent = detail;
  if (DOM.siteAv123AccountStatus) DOM.siteAv123AccountStatus.textContent = statusLabel;
  if (DOM.siteAv123AccountDetail) DOM.siteAv123AccountDetail.textContent = detail;
  DOM.av123AccountPanel.dataset.state = status === 'ready'
    ? 'ready'
    : status === 'running' || status === 'checking'
      ? 'running'
      : ['network_error', 'not_logged_in'].includes(status) ? 'error' : 'attention';
  const av123Busy = Boolean(state.favoriteRuntime?.running) || (state.isProcessing && state.activeLookupSite === 'av123');
  if (DOM.btnOpen123AvAccount) DOM.btnOpen123AvAccount.disabled = av123Busy;
  if (DOM.btnCheck123AvAccount) DOM.btnCheck123AvAccount.disabled = av123Busy || status === 'checking';
  if (DOM.btnOpen123AvAccountSite) DOM.btnOpen123AvAccountSite.disabled = av123Busy;
  if (DOM.btnCheck123AvAccountSite) DOM.btnCheck123AvAccountSite.disabled = av123Busy || status === 'checking';
}

function set123AvAccountState(result = {}, fallbackStatus = 'unknown') {
  const status = String(result.status || fallbackStatus);
  const accountLabel = String(result.metadata?.accountLabel || state.av123Account?.accountLabel || '').trim();
  const fallbackDetail = state.av123FavoriteMethod === 'app'
    ? 'APP 内独立账号窗口 · 固定 1 路串行'
    : state.av123FavoriteMethod === 'export'
      ? '仅生成 TXT / CSV，不访问账号'
      : '收藏使用本地 Chrome 已登录账号';
  const detail = accountLabel
    ? `当前账号 ${accountLabel}`
    : String(result.error || '').trim() || (status === 'checking' ? `正在读取${state.av123FavoriteMethod === 'app' ? ' APP 账号窗口' : '本地 Chrome'}中的可见登录状态` : fallbackDetail);
  state.av123Account = { status, accountLabel, detail };
  render123AvAccountState();
}

function updateResultExportVisibility() {
  if (!DOM.exportBar) return;
  DOM.exportBar.style.display = state.resultWorkspace === 'missav' && state.results.length && !state.isProcessing ? 'flex' : 'none';
}

function configureResultWorkspaceControls() {
  const workspace = activeResultWorkspace();
  DOM.resultWorkspaceButtons?.forEach(button => {
    const active = button.dataset.resultWorkspace === workspace.key;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  if (DOM.resultWorkspaceTitle) DOM.resultWorkspaceTitle.textContent = workspace.title;
  if (DOM.resultSearch) DOM.resultSearch.placeholder = workspace.searchPlaceholder;
  if (DOM.resultTagFilter) DOM.resultTagFilter.hidden = workspace.key !== 'missav';
  if (DOM.av123AccountPanel) DOM.av123AccountPanel.hidden = workspace.key !== 'av123' || state.av123FavoriteMethod === 'export';
  render123AvAccountState();

  const stageSignature = workspace.stageOptions.map(option => option[0]).join('|');
  if (DOM.resultStageFilter?.dataset.workspace !== stageSignature) {
    DOM.resultStageFilter.innerHTML = workspace.stageOptions
      .map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`)
      .join('');
    DOM.resultStageFilter.dataset.workspace = stageSignature;
  }
  const selectedStage = state.resultStageByWorkspace[workspace.key];
  DOM.resultStageFilter.value = workspace.stages.includes(selectedStage) ? selectedStage : workspace.lookupStage;
  if (DOM.resultStatusFilter) DOM.resultStatusFilter.value = state.resultStatusByWorkspace[workspace.key] || 'all';

  const sortSignature = workspace.sortOptions.map(option => option[0]).join('|');
  if (DOM.resultSort?.dataset.workspace !== sortSignature) {
    DOM.resultSort.innerHTML = workspace.sortOptions
      .map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`)
      .join('');
    DOM.resultSort.dataset.workspace = sortSignature;
  }
  const selectedSort = state.resultSortByWorkspace[workspace.key];
  DOM.resultSort.value = workspace.sortOptions.some(option => option[0] === selectedSort) ? selectedSort : 'original';

  const tabSignature = workspace.tabs.map(tab => tab[0]).join('|');
  if (DOM.resultTabs?.dataset.workspace !== tabSignature) {
    DOM.resultTabs.innerHTML = workspace.tabs
      .map(([value, label]) => `<button class="tab-btn" data-tab="${esc(value)}">${esc(label)}</button>`)
      .join('');
    DOM.resultTabs.dataset.workspace = tabSignature;
  }
  if (!workspace.tabs.some(tab => tab[0] === state.activeTab)) {
    state.activeTab = 'all';
    state.resultTabByWorkspace[workspace.key] = 'all';
  }
  DOM.resultTabs?.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === state.activeTab));
  updateResultExportVisibility();
}

function switchResultWorkspace(workspace) {
  const next = RESULT_WORKSPACES[workspace] ? workspace : 'missav';
  if (next === state.resultWorkspace) return;
  state.resultTabByWorkspace[state.resultWorkspace] = state.activeTab;
  state.resultStatusByWorkspace[state.resultWorkspace] = DOM.resultStatusFilter?.value || 'all';
  state.resultSortByWorkspace[state.resultWorkspace] = DOM.resultSort?.value || 'original';
  state.resultWorkspace = next;
  state.activeTab = state.resultTabByWorkspace[next] || 'all';
  state.resultSelectionAnchor = null;
  configureResultWorkspaceControls();
  renderTable();
}

function renderResultTableHead() {
  const workspace = activeResultWorkspace();
  if (DOM.resultTableHead?.dataset.workspace === workspace.key) return;
  const sharedStart = `<tr>
    <th class="col-select"><input type="checkbox" id="resultSelectVisible" aria-label="选择当前显示记录"></th>
    <th class="col-code"><button class="sheet-sort-button" data-result-sort-key="code">番号</button></th>`;
  DOM.resultTableHead.innerHTML = workspace.key === 'missav'
    ? `${sharedStart}
      <th class="col-task"><button class="sheet-sort-button" data-result-sort-key="status">MissAV 查询</button></th>
      <th class="col-task">Raindrop 同步</th>
      <th class="col-actress">女优 Tag</th>
      <th class="col-genre">类型 Tag</th>
      <th class="col-final"><button class="sheet-sort-button" data-result-sort-key="tag">最终 Tags</button></th>
      <th class="col-note">MissAV 错误 / 备注</th>
    </tr>`
    : `${sharedStart}
      <th class="col-task"><button class="sheet-sort-button" data-result-sort-key="status">123AV 查询</button></th>
      <th class="col-task">123AV 收藏</th>
      <th class="col-note">123AV 错误 / 备注</th>
    </tr>`;
  DOM.resultTableHead.dataset.workspace = workspace.key;
  DOM.resultTable.dataset.sheetKey = workspace.sheetKey;
  DOM.resultSelectVisible = $('#resultSelectVisible');
}

function derivedMissavTask(row) {
  const status = String(row?.status || '');
  if (status === 'queued' || status === 'processing_stopped') return { status: 'queued', url: row?.url || '', error: row?.error || '' };
  if (status === 'running') return { status: 'running', url: row?.url || '', error: row?.error || '' };
  if (['ok', 'no_actress_found', 'already_exists'].includes(status)) return { status: 'succeeded', url: row?.url || '', error: row?.error || '' };
  if (status === 'not_found') return { status: 'not_found', url: row?.url || '', error: row?.error || '' };
  if (status === 'network_error') return { status: 'network_error', url: row?.url || '', error: row?.error || row?.skippedReason || '' };
  if (['need_manual_check', 'page_ok_play_unknown'].includes(status)) return { status: 'manual', url: row?.url || '', error: row?.error || row?.skippedReason || '' };
  if (['duplicate_in_input'].includes(status)) return { status: 'skipped', url: '', error: row?.skippedReason || '' };
  return { status: status ? 'skipped' : 'not_configured', url: row?.url || '', error: row?.error || '' };
}

function resultTask(row, key) {
  const task = row?.tasks?.[key];
  if (task) return task;
  return key === 'missavLookup'
    ? derivedMissavTask(row)
    : { status: 'not_configured', url: '', error: '' };
}

function taskStatusLabel(task, key) {
  const status = String(task?.status || 'not_configured');
  if (status === 'queued') return '等待执行';
  if (status === 'running') return '执行中';
  if (status === 'ready') {
    if (key === 'raindropSync') return '待同步';
    if (key === 'av123Favorite') return '待收藏';
    return '已准备';
  }
  if (status === 'succeeded') {
    if (key === 'raindropSync') return '已同步';
    if (key === 'av123Favorite') return '已收藏';
    return '已查到';
  }
  if (status === 'not_found') return '未找到';
  if (status === 'network_error') return '网络错误';
  if (status === 'manual') return '需人工核验';
  if (status === 'not_logged_in') return '账号未登录';
  if (status === 'blocked') {
    if (key === 'raindropSync') return '等待 MissAV';
    if (key === 'av123Favorite') return '等待 123AV';
    return '等待前序';
  }
  if (status === 'verify_required') return '需核对远端';
  if (status === 'failed') return '执行失败';
  if (status === 'skipped') return '无需执行';
  return '旧版未启用';
}

function taskStatusClass(task) {
  const status = String(task?.status || 'not_configured');
  if (status === 'succeeded') return 'is-succeeded';
  if (status === 'running') return 'is-running';
  if (status === 'ready') return 'is-ready';
  if (status === 'not_found') return 'is-not-found';
  if (['network_error', 'not_logged_in', 'failed'].includes(status)) return 'is-error';
  if (['manual', 'verify_required'].includes(status)) return 'is-attention';
  if (status === 'blocked') return 'is-blocked';
  if (status === 'queued') return 'is-queued';
  return 'is-skipped';
}

function lookupStageSummary(key) {
  const tasks = state.results
    .map(row => resultTask(row, key))
    .filter(task => task.status !== 'not_configured');
  if (tasks.length) {
    const completedStatuses = new Set(['succeeded', 'not_found', 'network_error', 'manual', 'not_logged_in', 'failed', 'skipped', 'verify_required']);
    const completed = tasks.filter(task => completedStatuses.has(task.status)).length;
    const exceptions = tasks.filter(task => ['network_error', 'manual', 'not_logged_in', 'failed', 'verify_required'].includes(task.status)).length;
    return {
      label: `完成 ${completed}/${tasks.length} · 异常 ${exceptions}`,
      active: tasks.some(task => task.status === 'running'),
      complete: completed === tasks.length,
    };
  }
  const stage = state.resumableRun?.stages?.[key];
  if (stage?.total) {
    return {
      label: `完成 ${stage.completed}/${stage.total} · 异常 ${stage.exceptions}`,
      active: Boolean(stage.running),
      complete: stage.completed === stage.total,
    };
  }
  return { label: '等待批次', active: false, complete: false };
}

function updateOperationSummaries() {
  const missav = lookupStageSummary('missavLookup');
  const av123 = lookupStageSummary('av123Lookup');
  if (DOM.runMissavStageSummary) DOM.runMissavStageSummary.textContent = missav.label;
  if (DOM.run123AvStageSummary) DOM.run123AvStageSummary.textContent = av123.label;
  if (DOM.resultMissavWorkspaceSummary) DOM.resultMissavWorkspaceSummary.textContent = missav.label;
  if (DOM.result123AvWorkspaceSummary) DOM.result123AvWorkspaceSummary.textContent = av123.label;
  if (DOM.siteMissavCatalogSummary) DOM.siteMissavCatalogSummary.textContent = missav.label;
  if (DOM.site123AvCatalogSummary) DOM.site123AvCatalogSummary.textContent = av123.label;
  if (DOM.siteBatchCatalogSummary) {
    const batch = preparedRunForControls() || state.resumableRun;
    DOM.siteBatchCatalogSummary.textContent = batch ? `批次 #${batch.id} · ${batch.total || 0} 条` : `${state.inputCodes.length} 条输入`;
  }
  DOM.siteOperationCards?.forEach(card => {
    const summary = card.dataset.siteOperation === 'av123' ? av123 : missav;
    card.classList.toggle('is-active', summary.active);
    card.classList.toggle('is-complete', summary.complete);
  });
}

function renderTaskCell(row, key, context = 'result', resultIndex = -1) {
  const task = resultTask(row, key);
  const url = String(task.url || (key === 'missavLookup' ? row?.url || '' : '')).trim();
  const error = String(task.error || '').trim();
  const link = url
    ? context === 'result'
      ? `<button class="task-icon-button" data-result-url="${esc(url)}" title="打开页面" aria-label="打开 ${esc(key)} 页面"><i data-lucide="external-link"></i></button>`
      : `<button class="task-icon-button" data-action="open-url" data-url="${esc(url)}" title="打开页面" aria-label="打开 ${esc(key)} 页面"><i data-lucide="external-link"></i></button>`
    : '';
  const retry = context === 'result' && ['missavLookup', 'av123Lookup'].includes(key) && task.status === 'network_error'
    ? `<button class="task-icon-button is-warning" data-result-retry-index="${Number(resultIndex)}" data-result-retry-stage="${esc(key)}" title="重新运行 ${key === 'av123Lookup' ? '123AV' : 'MissAV'} 查询" aria-label="重新运行 ${key === 'av123Lookup' ? '123AV' : 'MissAV'} 查询"><i data-lucide="refresh-cw"></i></button>`
    : '';
  const favoriteAction = context === 'result' && key === 'av123Favorite' && ['ready', 'network_error', 'manual', 'not_logged_in', 'failed'].includes(task.status)
    ? `<button class="task-icon-button is-success" data-result-favorite-index="${Number(resultIndex)}" title="收藏到 123AV 账号" aria-label="收藏 ${esc(row?.code || '')}"><i data-lucide="bookmark-plus"></i></button>`
    : context === 'result' && key === 'av123Favorite' && task.status === 'verify_required'
      ? `<button class="task-icon-button is-warning" data-result-verify-index="${Number(resultIndex)}" title="只核对远端收藏状态" aria-label="复查 ${esc(row?.code || '')}"><i data-lucide="scan-search"></i></button>`
      : '';
  return `<div class="workflow-task-cell" title="${esc(error || taskStatusLabel(task, key))}">
    <span class="workflow-task-status ${taskStatusClass(task)}">${esc(taskStatusLabel(task, key))}</span>
    ${link || retry || favoriteAction ? `<span class="workflow-task-actions">${link}${retry}${favoriteAction}</span>` : ''}
  </div>`;
}

function workflowTaskErrors(row, stageKeys = RESULT_STAGE_KEYS, includeRowError = true) {
  const errors = stageKeys.map(key => {
    const task = resultTask(row, key);
    return task.error ? `${taskStatusLabel(task, key)}: ${task.error}` : '';
  }).filter(Boolean);
  const rowErrors = includeRowError ? [row?.error, row?.skippedReason] : [];
  return [...new Set([...rowErrors, ...errors].map(value => String(value || '').trim()).filter(Boolean))].join(' | ');
}

function renderTable() {
  configureResultWorkspaceControls();
  renderResultTableHead();
  updateOperationSummaries();
  state.resultSelected = new Set([...state.resultSelected].filter(index => state.results[index]));
  refreshResultTagOptions();
  const entries = getFilteredResultEntries();
  const workspace = activeResultWorkspace();
  const columnCount = workspace.key === 'missav' ? 8 : 5;
  if (!entries.length) {
    DOM.resultBody.innerHTML = `<tr class="empty-row"><td colspan="${columnCount}"><div class="empty-state visual-empty-state"><span class="empty-icon">M</span><p>${state.results.length ? '当前筛选范围没有记录' : '输入番号后，在处理页选择要启动的站点'}</p></div></td></tr>`;
    updateResultSelectionUi(entries);
    window.SheetTable?.enhanceTable(DOM.resultTable);
    renderIcons();
    return;
  }
  DOM.resultBody.innerHTML = entries.map(({ row: r, index }) => {
    const note = workflowTaskErrors(r, workspace.stages, workspace.key === 'missav');
    const sharedStart = `
    <tr data-result-index="${index}" class="${state.resultSelected.has(index) ? 'is-selected' : ''}" aria-selected="${state.resultSelected.has(index) ? 'true' : 'false'}">
      <td class="col-select"><input type="checkbox" data-result-select-row="${index}" aria-label="选择 ${esc(r.code)}" ${state.resultSelected.has(index) ? 'checked' : ''}></td>
      <td class="col-code">${esc(r.code)}</td>`;
    if (workspace.key === 'av123') return `${sharedStart}
      <td class="col-task">${renderTaskCell(r, 'av123Lookup', 'result', index)}</td>
      <td class="col-task">${renderTaskCell(r, 'av123Favorite', 'result', index)}</td>
      <td class="col-note" title="${esc(note)}">${esc(note || '-')}</td>
    </tr>`;
    return `${sharedStart}
      <td class="col-task">${renderTaskCell(r, 'missavLookup', 'result', index)}</td>
      <td class="col-task">${renderTaskCell(r, 'raindropSync', 'result', index)}</td>
      <td class="col-actress">${(r.actresses||[]).map(t => `<span class="tag-chip">${esc(t)}</span>`).join('') || '-'}</td>
      <td class="col-genre">${(r.genres||[]).map(t => `<span class="tag-chip">${esc(t)}</span>`).join('') || '-'}</td>
      <td class="col-final">${(r.finalTags || []).map(t => {
        let cls = 'tag-chip';
        if (t === api.UNKNOWN_ACTRESS_TAG) cls += ' tag-unknown';
        if (t === api.NEED_CHECK_TAG) cls += ' tag-needcheck';
        return `<span class="${cls}">${esc(t)}</span>`;
      }).join('') || '-'}</td>
      <td class="col-note" title="${esc(note)}">${esc(note || '-')}</td>
    </tr>`;
  }).join('');
  updateResultSelectionUi(entries);
  window.SheetTable?.enhanceTable(DOM.resultTable);
  renderIcons();
}

async function handleResultTableClick(event) {
  const favoriteButton = event.target.closest('[data-result-favorite-index]');
  if (favoriteButton) {
    event.preventDefault();
    event.stopPropagation();
    await run123AvFavoriteIndexes([Number(favoriteButton.dataset.resultFavoriteIndex)]);
    return;
  }
  const verifyButton = event.target.closest('[data-result-verify-index]');
  if (verifyButton) {
    event.preventDefault();
    event.stopPropagation();
    await run123AvFavoriteIndexes([Number(verifyButton.dataset.resultVerifyIndex)], { verifyOnly: true });
    return;
  }
  const retryButton = event.target.closest('[data-result-retry-index]');
  if (retryButton) {
    event.preventDefault();
    event.stopPropagation();
    await retryNetworkErrorsForStage([Number(retryButton.dataset.resultRetryIndex)], retryButton.dataset.resultRetryStage);
    return;
  }
  const link = event.target.closest('[data-result-url]');
  if (link) {
    event.preventDefault();
    try {
      await api.openExternal(link.dataset.resultUrl);
    } catch (err) {
      toast(`无法打开链接: ${err.message}`, 'error');
    }
    return;
  }

  const row = event.target.closest('[data-result-index]');
  if (!row || event.target.closest('button, a, select, textarea')) return;
  const clickedIndex = Number(row.dataset.resultIndex);
  const checkbox = event.target.closest('[data-result-select-row]');
  const entries = getFilteredResultEntries();
  const selection = window.ExplorerSelection?.applySelection({
    orderedIds: entries.map(entry => entry.index),
    selectedIds: [...state.resultSelected],
    clickedId: clickedIndex,
    anchorId: state.resultSelectionAnchor,
    ctrlKey: checkbox ? true : Boolean(event.ctrlKey || event.metaKey),
    shiftKey: Boolean(event.shiftKey),
  }) || { selectedIds: [clickedIndex], anchorId: clickedIndex };
  state.resultSelected = new Set(selection.selectedIds);
  state.resultSelectionAnchor = selection.anchorId;
  updateResultSelectionUi(entries);
}

function refreshResultTagOptions() {
  if (!DOM.resultTagFilter) return;
  const tags = [...new Set(state.results.flatMap(row => row.finalTags || []).map(tag => String(tag || '').trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'zh-CN', { numeric: true, sensitivity: 'base' }));
  const signature = tags.join('\u0001');
  if (DOM.resultTagFilter.dataset.signature === signature) return;
  const selected = DOM.resultTagFilter.value;
  DOM.resultTagFilter.innerHTML = `<option value="all">全部标签 (${tags.length})</option>${tags.map(tag => `<option value="${esc(tag)}">${esc(tag)}</option>`).join('')}`;
  DOM.resultTagFilter.value = tags.includes(selected) ? selected : 'all';
  DOM.resultTagFilter.dataset.signature = signature;
}

function resultMatchesActiveTab(row) {
  if (state.resultWorkspace === 'av123') {
    const status = resultTask(row, 'av123Lookup').status;
    if (state.activeTab === 'found') return status === 'succeeded';
    if (state.activeTab === 'not_found') return status === 'not_found';
    if (state.activeTab === 'attention') return RESULT_WORKSPACES.av123.stages.some(key =>
      ['network_error', 'manual', 'not_logged_in', 'failed', 'verify_required'].includes(resultTask(row, key).status));
    return true;
  }
  switch (state.activeTab) {
    case 'new': return row.includeInImport && !api.isManualVerifyRow(row);
    case 'skipped': return !row.includeInImport;
    case 'manual': return row.includeInImport && api.isManualVerifyRow(row);
    default: return true;
  }
}

function resultMatchesStatus(row, status, stageKey = 'missavLookup') {
  if (!status || status === 'all') return true;
  return resultTask(row, stageKey).status === status;
}

function getFilteredResultEntries() {
  const workspace = activeResultWorkspace();
  const query = String(DOM.resultSearch?.value || '').trim().toLowerCase();
  const status = DOM.resultStatusFilter?.value || 'all';
  const stageKey = workspace.stages.includes(DOM.resultStageFilter?.value) ? DOM.resultStageFilter.value : workspace.lookupStage;
  const tag = DOM.resultTagFilter?.value || 'all';
  const sort = DOM.resultSort?.value || 'original';
  const entries = state.results.map((row, index) => ({ row, index })).filter(({ row }) => {
    if (!resultMatchesActiveTab(row) || !resultMatchesStatus(row, status, stageKey)) return false;
    if (workspace.key === 'missav' && tag !== 'all' && !(row.finalTags || []).includes(tag)) return false;
    if (!query) return true;
    const taskSearch = workspace.stages.flatMap(key => {
      const task = resultTask(row, key);
      return [task.status, taskStatusLabel(task, key), task.url, task.error];
    });
    const workspaceFields = workspace.key === 'missav'
      ? [row.url, row.status, statusLabel(row), ...(row.actresses || []), ...(row.genres || []), ...(row.finalTags || []), row.skippedReason]
      : [];
    return [row.code, ...workspaceFields, ...taskSearch]
      .join(' ').toLowerCase().includes(query);
  });
  if (sort === 'original') return entries;
  const descending = sort.endsWith('_desc');
  const key = sort.replace(/_(asc|desc)$/, '');
  const value = entry => key === 'code'
    ? entry.row.code
    : key === 'status'
      ? taskStatusLabel(resultTask(entry.row, stageKey), stageKey)
      : (entry.row.finalTags || []).join(',');
  return entries.sort((left, right) => {
    const compared = String(value(left) || '').localeCompare(String(value(right) || ''), 'zh-CN', { numeric: true, sensitivity: 'base' });
    return (descending ? -compared : compared) || left.index - right.index;
  });
}

function getFilteredResults() {
  return getFilteredResultEntries().map(entry => entry.row);
}

function activeRetryStageKey() {
  const stage = DOM.resultStageFilter?.value;
  return ['missavLookup', 'av123Lookup'].includes(stage) ? stage : null;
}

function networkErrorIndexesForStage(stageKey = activeRetryStageKey()) {
  if (!stageKey) return [];
  return state.results
    .map((row, index) => resultTask(row, stageKey).status === 'network_error' ? index : -1)
    .filter(index => index >= 0);
}

async function retryNetworkErrorsForStage(indexes, requestedStage = activeRetryStageKey()) {
  if (!requestedStage) { toast('当前环节没有可重跑的网络查询', 'info'); return; }
  const stageKey = requestedStage === 'av123Lookup' ? 'av123Lookup' : 'missavLookup';
  if (stageKey === 'av123Lookup') return retry123AvResultIndexes(indexes);
  return retryResultIndexes(indexes);
}

function favoriteActionIndexes(statuses = ['ready', 'network_error', 'manual', 'not_logged_in', 'failed']) {
  const allowed = new Set(statuses);
  return state.results
    .map((row, index) => allowed.has(resultTask(row, 'av123Favorite').status) ? index : -1)
    .filter(index => index >= 0);
}

function updateResultSelectionUi(entries = getFilteredResultEntries()) {
  const selectedCount = state.resultSelected.size;
  const visibleIds = entries.map(entry => entry.index);
  const visibleSelected = visibleIds.filter(index => state.resultSelected.has(index)).length;
  const retryStage = activeRetryStageKey();
  const retryLabel = retryStage === 'av123Lookup' ? '123AV' : 'MissAV';
  const selectedNetworkCount = retryStage
    ? [...state.resultSelected].filter(index => resultTask(state.results[index], retryStage).status === 'network_error').length
    : 0;
  const allNetworkCount = networkErrorIndexesForStage(retryStage).length;
  const is123AvWorkspace = state.resultWorkspace === 'av123';
  const exportMethod = state.av123FavoriteMethod === 'export';
  const favoriteStatuses = new Set(['ready', 'network_error', 'manual', 'not_logged_in', 'failed']);
  const selectedFavoriteCount = [...state.resultSelected]
    .filter(index => favoriteStatuses.has(resultTask(state.results[index], 'av123Favorite').status)).length;
  const allReadyFavoriteCount = favoriteActionIndexes(['ready']).length;
  const selectedVerifyCount = [...state.resultSelected]
    .filter(index => resultTask(state.results[index], 'av123Favorite').status === 'verify_required').length;
  const allVerifyCount = favoriteActionIndexes(['verify_required']).length;
  DOM.resultBody?.querySelectorAll('[data-result-index]').forEach(row => {
    const index = Number(row.dataset.resultIndex);
    const selected = state.resultSelected.has(index);
    row.classList.toggle('is-selected', selected);
    row.setAttribute('aria-selected', selected ? 'true' : 'false');
    const checkbox = row.querySelector('[data-result-select-row]');
    if (checkbox) checkbox.checked = selected;
  });
  if (DOM.resultSelectVisible) {
    DOM.resultSelectVisible.checked = visibleIds.length > 0 && visibleSelected === visibleIds.length;
    DOM.resultSelectVisible.indeterminate = visibleSelected > 0 && visibleSelected < visibleIds.length;
  }
  if (DOM.resultRangeSummary) DOM.resultRangeSummary.textContent = retryStage
    ? `显示 ${entries.length}/${state.results.length} 条 · 已选 ${selectedCount} 条 · ${retryLabel} 网络错误 ${allNetworkCount} 条`
    : `显示 ${entries.length}/${state.results.length} 条 · 已选 ${selectedCount} 条`;
  if (DOM.btnSelectVisibleResults) DOM.btnSelectVisibleResults.disabled = state.isProcessing || !visibleIds.length;
  if (DOM.btnClearResultSelection) DOM.btnClearResultSelection.disabled = !selectedCount;
  if (DOM.btnCopyResultTSV) DOM.btnCopyResultTSV.disabled = !entries.length && !selectedCount;
  if (DOM.btnRetrySelectedResults) {
    DOM.btnRetrySelectedResults.hidden = !retryStage;
    DOM.btnRetrySelectedResults.disabled = state.isProcessing || !selectedNetworkCount;
    DOM.btnRetrySelectedResults.textContent = selectedNetworkCount ? `重跑选中 ${retryLabel} (${selectedNetworkCount})` : `重跑选中 ${retryLabel}`;
  }
  if (DOM.btnRetryAllNetworkResults) {
    DOM.btnRetryAllNetworkResults.hidden = !retryStage;
    DOM.btnRetryAllNetworkResults.disabled = state.isProcessing || !allNetworkCount;
    DOM.btnRetryAllNetworkResults.textContent = allNetworkCount ? `重跑全部 ${retryLabel} (${allNetworkCount})` : `重跑全部 ${retryLabel}`;
  }
  if (DOM.btnFavoriteSelected123Av) {
    DOM.btnFavoriteSelected123Av.hidden = !is123AvWorkspace || Boolean(state.activeAccountAction);
    DOM.btnFavoriteSelected123Av.disabled = Boolean(state.favoriteRuntime?.running) || (state.isProcessing && state.activeLookupSite === 'av123') || !selectedFavoriteCount;
    const actionLabel = exportMethod ? '导出所选' : '收藏所选';
    DOM.btnFavoriteSelected123Av.querySelector('span').textContent = selectedFavoriteCount ? `${actionLabel} (${selectedFavoriteCount})` : actionLabel;
  }
  if (DOM.btnFavoriteAll123Av) {
    DOM.btnFavoriteAll123Av.hidden = !is123AvWorkspace || Boolean(state.activeAccountAction);
    DOM.btnFavoriteAll123Av.disabled = Boolean(state.favoriteRuntime?.running) || (state.isProcessing && state.activeLookupSite === 'av123') || !allReadyFavoriteCount;
    const actionLabel = exportMethod ? '导出全部待收藏' : '收藏全部待收藏';
    DOM.btnFavoriteAll123Av.querySelector('span').textContent = allReadyFavoriteCount ? `${actionLabel} (${allReadyFavoriteCount})` : actionLabel;
  }
  if (DOM.btnVerifySelected123Av) {
    DOM.btnVerifySelected123Av.hidden = exportMethod || !is123AvWorkspace || Boolean(state.activeAccountAction);
    DOM.btnVerifySelected123Av.disabled = Boolean(state.favoriteRuntime?.running) || (state.isProcessing && state.activeLookupSite === 'av123') || !selectedVerifyCount;
    DOM.btnVerifySelected123Av.querySelector('span').textContent = selectedVerifyCount ? `复查所选 (${selectedVerifyCount})` : '复查所选';
  }
  if (DOM.btnVerifyAll123Av) {
    DOM.btnVerifyAll123Av.hidden = exportMethod || !is123AvWorkspace || Boolean(state.activeAccountAction);
    DOM.btnVerifyAll123Av.disabled = Boolean(state.favoriteRuntime?.running) || (state.isProcessing && state.activeLookupSite === 'av123') || !allVerifyCount;
    DOM.btnVerifyAll123Av.querySelector('span').textContent = allVerifyCount ? `复查全部待核对 (${allVerifyCount})` : '复查全部待核对';
  }
  if (DOM.btnStop123AvFavorite) DOM.btnStop123AvFavorite.hidden = !is123AvWorkspace || !state.favoriteRuntime?.running;
  if (DOM.btnExportCurrent) DOM.btnExportCurrent.disabled = !entries.length && !selectedCount;
  if (DOM.btnExportByTags) DOM.btnExportByTags.disabled = !entries.length && !selectedCount;
}

function selectVisibleResults() {
  getFilteredResultEntries().forEach(entry => state.resultSelected.add(entry.index));
  updateResultSelectionUi();
}

function toggleVisibleResultSelection() {
  const entries = getFilteredResultEntries();
  const allSelected = entries.length > 0 && entries.every(entry => state.resultSelected.has(entry.index));
  entries.forEach(entry => allSelected ? state.resultSelected.delete(entry.index) : state.resultSelected.add(entry.index));
  updateResultSelectionUi(entries);
}

function clearResultSelection() {
  state.resultSelected.clear();
  state.resultSelectionAnchor = null;
  updateResultSelectionUi();
}

function getResultScopeRows() {
  if (state.resultSelected.size) return [...state.resultSelected].sort((a, b) => a - b).map(index => state.results[index]).filter(Boolean);
  return getFilteredResults();
}

async function copyResultTSV() {
  const rows = getResultScopeRows();
  if (!rows.length) { toast('当前没有可复制的结果', 'error'); return; }
  if (state.resultWorkspace === 'av123') {
    const tableRows = rows.map(row => [
      row.code,
      taskStatusLabel(resultTask(row, 'av123Lookup'), 'av123Lookup'),
      resultTask(row, 'av123Lookup').url || '',
      taskStatusLabel(resultTask(row, 'av123Favorite'), 'av123Favorite'),
      workflowTaskErrors(row, RESULT_WORKSPACES.av123.stages, false),
    ]);
    const text = window.SheetTable.rowsToTSV(['番号', '123AV 查询', '123AV 链接', '123AV 收藏', '123AV 错误 / 备注'], tableRows);
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制 ${rows.length} 行 123AV 结果，可直接粘贴到 Excel/WPS`, 'success');
    } catch (err) { toast(`复制失败: ${err.message}`, 'error'); }
    return;
  }
  const tableRows = rows.map(row => [
    row.code,
    taskStatusLabel(resultTask(row, 'missavLookup'), 'missavLookup'),
    resultTask(row, 'missavLookup').url || row.url || '',
    taskStatusLabel(resultTask(row, 'raindropSync'), 'raindropSync'),
    (row.actresses || []).join(', '),
    (row.genres || []).join(', '),
    (row.finalTags || []).join(', '),
    workflowTaskErrors(row, RESULT_WORKSPACES.missav.stages, true),
  ]);
  const text = window.SheetTable.rowsToTSV(
    ['番号', 'MissAV 查询', 'MissAV 链接', 'Raindrop 同步', '女优 Tag', '类型 Tag', '最终 Tags', 'MissAV 错误 / 备注'],
    tableRows,
  );
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制 ${rows.length} 行，可直接粘贴到 Excel/WPS`, 'success');
  } catch (err) { toast(`复制失败: ${err.message}`, 'error'); }
}

function handleResultHeaderClick(event) {
  const button = event.target.closest('[data-result-sort-key]');
  if (!button) return;
  const key = button.dataset.resultSortKey;
  const current = DOM.resultSort.value;
  DOM.resultSort.value = current === `${key}_asc` ? `${key}_desc` : `${key}_asc`;
  state.resultSortByWorkspace[state.resultWorkspace] = DOM.resultSort.value;
  renderTable();
}
function statusClass(r) {
  if (['queued', 'running'].includes(r.status)) return 'status-skipped';
  if (r.status === 'network_error') return 'status-manual';
  if (!r.includeInImport) return 'status-skipped';
  switch (r.status) { case 'ok': return 'status-ok'; case 'not_found': return 'status-not_found'; case 'no_actress_found': return 'status-no_actress'; case 'need_manual_check': case 'page_ok_play_unknown': return 'status-manual'; default: return ''; }
}
function statusLabel(r) {
  if (r.status === 'queued') return '等待处理';
  if (r.status === 'running') return '处理中';
  if (r.status === 'network_error') return '⚠ 网络错误';
  if (!r.includeInImport) return r.skippedReason || '已跳过';
  switch (r.status) { case 'ok': return '✓ 正常'; case 'not_found': return '✗ 未找到'; case 'no_actress_found': return '⚠ 无女优'; case 'need_manual_check': return '⚠ 页面待核验'; case 'page_ok_play_unknown': return '⚠ 页面可访问，播放未知'; default: return r.status; }
}
function switchTab(tab) {
  const workspace = activeResultWorkspace();
  state.activeTab = workspace.tabs.some(item => item[0] === tab) ? tab : 'all';
  state.resultTabByWorkspace[workspace.key] = state.activeTab;
  DOM.resultTabs?.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === state.activeTab));
  renderTable();
}

function renderChromeFavoriteBridgeStatus() {
  const bridge = state.chromeFavoriteBridge || {};
  const connected = bridge.connected === true;
  if (DOM.chromeFavoriteBridgePanel) DOM.chromeFavoriteBridgePanel.dataset.state = connected ? 'online' : bridge.running ? 'waiting' : 'offline';
  if (DOM.chromeFavoriteBridgeStatus) DOM.chromeFavoriteBridgeStatus.textContent = connected
    ? `已连接${bridge.extensionVersion ? ` · 扩展 ${bridge.extensionVersion}` : ''}`
    : bridge.running ? '等待 Chrome 扩展连接' : '本地桥接未启动';
  if (DOM.chromeFavoriteBridgeDetail) DOM.chromeFavoriteBridgeDetail.textContent = connected
    ? `本机端口 ${bridge.port} · 收藏任务会在你当前的 Chrome 登录环境中执行${bridge.accountLabel ? ` · 账号 ${bridge.accountLabel}` : ''}`
    : bridge.extensionPath
      ? `扩展文件夹已准备：${bridge.extensionPath}。在 Chrome 扩展页“加载已解压的扩展程序”，再粘贴配对码。`
      : '首次使用：点击“安装/配对扩展”，在 Chrome 扩展页加载文件夹，再把配对码粘贴到扩展中。';
  if (DOM.btnCopyChromePairing) DOM.btnCopyChromePairing.hidden = !bridge.pairingCode;
}

async function refreshChromeFavoriteBridgeStatus(options = {}) {
  try {
    const status = await api.getChromeFavoriteBridgeStatus();
    state.chromeFavoriteBridge = { ...state.chromeFavoriteBridge, ...status };
    renderChromeFavoriteBridgeStatus();
    if (options.toast) toast(status.connected ? '本地 Chrome 扩展已连接' : '本地 Chrome 扩展尚未连接', status.connected ? 'success' : 'info');
    return status;
  } catch (error) {
    state.chromeFavoriteBridge = { ...state.chromeFavoriteBridge, running: false, connected: false };
    renderChromeFavoriteBridgeStatus();
    if (options.toast) toast(`Chrome 收藏桥状态读取失败：${error.message}`, 'error');
    return state.chromeFavoriteBridge;
  }
}

async function copyChromeFavoritePairingCode() {
  const pairingCode = String(state.chromeFavoriteBridge?.pairingCode || '');
  if (!pairingCode) return;
  try {
    await navigator.clipboard.writeText(pairingCode);
    toast('Chrome 扩展配对码已复制', 'success');
  } catch (error) {
    toast(`配对码复制失败：${error.message}`, 'error');
  }
}

async function prepareChromeFavoriteExtension() {
  try {
    const prepared = await api.prepareChromeFavoriteExtension();
    state.chromeFavoriteBridge = { ...state.chromeFavoriteBridge, ...prepared };
    renderChromeFavoriteBridgeStatus();
    await copyChromeFavoritePairingCode();
    toast('扩展文件夹已打开，配对码也已复制。请在 chrome://extensions 开启开发者模式并“加载已解压的扩展程序”，然后点扩展图标粘贴配对码。', 'info');
    window.setTimeout(() => refreshChromeFavoriteBridgeStatus(), 2500);
  } catch (error) {
    toast(`Chrome 扩展准备失败：${error.message}`, 'error');
  }
}

async function open123AvAccountWindow() {
  if (state.av123FavoriteMethod === 'export') return;
  const appMethod = state.av123FavoriteMethod === 'app';
  set123AvAccountState({ status: 'checking' });
  try {
    const result = await api.open123AvAccountWindow(favoriteExecutorOptions());
    set123AvAccountState(result);
    if (result.status === 'ready') toast(`123AV 账号 ${result.metadata?.accountLabel || ''} 已登录`, 'success');
    else if (result.metadata?.responseKind === 'chrome_extension_required') toast('请先安装并配对本地 Chrome 收藏桥扩展', 'info');
    else toast(appMethod ? '请在 APP 账号窗口中完成登录或验证，完成后点击“检查 APP 登录”' : '请在本地 Chrome 中完成登录或验证，完成后点击“检查登录”', 'info');
  } catch (err) {
    set123AvAccountState({ status: 'network_error', error: err.message || `${appMethod ? 'APP 账号窗口' : '本地 Chrome'}打开失败` });
    toast(`${appMethod ? 'APP 账号窗口' : '本地 Chrome'}打开失败: ${err.message}`, 'error');
  }
}

async function check123AvAccountStatus(options = {}) {
  if (state.av123FavoriteMethod === 'export') return { status: 'ready', metadata: { accountLabel: '仅导出' } };
  const appMethod = state.av123FavoriteMethod === 'app';
  set123AvAccountState({ status: 'checking' });
  try {
    const result = await api.check123AvAccount(favoriteExecutorOptions());
    set123AvAccountState(result);
    if (!options.quiet) {
      if (result.status === 'ready') toast(`123AV 账号 ${result.metadata?.accountLabel || ''} 已登录`, 'success');
      else if (result.status === 'not_logged_in') toast(`${appMethod ? 'APP 账号窗口' : '本地 Chrome'}中的 123AV 账号尚未登录`, 'info');
      else if (result.metadata?.responseKind === 'chrome_extension_required') toast('本地 Chrome 扩展尚未连接', 'info');
      else toast(result.error || '123AV 账号状态需要人工处理', 'error');
    }
    return result;
  } catch (err) {
    const result = { status: 'network_error', error: err.message || '登录状态检查失败' };
    set123AvAccountState(result);
    if (!options.quiet) toast(`123AV 登录状态检查失败: ${err.message}`, 'error');
    return result;
  }
}

async function ensure123AvAccountReady() {
  if (state.av123FavoriteMethod === 'export') return null;
  const appMethod = state.av123FavoriteMethod === 'app';
  const account = await check123AvAccountStatus({ quiet: true });
  if (account?.status === 'ready') return account;
  if (account?.metadata?.responseKind === 'chrome_extension_required') {
    if (confirm('本地 Chrome 收藏桥扩展尚未连接。现在准备扩展文件和配对码？')) await prepareChromeFavoriteExtension();
    return null;
  }
  const reason = account?.status === 'not_logged_in'
    ? `${appMethod ? 'APP 账号窗口' : '本地 Chrome'}中的 123AV 账号尚未登录。现在打开 123AV？`
    : `${account?.error || '123AV 账号状态不可用'}。现在打开${appMethod ? ' APP 账号窗口' : '本地 Chrome'}处理？`;
  if (confirm(reason)) await open123AvAccountWindow();
  return null;
}

function persistedFavoriteStatus(result) {
  const status = String(result?.status || 'failed');
  if (status === 'already_saved' || status === 'succeeded') return 'succeeded';
  if (['ready', 'network_error', 'manual', 'not_logged_in', 'verify_required', 'failed'].includes(status)) return status;
  return 'failed';
}

function favoriteDescriptor(item) {
  if (!item) return null;
  const runId = Number(item.runId || item.run_id || 0);
  const position = Number(item.position ?? item.batchPosition);
  const lookupTask = resultTask(item, 'av123Lookup');
  const favoriteTask = resultTask(item, 'av123Favorite');
  if (!runId || !Number.isInteger(position)) return null;
  return {
    key: `${runId}:${position}`,
    runId,
    position,
    code: String(item.code || '').trim(),
    url: String(lookupTask.url || '').trim(),
    favoriteStatus: favoriteTask.status,
    attemptCount: Number(favoriteTask.attemptCount || 0),
  };
}

function wakeFavoriteWorkers(runtime = state.favoriteRuntime) {
  if (!runtime) return;
  const waiters = runtime.waiters.splice(0);
  waiters.forEach(resolve => resolve());
}

function waitForFavoriteWake(runtime, timeoutMs = 0) {
  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) window.clearTimeout(timer);
      const index = runtime.waiters.indexOf(finish);
      if (index >= 0) runtime.waiters.splice(index, 1);
      resolve();
    };
    runtime.waiters.push(finish);
    if (timeoutMs > 0) timer = window.setTimeout(finish, timeoutMs);
  });
}

function enqueueFavoriteDescriptor(runtime, descriptor) {
  if (!runtime?.running || runtime.stopRequested || !descriptor || runtime.queuedKeys.has(descriptor.key)) return false;
  const allowed = runtime.verifyOnly
    ? descriptor.favoriteStatus === 'verify_required'
    : runtime.auto
      ? descriptor.favoriteStatus === 'ready'
      : ['ready', 'network_error', 'manual', 'not_logged_in', 'failed'].includes(descriptor.favoriteStatus);
  if (!allowed || !descriptor.url) return false;
  runtime.queuedKeys.add(descriptor.key);
  runtime.queue.push({ ...descriptor, round: 1 });
  runtime.total++;
  wakeFavoriteWorkers(runtime);
  renderFavoriteRuntime();
  return true;
}

function favoriteResultCanRetry(runtime, descriptor, taskStatus, result) {
  if (!runtime || runtime.verifyOnly || runtime.stopRequested || result?.requiresUserAction) return false;
  if (Number(descriptor?.round || 1) >= Number(runtime.maxRounds || 1)) return false;
  if (taskStatus === 'verify_required') return true;
  if (taskStatus === 'network_error' && !result?.metadata?.clickAttempted) return true;
  return taskStatus === 'manual' && result?.metadata?.responseKind === 'save_control_unavailable';
}

function enqueueFavoriteRetry(runtime, descriptor, taskStatus, result) {
  const round = Number(descriptor?.round || 1) + 1;
  const retryKey = `${descriptor.key}:${round}`;
  if (round > runtime.maxRounds || runtime.retryKeys.has(retryKey)) return false;
  runtime.retryKeys.add(retryKey);
  runtime.retryQueue.push({
    ...descriptor,
    favoriteStatus: taskStatus,
    round,
    notBefore: Date.now() + runtime.retryDelayMs,
    previousResponseKind: String(result?.metadata?.responseKind || ''),
  });
  runtime.retryScheduled++;
  wakeFavoriteWorkers(runtime);
  scheduleFavoriteUi(runtime);
  return true;
}

function favoriteRateLimitResult(result) {
  return result?.metadata?.responseKind === 'rate_limited'
    || /error\s*1015|being rate limited/i.test(String(result?.error || ''));
}

function appFavoriteRecoverableProblem(taskStatus, result) {
  if (result?.requiresUserAction || taskStatus === 'not_logged_in') return false;
  return ['network_error', 'manual', 'verify_required', 'failed'].includes(taskStatus)
    || favoriteRateLimitResult(result);
}

function scheduleAppFavoriteRecovery(runtime, taskStatus, result, descriptor) {
  if (runtime?.method !== 'app' || runtime.stopRequested || !appFavoriteRecoverableProblem(taskStatus, result)) return false;
  const now = Date.now();
  runtime.pauseUntil = Math.max(Number(runtime.pauseUntil || 0), now + AV123_APP_RECOVERY_DELAY_MS);
  runtime.pauseReason = favoriteRateLimitResult(result) ? '限流/网络异常' : '当前项异常';
  runtime.recoveryPauses++;
  logEvent('warn', 'av123_app_favorite_recovery_scheduled', {
    runId: runtime.runId,
    position: Number(descriptor?.position ?? -1),
    code: String(descriptor?.code || ''),
    taskStatus,
    responseKind: String(result?.metadata?.responseKind || ''),
    delayMs: AV123_APP_RECOVERY_DELAY_MS,
    pauseCount: runtime.recoveryPauses,
  });
  wakeFavoriteWorkers(runtime);
  scheduleFavoriteUi(runtime, true);
  return true;
}

async function waitForAppFavoriteRecovery(runtime) {
  if (runtime?.method !== 'app') return !runtime?.stopRequested;
  while (!runtime.stopRequested) {
    const remainingMs = Math.max(0, Number(runtime.pauseUntil || 0) - Date.now());
    if (!remainingMs) {
      runtime.waitReason = '';
      runtime.pauseReason = '';
      return true;
    }
    runtime.waitReason = 'recovery';
    scheduleFavoriteUi(runtime, true);
    await waitForFavoriteWake(runtime, Math.min(1000, remainingMs));
  }
  return false;
}

function promoteFavoriteRetryRound(runtime) {
  if (!runtime.retryQueue.length) return { promoted: false, waitMs: 0 };
  const now = Date.now();
  const ready = runtime.retryQueue.filter(descriptor => Number(descriptor.notBefore || 0) <= now);
  if (!ready.length) {
    const nextAt = Math.min(...runtime.retryQueue.map(descriptor => Number(descriptor.notBefore || now)));
    return { promoted: false, waitMs: Math.max(20, nextAt - now) };
  }
  const readyKeys = new Set(ready.map(descriptor => `${descriptor.key}:${descriptor.round}`));
  runtime.retryQueue = runtime.retryQueue.filter(descriptor => !readyKeys.has(`${descriptor.key}:${descriptor.round}`));
  ready.forEach(descriptor => runtime.retryKeys.delete(`${descriptor.key}:${descriptor.round}`));
  runtime.round = Math.max(runtime.round, ...ready.map(descriptor => Number(descriptor.round || 1)));
  runtime.queue.push(...ready);
  runtime.roundsStarted = Math.max(runtime.roundsStarted, runtime.round);
  logEvent('info', 'av123_favorite_retry_round_started', {
    runId: runtime.runId,
    round: runtime.round,
    count: ready.length,
    concurrency: runtime.concurrency,
  });
  scheduleFavoriteUi(runtime, true);
  return { promoted: true, waitMs: 0 };
}

async function takeFavoriteDescriptor(runtime) {
  let finalCheckDone = false;
  while (!runtime.stopRequested) {
    if (runtime.queue.length) return runtime.queue.shift();
    if (!runtime.accepting && runtime.active.size === 0 && runtime.retryQueue.length) {
      const promotion = promoteFavoriteRetryRound(runtime);
      if (promotion.promoted) {
        finalCheckDone = false;
        continue;
      }
      await waitForFavoriteWake(runtime, Math.min(1000, promotion.waitMs));
      continue;
    }
    if (!runtime.accepting && runtime.active.size === 0 && !runtime.retryQueue.length) {
      // Give another worker one event-loop turn to register a descriptor it
      // just removed from the queue before treating the runtime as finished.
      if (finalCheckDone) return null;
      finalCheckDone = true;
      await waitForFavoriteWake(runtime, 25);
      continue;
    }
    finalCheckDone = false;
    await waitForFavoriteWake(runtime);
  }
  return null;
}

function favoriteRemainingMs(runtime) {
  const recoveryMs = Math.max(0, Number(runtime?.pauseUntil || 0) - Date.now());
  if (!runtime?.durations?.length || runtime.accepting) return recoveryMs || null;
  const averageMs = processingEta?.averageDuration(runtime.durations);
  if (!averageMs) return recoveryMs || null;
  const remaining = Math.max(0, runtime.total - runtime.completed);
  return Math.ceil(remaining * averageMs / Math.max(1, runtime.concurrency) + recoveryMs);
}

function renderFavoriteRuntime() {
  const runtime = state.favoriteRuntime;
  const running = Boolean(runtime?.running);
  const total = Number(runtime?.total || 0);
  const completed = Number(runtime?.completed || 0);
  const elapsedMs = runtime?.startedAt ? Math.max(1, Date.now() - runtime.startedAt) : 0;
  const rate = elapsedMs ? completed * 1000 / elapsedMs : 0;
  const progress = total ? Math.min(100, Math.round(completed * 100 / total)) : 0;
  const remainingMs = favoriteRemainingMs(runtime);
  const roundLabel = runtime?.round > 1 ? `第 ${runtime.round} 轮自动重跑` : '';
  const recoveryRemaining = Math.max(0, Number(runtime?.pauseUntil || 0) - Date.now());
  const status = !runtime
    ? '未启动'
    : running
      ? recoveryRemaining > 0
        ? `异常休息中 · ${Math.ceil(recoveryRemaining / 1000)} 秒后续跑`
        : roundLabel || (runtime.verifyOnly ? '正在复查' : runtime.auto ? '自动收藏中' : '正在收藏')
      : runtime.stopRequested ? '已停止' : '已完成';
  const waitingText = runtime?.accepting ? ` · 等待查询继续命中` : '';
  if (running) {
    state.av123Account.detail = `${runtime.auto ? '自动收藏' : runtime.verifyOnly ? '远端复查' : '账号收藏'} ${completed}/${total} · 第 ${runtime.round} 轮 · ${runtime.concurrency} 路 · ${rate.toFixed(1)} 条/秒${recoveryRemaining > 0 ? ` · 暂停 ${Math.ceil(recoveryRemaining / 1000)} 秒` : ''}${runtime.accepting ? ' · 等待查询命中' : ''}`;
  }
  if (DOM.favoriteRuntimePanel) DOM.favoriteRuntimePanel.dataset.state = running ? 'running' : runtime?.stopRequested ? 'stopped' : 'idle';
  if (DOM.favoriteRuntimeStatus) DOM.favoriteRuntimeStatus.textContent = status;
  if (DOM.favoriteRuntimeRate) DOM.favoriteRuntimeRate.textContent = `${rate.toFixed(1)} 条/秒`;
  if (DOM.favoriteRuntimeProgressFill) DOM.favoriteRuntimeProgressFill.style.width = `${progress}%`;
  if (DOM.favoriteRuntimeSummary) DOM.favoriteRuntimeSummary.textContent = runtime
    ? `完成 ${completed}/${total} · 已收藏 ${runtime.succeeded} · 打开页 ${runtime.pageStarts} · 1015 ${runtime.rateLimitEvents} 次 · 10秒恢复 ${runtime.recoveryPauses || 0} 次 · 自动重跑 ${runtime.retryScheduled} · 待核对 ${runtime.attention}${waitingText}`
    : '待收藏会保留在当前批次';
  if (DOM.favoriteRuntimeEta) DOM.favoriteRuntimeEta.textContent = remainingMs == null
    ? runtime?.accepting ? '预计剩余：等待查询' : '预计剩余 —'
    : `预计剩余 ${processingEta?.formatDuration(remainingMs) || `${Math.ceil(remainingMs / 1000)} 秒`}`;
  if (DOM.btnStop123AvFavoriteSite) DOM.btnStop123AvFavoriteSite.hidden = !running;
}

function scheduleFavoriteUi(runtime, force = false) {
  const apply = () => {
    runtime.renderTimer = null;
    renderFavoriteRuntime();
    renderTable();
    updateUI();
  };
  if (force) {
    if (runtime.renderTimer) window.clearTimeout(runtime.renderTimer);
    apply();
  } else if (!runtime.renderTimer) runtime.renderTimer = window.setTimeout(apply, 120);
}

function completeFavoriteDescriptor(runtime, descriptor, taskStatus, result) {
  if (runtime.completedKeys.has(descriptor.key)) return;
  runtime.completedKeys.add(descriptor.key);
  runtime.completed++;
  if (taskStatus === 'succeeded') {
    runtime.succeeded++;
    if (result?.status === 'already_saved') runtime.alreadySaved++;
  } else if (taskStatus !== 'ready') {
    runtime.attention++;
  }
}

async function processFavoriteDescriptor(runtime, descriptor, workerId) {
  const currentItem = api.dbGetRunItem?.(descriptor.runId, descriptor.position);
  const refreshedDescriptor = favoriteDescriptor(currentItem);
  const currentDescriptor = refreshedDescriptor
    ? { ...refreshedDescriptor, round: Number(descriptor.round || 1), previousResponseKind: descriptor.previousResponseKind || '' }
    : descriptor;
  const retryingUncertain = Number(currentDescriptor.round || 1) > 1
    && ['verify_required', 'network_error', 'manual'].includes(currentDescriptor.favoriteStatus);
  const allowed = runtime.verifyOnly
    ? currentDescriptor.favoriteStatus === 'verify_required'
    : runtime.auto
      ? currentDescriptor.favoriteStatus === 'ready' || retryingUncertain
      : ['ready', 'network_error', 'manual', 'not_logged_in', 'failed'].includes(currentDescriptor.favoriteStatus) || retryingUncertain;
  if (!allowed || !currentDescriptor.url) return;
  const startedAt = Date.now();
  runtime.active.set(workerId, startedAt);
  let attempted = false;
  try {
    attempted = true;
    runtime.pageStarts++;
    const runningItem = api.dbUpdateRunTask(currentDescriptor.runId, currentDescriptor.position, '123av', 'favorite', { status: 'running', error: '' });
    replaceResultFromRunItem(runningItem);
    scheduleFavoriteUi(runtime);
    const result = await api.favorite123AvItem({
      code: currentDescriptor.code,
      url: currentDescriptor.url,
      verifyOnly: runtime.verifyOnly,
      confirmed: !runtime.verifyOnly,
      workerId,
      executor: runtime.method,
    });
    const taskStatus = persistedFavoriteStatus(result);
    const persisted = api.dbUpdateRunTask(currentDescriptor.runId, currentDescriptor.position, '123av', 'favorite', {
      status: taskStatus,
      url: result.url || currentDescriptor.url,
      error: result.error || '',
      metadata: {
        ...(result.metadata || {}),
        outcome: result.status === 'already_saved' ? 'already_saved' : result.status,
        verifiedOnly: runtime.verifyOnly,
        workerId,
        automatic: runtime.auto,
      },
      attemptCount: currentDescriptor.attemptCount + 1,
    });
    replaceResultFromRunItem(persisted);
    if (favoriteRateLimitResult(result)) runtime.rateLimitEvents++;
    scheduleAppFavoriteRecovery(runtime, taskStatus, result, currentDescriptor);
    const retryQueued = favoriteResultCanRetry(runtime, currentDescriptor, taskStatus, result)
      && enqueueFavoriteRetry(runtime, currentDescriptor, taskStatus, result);
    if (!retryQueued) completeFavoriteDescriptor(runtime, currentDescriptor, taskStatus, result);
    if (result.metadata?.accountLabel) set123AvAccountState({ status: 'running', metadata: { accountLabel: result.metadata.accountLabel } });
    if (result.requiresUserAction || taskStatus === 'not_logged_in') {
      set123AvAccountState(result);
      runtime.stopRequested = true;
      runtime.accepting = false;
      wakeFavoriteWorkers(runtime);
      toast(result.error || '请在 123AV 账号窗口中完成操作后再继续', 'error');
    }
    logEvent(['succeeded', 'ready'].includes(taskStatus) ? 'info' : 'warn', 'av123_favorite_item_finished', {
      runId: currentDescriptor.runId,
      position: currentDescriptor.position,
      code: currentDescriptor.code,
      workerId,
      automatic: runtime.auto,
      round: currentDescriptor.round,
      retryQueued,
      taskStatus,
      outcome: result.status,
      clickAttempted: Boolean(result.metadata?.clickAttempted),
      error: result.error || '',
    });
  } catch (err) {
    let retryQueued = false;
    let uncertaintyPersisted = false;
    try {
      const uncertain = api.dbUpdateRunTask(currentDescriptor.runId, currentDescriptor.position, '123av', 'favorite', {
        status: 'verify_required',
        url: currentDescriptor.url,
        error: `账号操作异常中断，需核对远端：${err.message || String(err)}`,
        metadata: { responseKind: 'renderer_exception', clickAttempted: true, workerId, automatic: runtime.auto },
        attemptCount: currentDescriptor.attemptCount + 1,
      });
      replaceResultFromRunItem(uncertain);
      uncertaintyPersisted = true;
      const uncertainResult = {
        status: 'verify_required',
        error: err.message || String(err),
        metadata: { responseKind: 'renderer_exception', clickAttempted: true },
      };
      scheduleAppFavoriteRecovery(runtime, 'verify_required', uncertainResult, currentDescriptor);
      retryQueued = favoriteResultCanRetry(runtime, currentDescriptor, 'verify_required', uncertainResult)
        && enqueueFavoriteRetry(runtime, currentDescriptor, 'verify_required', uncertainResult);
      if (!retryQueued) completeFavoriteDescriptor(runtime, currentDescriptor, 'verify_required', uncertainResult);
    } catch {}
    if (!uncertaintyPersisted) {
      completeFavoriteDescriptor(runtime, currentDescriptor, 'verify_required', { status: 'verify_required' });
      runtime.stopRequested = true;
      runtime.accepting = false;
      wakeFavoriteWorkers(runtime);
    }
    logEvent('error', 'av123_favorite_item_exception', {
      runId: currentDescriptor.runId,
      position: currentDescriptor.position,
      code: currentDescriptor.code,
      workerId,
      automatic: runtime.auto,
      round: currentDescriptor.round,
      retryQueued,
      error: err.message || String(err),
    });
    toast(!uncertaintyPersisted
      ? `${currentDescriptor.code} 状态写回失败，收藏队列已安全停止`
      : retryQueued
      ? `${currentDescriptor.code} 状态不明确，已放入下一轮重新处理`
      : `${currentDescriptor.code} 两轮后仍不明确，已标记为需核对远端`, retryQueued ? 'info' : 'error');
  } finally {
    runtime.active.delete(workerId);
    if (attempted) {
      runtime.attempts++;
      runtime.durations.push(Date.now() - startedAt);
    }
    wakeFavoriteWorkers(runtime);
    scheduleFavoriteUi(runtime);
  }
}

async function finishFavoriteRuntime(runtime) {
  runtime.running = false;
  runtime.accepting = false;
  state.activeAccountAction = '';
  if (!['manual', 'not_logged_in', 'network_error'].includes(state.av123Account.status)) {
    set123AvAccountState({ status: 'ready', metadata: { accountLabel: state.av123Account.accountLabel || runtime.accountLabel } });
  }
  scheduleFavoriteUi(runtime, true);
  const summary = `${runtime.verifyOnly ? '远端复查' : runtime.auto ? '123AV 自动收藏' : '123AV 收藏'} ${runtime.completed}/${runtime.total} 条 · 已确认 ${runtime.succeeded} 条${runtime.alreadySaved ? `（原已收藏 ${runtime.alreadySaved}）` : ''} · 自动重跑 ${runtime.retryScheduled} 条 · 待处理 ${runtime.attention} 条`;
  logEvent('info', runtime.verifyOnly ? 'av123_favorite_verify_finished' : 'av123_favorite_batch_finished', {
    runId: runtime.runId,
    completed: runtime.completed,
    requested: runtime.total,
    succeeded: runtime.succeeded,
    alreadySaved: runtime.alreadySaved,
    attention: runtime.attention,
    attempts: runtime.attempts,
    retryScheduled: runtime.retryScheduled,
    roundsStarted: runtime.roundsStarted,
    concurrency: runtime.concurrency,
    method: runtime.method,
    pageStarts: runtime.pageStarts,
    rateLimitEvents: runtime.rateLimitEvents,
    recoveryPauses: runtime.recoveryPauses,
    finalGapMs: runtime.currentGapMs,
    automatic: runtime.auto,
    stopped: runtime.stopRequested,
  });
  addHistory(summary);
  toast(summary, runtime.stopRequested || runtime.attention ? 'info' : 'success');
  maybeDeletePendingProcessingRun();
  return runtime;
}

function startFavoriteRuntime(items, options = {}) {
  if (state.favoriteRuntime?.running) return null;
  const method = normalize123AvFavoriteMethod(options.method || state.av123FavoriteMethod);
  const runtime = {
    running: true,
    stopRequested: false,
    accepting: false,
    auto: options.auto === true,
    verifyOnly: options.verifyOnly === true,
    runId: Number(options.runId || 0),
    accountLabel: String(options.accountLabel || '当前账号'),
    method,
    concurrency: 1,
    queue: [],
    retryQueue: [],
    queuedKeys: new Set(),
    retryKeys: new Set(),
    completedKeys: new Set(),
    waiters: [],
    total: 0,
    completed: 0,
    succeeded: 0,
    alreadySaved: 0,
    attention: 0,
    attempts: 0,
    retryScheduled: 0,
    round: 1,
    roundsStarted: 1,
    maxRounds: options.verifyOnly === true ? 1 : 2,
    retryDelayMs: method === 'app' ? AV123_APP_RECOVERY_DELAY_MS : 1200,
    baseGapMs: 0,
    currentGapMs: 0,
    nextPermitAt: 0,
    rateLimitUntil: 0,
    rateLimitCooldownMs: 0,
    burstLimit: 0,
    burstRestMs: 0,
    burstPageStarts: 0,
    restUntil: 0,
    pageStarts: 0,
    rateLimitEvents: 0,
    pauseUntil: 0,
    pauseReason: '',
    recoveryPauses: 0,
    successesSinceLimit: 0,
    waitReason: '',
    startedAt: Date.now(),
    durations: [],
    active: new Map(),
    renderTimer: null,
    promise: null,
  };
  state.favoriteRuntime = runtime;
  state.activeAccountAction = runtime.verifyOnly ? 'verify' : runtime.auto ? 'auto-favorite' : 'favorite';
  set123AvAccountState({ status: 'running', metadata: { accountLabel: runtime.accountLabel } });
  (items || []).map(favoriteDescriptor).filter(Boolean).forEach(descriptor => enqueueFavoriteDescriptor(runtime, descriptor));
  logEvent('info', runtime.verifyOnly ? 'av123_favorite_verify_started' : 'av123_favorite_batch_started', {
    runId: runtime.runId,
    count: runtime.total,
    accountLabel: runtime.accountLabel,
    concurrency: runtime.concurrency,
    method: runtime.method,
    automatic: runtime.auto,
    streaming: runtime.accepting,
    maxRounds: runtime.maxRounds,
    pageGapMs: runtime.currentGapMs,
    burstLimit: runtime.burstLimit,
    burstRestMs: runtime.burstRestMs,
    persistedCooldownMs: Math.max(0, runtime.rateLimitUntil - Date.now()),
  });
  const worker = async workerId => {
    while (!runtime.stopRequested) {
      if (!await waitForAppFavoriteRecovery(runtime)) break;
      const descriptor = await takeFavoriteDescriptor(runtime);
      if (!descriptor) break;
      await processFavoriteDescriptor(runtime, descriptor, workerId);
    }
  };
  runtime.promise = Promise.all(Array.from({ length: runtime.concurrency }, (_, workerId) => worker(workerId)))
    .then(() => finishFavoriteRuntime(runtime));
  renderFavoriteRuntime();
  updateUI();
  renderTable();
  return runtime;
}

function stop123AvFavorite() {
  const runtime = state.favoriteRuntime;
  if (!runtime?.running) return;
  runtime.stopRequested = true;
  runtime.accepting = false;
  wakeFavoriteWorkers(runtime);
  renderFavoriteRuntime();
  toast('正在停止收藏，已在途的页面会先完成状态写回…', 'info');
}

async function prepareAutoFavoriteForRun(batch) {
  if (!state.av123AutoFavorite) return null;
  if (state.av123FavoriteMethod === 'export') return null;
  if (state.favoriteRuntime?.running) {
    toast('已有 123AV 收藏队列运行，新命中项将保留为“待收藏”', 'info');
    return null;
  }
  const latestBatch = api.dbGetRun(Number(batch?.id || 0)) || batch;
  const readyItems = (latestBatch?.items || []).filter(item => {
    const lookup = item?.tasks?.av123Lookup || {};
    const favorite = item?.tasks?.av123Favorite || {};
    return lookup.status === 'succeeded'
      && favorite.status === 'ready'
      && Boolean(String(lookup.url || '').trim());
  });
  if (!readyItems.length) return null;
  const account = await ensure123AvAccountReady();
  if (!account) {
    toast('自动收藏未启动；命中项会保留为“待收藏”', 'info');
    return null;
  }
  const accountLabel = account.metadata?.accountLabel || '当前账号';
  const concurrency = effective123AvFavoriteConcurrency();
  const methodLabel = state.av123FavoriteMethod === 'app' ? 'APP 内执行器' : 'Chrome 扩展';
  if (!confirm(`123AV 查询已经结束，共有 ${readyItems.length} 条待收藏。\n\n将使用 ${methodLabel}与账号 ${accountLabel}，固定单路串行收藏。已收藏会跳过；${state.av123FavoriteMethod === 'app' ? '异常时休息 10 秒后自动继续；' : ''}首轮状态不明确会自动进入第 2 轮。确认开始？`)) {
    toast('已取消自动收藏，命中项会保留为“待收藏”', 'info');
    return null;
  }
  return startFavoriteRuntime(readyItems, {
    auto: true,
    streaming: false,
    runId: latestBatch?.id,
    accountLabel,
    concurrency,
    method: state.av123FavoriteMethod,
  });
}

async function export123AvFavoriteIndexes(indexes) {
  if (!state.dbReady) { toast('数据库未就绪', 'error'); return; }
  const rows = [...new Set((indexes || []).map(Number))]
    .filter(index => Number.isInteger(index) && state.results[index])
    .sort((left, right) => left - right)
    .map(index => state.results[index])
    .filter(row => {
      const lookup = resultTask(row, 'av123Lookup');
      const favorite = resultTask(row, 'av123Favorite');
      return lookup.status === 'succeeded'
        && Boolean(String(lookup.url || '').trim())
        && !['succeeded', 'skipped', 'blocked', 'not_configured'].includes(favorite.status);
    });
  if (!rows.length) { toast('当前范围没有可导出的待收藏记录', 'info'); return; }
  try {
    const outputDir = await api.openDirectory({ title: '选择 123AV 待收藏清单导出目录' });
    if (!outputDir) return;
    const prefix = api.timePrefixToMinute();
    const runDir = `${outputDir}\\${prefix}_123av_favorite_export`;
    await api.createDirectory(runDir);
    const txt = rows.map(row => row.code).join('\n') + '\n';
    const csvRows = rows.map(row => {
      const lookup = resultTask(row, 'av123Lookup');
      const favorite = resultTask(row, 'av123Favorite');
      return [row.code, lookup.url || '', favorite.status || '', Number(row.runId || 0), Number(row.batchPosition || 0)];
    });
    await api.writeFile(`${runDir}\\${prefix}_123av_待收藏番号.txt`, txt, 'utf-8');
    await api.writeFile(`${runDir}\\${prefix}_123av_待收藏任务.csv`, '\ufeff' + api.csvStringify(['code', 'url', 'favorite_status', 'run_id', 'position'], csvRows), 'utf-8');
    logEvent('info', 'av123_favorite_tasks_exported', { count: rows.length, directory: runDir });
    toast(`已导出 ${rows.length} 条 123AV 待收藏记录（TXT + CSV）`, 'success');
  } catch (error) {
    toast(`123AV 待收藏导出失败：${error.message}`, 'error');
  }
}

async function run123AvFavoriteIndexes(indexes, options = {}) {
  if (!state.dbReady) { toast('数据库未就绪', 'error'); return; }
  if (state.favoriteRuntime?.running) { toast('当前已有123AV收藏队列运行', 'info'); return; }
  if (state.isProcessing && state.activeLookupSite === 'av123') { toast('123AV 正在查询；同一网站需等查询结束后再收藏', 'info'); return; }
  if (state.av123FavoriteMethod === 'export') return export123AvFavoriteIndexes(indexes);
  const verifyOnly = options.verifyOnly === true;
  const allowed = verifyOnly ? new Set(['verify_required']) : new Set(['ready', 'network_error', 'manual', 'not_logged_in', 'failed']);
  const selectedRows = [...new Set((indexes || []).map(Number))]
    .filter(index => Number.isInteger(index) && state.results[index] && allowed.has(resultTask(state.results[index], 'av123Favorite').status))
    .sort((left, right) => left - right)
    .map(index => state.results[index]);
  if (!selectedRows.length) {
    toast(verifyOnly ? '当前范围没有需要核对远端的记录' : '当前范围没有可收藏的记录', 'info');
    return;
  }
  const runIds = [...new Set(selectedRows.map(row => Number(row.runId || 0)).filter(Boolean))];
  if (runIds.length !== 1) { toast('请先载入同一处理批次再执行收藏', 'error'); return; }
  const runId = runIds[0];
  const positions = new Set(selectedRows.map(row => Number(row.batchPosition)));
  const items = (api.dbGetRunItems(runId) || []).filter(item => positions.has(Number(item.position)));
  const account = await ensure123AvAccountReady();
  if (!account) return;
  const accountLabel = account.metadata?.accountLabel || '当前账号';
  const concurrency = effective123AvFavoriteConcurrency();
  const methodLabel = state.av123FavoriteMethod === 'app' ? 'APP 内执行器' : 'Chrome 扩展';
  if (!verifyOnly && !confirm(`将使用 ${methodLabel}与 123AV 账号 ${accountLabel}，以 ${concurrency} 路处理 ${items.length} 条记录。已收藏会跳过；${state.av123FavoriteMethod === 'app' ? '异常时休息 10 秒后自动继续；' : ''}首轮状态不明确会自动重跑一次。确认开始？`)) return;
  const runtime = startFavoriteRuntime(items, { verifyOnly, runId, accountLabel, concurrency, method: state.av123FavoriteMethod });
  if (runtime?.promise) await runtime.promise;
}

// ─── 核心处理流程（数据库版） ────────────────────────
function processingItemStatusForRow(row) {
  if (row?.status === 'already_exists') return 'skipped';
  if (row?.status === 'duplicate_in_input') return 'duplicate';
  if (row?.status === 'queued' || row?.status === 'processing_stopped') return 'queued';
  return 'completed';
}

function automaticBatchName() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${toolLabel(state.activeAvTool)} 批次 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function currentInputSource() {
  const sourceLabel = DOM.inputSourceInfo?.textContent || '手动输入';
  const sourceType = /文件|\.csv|\.html?|\.txt|\.md/i.test(sourceLabel)
    ? 'file'
    : sourceLabel.includes('导入去重') ? 'dedupe' : 'manual';
  return { sourceType, sourceLabel };
}

function batchItemToResult(item) {
  const row = api.buildOutputRow(
    item.code,
    item.url || '',
    item.status || item.itemStatus || 'queued',
    item.actresses || [],
    item.genres || [],
    (item.finalTags || []).filter(tag => !(item.genres || []).includes(tag)),
    item.skippedReason || '',
    Boolean(item.includeInImport),
  );
  row.finalTags = Array.isArray(item.finalTags) ? item.finalTags.slice() : row.finalTags;
  row.error = item.error || '';
  row.attemptCount = Number(item.attemptCount || 0);
  row.batchPosition = Number(item.position);
  row.runId = Number(item.runId || 0);
  row.itemStatus = item.itemStatus || '';
  row.tasks = item.tasks && typeof item.tasks === 'object' ? item.tasks : {};
  return row;
}

function statsFromBatch(batch) {
  return {
    total: Number(batch?.total || 0),
    new: Number(batch?.new || 0),
    exists: Number(batch?.skipped || 0),
    notFound: Number(batch?.notFound || 0),
    duplicate: Number(batch?.duplicate || 0),
  };
}

function currentInputSignature() {
  return state.inputCodes.map(code => api.codeComparableKey(code)).join('|');
}

function pendingMissavItems(items, pipelineVersion = 2) {
  if (Number(pipelineVersion || 1) < 2) return (items || []).filter(item => ['queued', 'running'].includes(item.itemStatus));
  return (items || []).filter(item => ['queued', 'running'].includes(String(item?.tasks?.missavLookup?.status || '')));
}

function prepareNewProcessingRun() {
  parseInputCodes();
  if (!state.inputCodes.length) throw new Error('请先输入番号');
  if (!state.dbReady) throw new Error('数据库未就绪，请等待加载完成');
  const signature = currentInputSignature();
  if (state.preparedRunId && signature === state.preparedInputSignature) {
    const existing = api.dbGetRun(Number(state.preparedRunId));
    if (existing) return existing;
  }

  state.results = [];
  state.resultSelected.clear(); state.resultSelectionAnchor = null;
  state.stats = { total: 0, new: 0, exists: 0, notFound: 0, duplicate: 0 };

  // 输入内部去重
  const uniqueCodes = []; const seen = new Set();
  for (const c of state.inputCodes) {
    const key = api.codeComparableKey(c);
    if (seen.has(key)) { state.results.push(api.buildOutputRow(c, '', 'duplicate_in_input', [], [], '', '本次输入重复', false)); state.stats.duplicate++; }
    else { seen.add(key); uniqueCodes.push(c); }
  }
  state.stats.total = state.inputCodes.length;

  // 数据库去重：历史已确认正常的跳过；历史失败、网络错误和待核验记录允许重新抓取修正。
  const toProcess = [];
  for (const c of uniqueCodes) {
    const found = api.dbFindCode(c);
    if (found.found && !['not_found', 'need_manual_check', 'page_ok_play_unknown', 'network_error'].includes(found.status)) {
      state.results.push(api.buildOutputRow(found.code || c, found.url || '', 'already_exists', [], [], '', `已存在于数据库`, false));
      state.stats.exists++;
    } else { toProcess.push(c); }
  }
  state.stats.new = toProcess.length;
  logEvent('info', 'processing_deduplicated', { total: state.stats.total, toProcess: toProcess.length, existing: state.stats.exists, duplicate: state.stats.duplicate });
  updateStats(); renderTable();
  const batchItems = [
    ...state.results.map(row => ({ ...row, itemStatus: processingItemStatusForRow(row) })),
    ...toProcess.map(code => ({ code, status: 'queued', itemStatus: 'queued', includeInImport: false })),
  ];
  const source = currentInputSource();
  const batchName = DOM.batchName?.value.trim() || automaticBatchName();
  const runId = api.dbCreateRun({
    name: batchName,
    ...source,
    toolKind: state.activeAvTool,
    speedMode: speedModeForSite('missav'),
    ...currentSpeedSettings(),
    outputDir: state.outputDirPath,
    status: 'paused',
    stats: state.stats,
    items: batchItems,
    pipelineVersion: 2,
  });
  const createdBatch = api.dbGetRun(runId);
  state.preparedRunId = runId;
  state.preparedInputSignature = signature;
  state.avToolSessions[state.activeAvTool].preparedRunId = runId;
  state.avToolSessions[state.activeAvTool].preparedInputSignature = signature;
  state.avToolSessions[state.activeAvTool].raw = DOM.codeInput.value;
  state.selectedRunId = runId;
  state.results = (createdBatch?.items || []).map(batchItemToResult);
  renderTable();
  if (DOM.resultBatchSummary) DOM.resultBatchSummary.textContent = `批次 #${runId} · ${batchItems.length} 条`;
  if (DOM.batchName) DOM.batchName.value = '';
  refreshResumableBatchPanel();
  logEvent('info', 'processing_batch_created', {
    runId,
    name: batchName,
    total: batchItems.length,
    missavPending: toProcess.length,
    av123Pending: pending123AvItems(createdBatch?.items || []).length,
    sourceType: source.sourceType,
    automaticLookup: false,
  });
  updateUI();
  return createdBatch;
}

async function ensureMissavOutputDirectory(batch) {
  let outputDir = batch?.outputDir || state.outputDirPath;
  if (outputDir && await api.fileExists(outputDir)) return outputDir;
  outputDir = await api.openDirectory({ title: '为 MissAV 结果选择导出目录' });
  if (!outputDir) return '';
  state.outputDirPath = outputDir;
  if (batch?.id && outputDir !== batch.outputDir) api.dbSetRunOutputDir(batch.id, outputDir);
  DOM.outputDirPath.textContent = shortenPath(outputDir);
  if (DOM.outputDirPathMirror) DOM.outputDirPathMirror.textContent = shortenPath(outputDir);
  return outputDir;
}

async function startSiteProcessing(site = 'missav') {
  const siteKey = site === 'av123' ? 'av123' : 'missav';
  if (state.activeAvTool !== siteKey) {
    toast(`当前打开的是 ${toolLabel(state.activeAvTool)} 工具，请从左侧进入 ${toolLabel(siteKey)} 后再开始`, 'error');
    return;
  }
  if (state.isProcessing) { toast('当前已有查询任务运行中，请先停止或等待完成', 'info'); return; }
  if (siteKey === 'av123' && state.favoriteRuntime?.running) { toast('123AV 正在收藏；同一网站需等收藏结束后再查询', 'info'); return; }
  try {
    let batch = state.preparedRunId ? api.dbGetRun(Number(state.preparedRunId)) : null;
    if (!batch) batch = prepareNewProcessingRun();
    if (batch.toolKind && !['dual', siteKey].includes(batch.toolKind)) {
      throw new Error(`这个批次属于 ${toolLabel(batch.toolKind)}，不能在 ${toolLabel(siteKey)} 中执行`);
    }
    await runSiteProcessing(batch, siteKey);
  } catch (err) {
    toast(err.message || String(err), 'error');
  }
}

async function runSiteProcessing(batch, site = 'missav') {
  if (!batch) throw new Error('没有找到处理批次');
  const siteKey = site === 'av123' ? 'av123' : 'missav';
  if (siteKey === 'av123' && state.favoriteRuntime?.running) {
    toast('123AV 正在收藏；同一网站需等收藏结束后再查询', 'info');
    return;
  }
  if (siteKey === 'missav' && !(await ensureMissavOutputDirectory(batch))) return;
  const speedProfile = processingSpeed.getSiteProfile(siteKey, speedModeForSite(siteKey));
  if (api.dbSetRunSpeedSettings) api.dbSetRunSpeedSettings(batch.id, currentSpeedSettings());
  const queue = siteKey === 'missav'
    ? pendingMissavItems(batch.items, batch.pipelineVersion)
    : pending123AvItems(batch.items);
  if (!queue.length) {
    loadProcessingRunResults(batch.id);
    toast(`${siteKey === 'missav' ? 'MissAV' : '123AV'} 已经没有待查询项`, 'info');
    return;
  }
  const siteStartedAt = Date.now();

  initializeSpeedRuntime(speedProfile, siteKey);
  state.isProcessing = true;
  state.stopRequested = false;
  state.activeLookupSite = siteKey;
  state.currentRunId = batch.id;
  state.preparedRunId = batch.id;
  state.selectedRunId = batch.id;
  state.inputCodes = batch.items.map(item => item.code);
  state.results = batch.items.map(batchItemToResult);
  state.stats = statsFromBatch(batch);
  state.resultSelected.clear();
  state.resultSelectionAnchor = null;
  DOM.progressContainer.style.display = 'block';
  DOM.exportBar.style.display = 'none';
  DOM.btnStopResults.style.display = 'inline-flex';
  if (DOM.resultBatchSummary) DOM.resultBatchSummary.textContent = `${batch.name} · ${siteKey === 'missav' ? 'MissAV' : '123AV'} ${queue.length} 项`;
  setStatus(null, `正在运行 ${siteKey === 'missav' ? 'MissAV' : '123AV'}...`, null, null);
  beginProcessingForecast(queue.length, 'running', speedProfile, siteKey);
  updateProgress(0, queue.length);
  updateStats();
  updateUI();
  renderTable();
  switchResultWorkspace(siteKey);
  switchPage('results');
  api.dbSetRunStatus(batch.id, 'running', state.stats);
  refreshResumableBatchPanel();
  logEvent('info', 'site_lookup_started', {
    runId: batch.id,
    site: siteKey,
    total: queue.length,
    speedMode: speedProfile.key,
    speedPolicy: siteKey === 'av123' ? state.av123SpeedPolicy : state.missavSpeedPolicy,
    maxSiteConcurrency: speedProfile.maxConcurrency,
    rateMode: siteRateSettings(siteKey).mode,
    rateCap: siteRateSettings(siteKey).cap,
    learnedRate: siteRateSettings(siteKey).learned,
    requestsPerSecond: Number(state.speedRuntime?.currentRequestsPerSecond || speedProfile.requestsPerSecond || 0),
  });

  try {
    if (siteKey === 'missav') {
      await processCodeQueue(queue.map(item => item.code), speedProfile, {
        runId: batch.id,
        batchPositions: queue.map(item => item.position),
        inPlaceResults: true,
      });
    } else {
      await process123AvQueueWithPolicy(queue, speedProfile, { runId: batch.id });
    }
    refreshResultsFromRun(batch.id);
  } catch (err) {
    state.stopRequested = true;
    logEvent('error', 'site_lookup_failed', { runId: batch.id, site: siteKey, error: err.message || String(err) });
    toast(`批次已暂停：${err.message}`, 'error');
  }
  const latestBeforeFinish = api.dbGetRun(batch.id);
  const finalStatus = state.stopRequested || Number(latestBeforeFinish?.lookupPending || 0) > 0 ? 'paused' : 'completed';
  api.dbFinishRun(batch.id, state.stats, finalStatus);
  const latest = api.dbGetRun(batch.id);
  const siteStageKey = siteKey === 'missav' ? 'missavLookup' : 'av123Lookup';
  const siteRemaining = lookupStagePending(latest, siteStageKey);
  const siteElapsedMs = Math.max(1, Date.now() - siteStartedAt);
  state.sitePerformance[siteKey] = {
    completed: Math.max(0, queue.length - siteRemaining),
    elapsedMs: siteElapsedMs,
  };
  const completed = Number(latest?.stages?.[siteStageKey]?.completed || 0);
  const total = Number(latest?.stages?.[siteStageKey]?.total || queue.length);
  const remainingOther = lookupStagePending(latest, siteKey === 'missav' ? 'av123Lookup' : 'missavLookup');
  logEvent('info', 'site_lookup_finished', {
    runId: batch.id,
    site: siteKey,
    completed,
    total,
    stopped: state.stopRequested,
    otherSitePending: remainingOther,
    elapsedMs: siteElapsedMs,
    processedThisRun: state.sitePerformance[siteKey].completed,
    itemsPerSecond: Number((state.sitePerformance[siteKey].completed * 1000 / siteElapsedMs).toFixed(2)),
    finalRequestsPerSecond: Number(state.speedRuntime?.currentRequestsPerSecond || 0),
    actualRequestCompletionsPerSecond: Number(actualRequestCompletionRate(state.speedRuntime).toFixed(2)),
    completedRequests: Number(state.speedRuntime?.completedRequests || 0),
    cacheHits: Number(state.speedRuntime?.cacheHits || 0),
    rateLimitEvents: Number(state.speedRuntime?.rateLimitEvents || 0),
    congestionEvents: Number(state.speedRuntime?.congestionEvents || 0),
    learnedRate: siteRateSettings(siteKey).learned,
  });
  state.currentRunId = null;
  refreshDbSummary();
  refreshResumableBatchPanel();
  finishProcessing({
    site: siteKey,
    summary: `${speedProfile.label}模式 | ${siteKey === 'missav' ? 'MissAV' : '123AV'} ${completed}/${total}${remainingOther ? ` | 另一站待 ${remainingOther} 条` : ' | 两站查询完成'}`,
  });
  if (siteKey === 'av123' && !state.stopRequested) await prepareAutoFavoriteForRun(latest);
}

async function startProcessing() {
  return startSiteProcessing('missav');
}

function saveProcessedRowToDb(row) {
  if (['already_exists', 'duplicate_in_input', 'processing_stopped'].includes(row.status)) return;
  if (api.dbPersistProcessedCode) {
    api.dbPersistProcessedCode(row);
    return;
  }
  const codeId = api.dbUpsertCode(row.code, row.url, row.status);
  const actressTagsToSave = row.matchedActressTags && row.matchedActressTags.length
    ? row.matchedActressTags
    : (row.matchedActressTag ? [row.matchedActressTag] : []);
  if (actressTagsToSave.length) {
    for (const tag of actressTagsToSave) {
      const actressId = api.dbGetOrCreateActressTag(tag);
      if (actressId) api.dbLinkActressCode(actressId, codeId);
    }
  } else if (row.status === 'not_found' || row.status === 'no_actress_found') {
    const unknownId = api.dbGetOrCreateActressTag('#未知女优');
    if (unknownId) api.dbLinkActressCode(unknownId, codeId);
  }
  for (const genre of (row.genres || [])) api.dbLinkGenreCode(genre, codeId);
}

async function processCodeQueue(codes, profile, options = {}) {
  const baseResults = state.results.slice();
  const processedRows = new Array(codes.length);
  const replaceIndexes = Array.isArray(options.replaceIndexes) ? options.replaceIndexes.map(Number) : null;
  const inPlaceResults = options.inPlaceResults === true && !replaceIndexes;
  const runId = Number(options.runId || 0);
  const batchPositions = Array.isArray(options.batchPositions) ? options.batchPositions.map(Number) : [];
  const progressOffset = Math.max(0, Number(options.progressOffset || 0));
  const progressTotal = Math.max(progressOffset + codes.length, Number(options.progressTotal || codes.length));
  const timingOffset = Math.max(0, Number(options.timingOffset ?? progressOffset));
  let nextIndex = 0;
  let completed = 0;
  let refreshTimer = null;

  const reportProgress = () => {
    updateProgress(progressOffset + completed, progressTotal);
    return progressOffset + completed;
  };

  const syncResults = (force = false) => {
    const apply = () => {
      refreshTimer = null;
      if (inPlaceResults) {
        // Each database write has already replaced the matching run row.
      } else if (replaceIndexes) {
        state.results = baseResults.slice();
        processedRows.forEach((row, index) => {
          const targetIndex = replaceIndexes[index];
          if (row && row.status !== 'processing_stopped' && Number.isInteger(targetIndex) && targetIndex >= 0 && targetIndex < state.results.length) state.results[targetIndex] = row;
        });
      } else {
        state.results = [...baseResults, ...processedRows.filter(Boolean)];
      }
      reportProgress();
      updateStats();
      renderTable();
    };
    if (force) {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      apply();
    } else if (!refreshTimer) {
      refreshTimer = window.setTimeout(apply, 180);
    }
  };

  const worker = async workerIndex => {
    while (!state.stopRequested) {
      if (!await acquireSpeedWorkerSlot(() => nextIndex < codes.length, 'missav')) break;
      const index = nextIndex++;
      if (index >= codes.length) { releaseSpeedWorkerSlot('missav'); break; }

      const code = codes[index];
      setStatus(null, `${profile.label}模式：${code} · 已完成 ${progressOffset + completed}/${progressTotal}`, null, null);
      markProcessingItemStarted(timingOffset + index);
      const itemStartedAt = Date.now();
      if (runId && Number.isInteger(batchPositions[index])) api.dbMarkRunItemRunning(runId, batchPositions[index], { persist: false });

      try {
        let row;
        try {
          row = await processOneCode(code, profile);
        } catch (err) {
          row = api.buildOutputRow(api.normalizeCode(code), '', 'network_error', [], [], [], `处理异常：${err.message || '未知错误'}`, false);
          row.error = err.message || '未知错误';
          logEvent('error', 'code_processing_exception', { code, speedMode: profile.key, error: row.error });
        }

        processedRows[index] = row;
        if (row.status === 'not_found') state.stats.notFound++;
        if (runId && Number.isInteger(batchPositions[index])) {
          const persisted = api.dbCompleteMissavRunItem
            ? api.dbCompleteMissavRunItem(runId, batchPositions[index], row, row.status === 'processing_stopped' ? 'queued' : 'completed')
            : (saveProcessedRowToDb(row), api.dbUpdateRunItem(runId, batchPositions[index], row, row.status === 'processing_stopped' ? 'queued' : 'completed'));
          row.tasks = persisted?.item?.tasks || row.tasks || {};
          row.runId = runId;
          row.batchPosition = batchPositions[index];
          if (inPlaceResults) replaceResultFromRunItem(persisted?.item);
        } else saveProcessedRowToDb(row);

        completed++;
        const waitAfterMs = !state.stopRequested && nextIndex < codes.length ? profile.rowDelayMs : 0;
        const aggregateCompleted = reportProgress();
        recordProcessingItem(timingOffset + index, (Date.now() - itemStartedAt) + waitAfterMs, aggregateCompleted);
        syncResults();
        if (waitAfterMs) await api.sleep(waitAfterMs);
      } finally {
        releaseSpeedWorkerSlot('missav');
      }
    }
  };

  await Promise.all(Array.from({ length: profile.maxConcurrency }, (_, index) => worker(index)));
  syncResults(true);
  if (state.stopRequested) setStatus(null, null, null, '已手动停止');
}

function pending123AvItems(items) {
  return (items || []).filter(item => ['queued', 'running'].includes(String(item?.tasks?.av123Lookup?.status || '')));
}

function refreshResultsFromRun(runId) {
  const items = api.dbGetRunItems(Number(runId)) || [];
  state.results = items.map(batchItemToResult);
  state.selectedRunId = Number(runId);
  state.resultSelected = new Set([...state.resultSelected].filter(index => state.results[index]));
  renderTable();
  return items;
}

function replaceResultFromRunItem(item) {
  if (!item) return;
  const runId = Number(item.runId || 0);
  const position = Number(item.position);
  const index = state.results.findIndex(row => Number(row.runId || 0) === runId && Number(row.batchPosition) === position);
  if (index >= 0) state.results[index] = batchItemToResult(item);
}

async function processOne123Av(code, profile = processingSpeed.getSiteProfile('av123', speedModeForSite('av123'))) {
  const normalized = api.normalizeCode(code);
  const cached = api.dbGetSiteLookupCache?.('123av', normalized);
  if (cached && ['succeeded', 'not_found'].includes(cached.status)) {
    const checkedAtMs = Date.parse(String(cached.checkedAt || '').replace(' ', 'T'));
    const ageMs = Number.isFinite(checkedAtMs) ? Math.max(0, Date.now() - checkedAtMs) : Number.POSITIVE_INFINITY;
    const maxAgeMs = cached.status === 'succeeded' ? 365 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
    if (ageMs <= maxAgeMs) {
      if (state.speedRuntime?.site === 'av123') state.speedRuntime.cacheHits = Number(state.speedRuntime.cacheHits || 0) + 1;
      logEvent('info', 'av123_lookup_cache_hit', {
        code: normalized,
        status: cached.status,
        checkedAt: cached.checkedAt || '',
        ageDays: Number((ageMs / 86400000).toFixed(2)),
      });
      return {
        status: cached.status,
        url: cached.url || '',
        statusCode: Number(cached.metadata?.statusCode || 200),
        error: '',
        metadata: {
          ...(cached.metadata || {}),
          cachedResponseKind: cached.metadata?.responseKind || '',
          responseKind: 'cache',
          cacheCheckedAt: cached.checkedAt || '',
        },
        attemptCount: 0,
        cacheEntry: null,
      };
    }
  }

  const detailCandidates = processingSpeed.select123AvDetailCandidateUrls(
    api.build123AvDetailCandidateUrls(normalized),
    profile.key,
  );
  const routes = detailCandidates.map((url, index) => ({
    key: index === 0 ? 'detail_base' : `detail_variant_${index}`,
    url,
    variantIndex: index,
  }));
  let result = null;
  let attempts = 0;
  for (const route of routes) {
    if (state.stopRequested) break;
    let page = null;
    try {
      await waitForRequestPermit();
      if (state.stopRequested) break;
      page = await api.fetch123AvPage(route.url, { timeout: profile.timeoutMs });
      result = api.classify123AvResponse(page, normalized, route.url);
    } catch (err) {
      result = { status: 'network_error', url: route.url, statusCode: 0, error: err?.message || '请求失败', metadata: { responseKind: 'network' } };
    }
    attempts++;
    result = {
      ...result,
      durationMs: Number(page?.durationMs || 0),
      responseBytes: Number(page?.responseBytes || 0),
      timedOut: page?.timedOut === true,
      metadata: {
        ...(result.metadata || {}),
        lookupRoute: route.key,
        statusCode: Number(result.statusCode || 0),
        durationMs: Number(page?.durationMs || 0),
        responseBytes: Number(page?.responseBytes || 0),
        timedOut: page?.timedOut === true,
      },
    };
    recordSpeedAttempt(result);
    logEvent(result.status === 'network_error' ? 'warn' : 'info', 'av123_lookup_checked', {
      code: normalized,
      requestedUrl: route.url,
      resultUrl: result.url || '',
      status: result.status,
      statusCode: result.statusCode || 0,
      responseKind: result.metadata?.responseKind || '',
      lookupRoute: route.key,
      candidateCount: Number(result.metadata?.candidateCount || 0),
      transport: page?.transport || '',
      durationMs: Number(page?.durationMs || 0),
      responseBytes: Number(page?.responseBytes || 0),
      timedOut: page?.timedOut === true,
      speedMode: profile.key,
      error: result.error || '',
    });
    if (result.status === 'succeeded' || result.status === 'network_error') break;
    if (result.status === 'not_found' && route.variantIndex < routes.length - 1) {
      logEvent('debug', 'av123_detail_variant_scheduled', {
        code: normalized,
        failedUrl: route.url,
        nextUrl: routes[route.variantIndex + 1].url,
        variantIndex: route.variantIndex + 1,
      });
      continue;
    }
    break;
  }

  if (!result) return { status: 'queued', url: '', error: '', metadata: {}, attemptCount: 0 };
  const cacheEntry = ['succeeded', 'not_found'].includes(result.status)
    ? {
      service: '123av',
      code: normalized,
      status: result.status,
      url: result.url || '',
      metadata: result.metadata || {},
    }
    : null;
  return {
    ...result,
    metadata: { ...(result.metadata || {}), statusCode: Number(result.statusCode || 0) },
    attemptCount: attempts,
    cacheEntry,
  };
}

async function process123AvQueue(items, profile, options = {}) {
  const queue = Array.isArray(items) ? items.slice() : [];
  const runId = Number(options.runId || 0);
  if (!runId || !queue.length || state.stopRequested) return { completed: 0, total: queue.length };
  const progressOffset = Math.max(0, Number(options.progressOffset || 0));
  const progressTotal = Math.max(progressOffset + queue.length, Number(options.progressTotal || queue.length));
  const timingOffset = Math.max(0, Number(options.timingOffset ?? progressOffset));
  const reportProgress = () => {
    updateProgress(progressOffset + completed, progressTotal);
    return progressOffset + completed;
  };

  if (!options.continueForecast) beginProcessingForecast(progressTotal, 'running', profile);
  updateProgress(progressOffset, progressTotal);
  setStatus(null, `正在查询 123AV · 已完成 ${progressOffset}/${progressTotal}`, null, null);
  logEvent('info', 'av123_queue_started', { runId, total: queue.length, speedMode: profile.key });

  let nextIndex = 0;
  let completed = 0;
  let uncheckpointedResults = 0;
  let lastCheckpointAt = Date.now();
  const checkpointResults = (force = false) => {
    const elapsedMs = Date.now() - lastCheckpointAt;
    if (!force && uncheckpointedResults < 100 && elapsedMs < 30000) return false;
    if (!uncheckpointedResults && !force) return false;
    api.dbCheckpoint?.();
    logEvent('debug', 'av123_database_checkpoint', {
      runId,
      resultCount: uncheckpointedResults,
      elapsedMs,
      forced: force,
    });
    uncheckpointedResults = 0;
    lastCheckpointAt = Date.now();
    return true;
  };
  let refreshTimer = null;
  const syncResults = (force = false) => {
    const apply = () => {
      refreshTimer = null;
      reportProgress();
      renderTable();
    };
    if (force) {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      apply();
    } else if (!refreshTimer) {
      refreshTimer = window.setTimeout(apply, 180);
    }
  };

  const worker = async () => {
    while (!state.stopRequested) {
      if (!await acquireSpeedWorkerSlot(() => nextIndex < queue.length, 'av123')) break;
      const index = nextIndex++;
      if (index >= queue.length) { releaseSpeedWorkerSlot('av123'); break; }
      const item = queue[index];
      const position = Number(item.position);
      const startedAt = Date.now();
      markProcessingItemStarted(timingOffset + index);
      setStatus(null, `123AV：${item.code} · 已完成 ${progressOffset + completed}/${progressTotal}`, null, null);

      try {
        const runningItem = api.dbUpdateRunTask(runId, position, '123av', 'lookup', { status: 'running', error: '', persist: false });
        replaceResultFromRunItem(runningItem);
        const result = await processOne123Av(item.code, profile);
        if (result.status === 'queued') {
          const queuedItem = api.dbUpdateRunTask(runId, position, '123av', 'lookup', { status: 'queued', error: '' });
          replaceResultFromRunItem(queuedItem);
          continue;
        }
        const previousAttempts = Number(item.tasks?.av123Lookup?.attemptCount || 0);
        const taskPatch = {
          status: result.status,
          url: result.url || '',
          error: result.error || '',
          metadata: result.metadata || {},
          attemptCount: previousAttempts + Math.max(0, Number(result.attemptCount || 0)),
          persist: false,
        };
        const persisted = result.cacheEntry && api.dbCompleteRunTaskWithCache
          ? api.dbCompleteRunTaskWithCache(runId, position, '123av', 'lookup', taskPatch, result.cacheEntry)
          : api.dbUpdateRunTask(runId, position, '123av', 'lookup', taskPatch);
        replaceResultFromRunItem(persisted);
        uncheckpointedResults++;
        checkpointResults();
        completed++;
        const waitAfterMs = !state.stopRequested && nextIndex < queue.length ? profile.rowDelayMs : 0;
        const aggregateCompleted = reportProgress();
        recordProcessingItem(timingOffset + index, (Date.now() - startedAt) + waitAfterMs, aggregateCompleted);
        syncResults();
        if (waitAfterMs) await api.sleep(waitAfterMs);
      } catch (err) {
        const failed = api.dbUpdateRunTask(runId, position, '123av', 'lookup', {
          status: 'network_error',
          url: api.build123AvDetailUrl(item.code),
          error: err?.message || '123AV 查询异常',
          metadata: { responseKind: 'exception' },
          attemptCount: Number(item.tasks?.av123Lookup?.attemptCount || 0) + 1,
          persist: false,
        });
        replaceResultFromRunItem(failed);
        uncheckpointedResults++;
        checkpointResults();
        completed++;
        const aggregateCompleted = reportProgress();
        recordProcessingItem(timingOffset + index, Date.now() - startedAt, aggregateCompleted);
        logEvent('error', 'av123_lookup_exception', { runId, position, code: item.code, error: err?.message || String(err) });
        syncResults();
      } finally {
        releaseSpeedWorkerSlot('av123');
      }
    }
  };

  await Promise.all(Array.from({ length: profile.maxConcurrency }, () => worker()));
  checkpointResults(true);
  syncResults(true);
  logEvent('info', 'av123_queue_finished', { runId, completed, total: queue.length, stopped: state.stopRequested });
  return { completed, total: queue.length };
}

function current123AvNetworkErrors(runId, positions) {
  const allowed = positions instanceof Set ? positions : new Set();
  const latest = api.dbGetRun(Number(runId));
  return (latest?.items || []).filter(item => (
    (!allowed.size || allowed.has(Number(item.position)))
    && item.tasks?.av123Lookup?.status === 'network_error'
  ));
}

async function process123AvQueueWithPolicy(items, profile, options = {}) {
  const queue = Array.isArray(items) ? items.slice() : [];
  const runId = Number(options.runId || 0);
  const stagedLevels = processingSpeed.getStagedConcurrencyLevels(profile.key);
  const useStagedTail = state.av123SpeedPolicy === 'staged' && profile.maxConcurrency >= 6 && stagedLevels.length > 1;
  if (!useStagedTail) return process123AvQueue(queue, profile, options);

  const positions = new Set(queue.map(item => Number(item.position)));
  let roundItems = queue;
  let totalCompleted = 0;
  let roundsRun = 0;
  for (let roundIndex = 0; roundIndex < stagedLevels.length && roundItems.length && !state.stopRequested; roundIndex++) {
    if (roundIndex > 0) advance123AvStagedLevel(`tail_round_${roundIndex + 1}`);
    const concurrency = getAllowedSpeedConcurrency();
    const roundProfile = {
      ...profile,
      label: roundIndex === 0 ? profile.label : `${profile.label}收尾`,
      initialConcurrency: concurrency,
      maxConcurrency: concurrency,
    };
    const roundLabel = roundIndex === 0 ? '高速主轮' : `错误收尾 ${roundIndex}`;
    setStatus(null, `123AV ${roundLabel} · ${concurrency} 路 · ${roundItems.length} 条`, null, null);
    logEvent('info', 'av123_staged_round_started', {
      runId,
      round: roundIndex + 1,
      phase: roundIndex === 0 ? 'primary' : 'error_tail',
      concurrency,
      count: roundItems.length,
    });
    const result = await process123AvQueue(roundItems, roundProfile, { ...options, continueForecast: false });
    totalCompleted += Number(result?.completed || 0);
    roundsRun++;
    roundItems = current123AvNetworkErrors(runId, positions);
    logEvent(roundItems.length ? 'warn' : 'info', 'av123_staged_round_finished', {
      runId,
      round: roundIndex + 1,
      concurrency,
      remainingNetworkErrors: roundItems.length,
    });
  }
  return { completed: totalCompleted, total: queue.length, roundsRun, remainingNetworkErrors: roundItems.length };
}

async function processOneCode(code, profile = processingSpeed.getSiteProfile('missav', speedModeForSite('missav'))) {
  const normalized = api.normalizeCode(code);
  const allUrls = api.candidateUrls(normalized);
  const urls = processingSpeed.selectCandidateUrls(allUrls, profile.key);
  const attempts = [];
  let confirmed = false;

  for (const url of urls) {
    if (state.stopRequested) break;
    let finalAttempt = null;
    for (let retry = 0; retry <= profile.retries && !state.stopRequested; retry++) {
      let page = null;
      try {
        await waitForRequestPermit();
        if (state.stopRequested) break;
        page = await api.fetchPage(url, { timeout: profile.timeoutMs });
        finalAttempt = api.classifyCandidateResponse(page, normalized, url);
      } catch (err) {
        finalAttempt = { status: 'network_error', url, html: '', statusCode: 0, error: err?.message || '请求失败' };
      }
      finalAttempt.durationMs = Number(page?.durationMs || 0);
      finalAttempt.responseBytes = Number(page?.responseBytes || 0);
      finalAttempt.timedOut = page?.timedOut === true;
      recordSpeedAttempt(finalAttempt);
      logEvent(finalAttempt.status === 'network_error' ? 'warn' : 'debug', 'candidate_checked', {
        code: normalized,
        requestedUrl: url,
        finalUrl: finalAttempt.url,
        status: finalAttempt.status,
        statusCode: finalAttempt.statusCode,
        transport: page?.transport || '',
        durationMs: Number(page?.durationMs || 0),
        responseBytes: Number(page?.responseBytes || 0),
        timedOut: page?.timedOut === true,
        speedMode: profile.key,
        retry,
        error: finalAttempt.error || '',
      });
      if (finalAttempt.status !== 'network_error' || retry >= profile.retries) break;
      logEvent('info', 'candidate_retry_scheduled', { code: normalized, url, retry: retry + 1, speedMode: profile.key });
    }
    if (!finalAttempt) break;
    attempts.push(finalAttempt);
    if (api.shouldStopCandidateSearch(finalAttempt.status)) { confirmed = true; break; }
  }

  if (state.stopRequested && !confirmed && attempts.length < urls.length) {
    return api.buildOutputRow(normalized, attempts[0]?.url || allUrls[0] || '', 'processing_stopped', [], [], [], '手动停止，当前番号未完成查询', false);
  }

  const resolved = api.resolveCandidateAttempts(attempts, allUrls[0]);
  const bestUrl = resolved.url || allUrls[0];
  const bestHtml = resolved.html || '';
  const bestStatus = resolved.status || 'not_found';

  let actresses = [], genres = [];
  if (bestStatus === 'ok' || bestStatus === 'page_ok_play_unknown') { actresses = api.extractActressTags(bestHtml); genres = api.extractGenreTags(bestHtml); }
  else if (bestStatus === 'no_actress_found' || bestStatus === 'need_manual_check') { genres = api.extractGenreTags(bestHtml); }

  const matchedTags = [];
  for (const name of actresses) {
    const match = api.dbSearchActressTag(name);
    const tag = match ? match.tag_name : name;
    if (tag && !matchedTags.includes(tag)) matchedTags.push(tag);
  }

  const reason = bestStatus === 'network_error'
    ? `网络/访问限制：${resolved.error || (resolved.statusCode ? `HTTP ${resolved.statusCode}` : '请求失败')}，未加入本批导出`
    : bestStatus === 'need_manual_check'
      ? '页面包含目标番号，但详情证据不足'
      : bestStatus === 'not_found' && !profile.fullSearch
        ? '极速简查仅检查主地址；可用其他模式进行完整补查'
      : '';
  const includeInImport = bestStatus !== 'network_error';
  const row = api.buildOutputRow(normalized, bestUrl, bestStatus, actresses, genres, matchedTags, reason, includeInImport);
  row.error = resolved.error || '';
  row.attemptCount = attempts.length;
  logEvent(bestStatus === 'network_error' ? 'warn' : 'info', 'code_resolved', {
    code: normalized,
    status: bestStatus,
    url: bestUrl,
    actressCount: actresses.length,
    genreCount: genres.length,
    attemptCount: attempts.length,
    speedMode: profile.key,
    error: resolved.error || '',
  });
  return row;
}
function requestDeleteProcessingRun(runId) {
  const id = Number(runId || 0);
  if (!id || !state.dbReady) { toast('没有可删除的处理批次', 'error'); return; }
  const batch = api.dbGetRun(id);
  if (!batch) {
    toast('该处理批次已经不存在', 'info');
    refreshResumableBatchPanel();
    return;
  }
  const isActiveLookup = state.isProcessing && Number(state.currentRunId || 0) === id;
  const isActiveFavorite = state.favoriteRuntime?.running && Number(state.favoriteRuntime.runId || 0) === id;
  const activeFavoriteOtherRun = state.favoriteRuntime?.running && Number(state.favoriteRuntime.runId || 0) !== id;
  if ((state.isProcessing && !isActiveLookup) || activeFavoriteOtherRun) {
    toast('当前有其他操作正在运行，请先停止后再删除该批次', 'info');
    return;
  }
  const itemCount = Number(batch.itemCount || batch.total || batch.items?.length || 0);
  const taskCount = Number(batch.pipelineTaskCount || 0);
  const message = `${isActiveLookup || isActiveFavorite ? '当前查询/收藏会先分别安全停止。\n\n' : ''}确认删除“${batch.name || `批次 #${id}`}”？\n\n将从当前数据库删除：\n• 1 个批次\n• ${itemCount} 条逐条结果\n• ${taskCount} 项阶段任务\n\n不会删除永久番号库中已经处理好的记录，也不会删除已经导出的文件。删除前会自动创建数据库备份。`;
  if (!confirm(message)) return;

  if (isActiveLookup || isActiveFavorite) {
    state.pendingDeleteRunId = id;
    if (isActiveLookup) stopProcessing();
    if (isActiveFavorite) stop123AvFavorite();
    setStatus(null, '正在安全停止，结束在途请求后删除整个批次…', null, null);
    updateRunDeleteControls();
    toast('正在停止并删除批次，请稍候…', 'info');
    return;
  }
  deleteProcessingRunNow(id);
}

function maybeDeletePendingProcessingRun() {
  const id = Number(state.pendingDeleteRunId || 0);
  if (!id) return false;
  const lookupActive = state.isProcessing && Number(state.currentRunId || 0) === id;
  const favoriteActive = state.favoriteRuntime?.running && Number(state.favoriteRuntime.runId || 0) === id;
  if (lookupActive || favoriteActive) return false;
  setStatus(null, '在途任务已结束，正在删除整个批次…', null, null);
  updateUI();
  deleteProcessingRunNow(id);
  return true;
}

function deleteProcessingRunNow(runId) {
  const id = Number(runId || 0);
  if (!id) return null;
  try {
    const result = api.dbDeleteRun(id, { createBackup: true });
    state.pendingDeleteRunId = null;
    if (!result?.deleted) {
      toast('该处理批次已经不存在', 'info');
      refreshResumableBatchPanel();
      return result;
    }

    if (Number(state.currentRunId || 0) === id) state.currentRunId = null;
    if (Number(state.preparedRunId || 0) === id) {
      state.preparedRunId = null;
      state.preparedInputSignature = '';
    }
    if (Number(state.selectedRunId || 0) === id) state.selectedRunId = null;
    if (Number(state.favoriteRuntime?.runId || 0) === id && !state.favoriteRuntime?.running) state.favoriteRuntime = null;
    const beforeResultCount = state.results.length;
    state.results = state.results.filter(row => Number(row?.runId || 0) !== id);
    state.resultSelected.clear();
    state.resultSelectionAnchor = null;
    state.sitePerformance = { missav: null, av123: null };
    state.stopRequested = false;
    if (beforeResultCount && !state.results.length) {
      state.stats = { total: 0, new: 0, exists: 0, notFound: 0, duplicate: 0 };
      if (DOM.resultBatchSummary) DOM.resultBatchSummary.textContent = '批次已删除';
      DOM.progressContainer.style.display = 'none';
      DOM.exportBar.style.display = 'none';
      DOM.btnStopResults.style.display = 'none';
      updateProgress(0, 0);
      resetProcessingForecast();
    }

    refreshDbSummary();
    refreshResumableBatchPanel();
    updateStats();
    renderTable();
    updateResultExportVisibility();
    updateUI();
    setStatus(null, null, '批次已删除 ✓', null);
    if (state.activePage === 'library') void refreshLibrary();
    logEvent('warn', 'processing_run_deleted', {
      runId: id,
      itemCount: Number(result.itemCount || 0),
      taskCount: Number(result.taskCount || 0),
      completedItems: Number(result.completedItems || 0),
      permanentCodeLinksKept: Number(result.permanentCodeLinks || 0),
      backupFile: result.backup?.fileName || '',
    });
    toast(`批次 #${id} 已删除：${result.itemCount} 条明细、${result.taskCount} 项任务；永久番号库已保留`, 'success');
    return result;
  } catch (err) {
    state.pendingDeleteRunId = null;
    updateRunDeleteControls();
    logEvent('error', 'processing_run_delete_failed', { runId: id, error: err.message || String(err) });
    toast(`删除批次失败：${err.message || String(err)}`, 'error');
    return null;
  }
}

function stopProcessing() {
  state.stopRequested = true;
  state.processingTiming.status = 'stopping';
  renderProcessingForecast();
  logEvent('warn', 'processing_stop_requested', {});
  toast('正在停止...', 'info');
}

function loadProcessingRunResults(runId, options = {}) {
  const batch = api.dbGetRun(Number(runId));
  if (!batch) throw new Error('没有找到该处理批次');
  if (['missav', 'av123'].includes(batch.toolKind)) {
    state.activeTool = batch.toolKind;
    state.activeAvTool = batch.toolKind;
  }
  applyBatchSpeedSettings(batch);
  state.selectedRunId = batch.id;
  state.preparedRunId = batch.id;
  state.preparedInputSignature = '';
  if (DOM.resultBatchSummary) DOM.resultBatchSummary.textContent = `${batch.name} · ${runStatusLabel(batch.status)} · ${batch.completed}/${batch.total}`;
  state.results = batch.items
    .filter(item => options.includePending !== false || !['queued', 'running'].includes(item.itemStatus))
    .map(batchItemToResult);
  state.stats = statsFromBatch(batch);
  state.avToolSessions[state.activeAvTool].preparedRunId = batch.id;
  state.resultSelected.clear();
  state.resultSelectionAnchor = null;
  if (batch.outputDir) {
    state.outputDirPath = batch.outputDir;
    DOM.outputDirPath.textContent = shortenPath(batch.outputDir);
    if (DOM.outputDirPathMirror) DOM.outputDirPathMirror.textContent = shortenPath(batch.outputDir);
  }
  updateStats();
  updateProgress(batch.completed, batch.total);
  renderTable();
  updateResultExportVisibility();
  updateRunDeleteControls();
  switchPage('results');
  return batch;
}

async function resumeProcessingRun(runId, site = 'missav') {
  if (state.isProcessing) { toast('当前已有处理任务运行中', 'info'); return; }
  if (site === 'av123' && state.favoriteRuntime?.running) { toast('123AV 正在收藏；同一网站需等收藏结束后再继续查询', 'info'); return; }
  if (!state.dbReady) { toast('数据库未就绪', 'error'); return; }
  const batch = api.dbGetRun(Number(runId));
  if (!batch) { toast('没有找到该处理批次', 'error'); return; }
  if (batch.toolKind && !['dual', site].includes(batch.toolKind)) {
    toast(`这个批次属于 ${toolLabel(batch.toolKind)}，不能用 ${toolLabel(site)} 继续`, 'error');
    return;
  }
  if (state.activeAvTool !== site || state.activeTool !== site) switchTool(site);
  applyBatchSpeedSettings(batch);
  state.preparedRunId = batch.id;
  state.preparedInputSignature = '';
  if (batch.outputDir) {
    state.outputDirPath = batch.outputDir;
    DOM.outputDirPath.textContent = shortenPath(batch.outputDir);
    if (DOM.outputDirPathMirror) DOM.outputDirPathMirror.textContent = shortenPath(batch.outputDir);
  }
  await runSiteProcessing(batch, site);
}

async function retry123AvResultIndexes(indexes) {
  if (state.isProcessing) { toast('当前已有处理任务运行中', 'info'); return; }
  if (state.favoriteRuntime?.running) { toast('123AV 正在收藏；同一网站需等收藏结束后再重跑查询', 'info'); return; }
  if (!state.dbReady) { toast('数据库未就绪，暂时无法重跑', 'error'); return; }
  const retryIndexes = [...new Set((indexes || []).map(Number))]
    .filter(index => Number.isInteger(index) && resultTask(state.results[index], 'av123Lookup').status === 'network_error')
    .sort((left, right) => left - right);
  if (!retryIndexes.length) { toast('选中范围内没有 123AV 网络错误', 'info'); return; }

  const runIds = [...new Set(retryIndexes.map(index => Number(state.results[index]?.runId || 0)).filter(Boolean))];
  if (runIds.length !== 1) { toast('请先载入同一个处理批次再重跑 123AV', 'error'); return; }
  const runId = runIds[0];
  const batch = api.dbGetRun(runId);
  if (!batch) { toast('没有找到原处理批次', 'error'); return; }
  const positions = new Set(retryIndexes.map(index => Number(state.results[index].batchPosition)));
  const retryItems = batch.items.filter(item => positions.has(Number(item.position)) && item.tasks?.av123Lookup?.status === 'network_error');
  if (!retryItems.length) { toast('这些 123AV 错误已经被处理', 'info'); return; }

  const speedProfile = processingSpeed.getSiteProfile('av123', speedModeForSite('av123'));
  const beforeCount = batch.stages?.av123Lookup?.statusCounts?.network_error || retryItems.length;
  if (api.dbSetRunSpeedSettings) api.dbSetRunSpeedSettings(runId, currentSpeedSettings());
  initializeSpeedRuntime(speedProfile, 'av123');
  state.isProcessing = true;
  state.stopRequested = false;
  state.activeLookupSite = 'av123';
  state.currentRunId = runId;
  state.preparedRunId = runId;
  state.selectedRunId = runId;
  state.stats = statsFromBatch(batch);
  updateUI();
  DOM.btnStopResults.style.display = 'inline-flex';
  DOM.progressContainer.style.display = 'block';
  DOM.exportBar.style.display = 'none';
  api.dbSetRunStatus(runId, 'running', state.stats);
  logEvent('info', 'av123_retry_started', { runId, count: retryItems.length, speedMode: speedProfile.key, codes: retryItems.map(item => item.code) });

  await process123AvQueueWithPolicy(retryItems, speedProfile, { runId });
  const beforeFinish = api.dbGetRun(runId);
  api.dbFinishRun(runId, state.stats, state.stopRequested || Number(beforeFinish?.lookupPending || 0) > 0 ? 'paused' : 'completed');
  const latest = api.dbGetRun(runId);
  refreshResultsFromRun(runId);
  const afterCount = latest?.stages?.av123Lookup?.statusCounts?.network_error || 0;
  const recovered = Math.max(0, beforeCount - afterCount);
  state.currentRunId = null;
  refreshResumableBatchPanel();
  logEvent('info', 'av123_retry_finished', { runId, requested: retryItems.length, recovered, remaining: afterCount, stopped: state.stopRequested });
  finishProcessing({ site: 'av123', kind: 'av123-retry', summary: `${speedProfile.label}模式 | 123AV 重跑 ${retryItems.length} 条 | 已恢复 ${recovered} 条 | 仍有网络错误 ${afterCount} 条` });
  if (!state.stopRequested) await prepareAutoFavoriteForRun(latest);
}

async function retryResultIndexes(indexes) {
  if (state.isProcessing) { toast('当前已有处理任务运行中', 'info'); return; }
  if (!state.dbReady) { toast('数据库未就绪，暂时无法重跑', 'error'); return; }
  const retryIndexes = [...new Set((indexes || []).map(Number))]
    .filter(index => Number.isInteger(index) && state.results[index]?.status === 'network_error')
    .sort((a, b) => a - b);
  if (!retryIndexes.length) { toast('选中范围内没有网络错误', 'info'); return; }

  const runIds = [...new Set(retryIndexes.map(index => Number(state.results[index]?.runId || 0)).filter(Boolean))];
  if (runIds.length !== 1) { toast('请先载入同一个处理批次再重跑 MissAV', 'error'); return; }
  const runId = runIds[0];
  const batch = api.dbGetRun(runId);
  if (!batch) { toast('没有找到原处理批次', 'error'); return; }
  const positions = new Set(retryIndexes.map(index => Number(state.results[index].batchPosition)));
  const retryItems = batch.items.filter(item => positions.has(Number(item.position)) && item.tasks?.missavLookup?.status === 'network_error');
  if (!retryItems.length) { toast('这些 MissAV 错误已经被处理', 'info'); return; }

  const speedProfile = processingSpeed.getSiteProfile('missav', speedModeForSite('missav'));
  const beforeNetworkCount = Number(batch.stages?.missavLookup?.statusCounts?.network_error || retryItems.length);
  if (api.dbSetRunSpeedSettings) api.dbSetRunSpeedSettings(runId, currentSpeedSettings());
  initializeSpeedRuntime(speedProfile, 'missav');
  state.isProcessing = true;
  state.stopRequested = false;
  state.activeLookupSite = 'missav';
  state.currentRunId = runId;
  state.preparedRunId = runId;
  state.selectedRunId = runId;
  state.stats = statsFromBatch(batch);
  updateUI();
  DOM.btnStopResults.style.display = 'inline-flex';
  DOM.progressContainer.style.display = 'block';
  DOM.exportBar.style.display = 'none';
  setStatus(null, `正在重跑 ${retryItems.length} 条 MissAV 网络错误...`, null, null);
  beginProcessingForecast(retryItems.length, 'running', speedProfile, 'missav');
  updateProgress(0, retryItems.length);
  renderTable();
  api.dbSetRunStatus(runId, 'running', state.stats);
  logEvent('info', 'network_retry_started', { runId, site: 'missav', count: retryItems.length, speedMode: speedProfile.key, codes: retryItems.map(item => item.code) });
  await processCodeQueue(retryItems.map(item => item.code), speedProfile, {
    runId,
    batchPositions: retryItems.map(item => item.position),
    inPlaceResults: true,
  });
  const beforeFinish = api.dbGetRun(runId);
  api.dbFinishRun(runId, state.stats, state.stopRequested || Number(beforeFinish?.lookupPending || 0) > 0 ? 'paused' : 'completed');
  const latest = api.dbGetRun(runId);
  refreshResultsFromRun(runId);
  const remainingInRetry = Number(latest?.stages?.missavLookup?.statusCounts?.network_error || 0);
  const recovered = Math.max(0, beforeNetworkCount - remainingInRetry);
  state.currentRunId = null;
  refreshResumableBatchPanel();
  refreshDbSummary();
  logEvent('info', 'network_retry_finished', { runId, site: 'missav', requested: retryItems.length, recovered, remaining: remainingInRetry, stopped: state.stopRequested });
  finishProcessing({ site: 'missav', kind: 'retry', summary: `${speedProfile.label}模式 | MissAV 重跑 ${retryItems.length} 条 | 已恢复 ${recovered} 条 | 仍为网络错误 ${remainingInRetry} 条` });
}

function finishProcessing(options = {}) {
  const finishedSite = options.site || state.activeLookupSite;
  state.isProcessing = false;
  finishProcessingForecast(state.stopRequested ? 'stopped' : 'done');
  const completedSpeedMode = state.speedRuntime?.profile?.label || processingSpeed.getProfile(speedModeForSite(finishedSite)).label;
  state.speedRuntime = null;
  state.activeLookupSite = '';
  DOM.btnStopResults.style.display = 'none'; updateResultExportVisibility();
  if (maybeDeletePendingProcessingRun()) return;
  if (state.stopRequested) setStatus(null, null, null, '已停止'); else setStatus(null, null, '处理完成 ✓', null);
  switchPage('results');
  updateStats(); renderTable();
  updateUI();
  refreshResumableBatchPanel();
  const av123Succeeded = state.results.filter(row => resultTask(row, 'av123Lookup').status === 'succeeded').length;
  const av123NotFound = state.results.filter(row => resultTask(row, 'av123Lookup').status === 'not_found').length;
  const av123Errors = state.results.filter(row => ['network_error', 'manual'].includes(resultTask(row, 'av123Lookup').status)).length;
  const summary = options.summary || `${completedSpeedMode}模式 | MissAV 新查 ${state.stats.new} | 历史跳过 ${state.stats.exists} | 123AV 查到 ${av123Succeeded} / 未找到 ${av123NotFound} / 异常 ${av123Errors}`;
  logEvent('info', String(options.kind || '').includes('retry') ? 'network_retry_ui_finished' : 'processing_finished', { site: finishedSite, stopped: state.stopRequested, speedMode: speedModeForSite(finishedSite), av123SpeedPolicy: state.av123SpeedPolicy, stats: state.stats, resultCount: state.results.length, av123Succeeded, av123NotFound, av123Errors });
  addHistory(summary); toast(summary, 'success');
}

// ─── 导出 ────────────────────────────────────────────
async function ensureResultOutputDirectory() {
  if (state.outputDirPath) return state.outputDirPath;
  const selected = await api.openDirectory({ title: '选择结果导出目录' });
  if (!selected) return '';
  state.outputDirPath = selected;
  DOM.outputDirPath.textContent = shortenPath(selected);
  if (DOM.outputDirPathMirror) DOM.outputDirPathMirror.textContent = shortenPath(selected);
  updateUI();
  return selected;
}

async function writeResultBundle(rows, scopeName, options = {}) {
  if (!rows.length) { toast('当前范围没有结果可导出', 'error'); return ''; }
  const outputDir = await ensureResultOutputDirectory();
  if (!outputDir) return '';
  const prefix = api.timePrefixToMinute();
  const suffix = scopeName ? `_${scopeName}` : '';
  const runDir = `${outputDir}\\${prefix}_missav_import${suffix}`;
  await api.createDirectory(runDir);
  await api.writeFile(`${runDir}\\${prefix}_missav_raindrop_import.html`, api.generateRaindropHTML(rows));
  await api.writeFile(`${runDir}\\${prefix}_missav_raindrop_import.csv`, '\ufeff' + api.generateRaindropCSV(rows));
  await api.writeFile(`${runDir}\\${prefix}_missav_import_report.csv`, '\ufeff' + api.generateReportCSV(rows));
  await api.writeFile(`${runDir}\\${prefix}_missav_backup.json`, api.generateBackupJSON(rows, [], state.stats));
  if (options.includeDatabaseCollection) await api.writeFile(`${runDir}\\${prefix}_女优tag合集.csv`, '\ufeff' + api.dbExportCSV());
  return runDir;
}

async function exportAll() {
  if (!state.results.length) { toast('无结果可导出', 'error'); return; }
  try {
    const runDir = await writeResultBundle(state.results, '', { includeDatabaseCollection: true });
    if (!runDir) return;
    logEvent('info', 'export_all_succeeded', { runDir, resultCount: state.results.length });
    toast(`导出成功！→ ${runDir}`, 'success');
    addHistory(`全部导出: ${fileName(runDir)}`);
    if (confirm('导出完成，打开输出文件夹？')) openOutputFolder();
  } catch (err) { logEvent('error', 'export_all_failed', { error: err.message }); toast(`导出失败: ${err.message}`, 'error'); }
}

async function exportCurrentScope() {
  const rows = getResultScopeRows();
  if (!rows.length) { toast('当前所选/筛选范围没有结果', 'error'); return; }
  try {
    const runDir = await writeResultBundle(rows, state.resultSelected.size ? `选中${rows.length}条` : `筛选${rows.length}条`);
    if (!runDir) return;
    logEvent('info', 'export_scope_succeeded', { runDir, resultCount: rows.length, selectedCount: state.resultSelected.size });
    toast(`已导出当前范围 ${rows.length} 条 → ${runDir}`, 'success');
    addHistory(`范围导出: ${fileName(runDir)}`);
  } catch (err) {
    logEvent('error', 'export_scope_failed', { error: err.message, resultCount: rows.length });
    toast(`范围导出失败: ${err.message}`, 'error');
  }
}

async function exportByTags() {
  const rows = getResultScopeRows();
  const groups = api.buildTagExportGroups(rows);
  if (!groups.length) { toast('当前范围没有带标签且可导入的记录', 'error'); return; }
  try {
    const outputDir = await ensureResultOutputDirectory();
    if (!outputDir) return;
    const prefix = api.timePrefixToMinute();
    const runDir = `${outputDir}\\${prefix}_按标签拆分_${groups.length}组`;
    await api.createDirectory(runDir);
    for (const group of groups) {
      await api.writeFile(`${runDir}\\${group.fileBase}.html`, api.generateRaindropHTML(group.rows));
      await api.writeFile(`${runDir}\\${group.fileBase}.csv`, '\ufeff' + api.generateRaindropCSV(group.rows));
    }
    await api.writeFile(`${runDir}\\标签导出索引.csv`, '\ufeff' + api.generateTagExportIndexCSV(groups));
    await api.writeFile(`${runDir}\\当前范围处理报告.csv`, '\ufeff' + api.generateReportCSV(rows));
    logEvent('info', 'export_by_tags_succeeded', { runDir, sourceRows: rows.length, tagGroups: groups.length, filesWritten: groups.length * 2 + 2 });
    toast(`按标签导出完成：${groups.length} 个标签，${groups.length * 2 + 2} 个文件`, 'success');
    addHistory(`按标签导出: ${groups.length} 组`);
  } catch (err) {
    logEvent('error', 'export_by_tags_failed', { error: err.message, sourceRows: rows.length, tagGroups: groups.length });
    toast(`按标签导出失败: ${err.message}`, 'error');
  }
}

async function exportHTMLOnly() {
  const rows = getResultScopeRows();
  if (!rows.length) { toast('当前范围没有结果可导出', 'error'); return; }
  try { const outputDir = await ensureResultOutputDirectory(); if (!outputDir) return; const prefix = api.timePrefixToMinute(); const runDir = `${outputDir}\\${prefix}_missav_import`; await api.createDirectory(runDir); await api.writeFile(`${runDir}\\${prefix}_missav_raindrop_import.html`, api.generateRaindropHTML(rows)); toast(`HTML 已导出 ${rows.length} 条`, 'success'); } catch (err) { toast(`导出失败: ${err.message}`, 'error'); }
}
async function exportCSVOnly() {
  const rows = getResultScopeRows();
  if (!rows.length) { toast('当前范围没有结果可导出', 'error'); return; }
  try { const outputDir = await ensureResultOutputDirectory(); if (!outputDir) return; const prefix = api.timePrefixToMinute(); const runDir = `${outputDir}\\${prefix}_missav_import`; await api.createDirectory(runDir); await api.writeFile(`${runDir}\\${prefix}_missav_raindrop_import.csv`, '\ufeff' + api.generateRaindropCSV(rows)); toast(`CSV 已导出 ${rows.length} 条`, 'success'); } catch (err) { toast(`导出失败: ${err.message}`, 'error'); }
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
  if (tab === 'raw') state.rawDbPage = 1;
  const visibleTab = visibleLibraryTab(tab);
  $$('.library-tabs .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.libraryTab === visibleTab));
  refreshLibrary();
}

function visibleLibraryTab(tab) {
  if (['overview', 'map', 'review', 'export', 'health', 'backup', 'duplicates', 'logs'].includes(tab)) return 'maintenance';
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
        ? '搜索番号、链接、状态、女优或类型 Tag'
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
    if (state.libraryTab === 'runs') renderLibraryRuns(q);
    if (state.libraryTab === 'logs') await renderLibraryLogs();
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
  const operationalRows = Number(stats.processingRunCount || 0)
    + Number(stats.processingItemCount || 0)
    + Number(stats.processingTaskCount || 0)
    + Number(stats.siteCacheCount || 0)
    + Number(stats.remoteSyncCount || 0)
    + Number(stats.telegramSourceCount || 0)
    + Number(stats.telegramMessageCount || 0)
    + Number(stats.telegramImportCount || 0);
  const tools = [
    ['overview', '数据概况', '数量统计与最近处理记录'],
    ['health', '数据体检', '缺链接、缺 Tag、状态矛盾与坏关联'],
    ['backup', '备份恢复', '创建、恢复和管理数据库快照'],
    ['duplicates', '疑似重复', '按标准化番号查找重复记录'],
    ['raw', '高级数据', '维护番号、Tag 关系与处理历史表'],
    ['logs', '运行日志', '复制、导出网络与处理诊断信息'],
  ];
  DOM.libraryContent.innerHTML = `
    <div class="maintenance-workbench">
      <div class="maintenance-summary"><strong>${stats.codeCount}</strong><span>番号</span><strong>${stats.actressCount}</strong><span>女优 Tags</span><strong>${stats.genreCount}</strong><span>类型 Tags</span><strong>${operationalRows}</strong><span>任务/缓存/来源记录</span></div>
      <div class="maintenance-list">${tools.map(([tab, title, desc]) => `<button data-action="maintenance-open" data-tab="${tab}"><span><strong>${title}</strong><small>${desc}</small></span><b>›</b></button>`).join('')}</div>
    </div>`;
}

function renderLibraryOverview() {
  const stats = api.dbGetStats();
  const runs = api.dbGetRecentRuns(5);
  const duplicates = api.dbGetDuplicateCodeGroups();
  const health = api.dbGetHealthReport({ limit: 1 });
  DOM.libraryContent.innerHTML = `
    <div class="library-stats-grid">
      <div class="stat-card"><div class="stat-value">${stats.codeCount}</div><div class="stat-label">永久番号</div></div>
      <div class="stat-card"><div class="stat-value">${stats.actressCount}</div><div class="stat-label">女优 Tags</div></div>
      <div class="stat-card"><div class="stat-value">${stats.genreCount}</div><div class="stat-label">类型 Tags</div></div>
      <div class="stat-card"><div class="stat-value">${health.summary?.noUrl || 0}</div><div class="stat-label">缺链接</div></div>
      <div class="stat-card"><div class="stat-value">${health.summary?.manualStatus || 0}</div><div class="stat-label">需核验</div></div>
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
  const dbRows = api.dbGetBookmarkLibrary({ search: q || '', limit: 50000 });
  state.libraryCodeAllRows = dbRows;
  const rows = dbRows.map(enrichCollectionMapRow);
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

function enrichCollectionMapRow(row) {
  const finalTags = raindropExplicitOrAutoTags(row);
  const explicitCollection = String(row.raindrop_folder || '').trim();
  const collectionLabel = explicitCollection || '未设置 Collection';
  const collectionKey = explicitCollection || '__missing_collection__';
  const title = row.raindrop_title || row.code || 'Untitled';
  const url = String(row.best_url || '').trim();
  const risks = [];
  if (!url) risks.push('无链接');
  if (!explicitCollection) risks.push('缺 Collection');
  if (!String(row.raindrop_title || '').trim()) risks.push('默认 Title');
  if (!finalTags.length) risks.push('无 Tags');
  if (!String(row.raindrop_created || '').trim()) risks.push('默认 Created');
  if (row.status === 'not_found') risks.push('未找到状态');
  return { ...row, finalTags, collectionLabel, collectionKey, title, url, risks };
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
  const dbRows = api.dbGetBookmarkLibrary({ search: q || '', limit: 50000 });
  state.libraryCodeAllRows = dbRows;
  const rows = dbRows.map(row => enrichReviewRow(row));
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

function enrichReviewRow(row) {
  const url = String(row.best_url || '').trim();
  const status = String(row.status || (row.code ? 'historical' : 'bookmark'));
  const finalTags = raindropExplicitOrAutoTags(row);
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
          <label class="code-detail-field"><span>Highlights</span><textarea data-code-detail-field="highlights" spellcheck="false">${esc(row.highlights || '')}</textarea></label>
          <label class="code-detail-field"><span>Cover</span><input data-code-detail-field="raindrop_cover" value="${esc(row.raindrop_cover || '')}"></label>
          <label class="code-detail-field"><span>Raindrop ID</span><input data-code-detail-field="raindrop_id" value="${esc(row.raindrop_id || '')}"></label>
          <label class="code-detail-field"><span>Last modified</span><input data-code-detail-field="last_modified" value="${esc(row.last_modified || '')}"></label>
          <label class="code-detail-field"><span>Favorite</span><input type="checkbox" data-code-detail-field="favorite" ${row.favorite ? 'checked' : ''}></label>
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
  persistBookmarkPanel(id, panel);
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
        <span>当前预览受上方搜索框影响；导出保留 Raindrop 官方 11 个字段，无效链接会明确排除。</span>
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
  const dbRows = api.dbGetBookmarkLibrary({ search: q || '', limit: 50000 });
  const dbById = new Map(dbRows.map(row => [Number(row.id), row]));
  const bundle = api.dbBuildRaindropExport({ search: q || '' });
  const exportable = (bundle.records || []).map(record => {
    const row = dbById.get(Number(record.bookmark_id)) || {};
    return {
      ...row,
      id: Number(record.bookmark_id),
      item: record,
      url: record.url,
      title: record.title,
      folder: record.folder,
      finalTags: splitTagInput(record.tags),
      created: record.created,
    };
  });
  const blocked = (bundle.blocked || []).map(record => {
    const row = dbById.get(Number(record.bookmark_id)) || {};
    return { ...row, id: Number(record.bookmark_id), item: record, url: record.url, title: record.title, folder: record.folder, finalTags: splitTagInput(record.tags), created: record.created };
  });
  const manual = [];
  const issues = [];

  for (const row of blocked) {
    const message = row.item?.reason === 'invalid_url'
      ? '链接不是有效的 HTTP/HTTPS 地址：这条记录不会进入导出文件'
      : '无链接：这条记录不会进入导出文件';
    issues.push(exportIssue(row, 'danger', message));
  }

  for (const row of exportable) {
    const finalTags = row.finalTags || [];
    const folder = row.folder || '';
    if (row.status === 'not_found') {
      manual.push(row);
      issues.push(exportIssue(row, 'warn', '状态为 not_found 但存在链接，建议人工确认'));
    }
    if (!String(row.raindrop_title || '').trim()) issues.push(exportIssue(row, 'info', 'Title 使用番号、链接或 Untitled 作为默认值'));
    if (!String(row.raindrop_folder || '').trim() && folder) issues.push(exportIssue(row, 'info', `Collection 使用默认值：${folder}`));
    if (!String(row.raindrop_tags || '').trim() && finalTags.length) issues.push(exportIssue(row, 'info', 'Tags 使用自动生成值'));
    if (!finalTags.length) issues.push(exportIssue(row, 'warn', 'Tags 为空，建议补充'));
    if (!String(row.raindrop_created || '').trim()) issues.push(exportIssue(row, 'info', 'Created 使用数据库创建时间'));
  }

  return { total: Number(bundle.summary?.total || dbRows.length), rows: dbRows, exportable, blocked, manual, issues, summary: bundle.summary || {} };
}

function defaultExportFolder(row) {
  return row.status === 'not_found' ? '需要手动核验' : 'MissAV_Import';
}

function exportIssue(row, severity, message) {
  return { id: row.id, code: row.code, label: row.code || row.raindrop_title || row.title || `收藏 #${row.id}`, severity, message };
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
            <td class="mono">${esc(row.code || '-')}</td>
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
      <strong>${esc(issue.label)}</strong><span>${esc(issue.message)}</span>
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
      <thead><tr><th>ID</th><th>女优 Tag</th><th>番号数</th><th>番号示例</th><th>操作</th></tr></thead>
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
  state.selectedCodeId = Number(id) || null;
  state.codeStatusFilter = 'all';
  state.codeCollectionFilter = 'all';
  if (DOM.librarySearch) DOM.librarySearch.value = state.selectedCodeId ? '' : (code || '');
  $$('.library-tabs .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.libraryTab === 'codes'));
  await refreshLibrary();
}
function renderLibraryBackups(q) {
  const stats = api.dbGetStats();
  const inventory = api.dbGetDatabaseInventory();
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
      <section class="database-reset-panel">
        <div>
          <strong>正式启用前归零 / 全库重新开始</strong>
          <p>当前数据库共 ${inventory.businessRows} 行业务数据，分布在 ${inventory.tables.filter(table => table.rowCount > 0).length} 张表。操作会先创建完整 SQLite 备份，再清空番号、标签与关系、处理批次和四阶段任务、站点缓存、Raindrop 映射、Telegram 来源/消息指纹/导入历史，以及旧兼容收藏数据。</p>
          <small>保留：数据库结构、备份文件、外观设置，以及 Windows 安全存储中的 Chrome 配对、Raindrop/Telegram 令牌和会话。</small>
        </div>
        <button class="btn btn-danger" data-action="database-reset-all">备份并清空全部业务数据</button>
      </section>
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
    pre_full_reset: '全库归零前',
    auto: '自动',
    import: '导入前',
    bulk_edit: '批量编辑前',
  };
  return map[reason] || reason || '-';
}
function renderLibraryCodes(q) {
  const query = {
    search: q,
    statusFilter: state.codeStatusFilter,
    sort: state.codeSort,
    page: state.codePage,
    pageSize: state.codePageSize,
  };
  let pageData = api.dbGetCodeLibraryPage(query);
  const pageCount = Math.max(1, Number(pageData.pageCount) || 1);
  state.codePage = Math.min(Math.max(1, state.codePage), pageCount);
  if (state.codePage !== Number(pageData.page)) {
    pageData = api.dbGetCodeLibraryPage({ ...query, page: state.codePage });
  }
  const pageRows = pageData.rows || [];
  const rows = pageRows;
  state.libraryCodes = rows;
  state.libraryCodeAllRows = rows;
  state.libraryCodeTotal = Number(pageData.total) || 0;
  const start = (state.codePage - 1) * state.codePageSize;
  const availableIds = new Set(rows.map(row => Number(row.id)));
  if (!availableIds.has(Number(state.codeSelectionAnchorId))) state.codeSelectionAnchorId = null;
  if (state.selectedCodeId && !availableIds.has(Number(state.selectedCodeId))) state.selectedCodeId = pageRows[0]?.id || null;
  if (!state.selectedCodeId && pageRows.length) state.selectedCodeId = pageRows[0].id;
  const detailRow = rows.find(row => Number(row.id) === Number(state.selectedCodeId)) || pageRows[0] || null;

  DOM.libraryContent.innerHTML = `
    <div class="code-workbench">
      <div class="library-action-bar code-primary-toolbar">
        <button class="btn btn-secondary btn-sm" data-action="create-code">新增番号</button>
        <button class="btn btn-outline btn-sm" data-action="open-import-compare">导入并去重</button>
        <button class="btn btn-outline btn-sm" data-action="code-select-filtered">全选当前结果 ${state.libraryCodeTotal}</button>
        <button class="btn btn-outline btn-sm" data-action="code-clear-selection">清空选择</button>
        <button class="btn btn-outline btn-sm" data-action="code-copy-selected">复制选中番号</button>
        <label class="code-toolbar-field"><span>筛选</span><select data-code-filter-status="1">
          <option value="all" ${state.codeStatusFilter === 'all' ? 'selected' : ''}>全部</option>
          <option value="ok" ${state.codeStatusFilter === 'ok' ? 'selected' : ''}>已找到</option>
          <option value="not_found" ${state.codeStatusFilter === 'not_found' ? 'selected' : ''}>未找到</option>
          <option value="need_manual_check" ${state.codeStatusFilter === 'need_manual_check' ? 'selected' : ''}>需核验</option>
          <option value="network_error" ${state.codeStatusFilter === 'network_error' ? 'selected' : ''}>网络错误</option>
          <option value="no_url" ${state.codeStatusFilter === 'no_url' ? 'selected' : ''}>无链接</option>
          <option value="no_actress" ${state.codeStatusFilter === 'no_actress' ? 'selected' : ''}>无女优 Tag</option>
          <option value="no_genre" ${state.codeStatusFilter === 'no_genre' ? 'selected' : ''}>无类型 Tag</option>
        </select></label>
        <label class="code-toolbar-field"><span>排序</span><select data-code-sort="1">
          <option value="recent" ${state.codeSort === 'recent' ? 'selected' : ''}>最近加入</option>
          <option value="code" ${state.codeSort === 'code' ? 'selected' : ''}>番号 A-Z</option>
          <option value="status" ${state.codeSort === 'status' ? 'selected' : ''}>处理状态</option>
        </select></label>
        <span>共 <strong>${state.libraryCodeTotal}</strong> 条 · 已选 <strong data-code-selected-count="1">${state.codeSelected.size}</strong></span>
      </div>
      <details class="library-bulk-drawer" ${state.codeSelected.size ? 'open' : ''}>
        <summary>批量处理选中的 <strong data-code-selected-count="1">${state.codeSelected.size}</strong> 条番号</summary>
        <div class="library-bulk-grid">
          <label class="code-toolbar-field"><span>状态</span><select data-code-bulk-status-value>${statusOptionsHtml('ok')}</select></label>
          <button class="btn btn-outline btn-sm" data-action="code-bulk-status">应用状态</button>
          <button class="btn btn-outline btn-sm" data-action="code-bulk-add-actress">追加女优</button>
          <button class="btn btn-outline btn-sm" data-action="code-bulk-remove-actress">移除女优</button>
          <button class="btn btn-outline btn-sm" data-action="code-bulk-add-genre">追加类型</button>
          <button class="btn btn-outline btn-sm" data-action="code-bulk-remove-genre">移除类型</button>
          <button class="btn btn-outline btn-sm" data-action="code-bulk-generate-url">生成链接</button>
          <button class="btn btn-outline btn-sm" data-action="code-bulk-normalize">规范番号</button>
          <button class="btn btn-danger btn-sm" data-action="code-bulk-delete">删除选中</button>
        </div>
      </details>
      <div class="code-manager-layout">
        <section class="raindrop-record-pane">
          <div class="record-pane-head"><span>${state.libraryCodeTotal ? `${start + 1}-${Math.min(start + pageRows.length, state.libraryCodeTotal)} / ${state.libraryCodeTotal}` : '0 条记录'} · 单击选择，Ctrl 增减，Shift 连选，Ctrl+Shift 追加区间</span><div><button class="btn btn-outline btn-sm" data-action="code-page" data-page="${state.codePage - 1}" ${state.codePage <= 1 ? 'disabled' : ''}>上一页</button><button class="btn btn-outline btn-sm" data-action="code-page" data-page="${state.codePage + 1}" ${state.codePage >= pageCount ? 'disabled' : ''}>下一页</button></div></div>
          <div class="raindrop-record-list" role="listbox" aria-multiselectable="true">${pageRows.length ? pageRows.map(renderCodeLibraryItem).join('') : '<div class="library-empty">当前筛选下没有番号记录</div>'}</div>
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
  if (state.codeSort === 'status') next.sort((a, b) => String(a.status || '').localeCompare(String(b.status || '')) || String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));
  return next;
}

function renderCodeLibraryItem(row) {
  const id = Number(row.id);
  const selected = state.codeSelected.has(id);
  const focused = Number(state.selectedCodeId) === id;
  const tags = [...(row.actress_tags || []), ...(row.genre_tags || [])];
  return `<article class="raindrop-record-item manager-code-record ${selected ? 'is-selected' : ''} ${focused ? 'is-focused' : ''}" data-code-row="${id}" role="option" aria-selected="${selected ? 'true' : 'false'}" tabindex="0">
    <input type="checkbox" data-code-select-row="${id}" ${selected ? 'checked' : ''} aria-label="选择 ${esc(row.code)}">
    <button class="record-main" data-action="code-focus-row" data-id="${id}">
      <strong>${esc(row.code)}</strong>
      <span class="record-code">${esc(statusDisplayLabel(row.status))} · #${id}</span>
      <span class="record-link">${esc(row.best_url || 'No link')}</span>
      <span class="record-tags">${tags.slice(0, 4).map(tag => `<i>${esc(tag)}</i>`).join('') || '<i>无 Tags</i>'}</span>
    </button>
    <div class="record-side">
      <span class="code-status-pill status-${esc(row.status || 'unknown')}">${esc(statusDisplayLabel(row.status))}</span>
      ${row.best_url ? `<button class="record-open-btn" data-action="open-url" data-url="${esc(row.best_url)}" title="打开链接">↗</button>` : ''}
    </div>
  </article>`;
}

function filterCodeRows(rows) {
  const filter = state.codeStatusFilter || 'all';
  if (filter === 'all') return rows;
  return rows.filter(row => {
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
    return `<aside class="code-detail-panel"><div class="library-empty">单击一条番号记录后编辑详情</div></aside>`;
  }
  return `
    <aside class="code-detail-panel" data-code-detail-id="${row.id}">
      <div class="code-detail-header">
        <div>
          <span>番号记录 #${row.id}</span>
          <h3 data-rd-title>${esc(row.code)}</h3>
          <p data-rd-link>${esc(row.best_url || 'No link')}</p>
        </div>
        <span class="code-status-pill status-${esc(row.status || 'unknown')}">${esc(statusDisplayLabel(row.status))}</span>
      </div>
      <div class="code-detail-fields">
        <label class="code-detail-field"><span>番号</span><input data-code-detail-field="code" value="${esc(row.code || '')}"></label>
        <label class="code-detail-field"><span>MissAV 链接</span><input data-code-detail-field="best_url" value="${esc(row.best_url || '')}"></label>
        <label class="code-detail-field"><span>处理状态</span><select data-code-detail-field="status">${statusOptionsHtml(row.status || 'ok')}</select></label>
        <label class="code-detail-field"><span>女优 Tags</span><textarea data-code-detail-field="actress_tags" spellcheck="false">${esc((row.actress_tags || []).join('\n'))}</textarea></label>
        <label class="code-detail-field"><span>类型 Tags</span><textarea data-code-detail-field="genre_tags" spellcheck="false">${esc((row.genre_tags || []).join('\n'))}</textarea></label>
        <label class="code-detail-field"><span>加入时间</span><input value="${esc(row.created_at || '')}" readonly></label>
      </div>
      <div class="code-detail-actions">
        <button class="btn btn-success btn-sm" data-action="save-code-detail" data-id="${row.id}">保存</button>
        <button class="btn btn-secondary btn-sm" data-action="save-code-detail-next" data-id="${row.id}">保存并下一条</button>
        <button class="btn btn-outline btn-sm" data-action="detail-revert" data-id="${row.id}">撤销</button>
        <button class="btn btn-outline btn-sm" data-action="code-fill-detail-url" data-id="${row.id}">生成链接</button>
        ${row.best_url ? `<button class="btn btn-outline btn-sm" data-action="open-url" data-url="${esc(row.best_url)}">打开</button>` : ''}
        <button class="btn btn-danger btn-sm" data-action="delete-code" data-id="${row.id}" data-code="${esc(row.code)}">删除</button>
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
  return state.libraryCodes || [];
}

function selectedCodeRows() {
  return api.dbGetCodeLibraryByIds(selectedCodeIds());
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
    row.classList.toggle('is-focused', Number(state.selectedCodeId) === id);
    row.setAttribute('aria-selected', state.codeSelected.has(id) ? 'true' : 'false');
    const checkbox = row.querySelector('[data-code-select-row]');
    if (checkbox) checkbox.checked = state.codeSelected.has(id);
  });
  const drawer = DOM.libraryContent?.querySelector('.library-bulk-drawer');
  if (drawer && count) drawer.open = true;
}

async function selectCodeById(id, event = {}) {
  const clickedId = Number(id);
  const orderedIds = (state.libraryCodes || []).map(row => Number(row.id));
  const selection = window.ExplorerSelection?.applySelection({
    orderedIds,
    selectedIds: [...state.codeSelected],
    clickedId,
    anchorId: state.codeSelectionAnchorId,
    ctrlKey: Boolean(event.ctrlKey || event.metaKey),
    shiftKey: Boolean(event.shiftKey),
  }) || { selectedIds: [clickedId], anchorId: clickedId };
  state.codeSelected = new Set(selection.selectedIds.map(Number));
  state.codeSelectionAnchorId = selection.anchorId;
  state.selectedCodeId = clickedId;
  updateCodeSelectionUi();
  const row = (state.libraryCodeAllRows || []).find(item => Number(item.id) === clickedId) || null;
  const currentPanel = DOM.libraryContent?.querySelector('.code-detail-panel');
  if (currentPanel) currentPanel.outerHTML = renderCodeDetailPanel(row);
  renderIcons();
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
  const hiddenLegacyTables = new Set(['bookmarks', 'bookmark_collections']);
  const tables = api.dbGetEditableTables().filter(table => !hiddenLegacyTables.has(table.name));
  state.rawDbTables = tables;
  if (!tables.some(t => t.name === state.rawDbTable)) state.rawDbTable = tables.find(table => table.name === 'codes')?.name || tables[0]?.name || 'codes';
  const limit = state.rawDbPageSize;
  let data = api.dbGetRawTableRows(state.rawDbTable, { search: q, limit, offset: (Math.max(1, state.rawDbPage) - 1) * limit });
  const pageCount = Math.max(1, Math.ceil(Number(data.filteredTotal || 0) / limit));
  if (state.rawDbPage > pageCount) {
    state.rawDbPage = pageCount;
    data = api.dbGetRawTableRows(state.rawDbTable, { search: q, limit, offset: (state.rawDbPage - 1) * limit });
  }
  state.rawDbData = data;
  const currentTable = tables.find(table => table.name === state.rawDbTable) || tables[0] || {};
  const tableGroups = new Map();
  for (const table of tables) {
    const category = table.category || '其他';
    if (!tableGroups.has(category)) tableGroups.set(category, []);
    tableGroups.get(category).push(table);
  }
  const tableOptions = [...tableGroups.entries()].map(([category, group]) => `
    <optgroup label="${esc(category)}">
      ${group.map(t => `<option value="${esc(t.name)}" ${t.name === state.rawDbTable ? 'selected' : ''}>${esc(t.label)} · ${esc(t.name)}</option>`).join('')}
    </optgroup>`).join('');
  const selectedCount = state.rawDbSelected.size;
  const bulkColumns = data.editable.map(column => `<option value="${esc(column)}">${esc(column)}</option>`).join('');
  DOM.libraryContent.innerHTML = `
    <div class="db-editor-shell">
      <div class="library-action-bar db-editor-toolbar">
        <label class="raw-table-picker"><span>数据表</span><select data-raw-table-select="1">${tableOptions}</select></label>
        <button class="btn btn-secondary btn-sm" data-action="raw-add-row" ${data.insertable.length ? '' : 'disabled'}>新增行</button>
        <button class="btn btn-outline btn-sm" data-action="raw-select-page">选择本页</button>
        <button class="btn btn-outline btn-sm" data-action="raw-clear-selection" ${selectedCount ? '' : 'disabled'}>清空选择</button>
        <button class="btn btn-outline btn-sm" data-action="raw-copy-scope">复制选中/筛选</button>
        <button class="btn btn-outline btn-sm" data-action="raw-export-scope">导出 CSV</button>
        <button class="btn btn-outline btn-sm" data-action="raw-page" data-page="${state.rawDbPage - 1}" ${state.rawDbPage <= 1 ? 'disabled' : ''}>上一页</button>
        <button class="btn btn-outline btn-sm" data-action="raw-page" data-page="${state.rawDbPage + 1}" ${state.rawDbPage >= pageCount ? 'disabled' : ''}>下一页</button>
        <span>${esc(data.label)}：显示 ${data.rows.length} / ${data.filteredTotal} 行（全表 ${data.total}）· 第 ${state.rawDbPage}/${pageCount} 页</span>
      </div>
      <div class="raw-table-info">
        <div><strong>${esc(currentTable.category || '数据表')} · ${esc(currentTable.label || data.label)}</strong><span>${esc(currentTable.description || '')}</span></div>
        <div><b data-raw-selected-count>${selectedCount}</b><span>已选择</span></div>
      </div>
      <div class="library-action-bar raw-bulk-toolbar">
        <label class="raw-table-picker"><span>批量字段</span><select data-raw-bulk-column>${bulkColumns || '<option value="">无可批量编辑字段</option>'}</select></label>
        <button class="btn btn-secondary btn-sm" data-action="raw-bulk-edit" ${selectedCount && data.editable.length ? '' : 'disabled'}>批量修改</button>
        <button class="btn btn-danger btn-sm" data-action="raw-bulk-delete" ${selectedCount ? '' : 'disabled'}>删除选中 ${selectedCount || ''}</button>
        <span>单击替换选择；Ctrl 切换；Shift 连选；Ctrl+Shift 追加区间。编辑字段会校验番号唯一性、关系主键和 JSON 格式，批量写入前自动备份。</span>
      </div>
      <div class="db-table-wrapper">
        <table class="library-table db-raw-table">
          <thead><tr><th class="raw-select-column">选择</th>${data.columns.map(col => `<th>${esc(col)}${data.pk.includes(col) ? '<small> PK</small>' : ''}</th>`).join('')}<th>操作</th></tr></thead>
          <tbody>${data.rows.length ? data.rows.map(row => renderRawTableRow(data, row)).join('') : `<tr><td colspan="${data.columns.length + 2}"><div class="library-empty">该表暂无记录</div></td></tr>`}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderRawTableRow(data, row) {
  const pk = rawPkForRow(row, data.pk);
  const selected = state.rawDbSelected.has(pk);
  return `<tr data-raw-row-pk="${esc(pk)}" class="${selected ? 'raw-row-selected' : ''}">
    <td class="raw-select-column"><input type="checkbox" data-raw-select-row="${esc(pk)}" ${selected ? 'checked' : ''}></td>${data.columns.map(col => {
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

function selectRawRow(pk, event = {}) {
  const ordered = (state.rawDbData?.rows || []).map(row => rawPkForRow(row, state.rawDbData.pk));
  const ctrlKey = Boolean(event.ctrlKey);
  const shiftKey = Boolean(event.shiftKey);
  const anchor = ordered.includes(state.rawDbSelectionAnchor) ? state.rawDbSelectionAnchor : null;
  if (shiftKey) {
    const startKey = anchor || pk;
    const start = ordered.indexOf(startKey);
    const end = ordered.indexOf(pk);
    const range = start >= 0 && end >= 0 ? ordered.slice(Math.min(start, end), Math.max(start, end) + 1) : [pk];
    if (!ctrlKey) state.rawDbSelected.clear();
    for (const key of range) state.rawDbSelected.add(key);
    state.rawDbSelectionAnchor = startKey;
  } else if (ctrlKey) {
    if (state.rawDbSelected.has(pk)) state.rawDbSelected.delete(pk);
    else state.rawDbSelected.add(pk);
    state.rawDbSelectionAnchor = pk;
  } else {
    state.rawDbSelected = new Set([pk]);
    state.rawDbSelectionAnchor = pk;
  }
  updateRawSelectionUi();
}

function updateRawSelectionUi() {
  const count = state.rawDbSelected.size;
  DOM.libraryContent?.querySelectorAll('[data-raw-row-pk]').forEach(row => {
    const selected = state.rawDbSelected.has(row.dataset.rawRowPk || '');
    row.classList.toggle('raw-row-selected', selected);
    const checkbox = row.querySelector('[data-raw-select-row]');
    if (checkbox) checkbox.checked = selected;
  });
  const counter = DOM.libraryContent?.querySelector('[data-raw-selected-count]');
  if (counter) counter.textContent = String(count);
  const bulkEdit = DOM.libraryContent?.querySelector('[data-action="raw-bulk-edit"]');
  const bulkDelete = DOM.libraryContent?.querySelector('[data-action="raw-bulk-delete"]');
  const clear = DOM.libraryContent?.querySelector('[data-action="raw-clear-selection"]');
  if (bulkEdit) bulkEdit.disabled = !count || !(state.rawDbData?.editable || []).length;
  if (bulkDelete) {
    bulkDelete.disabled = !count;
    bulkDelete.textContent = count ? `删除选中 ${count}` : '删除选中';
  }
  if (clear) clear.disabled = !count;
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

function runStatusLabel(status) {
  switch (status) {
    case 'running': return '运行中';
    case 'paused': return '已暂停';
    case 'failed': return '异常结束';
    default: return '已完成';
  }
}

function runStatusClass(status) {
  if (status === 'running') return 'is-running';
  if (status === 'paused') return 'is-paused';
  if (status === 'failed') return 'is-failed';
  return 'is-completed';
}

function pipelineRunStateLabel(run) {
  if (Number(run?.pipelineVersion || 1) < 2) return runStatusLabel(run?.status);
  if (run?.pipelineState === 'active') return '流程执行中';
  if (run?.pipelineState === 'attention') return '流程需处理';
  if (run?.pipelineState === 'pending') return '后续待处理';
  return '全流程完成';
}

function pipelineRunStateClass(run) {
  if (Number(run?.pipelineVersion || 1) < 2) return runStatusClass(run?.status);
  if (run?.pipelineState === 'active') return 'is-running';
  if (run?.pipelineState === 'attention') return 'is-failed';
  if (run?.pipelineState === 'pending') return 'is-paused';
  return 'is-completed';
}

function pipelineRunProgress(run) {
  return Number(run?.pipelineVersion || 1) >= 2 && Number.isFinite(run?.pipelineProgress)
    ? Number(run.pipelineProgress)
    : Number(run?.progress || 0);
}

function renderStageMetric(run, key, label) {
  const stage = run?.stages?.[key];
  if (!stage?.total) return `<div><strong>-</strong><span>${esc(label)} · 旧版未启用</span></div>`;
  return `<div class="pipeline-stage-metric">
    <strong>${stage.completed}/${stage.total}</strong>
    <span>${esc(label)} · 待 ${stage.pending} · 异常 ${stage.exceptions}</span>
  </div>`;
}

function runItemStatusLabel(item) {
  if (item.itemStatus === 'queued') return '等待处理';
  if (item.itemStatus === 'running') return '处理中';
  if (item.itemStatus === 'skipped') return '历史跳过';
  if (item.itemStatus === 'duplicate') return '本批重复';
  return statusLabel(item);
}

function renderLibraryRuns(q = '') {
  const query = String(q || '').trim().toLowerCase();
  const allRuns = api.dbGetRecentRuns(200);
  const runs = query
    ? allRuns.filter(run => [run.name, run.sourceLabel, run.status, run.speedMode, run.id].join(' ').toLowerCase().includes(query))
    : allRuns;
  if (!runs.some(run => run.id === state.selectedRunId)) state.selectedRunId = runs[0]?.id || null;
  const selected = state.selectedRunId ? api.dbGetRun(state.selectedRunId) : null;
  const activeCount = allRuns.filter(run => ['running', 'paused'].includes(run.status) && run.lookupPending > 0).length;
  const completedCount = allRuns.filter(run => Number(run.pipelineVersion || 1) >= 2 ? run.pipelineState === 'completed' : run.status === 'completed').length;
  const totalItems = allRuns.reduce((sum, run) => sum + Number(run.total || 0), 0);

  DOM.libraryContent.innerHTML = `
    <div class="batch-workbench">
      <div class="batch-summary-strip">
        <div><strong>${allRuns.length}</strong><span>全部批次</span></div>
        <div><strong>${activeCount}</strong><span>可继续查询</span></div>
        <div><strong>${completedCount}</strong><span>全流程完成</span></div>
        <div><strong>${totalItems}</strong><span>累计条目</span></div>
      </div>
      <div class="batch-toolbar">
        <span>批次数据永久保存在本地数据库；停止或异常退出后可继续剩余项。</span>
        <button class="btn btn-outline btn-sm" data-action="runs-refresh">刷新</button>
      </div>
      <div class="batch-layout">
        <section class="batch-list-pane">
          <div class="batch-pane-head"><strong>处理批次</strong><span>${runs.length} 个匹配项</span></div>
          <div class="batch-list" role="listbox">
            ${runs.length ? runs.map(run => `
              <button class="batch-list-row ${run.id === state.selectedRunId ? 'is-selected' : ''}" data-action="run-select" data-run-id="${run.id}" aria-selected="${run.id === state.selectedRunId ? 'true' : 'false'}">
                <span class="batch-list-main"><strong>${esc(run.name)}</strong><small>${esc(run.sourceLabel || '未记录来源')}</small></span>
                <span class="batch-progress-inline"><i style="width:${Math.max(0, Math.min(100, pipelineRunProgress(run)))}%"></i></span>
                <span class="batch-list-meta"><b class="batch-status ${pipelineRunStateClass(run)}">${pipelineRunStateLabel(run)}</b><small>${Number(run.pipelineVersion || 1) >= 2 ? `任务 ${run.pipelineCompleted}/${run.pipelineTaskCount}` : `${run.completed}/${run.total} · 剩余 ${run.pending}`}</small></span>
              </button>`).join('') : '<div class="library-empty">没有匹配的处理批次</div>'}
          </div>
        </section>
        <section class="batch-detail-pane">
          ${selected ? renderProcessingRunDetail(selected) : '<div class="library-empty">选择一个批次查看明细</div>'}
        </section>
      </div>
    </div>`;
  window.SheetTable?.enhanceTable(DOM.libraryContent.querySelector('.batch-items-table'));
  renderIcons();
}

function renderProcessingRunDetail(run) {
  const items = run.items || [];
  const workspace = state.runDetailWorkspace === 'av123' ? 'av123' : 'missav';
  const missavPending = lookupStagePending(run, 'missavLookup');
  const av123Pending = lookupStagePending(run, 'av123Lookup');
  const missavSpeed = processingSpeed.getProfile(run.missavSpeedMode || run.speedMode).label;
  const av123Speed = processingSpeed.getProfile(run.av123SpeedMode || run.speedMode).label;
  const normalizedMissavPolicy = normalizeMissavSpeedPolicy(run.missavSpeedPolicy);
  const missavPolicy = normalizedMissavPolicy === 'balanced' ? '动态半速' : normalizedMissavPolicy === 'fixed' ? '保持工作路' : '稳定自适应';
  const missavRate = `${run.missavRateMode === 'fixed' ? '固定' : '自动探速'} ≤ ${normalizeSiteRateCap('missav', run.missavRateCap)} RPS`;
  const normalizedPolicy = normalize123AvSpeedPolicy(run.av123SpeedPolicy);
  const av123Policy = normalizedPolicy === 'staged' ? '分层收尾' : normalizedPolicy === 'balanced' ? '动态半速' : '保持并发';
  const av123Rate = `${run.av123RateMode === 'fixed' ? '固定' : '自动探速'} ≤ ${normalize123AvRateCap(run.av123RateCap)} RPS`;
  return `
    <div class="batch-detail-head">
      <div><span>批次 #${run.id}</span><h3>${esc(run.name)}</h3><p>${esc(run.sourceLabel || '未记录来源')} · MissAV ${esc(missavSpeed)} / ${esc(missavPolicy)} / ${esc(missavRate)} · 123AV ${esc(av123Speed)} / ${esc(av123Policy)} / ${esc(av123Rate)}</p></div>
      <span class="batch-status ${pipelineRunStateClass(run)}">${pipelineRunStateLabel(run)}</span>
    </div>
    <div class="batch-detail-actions">
      <button class="btn btn-secondary btn-sm" data-action="run-load" data-run-id="${run.id}">载入结果</button>
      ${missavPending > 0 ? `<button class="btn btn-warning btn-sm" data-action="run-resume" data-site="missav" data-run-id="${run.id}" ${state.isProcessing ? 'disabled' : ''}>继续 MissAV ${missavPending} 项</button>` : ''}
      ${av123Pending > 0 ? `<button class="btn btn-warning btn-sm" data-action="run-resume" data-site="av123" data-run-id="${run.id}" ${state.isProcessing ? 'disabled' : ''}>继续 123AV ${av123Pending} 项</button>` : ''}
      ${state.currentRunId === run.id && state.isProcessing ? `<button class="btn btn-danger btn-sm" data-action="run-stop">停止 ${state.activeLookupSite === 'av123' ? '123AV' : 'MissAV'} 并保存</button>` : ''}
      <button class="btn btn-outline btn-sm" data-action="run-rename" data-run-id="${run.id}" data-run-name="${esc(run.name)}">重命名</button>
      <button class="btn btn-danger btn-sm" data-action="run-delete" data-run-id="${run.id}" ${(state.isProcessing && state.currentRunId !== run.id) || state.pendingDeleteRunId === run.id ? 'disabled' : ''}><i data-lucide="trash-2"></i><span>${state.pendingDeleteRunId === run.id ? '正在停止并删除…' : state.isProcessing && state.currentRunId === run.id ? '停止并删除整个批次' : '删除整个批次'}</span></button>
    </div>
    ${Number(run.pipelineVersion || 1) < 2 ? '<div class="batch-legacy-note">旧版 MissAV 单支线批次：保留原结果，不补建 123AV 待办。</div>' : ''}
    <div class="pipeline-branch-summary-grid">
      <section class="pipeline-branch-summary pipeline-branch-missav">
        <div class="pipeline-branch-head"><strong>MissAV</strong><span>查询与标签</span></div>
        <div class="batch-detail-metrics">
          ${renderStageMetric(run, 'missavLookup', '页面查询')}
          ${renderStageMetric(run, 'raindropSync', 'Raindrop 同步')}
        </div>
      </section>
      <section class="pipeline-branch-summary pipeline-branch-av123">
        <div class="pipeline-branch-head"><strong>123AV</strong><span>查询与账号</span></div>
        <div class="batch-detail-metrics">
          ${renderStageMetric(run, 'av123Lookup', '精确查询')}
          ${renderStageMetric(run, 'av123Favorite', '收藏状态')}
        </div>
      </section>
    </div>
    <div class="batch-detail-meta"><span>批次：${esc(runStatusLabel(run.status))} ${run.completed}/${run.total}</span><span>开始：${esc(run.started_at || '-')}</span><span>结束：${esc(run.finished_at || '-')}</span><span>输出：${esc(run.outputDir || '-')}</span></div>
    <div class="batch-workspace-switch" role="group" aria-label="选择批次站点板块">
      <button type="button" class="${workspace === 'missav' ? 'active' : ''}" data-action="run-workspace" data-workspace="missav">MissAV 明细</button>
      <button type="button" class="${workspace === 'av123' ? 'active' : ''}" data-action="run-workspace" data-workspace="av123">123AV 明细</button>
    </div>
    <div class="batch-items-wrapper">
      <table class="library-table batch-items-table" data-sheet-key="processing-run-${workspace}-v1">
        <thead>${workspace === 'missav'
          ? '<tr><th>#</th><th>番号</th><th class="col-task">MissAV 查询</th><th class="col-task">Raindrop 同步</th><th>Tags</th><th>MissAV 错误 / 备注</th></tr>'
          : '<tr><th>#</th><th>番号</th><th class="col-task">123AV 查询</th><th class="col-task">123AV 收藏</th><th>123AV 错误 / 备注</th></tr>'}
        </thead>
        <tbody>${items.length ? items.map(item => `
          <tr>
            <td class="mono">${item.position + 1}</td>
            <td class="mono">${esc(item.code)}</td>
            ${workspace === 'missav'
              ? `<td class="col-task">${renderTaskCell(item, 'missavLookup', 'library')}</td>
                <td class="col-task">${renderTaskCell(item, 'raindropSync', 'library')}</td>
                <td>${esc((item.finalTags || []).join(', ')) || '-'}</td>
                <td title="${esc(workflowTaskErrors(item, RESULT_WORKSPACES.missav.stages, true))}">${esc(workflowTaskErrors(item, RESULT_WORKSPACES.missav.stages, true) || '-')}</td>`
              : `<td class="col-task">${renderTaskCell(item, 'av123Lookup', 'library')}</td>
                <td class="col-task">${renderTaskCell(item, 'av123Favorite', 'library')}</td>
                <td title="${esc(workflowTaskErrors(item, RESULT_WORKSPACES.av123.stages, false))}">${esc(workflowTaskErrors(item, RESULT_WORKSPACES.av123.stages, false) || '-')}</td>`}
          </tr>`).join('') : `<tr><td colspan="${workspace === 'missav' ? 6 : 5}"><div class="library-empty">旧版统计记录没有逐条明细</div></td></tr>`}</tbody>
      </table>
    </div>`;
}

async function buildDiagnosticReport() {
  const info = await api.logGetInfo();
  const recent = await api.logReadRecent(1024 * 1024);
  const stats = state.dbReady ? api.dbGetStats() : {};
  return [
    'MissAV Manager 诊断日志',
    `生成时间: ${new Date().toISOString()}`,
    `版本: ${APP_VERSION}`,
    `日志文件: ${info.filePath}`,
    `数据库状态: ${state.dbReady ? 'ready' : 'not_ready'}`,
    `番号数: ${stats.codeCount || 0}`,
    `女优 Tag: ${stats.actressCount || 0}`,
    `类型 Tag: ${stats.genreCount || 0}`,
    '',
    '===== 最近运行日志 =====',
    recent || '(暂无日志)',
  ].join('\n');
}

async function renderLibraryLogs() {
  const info = await api.logGetInfo();
  const recent = await api.logReadRecent(512 * 1024);
  DOM.libraryContent.innerHTML = `
    <div class="runtime-log-workbench">
      <div class="library-action-bar">
        <button class="btn btn-secondary btn-sm" data-action="logs-refresh">刷新日志</button>
        <button class="btn btn-outline btn-sm" data-action="logs-copy">复制诊断报告</button>
        <button class="btn btn-outline btn-sm" data-action="logs-export">导出诊断日志</button>
        <button class="btn btn-outline btn-sm" data-action="logs-open-dir">打开日志目录</button>
        <span>当前 ${formatBytes(info.size)} / 上限 ${formatBytes(info.maxBytes)}，超过后自动轮换</span>
      </div>
      <div class="backup-path-panel"><span>日志文件</span><strong>${esc(info.filePath)}</strong></div>
      <textarea class="runtime-log-view" readonly spellcheck="false">${esc(recent || '暂无运行日志')}</textarea>
    </div>`;
}

function renderRunList(runs) {
  if (!runs || !runs.length) return '<div class="library-empty">暂无处理历史</div>';
  return `
    <table class="library-table">
      <thead><tr><th>ID</th><th>批次</th><th>状态</th><th>开始</th><th>进度</th><th>跳过</th><th>未找到</th><th>网络错误</th></tr></thead>
      <tbody>${runs.map(r => `
        <tr>
          <td class="mono">${r.id}</td><td>${esc(r.name || `批次 #${r.id}`)}</td><td><span class="batch-status ${runStatusClass(r.status)}">${runStatusLabel(r.status)}</span></td>
          <td>${esc(r.started_at || '')}</td><td>${r.completed}/${r.total}</td><td>${r.skipped}</td><td>${r.notFound}</td><td>${r.networkError}</td>
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
  const rowCheckbox = event.target.closest('[data-code-select-row]');
  if (rowCheckbox) {
    event.preventDefault();
    await selectCodeById(Number(rowCheckbox.dataset.codeSelectRow), event);
    return;
  }
  const rawCheckbox = event.target.closest('[data-raw-select-row]');
  if (rawCheckbox) {
    event.preventDefault();
    selectRawRow(rawCheckbox.dataset.rawSelectRow || '', event);
    return;
  }
  const btn = event.target.closest('[data-action]');
  if (!btn) {
    const row = event.target.closest('[data-code-row]');
    if (row && !event.target.closest('input, select, textarea, button')) await selectCodeById(Number(row.dataset.codeRow), event);
    const rawRow = event.target.closest('[data-raw-row-pk]');
    if (rawRow && !event.target.closest('input, select, textarea, button')) selectRawRow(rawRow.dataset.rawRowPk || '', event);
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

    if (action === 'backup-create') {
      await createManualBackup();
      return;
    }

    if (action === 'backup-refresh') {
      await refreshLibrary();
      return;
    }

    if (action === 'backup-open-dir') {
      await api.showDirectory(api.dbGetBackupDirectory());
      return;
    }

    if (action === 'backup-export-csv') {
      await exportDbCSVFromLibrary();
      return;
    }

    if (action === 'backup-copy-path') {
      await copyText(btn.dataset.path || '');
      toast('备份路径已复制', 'success');
      return;
    }

    if (action === 'backup-delete') {
      const fileName = btn.dataset.file || '';
      if (!confirm(`确认删除备份「${fileName}」？删除后不能从软件内恢复。`)) return;
      api.dbDeleteBackup(fileName);
      await refreshLibrary();
      toast('备份已删除', 'success');
      return;
    }

    if (action === 'backup-restore') {
      const fileName = btn.dataset.file || '';
      if (!confirm(`确认恢复备份「${fileName}」并替换当前数据库？软件会先自动保存一份恢复前备份。`)) return;
      const restored = api.dbRestoreBackup(fileName);
      refreshDbSummary();
      refreshResumableBatchPanel();
      await refreshLibrary();
      toast(`已恢复备份：${restored.backup?.fileName || fileName}`, 'success');
      return;
    }

    if (action === 'database-reset-all') {
      await resetAllDatabaseFromUi();
      return;
    }

    if (action === 'runs-refresh') {
      refreshResumableBatchPanel();
      await refreshLibrary();
      return;
    }

    if (action === 'run-select') {
      state.selectedRunId = Number(btn.dataset.runId || 0);
      await refreshLibrary();
      return;
    }

    if (action === 'run-workspace') {
      state.runDetailWorkspace = btn.dataset.workspace === 'av123' ? 'av123' : 'missav';
      await refreshLibrary();
      return;
    }

    if (action === 'run-load') {
      const batch = loadProcessingRunResults(Number(btn.dataset.runId || 0));
      toast(`已载入 ${batch.name} 的 ${batch.items.length} 条明细`, 'success');
      return;
    }

    if (action === 'run-resume') {
      await resumeProcessingRun(Number(btn.dataset.runId || 0), btn.dataset.site === 'av123' ? 'av123' : 'missav');
      return;
    }

    if (action === 'run-stop') {
      stopProcessing();
      return;
    }

    if (action === 'run-delete') {
      requestDeleteProcessingRun(Number(btn.dataset.runId || 0));
      return;
    }

    if (action === 'run-rename') {
      const runId = Number(btn.dataset.runId || 0);
      const currentName = btn.dataset.runName || '';
      const nextName = await showTextInputDialog({ title: '重命名处理批次', label: '批次名称', value: currentName, submitLabel: '保存' });
      if (!nextName || nextName.trim() === currentName) return;
      api.dbRenameRun(runId, nextName.trim());
      refreshResumableBatchPanel();
      await refreshLibrary();
      toast('批次名称已更新', 'success');
      return;
    }

    if (action === 'logs-refresh') {
      await renderLibraryLogs();
      return;
    }

    if (action === 'logs-copy') {
      await copyText(await buildDiagnosticReport());
      toast('诊断报告已复制，可直接粘贴给我', 'success');
      return;
    }

    if (action === 'logs-export') {
      const dir = await api.openDirectory({ title: '选择诊断日志保存目录' });
      if (!dir) return;
      const filePath = `${dir}\\${api.timePrefixToMinute()}_missav_diagnostic.log`;
      await api.writeFile(filePath, await buildDiagnosticReport(), 'utf-8');
      toast(`诊断日志已导出：${filePath}`, 'success');
      return;
    }

    if (action === 'logs-open-dir') {
      const info = await api.logGetInfo();
      await api.showDirectory(info.directory);
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
      const name = await showTextInputDialog({ title: '新增女优 Tag', label: 'Tag 名称', placeholder: '输入新的女优 tag 名称', submitLabel: '新增' });
      if (!name) return;
      api.dbCreateActressTag(name.trim());
      await afterDbWrite('女优 tag 已新增');
      return;
    }

    if (action === 'rename-tag') {
      const oldName = btn.dataset.name || '';
      const nextName = await showTextInputDialog({ title: '重命名女优 Tag', label: 'Tag 名称', value: oldName, submitLabel: '保存' });
      if (!nextName || nextName === oldName) return;
      api.dbRenameActressTag(Number(btn.dataset.id), nextName.trim());
      await afterDbWrite('重命名完成');
      return;
    }

    if (action === 'merge-tag') {
      const sourceId = Number(btn.dataset.id);
      const sourceName = btn.dataset.name || '';
      const targetInput = await showTextInputDialog({ title: '合并女优 Tag', label: `把「${sourceName}」合并到`, placeholder: '输入目标 Tag 名称或 ID', submitLabel: '查找' });
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
      await selectCodeById(Number(btn.dataset.id), event);
      return;
    }

    if (action === 'code-select-filtered') {
      const ids = api.dbGetCodeLibraryIds({
        search: DOM.librarySearch?.value.trim() || '',
        statusFilter: state.codeStatusFilter,
        sort: state.codeSort,
        limit: 200000,
      });
      for (const id of ids) state.codeSelected.add(Number(id));
      state.codeSelectionAnchorId = state.libraryCodes?.[0]?.id || null;
      updateCodeSelectionUi();
      return;
    }

    if (action === 'code-clear-selection') {
      state.codeSelected.clear();
      state.codeSelectionAnchorId = null;
      updateCodeSelectionUi();
      return;
    }

    if (action === 'code-copy-selected') {
      await copySelectedCodeList();
      return;
    }

    if (action === 'code-export-raindrop-csv') {
      await exportLibraryRaindrop('csv', { search: DOM.librarySearch?.value.trim() || '' });
      return;
    }

    if (action === 'code-export-raindrop-html') {
      await exportLibraryRaindrop('html', { search: DOM.librarySearch?.value.trim() || '' });
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
      await exportLibraryRaindrop('csv', { search: DOM.librarySearch?.value.trim() || '' });
      return;
    }

    if (action === 'preview-export-html') {
      await exportLibraryRaindrop('html', { search: DOM.librarySearch?.value.trim() || '' });
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
      await createCodeByPrompt();
      return;
    }

    if (action === 'edit-code') {
      await editCodeByPrompt(Number(btn.dataset.id));
      return;
    }

    if (action === 'delete-code') {
      const title = btn.dataset.code || '';
      if (!confirm(`确认删除永久番号记录「${title}」及其 Tag 关联？此操作不会清理保留的旧兼容数据。`)) return;
      api.dbDeleteCodeRecord(Number(btn.dataset.id));
      state.codeSelected.delete(Number(btn.dataset.id));
      state.selectedCodeId = null;
      await afterDbWrite('番号记录已删除');
      return;
    }

    if (action === 'create-genre') {
      const name = await showTextInputDialog({ title: '新增类型 Tag', label: 'Tag 名称', placeholder: '输入新的类型 tag 名称', submitLabel: '新增' });
      if (!name) return;
      api.dbCreateGenreTag(name.trim());
      await afterDbWrite('类型 tag 已新增');
      return;
    }

    if (action === 'rename-genre') {
      const oldName = btn.dataset.name || '';
      const nextName = await showTextInputDialog({ title: '重命名类型 Tag', label: 'Tag 名称', value: oldName, submitLabel: '保存' });
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

    if (action === 'raw-select-page') {
      for (const row of state.rawDbData?.rows || []) state.rawDbSelected.add(rawPkForRow(row, state.rawDbData.pk));
      state.rawDbSelectionAnchor = state.rawDbData?.rows?.length
        ? rawPkForRow(state.rawDbData.rows[0], state.rawDbData.pk)
        : null;
      updateRawSelectionUi();
      return;
    }

    if (action === 'raw-clear-selection') {
      state.rawDbSelected.clear();
      state.rawDbSelectionAnchor = null;
      updateRawSelectionUi();
      return;
    }

    if (action === 'raw-copy-scope') {
      await copyRawTableScope();
      return;
    }

    if (action === 'raw-export-scope') {
      await exportRawTableScope();
      return;
    }

    if (action === 'raw-bulk-edit') {
      await bulkEditRawRows();
      return;
    }

    if (action === 'raw-bulk-delete') {
      await bulkDeleteRawRows();
      return;
    }

    if (action === 'raw-page') {
      state.rawDbPage = Math.max(1, Number(btn.dataset.page || 1));
      await refreshLibrary();
      return;
    }

    if (action === 'raw-delete-row') {
      const pk = parseJsonAttr(btn.dataset.rawPk);
      const message = state.rawDbTable === 'bookmark_collections'
        ? `确认删除 Collection「${pk.path || ''}」及其子目录和收藏？番号历史索引会保留。`
        : `确认删除 ${state.rawDbTable} 表中的这条记录？`;
      if (!confirm(message)) return;
      createBulkEditBackup(`raw_delete_${state.rawDbTable}`);
      api.dbDeleteRawRow(state.rawDbTable, pk);
      state.rawDbSelected.delete(JSON.stringify(pk));
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
    state.selectedCodeId = id;
    const row = (state.libraryCodeAllRows || []).find(item => Number(item.id) === id);
    if (field === 'status') {
      if (!row?.source_code_id) throw new Error('该收藏尚未关联番号，不能设置番号状态');
      api.dbUpdateCodeRecord(row.source_code_id, { status: value });
    } else {
      const result = api.dbUpdateBookmarkRecord(id, { [field]: value });
      if (result?.sourceCodeId && ['code', 'best_url', 'raindrop_title', 'raindrop_excerpt', 'raindrop_note', 'raindrop_folder', 'raindrop_tags', 'raindrop_created', 'raindrop_cover'].includes(field)) {
        api.dbUpdateCodeRecord(result.sourceCodeId, { [field]: value });
      }
    }
    await afterDbWrite('单元格已保存');
    return;
  }

  const tableSelect = event.target.closest('[data-raw-table-select]');
  if (tableSelect) {
    state.rawDbTable = tableSelect.value || 'codes';
    state.rawDbPage = 1;
    state.rawDbSelected.clear();
    state.rawDbSelectionAnchor = null;
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
  const input = await showTextInputDialog({ title: '新增番号', label: '番号', placeholder: '例如：ABF-354', submitLabel: '新增' });
  if (!input) return;
  const code = api.normalizeCode(input) || String(input).trim().toUpperCase();
  if (!code) throw new Error('请输入有效番号');
  const existing = api.dbFindCode(code);
  if (existing?.found) {
    state.selectedCodeId = Number(existing.code_id) || null;
    throw new Error(`番号 ${code} 已存在`);
  }
  const id = api.dbCreateCodeRecord(code, '', 'ok');
  state.selectedCodeId = id;
  state.codeSelected = new Set([id]);
  state.codeSelectionAnchorId = id;
  await afterDbWrite('番号已新增，可在右侧继续填写链接和 Tag');
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
  const label = await showTextInputDialog({ title: '创建数据库备份', label: '备份标签', value: 'manual', submitLabel: '创建' });
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
function persistBookmarkPanel(id, panel) {
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
  return result;
}

async function saveCodeDetail(id) {
  const panel = DOM.libraryContent.querySelector(`[data-code-detail-id="${id}"]`);
  if (!panel) throw new Error('没有找到详情面板');
  const get = name => panel.querySelector(`[data-code-detail-field="${name}"]`)?.value || '';
  api.dbUpdateCodeRecord(id, { code: get('code'), best_url: get('best_url'), status: get('status') || 'ok' });
  api.dbSetCodeActressTags(id, get('actress_tags'));
  api.dbSetCodeGenreTags(id, get('genre_tags'));
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
  if (!row || !row.code) throw new Error('该记录没有可生成链接的番号');
  const urls = api.candidateUrls(row.code) || [];
  const url = urls[0] || `https://missav.ai/cn/${String(row.code || '').toLowerCase()}`;
  const panel = DOM.libraryContent.querySelector(`[data-code-detail-id="${id}"]`);
  const input = panel?.querySelector('[data-code-detail-field="best_url"]');
  if (input) input.value = url;
  api.dbUpdateCodeRecord(id, { best_url: url });
  state.selectedCodeId = id;
  await afterDbWrite('链接已生成');
}

async function copySelectedCodeList() {
  const rows = selectedCodeRows();
  if (!rows.length) throw new Error('请先选择要复制的番号');
  const text = rows.map(row => row.code).filter(Boolean).join('\n');
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
  const rows = selectedCodeRowsForBulk();
  const status = DOM.libraryContent.querySelector('[data-code-bulk-status-value]')?.value || 'ok';
  createBulkEditBackup('bulk_status');
  for (const row of rows) api.dbUpdateCodeRecord(row.id, { status });
  await afterDbWrite(`已批量更新状态：${rows.length} 条`);
}

async function bulkChangeCodeTags(kind, mode) {
  const isActress = kind === 'actress';
  const label = isActress ? '女优 tag' : '类型 tag';
  const text = await showTextInputDialog({
    title: `${mode === 'add' ? '追加' : '移除'}${label}`,
    label: 'Tag 列表',
    placeholder: '多个 Tag 用逗号或 | 分隔',
    submitLabel: mode === 'add' ? '追加' : '移除',
  });
  if (!text) return;
  const tags = splitTagInput(text);
  if (!tags.length) return;
  const rows = selectedCodeRowsForBulk();
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
  const rows = selectedCodeRowsForBulk().filter(row => row.code);
  if (!rows.length) throw new Error('选中记录中没有可生成链接的番号');
  if (!confirm(`为选中的 ${rows.length} 条番号生成/覆盖链接？`)) return;
  createBulkEditBackup('bulk_generate_url');
  for (const row of rows) {
    const urls = api.candidateUrls(row.code) || [];
    const url = urls[0] || `https://missav.ai/cn/${String(row.code || '').toLowerCase()}`;
    api.dbUpdateCodeRecord(row.id, { best_url: url });
  }
  await afterDbWrite('已批量生成链接');
}

async function bulkNormalizeCodes() {
  const rows = selectedCodeRowsForBulk().filter(row => row.code);
  if (!rows.length) throw new Error('选中记录中没有可规范的番号');
  createBulkEditBackup('bulk_normalize_codes');
  let changed = 0;
  for (const row of rows) {
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
  if (!confirm(`确认删除选中的 ${ids.length} 条永久番号记录及其 Tag 关联？保留的旧兼容数据不会被清理。`)) return;
  createBulkEditBackup('bulk_delete_codes');
  for (const id of ids) api.dbDeleteCodeRecord(id);
  state.codeSelected.clear();
  state.codeSelectionAnchorId = null;
  state.selectedCodeId = null;
  await afterDbWrite('已批量删除番号记录');
}
async function addRawRowByPrompt() {
  const data = state.rawDbData || api.dbGetRawTableRows(state.rawDbTable, { limit: 1 });
  const row = {};
  for (const col of data.insertable || []) {
    const value = await showTextInputDialog({
      title: `新增 ${data.table} 记录`,
      label: col,
      value: defaultRawValue(data.table, col),
      submitLabel: '下一步',
    });
    if (value === null) return;
    row[col] = value;
  }
  api.dbInsertRawRow(data.table, row);
  await afterDbWrite('原始表记录已新增');
}

function databaseOperationActiveReason() {
  if (state.isProcessing) return 'MissAV 或 123AV 查询仍在运行';
  if (state.favoriteRuntime?.running) return '123AV 收藏仍在运行';
  if (state.raindropSync.running) return 'Raindrop 同步仍在运行';
  if (telegramAnyRunning()) return 'Telegram 同步仍在运行';
  return '';
}

async function resetAllDatabaseFromUi() {
  const activeReason = databaseOperationActiveReason();
  if (activeReason) throw new Error(`${activeReason}，请先停止后再清空数据库`);
  const inventory = api.dbGetDatabaseInventory();
  const confirmation = await showTextInputDialog({
    title: '备份并清空全部数据库业务数据',
    label: `将清空 ${inventory.businessRows} 行业务数据。请输入“清空全部数据”`,
    placeholder: '清空全部数据',
    submitLabel: '确认清空',
  });
  if (confirmation === null) return;
  if (confirmation.trim() !== '清空全部数据') throw new Error('确认文字不正确，未执行任何删除');
  const result = api.dbResetAllBusinessData({ confirmText: confirmation.trim(), backupLabel: '正式启用前完整备份' });
  logEvent('info', 'database_full_reset', {
    clearedRows: result.before?.businessRows || 0,
    backupFile: result.backup?.fileName || '',
    integrity: 'ok',
  });
  alert(`数据库已归零。\n\n已清空 ${result.before?.businessRows || 0} 行业务数据。\n可恢复备份：${result.backup?.fileName || '已创建'}\n\n账号令牌、登录会话、外观设置和所有备份文件均已保留。`);
  window.location.reload();
}

function rawScopeData() {
  const search = DOM.librarySearch?.value.trim() || '';
  const data = api.dbExportRawTableRows(state.rawDbTable, { search });
  const selected = state.rawDbSelected;
  const pkColumns = state.rawDbData?.pk || [];
  const rows = selected.size
    ? data.rows.filter(row => selected.has(rawPkForRow(row, pkColumns)))
    : data.rows;
  return { ...data, rows, selected: selected.size > 0, search };
}

async function copyRawTableScope() {
  const data = rawScopeData();
  if (!data.rows.length) throw new Error('当前没有可复制的数据');
  const rows = data.rows.map(row => data.columns.map(column => row[column] ?? ''));
  const text = window.SheetTable.rowsToTSV(data.columns, rows);
  await copyText(text);
  toast(`已复制 ${data.rows.length} 行 ${data.label}，可直接粘贴到 Excel/WPS`, 'success');
}

async function exportRawTableScope() {
  const data = rawScopeData();
  if (!data.rows.length) throw new Error('当前没有可导出的数据');
  const dir = await api.openDirectory({ title: '选择数据库表格导出目录' });
  if (!dir) return;
  const suffix = data.selected ? '选中' : data.search ? '筛选' : '全部';
  const filePath = `${dir}\\${api.timePrefixToMinute()}_${data.table}_${suffix}.csv`;
  const rows = data.rows.map(row => data.columns.map(column => row[column] ?? ''));
  await api.writeFile(filePath, '\ufeff' + api.csvStringify(data.columns, rows), 'utf-8');
  toast(`已导出 ${data.rows.length} 行：${filePath}`, 'success');
}

async function bulkEditRawRows() {
  if (!state.rawDbSelected.size) throw new Error('请先选择要修改的记录');
  const column = DOM.libraryContent.querySelector('[data-raw-bulk-column]')?.value || '';
  if (!column) throw new Error('当前表没有可批量修改的字段');
  const value = await showTextInputDialog({
    title: `批量修改 ${state.rawDbTable}`,
    label: `${state.rawDbSelected.size} 行 → ${column}`,
    placeholder: column.endsWith('_json') ? '输入有效 JSON' : '输入统一的新值',
    submitLabel: '修改',
  });
  if (value === null) return;
  createBulkEditBackup(`raw_bulk_update_${state.rawDbTable}_${column}`);
  const pks = [...state.rawDbSelected].map(parseJsonAttr);
  const result = api.dbBulkUpdateRawCells(state.rawDbTable, pks, column, value);
  await afterDbWrite(`已批量修改 ${result.updated} 行的 ${column}`);
}

async function bulkDeleteRawRows() {
  const count = state.rawDbSelected.size;
  if (!count) throw new Error('请先选择要删除的记录');
  if (!confirm(`确认删除 ${state.rawDbTable} 表中选中的 ${count} 行？\n软件会先自动创建数据库备份。`)) return;
  createBulkEditBackup(`raw_bulk_delete_${state.rawDbTable}`);
  const pks = [...state.rawDbSelected].map(parseJsonAttr);
  const result = api.dbBulkDeleteRawRows(state.rawDbTable, pks);
  state.rawDbSelected.clear();
  state.rawDbSelectionAnchor = null;
  await afterDbWrite(`已删除 ${result.deleted} 行`);
}

function defaultRawValue(table, col) {
  if (table === 'codes' && col === 'status') return 'ok';
  if (col === 'metadata_json') return '{}';
  if (col.endsWith('_json')) return '[]';
  if (col === 'collection_id') return '-1';
  if (col === 'status' && table === 'site_lookup_cache') return 'not_found';
  if (col === 'status' && table === 'remote_sync_records') return 'succeeded';
  if (/_codes$/.test(col)) return '0';
  return '';
}

async function afterDbWrite(message) {
  refreshDbSummary();
  toast(message, 'success');
  await refreshLibrary();
}

async function exportLibraryRaindrop(type, options = {}) {
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
    const search = String(options.search || '').trim();
    const bundle = api.dbBuildRaindropExport({ search });
    const rows = bundle.records || [];
    if (!rows.length) {
      const blocked = Number(bundle.summary?.blocked || 0);
      toast(blocked ? `没有可导出的有效链接；已排除 ${blocked} 条问题记录` : '本地收藏库为空', blocked ? 'error' : 'info');
      return;
    }
    const prefix = api.timePrefixToMinute();
    const isHtml = type === 'html';
    const filePath = `${dir}\\${prefix}_raindrop_official_export.${isHtml ? 'html' : 'csv'}`;
    const content = isHtml ? api.generateOfficialRaindropHTML(rows) : '\ufeff' + api.generateOfficialRaindropCSV(rows);
    await api.writeFile(filePath, content, 'utf-8');
    const blocked = Number(bundle.summary?.blocked || 0);
    const scope = search ? `（搜索范围：${search}）` : '';
    toast(`已导出 ${rows.length} 条${scope}${blocked ? `，排除 ${blocked} 条无效链接` : ''}：${filePath}`, 'success');
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
async function importTextFiles() {
  const selected = await api.openFile({
    title: '选择一个或多个番号文件',
    filters: [
      { name: '番号文本 / HTML / Markdown / CSV', extensions: ['txt', 'html', 'htm', 'md', 'json', 'csv', 'log'] },
      { name: '所有文件', extensions: ['*'] },
    ],
    multiSelections: true,
  });
  if (!selected) return;

  const filePaths = Array.isArray(selected) ? selected : [selected];
  if (!filePaths.length) return;

  const imported = [];
  const failures = [];
  const parsedTelegramFiles = new Set();
  const structured = filePaths.filter(filePath => /\.html?$|\.json$/i.test(filePath));
  if (structured.length) {
    try {
      const parsed = await api.parseTelegramExport(structured);
      const sourceNames = new Set((parsed?.messages || []).map(message => String(message?.sourceLabel || '')).filter(Boolean));
      const session = state.avToolSessions[state.activeAvTool];
      session.messageKeys ||= new Set();
      const filteredMessages = api.filterTelegramMessagesByTime(parsed?.messages || [], avToolRange(state.activeAvTool));
      const blocks = [];
      for (const message of filteredMessages) {
        const key = String(message?.contentHash || `${message?.accountKey || ''}:${message?.chatKey || ''}:${message?.messageId || ''}`);
        if (!key || session.messageKeys.has(key)) continue;
        session.messageKeys.add(key);
        const block = [message?.text, ...(message?.links || [])].filter(Boolean).join('\n');
        if (block) blocks.push(block);
      }
      for (const filePath of structured) {
        if (sourceNames.has(fileName(filePath))) parsedTelegramFiles.add(filePath);
      }
      if (parsedTelegramFiles.size) {
        imported.push({ filePath: `${parsedTelegramFiles.size} 个 Telegram 导出文件`, text: blocks.join('\n\n') });
      }
    } catch (error) {
      logEvent('warn', 'av_tool_telegram_import_fallback', { error: error.message || String(error) });
    }
  }
  for (const filePath of filePaths) {
    if (parsedTelegramFiles.has(filePath)) continue;
    try {
      const text = await api.readFile(filePath, 'utf-8');
      imported.push({ filePath, text });
    } catch (error) {
      failures.push({ file: fileName(filePath), error: error.message || String(error) });
    }
  }
  if (!imported.length) {
    logEvent('error', 'text_files_import_failed', { requested: filePaths.length, failures });
    toast(`所选 ${filePaths.length} 个文件均读取失败`, 'error');
    return;
  }

  const mergedText = imported.map(item => item.text).join('\n\n');
  const current = DOM.codeInput.value.trimEnd();
  DOM.codeInput.value = current ? `${current}\n\n${mergedText}` : mergedText;
  const sourceLabel = imported.length === 1
    ? fileName(imported[0].filePath)
    : `${imported.length} 个文件${failures.length ? `（${failures.length} 个失败）` : ''}`;
  parseInputCodes(sourceLabel);
  saveActiveAvToolSession();
  updateUI();
  logEvent(failures.length ? 'warn' : 'info', 'text_files_imported', {
    files: imported.map(item => fileName(item.filePath)),
    requestedFileCount: filePaths.length,
    importedFileCount: imported.length,
    failedFileCount: failures.length,
    failures,
    codeCount: state.inputCodes.length,
  });
  toast(
    failures.length
      ? `已导入 ${imported.length} 个文件，${failures.length} 个读取失败；成功内容已保留`
      : `已导入 ${imported.length} 个文件，共识别 ${state.inputCodes.length} 个番号`,
    failures.length ? 'info' : 'success',
  );
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

// ─── Raindrop 直接同步 ───────────────────────────────
function setRaindropPreviewExpanded(expanded) {
  state.raindropSync.previewExpanded = Boolean(expanded);
  DOM.raindropPreviewPanel?.classList.toggle('is-expanded', state.raindropSync.previewExpanded);
  document.body.classList.toggle('raindrop-preview-expanded', state.raindropSync.previewExpanded);
  if (DOM.btnToggleRaindropPreviewSize) {
    const label = DOM.btnToggleRaindropPreviewSize.querySelector('span');
    if (label) label.textContent = state.raindropSync.previewExpanded ? '还原表格' : '展开表格';
    DOM.btnToggleRaindropPreviewSize.setAttribute('aria-pressed', state.raindropSync.previewExpanded ? 'true' : 'false');
  }
}

function loadRaindropSyncSettings() {
  try {
    const saved = Number(localStorage.getItem(RAINDROP_COLLECTION_KEY));
    state.raindropSync.collectionId = Number.isSafeInteger(saved) && saved !== 0 && saved >= -1 ? saved : -1;
  } catch {
    state.raindropSync.collectionId = -1;
  }
}

function setRaindropBusy(busy) {
  state.raindropSync.running = Boolean(busy);
  const disabled = Boolean(busy);
  for (const control of [DOM.btnSaveRaindropToken, DOM.btnTestRaindropAccount, DOM.btnClearRaindropToken,
    DOM.btnRefreshRaindropCollections, DOM.raindropBatchSelect, DOM.raindropCollectionSelect, DOM.btnPreviewRaindropSync]) {
    if (control) control.disabled = disabled || (control === DOM.raindropCollectionSelect
      && (!state.raindropSync.auth.configured || isMissavAutoRoutingRun()));
  }
  if (DOM.btnStartRaindropSync) {
    DOM.btnStartRaindropSync.hidden = disabled;
    DOM.btnStartRaindropSync.disabled = disabled || !raindropPlanIsReady();
  }
  if (DOM.btnStopRaindropSync) {
    DOM.btnStopRaindropSync.hidden = !disabled;
    if (disabled) DOM.btnStopRaindropSync.disabled = false;
  }
}

function raindropActionLabel(action) {
  return action === 'create' ? '新建' : action === 'update' ? '更新' : action === 'skip' ? '跳过' : action === 'error' ? '异常' : '待核对';
}

function raindropPlanIsReady() {
  return Boolean(state.raindropSync.auth.configured && state.raindropSync.plan.length &&
    state.raindropSync.plan.every(row => ['create', 'update', 'skip', 'error'].includes(row.action)) &&
    state.raindropSync.plan.some(row => ['create', 'update'].includes(row.action) || (row.action === 'skip' && row.taskStatus !== 'succeeded')));
}

function currentRaindropCollectionLabel() {
  const id = Number(state.raindropSync.collectionId);
  if (id === -1) return 'Unsorted';
  return state.raindropSync.collections.find(row => Number(row.id) === id)?.path || `Collection ${id}`;
}

function selectedRaindropRun() {
  return state.raindropSync.runId ? api.dbGetRun(Number(state.raindropSync.runId)) : null;
}

function isMissavAutoRoutingRun(run = selectedRaindropRun()) {
  return run?.toolKind === 'missav';
}

function raindropCollectionLabelForId(id) {
  const collectionId = Number(id);
  if (collectionId === -1) return 'Unsorted';
  return state.raindropSync.collections.find(row => Number(row.id) === collectionId)?.path || `Collection ${collectionId}`;
}

function routingTargetForItem(run, item) {
  if (!isMissavAutoRoutingRun(run)) {
    return {
      key: 'manual',
      collectionId: Number(state.raindropSync.collectionId),
      collectionLabel: currentRaindropCollectionLabel(),
    };
  }
  const key = api.selectMissavRaindropCollection(item.actresses || [], run.knownActresses || []);
  const collectionId = Number(state.raindropSync.routingCollections[key]);
  return {
    key,
    collectionId,
    collectionLabel: key,
  };
}

async function ensureMissavRoutingCollections(run) {
  if (!isMissavAutoRoutingRun(run)) return state.raindropSync.routingCollections;
  if (!state.raindropSync.auth.configured) throw new Error('请先配置 Raindrop 访问令牌，才能建立 missav1 / missav2');
  const ready = ['missav1', 'missav2'].every(key => Number(state.raindropSync.routingCollections[key]) > 0);
  if (ready) return state.raindropSync.routingCollections;
  const response = await api.ensureRaindropCollections(['missav1', 'missav2']);
  state.raindropSync.routingCollections = {
    missav1: Number(response?.routing?.missav1) || null,
    missav2: Number(response?.routing?.missav2) || null,
  };
  state.raindropSync.collections = Array.isArray(response?.items) ? response.items : state.raindropSync.collections;
  renderRaindropCollections();
  if (response?.created?.length) {
    toast(`已在 Raindrop 根目录创建：${response.created.map(row => row.title).join('、')}`, 'success');
  }
  return state.raindropSync.routingCollections;
}

function updateRaindropMetrics() {
  const plan = state.raindropSync.plan;
  const count = action => plan.filter(row => row.action === action).length;
  if (DOM.raindropMetricEligible) DOM.raindropMetricEligible.textContent = String(plan.length);
  if (DOM.raindropMetricCreate) DOM.raindropMetricCreate.textContent = String(count('create') + count('check'));
  if (DOM.raindropMetricUpdate) DOM.raindropMetricUpdate.textContent = String(count('update'));
  if (DOM.raindropMetricSkip) DOM.raindropMetricSkip.textContent = String(count('skip'));
  if (DOM.raindropMetricError) DOM.raindropMetricError.textContent = String(count('error'));
}

function renderRaindropPlan() {
  updateRaindropMetrics();
  const plan = state.raindropSync.plan;
  const pendingCheck = plan.filter(row => row.action === 'check').length;
  const actionable = plan.filter(row => ['create', 'update'].includes(row.action)).length;
  const errors = plan.filter(row => row.action === 'error').length;
  if (DOM.raindropPlanTitle) {
    DOM.raindropPlanTitle.textContent = !plan.length ? '尚未生成同步预览'
      : pendingCheck ? `已准备 ${plan.length} 条，尚有 ${pendingCheck} 条待远端核对`
        : `预览完成：需要写入 ${actionable} 条`;
  }
  if (DOM.raindropPlanDetail) {
    const estimate = Math.max(1, Math.ceil(actionable * 0.55));
    DOM.raindropPlanDetail.textContent = !plan.length
      ? isMissavAutoRoutingRun()
        ? '选择 MissAV 批次后生成预览；目标会自动分流到 missav1 / missav2。'
        : '选择批次和 Collection 后，先核对远端再执行。'
      : pendingCheck ? '点击“生成预览”后会按每组最多 100 个链接检查是否已存在。'
        : `${plan.filter(row => row.action === 'create').length} 条新建 · ${plan.filter(row => row.action === 'update').length} 条更新 · ${plan.filter(row => row.action === 'skip').length} 条跳过 · 预计至少 ${processingEta?.formatDuration(estimate * 1000) || `${estimate} 秒`}${errors ? ` · ${errors} 条数据异常` : ''}`;
  }
  if (DOM.raindropPreviewBody) {
    if (!plan.length) {
      DOM.raindropPreviewBody.innerHTML = '<tr class="empty-row"><td colspan="5"><div class="empty-state"><p>等待同步预览</p></div></td></tr>';
    } else {
      DOM.raindropPreviewBody.innerHTML = plan.slice(0, 300).map(row => `
        <tr>
          <td>${esc(row.code)}</td>
          <td class="raindrop-action-${esc(row.action)}">${esc(raindropActionLabel(row.action))}</td>
          <td>${esc(row.collectionLabel || currentRaindropCollectionLabel())}</td>
          <td>${esc((row.payload?.tags || []).join(', ')) || '-'}</td>
          <td>${esc(row.statusText || (row.action === 'skip' ? '远端内容无需变化' : row.action === 'check' ? '等待核对远端 URL' : '等待执行'))}</td>
        </tr>`).join('') + (plan.length > 300 ? `<tr><td colspan="5">仅显示前 300 条，完整计划共 ${plan.length} 条</td></tr>` : '');
    }
  }
  setRaindropBusy(state.raindropSync.running);
}

function updateRaindropAuthUI() {
  const auth = state.raindropSync.auth;
  if (DOM.raindropSyncStateBadge) DOM.raindropSyncStateBadge.textContent = auth.configured ? (auth.account?.label || '已配置') : '未配置';
  if (DOM.raindropAccountStatus) {
    DOM.raindropAccountStatus.textContent = !auth.encryptionAvailable ? '系统安全存储不可用'
      : auth.account?.label ? `已连接：${auth.account.label}` : auth.configured ? '令牌已加密保存' : '尚未保存令牌';
  }
  if (DOM.raindropCollectionSelect) DOM.raindropCollectionSelect.disabled = !auth.configured || state.raindropSync.running || isMissavAutoRoutingRun();
}

async function refreshRaindropSyncPage() {
  if (!state.dbReady) return;
  try {
    const auth = await api.getRaindropAuthStatus();
    state.raindropSync.auth = { ...state.raindropSync.auth, ...auth };
    updateRaindropAuthUI();
    refreshRaindropRunOptions();
    if (auth.configured && !state.raindropSync.collections.length) await loadRaindropCollections();
    else renderRaindropPlan();
  } catch (err) {
    if (DOM.raindropAccountStatus) DOM.raindropAccountStatus.textContent = err.message;
    logEvent('warn', 'raindrop_page_refresh_failed', { error: err.message });
  }
}

function refreshRaindropRunOptions() {
  if (!DOM.raindropBatchSelect || !state.dbReady) return;
  const runs = (api.dbGetRecentRuns?.(100) || []).filter(run =>
    Number(run.pipelineVersion) >= 2
    && run.toolKind !== 'av123'
    && Number(run.stages?.raindropSync?.total || 0) > 0);
  const preferred = Number(state.raindropSync.runId || state.selectedRunId || state.preparedRunId || state.resumableRun?.id || 0);
  const selected = runs.some(run => Number(run.id) === preferred) ? preferred : Number(runs[0]?.id || 0);
  DOM.raindropBatchSelect.innerHTML = runs.length
    ? runs.map(run => `<option value="${run.id}">${esc(run.name)} · ${run.stages.raindropSync.statusCounts.ready || 0} 待同步</option>`).join('')
    : '<option value="">暂无包含 MissAV 结果的批次</option>';
  DOM.raindropBatchSelect.value = selected ? String(selected) : '';
  if (selected !== Number(state.raindropSync.runId || 0)) selectRaindropRun(selected, { render: false });
  const run = selected ? api.dbGetRun(selected) : null;
  if (DOM.raindropBatchStatus) DOM.raindropBatchStatus.textContent = run ? `${run.name} · ${run.total} 条` : '请选择批次';
}

function selectRaindropRun(value, options = {}) {
  state.raindropSync.runId = Number(value) || null;
  state.raindropSync.plan = [];
  if (DOM.raindropBatchStatus) {
    const run = state.raindropSync.runId ? api.dbGetRun(state.raindropSync.runId) : null;
    DOM.raindropBatchStatus.textContent = run ? `${run.name} · ${run.total} 条` : '请选择批次';
  }
  const run = selectedRaindropRun();
  const auto = isMissavAutoRoutingRun(run);
  if (DOM.raindropCollectionLabel) DOM.raindropCollectionLabel.textContent = auto ? '自动目标 Collection' : '目标 Collection';
  if (DOM.raindropRoutingNote) {
    DOM.raindropRoutingNote.textContent = auto
      ? '本批次使用创建时冻结的女优底库：命中任一已知女优 → missav1；全是新女优或没有女优 → missav2。目录缺失时在根目录自动创建。'
      : '这是旧版或兼容批次，继续使用上方手动选择的目标 Collection。';
  }
  if (DOM.raindropCollectionSelect) DOM.raindropCollectionSelect.disabled = auto || !state.raindropSync.auth.configured || state.raindropSync.running;
  if (options.render !== false) void buildRaindropSyncPlan({ checkRemote: false });
}

function selectRaindropCollection() {
  state.raindropSync.collectionId = Number(DOM.raindropCollectionSelect?.value ?? -1);
  try { localStorage.setItem(RAINDROP_COLLECTION_KEY, String(state.raindropSync.collectionId)); } catch {}
  state.raindropSync.plan = [];
  void buildRaindropSyncPlan({ checkRemote: false });
}

async function saveRaindropToken() {
  const token = DOM.raindropTokenInput?.value || '';
  if (!token.trim()) { toast('请先粘贴 Raindrop 访问令牌', 'error'); return; }
  DOM.btnSaveRaindropToken.disabled = true;
  try {
    const result = await api.setRaindropToken(token);
    if (DOM.raindropTokenInput) DOM.raindropTokenInput.value = '';
    state.raindropSync.auth = { ...result, configured: true };
    state.raindropSync.routingCollections = { missav1: null, missav2: null };
    updateRaindropAuthUI();
    await loadRaindropCollections({ force: true });
    logEvent('info', 'raindrop_token_configured', { accountLabel: result.account?.label || '' });
    toast(`Raindrop 已连接：${result.account?.label || '账号可用'}`, 'success');
  } catch (err) {
    if (DOM.raindropTokenInput) DOM.raindropTokenInput.value = '';
    logEvent('warn', 'raindrop_token_rejected', { error: err.message });
    toast(err.message, 'error');
  } finally {
    DOM.btnSaveRaindropToken.disabled = false;
  }
}

async function testRaindropAccount(options = {}) {
  try {
    const result = await api.testRaindropAccount();
    state.raindropSync.auth = { ...state.raindropSync.auth, ...result, configured: true };
    updateRaindropAuthUI();
    if (!options.quiet) toast(`连接正常：${result.account?.label || 'Raindrop 账号'}`, 'success');
    return result;
  } catch (err) {
    state.raindropSync.auth.account = null;
    updateRaindropAuthUI();
    if (!options.quiet) toast(err.message, 'error');
    throw err;
  }
}

async function clearRaindropToken() {
  if (!confirm('清除本机加密保存的 Raindrop 访问令牌？已同步记录不会删除。')) return;
  try {
    const result = await api.clearRaindropToken();
    state.raindropSync.auth = { ...result, account: null };
    state.raindropSync.collections = [];
    state.raindropSync.routingCollections = { missav1: null, missav2: null };
    state.raindropSync.plan = [];
    if (DOM.raindropTokenInput) DOM.raindropTokenInput.value = '';
    updateRaindropAuthUI();
    renderRaindropCollections();
    renderRaindropPlan();
    toast('已清除 Raindrop 令牌', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

function renderRaindropCollections() {
  if (!DOM.raindropCollectionSelect) return;
  const items = state.raindropSync.collections;
  DOM.raindropCollectionSelect.innerHTML = `<option value="-1">Unsorted</option>${items.map(row => `<option value="${row.id}">${esc(row.path)}${row.count ? ` (${row.count})` : ''}</option>`).join('')}`;
  const selected = items.some(row => Number(row.id) === Number(state.raindropSync.collectionId)) ? Number(state.raindropSync.collectionId) : -1;
  state.raindropSync.collectionId = selected;
  DOM.raindropCollectionSelect.value = String(selected);
  DOM.raindropCollectionSelect.disabled = !state.raindropSync.auth.configured || state.raindropSync.running || isMissavAutoRoutingRun();
}

async function loadRaindropCollections(options = {}) {
  if (!state.raindropSync.auth.configured) { updateRaindropAuthUI(); return; }
  if (state.raindropSync.collections.length && !options.force) { renderRaindropCollections(); return; }
  if (DOM.btnRefreshRaindropCollections) DOM.btnRefreshRaindropCollections.disabled = true;
  try {
    const response = await api.getRaindropCollections();
    state.raindropSync.collections = Array.isArray(response?.items) ? response.items : [];
    for (const key of ['missav1', 'missav2']) {
      const root = state.raindropSync.collections.find(row =>
        Number(row.parentId || 0) === 0 && String(row.title || '').toLowerCase() === key);
      state.raindropSync.routingCollections[key] = root ? Number(root.id) : null;
    }
    renderRaindropCollections();
    if (options.force) toast(`已载入 ${state.raindropSync.collections.length} 个 Collection`, 'success');
  } catch (err) {
    toast(err.message, 'error');
    logEvent('warn', 'raindrop_collections_failed', { error: err.message });
  } finally {
    if (DOM.btnRefreshRaindropCollections) DOM.btnRefreshRaindropCollections.disabled = state.raindropSync.running;
  }
}

function raindropEligibleTask(task) {
  return ['ready', 'succeeded', 'network_error', 'failed', 'verify_required'].includes(String(task?.status || ''));
}

async function buildRaindropSyncPlan(options = {}) {
  if (!state.dbReady || !state.raindropSync.runId) { state.raindropSync.plan = []; renderRaindropPlan(); return []; }
  const run = api.dbGetRun(state.raindropSync.runId);
  if (!run) { state.raindropSync.plan = []; renderRaindropPlan(); return []; }
  if (isMissavAutoRoutingRun(run)) {
    try {
      await ensureMissavRoutingCollections(run);
    } catch (err) {
      state.raindropSync.plan = [];
      renderRaindropPlan();
      if (options.checkRemote) toast(err.message, 'error');
      return [];
    }
  }
  const plan = [];
  for (const item of run.items || []) {
    const task = item.tasks?.raindropSync;
    if (!raindropEligibleTask(task)) continue;
    try {
      const target = routingTargetForItem(run, item);
      const payload = api.buildRaindropSyncPayload(item, target.collectionId);
      const hash = api.raindropPayloadHash(payload);
      const record = api.dbGetRemoteSyncRecord('raindrop', item.code);
      const same = record?.status === 'succeeded' && record.payloadHash === hash && Number(record.collectionId) === Number(target.collectionId);
      plan.push({
        runId: run.id,
        position: item.position,
        code: item.code,
        collectionId: target.collectionId,
        collectionLabel: target.collectionLabel,
        routingKey: target.key,
        payload,
        payloadHash: hash,
        remoteId: record?.remoteId || '',
        taskStatus: task.status,
        action: same ? 'skip' : record?.remoteId ? 'update' : 'check',
        statusText: same ? `上次同步于 ${record.syncedAt || record.updatedAt || '本机记录时间'}` : record?.remoteId ? `已关联远端 #${record.remoteId}` : '',
      });
    } catch (err) {
      plan.push({ runId: run.id, position: item.position, code: item.code, payload: null, payloadHash: '', remoteId: '', collectionId: null, collectionLabel: '-', action: 'error', statusText: err.message });
    }
  }
  state.raindropSync.plan = plan;
  renderRaindropPlan();
  if (!options.checkRemote) return plan;
  if (!state.raindropSync.auth.configured) { toast('请先配置 Raindrop 访问令牌', 'error'); return plan; }

  const unknown = plan.filter(row => row.action === 'check');
  if (DOM.raindropPlanTitle) DOM.raindropPlanTitle.textContent = `正在核对 ${unknown.length} 个远端链接…`;
  try {
    for (let offset = 0; offset < unknown.length; offset += 100) {
      const chunk = unknown.slice(offset, offset + 100);
      const response = await api.checkRaindropUrls(chunk.map(row => row.payload.link));
      const byUrl = new Map((response?.items || []).map(row => [row.url, row.remoteId]));
      for (const row of chunk) {
        const remoteId = byUrl.get(row.payload.link);
        row.remoteId = remoteId || '';
        row.action = remoteId ? 'update' : 'create';
        row.statusText = remoteId
          ? `官网已有同一链接（书签 ID #${remoteId}），将更新标题/Tags，并放入 ${row.collectionLabel}`
          : `官网不存在同一链接，将新建到 ${row.collectionLabel}`;
      }
      renderRaindropPlan();
    }
    logEvent('info', 'raindrop_sync_previewed', {
      runId: run.id,
      total: plan.length,
      create: plan.filter(row => row.action === 'create').length,
      update: plan.filter(row => row.action === 'update').length,
      skip: plan.filter(row => row.action === 'skip').length,
      missav1: plan.filter(row => row.routingKey === 'missav1').length,
      missav2: plan.filter(row => row.routingKey === 'missav2').length,
    });
  } catch (err) {
    logEvent('warn', 'raindrop_sync_preview_failed', { runId: run.id, error: err.message });
    toast(`远端核对失败：${err.message}`, 'error');
  }
  renderRaindropPlan();
  return plan;
}

function updateRaindropProgress(completed, total, label) {
  const percent = total ? Math.round((completed / total) * 100) : 0;
  if (DOM.raindropSyncProgress) DOM.raindropSyncProgress.hidden = false;
  if (DOM.raindropProgressText) DOM.raindropProgressText.textContent = `${label || '同步中'} · ${completed}/${total}`;
  if (DOM.raindropProgressPercent) DOM.raindropProgressPercent.textContent = `${percent}%`;
  if (DOM.raindropProgressFill) DOM.raindropProgressFill.style.width = `${percent}%`;
}

function classifyRaindropSyncFailure(message, sideEffectStarted) {
  const text = String(message || 'Raindrop 同步失败');
  if (/授权|令牌|HTTP 401|HTTP 403/.test(text)) return 'not_logged_in';
  if (/429|速率上限/.test(text)) return 'network_error';
  if (sideEffectStarted && /超时|网络|连接|fetch/i.test(text)) return 'verify_required';
  return 'failed';
}

async function startRaindropSync() {
  if (state.raindropSync.running) return;
  if (!raindropPlanIsReady()) {
    await buildRaindropSyncPlan({ checkRemote: true });
    if (!raindropPlanIsReady()) { toast('没有需要写入的条目，或同步预览尚未完成', 'error'); return; }
  }
  const writeRows = state.raindropSync.plan.filter(row => ['create', 'update'].includes(row.action));
  const unchanged = state.raindropSync.plan.filter(row => row.action === 'skip').length;
  const targetCounts = state.raindropSync.plan.reduce((map, row) => {
    const label = row.collectionLabel || currentRaindropCollectionLabel();
    map[label] = (map[label] || 0) + 1;
    return map;
  }, {});
  const targetSummary = Object.entries(targetCounts).map(([label, count]) => `${label} ${count} 条`).join('，');
  if (!confirm(`将按预览目标向 Raindrop 写入 ${writeRows.length} 条（新建 ${writeRows.filter(row => row.action === 'create').length}，更新 ${writeRows.filter(row => row.action === 'update').length}），另有 ${unchanged} 条确认无需变化。\n目标分布：${targetSummary}。\n继续吗？`)) return;

  state.raindropSync.stopRequested = false;
  state.raindropSync.progress = { completed: 0, total: state.raindropSync.plan.length, errors: 0 };
  setRaindropBusy(true);
  logEvent('info', 'raindrop_sync_started', { runId: state.raindropSync.runId, total: state.raindropSync.plan.length, targets: targetCounts });
  let writesSinceCheckpoint = 0;
  try {
    for (let index = 0; index < state.raindropSync.plan.length; index++) {
      if (state.raindropSync.stopRequested) break;
      const row = state.raindropSync.plan[index];
      if (row.action === 'error') {
        state.raindropSync.progress.errors++;
      } else if (row.action === 'skip') {
        api.dbCompleteRemoteSyncTask(row.runId, row.position, {
          status: 'succeeded',
          error: '',
          metadata: {
            action: 'unchanged',
            remoteId: row.remoteId || '',
            collectionId: row.collectionId,
            collectionLabel: row.collectionLabel,
          },
          persist: false,
        }, null);
        row.taskStatus = 'succeeded';
      } else {
        api.dbUpdateRunTask(row.runId, row.position, 'raindrop', 'sync', { status: 'running', error: '', persist: false });
        try {
          const result = await api.upsertRaindropItem({ remoteId: row.remoteId || null, payload: row.payload });
          row.remoteId = String(result.item.id);
          row.action = 'skip';
          row.taskStatus = 'succeeded';
          row.statusText = result.action === 'updated' ? `已更新远端 #${result.item.id}` : `已新建远端 #${result.item.id}`;
          api.dbCompleteRemoteSyncTask(row.runId, row.position, {
            status: 'succeeded', url: row.payload.link, error: '',
            metadata: { action: result.action, remoteId: result.item.id, collectionId: row.collectionId, collectionLabel: row.collectionLabel }, persist: false,
          }, {
            code: row.code, remoteId: result.item.id, link: row.payload.link,
            collectionId: row.collectionId, payloadHash: row.payloadHash,
            status: 'succeeded', metadata: { action: result.action },
          });
          writesSinceCheckpoint++;
        } catch (err) {
          const status = classifyRaindropSyncFailure(err.message, true);
          row.action = 'error';
          row.taskStatus = status;
          row.statusText = status === 'verify_required' ? `${err.message}；需核对远端后再重试` : err.message;
          state.raindropSync.progress.errors++;
          api.dbCompleteRemoteSyncTask(row.runId, row.position, { status, error: row.statusText, metadata: { collectionId: row.collectionId, collectionLabel: row.collectionLabel }, persist: false }, null);
          logEvent('warn', 'raindrop_sync_item_failed', { runId: row.runId, position: row.position, code: row.code, status, error: err.message });
          if (status === 'not_logged_in') {
            state.raindropSync.stopRequested = true;
            toast('Raindrop 授权失效，同步已暂停', 'error');
          }
        }
      }
      state.raindropSync.progress.completed = index + 1;
      updateRaindropProgress(index + 1, state.raindropSync.plan.length, state.raindropSync.stopRequested ? '正在停止' : '同步中');
      if (writesSinceCheckpoint >= 20) { api.dbCheckpoint?.(); writesSinceCheckpoint = 0; }
      if (index % 5 === 0) renderRaindropPlan();
    }
  } finally {
    api.dbCheckpoint?.();
    const stopped = state.raindropSync.stopRequested;
    state.raindropSync.running = false;
    setRaindropBusy(false);
    renderRaindropPlan();
    const fresh = api.dbGetRun(state.raindropSync.runId);
    if (fresh && [state.selectedRunId, state.preparedRunId, state.currentRunId].map(Number).includes(Number(fresh.id))) {
      state.results = fresh.items.map(batchItemToResult);
      if (state.activePage === 'results') renderTable();
    }
    updateRaindropProgress(state.raindropSync.progress.completed, state.raindropSync.plan.length, stopped ? '已停止' : '同步完成');
    logEvent('info', stopped ? 'raindrop_sync_stopped' : 'raindrop_sync_finished', { runId: state.raindropSync.runId, completed: state.raindropSync.progress.completed, total: state.raindropSync.plan.length, errors: state.raindropSync.progress.errors });
    toast(stopped ? 'Raindrop 同步已安全停止，可重新预览后继续' : `Raindrop 同步完成，异常 ${state.raindropSync.progress.errors} 条`, stopped || state.raindropSync.progress.errors ? 'warning' : 'success');
  }
}

function stopRaindropSync() {
  if (!state.raindropSync.running) return;
  state.raindropSync.stopRequested = true;
  if (DOM.btnStopRaindropSync) DOM.btnStopRaindropSync.disabled = true;
  updateRaindropProgress(state.raindropSync.progress.completed, state.raindropSync.plan.length, '等待当前请求完成后停止');
}

// ─── 辅助 ────────────────────────────────────────────
function clearAll() {
  DOM.codeInput.value = ''; state.inputCodes = []; state.results = [];
  state.preparedRunId = null;
  state.preparedInputSignature = '';
  state.selectedRunId = null;
  state.sitePerformance = { missav: null, av123: null };
  state.resultSelected.clear(); state.resultSelectionAnchor = null;
  state.resultWorkspace = state.activeAvTool;
  state.activeTab = 'all';
  state.resultTabByWorkspace = { missav: 'all', av123: 'all' };
  state.resultStageByWorkspace = { missav: 'missavLookup', av123: 'av123Lookup' };
  state.resultStatusByWorkspace = { missav: 'all', av123: 'all' };
  state.resultSortByWorkspace = { missav: 'original', av123: 'original' };
  if (DOM.resultSearch) DOM.resultSearch.value = '';
  if (DOM.resultStatusFilter) DOM.resultStatusFilter.value = 'all';
  configureResultWorkspaceControls();
  if (DOM.resultTagFilter) { DOM.resultTagFilter.value = 'all'; DOM.resultTagFilter.dataset.signature = ''; }
  if (DOM.resultSort) DOM.resultSort.value = 'original';
  state.stats = { total: 0, new: 0, exists: 0, notFound: 0, duplicate: 0 };
  DOM.codeCount.textContent = '0 条';
  if (DOM.filteredCodeOutput) DOM.filteredCodeOutput.value = '';
  if (DOM.filteredCodeCount) DOM.filteredCodeCount.textContent = '0 条 · 一行一个';
  if (DOM.inputSourceInfo) { DOM.inputSourceInfo.textContent = '文本 / HTML / TXT / MD'; DOM.inputSourceInfo.dataset.sourceLabel = ''; }
  if (DOM.batchName) DOM.batchName.value = '';
  if (DOM.resultBatchSummary) DOM.resultBatchSummary.textContent = '导入前预览';
  state.avToolSessions[state.activeAvTool] = {
    raw: '',
    sourceLabel: '手动输入',
    preparedRunId: null,
    preparedInputSignature: '',
    timeStart: DOM.avTimeStart?.value || '',
    timeEnd: DOM.avTimeEnd?.value || '',
  };
  DOM.exportBar.style.display = 'none'; DOM.progressContainer.style.display = 'none';
  resetProcessingForecast();
  updateStats(); renderTable(); setStatus('就绪', null, null, null); updateUI();
}
function pasteSample() {
  DOM.codeInput.value = 'ABF-354\nSONE-314\nFC2-PPV-4843473\nGDJP-006\nFPRE-216\nEYAN-214\n<div id="message14298">SNIS-786 https://missav.ai/cn/sone-314-chinese-subtitle</div>';
  parseInputCodes('示例数据');
  saveActiveAvToolSession();
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
























