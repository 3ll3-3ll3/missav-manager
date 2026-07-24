const fs = require('fs');
const path = require('path');

const inputPaths = process.argv.slice(2);
if (!inputPaths.length) {
  console.error('用法：node scripts/analyze-av123-runtime.cjs <log> [previous-log]');
  process.exit(1);
}

function parseLog(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(line => {
      const match = line.match(/^(\S+) \[(\w+)\] (\S+) (\{.*\})$/);
      if (!match) return null;
      try {
        return {
          timestamp: match[1],
          time: Date.parse(match[1]),
          level: match[2],
          event: match[3],
          data: JSON.parse(match[4]),
          source: path.basename(filePath),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function percentile(sortedValues, quantile) {
  if (!sortedValues.length) return 0;
  return sortedValues[Math.min(sortedValues.length - 1, Math.floor((sortedValues.length - 1) * quantile))];
}

function counts(values) {
  const result = {};
  for (const value of values) result[value || '(empty)'] = (result[value || '(empty)'] || 0) + 1;
  return result;
}

const rows = inputPaths.flatMap(parseLog).sort((a, b) => a.time - b.time);
const starts = rows.filter(row => row.event === 'site_lookup_started' && row.data.site === 'av123');
const reports = [];

for (const start of starts) {
  const finish = rows.find(row => row.event === 'site_lookup_finished'
    && row.data.site === 'av123'
    && Number(row.data.runId) === Number(start.data.runId)
    && row.time >= start.time);
  const endTime = finish?.time || Number.POSITIVE_INFINITY;
  const attempts = rows.filter(row => row.event === 'av123_lookup_checked'
    && row.time >= start.time
    && row.time <= endTime);
  const gaps = attempts.slice(1).map((row, index) => row.time - attempts[index].time).sort((a, b) => a - b);
  const rateEvents = rows.filter(row => row.time >= start.time
    && row.time <= endTime
    && row.event.startsWith('av123_request_rate'));
  const fallbacks = rows.filter(row => row.time >= start.time
    && row.time <= endTime
    && row.event === 'network_fallback'
    && row.data.service === '123av');
  const failures = rows.filter(row => row.time >= start.time
    && row.time <= endTime
    && row.event === 'network_failed'
    && row.data.service === '123av');

  reports.push({
    runId: start.data.runId,
    source: start.source,
    startedAt: start.timestamp,
    finishedAt: finish?.timestamp || null,
    configured: start.data,
    result: finish?.data || null,
    attemptCount: attempts.length,
    statusCounts: counts(attempts.map(row => row.data.status)),
    routeCounts: counts(attempts.map(row => row.data.lookupRoute)),
    completionGapMs: {
      p50: percentile(gaps, 0.5),
      p95: percentile(gaps, 0.95),
      max: gaps.at(-1) || 0,
      over5Seconds: gaps.filter(gap => gap > 5000).length,
      over20Seconds: gaps.filter(gap => gap > 20000).length,
    },
    rateEvents: rateEvents.map(row => ({ timestamp: row.timestamp, event: row.event, data: row.data })),
    networkFallbacks: fallbacks.length,
    networkFailures: failures.length,
  });
}

console.log(JSON.stringify(reports, null, 2));
