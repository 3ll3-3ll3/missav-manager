/**
 * MissAV Manager — Raindrop 导入文件 & 报告导出
 */

const { escapeHtml, csvCell, timePrefixToMinute } = require('./utils');

const MANUAL_VERIFY_FOLDER = '需要手动核验';
const MAIN_FOLDER = 'MissAV_Import';
const NEED_CHECK_TAG = '需要查找';
const UNKNOWN_ACTRESS_TAG = '#未知女优';

/**
 * 判断某条记录是否应放入「需要手动核验」文件夹
 * 规则：只有 status === 'not_found' 才进
 */
function isManualVerifyRow(row) {
  return row.includeInImport === true && row.status === 'not_found';
}

function folderForRow(row) {
  return row.folder || (isManualVerifyRow(row) ? MANUAL_VERIFY_FOLDER : MAIN_FOLDER);
}

/**
 * 生成 Raindrop 导入 HTML
 * @param {Array} rows - 处理结果行
 */
function generateRaindropHTML(rows) {
  const importRows = rows.filter(r => r.includeInImport);
  const folderGroups = new Map();

  for (const row of importRows) {
    const folder = folderForRow(row);
    if (!folderGroups.has(folder)) folderGroups.set(folder, []);
    folderGroups.get(folder).push(row);
  }

  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>MissAV Import</TITLE>',
    '<H1>MissAV Import</H1>',
    '<DL><p>',
  ];

  for (const [folder, folderRows] of folderGroups.entries()) {
    lines.push(`<DT><H3>${escapeHtml(folder)}</H3>`);
    lines.push('<DL><p>');
    for (const row of folderRows) {
      const tags = (row.finalTags || []).join(',');
      const title = row.title || row.code;
      const note = row.note || row.excerpt || '';
      lines.push(`<DT><A HREF="${escapeHtml(row.url)}" TAGS="${escapeHtml(tags)}">${escapeHtml(title)}</A>`);
      if (note) lines.push(`<DD>${escapeHtml(note)}`);
    }
    lines.push('</DL><p>');
  }

  lines.push('</DL><p>');
  return lines.join('\n');
}

/**
 * 生成 Raindrop 导入 CSV
 */
function generateRaindropCSV(rows) {
  const importRows = rows.filter(r => r.includeInImport);
  const lines = ['folder,url,title,note,tags,created'];

  for (const row of importRows) {
    lines.push([
      csvCell(folderForRow(row)),
      csvCell(row.url),
      csvCell(row.title || row.code),
      csvCell(row.note || row.excerpt || ''),
      csvCell((row.finalTags || []).join(',')),
      csvCell(row.created || ''),
    ].join(','));
  }

  return lines.join('\n');
}

/**
 * 生成处理报告 CSV
 */
function generateReportCSV(rows) {
  const lines = ['code,url,status,actresses_found,genres_found,final_tags,skipped_reason,in_manual_verify'];

  for (const row of rows) {
    lines.push([
      csvCell(row.code),
      csvCell(row.url),
      csvCell(row.status),
      csvCell((row.actresses || []).join(' | ')),
      csvCell((row.genres || []).join(' | ')),
      csvCell((row.finalTags || []).join(',')),
      csvCell(row.skippedReason || ''),
      csvCell(isManualVerifyRow(row) ? 'yes' : 'no'),
    ].join(','));
  }

  return lines.join('\n');
}

/**
 * 生成女优 tag 合集 CSV
 */
function generateTagCollectionCSV(collectionRows) {
  const maxCodes = Math.max(0, ...collectionRows.map(r => r.codes.length));
  const header = ['女优tag名字', '收藏数'];
  for (let i = 1; i <= maxCodes; i++) header.push(`番号${i}`);

  const lines = [header.join(',')];

  for (const row of collectionRows) {
    const cols = [csvCell(row.tag), String(row.count)];
    for (let i = 0; i < maxCodes; i++) {
      cols.push(csvCell(row.codes[i] || ''));
    }
    lines.push(cols.join(','));
  }

  return lines.join('\n');
}

/**
 * 生成备份 JSON
 */
function generateBackupJSON(rows, collectionRows, stats) {
  return JSON.stringify({
    exportTime: new Date().toISOString(),
    stats,
    results: rows.map(r => ({
      code: r.code,
      url: r.url,
      status: r.status,
      actresses: r.actresses || [],
      genres: r.genres || [],
      finalTags: r.finalTags,
      skippedReason: r.skippedReason || '',
      includeInImport: r.includeInImport,
      inManualVerify: isManualVerifyRow(r),
      error: r.error || '',
    })),
    tagCollection: collectionRows.map(r => ({
      tag: r.tag,
      count: r.count,
      codes: r.codes,
    })),
  }, null, 2);
}

/**
 * 构建最终输出的每条记录
 */
function buildOutputRow(code, url, status, actresses, genres, matchedActressTag, skippedReason, includeInImport) {
  // 构建最终 tags
  const finalTags = [];
  const matchedActressTags = Array.isArray(matchedActressTag)
    ? matchedActressTag.filter(Boolean)
    : String(matchedActressTag || '').split(',').map(x => x.trim()).filter(Boolean);

  // 女优 tag
  if (matchedActressTags.length) {
    finalTags.push(...matchedActressTags);
  } else if (status === 'not_found' || status === 'no_actress_found' || status === 'need_manual_check') {
    finalTags.push(UNKNOWN_ACTRESS_TAG);
  }

  // 类型 tag（正常状态都加）
  if (status !== 'not_found' && genres && genres.length > 0) {
    for (const g of genres) {
      if (!finalTags.includes(g)) finalTags.push(g);
    }
  }

  // 问题 tag
  if (status === 'not_found') {
    finalTags.push(NEED_CHECK_TAG);
  }

  // 去重 tag
  const uniqueTags = [...new Set(finalTags)];

  return {
    code,
    url,
    status,
    actresses: actresses || [],
    genres: genres || [],
    matchedActressTag: matchedActressTags[0] || '',
    matchedActressTags,
    title: code,
    excerpt: '',
    note: '',
    folder: '',
    cover: '',
    created: '',
    customTags: [],
    finalTags: uniqueTags,
    skippedReason: skippedReason || '',
    includeInImport,
    error: '',
  };
}

module.exports = {
  MANUAL_VERIFY_FOLDER,
  MAIN_FOLDER,
  NEED_CHECK_TAG,
  UNKNOWN_ACTRESS_TAG,
  isManualVerifyRow,
  generateRaindropHTML,
  generateRaindropCSV,
  generateReportCSV,
  generateTagCollectionCSV,
  generateBackupJSON,
  buildOutputRow,
  timePrefixToMinute,
};


