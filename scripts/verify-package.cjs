const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');

const projectDir = path.resolve(__dirname, '..');
const packagePath = path.join(projectDir, 'dist', 'win-unpacked', 'resources', 'app.asar');
const exePath = path.join(projectDir, 'dist', `TG_Content_Toolbox_v${require('../package.json').version}.exe`);
const checks = [
  ['package.json', '"name": "tg-content-toolbox"'],
  ['package.json', '"version": "0.3.0"'],
  ['main.js', "new Set(['userData'])"],
  ['main.js', 'sandbox: true'],
  ['main.js', 'database-location:change'],
  ['main.js', 'app_package_smoke_ready'],
  ['preload.js', "require('electron')"],
  ['src/coreService.js', 'DATABASE_METHODS'],
  ['src/nativeSqlite.js', "require('node:sqlite')"],
  ['src/databaseLocation.js', 'relocateDatabaseDirectory'],
  ['src/database.js', 'getCodeLibraryPage'],
  ['src/database.js', 'NATIVE_MIGRATION_MARKER'],
  ['src/tools/registry.js', 'groupTools'],
  ['renderer/index.html', 'data-page-panel="home"'],
  ['renderer/index.html', 'data-page-panel="tasks"'],
  ['renderer/index.html', 'btnChangeDbLocation'],
  ['renderer/index.html', 'Content-Security-Policy'],
  ['renderer/tool-shell.js', 'buildToolHomeHtml'],
  ['main.js', 'chrome-favorite:prepare'],
  ['main.js', 'local Chrome 123AV account bridge'],
  ['src/chromeFavoriteBridge.js', 'local_chrome_extension'],
  ['chrome-extension/manifest.json', 'MissAV Manager - 123AV 收藏桥'],
  ['chrome-extension/service-worker.js', 'bridge-config-updated'],
  ['src/database.js', 'av123_auto_favorite'],
  ['renderer/index.html', 'data-av123-site-tab="favorite"'],
  ['renderer/index.html', 'chromeFavoriteBridgePanel'],
  ['renderer/index.html', '安装/配对扩展'],
  ['renderer/index.html', 'data-av123-favorite-method="chrome"'],
  ['renderer/index.html', 'data-av123-favorite-method="app"'],
  ['renderer/index.html', 'data-av123-favorite-method="export"'],
  ['renderer/index.html', 'data-favorite-concurrency="1"'],
  ['renderer/app.js', 'prepareAutoFavoriteForRun'],
  ['renderer/app.js', 'AV123_APP_RECOVERY_DELAY_MS = 10000'],
  ['renderer/app.js', 'concurrency: 1'],
  ['renderer/app.js', 'av123_favorite_retry_round_started'],
  ['renderer/app.js', 'prepareChromeFavoriteExtension'],
  ['renderer/app.js', "theme: 'mint'"],
  ['renderer/app.js', "visualPack: 'none'"],
  ['main.js', 'let av123FavoriteQueue = Promise.resolve()'],
  ['main.js', 'return enqueueAv123FavoriteOperation(async () =>'],
  ['src/av123Account.js', 'confirmationWaitMs'],
  ['src/av123Account.js', 'rate_limited'],
  ['src/raindropApi.js', 'MAX_URL_CHECK'],
  ['src/raindropApi.js', 'selectMissavCollectionName'],
  ['src/toolboxFilters.js', 'extractTwitterProfiles'],
  ['src/toolboxFilters.js', 'extractBadNewsLinks'],
  ['src/database.js', 'known_actresses_json'],
  ['src/database.js', 'tool_kind'],
  ['main.js', 'raindrop:ensure-collections'],
  ['src/telegramClient.js', 'syncCursorMessageId'],
  ['src/telegramClient.js', 'listGroupDialogs'],
  ['src/telegramClient.js', 'signInUserWithQrCode'],
  ['src/telegramBot.js', 'TelegramBotService'],
  ['src/telegramBot.js', 'parseBotUpdates'],
  ['src/telegramSource.js', 'parseTelegramExportFiles'],
  ['src/database.js', 'telegram_message_refs'],
  ['src/database.js', 'Telegram 增量来源最多只能选择 5 个群组'],
  ['src/database.js', 'resetAllBusinessData'],
  ['src/database.js', 'bulkUpdateRawCells'],
  ['src/database.js', 'remote_sync_records'],
  ['renderer/app.js', 'database-reset-all'],
  ['renderer/app.js', 'raw-bulk-edit'],
  ['renderer/app.js', 'dbExportRawTableRows'],
  ['renderer/index.html', 'data-page-panel="sources"'],
  ['renderer/index.html', 'data-page-panel="twitter"'],
  ['renderer/index.html', 'data-page-panel="badnews"'],
  ['renderer/index.html', 'TG 内容工具箱'],
  ['renderer/app.js', 'dispatchToolboxMessages'],
  ['renderer/app.js', 'routingTargetForItem'],
  ['renderer/index.html', 'telegramGroupPicker'],
  ['renderer/index.html', 'telegramQrLogin'],
  ['renderer/index.html', 'telegramBotGroupPicker'],
  ['renderer/index.html', '导入一个或多个文件'],
  ['renderer/app.js', 'async function importTextFiles()'],
  ['renderer/app.js', 'multiSelections: true'],
  ['renderer/app.js', 'failedFileCount: failures.length'],
  ['main.js', 'TELEGRAM_BOT_API_PARTITION'],
  ['node_modules\\qrcode\\package.json', '"version": "1.5.4"'],
];

const forbidden = [
  ['src/database.js', "require('sql.js')"],
  ['preload.js', "require('fs')"],
  ['preload.js', "require('path')"],
  ['renderer/index.html', 'Codex 接管'],
  ['renderer/app.js', 'codexTask'],
  ['renderer/index.html', 'data-favorite-concurrency="4"'],
  ['renderer/index.html', 'btnImportTextFiles'],
];

if (!fs.existsSync(packagePath) || !fs.existsSync(exePath)) throw new Error('打包产物不存在');
const archiveFile = file => file.split('/').join(path.sep);
for (const [file, marker] of checks) {
  const present = asar.extractFile(packagePath, archiveFile(file)).toString('utf8').includes(marker);
  process.stdout.write(`${file}: ${present ? 'OK' : `MISSING ${marker}`}\n`);
  if (!present) process.exitCode = 1;
}
for (const [file, marker] of forbidden) {
  const present = asar.extractFile(packagePath, archiveFile(file)).toString('utf8').includes(marker);
  process.stdout.write(`${file}: ${present ? `FORBIDDEN ${marker}` : 'ABSENT OK'}\n`);
  if (present) process.exitCode = 1;
}
const bytes = fs.readFileSync(exePath);
process.stdout.write(JSON.stringify({
  exePath,
  size: bytes.length,
  sha256: crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase(),
}, null, 2));
