const { app, BrowserWindow, ipcMain, dialog, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

// ── 全局错误处理 ──────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[Main Process Error]', err.message);
  console.error(err.stack);
});

// ── Window ──────────────────────────────────────────────
let mainWindow;

function createWindow() {
  console.log('[Main] Creating window...');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 680,
    title: 'MissAV Manager',
    backgroundColor: '#0f0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  console.log('[Main] Loading renderer...');
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 监听渲染进程错误
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('[Renderer Load Error]', errorCode, errorDescription, validatedURL);
  });

  mainWindow.webContents.on('console-message', (event, level, message) => {
    console.log(`[Renderer] ${message}`);
  });

  mainWindow.once('ready-to-show', () => {
    console.log('[Main] Window ready to show');
    mainWindow.show();
    if (process.argv.includes('--dev')) {
      mainWindow.webContents.openDevTools();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── IPC: File Dialogs ───────────────────────────────────
ipcMain.handle('dialog:openFile', async (_event, options) => {
  const properties = ['openFile'];
  if (options?.multiSelections) properties.push('multiSelections');

  const result = await dialog.showOpenDialog(mainWindow, {
    title: options?.title || '选择文件',
    filters: options?.filters || [{ name: 'CSV 文件', extensions: ['csv'] }],
    properties,
  });
  if (result.canceled || !result.filePaths.length) return null;
  return options?.multiSelections ? result.filePaths : result.filePaths[0];
});

ipcMain.handle('dialog:openDirectory', async (_event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options?.title || '选择文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ── IPC: File System ────────────────────────────────────
ipcMain.handle('fs:readFile', async (_event, filePath, encoding = 'utf-8') => {
  try {
    return fs.readFileSync(filePath, encoding);
  } catch (err) {
    throw new Error(`读取文件失败: ${err.message}`);
  }
});

ipcMain.handle('fs:writeFile', async (_event, filePath, content, encoding = 'utf-8') => {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, encoding);
    return true;
  } catch (err) {
    throw new Error(`写入文件失败: ${err.message}`);
  }
});

ipcMain.handle('fs:createDirectory', async (_event, dirPath) => {
  try {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    return true;
  } catch (err) {
    throw new Error(`创建文件夹失败: ${err.message}`);
  }
});

ipcMain.handle('fs:exists', async (_event, filePath) => {
  return fs.existsSync(filePath);
});

ipcMain.handle('fs:readDir', async (_event, dirPath) => {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true }).map(d => ({
      name: d.name,
      isDirectory: d.isDirectory(),
      isFile: d.isFile(),
    }));
  } catch {
    return [];
  }
});

// ── IPC: Network Fetch ──────────────────────────────────
function defaultFetchHeaders(extraHeaders = {}) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Referer': 'https://missav.ai/',
    ...extraHeaders,
  };
}

async function fetchWithElectronNet(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 15000);

  try {
    const response = await net.fetch(url, {
      method: options.method || 'GET',
      headers: defaultFetchHeaders(options.headers || {}),
      redirect: 'follow',
      signal: controller.signal,
    });

    const body = await response.text();
    const headers = {};
    response.headers.forEach((value, key) => { headers[key] = value; });

    return {
      redirected: response.url && response.url !== url,
      redirectUrl: response.url || url,
      statusCode: response.status,
      headers,
      body,
      finalUrl: response.url || url,
      transport: 'electron-net',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function fetchWithNode(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;

    const fetchOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: defaultFetchHeaders(options.headers || {}),
      timeout: options.timeout || 15000,
    };

    const req = transport.request(fetchOptions, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        resolve({ redirected: true, redirectUrl, statusCode: res.statusCode, transport: 'node' });
        return;
      }

      let chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve({
          redirected: false,
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          finalUrl: url,
          transport: 'node',
        });
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`请求超时 (${fetchOptions.timeout}ms)`));
    });

    req.end();
  });
}

ipcMain.handle('net:fetch', async (_event, url, options = {}) => {
  try {
    return await fetchWithElectronNet(url, options);
  } catch (electronErr) {
    try {
      return await fetchWithNode(url, options);
    } catch (nodeErr) {
      return {
        redirected: false,
        statusCode: 0,
        headers: {},
        body: '',
        finalUrl: url,
        error: `Electron net: ${electronErr.message}; Node fallback: ${nodeErr.message}`,
        transport: 'failed',
      };
    }
  }
});
// ── IPC: Open External ──────────────────────────────────
ipcMain.handle('shell:openExternal', async (_event, url) => {
  return shell.openExternal(url);
});

// ── IPC: App Info ────────────────────────────────────────
ipcMain.handle('app:getPath', async (_event, name) => {
  return app.getPath(name);
});

