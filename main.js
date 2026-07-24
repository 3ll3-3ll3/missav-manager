const { app, BrowserWindow, ipcMain, dialog, shell, net } = require('electron');
const { session, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { createRuntimeLogger } = require('./src/logger');
const av123Account = require('./src/av123Account');
const raindropApi = require('./src/raindropApi');
const telegramSource = require('./src/telegramSource');
const { TelegramUserService } = require('./src/telegramClient');
const { TelegramBotService, normalizeBotToken, redactBotSecrets } = require('./src/telegramBot');
const { fetchWithElectronRequest } = require('./src/networkTransport');
const { ChromeFavoriteBridge } = require('./src/chromeFavoriteBridge');
const coreService = require('./src/coreService');
const fetcher = require('./src/fetcher');
const av123 = require('./src/av123');
const packageInfo = require('./package.json');
const { selectUserDataPath } = require('./src/userDataPath');
const databaseLocation = require('./src/databaseLocation');

const FETCH_HOSTS = new Set(['missav.ai', 'www.missav.ai']);
const AV123_FETCH_HOSTS = new Set(['123av.com', 'www.123av.com']);
const AV123_QUERY_PARTITION = 'persist:missav-manager-123av-query';
const RAINDROP_API_PARTITION = 'persist:missav-manager-raindrop-api';
const TELEGRAM_BOT_API_PARTITION = 'persist:missav-manager-telegram-bot-api';
const APP_PATH_NAMES = new Set(['userData']);
const grantedFiles = new Set();
const grantedDirectories = new Set();

const selectedUserData = selectUserDataPath({
  explicit: process.env.MISSAV_USER_DATA_DIR,
  appData: app.getPath('appData'),
  current: app.getPath('userData'),
});
app.setPath('userData', selectedUserData.path);
const selectedDatabaseLocation = databaseLocation.readDatabaseDirectory(app.getPath('userData'));
let activeDatabaseDirectory = selectedDatabaseLocation.directory;
const PACKAGE_SMOKE_MODE = process.argv.includes('--package-smoke');

let runtimeLogger = null;
let raindropEnsureCollectionsPromise = null;
function getRuntimeLogger() {
  if (!runtimeLogger) runtimeLogger = createRuntimeLogger(path.join(app.getPath('userData'), 'logs'));
  return runtimeLogger;
}

function writeRuntimeLog(level, event, data = {}) {
  try { getRuntimeLogger().append({ level, event, data }); } catch (err) { console.error('[Log Write Error]', err.message); }
}

function normalizeGrantedPath(value) {
  return path.resolve(String(value || ''));
}

function pathInside(root, target) {
  const normalizedRoot = normalizeGrantedPath(root);
  const normalizedTarget = normalizeGrantedPath(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

function grantFile(filePath) {
  const resolved = normalizeGrantedPath(filePath);
  if (resolved) grantedFiles.add(resolved);
  return resolved;
}

function grantDirectory(dirPath) {
  const resolved = normalizeGrantedPath(dirPath);
  if (resolved) grantedDirectories.add(resolved);
  return resolved;
}

function assertGrantedPath(targetPath, options = {}) {
  const resolved = normalizeGrantedPath(targetPath);
  const userData = normalizeGrantedPath(app.getPath('userData'));
  const allowed = pathInside(userData, resolved)
    || grantedFiles.has(resolved)
    || [...grantedDirectories].some(root => pathInside(root, resolved));
  if (!allowed) throw new Error(options.message || '该路径尚未由文件选择器授权');
  return resolved;
}

function raindropTokenPath() {
  return path.join(app.getPath('userData'), 'secure', 'raindrop-token.bin');
}

function raindropEncryptionAvailable() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

function readRaindropToken() {
  if (!raindropEncryptionAvailable()) throw new Error('系统安全存储暂不可用，无法读取 Raindrop 令牌');
  const filePath = raindropTokenPath();
  if (!fs.existsSync(filePath)) throw new Error('尚未配置 Raindrop 访问令牌');
  try {
    return raindropApi.normalizeToken(safeStorage.decryptString(fs.readFileSync(filePath)));
  } catch {
    throw new Error('Raindrop 令牌无法解密，请清除后重新保存');
  }
}

function writeRaindropToken(token) {
  if (!raindropEncryptionAvailable()) throw new Error('系统安全存储暂不可用，不能安全保存 Raindrop 令牌');
  const filePath = raindropTokenPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, safeStorage.encryptString(raindropApi.normalizeToken(token)), { mode: 0o600 });
}

function clearRaindropToken() {
  const filePath = raindropTokenPath();
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function chromeFavoriteBridgeTokenPath() {
  return path.join(app.getPath('userData'), 'secure', 'chrome-favorite-bridge-token.bin');
}

function readOrCreateChromeFavoriteBridgeToken() {
  if (!raindropEncryptionAvailable()) throw new Error('系统安全存储暂不可用，无法安全配对 Chrome 扩展');
  const filePath = chromeFavoriteBridgeTokenPath();
  if (fs.existsSync(filePath)) {
    try {
      const token = safeStorage.decryptString(fs.readFileSync(filePath));
      if (/^[a-f0-9]{64}$/i.test(token)) return token.toLowerCase();
    } catch {}
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, safeStorage.encryptString(token), { mode: 0o600 });
  return token;
}

function telegramSecretPath() {
  return path.join(app.getPath('userData'), 'secure', 'telegram-user.bin');
}

function readTelegramSecret() {
  if (!raindropEncryptionAvailable()) throw new Error('系统安全存储暂不可用，无法读取 Telegram 会话');
  const filePath = telegramSecretPath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const value = JSON.parse(safeStorage.decryptString(fs.readFileSync(filePath)));
    if (!Number.isSafeInteger(Number(value?.apiId)) || Number(value.apiId) <= 0
      || !String(value?.apiHash || '').trim() || !String(value?.session || '').trim()) return null;
    return {
      apiId: Number(value.apiId),
      apiHash: String(value.apiHash),
      session: String(value.session),
      accountKey: String(value.accountKey || ''),
      accountLabel: String(value.accountLabel || ''),
    };
  } catch {
    throw new Error('Telegram 会话无法解密，请清除后重新登录');
  }
}

function writeTelegramSecret(secret) {
  if (!raindropEncryptionAvailable()) throw new Error('系统安全存储暂不可用，不能安全保存 Telegram 会话');
  const filePath = telegramSecretPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = JSON.stringify({
    apiId: Number(secret.apiId),
    apiHash: String(secret.apiHash || ''),
    session: String(secret.session || ''),
    accountKey: String(secret.accountKey || ''),
    accountLabel: String(secret.accountLabel || ''),
  });
  fs.writeFileSync(filePath, safeStorage.encryptString(payload), { mode: 0o600 });
}

function clearTelegramSecret() {
  const filePath = telegramSecretPath();
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function telegramBotSecretPath() {
  return path.join(app.getPath('userData'), 'secure', 'telegram-bot.bin');
}

function readTelegramBotSecret() {
  if (!raindropEncryptionAvailable()) throw new Error('系统安全存储暂不可用，无法读取 Telegram Bot Token');
  const filePath = telegramBotSecretPath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const value = JSON.parse(safeStorage.decryptString(fs.readFileSync(filePath)));
    return {
      token: normalizeBotToken(value?.token),
      botId: String(value?.botId || ''),
      username: String(value?.username || ''),
      accountKey: String(value?.accountKey || ''),
      accountLabel: String(value?.accountLabel || ''),
    };
  } catch {
    throw new Error('Telegram Bot Token 无法解密，请清除后重新连接');
  }
}

function writeTelegramBotSecret(secret) {
  if (!raindropEncryptionAvailable()) throw new Error('系统安全存储暂不可用，不能安全保存 Telegram Bot Token');
  const filePath = telegramBotSecretPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = JSON.stringify({
    token: normalizeBotToken(secret?.token),
    botId: String(secret?.botId || ''),
    username: String(secret?.username || ''),
    accountKey: String(secret?.accountKey || ''),
    accountLabel: String(secret?.accountLabel || ''),
  });
  fs.writeFileSync(filePath, safeStorage.encryptString(payload), { mode: 0o600 });
}

function clearTelegramBotSecret() {
  const filePath = telegramBotSecretPath();
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

async function telegramBotApiRequest(method, payload = {}, token) {
  const cleanToken = normalizeBotToken(token);
  const endpoint = String(method || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9]+$/.test(endpoint)) throw new Error('Telegram Bot API 方法无效');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await session.fromPartition(TELEGRAM_BOT_API_PARTITION).fetch(
      `https://api.telegram.org/bot${cleanToken}/${endpoint}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
        signal: controller.signal,
      },
    );
    const body = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {}
    if (!response.ok || !parsed?.ok) {
      const retryAfter = Math.max(0, Number(parsed?.parameters?.retry_after) || 0);
      const description = redactBotSecrets(parsed?.description || `HTTP ${response.status}`, cleanToken);
      if (response.status === 409 || /webhook/i.test(description)) {
        throw new Error('该机器人正在被其他 Webhook 使用；请换一个新机器人，或先在原服务中停用 Webhook');
      }
      if (response.status === 429 || retryAfter > 0) {
        throw new Error(`Telegram Bot API 请求过快，请等待 ${retryAfter || 30} 秒后重试`);
      }
      throw new Error(description || `Telegram Bot API HTTP ${response.status}`);
    }
    return parsed.result;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Telegram Bot API 请求超时，请检查网络后重试');
    throw new Error(redactBotSecrets(error, cleanToken) || 'Telegram Bot API 请求失败');
  } finally {
    clearTimeout(timer);
  }
}

let raindropApiQueue = Promise.resolve();
let raindropLastRequestAt = 0;
let raindropBlockedUntil = 0;

function waitMilliseconds(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function enqueueRaindropApi(operation) {
  const pending = raindropApiQueue.then(operation, operation);
  raindropApiQueue = pending.catch(() => {});
  return pending;
}

async function raindropApiRequest(endpoint, options = {}) {
  const token = options.tokenOverride ? raindropApi.normalizeToken(options.tokenOverride) : readRaindropToken();
  const method = String(options.method || 'GET').toUpperCase();
  const url = `${raindropApi.API_BASE}${endpoint}`;
  const maxAttempts = Math.max(1, Math.min(3, Number(options.maxAttempts) || 3));

  return enqueueRaindropApi(async () => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const waitUntil = Math.max(raindropBlockedUntil, raindropLastRequestAt + 550);
      if (waitUntil > Date.now()) await waitMilliseconds(waitUntil - Date.now());
      raindropLastRequestAt = Date.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      let response;
      try {
        response = await session.fromPartition(RAINDROP_API_PARTITION).fetch(url, {
          method,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
          cache: 'no-store',
        });
      } catch (err) {
        clearTimeout(timeoutId);
        if (attempt < maxAttempts) {
          await waitMilliseconds(600 * attempt);
          continue;
        }
        const wrapped = new Error(err?.name === 'AbortError' ? 'Raindrop API 请求超时' : `Raindrop 网络请求失败：${err.message}`);
        wrapped.statusCode = 0;
        throw wrapped;
      }
      clearTimeout(timeoutId);
      const rate = raindropApi.parseRateLimit(response.headers);
      if (rate.remaining === 0 && rate.resetAt) raindropBlockedUntil = Math.max(raindropBlockedUntil, rate.resetAt);
      const raw = await response.text();
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
      if (response.ok && data?.result !== false) return { data, rate, statusCode: response.status };

      if (response.status === 429 && attempt < maxAttempts) {
        const retryAt = rate.resetAt || Date.now() + Math.min(15000, 1500 * attempt);
        raindropBlockedUntil = Math.max(raindropBlockedUntil, retryAt);
        writeRuntimeLog('warn', 'raindrop_rate_limited', { statusCode: 429, attempt, retryAt });
        continue;
      }
      if (response.status >= 500 && attempt < maxAttempts) {
        await waitMilliseconds(800 * attempt);
        continue;
      }
      const error = new Error(raindropApi.safeApiError(response.status, data));
      error.statusCode = response.status;
      throw error;
    }
    throw new Error('Raindrop API 请求失败');
  });
}

function safeRaindropAccount(data = {}) {
  const user = data?.user || data?.item || data || {};
  return {
    id: Number(user._id) || 0,
    label: String(user.fullName || user.name || user.email || '').trim().slice(0, 160) || 'Raindrop 用户',
  };
}

async function testRaindropToken(tokenOverride) {
  const result = await raindropApiRequest('/user', { tokenOverride, maxAttempts: 2 });
  return { configured: true, encryptionAvailable: raindropEncryptionAvailable(), account: safeRaindropAccount(result.data), rate: result.rate };
}

function parseWebUrl(value, { fetchTarget = false, allowedHosts = FETCH_HOSTS, serviceLabel = 'MissAV' } = {}) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new Error('链接格式无效');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('只允许打开 HTTP/HTTPS 链接');
  }
  if (parsed.username || parsed.password) {
    throw new Error('链接中不允许包含账号信息');
  }
  if (fetchTarget && !allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error(`只允许抓取 ${serviceLabel} 页面`);
  }
  return parsed.href;
}

// ── 全局错误处理 ──────────────────────────────────────
process.on('uncaughtException', (err) => {
  writeRuntimeLog('error', 'main_uncaught_exception', { message: err.message, stack: err.stack || '' });
  console.error('[Main Process Error]', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  writeRuntimeLog('error', 'main_unhandled_rejection', { message: reason?.message || String(reason), stack: reason?.stack || '' });
});

// ── Window ──────────────────────────────────────────────
let mainWindow;
let telegramUserService = null;
let telegramBotService = null;
let av123AccountWindow = null;
let av123AccountQueue = Promise.resolve();
let av123FavoriteWindow = null;
let av123FavoriteQueue = Promise.resolve();
const av123FavoriteWebContentsIds = new Set();
let av123AccountResourceFilterConfigured = false;
let chromeFavoriteBridge = null;

async function ensureChromeFavoriteBridge() {
  if (!chromeFavoriteBridge) {
    chromeFavoriteBridge = new ChromeFavoriteBridge({
      token: readOrCreateChromeFavoriteBridgeToken(),
      log: (level, event, data) => writeRuntimeLog(level, event, data),
    });
  }
  if (!chromeFavoriteBridge.server?.listening) await chromeFavoriteBridge.start();
  return chromeFavoriteBridge;
}

function chromeFavoriteExtensionTargetDir() {
  return path.join(app.getPath('userData'), 'chrome-extension', '123av-favorite-bridge');
}

function installChromeFavoriteExtensionFiles() {
  const sourceDir = path.join(__dirname, 'chrome-extension');
  const targetDir = chromeFavoriteExtensionTargetDir();
  const files = ['manifest.json', 'service-worker.js', 'content-script.js', 'popup.html', 'popup.css', 'popup.js'];
  fs.mkdirSync(targetDir, { recursive: true });
  for (const fileName of files) {
    const sourcePath = path.join(sourceDir, fileName);
    if (!fs.existsSync(sourcePath)) throw new Error(`安装包缺少 Chrome 扩展文件：${fileName}`);
    fs.copyFileSync(sourcePath, path.join(targetDir, fileName));
  }
  return targetDir;
}

function getTelegramUserService() {
  if (telegramUserService) return telegramUserService;
  telegramUserService = new TelegramUserService({
    readSecret: readTelegramSecret,
    writeSecret: writeTelegramSecret,
    clearSecret: clearTelegramSecret,
    emitState: state => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('telegram:state', state);
    },
    log: (level, event, data) => writeRuntimeLog(level, event, data),
  });
  return telegramUserService;
}

function getTelegramBotService() {
  if (telegramBotService) return telegramBotService;
  telegramBotService = new TelegramBotService({
    readSecret: readTelegramBotSecret,
    writeSecret: writeTelegramBotSecret,
    clearSecret: clearTelegramBotSecret,
    request: telegramBotApiRequest,
    log: (level, event, data) => writeRuntimeLog(level, event, data),
  });
  return telegramBotService;
}

function enqueueAv123AccountOperation(operation) {
  const pending = av123AccountQueue.then(operation, operation);
  av123AccountQueue = pending.catch(() => {});
  return pending;
}

function enqueueAv123FavoriteOperation(operation) {
  const pending = av123FavoriteQueue.then(operation, operation);
  av123FavoriteQueue = pending.catch(() => {});
  return pending;
}

function configureAv123AccountResourceFilter(accountSession) {
  if (av123AccountResourceFilterConfigured) return;
  av123AccountResourceFilterConfigured = true;
  accountSession.webRequest.onBeforeRequest((details, callback) => {
    const workerRequest = av123FavoriteWebContentsIds.has(Number(details.webContentsId));
    const resourceType = String(details.resourceType || '').toLowerCase();
    const cancel = workerRequest && ['image', 'media', 'font', 'ping'].includes(resourceType);
    callback({ cancel });
  });
}

function secureAv123AccountWindow(accountWindow, options = {}) {
  accountWindow.webContents.setAudioMuted(true);
  configureAv123AccountResourceFilter(accountWindow.webContents.session);
  if (options.favoriteWorker === true) av123FavoriteWebContentsIds.add(accountWindow.webContents.id);
  accountWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  accountWindow.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      parseWebUrl(targetUrl, { fetchTarget: true, allowedHosts: AV123_FETCH_HOSTS, serviceLabel: '123AV' });
    } catch {
      event.preventDefault();
    }
  });
  accountWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
}

function createAv123AccountWindow() {
  if (av123AccountWindow && !av123AccountWindow.isDestroyed()) return av123AccountWindow;
  av123AccountWindow = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 860,
    minHeight: 620,
    title: '123AV 账号窗口',
    backgroundColor: '#111318',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:missav-manager-123av-account',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  secureAv123AccountWindow(av123AccountWindow);
  av123AccountWindow.on('closed', () => { av123AccountWindow = null; });
  return av123AccountWindow;
}

function createAv123FavoriteWindow() {
  if (av123FavoriteWindow && !av123FavoriteWindow.isDestroyed()) return av123FavoriteWindow;
  const workerWindow = new BrowserWindow({
    width: 960,
    height: 720,
    title: '123AV 收藏工作窗口',
    backgroundColor: '#111318',
    show: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:missav-manager-123av-account',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  secureAv123AccountWindow(workerWindow, { favoriteWorker: true });
  const workerWebContentsId = workerWindow.webContents.id;
  workerWindow.on('closed', () => {
    av123FavoriteWebContentsIds.delete(workerWebContentsId);
    av123FavoriteWindow = null;
  });
  av123FavoriteWindow = workerWindow;
  return workerWindow;
}

async function loadAv123AccountUrl(url, targetWindow = null) {
  const safeUrl = parseWebUrl(url, { fetchTarget: true, allowedHosts: AV123_FETCH_HOSTS, serviceLabel: '123AV' });
  const accountWindow = targetWindow && !targetWindow.isDestroyed() ? targetWindow : createAv123AccountWindow();
  let timeoutId;
  try {
    await Promise.race([
      accountWindow.loadURL(safeUrl),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('123AV 账号页面加载超时')), 30000);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
  return accountWindow;
}

async function inspectAv123AccountPage(targetWindow = null) {
  const accountWindow = targetWindow && !targetWindow.isDestroyed() ? targetWindow : createAv123AccountWindow();
  if (accountWindow.webContents.getURL() === '' || accountWindow.webContents.getURL() === 'about:blank') {
    await loadAv123AccountUrl('https://123av.com/cn/', accountWindow);
  }
  let snapshot = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 120));
    snapshot = await accountWindow.webContents.executeJavaScript(av123Account.buildInspectionScript(), true);
    const detailPage = /\/[a-z]{2}\/v\//i.test(String(snapshot?.url || ''));
    const ready = snapshot?.challenge || snapshot?.loggedOut
      || (snapshot?.accountLabel && (!detailPage || snapshot?.saveState || snapshot?.detailCode || snapshot?.heading));
    if (ready) break;
  }
  return snapshot;
}

async function checkAv123AccountStatus() {
  try {
    await loadAv123AccountUrl('https://123av.com/cn/');
    const snapshot = await inspectAv123AccountPage();
    return av123Account.classifyAccountSnapshot(snapshot);
  } catch (err) {
    return {
      status: 'network_error',
      error: err.message || '123AV 账号页面加载失败',
      metadata: { responseKind: 'navigation_error' },
    };
  }
}

function createWindow() {
  console.log('[Main] Creating window...');
  writeRuntimeLog('info', 'app_window_create', { version: app.getVersion(), platform: process.platform, arch: process.arch });

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 680,
    title: 'TG 内容工具箱',
    backgroundColor: '#0f0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  });

  console.log('[Main] Loading renderer...');
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const currentUrl = mainWindow?.webContents?.getURL() || '';
    if (targetUrl !== currentUrl) event.preventDefault();
  });

  // 监听渲染进程错误
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    writeRuntimeLog('error', 'renderer_load_failed', { errorCode, errorDescription, validatedURL });
    console.error('[Renderer Load Error]', errorCode, errorDescription, validatedURL);
  });

  mainWindow.webContents.on('console-message', (event, level, message) => {
    console.log(`[Renderer] ${message}`);
  });

  mainWindow.once('ready-to-show', () => {
    writeRuntimeLog('info', 'app_window_ready', {});
    console.log('[Main] Window ready to show');
    if (PACKAGE_SMOKE_MODE) {
      writeRuntimeLog('info', 'app_package_smoke_ready', {});
      setTimeout(() => app.quit(), 250);
      return;
    }
    mainWindow.show();
    if (process.argv.includes('--dev')) {
      mainWindow.webContents.openDevTools();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (av123AccountWindow && !av123AccountWindow.isDestroyed()) av123AccountWindow.close();
    if (av123FavoriteWindow && !av123FavoriteWindow.isDestroyed()) av123FavoriteWindow.close();
  });
}

app.whenReady().then(async () => {
  try {
    const status = await coreService.init({
      dbDir: activeDatabaseDirectory,
      applicationDir: __dirname,
    });
    writeRuntimeLog('info', 'database_ready', {
      path: status.path,
      engine: status.engine,
      schemaVersion: status.schemaVersion,
      migrationBackup: status.migrationBackup?.fileName || '',
      locationSource: selectedDatabaseLocation.configured ? 'configured' : 'default',
      userDataSource: selectedUserData.source,
    });
  } catch (error) {
    writeRuntimeLog('error', 'database_init_failed', { error: error.message || String(error) });
  }
  try {
    await ensureChromeFavoriteBridge();
  } catch (error) {
    writeRuntimeLog('error', 'chrome_favorite_bridge_start_failed', { error: error.message || String(error) });
  }
  createWindow();
});

app.on('before-quit', () => {
  if (chromeFavoriteBridge) chromeFavoriteBridge.close().catch(() => {});
  try { coreService.close(); } catch {}
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.on('app:get-version-sync', event => {
  event.returnValue = packageInfo.version;
});

ipcMain.on('core:call', (event, payload = {}) => {
  try {
    const value = coreService.call(
      String(payload.scope || ''),
      String(payload.method || ''),
      Array.isArray(payload.args) ? payload.args : [],
    );
    event.returnValue = { ok: true, value };
  } catch (error) {
    event.returnValue = { ok: false, error: error.message || String(error) };
  }
});

// ── IPC: File Dialogs ───────────────────────────────────
ipcMain.handle('dialog:openFile', async (_event, options) => {
  const properties = ['openFile'];
  if (options?.multiSelections) properties.push('multiSelections');

  const result = await dialog.showOpenDialog(mainWindow, {
    title: options?.title || '选择文件',
    filters: options?.filters || [{ name: 'CSV 文件', extensions: ['csv'] }],
    properties,
  });
  if (result.canceled || !result.filePaths.length) return null;
  const granted = result.filePaths.map(grantFile);
  return options?.multiSelections ? granted : granted[0];
});

ipcMain.handle('dialog:openDirectory', async (_event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options?.title || '选择文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return grantDirectory(result.filePaths[0]);
});

ipcMain.handle('database-location:status', async () => ({
  directory: activeDatabaseDirectory,
  databasePath: coreService.status().path || path.join(activeDatabaseDirectory, 'missav_data.db'),
  configured: databaseLocation.readDatabaseDirectory(app.getPath('userData')).configured,
}));

ipcMain.handle('database-location:change', async () => {
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: '选择数据库专用文件夹',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '使用这个文件夹',
  });
  if (selection.canceled || !selection.filePaths.length) return { changed: false, canceled: true };
  const target = grantDirectory(selection.filePaths[0]);
  const current = path.resolve(activeDatabaseDirectory);
  if (path.resolve(target) === current) return { changed: false, canceled: false, directory: current };
  if (fs.existsSync(path.join(target, databaseLocation.DATABASE_FILE))) {
    throw new Error('所选文件夹已经有数据库。为防止覆盖，请选择一个空文件夹。');
  }

  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: '迁移数据库位置',
    message: '把当前数据库迁移到所选文件夹吗？',
    detail: `当前：${current}\n目标：${target}\n\n软件会先建立备份，再复制并校验数据库；原文件会保留，完成后自动重启。`,
    buttons: ['迁移并重启', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (confirmation.response !== 0) return { changed: false, canceled: true };

  try {
    coreService.call('database', 'createBackup', ['before_database_location_change', 'relocation']);
    coreService.call('database', 'save', ['FULL']);
    coreService.close();
    const migration = databaseLocation.relocateDatabaseDirectory(current, target);
    databaseLocation.writeDatabaseDirectory(app.getPath('userData'), target);
    activeDatabaseDirectory = target;
    writeRuntimeLog('info', 'database_location_changed', {
      source: current,
      target,
      bytes: migration.bytes || 0,
    });
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 250);
    return { changed: true, directory: target, restarting: true };
  } catch (error) {
    try {
      await coreService.init({ dbDir: current, applicationDir: __dirname });
    } catch {}
    throw new Error(`数据库迁移失败，仍使用原目录：${error.message || String(error)}`);
  }
});

function telegramExportHtmlTargets(directory) {
  const indexPath = path.join(directory, 'export_results.html');
  if (!fs.existsSync(indexPath)) return [];
  let html = '';
  try { html = fs.readFileSync(indexPath, 'utf8'); } catch { return []; }
  const targets = [];
  for (const match of html.matchAll(/href\s*=\s*(?:"([^"]*messages[^"]*\.html?)"|'([^']*messages[^']*\.html?)')/gi)) {
    const href = String(match[1] || match[2] || '').replace(/\//g, path.sep);
    const target = path.resolve(directory, href);
    const root = path.resolve(directory) + path.sep;
    if ((target + path.sep).startsWith(root) && fs.existsSync(target)) targets.push(target);
  }
  return [...new Set(targets)];
}

function collectTelegramExportPaths(inputs) {
  const selected = [...new Set((inputs || []).map(value => path.resolve(String(value || ''))).filter(Boolean))];
  const output = [];
  for (const selectedPath of selected) {
    if (!fs.existsSync(selectedPath)) continue;
    const stat = fs.statSync(selectedPath);
    if (stat.isFile()) {
      if (/\.(?:json|html?)$/i.test(selectedPath)) output.push(selectedPath);
      continue;
    }
    const resultJson = path.join(selectedPath, 'result.json');
    if (fs.existsSync(resultJson)) {
      output.push(resultJson);
      continue;
    }
    const savedHtmlTargets = telegramExportHtmlTargets(selectedPath);
    if (savedHtmlTargets.length) {
      output.push(...savedHtmlTargets);
      continue;
    }
    const stack = [selectedPath];
    let visited = 0;
    while (stack.length && visited < 5000 && output.length < 500) {
      const current = stack.pop();
      visited++;
      let entries = [];
      try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(entryPath);
        else if (/^messages(?:\d+)?\.html?$/i.test(entry.name)) output.push(entryPath);
      }
    }
  }
  return [...new Set(output)].slice(0, 500);
}

ipcMain.handle('telegram:parse-export', async (_event, selectedPaths) => {
  const inputPaths = Array.isArray(selectedPaths) ? selectedPaths : [selectedPaths];
  const authorizedPaths = inputPaths.map(value => assertGrantedPath(value));
  const files = collectTelegramExportPaths(authorizedPaths);
  if (!files.length) throw new Error('所选位置没有找到 Telegram JSON 或消息 HTML');
  let totalBytes = 0;
  const parsedFiles = [];
  const errors = [];
  for (const filePath of files) {
    try {
      const size = fs.statSync(filePath).size;
      if (size > 128 * 1024 * 1024) throw new Error('单个导出文件超过 128 MB，请改用 API 增量同步或缩小导出范围');
      totalBytes += size;
      if (totalBytes > 256 * 1024 * 1024) throw new Error('本次导出文本超过 256 MB，请分批导入');
      parsedFiles.push({ path: filePath, content: fs.readFileSync(filePath, 'utf8') });
    } catch (error) {
      errors.push({ file: path.basename(filePath), error: error.message || String(error) });
    }
  }
  const parsed = telegramSource.parseTelegramExportFiles(parsedFiles);
  const roots = [...new Set(authorizedPaths.map(value => path.resolve(String(value || ''))))].sort();
  const sourceKey = `telegram-export:${crypto.createHash('sha256').update(roots.join('\n')).digest('hex').slice(0, 24)}`;
  const result = {
    sourceKey,
    sourceType: parsedFiles.some(file => /\.json$/i.test(file.path)) ? 'export_json' : 'export_html',
    sourceLabel: roots.length === 1 ? path.basename(roots[0]) : `${roots.length} 个 Telegram 导出位置`,
    fileCount: parsedFiles.length,
    messages: parsed.messages,
    errors: [...errors, ...parsed.errors],
  };
  writeRuntimeLog(result.errors.length ? 'warn' : 'info', 'telegram_export_parsed', {
    sourceKey,
    sourceType: result.sourceType,
    fileCount: result.fileCount,
    messageCount: result.messages.length,
    codeCount: new Set(result.messages.flatMap(message => message.codes || [])).size,
    errorCount: result.errors.length,
  });
  return result;
});

ipcMain.handle('telegram-bot:status', async () => ({
  ...getTelegramBotService().status(),
  encryptionAvailable: raindropEncryptionAvailable(),
}));

ipcMain.handle('telegram-bot:connect', async (_event, options = {}) => ({
  ...(await getTelegramBotService().connect(options.token)),
  encryptionAvailable: raindropEncryptionAvailable(),
}));

ipcMain.handle('telegram-bot:connect-stored', async () => ({
  ...(await getTelegramBotService().connectStored()),
  encryptionAvailable: raindropEncryptionAvailable(),
}));

ipcMain.handle('telegram-bot:clear', async () => ({
  ...getTelegramBotService().clear(),
  encryptionAvailable: raindropEncryptionAvailable(),
}));

ipcMain.handle('telegram-bot:discover', async (_event, options = {}) => (
  getTelegramBotService().getUpdates({
    offset: options.offset,
    limit: options.limit,
    discovery: true,
  })
));

ipcMain.handle('telegram-bot:updates', async (_event, options = {}) => (
  getTelegramBotService().getUpdates({
    offset: options.offset,
    limit: options.limit,
  })
));

ipcMain.handle('telegram:status', async () => ({
  ...getTelegramUserService().status(),
  encryptionAvailable: raindropEncryptionAvailable(),
}));

ipcMain.handle('telegram:connect-stored', async () => ({
  ...(await getTelegramUserService().connectStored()),
  encryptionAvailable: raindropEncryptionAvailable(),
}));

ipcMain.handle('telegram:auth-start', async (_event, options = {}) => ({
  ...getTelegramUserService().startAuthorization({
    apiId: options.apiId,
    apiHash: options.apiHash,
    phoneNumber: options.phoneNumber,
  }),
  encryptionAvailable: raindropEncryptionAvailable(),
}));

ipcMain.handle('telegram:auth-start-qr', async (_event, options = {}) => ({
  ...getTelegramUserService().startQrAuthorization({
    apiId: options.apiId,
    apiHash: options.apiHash,
  }),
  encryptionAvailable: raindropEncryptionAvailable(),
}));

ipcMain.handle('telegram:auth-submit', async (_event, options = {}) => ({
  submitted: getTelegramUserService().submitAuthValue(options.kind, options.value),
}));

ipcMain.handle('telegram:auth-cancel', async () => getTelegramUserService().cancelAuthorization());
ipcMain.handle('telegram:logout', async () => getTelegramUserService().logOut());
ipcMain.handle('telegram:sync-stop', async () => getTelegramUserService().stopSync());
ipcMain.handle('telegram:list-groups', async () => getTelegramUserService().listGroupDialogs({ limit: 500 }));
ipcMain.handle('telegram:sync-group', async (_event, options = {}) => {
  const result = await getTelegramUserService().syncGroupMessages({
    chatKey: options.chatKey,
    limit: options.limit,
    since: options.since,
    ignoreBaseline: options.ignoreBaseline === true,
    baselineMessageId: options.baselineMessageId,
    checkpointMessageId: options.checkpointMessageId,
    syncCursorMessageId: options.syncCursorMessageId,
    syncTargetMessageId: options.syncTargetMessageId,
    lookback: options.lookback,
    onProgress: progress => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('telegram:progress', progress);
    },
  });
  const sourceKey = `telegram-api:${result.accountKey}:group:${result.chatKey}`;
  writeRuntimeLog('info', 'telegram_group_messages_ready_for_import', {
    accountKey: result.accountKey,
    chatKey: result.chatKey,
    sourceLabel: result.sourceLabel,
    messageCount: result.messages.length,
    checkpointMessageId: result.checkpointMessageId,
    checkpointComplete: result.checkpointComplete,
    syncCursorMessageId: result.syncCursorMessageId,
    syncTargetMessageId: result.syncTargetMessageId,
    hasMore: result.hasMore,
    stopped: result.stopped,
  });
  return {
    sourceKey,
    sourceType: 'api_group',
    sourceLabel: result.sourceLabel,
    messages: result.messages,
    errors: [],
    checkpointMessageId: result.checkpointMessageId,
    checkpointDate: result.messages[0]?.messageDate || '',
    accountKey: result.accountKey,
    accountLabel: result.accountLabel,
    chatKey: result.chatKey,
    chatType: result.chatType,
    isSelected: true,
    baselineMessageId: Math.max(0, Number(options.baselineMessageId) || 0),
    checkpointComplete: result.checkpointComplete,
    syncCursorMessageId: result.syncCursorMessageId,
    syncTargetMessageId: result.syncTargetMessageId,
    hasMore: result.hasMore,
    stopped: result.stopped,
  };
});

// ── IPC: File System ────────────────────────────────────
ipcMain.handle('fs:readFile', async (_event, filePath, encoding = 'utf-8') => {
  try {
    return fs.readFileSync(assertGrantedPath(filePath), encoding);
  } catch (err) {
    throw new Error(`读取文件失败: ${err.message}`);
  }
});

ipcMain.handle('fs:writeFile', async (_event, filePath, content, encoding = 'utf-8') => {
  try {
    const resolved = assertGrantedPath(filePath);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(resolved, content, encoding);
    return true;
  } catch (err) {
    throw new Error(`写入文件失败: ${err.message}`);
  }
});

ipcMain.handle('fs:createDirectory', async (_event, dirPath) => {
  try {
    const resolved = assertGrantedPath(dirPath);
    if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
    return true;
  } catch (err) {
    throw new Error(`创建文件夹失败: ${err.message}`);
  }
});

ipcMain.handle('fs:exists', async (_event, filePath) => {
  try {
    return fs.existsSync(assertGrantedPath(filePath));
  } catch {
    return false;
  }
});

ipcMain.handle('fs:readDir', async (_event, dirPath) => {
  try {
    return fs.readdirSync(assertGrantedPath(dirPath), { withFileTypes: true }).map(d => ({
      name: d.name,
      isDirectory: d.isDirectory(),
      isFile: d.isFile(),
    }));
  } catch {
    return [];
  }
});

// ── IPC: Network Fetch ──────────────────────────────────
function defaultFetchHeaders(extraHeaders = {}, referer = 'https://missav.ai/', userAgent = '') {
  return {
    'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Referer': referer,
    ...extraHeaders,
  };
}

async function fetchWithElectronNet(url, options = {}) {
  const networkSession = options.sessionPartition ? session.fromPartition(options.sessionPartition) : null;
  const result = await fetchWithElectronRequest(net, url, {
    method: options.method || 'GET',
    headers: defaultFetchHeaders(options.headers || {}, options.referer, networkSession?.getUserAgent()),
    redirectMode: options.redirectMode || 'follow',
    timeout: options.timeout || 15000,
    maximumBytes: options.maximumBytes || 8 * 1024 * 1024,
    networkSession,
  });
  if (!result.redirected) {
    result.finalUrl = parseWebUrl(result.finalUrl || url, {
      fetchTarget: true,
      allowedHosts: options.allowedHosts || FETCH_HOSTS,
      serviceLabel: options.serviceLabel || 'MissAV',
    });
  }
  return result;
}

function fetchWithNode(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;

    const fetchOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: defaultFetchHeaders(options.headers || {}, options.referer, options.userAgent),
      timeout: options.timeout || 15000,
    };

    let settled = false;
    let req = null;
    const startedAt = Date.now();
    const hardTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { req?.destroy?.(); } catch {}
      const error = new Error(`请求超过总时限 (${fetchOptions.timeout}ms)`);
      error.code = 'ETIMEDOUT';
      error.hardTimeout = true;
      reject(error);
    }, fetchOptions.timeout);
    const finishResolve = value => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      resolve({ ...value, durationMs: Date.now() - startedAt });
    };
    const finishReject = error => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      reject(error);
    };

    req = transport.request(fetchOptions, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        res.resume();
        finishResolve({ redirected: true, redirectUrl, statusCode: res.statusCode, transport: 'node', responseBytes: 0 });
        return;
      }

      let chunks = [];
      let responseBytes = 0;
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const payload = Buffer.concat(chunks);
        responseBytes = payload.length;
        const body = payload.toString('utf-8');
        finishResolve({
          redirected: false,
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          finalUrl: url,
          transport: 'node',
          responseBytes,
        });
      });
    });

    req.on('error', finishReject);

    req.end();
  });
}

async function handleNetworkFetch(url, options, config) {
  const requestStartedAt = Date.now();
  let safeUrl;
  try {
    safeUrl = parseWebUrl(url, {
      fetchTarget: true,
      allowedHosts: config.allowedHosts,
      serviceLabel: config.serviceLabel,
    });
  } catch (err) {
    return {
      redirected: false,
      statusCode: 0,
      headers: {},
      body: '',
      finalUrl: String(url || ''),
      error: err.message,
      transport: 'rejected',
    };
  }

  const safeOptions = {
    ...options,
    timeout: Math.min(30000, Math.max(1000, Number(options.timeout) || 15000)),
    allowedHosts: config.allowedHosts,
    serviceLabel: config.serviceLabel,
    referer: config.referer,
    redirectMode: config.redirectMode || 'follow',
    sessionPartition: config.sessionPartition || '',
  };

  if (safeOptions.sessionPartition) {
    safeOptions.userAgent = session.fromPartition(safeOptions.sessionPartition).getUserAgent();
  }

  try {
    const result = await fetchWithElectronNet(safeUrl, safeOptions);
    writeRuntimeLog('debug', 'network_request', {
      url: safeUrl,
      finalUrl: result.finalUrl || safeUrl,
      statusCode: result.statusCode || 0,
      transport: result.transport || 'electron-net',
      wasRedirected: Boolean(result.wasRedirected),
      service: config.logService,
      durationMs: Number(result.durationMs || 0),
      responseBytes: Number(result.responseBytes || 0),
    });
    return result;
  } catch (electronErr) {
    if (electronErr?.hardTimeout || electronErr?.code === 'ETIMEDOUT') {
      const failed = {
        redirected: false,
        statusCode: 0,
        headers: {},
        body: '',
        finalUrl: safeUrl,
        error: electronErr.message,
        transport: 'electron-timeout',
        durationMs: safeOptions.timeout,
        responseBytes: 0,
        timedOut: true,
      };
      writeRuntimeLog('warn', 'network_timeout', {
        url: safeUrl,
        timeoutMs: safeOptions.timeout,
        service: config.logService,
      });
      return failed;
    }
    if (config.allowNodeFallback !== true) {
      const failed = {
        redirected: false,
        statusCode: 0,
        headers: {},
        body: '',
        finalUrl: safeUrl,
        error: `Electron net: ${electronErr.message}`,
        transport: 'electron-failed',
        durationMs: Date.now() - requestStartedAt,
        responseBytes: 0,
      };
      writeRuntimeLog('error', 'network_failed', {
        url: safeUrl,
        error: failed.error,
        service: config.logService,
        durationMs: failed.durationMs,
        fallbackSuppressed: true,
      });
      return failed;
    }
    try {
      const result = await fetchWithNode(safeUrl, safeOptions);
      writeRuntimeLog('warn', 'network_fallback', {
        url: safeUrl,
        electronError: electronErr.message,
        statusCode: result.statusCode || 0,
        transport: result.transport || 'node',
        service: config.logService,
        durationMs: Number(result.durationMs || 0),
        responseBytes: Number(result.responseBytes || 0),
      });
      return result;
    } catch (nodeErr) {
      const failed = {
        redirected: false,
        statusCode: 0,
        headers: {},
        body: '',
        finalUrl: safeUrl,
        error: `Electron net: ${electronErr.message}; Node fallback: ${nodeErr.message}`,
        transport: 'failed',
      };
      writeRuntimeLog('error', 'network_failed', { url: safeUrl, error: failed.error, service: config.logService });
      return failed;
    }
  }
}

ipcMain.handle('net:fetch', async (_event, url, options = {}) => handleNetworkFetch(url, options, {
  allowedHosts: FETCH_HOSTS,
  serviceLabel: 'MissAV',
  logService: 'missav',
  referer: 'https://missav.ai/',
  redirectMode: 'follow',
}));

ipcMain.handle('net:fetch123av', async (_event, url, options = {}) => handleNetworkFetch(url, options, {
  allowedHosts: AV123_FETCH_HOSTS,
  serviceLabel: '123AV',
  logService: '123av',
  referer: 'https://123av.com/',
  redirectMode: 'error',
  sessionPartition: AV123_QUERY_PARTITION,
}));

ipcMain.handle('net:fetch-page', async (_event, url, options = {}) => fetcher.fetchPage(
  url,
  (targetUrl, fetchOptions) => handleNetworkFetch(targetUrl, fetchOptions, {
    allowedHosts: FETCH_HOSTS,
    serviceLabel: 'MissAV',
    logService: 'missav',
    referer: 'https://missav.ai/',
    redirectMode: 'follow',
  }),
  options,
));

ipcMain.handle('net:fetch123av-page', async (_event, url, options = {}) => av123.fetchPage(
  url,
  (targetUrl, fetchOptions) => handleNetworkFetch(targetUrl, fetchOptions, {
    allowedHosts: AV123_FETCH_HOSTS,
    serviceLabel: '123AV',
    logService: '123av',
    referer: 'https://123av.com/',
    redirectMode: 'error',
    sessionPartition: AV123_QUERY_PARTITION,
  }),
  options,
));

// ── IPC: local Chrome 123AV account bridge ─────────────
ipcMain.handle('chrome-favorite:status', async () => {
  const bridge = await ensureChromeFavoriteBridge();
  return bridge.status();
});

ipcMain.handle('chrome-favorite:prepare', async () => {
  const bridge = await ensureChromeFavoriteBridge();
  const extensionPath = installChromeFavoriteExtensionFiles();
  const openError = await shell.openPath(extensionPath);
  if (openError) throw new Error(openError);
  writeRuntimeLog('info', 'chrome_favorite_extension_prepared', { extensionPath, port: bridge.port });
  return {
    ...bridge.status(),
    extensionPath,
    pairingCode: bridge.pairingCode(),
  };
});

function normalizeAv123FavoriteExecutor(value) {
  return value === 'app' ? 'app' : 'chrome';
}

ipcMain.handle('123av-account:open', async (_event, options = {}) => {
  const executor = normalizeAv123FavoriteExecutor(options?.executor);
  if (executor === 'app') {
    return enqueueAv123AccountOperation(async () => {
      const accountWindow = createAv123AccountWindow();
      if (!accountWindow.webContents.getURL() || accountWindow.webContents.getURL() === 'about:blank') {
        await loadAv123AccountUrl('https://123av.com/cn/', accountWindow);
      }
      accountWindow.show();
      accountWindow.focus();
      const snapshot = await inspectAv123AccountPage(accountWindow);
      const result = av123Account.classifyAccountSnapshot(snapshot);
      writeRuntimeLog('info', 'av123_app_account_window_opened', {
        status: result.status,
        accountLabel: result.metadata?.accountLabel || '',
      });
      return result;
    });
  }
  const bridge = await ensureChromeFavoriteBridge();
  const result = await bridge.execute('open_account', {}, { timeoutMs: 45000 });
  writeRuntimeLog('info', 'av123_chrome_account_opened', {
    status: result.status,
    accountLabel: result.metadata?.accountLabel || '',
  });
  return result;
});

ipcMain.handle('123av-account:check', async (_event, options = {}) => {
  const executor = normalizeAv123FavoriteExecutor(options?.executor);
  if (executor === 'app') {
    return enqueueAv123AccountOperation(async () => {
      const result = await checkAv123AccountStatus();
      writeRuntimeLog(result.status === 'ready' ? 'info' : 'warn', 'av123_app_account_checked', {
        status: result.status,
        accountLabel: result.metadata?.accountLabel || '',
        error: result.error || '',
      });
      return result;
    });
  }
  const bridge = await ensureChromeFavoriteBridge();
  const result = await bridge.execute('check_account', {}, { timeoutMs: 45000 });
  writeRuntimeLog(result.status === 'ready' ? 'info' : 'warn', 'av123_chrome_account_checked', {
    status: result.status,
    accountLabel: result.metadata?.accountLabel || '',
    error: result.error || '',
  });
  return result;
});

ipcMain.handle('123av-account:favorite', async (_event, options = {}) => {
  const verifyOnly = options?.verifyOnly === true;
  if (!verifyOnly && options?.confirmed !== true) throw new Error('执行 123AV 收藏前必须由用户确认');
  const executor = normalizeAv123FavoriteExecutor(options?.executor);
  if (executor === 'app') {
    return enqueueAv123FavoriteOperation(async () => {
      const workerWindow = createAv123FavoriteWindow();
      const result = await av123Account.runFavoriteAction({
        navigate: url => loadAv123AccountUrl(url, workerWindow),
        inspect: () => inspectAv123AccountPage(workerWindow),
        clickSave: () => workerWindow.webContents.executeJavaScript(av123Account.buildSaveClickScript(), true),
      }, {
        code: options?.code,
        url: options?.url,
        verifyOnly,
      });
      writeRuntimeLog(
        ['succeeded', 'already_saved', 'ready'].includes(result.status) ? 'info' : 'warn',
        verifyOnly ? 'av123_app_favorite_verified' : 'av123_app_favorite_finished',
        {
          code: String(options?.code || ''),
          url: result.url || '',
          status: result.status,
          accountLabel: result.metadata?.accountLabel || '',
          responseKind: result.metadata?.responseKind || '',
          workerId: 0,
          clickAttempted: Boolean(result.metadata?.clickAttempted),
          error: result.error || '',
        },
      );
      if (result.requiresUserAction) {
        await enqueueAv123AccountOperation(async () => {
          const accountWindow = createAv123AccountWindow();
          await loadAv123AccountUrl(result.url || 'https://123av.com/cn/', accountWindow);
          accountWindow.show();
          accountWindow.focus();
        });
      }
      return result;
    });
  }
  return enqueueAv123FavoriteOperation(async () => {
    const bridge = await ensureChromeFavoriteBridge();
    const result = await bridge.execute('favorite', {
      code: options?.code,
      url: options?.url,
      verifyOnly,
      workerId: 0,
    }, { timeoutMs: 50000 });
    writeRuntimeLog(
      ['succeeded', 'already_saved', 'ready'].includes(result.status) ? 'info' : 'warn',
      verifyOnly ? 'av123_chrome_favorite_verified' : 'av123_chrome_favorite_finished',
      {
        code: String(options?.code || ''),
        url: result.url || '',
        status: result.status,
        accountLabel: result.metadata?.accountLabel || '',
        responseKind: result.metadata?.responseKind || '',
        workerId: 0,
        clickAttempted: Boolean(result.metadata?.clickAttempted),
        error: result.error || '',
      },
    );
    return result;
  });
});

// ── IPC: Raindrop Direct Sync ──────────────────────────
ipcMain.handle('raindrop:auth-status', async () => ({
  configured: fs.existsSync(raindropTokenPath()),
  encryptionAvailable: raindropEncryptionAvailable(),
}));

ipcMain.handle('raindrop:set-token', async (_event, token) => {
  const normalized = raindropApi.normalizeToken(token);
  const checked = await testRaindropToken(normalized);
  writeRaindropToken(normalized);
  writeRuntimeLog('info', 'raindrop_token_saved', { accountId: checked.account.id, accountLabel: checked.account.label });
  return checked;
});

ipcMain.handle('raindrop:clear-token', async () => {
  clearRaindropToken();
  writeRuntimeLog('info', 'raindrop_token_cleared', {});
  return { configured: false, encryptionAvailable: raindropEncryptionAvailable() };
});

ipcMain.handle('raindrop:test', async () => {
  const checked = await testRaindropToken();
  writeRuntimeLog('info', 'raindrop_account_checked', { accountId: checked.account.id, accountLabel: checked.account.label });
  return checked;
});

ipcMain.handle('raindrop:collections', async () => {
  const [root, children] = await Promise.all([
    raindropApiRequest('/collections'),
    raindropApiRequest('/collections/childrens'),
  ]);
  return {
    items: raindropApi.flattenCollections(root.data, children.data),
    rate: children.rate,
  };
});

ipcMain.handle('raindrop:ensure-collections', async (_event, names) => {
  if (raindropEnsureCollectionsPromise) return raindropEnsureCollectionsPromise;
  raindropEnsureCollectionsPromise = (async () => {
    const requested = raindropApi.normalizeAutoCollectionNames(names);
    const [root, children] = await Promise.all([
      raindropApiRequest('/collections'),
      raindropApiRequest('/collections/childrens'),
    ]);
    const existing = raindropApi.flattenCollections(root.data, children.data);
    const routing = {};
    const created = [];
    for (const name of requested) {
      const found = existing.find(row => row.parentId === 0 && row.title.toLowerCase() === name.toLowerCase());
      if (found) {
        routing[name] = found.id;
        continue;
      }
      const response = await raindropApiRequest('/collection', {
        method: 'POST',
        body: { title: name },
      });
      const collection = raindropApi.parseCreatedCollection(response.data, name);
      if (collection.parentId !== 0) throw new Error(`Raindrop 未把 ${name} 创建在根目录`);
      existing.push({ ...collection, path: collection.title });
      routing[name] = collection.id;
      created.push(collection);
      writeRuntimeLog('info', 'raindrop_collection_created', {
        collectionId: collection.id,
        title: collection.title,
      });
    }
    return {
      routing,
      created,
      items: existing.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN')),
    };
  })();
  try {
    return await raindropEnsureCollectionsPromise;
  } finally {
    raindropEnsureCollectionsPromise = null;
  }
});

ipcMain.handle('raindrop:check-urls', async (_event, urls) => {
  const safeUrls = raindropApi.sanitizeUrls(urls);
  const result = await raindropApiRequest('/import/url/exists', { method: 'POST', body: { urls: safeUrls } });
  return { items: raindropApi.parseExistsResponse(result.data, safeUrls), rate: result.rate };
});

ipcMain.handle('raindrop:upsert', async (_event, options = {}) => {
  const payload = raindropApi.sanitizeSyncPayload(options.payload || {});
  const remoteId = Number(options.remoteId);
  let action = 'created';
  let response;
  if (Number.isSafeInteger(remoteId) && remoteId > 0) {
    try {
      response = await raindropApiRequest(`/raindrop/${remoteId}`, { method: 'PUT', body: payload });
      action = 'updated';
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }
  }
  if (!response) response = await raindropApiRequest('/raindrop', { method: 'POST', body: payload });
  const item = response.data?.item || response.data?.raindrop || response.data || {};
  const nextRemoteId = Number(item._id || item.id || remoteId);
  if (!Number.isSafeInteger(nextRemoteId) || nextRemoteId <= 0) throw new Error('Raindrop 返回结果缺少书签 ID，请在网页端核对');
  return {
    action,
    item: {
      id: nextRemoteId,
      link: String(item.link || payload.link),
      title: String(item.title || payload.title),
    },
    rate: response.rate,
  };
});
// ── IPC: Open External ──────────────────────────────────
ipcMain.handle('shell:openExternal', async (_event, url) => {
  return shell.openExternal(parseWebUrl(url));
});

ipcMain.handle('shell:openDirectory', async (_event, dirPath) => {
  const resolved = assertGrantedPath(dirPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('目录不存在');
  }
  const error = await shell.openPath(resolved);
  if (error) throw new Error(error);
  return true;
});

// ── IPC: App Info ────────────────────────────────────────
ipcMain.handle('app:getPath', async (_event, name) => {
  if (!APP_PATH_NAMES.has(name)) throw new Error('不允许读取该应用路径');
  return app.getPath(name);
});

// ── IPC: Runtime Logs ───────────────────────────────────
ipcMain.handle('logs:append', async (_event, entry) => {
  return getRuntimeLogger().append(entry || {});
});

ipcMain.handle('logs:readRecent', async (_event, maxBytes) => {
  return getRuntimeLogger().readRecent(Math.min(2 * 1024 * 1024, Math.max(4096, Number(maxBytes) || 256 * 1024)));
});

ipcMain.handle('logs:getInfo', async () => {
  return getRuntimeLogger().info();
});

