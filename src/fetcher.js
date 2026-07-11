/**
 * MissAV Manager — MissAV 页面抓取 & 元数据提取
 */

const { cleanText, cleanRaindropTag, isBadTypeTag } = require('./utils');

/**
 * 通过主进程 fetch 一个 MissAV 页面
 * @param {string} url
 * @param {object} fetchImpl - 实际 fetch 实现 (来自 preload 暴露的 electronAPI.fetchPage)
 */
async function fetchPage(url, fetchImpl) {
  let result;
  try {
    result = await fetchImpl(url, { timeout: 15000 });
  } catch (err) {
    return { statusCode: 0, body: '', error: err.message };
  }

  // 处理重定向（最多跟 3 次）
  let redirects = 0;
  while (result.redirected && redirects < 3) {
    try {
      result = await fetchImpl(result.redirectUrl, { timeout: 15000 });
      redirects++;
    } catch (err) {
      return { statusCode: 0, body: '', error: err.message, redirectedFrom: result.redirectUrl };
    }
  }

  return {
    statusCode: result.statusCode,
    body: result.body || '',
    finalUrl: result.finalUrl,
    error: null,
  };
}

/**
 * 检查页面状态
 */
function checkPageStatus(pageHtml, code, finalUrl) {
  const rawHtml = String(pageHtml || '');
  const html = rawHtml.toLowerCase();
  const urlText = String(finalUrl || '').toLowerCase();
  const normalizedCode = String(code || '');
  const codeLower = normalizedCode.toLowerCase();
  const codeNoDash = normalizedCode.replace(/-/g, '').toLowerCase();

  // 完全没有拿到内容时才判定为不存在。
  if (!rawHtml.trim()) {
    return 'not_found';
  }

  // 检查是否包含目标番号。URL 命中也算，因为有些页面正文会懒加载或被保护页截断。
  const hasCode =
    html.includes(codeLower) ||
    html.includes(codeNoDash) ||
    urlText.includes(codeLower) ||
    urlText.includes(codeNoDash) ||
    (normalizedCode.startsWith('FC2-PPV-') && (html.includes(normalizedCode.replace('FC2-PPV-', 'fc2-ppv-')) || urlText.includes(normalizedCode.replace('FC2-PPV-', 'fc2-ppv-'))));

  if (!hasCode) {
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
  checkPageStatus,
  extractActressTags,
  extractGenreTags,
  extractMetadata,
};



