/**
 * MissAV Manager — 女优 tag 合集管理
 *
 * 合集 CSV 格式: 女优tag名字, 收藏数, 番号1, 番号2, ...
 */

const { normalizeCode, codeComparableKey } = require('./parser');

/**
 * 解析旧 tag 合集 CSV 文本
 * @returns {{ tag: string, count: number, codes: string[] }[]}
 */
function parseTagCollection(csvText) {
  const lines = String(csvText || '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return []; // 至少要有 header + 1 行数据

  // 跳过 header
  const dataLines = lines.slice(1);
  const rows = [];

  for (const line of dataLines) {
    const cols = parseCSVLine(line);
    if (cols.length < 3) continue;

    const tag = (cols[0] || '').trim();
    if (!tag) continue;

    // cols[1] 是 count，从 cols[2] 开始是番号
    const codes = cols.slice(2)
      .map(c => normalizeCode(c.trim()))
      .filter(c => c && c.length >= 5);

    rows.push({
      tag,
      count: codes.length, // 重新计算确保准确
      codes: [...new Set(codes)], // 行内去重
    });
  }

  return rows;
}

/**
 * 简单 CSV 行解析（支持引号转义）
 */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

/**
 * 检查番号是否已在合集中
 * @returns {{ found: boolean, tagName: string }}
 */
function findCodeInCollection(code, collection) {
  const key = codeComparableKey(code);
  for (const row of collection) {
    for (const c of row.codes) {
      if (codeComparableKey(c) === key) {
        return { found: true, tagName: row.tag };
      }
    }
  }
  return { found: false, tagName: '' };
}

/**
 * 匹配女优名到旧 tag
 */
function matchActressTag(actressNames, oldCollection) {
  if (!actressNames || actressNames.length === 0) return '';

  // 先尝试精确匹配
  for (const name of actressNames) {
    for (const row of oldCollection) {
      if (row.tag === name) return row.tag;
    }
  }

  // 模糊匹配：检查旧 tag 是否包含新抓到的名字
  for (const name of actressNames) {
    const nameLower = name.toLowerCase();
    for (const row of oldCollection) {
      const tagLower = row.tag.toLowerCase();
      if (tagLower.includes(nameLower) || nameLower.includes(tagLower.split('_')[0])) {
        return row.tag;
      }
    }
  }

  // 无匹配 → 返回第一个名字作为新 tag
  return actressNames[0];
}

/**
 * 增量更新 tag 合集
 * @param {Array} oldCollection - 旧合集行
 * @param {Array} newEntries - 本次新抓取结果 [{ code, actressTag, genres, status }]
 * @returns {Array} 更新后的合集行
 */
function updateTagCollection(oldCollection, newEntries) {
  // 深拷贝旧合集
  const updated = oldCollection.map(row => ({
    tag: row.tag,
    codes: [...row.codes],
  }));

  for (const entry of newEntries) {
    const code = normalizeCode(entry.code);
    const key = codeComparableKey(code);
    const actressTag = entry.actressTag || '';

    // 跳过已存在的番号
    const existing = findCodeInCollection(code, updated);
    if (existing.found) continue;

    if (actressTag) {
      // 查找匹配行
      let row = updated.find(r => r.tag === actressTag);
      if (row) {
        // 已有该女优行 → 追加番号
        if (!row.codes.some(c => codeComparableKey(c) === key)) {
          row.codes.push(code);
        }
      } else {
        // 新增女优行
        updated.push({ tag: actressTag, codes: [code] });
      }
    } else {
      // 女优未知
      let unknownRow = updated.find(r => r.tag === '#未知女优');
      if (unknownRow) {
        if (!unknownRow.codes.some(c => codeComparableKey(c) === key)) {
          unknownRow.codes.push(code);
        }
      } else {
        updated.push({ tag: '#未知女优', codes: [code] });
      }
    }
  }

  // 更新 count + 行内排序 + 去重
  for (const row of updated) {
    row.codes = [...new Set(row.codes)].sort();
    row.count = row.codes.length;
  }

  // 整体排序
  return sortCollectionRows(updated);
}

/**
 * 合集排序
 */
function sortCollectionRows(rows) {
  return [...rows].sort((a, b) => {
    const at = String(a.tag || '');
    const bt = String(b.tag || '');

    // 特殊 tag（# 开头）排最前
    const ak = at.startsWith('#') ? `000_${at}` : `100_${at}`;
    const bk = bt.startsWith('#') ? `000_${bt}` : `100_${bt}`;

    return ak.localeCompare(bk, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  });
}

module.exports = {
  parseTagCollection,
  findCodeInCollection,
  matchActressTag,
  updateTagCollection,
  sortCollectionRows,
  parseCSVLine,
};