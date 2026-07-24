const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const database = require('../src/database');

const ROWS = 80;
const actressTags = ['Speed Actress A', 'Speed Actress B'];
const genres = ['剧情', '高清', '单体', '独家', '企划', '数码', '长片', '热门'];

function resultRow(index) {
  const code = `QZSP-${String(1000 + index)}`;
  return {
    code,
    url: `https://missav.ai/cn/${code.toLowerCase()}`,
    status: 'ok',
    matchedActressTags: actressTags,
    genres,
  };
}

async function measure(kind) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `missav-persist-${kind}-`));
  try {
    await database.init(dir);
    const startedAt = performance.now();
    for (let index = 0; index < ROWS; index++) {
      const row = resultRow(index);
      if (kind === 'optimized') {
        database.persistProcessedCode(row);
      } else {
        const codeId = database.upsertCode(row.code, row.url, row.status);
        for (const tag of row.matchedActressTags) {
          const actressId = database.getOrCreateActressTag(tag);
          database.linkActressCode(actressId, codeId);
        }
        for (const genre of row.genres) database.linkGenreCode(genre, codeId);
      }
    }
    const elapsedMs = performance.now() - startedAt;
    return { kind, rows: ROWS, elapsedMs: Math.round(elapsedMs), rowsPerSecond: Number((ROWS * 1000 / elapsedMs).toFixed(1)) };
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  const legacy = await measure('legacy');
  const optimized = await measure('optimized');
  process.stdout.write(JSON.stringify({ legacy, optimized, speedup: Number((legacy.elapsedMs / optimized.elapsedMs).toFixed(2)) }, null, 2));
})().catch(error => {
  process.stderr.write(error.stack || error.message);
  process.exitCode = 1;
});
