const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const account = require('../src/av123Account');
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'missav-av123-account-smoke-'));
app.setPath('userData', path.join(scratchDir, 'user-data'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  const html = `<!doctype html><html><head><title>ABF-356</title></head><body>
    <header><button>2307402078</button></header>
    <form hidden><input type="password" value="never-read"></form>
    <main>
      <h1>ABF-356 — account smoke</h1>
      <button id="save" onclick="this.textContent='已保存'">保存</button>
      <dl><dt>代码</dt><dd>ABF-356</dd></dl>
    </main>
  </body></html>`;
  const fixturePath = path.join(scratchDir, 'account-fixture.html');
  fs.writeFileSync(fixturePath, html, 'utf8');
  await window.loadFile(fixturePath);

  const adapter = {
    navigate: async () => {},
    inspect: () => window.webContents.executeJavaScript(account.buildInspectionScript(), true),
    clickSave: () => window.webContents.executeJavaScript(account.buildSaveClickScript(), true),
    sleep: async () => {},
  };
  const inspected = await adapter.inspect();
  assert.equal(inspected.accountLabel, '2307402078');
  assert.equal(inspected.loggedOut, false);
  const result = await account.runFavoriteAction(adapter, {
    code: 'ABF-356',
    url: 'https://123av.com/cn/v/abf-356',
    pollDelayMs: 0,
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.metadata.accountLabel, '2307402078');
  assert.equal(result.metadata.clickAttempted, true);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#save').textContent`), '已保存');

  const second = await account.runFavoriteAction(adapter, {
    code: 'ABF-356',
    url: 'https://123av.com/cn/v/abf-356',
    pollDelayMs: 0,
  });
  assert.equal(second.status, 'already_saved');
  assert.equal(second.metadata.clickAttempted, false);

  process.stdout.write(JSON.stringify({ first: result.status, second: second.status, accountLabel: result.metadata.accountLabel, scratchDir }));
  window.destroy();
  app.quit();
}

run().catch(error => {
  process.stderr.write(error.stack || error.message);
  app.exit(1);
});
