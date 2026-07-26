const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const coreService = require('../src/coreService');
const packageInfo = require('../package.json');

const projectDir = path.resolve(__dirname, '..');
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'missav-telegram-ui-'));
const screenshotPath = path.join(projectDir, 'artifacts', 'ui-telegram-sources.png');
const mobileScreenshotPath = path.join(projectDir, 'artifacts', 'ui-telegram-sources-mobile.png');
const qrScreenshotPath = path.join(projectDir, 'artifacts', 'ui-telegram-qr-login.png');
const mockQrDataUrl = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="white"/><path d="M30 30h90v90H30zM200 30h90v90h-90zM30 200h90v90H30zM150 150h40v40h-40zM210 160h30v80h-30zM150 230h50v30h-50z" fill="#17111d"/></svg>',
).toString('base64')}`;
let telegramConnected = false;
let telegramBotConnected = false;

function envelope(id, code, sourceType = 'export_json') {
  return {
    sourceType,
    sourceLabel: sourceType === 'api' ? 'Telegram API · 番号收集群' : 'result.json',
    accountKey: '42',
    chatKey: '-1001001',
    messageId: String(id),
    messageDate: `2026-07-22T00:0${id}:00.000Z`,
    editedAt: '',
    text: code,
    links: [],
    contentHash: `content-hash-${id}-${code}`,
    dedupeKey: `telegram:42:-1001001:${id}`,
    codes: [code],
  };
}

app.commandLine.appendSwitch('in-process-gpu');
app.setPath('userData', path.join(scratchDir, 'user-data'));

ipcMain.on('app:get-version-sync', event => {
  event.returnValue = packageInfo.version;
});
ipcMain.on('core:call', (event, payload = {}) => {
  try {
    event.returnValue = {
      ok: true,
      value: coreService.call(String(payload.scope || ''), String(payload.method || ''), payload.args || []),
    };
  } catch (error) {
    event.returnValue = { ok: false, error: error.message || String(error) };
  }
});
ipcMain.handle('app:getPath', (_event, name) => app.getPath(name));
ipcMain.handle('database-location:status', () => ({
  directory: path.join(app.getPath('userData'), 'data'),
  databasePath: path.join(app.getPath('userData'), 'data', 'missav_data.db'),
  configured: false,
}));
ipcMain.handle('database-location:change', () => ({ changed: false, canceled: true }));
ipcMain.handle('logs:append', () => true);
ipcMain.handle('shell:openExternal', () => true);
ipcMain.handle('chrome-favorite:status', () => ({ running: true, connected: false, port: 17831, queued: 0, active: 0 }));
ipcMain.handle('chrome-favorite:prepare', () => ({ running: true, connected: false, port: 17831, pairingCode: `MMCB1:17831:${'a'.repeat(64)}`, extensionPath: path.join(scratchDir, 'chrome-extension') }));
ipcMain.handle('telegram-bot:status', () => ({
  status: telegramBotConnected ? 'ready' : 'disconnected',
  configured: true,
  connected: telegramBotConnected,
  encryptionAvailable: true,
  accountKey: 'bot:9001',
  accountLabel: 'UI Collector (@ui_collector_bot)',
  username: 'ui_collector_bot',
  error: '',
}));
ipcMain.handle('telegram-bot:connect', () => {
  telegramBotConnected = true;
  return {
    status: 'ready',
    configured: true,
    connected: true,
    encryptionAvailable: true,
    accountKey: 'bot:9001',
    accountLabel: 'UI Collector (@ui_collector_bot)',
    username: 'ui_collector_bot',
    error: '',
  };
});
ipcMain.handle('telegram-bot:connect-stored', () => {
  telegramBotConnected = true;
  return {
    status: 'ready',
    configured: true,
    connected: true,
    encryptionAvailable: true,
    accountKey: 'bot:9001',
    accountLabel: 'UI Collector (@ui_collector_bot)',
    username: 'ui_collector_bot',
    error: '',
  };
});
ipcMain.handle('telegram-bot:clear', () => {
  telegramBotConnected = false;
  return { status: 'disconnected', configured: false, connected: false, encryptionAvailable: true };
});
ipcMain.handle('telegram-bot:discover', () => ({
  accountKey: 'bot:9001',
  accountLabel: 'UI Collector (@ui_collector_bot)',
  updateCount: 1,
  lastUpdateId: 50,
  nextOffset: 51,
  groups: [{
    chatKey: '-1005001',
    title: '机器人番号群',
    chatType: 'supergroup',
    username: 'bot_codes_ui',
    latestMessageId: 7,
    latestMessageDate: '2026-07-22T00:07:00.000Z',
  }],
  messageGroups: [],
}));
ipcMain.handle('telegram-bot:updates', () => ({
  accountKey: 'bot:9001',
  accountLabel: 'UI Collector (@ui_collector_bot)',
  updateCount: 1,
  lastUpdateId: 51,
  nextOffset: 52,
  groups: [{
    chatKey: '-1005001',
    title: '机器人番号群',
    chatType: 'supergroup',
    username: 'bot_codes_ui',
    latestMessageId: 8,
    latestMessageDate: '2026-07-22T00:08:00.000Z',
  }],
  messageGroups: [{
    chatKey: '-1005001',
    title: '机器人番号群',
    chatType: 'supergroup',
    username: 'bot_codes_ui',
    latestMessageId: 8,
    latestMessageDate: '2026-07-22T00:08:00.000Z',
    messages: [{
      ...envelope(8, 'MIDV-777', 'bot_api'),
      sourceLabel: 'Telegram Bot · 机器人番号群',
      accountKey: 'bot:9001',
      chatKey: '-1005001',
      dedupeKey: 'telegram:bot:9001:-1005001:8',
    }],
  }],
}));
ipcMain.handle('telegram:status', async () => {
  await new Promise(resolve => setTimeout(resolve, 80));
  return {
    status: telegramConnected ? 'ready' : 'disconnected',
    configured: true,
    connected: telegramConnected,
    encryptionAvailable: true,
    accountKey: '42',
    accountLabel: 'UI Telegram',
    error: '',
  };
});
ipcMain.handle('telegram:network-config', () => ({ mode: 'socks5', host: '127.0.0.1', port: 7890 }));
ipcMain.handle('telegram:network-save', (_event, value) => value);
ipcMain.handle('telegram:network-test', (_event, value) => ({
  ok: true,
  config: value,
  transport: `SOCKS5 ${value.host}:${value.port}`,
  attempted: [`SOCKS5 ${value.host}:${value.port}`],
}));
ipcMain.handle('telegram:connect-stored', () => {
  telegramConnected = true;
  return {
    status: 'ready',
    configured: true,
    connected: true,
    encryptionAvailable: true,
    accountKey: '42',
    accountLabel: 'UI Telegram',
    error: '',
  };
});
ipcMain.handle('telegram:auth-start', () => ({ status: 'waiting_code', configured: false, hint: '验证码已发送到 Telegram 应用' }));
ipcMain.handle('telegram:auth-start-qr', () => {
  telegramConnected = false;
  return {
    status: 'waiting_qr',
    configured: true,
    connected: false,
    qrDataUrl: mockQrDataUrl,
    qrExpiresAt: Date.now() + 30_000,
    hint: '使用已登录的 Telegram 手机端扫码确认',
  };
});
ipcMain.handle('telegram:auth-submit', () => ({ submitted: true }));
ipcMain.handle('telegram:auth-cancel', () => ({ status: 'disconnected', configured: false }));
ipcMain.handle('telegram:logout', () => ({ status: 'disconnected', configured: false }));
ipcMain.handle('telegram:sync-stop', () => true);
ipcMain.handle('telegram:list-groups', () => ({
  accountKey: '42',
  accountLabel: 'UI Telegram',
  groups: [
    {
      chatKey: '-1001001',
      title: '番号收集群',
      chatType: 'supergroup',
      username: 'codes_ui',
      owned: true,
      admin: true,
      archived: false,
      latestMessageId: 2,
      latestMessageDate: '2026-07-22T00:02:00.000Z',
    },
    {
      chatKey: '-1002002',
      title: '番号发布频道',
      chatType: 'channel',
      username: 'channel_ui',
      owned: false,
      admin: false,
      archived: true,
      latestMessageId: 20,
      latestMessageDate: '2026-07-22T01:00:00.000Z',
    },
  ],
}));
ipcMain.handle('telegram:parse-export', () => ({
  sourceKey: 'telegram-export:ui',
  sourceType: 'export_json',
  sourceLabel: 'result.json',
  fileCount: 1,
  messages: [envelope(1, 'SSIS-469'), envelope(2, 'SONE-314')],
  errors: [],
}));
ipcMain.handle('telegram:sync-group', () => ({
  sourceKey: 'telegram-api:42:group:-1001001',
  sourceType: 'api_group',
  sourceLabel: '番号收集群',
  accountKey: '42',
  accountLabel: 'UI Telegram',
  chatKey: '-1001001',
  chatType: 'supergroup',
  isSelected: true,
  baselineMessageId: 2,
  checkpointMessageId: 3,
  checkpointComplete: true,
  syncCursorMessageId: 0,
  syncTargetMessageId: 0,
  hasMore: false,
  stopped: false,
  messages: [envelope(1, 'SSIS-469', 'api'), envelope(3, 'ABF-354', 'api')],
  errors: [],
}));

async function run() {
  await app.whenReady();
  await coreService.init({
    dbDir: path.join(app.getPath('userData'), 'data'),
    applicationDir: projectDir,
  });
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  const window = new BrowserWindow({
    width: 1320,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(projectDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await window.loadFile(path.join(projectDir, 'renderer', 'index.html'));
  await new Promise(resolve => setTimeout(resolve, 700));
  const qrResult = await window.webContents.executeJavaScript(`(async () => {
    for (let i = 0; i < 60 && !state.dbReady; i++) await api.sleep(50);
    const autoConnected = state.telegram.auth.status === 'ready';
    switchPage('sources');
    switchTelegramPanel('api');
    state.telegram.auth = { ...state.telegram.auth, status: 'expired', configured: true, connected: false };
    renderTelegramSource();
    await startTelegramQrAuthorization();
    return {
      autoConnected,
      status: state.telegram.auth.status,
      qrVisible: !DOM.telegramQrLogin?.hidden,
      qrHasImage: String(DOM.telegramQrImage?.src || '').startsWith('data:image/svg+xml'),
      countdown: DOM.telegramQrCountdown?.textContent || '',
      phoneFallbackClosed: !DOM.telegramPhoneFallback?.open,
    };
  })()`);
  window.showInactive();
  await new Promise(resolve => setTimeout(resolve, 150));
  const qrImage = await window.webContents.capturePage();
  fs.writeFileSync(qrScreenshotPath, qrImage.toPNG());
  await window.webContents.executeJavaScript(`(async () => {
    await cancelTelegramAuthorization();
    await connectStoredTelegram({ silent: true, loadGroups: false });
  })()`);
  const result = await window.webContents.executeJavaScript(`(async () => {
    switchPage('sources');
    await refreshTelegramSourcePage();
    switchTelegramPanel('bot');
    await discoverTelegramBotGroups();
    state.telegram.bot.selectedGroupKeys = new Set(['-1005001']);
    await saveTelegramBotGroupSources();
    await syncTelegramBotGroups();
    const botCodes = [...state.telegram.preview.codes];
    switchTelegramPanel('export');
    await importTelegramExportPaths(['mock-result.json']);
    const firstCodes = [...state.telegram.preview.codes];
    await importTelegramExportPaths(['mock-result.json']);
    const repeatedCodes = [...state.telegram.preview.codes];
    switchTelegramPanel('api');
    await loadTelegramGroups();
    state.telegram.selectedGroupKeys = new Set(['-1001001']);
    await saveTelegramGroupSources();
    const botSourceKey = state.telegram.bot.groupSources[0]?.sourceKey || '';
    const apiSourceKey = state.telegram.groupSources[0]?.sourceKey || '';
    const staleSource = api.dbUpsertTelegramSource({
      sourceKey: 'telegram-api:42:group:-1009999',
      sourceType: 'api_group',
      accountKey: '42',
      accountLabel: 'UI Telegram',
      sourceLabel: '已退出的测试群',
      chatKey: '-1009999',
      chatType: 'supergroup',
      isSelected: true,
      status: 'ready',
    });
    state.telegram.groupSources = [...state.telegram.groupSources, { ...api.dbGetTelegramSource(staleSource.sourceKey), unavailable: true }];
    renderTelegramGroups();
    const staleRemoveVisible = Boolean(DOM.telegramSelectedSources?.querySelector('[data-telegram-remove-group]'));
    const originalConfirm = window.confirm;
    window.confirm = () => true;
    await removeTelegramGroupBinding(staleSource.sourceKey, 'api_group');
    window.confirm = originalConfirm;
    const staleSourceRemoved = api.dbGetTelegramGroupSources('42').every(source => source.sourceKey !== staleSource.sourceKey);
    const selectSourcesWithPicker = (select, kind, sourceKeys) => {
      setToolboxBinding(kind, []);
      const picker = select._groupPicker;
      picker.trigger.click();
      picker.search.value = '机器人';
      picker.search.dispatchEvent(new Event('input', { bubbles: true }));
      const searchVisible = picker.list.querySelectorAll('[data-group-source-key]').length;
      picker.search.value = '';
      picker.search.dispatchEvent(new Event('input', { bubbles: true }));
      sourceKeys.forEach(sourceKey => {
        const option = [...picker.list.querySelectorAll('[data-group-source-key]')]
          .find(node => node.dataset.groupSourceKey === sourceKey);
        option?.click();
      });
      picker.trigger.click();
      return searchVisible;
    };
    const twitterPickerSearchVisible = selectSourcesWithPicker(
      DOM.twitterGroupBinding,
      'twitter',
      [botSourceKey, apiSourceKey],
    );
    const haijiaoPickerSearchVisible = selectSourcesWithPicker(
      DOM.haijiaoGroupBinding,
      'haijiao',
      [botSourceKey, apiSourceKey],
    );
    dispatchToolboxMessages({
      sourceKey: botSourceKey,
      sourceType: 'bot_group',
      sourceLabel: 'UI Bot 来源',
      messages: [{
        text: '#multi_bot_user https://www.haijiaolove.xyz/hjsz/127766.html?from=bot https://t.me/jisou',
        links: [],
        contentHash: 'multi-binding-bot',
      }],
    });
    dispatchToolboxMessages({
      sourceKey: apiSourceKey,
      sourceType: 'api_group',
      sourceLabel: 'UI API 来源',
      messages: [{
        text: '#multi_api_user https://haijiaolove.xyz/hjyc/115213.html#share https://www.haijiaolove.xyz/original',
        links: [],
        contentHash: 'multi-binding-api',
      }],
    });
    await syncTelegramGroups();
    const apiCodes = [...state.telegram.preview.codes];
    const historyCount = state.telegram.history.length;
    useTelegramCodes();
    return {
      dbReady: state.dbReady,
      navButtons: document.querySelectorAll('.nav-btn[data-page]').length,
      firstCodes,
      repeatedCodes,
      botCodes,
      apiCodes,
      historyCount,
      activePage: state.activePage,
      inputCodes: [...state.inputCodes],
      authStatus: state.telegram.auth.status,
      accountSummary: DOM.telegramAccountSummary?.textContent || '',
      availableChannels: state.telegram.availableGroups.filter(group => group.chatType === 'channel').length,
      sourceLimitText: DOM.telegramGroupSelectionCount?.textContent || '',
      proxyMode: DOM.telegramNetworkMode?.value || '',
      proxyHost: DOM.telegramProxyHost?.value || '',
      proxyPort: DOM.telegramProxyPort?.value || '',
      sourcePanels: document.querySelectorAll('[data-telegram-panel-content]').length,
      selectedGroups: state.telegram.groupSources.length,
      selectedBotGroups: state.telegram.bot.groupSources.length,
      telegramRemoveButtons: document.querySelectorAll('[data-telegram-remove-group]').length,
      staleRemoveVisible,
      staleSourceRemoved,
      botAuthStatus: state.telegram.bot.auth.status,
      previewReadonly: DOM.telegramCodePreview?.readOnly,
      markReadControlPresent: Boolean(DOM.telegramMarkReadAfterSync),
      markReadDefaultOff: DOM.telegramMarkReadAfterSync?.checked === false,
      twitterBindingCount: state.toolboxBindings.twitter.length,
      twitterBindingMultiple: Boolean(DOM.twitterGroupBinding?.multiple),
      twitterSelectedOptions: [...DOM.twitterGroupBinding?.selectedOptions || []].filter(option => option.value).length,
      twitterPickerSearchVisible,
      twitterPickerSummary: DOM.twitterGroupBinding?._groupPicker?.trigger?.textContent || '',
      twitterBoundProfiles: state.toolbox.twitter.results.map(row => row.name),
      haijiaoBindingCount: state.toolboxBindings.haijiao.length,
      haijiaoBindingMultiple: Boolean(DOM.haijiaoGroupBinding?.multiple),
      haijiaoSelectedOptions: [...DOM.haijiaoGroupBinding?.selectedOptions || []].filter(option => option.value).length,
      haijiaoPickerSearchVisible,
      haijiaoBoundLinks: [...state.toolbox.haijiao.results],
      groupPickerShells: document.querySelectorAll('.group-picker-shell').length,
    };
  })()`);
  window.showInactive();
  await window.webContents.executeJavaScript(`switchPage('sources'); switchTelegramPanel('bot'); if (DOM.toastContainer) DOM.toastContainer.innerHTML = ''`);
  await new Promise(resolve => setTimeout(resolve, 250));
  const image = await window.webContents.capturePage();
  fs.writeFileSync(screenshotPath, image.toPNG());
  window.setSize(416, 820);
  await new Promise(resolve => setTimeout(resolve, 250));
  const mobileResult = await window.webContents.executeJavaScript(`(() => {
    switchTool('twitter');
    refreshToolboxGroupOptions();
    const picker = DOM.twitterGroupBinding._groupPicker;
    picker.trigger.click();
    const pickerRect = picker.popover.getBoundingClientRect();
    const pickerPosition = getComputedStyle(picker.popover).position;
    picker.trigger.click();
    switchPage('sources');
    switchTelegramPanel('bot');
    const layout = document.querySelector('.telegram-source-layout');
    const visiblePanel = document.querySelector('[data-telegram-panel-content="bot"]');
    return {
      width: window.innerWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      layoutColumns: getComputedStyle(layout).gridTemplateColumns.split(' ').length,
      sourceNavButtons: document.querySelectorAll('[data-telegram-panel]').length,
      panelWidth: visiblePanel?.getBoundingClientRect().width || 0,
      metricColumns: getComputedStyle(document.querySelector('.telegram-result-metrics')).gridTemplateColumns.split(' ').length,
      pickerPosition,
      pickerWidth: pickerRect.width,
      pickerLeft: pickerRect.left,
      pickerRight: pickerRect.right,
    };
  })()`);
  const mobileImage = await window.webContents.capturePage();
  fs.writeFileSync(mobileScreenshotPath, mobileImage.toPNG());

  if (!result.dbReady
    || result.navButtons !== 5
    || result.firstCodes.join(',') !== 'SSIS-469,SONE-314'
    || result.repeatedCodes.length !== 0
    || result.botCodes.join(',') !== 'MIDV-777'
    || result.apiCodes.join(',') !== 'ABF-354'
    || result.historyCount !== 4
    || result.activePage !== 'process'
    || result.inputCodes.join(',') !== 'ABF-354'
    || result.authStatus !== 'ready'
    || !result.accountSummary.includes('UI Telegram')
    || result.availableChannels !== 1
    || !result.sourceLimitText.includes('/ 100')
    || result.proxyMode !== 'socks5'
    || result.proxyHost !== '127.0.0.1'
    || result.proxyPort !== '7890'
    || result.sourcePanels !== 3
    || result.selectedGroups !== 1
    || result.selectedBotGroups !== 1
    || result.telegramRemoveButtons !== 2
    || !result.staleRemoveVisible
    || !result.staleSourceRemoved
    || result.botAuthStatus !== 'ready'
    || !result.previewReadonly
    || !result.markReadControlPresent
    || !result.markReadDefaultOff
    || result.twitterBindingCount !== 2
    || !result.twitterBindingMultiple
    || result.twitterSelectedOptions !== 2
    || result.twitterPickerSearchVisible !== 1
    || !result.twitterPickerSummary.includes('已选择 2 个来源')
    || result.twitterBoundProfiles.join(',') !== 'multi_bot_user,multi_api_user'
    || result.haijiaoBindingCount !== 2
    || !result.haijiaoBindingMultiple
    || result.haijiaoSelectedOptions !== 2
    || result.haijiaoPickerSearchVisible !== 1
    || result.groupPickerShells !== 4
    || result.haijiaoBoundLinks.join(',') !== 'https://www.haijiaolove.xyz/hjsz/127766.html,https://www.haijiaolove.xyz/hjyc/115213.html') {
    throw new Error(`Telegram source UI assertion failed: ${JSON.stringify(result)}`);
  }
  if (!qrResult.autoConnected
    || qrResult.status !== 'waiting_qr'
    || !qrResult.qrVisible
    || !qrResult.qrHasImage
    || !qrResult.countdown.includes('自动刷新')
    || !qrResult.phoneFallbackClosed) {
    throw new Error(`Telegram QR UI assertion failed: ${JSON.stringify(qrResult)}`);
  }
  if (mobileResult.width > 416
    || mobileResult.pageScrollWidth > 417
    || mobileResult.layoutColumns !== 1
    || mobileResult.sourceNavButtons !== 3
    || mobileResult.panelWidth < 340
    || mobileResult.metricColumns !== 2
    || mobileResult.pickerPosition !== 'fixed'
    || mobileResult.pickerWidth > 393
    || mobileResult.pickerLeft < 11
    || mobileResult.pickerRight > 405) {
    throw new Error(`Telegram source mobile assertion failed: ${JSON.stringify(mobileResult)}`);
  }
  process.stdout.write(JSON.stringify({
    result,
    qrResult,
    mobileResult,
    screenshotPath,
    qrScreenshotPath,
    mobileScreenshotPath,
    scratchDir,
  }, null, 2));
  await window.close();
  coreService.close();
  app.quit();
}

run().catch(error => {
  process.stderr.write(error.stack || error.message);
  app.exit(1);
});
