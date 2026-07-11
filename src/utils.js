/**
 * MissAV Manager — 通用工具函数
 */

/**
 * 清理文本：合并空白字符，去除首尾空格
 */
function cleanText(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 清理 Raindrop tag：去除非法字符，替换空格为下划线
 */
function cleanRaindropTag(s) {
  return cleanText(s)
    .replace(/[#,;"'<>?:|\\\/[\]{}]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 120);
}

/**
 * HTML 转义
 */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * CSV 单元格转义
 */
function csvCell(s) {
  return `"${String(s ?? '').replace(/"/g, '""')}"`;
}

/**
 * 生成精确到分钟的时间前缀: YYYYMMDD_HHMM
 */
function timePrefixToMinute() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}${m}${day}_${hh}${mm}`;
}

/**
 * 延迟函数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 判断是否是广告/脏类型 tag
 */
function isBadTypeTag(name) {
  const s = cleanText(name);
  const tag = cleanRaindropTag(s);

  if (!s || !tag) return true;

  // 页面字段类，不是类型
  if (/女优|女優|男优|男優|系列|发行商|發行商|导演|導演|标签|標籤|片商|收藏|登录|注册|更多|首页|首頁/i.test(s)) return true;

  // 广告 / 引流 / 博彩 / VPN / 漫画 / 主播
  if (/官方.*电报|官方.*電報|电报群|電報群|Telegram|TG群/i.test(s)) return true;
  if (/无广告|無廣告|免费漫画|免費漫畫|漫画|漫畫/i.test(s)) return true;
  if (/AI[_\s\-]*Jerk|Jerk[_\s\-]*Off/i.test(s)) return true;
  if (/亚博|亞博|赌场|賭場|世界杯|博彩|投注/i.test(s)) return true;
  if (/VPN|性价王|性價王/i.test(s)) return true;
  if (/色色主播|主播|直播|约炮|約炮|交友/i.test(s)) return true;

  // 下载/资源类
  if (/下载|下載|磁力|种子|種子|网盘|網盤|云盘|雲盤|torrent|magnet/i.test(s)) return true;

  // 网站/系统/无意义
  if (/MissAV|DM\d+|^\d+$/.test(s)) return true;

  // 番号或伪番号混进 tag
  if (/[a-z]{2,}\d{2,}/i.test(s)) return true;

  // URL / 域名
  if (/https?:\/\//i.test(s) || /\.[a-z]{2,}/i.test(s)) return true;

  // 纯下划线 tag（广告经过 cleanRaindropTag 后的残留）
  if (/^_+$/.test(tag)) return true;

  return false;
}

module.exports = {
  cleanText,
  cleanRaindropTag,
  escapeHtml,
  csvCell,
  timePrefixToMinute,
  sleep,
  isBadTypeTag,
};