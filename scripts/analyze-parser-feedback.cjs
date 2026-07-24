const fs = require('fs');
const { parseCSV } = require('../src/csvTools');
const parser = require('../src/parser');

const [reportPath, sourcePath] = process.argv.slice(2);
if (!reportPath || !sourcePath) {
  process.stderr.write('Usage: node scripts/analyze-parser-feedback.cjs <report.csv> <source.csv>\n');
  process.exit(2);
}

function readCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const parsed = parseCSV(text);
  return {
    headers: parsed.headers,
    rows: parsed.rows.map(row => Object.fromEntries(parsed.headers.map((header, index) => [header, row[index] || '']))),
  };
}

function compact(value, max = 130) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function contextAround(value, pattern, radius = 72) {
  const text = String(value || '').replace(/\s+/g, ' ');
  const match = pattern.exec(text);
  pattern.lastIndex = 0;
  if (!match) return compact(text, radius * 2);
  const start = Math.max(0, match.index - radius);
  const end = Math.min(text.length, match.index + match[0].length + radius);
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

const report = readCsv(reportPath);
const source = readCsv(sourcePath);
const reportCodes = report.rows.map(row => parser.normalizeCode(row.code)).filter(Boolean);
const sourceParsed = new Map();

source.rows.forEach((row, rowIndex) => {
  const parsedCodes = parser.parseCodeList(Object.values(row).join('\n'));
  for (const code of parsedCodes) {
    if (!sourceParsed.has(code)) sourceParsed.set(code, []);
    sourceParsed.get(code).push(rowIndex);
  }
});

process.stdout.write(`report_codes=${reportCodes.length}\nsource_rows=${source.rows.length}\nsource_parsed_unique=${sourceParsed.size}\n\n`);
for (const code of reportCodes) {
  const match = code.match(/^([A-Z]+)-(\d+)$/);
  const pattern = match
    ? new RegExp(`${match[1]}[\\s_-]*${match[2]}`, 'ig')
    : new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
  const rowIndexes = sourceParsed.get(code) || [];
  const contexts = [];
  for (const rowIndex of rowIndexes.slice(0, 5)) {
    const row = source.rows[rowIndex];
    const matchedFields = source.headers.filter(header => {
      pattern.lastIndex = 0;
      return pattern.test(String(row[header] || ''));
    });
    const contextFields = matchedFields.map(field => `${field}=${contextAround(row[field], pattern)}`);
    contexts.push(`row=${rowIndex + 2}; folder=${compact(row.folder, 50)}; fields=${matchedFields.join('|')}; ${contextFields.join('; ')}; source_url=${compact(row.url, 100)}; title=${compact(row.title, 100)}`);
  }
  process.stdout.write(`${code}\t${rowIndexes.length}\t${contexts.join(' || ') || '(not located by current parser)'}\n`);
}
