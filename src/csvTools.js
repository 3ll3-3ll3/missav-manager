/**
 * CSV tools for MissAV Manager.
 * Supports quoted fields, CRLF/LF, BOM, duplicate header names, and simple data audits.
 */
const { normalizeCode, codeComparableKey } = require('./parser');

function parseCSV(text) {
  const input = String(text || '').replace(/^\ufeff/, '');
  const records = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === ',' && !inQuotes) {
      row.push(field);
      field = '';
      continue;
    }

    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++;
      row.push(field);
      records.push(row);
      row = [];
      field = '';
      continue;
    }

    field += ch;
  }

  if (field.length || row.length) {
    row.push(field);
    records.push(row);
  }

  while (records.length && records[records.length - 1].every(v => !String(v || '').trim())) {
    records.pop();
  }

  const rawHeaders = records.shift() || [];
  const headers = uniqueHeaders(rawHeaders.map((h, i) => String(h || '').trim() || `Column${i + 1}`));
  const colCount = Math.max(headers.length, ...records.map(r => r.length), 0);

  while (headers.length < colCount) headers.push(`Column${headers.length + 1}`);

  const rowLengths = records.map(r => r.length);
  const rows = records.map(r => {
    const next = r.slice(0, colCount);
    while (next.length < colCount) next.push('');
    return next;
  });

  return { headers, rows: repairRaindropLineBreaks(headers, rows, rowLengths) };
}

function repairRaindropLineBreaks(headers, rows, rowLengths) {
  const official = ['id', 'title', 'note', 'excerpt', 'url', 'folder', 'tags', 'created', 'cover', 'highlights', 'favorite'];
  if (headers.length !== official.length || official.some((name, index) => String(headers[index] || '').toLowerCase() !== name)) return rows;

  const repaired = [];
  let current = null;
  let continuationColumn = null;

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const rawLength = rowLengths[index] || 0;
    if (/^\d+$/.test(String(row[0] || '').trim())) {
      current = row.slice();
      repaired.push(current);
      continuationColumn = rawLength > 0 && rawLength < official.length ? rawLength - 1 : null;
      continue;
    }

    if (!current || continuationColumn === null) {
      if (row.some(value => String(value || '').trim())) repaired.push(row);
      continue;
    }

    const sourceUrl = row.findIndex(value => /^https?:\/\//i.test(String(value || '').trim()));
    if (sourceUrl >= 0 && continuationColumn < 4 && !String(current[4] || '').trim()) {
      appendCsvContinuation(current, continuationColumn, row.slice(0, sourceUrl).join(','));
      for (let source = sourceUrl, target = 4; source < rawLength && target < official.length; source++, target++) {
        current[target] = row[source] ?? '';
      }
      continuationColumn = null;
      continue;
    }

    appendCsvContinuation(current, continuationColumn, row.slice(0, rawLength).join(','));
  }

  return repaired;
}

function appendCsvContinuation(row, column, value) {
  const current = String(row[column] || '');
  row[column] = current ? `${current}\n${value}` : String(value || '');
}

function uniqueHeaders(headers) {
  const seen = new Map();
  return headers.map((h, i) => {
    const base = String(h || '').trim() || `Column${i + 1}`;
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return count ? `${base}_${count + 1}` : base;
  });
}

function stringifyCSV(headers, rows) {
  const out = [];
  out.push(headers.map(escapeCell).join(','));
  for (const row of rows) {
    out.push(headers.map((_, i) => escapeCell(row[i] ?? '')).join(','));
  }
  return out.join('\r\n');
}

function escapeCell(value) {
  const s = String(value ?? '');
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function analyzeCSV(headers, rows) {
  const issues = [];
  const codeCol = guessColumn(headers, ['番号', 'code', 'movie', '品番']);
  const urlCol = guessColumn(headers, ['url', '链接', 'link', '网址']);
  const statusCol = guessColumn(headers, ['状态', 'status']);
  const seenCodes = new Map();
  let unknownActress = 0;
  let needCheck = 0;
  let notFound = 0;

  rows.forEach((row, rowIndex) => {
    const text = row.map(v => String(v || '')).join(' | ');
    if (text.includes('#未知女优')) unknownActress++;
    if (/需要查找|待核验|可点待核验/.test(text)) needCheck++;
    if (/未找到|not_found/i.test(text)) notFound++;

    if (codeCol >= 0) {
      const rawCode = String(row[codeCol] || '').trim();
      if (!rawCode) {
        issues.push({ type: 'empty_code', severity: 'error', row: rowIndex, column: codeCol, message: '番号为空' });
      } else {
        const normalized = normalizeCode(rawCode);
        if (!/^(FC2-PPV-\d{4,10}|[A-Z]{2,12}-\d{2,8})$/.test(normalized)) {
          issues.push({ type: 'bad_code', severity: 'warning', row: rowIndex, column: codeCol, message: `番号格式可疑：${rawCode}` });
        }
        const key = codeComparableKey(rawCode);
        if (seenCodes.has(key)) {
          const message = `疑似重复番号：${normalized}`;
          issues.push({ type: 'duplicate_code', severity: 'warning', row: rowIndex, column: codeCol, message });
          issues.push({ type: 'duplicate_code', severity: 'warning', row: seenCodes.get(key), column: codeCol, message });
        } else {
          seenCodes.set(key, rowIndex);
        }
      }
    }

    if (urlCol >= 0) {
      const url = String(row[urlCol] || '').trim();
      if (url && !/^https?:\/\//i.test(url)) {
        issues.push({ type: 'bad_url', severity: 'warning', row: rowIndex, column: urlCol, message: `链接格式可疑：${url}` });
      }
    }
  });

  const uniqueIssues = dedupeIssues(issues);
  return {
    rowCount: rows.length,
    columnCount: headers.length,
    codeColumn: codeCol,
    urlColumn: urlCol,
    statusColumn: statusCol,
    unknownActress,
    needCheck,
    notFound,
    issueCount: uniqueIssues.length,
    issues: uniqueIssues,
  };
}

function guessColumn(headers, names) {
  const lower = headers.map(h => String(h || '').toLowerCase());
  for (const name of names) {
    const key = String(name).toLowerCase();
    const exact = lower.findIndex(h => h === key);
    if (exact >= 0) return exact;
  }
  for (const name of names) {
    const key = String(name).toLowerCase();
    const partial = lower.findIndex(h => h.includes(key));
    if (partial >= 0) return partial;
  }
  return -1;
}

function dedupeIssues(issues) {
  const seen = new Set();
  return issues.filter(issue => {
    const key = `${issue.type}:${issue.row}:${issue.column}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  parseCSV,
  stringifyCSV,
  analyzeCSV,
  guessColumn,
};
