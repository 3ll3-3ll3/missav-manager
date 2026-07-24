/**
 * MissAV Manager — MissAV 页面抓取 & 元数据提取
 */

const { cleanText, cleanRaindropTag, isBadTypeTag } = require('./utils');

/**
 * 通过主进程 fetch 一个 MissAV 页面
 * @param {string} url
 * @param {object} fetchImpl - 实际 fetch 实现 (来自 preload 暴露的 electronAPI.fetchPage)
 */
async function fetchPage(url, fetchImpl, options = {}) {
  const timeout = Number(options.timeout || 15000);
  let result;
  try {
    result = await fetchImpl(url, { timeout });
  } catch (err) {
    return { statusCode: 0, body: '', error: err.message };
  }

  // 处理重定向（最多跟 3 次）
  let redirects = 0;
  while (result.redirected && redirects < 3) {
    try {
      result = await fetchImpl(result.redirectUrl, { timeout });
      redirects++;
    } catch (err) {
      return { statusCode: 0, body: '', error: err.message, redirectedFrom: result.redirectUrl };
    }
  }

  if (result.redirected) {
    return {
      statusCode: result.statusCode || 0,
      body: '',
      finalUrl: result.redirectUrl || url,
      error: '重定向次数超过限制',
    };
  }

  return {
    statusCode: result.statusCode,
    body: result.body || '',
    finalUrl: result.finalUrl || url,
    error: result.error || null,
    transport: result.transport || '',
    durationMs: Number(result.durationMs || 0),
    responseBytes: Number(result.responseBytes || 0),
    timedOut: result.timedOut === true,
  };
}

/**
 * 检查页面状态
 */
function detectAccessChallenge(pageHtml, code = '') {
  const html = String(pageHtml || '').toLowerCase();
  if (!html) return '';

  // 这些特征只会出现在真正的拦截页，可直接判为访问验证。
  const strongMarkers = [
    ['cloudflare_challenge', 'cf-chl-'],
    ['checking_browser', 'checking your browser'],
    ['verify_human', 'verify you are human'],
    ['cloudflare_attention_required', 'attention required! | cloudflare'],
    ['title_just_a_moment', '<title>just a moment'],
    ['title_403_forbidden', '<title>403 forbidden'],
  ];
  const strongMatch = strongMarkers.find(([, marker]) => html.includes(marker));
  if (strongMatch) return strongMatch[0];

  // MissAV 的正常详情页可能预载 CAPTCHA/访问控制脚本。只有页面没有同时
  // 呈现“目标番号 + 详情结构”时，才把这些通用词当成拦截证据。
  const hasTargetCode = code ? hasCodeEvidence(pageHtml, code) : false;
  const hasDetailStructure = hasDetailPageEvidence(pageHtml);
  if (hasTargetCode && hasDetailStructure) return '';

  const weakMarkers = [
    ['cloudflare_challenge_platform', 'challenge-platform'],
    ['too_many_requests', 'too many requests'],
    ['rate_limit_exceeded', 'rate limit exceeded'],
    ['access_denied', 'access denied'],
    ['captcha', 'captcha'],
    ['human_verification_zh', '人机验证'],
    ['security_verification_zh', '安全验证'],
    ['access_denied_zh', '访问被拒绝'],
    ['rate_limit_zh', '请求过于频繁'],
  ];
  const weakMatch = weakMarkers.find(([, marker]) => html.includes(marker));
  return weakMatch ? weakMatch[0] : '';
}

function isAccessChallengePage(pageHtml, code = '') {
  return Boolean(detectAccessChallenge(pageHtml, code));
}

function hasCodeEvidence(pageHtml, code) {
  const html = String(pageHtml || '').toLowerCase();
  const normalizedCode = String(code || '').trim().toLowerCase();
  if (!html || !normalizedCode) return false;
  const forms = new Set([
    normalizedCode,
    normalizedCode.replace(/-/g, ''),
    normalizedCode.replace(/-/g, '_'),
    normalizedCode.replace(/-/g, ' '),
  ]);
  if (normalizedCode.startsWith('fc2-ppv-')) {
    const number = normalizedCode.replace('fc2-ppv-', '');
    forms.add(`fc2-${number}`);
    forms.add(`fc2 ppv ${number}`);
    forms.add(`fc2_ppv_${number}`);
  }
  return [...forms].some(form => form && html.includes(form));
}

function hasDetailPageEvidence(pageHtml) {
  const html = String(pageHtml || '').toLowerCase();
  return html.includes('video') ||
    html.includes('player') ||
    html.includes('m3u8') ||
    html.includes('播放') ||
    html.includes('iframe') ||
    html.includes('jwplayer') ||
    html.includes('/video/') ||
    html.includes('/actresses/') ||
    html.includes('/genres/');
}

function checkPageStatus(pageHtml, code, finalUrl) {
  const rawHtml = String(pageHtml || '');
  const html = rawHtml.toLowerCase();

  // 完全没有拿到内容时才判定为不存在。
  if (!rawHtml.trim()) {
    return 'not_found';
  }

  // 防爬、验证码和限流页属于访问失败，不属于“页面可点待核验”。
  if (isAccessChallengePage(rawHtml, code)) {
    return 'network_error';
  }

  // URL 本身不再作为番号命中证据，避免首页、保护页和通用错误页被误判为待核验。
  if (!hasCodeEvidence(rawHtml, code)) {
    return 'not_found';
  }

  // 内容太短时不能可靠提取标签，但这不是“需要查找/不存在”。
  if (rawHtml.length < 200) {
    return 'need_manual_check';
  }

  // 检查是否是视频详情页
  const hasVideoIndicator =
    html.includes('video') ||
    html.includes('player') ||
    html.includes('m3u8') ||
    html.includes('播放') ||
    html.includes('iframe') ||
    html.includes('jwplayer') ||
    html.includes('/video/');

  const hasActress = html.includes('/actresses/');
  const hasGenre = html.includes('/genres/');

  if (!hasActress && !hasGenre && !hasVideoIndicator) {
    return 'need_manual_check';
  }

  if (!hasVideoIndicator && hasActress) {
    return 'page_ok_play_unknown';
  }

  if (!hasActress) {
    return 'no_actress_found';
  }

  return 'ok';
}

function classifyCandidateResponse(page, code, requestedUrl = '') {
  const response = page || {};
  const url = response.finalUrl || requestedUrl || '';
  const statusCode = Number(response.statusCode || 0);
  const html = String(response.body || '');

  if (response.error) {
    return { status: 'network_error', url, html: '', statusCode, error: String(response.error) };
  }
  if (statusCode === 404 || statusCode === 410) {
    return { status: 'not_found', url, html, statusCode, error: '' };
  }
  if (!statusCode || statusCode >= 400) {
    return { status: 'network_error', url, html: '', statusCode, error: statusCode ? `HTTP ${statusCode}` : '未取得有效 HTTP 响应' };
  }

  const status = checkPageStatus(html, code, url);
  const challengeReason = status === 'network_error' ? detectAccessChallenge(html, code) : '';
  return {
    status,
    url,
    html,
    statusCode,
    error: status === 'network_error'
      ? `页面触发访问验证、限流或防爬保护${challengeReason ? `（特征：${challengeReason}）` : ''}`
      : '',
  };
}

function shouldStopCandidateSearch(status) {
  return ['ok', 'no_actress_found', 'page_ok_play_unknown'].includes(status);
}

function resolveCandidateAttempts(attempts, fallbackUrl = '') {
  const rows = Array.isArray(attempts) ? attempts : [];
  const priority = new Map([
    ['ok', 5],
    ['no_actress_found', 4],
    ['page_ok_play_unknown', 3],
    ['need_manual_check', 2],
  ]);
  let best = null;
  for (const row of rows) {
    const score = priority.get(row.status) || 0;
    if (score && (!best || score > best.score)) best = { ...row, score };
  }
  if (best) {
    const { score, ...result } = best;
    return result;
  }

  const network = rows.find(row => row.status === 'network_error');
  if (network) return network;
  const missing = rows.find(row => row.status === 'not_found');
  return missing || { status: 'not_found', url: fallbackUrl, html: '', statusCode: 0, error: '' };
}

/**
 * 从 HTML 中提取女优 tag（只抓 /actresses/ 链接）
 */
function extractActressTags(pageHtml) {
  const html = String(pageHtml || '').replace(/\\\//g, '/');
  const actressPattern = /<a\b[^>]*href\s*=\s*(["'])[^"']*\/actresses\/[^"']*\1[^>]*>([\s\S]*?)<\/a>/gi;
  const result = [];
  const seen = new Set();

  let match;
  while ((match = actressPattern.exec(html)) !== null) {
    const raw = cleanText(match[2].replace(/<[^>]*>/g, ''));
    if (!raw || raw.length > 80) continue;

    const tag = cleanRaindropTag(raw);
    if (!tag || seen.has(tag)) continue;
    if (isBadTypeTag(raw)) continue;

    seen.add(tag);
    result.push(tag);
  }

  return result;
}

/**
 * 从 HTML 中提取类型 tag（只抓 /genres/ 链接）
 *//**
 * 从 HTML 中提取类型 tag（只抓 /genres/ 链接）
 */
function extractGenreTags(pageHtml) {
  const html = String(pageHtml || '').replace(/\\\//g, '/');
  const genrePattern = /<a\b[^>]*href\s*=\s*(["'])[^"']*\/genres\/[^"']*\1[^>]*>([\s\S]*?)<\/a>/gi;
  const result = [];
  const seen = new Set();

  let match;
  while ((match = genrePattern.exec(html)) !== null) {
    const raw = cleanText(match[2].replace(/<[^>]*>/g, ''));
    if (!raw || raw.length > 40) continue;
    if (isBadTypeTag(raw)) continue;

    const tag = cleanRaindropTag(raw);
    if (!tag || seen.has(tag)) continue;

    seen.add(tag);
    result.push(tag);
  }

  return result;
}

/**
 * 综合元数据提取
 *//**
 * 综合元数据提取
 */
function extractMetadata(pageHtml, code, finalUrl) {
  const status = checkPageStatus(pageHtml, code, finalUrl);
  const actresses = status === 'ok' || status === 'page_ok_play_unknown'
    ? extractActressTags(pageHtml)
    : [];
  const genres = (status === 'ok' || status === 'page_ok_play_unknown' || status === 'no_actress_found')
    ? extractGenreTags(pageHtml)
    : [];

  return { status, actresses, genres };
}

module.exports = {
  fetchPage,
  detectAccessChallenge,
  isAccessChallengePage,
  hasCodeEvidence,
  hasDetailPageEvidence,
  checkPageStatus,
  classifyCandidateResponse,
  resolveCandidateAttempts,
  shouldStopCandidateSearch,
  extractActressTags,
  extractGenreTags,
  extractMetadata,
};



