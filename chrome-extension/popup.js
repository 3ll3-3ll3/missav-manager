const input = document.querySelector('#pairingCode');
const statusNode = document.querySelector('#status');
const connectButton = document.querySelector('#connect');

function showStatus(text, kind = 'idle') {
  statusNode.textContent = text;
  statusNode.dataset.kind = kind;
}

function parsePairingCode(value) {
  const match = String(value || '').trim().match(/^MMCB1:(\d{2,5}):([a-f0-9]{64})$/i);
  if (!match) throw new Error('配对码格式不正确');
  const port = Number(match[1]);
  if (port < 1024 || port > 65535) throw new Error('配对端口无效');
  return { port, token: match[2].toLowerCase() };
}

connectButton.addEventListener('click', async () => {
  try {
    connectButton.disabled = true;
    const config = parsePairingCode(input.value);
    await chrome.storage.local.set({ bridgeConfig: config, bridgeLastError: '' });
    await chrome.runtime.sendMessage({ type: 'bridge-config-updated' });
    input.value = '';
    showStatus('已保存，正在连接本地 APP。可关闭此窗口。', 'ok');
  } catch (error) {
    showStatus(error.message || String(error), 'error');
  } finally {
    connectButton.disabled = false;
  }
});

chrome.runtime.sendMessage({ type: 'bridge-status' }).then(status => {
  showStatus(status?.configured ? '已配对；打开 APP 后会自动连接。' : '尚未配对', status?.configured ? 'ok' : 'idle');
}).catch(() => showStatus('扩展后台暂未就绪，请重开此窗口', 'error'));
