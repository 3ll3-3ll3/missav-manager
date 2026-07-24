const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const HOME_URL = 'https://123av.com/cn/';
const workerTabs = new Map();
const pollingSlots = new Set();
let pumpScheduled = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = (value, maxLength = 800) => String(value == null ? '' : value).trim().slice(0, maxLength);
const normalizeCode = value => clean(value, 100).toUpperCase().replace(/[\s_]+/g, '-').replace(/[^A-Z0-9-]/g, '');
const comparableCode = value => normalizeCode(value).replace(/-/g, '');

async function readConfig() {
  const { bridgeConfig } = await chrome.storage.local.get('bridgeConfig');
  if (!bridgeConfig?.port || !bridgeConfig?.token) return null;
  return {
    port: Number(bridgeConfig.port),
    token: clean(bridgeConfig.token, 200),
  };
}

function endpoint(config, path) {
  return `http://127.0.0.1:${config.port}${path}`;
}

async function bridgeFetch(config, path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${config.token}`);
  if (options.body) headers.set('Content-Type', 'application/json');
  return fetch(endpoint(config, path), { ...options, headers, cache: 'no-store' });
}

async function hello(config, accountLabel = '') {
  const response = await bridgeFetch(config, '/v1/hello', {
    method: 'POST',
    body: JSON.stringify({ version: EXTENSION_VERSION, accountLabel: clean(accountLabel, 64) }),
  });
  if (!response.ok) throw new Error(`桥接认证失败 (${response.status})`);
}

function validateDetailUrl(value) {
  const parsed = new URL(clean(value));
  if (parsed.protocol !== 'https:' || !['123av.com', 'www.123av.com'].includes(parsed.hostname.toLowerCase())) {
    throw new Error('只允许打开 123AV HTTPS 页面');
  }
  if (!/^\/[a-z]{2}\/v\/[^/]+\/?$/i.test(parsed.pathname)) throw new Error('详情链接格式无效');
  parsed.hash = '';
  return parsed.href;
}

function hasExactCodeEvidence(snapshot, expectedCode) {
  const expected = comparableCode(expectedCode);
  if (!expected) return false;
  const evidence = `${snapshot?.detailCode || ''} ${snapshot?.heading || ''}`.toUpperCase();
  const candidates = evidence.match(/FC2(?:[\s_-]*PPV)?[\s_-]*\d{4,10}|[A-Z]{2,8}[\s_-]*\d{2,5}/g) || [];
  return candidates.some(value => comparableCode(value) === expected);
}

function classifySnapshot(snapshot, expectedCode = '') {
  const metadata = {
    accountLabel: clean(snapshot?.accountLabel, 64),
    pageUrl: clean(snapshot?.url),
    remoteState: clean(snapshot?.saveState, 32),
  };
  if (snapshot?.rateLimited) return {
    status: 'network_error',
    error: '123AV / Cloudflare Error 1015：当前 IP 被临时限速',
    metadata: { ...metadata, responseKind: 'rate_limited', retryAfterMs: 60000 },
  };
  if (snapshot?.challenge) return {
    status: 'manual', error: '123AV 要求在 Chrome 中完成人工访问验证', requiresUserAction: true,
    metadata: { ...metadata, responseKind: 'challenge' },
  };
  if (!snapshot?.accountLabel || snapshot?.loggedOut) return {
    status: 'not_logged_in', error: '本地 Chrome 中的 123AV 账号尚未登录', requiresUserAction: true,
    metadata: { ...metadata, responseKind: 'not_logged_in' },
  };
  if (!expectedCode) return { status: 'ready', error: '', metadata: { ...metadata, responseKind: 'account_ready' } };
  if (!hasExactCodeEvidence(snapshot, expectedCode)) return {
    status: 'manual', error: `详情页未显示目标番号 ${normalizeCode(expectedCode)}`,
    metadata: { ...metadata, responseKind: 'detail_mismatch' },
  };
  if (snapshot.saveState === 'saved') return {
    status: 'already_saved', error: '', metadata: { ...metadata, responseKind: 'detail', remoteState: 'saved' },
  };
  if (snapshot.saveState === 'save') return {
    status: 'ready', error: '', metadata: { ...metadata, responseKind: 'detail', remoteState: 'not_saved' },
  };
  return {
    status: 'manual', error: '详情页没有可识别的收藏按钮',
    metadata: { ...metadata, responseKind: 'save_control_missing' },
  };
}

async function waitForTab(tabId, timeoutMs = 30000) {
  const current = await chrome.tabs.get(tabId).catch(() => null);
  if (current?.status === 'complete') return current;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Chrome 页面加载超时')), timeoutMs);
    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish(null, tab);
    };
    const removed = removedTabId => {
      if (removedTabId === tabId) finish(new Error('Chrome 工作标签页已关闭'));
    };
    const finish = (error, tab) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removed);
      if (error) reject(error); else resolve(tab);
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removed);
  });
}

async function getWorkerTab(workerId, url, active = false) {
  const slot = Math.max(0, Math.min(4, Number(workerId) || 0));
  let tabId = workerTabs.get(slot);
  let tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  if (!tab) {
    tab = await chrome.tabs.create({ url, active });
    workerTabs.set(slot, tab.id);
  } else {
    tab = await chrome.tabs.update(tab.id, { url, active });
  }
  await waitForTab(tab.id);
  return chrome.tabs.get(tab.id);
}

async function inspect(tabId) {
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt) await sleep(180);
    try {
      const reply = await chrome.tabs.sendMessage(tabId, { type: 'inspect' });
      if (reply?.ok) return reply.snapshot || {};
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('无法读取 123AV 页面状态');
}

async function runAccountCommand(command) {
  const tab = await getWorkerTab(4, HOME_URL, command === 'open_account');
  const snapshot = await inspect(tab.id);
  return classifySnapshot(snapshot);
}

async function runFavorite(payload = {}) {
  const url = validateDetailUrl(payload.url);
  const code = normalizeCode(payload.code);
  const tab = await getWorkerTab(payload.workerId, url, false);
  const firstSnapshot = await inspect(tab.id);
  const first = classifySnapshot(firstSnapshot, code);
  first.url = url;
  first.metadata = { ...first.metadata, clickAttempted: false };
  if (first.status === 'already_saved' || first.status !== 'ready') return first;
  if (payload.verifyOnly === true) {
    return { status: 'ready', url, error: '', metadata: { ...first.metadata, responseKind: 'verified_not_saved' } };
  }
  let clickReply;
  try {
    clickReply = await chrome.tabs.sendMessage(tab.id, { type: 'click-save' });
  } catch (error) {
    return {
      status: 'verify_required', url, error: `收藏点击状态未知：${clean(error?.message, 300)}`,
      metadata: { ...first.metadata, responseKind: 'click_error', clickAttempted: true },
    };
  }
  if (!clickReply?.clicked) return {
    status: 'manual', url, error: 'Chrome 中的收藏按钮当前不可点击',
    metadata: { ...first.metadata, responseKind: 'save_control_unavailable', clickAttempted: false },
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(350);
    const next = classifySnapshot(await inspect(tab.id), code);
    if (next.status === 'already_saved') return {
      status: 'succeeded', url, error: '',
      metadata: { ...next.metadata, responseKind: 'saved', clickAttempted: true, confirmationPolls: attempt + 1 },
    };
    if (next.status !== 'ready') return {
      status: 'verify_required', url, error: `已点击收藏，但需要核对远端：${next.error || '页面状态发生变化'}`,
      requiresUserAction: next.requiresUserAction === true,
      metadata: { ...next.metadata, responseKind: 'post_click_unverified', clickAttempted: true },
    };
  }
  return {
    status: 'verify_required', url, error: '已点击收藏，但页面未及时显示“已保存”，将在下一轮重新打开确认',
    metadata: { ...first.metadata, responseKind: 'post_click_timeout', clickAttempted: true, confirmationPolls: 5, confirmationWaitMs: 1750 },
  };
}

async function executeTask(task) {
  if (task.command === 'open_account' || task.command === 'check_account') return runAccountCommand(task.command);
  if (task.command === 'favorite') return runFavorite(task.payload || {});
  return { status: 'failed', error: '不支持的 Chrome 收藏任务', metadata: { responseKind: 'unsupported_command' } };
}

async function postResult(config, id, result) {
  await bridgeFetch(config, '/v1/result', {
    method: 'POST',
    body: JSON.stringify({ id, result }),
  });
}

async function pollSlot(slot) {
  if (pollingSlots.has(slot)) return;
  pollingSlots.add(slot);
  try {
    const config = await readConfig();
    if (!config) return;
    await hello(config);
    for (let idle = 0; idle < 40; idle++) {
      const response = await bridgeFetch(config, '/v1/next');
      if (response.status === 204) {
        await sleep(500);
        continue;
      }
      if (!response.ok) throw new Error(`桥接读取失败 (${response.status})`);
      idle = 0;
      const body = await response.json();
      const task = body.task;
      if (!task?.id) continue;
      let result;
      try {
        result = await executeTask(task);
      } catch (error) {
        result = {
          status: 'network_error', url: clean(task.payload?.url), error: clean(error?.message || error, 1000),
          metadata: { responseKind: 'chrome_navigation_error', clickAttempted: false },
        };
      }
      await postResult(config, task.id, result);
      if (result?.metadata?.accountLabel) await hello(config, result.metadata.accountLabel);
    }
  } catch (error) {
    await chrome.storage.local.set({ bridgeLastError: clean(error?.message || error, 500), bridgeLastSeen: Date.now() });
  } finally {
    pollingSlots.delete(slot);
    schedulePump(1200);
  }
}

async function pump() {
  pumpScheduled = false;
  const config = await readConfig();
  if (!config) return;
  for (let slot = 0; slot < 4; slot++) pollSlot(slot);
}

function schedulePump(delay = 0) {
  if (pumpScheduled) return;
  pumpScheduled = true;
  setTimeout(() => pump(), delay);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('bridge-wake', { periodInMinutes: 0.5 });
  schedulePump();
});
chrome.runtime.onStartup.addListener(() => schedulePump());
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'bridge-wake') schedulePump(); });
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'bridge-config-updated') {
    schedulePump();
    sendResponse({ ok: true });
  }
  if (message?.type === 'bridge-status') {
    readConfig().then(config => sendResponse({ configured: Boolean(config), activeSlots: pollingSlots.size }));
    return true;
  }
});
schedulePump();
