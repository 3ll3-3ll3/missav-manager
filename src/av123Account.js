/**
 * 123AV account-window automation helpers.
 *
 * This module only works with visible DOM state. It never reads cookies,
 * storage, passwords, or session data.
 */

const { normalizeCode } = require('./parser');
const { hasExactCodeEvidence } = require('./av123');

const AV123_HOSTS = new Set(['123av.com', 'www.123av.com']);

function validateDetailUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new Error('123AV 详情链接格式无效');
  }
  if (parsed.protocol !== 'https:' || !AV123_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('只允许操作 123AV HTTPS 详情页');
  }
  if (parsed.username || parsed.password || !/^\/[a-z]{2}\/v\/[^/]+\/?$/i.test(parsed.pathname)) {
    throw new Error('只允许操作标准 123AV 详情页');
  }
  parsed.hash = '';
  return parsed.href;
}

function accountMetadata(snapshot = {}, extra = {}) {
  return {
    accountLabel: String(snapshot.accountLabel || '').trim().slice(0, 64),
    pageUrl: String(snapshot.url || '').trim().slice(0, 500),
    remoteState: String(extra.remoteState || snapshot.saveState || '').trim().slice(0, 32),
    ...extra,
  };
}

function classifyAccountSnapshot(snapshot = {}, expectedCode = '') {
  const code = normalizeCode(expectedCode);
  const accountLabel = String(snapshot.accountLabel || '').trim();
  if (snapshot.rateLimited) {
    return {
      status: 'network_error',
      error: '123AV / Cloudflare Error 1015：当前 IP 被临时限速',
      requiresUserAction: false,
      metadata: accountMetadata(snapshot, {
        responseKind: 'rate_limited',
        retryAfterMs: 120000,
      }),
    };
  }
  if (snapshot.challenge) {
    return {
      status: 'manual',
      error: '123AV 要求人工完成访问验证',
      requiresUserAction: true,
      metadata: accountMetadata(snapshot, { responseKind: 'challenge' }),
    };
  }
  // A visible account identifier is stronger evidence than login-form markup
  // that the site may keep mounted but hidden after authentication.
  if (!accountLabel) {
    return {
      status: 'not_logged_in',
      error: '123AV 账号窗口尚未登录',
      requiresUserAction: true,
      metadata: accountMetadata(snapshot, { responseKind: 'not_logged_in' }),
    };
  }
  if (!code) {
    return {
      status: 'ready',
      error: '',
      metadata: accountMetadata(snapshot, { responseKind: 'account_ready' }),
    };
  }

  const evidence = [snapshot.detailCode, snapshot.heading].filter(Boolean).join(' ');
  if (!hasExactCodeEvidence(evidence, code)) {
    return {
      status: 'manual',
      error: `123AV 详情页未显示目标番号 ${code}`,
      metadata: accountMetadata(snapshot, { responseKind: 'detail_mismatch' }),
    };
  }
  if (snapshot.saveState === 'saved') {
    return {
      status: 'already_saved',
      error: '',
      metadata: accountMetadata(snapshot, { responseKind: 'detail', remoteState: 'saved' }),
    };
  }
  if (snapshot.saveState === 'save') {
    return {
      status: 'ready',
      error: '',
      metadata: accountMetadata(snapshot, { responseKind: 'detail', remoteState: 'not_saved' }),
    };
  }
  return {
    status: 'manual',
    error: '123AV 详情页没有可识别的收藏按钮',
    metadata: accountMetadata(snapshot, { responseKind: 'save_control_missing' }),
  };
}

function buildInspectionScript() {
  return `(() => {
    const clean = value => String(value || '').replace(/\\s+/g, ' ').trim();
    const isVisible = node => {
      if (!node || !node.isConnected) return false;
      const style = getComputedStyle(node);
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && node.getClientRects().length > 0;
    };
    const buttons = [...document.querySelectorAll('button')].filter(isVisible);
    const buttonText = button => clean(button.getAttribute('aria-label') || button.innerText || button.textContent);
    const accountLabel = buttons.map(buttonText).find(text => /^\\d{6,20}$/.test(text)) || '';
    const mainButtons = [...document.querySelectorAll('main button')];
    const savedButton = mainButtons.find(button => buttonText(button).startsWith('已保存'));
    const saveButton = savedButton || mainButtons.find(button => buttonText(button).startsWith('保存'));
    const codeTerm = [...document.querySelectorAll('main dt')].find(node => /^(代码|番[號号]|code)$/i.test(clean(node.textContent)));
    const bodyText = clean(document.body?.innerText || '').slice(0, 12000);
    const title = clean(document.title);
    const rateLimited = /error\s*1015|you are being rate limited|banned you temporarily|temporarily from accessing/i.test(title + ' ' + bodyText.slice(0, 3000));
    const challenge = !rateLimited && /just a moment|verify you are human|cloudflare|captcha|人机验证|访问验证|安全验证/i.test(title + ' ' + bodyText.slice(0, 3000));
    const visiblePasswordInput = [...document.querySelectorAll('input[type="password"]')].some(isVisible);
    const loggedOut = visiblePasswordInput || /\\/(login|signin)(?:\\/|$)/i.test(location.pathname);
    return {
      url: location.href,
      title: title.slice(0, 300),
      accountLabel,
      loggedOut,
      challenge,
      rateLimited,
      heading: clean(document.querySelector('main h1')?.innerText).slice(0, 1000),
      detailCode: clean(codeTerm?.nextElementSibling?.innerText).slice(0, 160),
      saveState: savedButton ? 'saved' : saveButton ? 'save' : '',
    };
  })()`;
}

function buildSaveClickScript() {
  return `(() => {
    const clean = value => String(value || '').replace(/\\s+/g, ' ').trim();
    const buttons = [...document.querySelectorAll('main button')];
    const button = buttons.find(node => clean(node.getAttribute('aria-label') || node.innerText || node.textContent).startsWith('保存'));
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`;
}

async function runFavoriteAction(adapter, options = {}) {
  if (!adapter || typeof adapter.navigate !== 'function' || typeof adapter.inspect !== 'function' || typeof adapter.clickSave !== 'function') {
    throw new Error('123AV 账号执行器未正确初始化');
  }
  const code = normalizeCode(options.code);
  if (!code) throw new Error('番号不能为空');
  const url = validateDetailUrl(options.url);
  const verifyOnly = options.verifyOnly === true;
  // The 123AV save request often succeeds before the hydrated button changes
  // from "保存" to "已保存".  Keeping a worker parked on the same DOM for ten
  // seconds made the whole queue unnecessarily slow.  The renderer now runs a
  // second, fresh-page round for uncertain clicks, so this first-pass check is
  // intentionally short.
  const pollAttempts = Math.max(1, Math.min(60, Number(options.pollAttempts) || 4));
  const pollDelayMs = Math.max(0, Math.min(3000, Number(options.pollDelayMs) || 400));
  const sleep = typeof adapter.sleep === 'function'
    ? adapter.sleep
    : ms => new Promise(resolve => setTimeout(resolve, ms));

  try {
    await adapter.navigate(url);
  } catch (err) {
    return {
      status: 'network_error',
      url,
      error: err?.message || '123AV 详情页加载失败',
      metadata: { responseKind: 'navigation_error', clickAttempted: false },
    };
  }

  let snapshot;
  try {
    snapshot = await adapter.inspect(code);
  } catch (err) {
    return {
      status: 'network_error',
      url,
      error: err?.message || '无法读取 123AV 页面状态',
      metadata: { responseKind: 'inspection_error', clickAttempted: false },
    };
  }
  const initial = classifyAccountSnapshot(snapshot, code);
  if (initial.status === 'already_saved') {
    return { ...initial, url, metadata: { ...initial.metadata, clickAttempted: false } };
  }
  if (initial.status !== 'ready') {
    return { ...initial, url, metadata: { ...initial.metadata, clickAttempted: false } };
  }
  if (verifyOnly) {
    return {
      status: 'ready',
      url,
      error: '',
      metadata: { ...initial.metadata, responseKind: 'verified_not_saved', clickAttempted: false },
    };
  }

  let clicked = false;
  try {
    clicked = await adapter.clickSave();
  } catch (err) {
    return {
      status: 'verify_required',
      url,
      error: `收藏点击后状态未知：${err?.message || '页面执行异常'}`,
      metadata: { ...initial.metadata, responseKind: 'click_error', clickAttempted: true },
    };
  }
  if (!clicked) {
    return {
      status: 'manual',
      url,
      error: '123AV 收藏按钮当前不可点击',
      metadata: { ...initial.metadata, responseKind: 'save_control_unavailable', clickAttempted: false },
    };
  }

  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    await sleep(pollDelayMs);
    let nextSnapshot;
    try {
      nextSnapshot = await adapter.inspect(code);
    } catch (err) {
      return {
        status: 'verify_required',
        url,
        error: `已点击收藏，但远端状态读取失败：${err?.message || '页面读取异常'}`,
        metadata: { ...initial.metadata, responseKind: 'post_click_inspection_error', clickAttempted: true },
      };
    }
    const next = classifyAccountSnapshot(nextSnapshot, code);
    if (next.status === 'already_saved') {
      return {
        status: 'succeeded',
        url,
        error: '',
        metadata: { ...next.metadata, responseKind: 'saved', clickAttempted: true },
      };
    }
    if (next.status !== 'ready') {
      return {
        status: 'verify_required',
        url,
        error: `已点击收藏，但需要核对远端：${next.error || '页面状态发生变化'}`,
        requiresUserAction: Boolean(next.requiresUserAction),
        metadata: { ...next.metadata, responseKind: 'post_click_unverified', clickAttempted: true },
      };
    }
  }

  return {
    status: 'verify_required',
    url,
    error: '已点击收藏，但页面未及时显示“已保存”，等待下一轮重新打开确认',
    metadata: {
      ...initial.metadata,
      responseKind: 'post_click_timeout',
      clickAttempted: true,
      confirmationPolls: pollAttempts,
      confirmationWaitMs: pollAttempts * pollDelayMs,
    },
  };
}

module.exports = {
  AV123_HOSTS,
  validateDetailUrl,
  classifyAccountSnapshot,
  buildInspectionScript,
  buildSaveClickScript,
  runFavoriteAction,
};
