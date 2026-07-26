const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { PromisedNetSockets, PromisedWebSockets } = require('teleproto/extensions');
const net = require('node:net');
const QRCode = require('qrcode');
const { telegramApiMessagesToEnvelopes } = require('./telegramSource');

const LOCAL_SOCKS_PORTS = Object.freeze([7890, 7891, 1080, 10808]);
const TELEGRAM_NETWORK_MODES = new Set(['auto', 'socks5', 'websocket', 'direct']);

function normalizeTelegramNetworkConfig(value = {}) {
  const mode = TELEGRAM_NETWORK_MODES.has(String(value.mode || '').trim())
    ? String(value.mode).trim()
    : 'auto';
  const host = String(value.host || '127.0.0.1').trim();
  const port = Math.trunc(Number(value.port || 7890));
  if (!host || host.length > 253 || !/^[A-Za-z0-9_.:-]+$/.test(host)) {
    throw new Error('代理主机格式无效；Clash 本机代理通常填写 127.0.0.1');
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('代理端口必须是 1–65535 的整数');
  }
  return { mode, host, port };
}

function localPortIsOpen(host, port, timeoutMs = 180) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: String(host), port: Number(port) });
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(Boolean(value));
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function socksTransportCandidate(host, port) {
  return {
    id: `socks5-${host}-${port}`,
    label: `SOCKS5 ${host}:${port}`,
    clientOptions: {
      networkSocket: PromisedNetSockets,
      proxy: { socksType: 5, ip: host, port },
    },
  };
}

async function defaultTelegramTransportCandidates(value = {}) {
  const config = normalizeTelegramNetworkConfig(value);
  if (config.mode === 'socks5') return [socksTransportCandidate(config.host, config.port)];
  if (config.mode === 'websocket') return [{
    id: 'websocket',
    label: 'Telegram WebSocket',
    clientOptions: { networkSocket: PromisedWebSockets },
  }];
  if (config.mode === 'direct') return [{
    id: 'tcp',
    label: 'Telegram 直连',
    clientOptions: { networkSocket: PromisedNetSockets },
  }];

  const endpoints = [
    { host: config.host, port: config.port },
    ...LOCAL_SOCKS_PORTS.map(port => ({ host: '127.0.0.1', port })),
  ].filter((endpoint, index, all) => all.findIndex(candidate => (
    candidate.host === endpoint.host && candidate.port === endpoint.port
  )) === index);
  const openEndpoints = (await Promise.all(endpoints.map(async endpoint => (
    (await localPortIsOpen(endpoint.host, endpoint.port)) ? endpoint : null
  )))).filter(Boolean);
  return [
    ...openEndpoints.map(endpoint => socksTransportCandidate(endpoint.host, endpoint.port)),
    {
      id: 'websocket',
      label: 'Telegram WebSocket',
      clientOptions: {
        networkSocket: PromisedWebSockets,
      },
    },
    {
      id: 'tcp',
      label: 'Telegram 直连',
      clientOptions: { networkSocket: PromisedNetSockets },
    },
  ];
}

function authorizationCancelledError() {
  const error = new Error('Telegram 授权已取消');
  error.name = 'AbortError';
  return error;
}

function cleanTelegramError(error) {
  const message = String(error?.errorMessage || error?.message || error || 'Telegram 操作失败')
    .replace(/tg:\/\/login\?token=[A-Za-z0-9_-]+/gi, 'tg://login?token=[credential]')
    .replace(/\+?\d[\d\s-]{7,}/g, '[phone]')
    .replace(/\b[a-f0-9]{32,64}\b/gi, '[credential]')
    .replace(/[A-Za-z0-9+/=_-]{80,}/g, '[credential]')
    .slice(0, 1000);
  const seconds = Math.max(0, Number(error?.seconds || message.match(/FLOOD_(?:PREMIUM_)?WAIT_(\d+)/i)?.[1]) || 0);
  const code = String(error?.errorMessage || error?.code || '')
    .replace(/tg:\/\/login\?token=[A-Za-z0-9_-]+/gi, 'QR_TOKEN_REDACTED')
    .replace(/\b[a-f0-9]{32,64}\b/gi, '[credential]')
    .slice(0, 120);
  return { message, seconds, code };
}

function telegramQrExpiryMillis(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return Date.now() + 30_000;
  if (numeric > 1e12) return Math.round(numeric);
  if (numeric > 1e9) return Math.round(numeric * 1000);
  return Date.now() + Math.max(1, numeric) * 1000;
}

function isAuthorizationCancelled(error) {
  return error?.name === 'AbortError'
    || /AUTH_USER_CANCEL|QR login aborted|授权已取消/i.test(String(error?.message || error || ''));
}

function accountLabel(user) {
  const name = [user?.firstName, user?.lastName].map(value => String(value || '').trim()).filter(Boolean).join(' ');
  const username = String(user?.username || '').trim();
  return name || (username ? `@${username}` : '') || `Telegram ${String(user?.id || '')}`.trim();
}

function normalizeTelegramDate(value) {
  const millis = value instanceof Date
    ? value.getTime()
    : Number(value || 0) * (Number(value || 0) > 1e12 ? 1 : 1000);
  if (!Number.isFinite(millis) || millis <= 0) return '';
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

class TelegramUserService {
  constructor(options = {}) {
    this.createClient = options.createClient || ((session, apiId, apiHash, clientOptions) =>
      new TelegramClient(new StringSession(session || ''), apiId, apiHash, clientOptions));
    this.readSecret = options.readSecret || (() => null);
    this.writeSecret = options.writeSecret || (() => {});
    this.clearSecret = options.clearSecret || (() => {});
    this.emitState = options.emitState || (() => {});
    this.log = options.log || (() => {});
    this.getTransportCandidates = options.getTransportCandidates || defaultTelegramTransportCandidates;
    this.readNetworkConfig = options.readNetworkConfig || (() => normalizeTelegramNetworkConfig());
    this.renderQrCode = options.renderQrCode || (value => QRCode.toDataURL(value, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320,
      color: { dark: '#17111d', light: '#ffffff' },
    }));
    this.client = null;
    this.secret = null;
    this.state = { status: 'disconnected', configured: false, accountKey: '', accountLabel: '', error: '', transport: '' };
    this.authWaiter = null;
    this.authPromise = null;
    this.authAbortController = null;
    this.syncStopRequested = false;
    this.groupPeers = new Map();
  }

  publicState(patch = {}) {
    this.state = { ...this.state, ...patch };
    const safe = {
      status: this.state.status,
      configured: Boolean(this.state.configured),
      connected: this.state.status === 'ready',
      accountKey: String(this.state.accountKey || ''),
      accountLabel: String(this.state.accountLabel || ''),
      error: String(this.state.error || ''),
      transport: String(this.state.transport || ''),
      waitSeconds: Number(this.state.waitSeconds || 0),
      hint: String(this.state.hint || ''),
      siteKey: String(this.state.siteKey || ''),
      qrDataUrl: this.state.status === 'waiting_qr' ? String(this.state.qrDataUrl || '') : '',
      qrExpiresAt: this.state.status === 'waiting_qr' ? Number(this.state.qrExpiresAt || 0) : 0,
    };
    this.emitState(safe);
    return safe;
  }

  loadSecret() {
    if (this.secret) return this.secret;
    try {
      const secret = this.readSecret();
      if (secret && Number(secret.apiId) > 0 && secret.apiHash && secret.session) this.secret = secret;
    } catch {}
    return this.secret;
  }

  status() {
    const secret = this.loadSecret();
    return this.publicState({
      configured: Boolean(secret),
      accountKey: secret?.accountKey || this.state.accountKey || '',
      accountLabel: secret?.accountLabel || this.state.accountLabel || '',
    });
  }

  makeClient(secret, transport = {}) {
    return this.createClient(secret.session || '', Number(secret.apiId), String(secret.apiHash), {
      connectionRetries: 1,
      requestRetries: 3,
      autoReconnect: true,
      floodSleepThreshold: 60,
      timeout: 10,
      ...(transport.clientOptions || {}),
    });
  }

  networkConfig() {
    return normalizeTelegramNetworkConfig(this.readNetworkConfig());
  }

  async connectWithFallback(secret, options = {}) {
    const candidates = await this.getTransportCandidates(this.networkConfig());
    const attempted = [];
    let lastError = null;
    for (const candidate of candidates) {
      if (options.signal?.aborted) throw authorizationCancelledError();
      const client = this.makeClient(secret, candidate);
      this.client = client;
      attempted.push(candidate.label);
      this.publicState({
        status: 'connecting',
        error: '',
        transport: candidate.label,
        hint: `正在通过${candidate.label}连接`,
      });
      this.log('debug', 'telegram_transport_attempt', { transport: candidate.id });
      try {
        await client.connect();
        if (options.signal?.aborted) throw authorizationCancelledError();
        this.log('info', 'telegram_transport_connected', { transport: candidate.id });
        return client;
      } catch (error) {
        try { await client.disconnect(); } catch {}
        if (this.client === client) this.client = null;
        if (isAuthorizationCancelled(error) || options.signal?.aborted) throw authorizationCancelledError();
        lastError = error;
        this.log('warn', 'telegram_transport_failed', {
          transport: candidate.id,
          ...cleanTelegramError(error),
        });
      }
    }
    const clean = cleanTelegramError(lastError);
    const error = new Error(`无法连接 Telegram 网络（已尝试：${attempted.join('、') || '无可用通道'}）。请检查代理/VPN 配置后重试。最后错误：${clean.message}`);
    error.code = 'TELEGRAM_NETWORK_UNREACHABLE';
    throw error;
  }

  async testNetworkConfig(value = {}) {
    const config = normalizeTelegramNetworkConfig(value);
    const candidates = await this.getTransportCandidates(config);
    const attempted = [];
    let lastError = null;
    for (const candidate of candidates) {
      const client = this.makeClient({
        apiId: 1,
        apiHash: '00000000000000000000000000000000',
        session: '',
      }, candidate);
      attempted.push(candidate.label);
      try {
        await client.connect();
        try { await client.disconnect(); } catch {}
        this.log('info', 'telegram_network_test_succeeded', { transport: candidate.id });
        return { ok: true, config, transport: candidate.label, attempted };
      } catch (error) {
        lastError = error;
        try { await client.disconnect(); } catch {}
        this.log('warn', 'telegram_network_test_failed', {
          transport: candidate.id,
          ...cleanTelegramError(error),
        });
      }
    }
    const clean = cleanTelegramError(lastError);
    throw new Error(`Telegram 代理测试失败：${clean.message}`);
  }

  async connectStored() {
    const secret = this.loadSecret();
    if (!secret) return this.publicState({ status: 'disconnected', configured: false, error: '' });
    if (this.client && this.state.status === 'ready') return this.status();
    this.publicState({ status: 'connecting', configured: true, error: '' });
    try {
      const client = await this.connectWithFallback(secret);
      if (!(await client.checkAuthorization())) {
        try { await client.disconnect(); } catch {}
        this.client = null;
        return this.publicState({ status: 'expired', configured: true, error: 'Telegram 会话已失效，请重新登录' });
      }
      const user = await client.getMe();
      this.client = client;
      this.groupPeers.clear();
      this.secret = {
        ...secret,
        session: String(client.session?.save?.() || secret.session || ''),
        accountKey: String(user?.id || secret.accountKey || ''),
        accountLabel: accountLabel(user) || secret.accountLabel || '',
      };
      this.writeSecret(this.secret);
      return this.publicState({
        status: 'ready',
        configured: true,
        accountKey: this.secret.accountKey,
        accountLabel: this.secret.accountLabel,
        error: '',
        hint: '',
      });
    } catch (error) {
      const clean = cleanTelegramError(error);
      this.log('error', 'telegram_session_connect_failed', clean);
      this.client = null;
      return this.publicState({ status: 'error', configured: true, error: clean.message, waitSeconds: clean.seconds });
    }
  }

  requestAuthValue(kind, metadata = {}) {
    if (this.authWaiter) {
      this.authWaiter.reject(new Error('Telegram 授权流程状态冲突'));
      this.authWaiter = null;
    }
    this.publicState({
      status: `waiting_${kind}`,
      configured: false,
      error: '',
      hint: String(metadata.hint || ''),
      siteKey: String(metadata.siteKey || ''),
    });
    return new Promise((resolve, reject) => {
      this.authWaiter = { kind, resolve, reject };
    });
  }

  submitAuthValue(kind, value) {
    const waiter = this.authWaiter;
    if (!waiter || waiter.kind !== String(kind || '')) throw new Error('当前授权步骤与提交内容不匹配');
    const cleaned = String(value || '').trim();
    if (!cleaned) throw new Error('请输入当前授权步骤所需内容');
    this.authWaiter = null;
    waiter.resolve(cleaned);
    this.publicState({ status: 'authorizing', error: '', hint: '', siteKey: '' });
    return true;
  }

  startAuthorization(options = {}) {
    if (this.authPromise) throw new Error('Telegram 授权正在进行');
    const suppliedApiId = String(options.apiId || '').trim();
    const suppliedApiHash = String(options.apiHash || '').trim();
    const saved = !suppliedApiId && !suppliedApiHash ? this.loadSecret() : null;
    const apiId = Number(saved?.apiId || suppliedApiId);
    const apiHash = String(saved?.apiHash || suppliedApiHash).trim();
    const phoneNumber = String(options.phoneNumber || '').trim();
    if (!Number.isSafeInteger(apiId) || apiId <= 0) throw new Error('api_id 必须是正整数');
    if (!/^[a-f0-9]{20,128}$/i.test(apiHash)) throw new Error('api_hash 格式无效');
    if (!/^\+?\d{7,20}$/.test(phoneNumber.replace(/[\s()-]/g, ''))) throw new Error('手机号格式无效');
    if (this.client) {
      try { void this.client.disconnect(); } catch {}
      this.client = null;
    }
    this.groupPeers.clear();
    const pendingSecret = { apiId, apiHash, session: '', accountKey: '', accountLabel: '' };
    const controller = new AbortController();
    let client = null;
    this.authAbortController = controller;
    this.publicState({
      status: 'connecting',
      configured: false,
      error: '',
      accountKey: '',
      accountLabel: '',
      qrDataUrl: '',
      qrExpiresAt: 0,
    });
    this.authPromise = (async () => {
      try {
        client = await this.connectWithFallback(pendingSecret, { signal: controller.signal });
        await client.start({
          phoneNumber,
          phoneCode: async isCodeViaApp => this.requestAuthValue('code', { hint: isCodeViaApp ? '验证码已发送到 Telegram 应用' : '请输入 Telegram 验证码' }),
          password: async hint => this.requestAuthValue('password', { hint: hint || '请输入两步验证密码' }),
          emailAddress: async () => this.requestAuthValue('email', { hint: 'Telegram 要求设置或确认邮箱' }),
          emailVerification: async metadata => ({
            type: 'code',
            code: await this.requestAuthValue('email_code', { hint: metadata?.emailPattern || '请输入邮箱验证码' }),
          }),
          reCaptchaCallback: async siteKey => this.requestAuthValue('recaptcha', { siteKey, hint: '需要完成 Telegram reCAPTCHA' }),
          onError: error => {
            const clean = cleanTelegramError(error);
            this.log('warn', 'telegram_auth_step_error', clean);
            this.publicState({ error: clean.message, waitSeconds: clean.seconds });
            return false;
          },
        });
        const user = await client.getMe();
        const session = String(client.session?.save?.() || '');
        if (!session) throw new Error('Telegram 会话创建失败');
        this.secret = {
          apiId,
          apiHash,
          session,
          accountKey: String(user?.id || ''),
          accountLabel: accountLabel(user),
        };
        this.writeSecret(this.secret);
        this.log('info', 'telegram_auth_ready', {
          accountKey: this.secret.accountKey,
          accountLabel: this.secret.accountLabel,
        });
        return this.publicState({
          status: 'ready',
          configured: true,
          accountKey: this.secret.accountKey,
          accountLabel: this.secret.accountLabel,
          error: '',
          waitSeconds: 0,
          hint: '',
          siteKey: '',
        });
      } catch (error) {
        if (isAuthorizationCancelled(error)) {
          this.log('info', 'telegram_auth_cancelled', { method: 'phone' });
          try { await client?.disconnect(); } catch {}
          this.client = null;
          return this.publicState({ status: 'disconnected', configured: Boolean(this.loadSecret()), error: '', waitSeconds: 0 });
        }
        const clean = cleanTelegramError(error);
        this.log('error', 'telegram_auth_failed', clean);
        try { await client?.disconnect(); } catch {}
        this.client = null;
        return this.publicState({ status: 'error', configured: false, error: clean.message, waitSeconds: clean.seconds });
      } finally {
        this.authPromise = null;
        this.authWaiter = null;
        this.authAbortController = null;
      }
    })();
    return this.status();
  }

  startQrAuthorization(options = {}) {
    if (this.authPromise) throw new Error('Telegram 授权正在进行');
    const suppliedApiId = String(options.apiId || '').trim();
    const suppliedApiHash = String(options.apiHash || '').trim();
    const saved = !suppliedApiId && !suppliedApiHash ? this.loadSecret() : null;
    const apiId = Number(saved?.apiId || suppliedApiId);
    const apiHash = String(saved?.apiHash || suppliedApiHash).trim();
    if (!Number.isSafeInteger(apiId) || apiId <= 0) throw new Error('api_id 必须是正整数');
    if (!/^[a-f0-9]{20,128}$/i.test(apiHash)) throw new Error('api_hash 格式无效');
    if (this.client) {
      try { void this.client.disconnect(); } catch {}
      this.client = null;
    }
    this.groupPeers.clear();
    const pendingSecret = { apiId, apiHash, session: '', accountKey: '', accountLabel: '' };
    const controller = new AbortController();
    let client = null;
    this.authAbortController = controller;
    this.publicState({
      status: 'connecting',
      configured: false,
      error: '',
      accountKey: '',
      accountLabel: '',
      qrDataUrl: '',
      qrExpiresAt: 0,
      hint: '正在生成登录二维码',
    });
    this.authPromise = (async () => {
      try {
        client = await this.connectWithFallback(pendingSecret, { signal: controller.signal });
        const user = await client.signInUserWithQrCode({ apiId, apiHash }, {
          qrCode: async ({ token, expires }) => {
            if (controller.signal.aborted) {
              const error = new Error('QR login aborted');
              error.name = 'AbortError';
              throw error;
            }
            const loginUrl = `tg://login?token=${Buffer.from(token).toString('base64url')}`;
            const qrDataUrl = await this.renderQrCode(loginUrl);
            const qrExpiresAt = telegramQrExpiryMillis(expires);
            this.publicState({
              status: 'waiting_qr',
              configured: false,
              error: '',
              hint: '使用已登录的 Telegram 手机端扫码确认',
              qrDataUrl,
              qrExpiresAt,
            });
            this.log('debug', 'telegram_qr_ready', {
              expiresAt: new Date(qrExpiresAt).toISOString(),
            });
          },
          password: async hint => this.requestAuthValue('password', { hint: hint || '请输入两步验证密码' }),
          onError: error => {
            const clean = cleanTelegramError(error);
            this.log('warn', 'telegram_qr_auth_step_error', clean);
            this.publicState({ error: clean.message, waitSeconds: clean.seconds });
            return false;
          },
          abortSignal: controller.signal,
        });
        const authorizedUser = user || await client.getMe();
        const session = String(client.session?.save?.() || '');
        if (!session) throw new Error('Telegram 会话创建失败');
        this.secret = {
          apiId,
          apiHash,
          session,
          accountKey: String(authorizedUser?.id || ''),
          accountLabel: accountLabel(authorizedUser),
        };
        this.writeSecret(this.secret);
        this.log('info', 'telegram_auth_ready', {
          method: 'qr',
          accountKey: this.secret.accountKey,
          accountLabel: this.secret.accountLabel,
        });
        return this.publicState({
          status: 'ready',
          configured: true,
          accountKey: this.secret.accountKey,
          accountLabel: this.secret.accountLabel,
          error: '',
          waitSeconds: 0,
          hint: '',
          qrDataUrl: '',
          qrExpiresAt: 0,
        });
      } catch (error) {
        if (isAuthorizationCancelled(error)) {
          this.log('info', 'telegram_auth_cancelled', { method: 'qr' });
          try { await client?.disconnect(); } catch {}
          this.client = null;
          return this.publicState({
            status: 'disconnected',
            configured: Boolean(this.loadSecret()),
            error: '',
            waitSeconds: 0,
            hint: '',
            qrDataUrl: '',
            qrExpiresAt: 0,
          });
        }
        const clean = cleanTelegramError(error);
        this.log('error', 'telegram_qr_auth_failed', clean);
        try { await client?.disconnect(); } catch {}
        this.client = null;
        return this.publicState({
          status: 'error',
          configured: false,
          error: clean.message,
          waitSeconds: clean.seconds,
          hint: '',
          qrDataUrl: '',
          qrExpiresAt: 0,
        });
      } finally {
        this.authPromise = null;
        this.authWaiter = null;
        this.authAbortController = null;
      }
    })();
    return this.status();
  }

  async cancelAuthorization() {
    const activeAuthorization = this.authPromise;
    if (this.authAbortController) this.authAbortController.abort();
    if (this.authWaiter) {
      this.authWaiter.reject(new Error('AUTH_USER_CANCEL'));
      this.authWaiter = null;
    }
    if (activeAuthorization) {
      try { await activeAuthorization; } catch {}
    } else if (this.client) {
      try { await this.client.disconnect(); } catch {}
      this.client = null;
    }
    this.groupPeers.clear();
    return this.publicState({
      status: 'disconnected',
      configured: Boolean(this.loadSecret()),
      error: '',
      waitSeconds: 0,
      hint: '',
      qrDataUrl: '',
      qrExpiresAt: 0,
    });
  }

  async logOut() {
    if (this.authPromise) await this.cancelAuthorization();
    if (this.client) {
      try {
        if (await this.client.checkAuthorization()) await this.client.logOut();
      } catch {}
      try { await this.client.disconnect(); } catch {}
    }
    this.client = null;
    this.groupPeers.clear();
    this.secret = null;
    this.clearSecret();
    return this.publicState({ status: 'disconnected', configured: false, accountKey: '', accountLabel: '', error: '' });
  }

  stopSync() {
    this.syncStopRequested = true;
    return true;
  }

  async ensureConnected() {
    if (this.client) {
      try {
        if (await this.client.checkAuthorization()) {
          if (!['ready', 'syncing'].includes(this.state.status)) this.publicState({ status: 'ready', error: '', waitSeconds: 0 });
          return this.client;
        }
      } catch {}
    }
    const connected = await this.connectStored();
    if (connected.status !== 'ready') throw new Error(connected.error || 'Telegram 尚未连接');
    return this.client;
  }

  async listGroupDialogs(options = {}) {
    const client = await this.ensureConnected();
    const limit = Math.max(1, Math.min(1000, Number(options.limit) || 500));
    this.publicState({ status: 'listing_groups', error: '' });
    try {
      // teleproto 1.228.4 has an inverted ignoreMigrated condition that drops
      // every normal dialog. Fetch all dialogs and filter private users here.
      const dialogs = await client.getDialogs({ limit, ignoreMigrated: false });
      const groups = [];
      this.groupPeers.clear();
      for (const dialog of dialogs || []) {
        if (!dialog || (!dialog.isGroup && !dialog.isChannel) || dialog.isUser) continue;
        const chatKey = String(dialog.id?.toString?.() || dialog.id || '').trim();
        if (!chatKey) continue;
        const entity = dialog.entity || {};
        if (entity.migratedTo) continue;
        const chatType = entity.megagroup
          ? 'supergroup'
          : dialog.isGroup && !dialog.isChannel
            ? 'group'
            : 'channel';
        const title = String(dialog.title || dialog.name || entity.title || `Telegram ${chatKey}`).trim().slice(0, 260);
        this.groupPeers.set(chatKey, {
          inputEntity: dialog.inputEntity,
          title,
          chatType,
        });
        groups.push({
          chatKey,
          title,
          chatType,
          username: String(entity.username || '').trim().slice(0, 128),
          owned: Boolean(entity.creator),
          admin: Boolean(entity.creator || entity.adminRights),
          archived: Boolean(dialog.archived),
          latestMessageId: Math.max(0, Number(dialog.message?.id) || 0),
          latestMessageDate: normalizeTelegramDate(dialog.message?.date || dialog.date),
        });
      }
      groups.sort((left, right) =>
        Number(right.owned) - Number(left.owned)
        || Number(right.admin) - Number(left.admin)
        || left.title.localeCompare(right.title, 'zh-CN'));
      this.log('info', 'telegram_group_dialogs_listed', {
        accountKey: this.secret?.accountKey || '',
        count: groups.length,
        dialogCount: Number(dialogs?.length || 0),
        groupCount: groups.filter(group => group.chatType !== 'channel').length,
        channelCount: groups.filter(group => group.chatType === 'channel').length,
        archivedCount: groups.filter(group => group.archived).length,
      });
      this.publicState({ status: 'ready', error: '' });
      return {
        accountKey: this.secret?.accountKey || this.state.accountKey || '',
        accountLabel: this.secret?.accountLabel || this.state.accountLabel || '',
        groups,
      };
    } catch (error) {
      const clean = cleanTelegramError(error);
      this.log('error', 'telegram_group_dialogs_list_failed', clean);
      this.publicState({ status: 'error', error: clean.message, waitSeconds: clean.seconds });
      throw new Error(clean.seconds ? `${clean.message}；需等待 ${clean.seconds} 秒` : clean.message);
    }
  }

  async resolveGroup(chatKey) {
    const key = String(chatKey || '').trim();
    if (!key) throw new Error('缺少 Telegram 群组标识');
    if (!this.groupPeers.has(key)) await this.listGroupDialogs();
    const group = this.groupPeers.get(key);
    if (!group) throw new Error('所选 Telegram 群组/频道不可用；请刷新来源列表并重新选择');
    return group;
  }

  async syncGroupMessages(options = {}) {
    await this.ensureConnected();
    const group = await this.resolveGroup(options.chatKey);
    return this.syncPeerMessages(group.inputEntity, {
      chatKey: String(options.chatKey || ''),
      sourceLabel: group.title,
      chatType: group.chatType,
    }, options);
  }

  async markGroupRead(options = {}) {
    await this.ensureConnected();
    const group = await this.resolveGroup(options.chatKey);
    const maxId = Math.max(0, Number(options.maxId) || 0);
    if (!maxId) return { marked: false, chatKey: String(options.chatKey || ''), maxId: 0 };
    await this.client.markAsRead(group.inputEntity, undefined, { maxId });
    this.log('info', 'telegram_group_marked_read', {
      accountKey: this.secret?.accountKey || '',
      chatKey: String(options.chatKey || ''),
      sourceLabel: group.title,
      maxId,
    });
    return { marked: true, chatKey: String(options.chatKey || ''), maxId };
  }

  async syncPeerMessages(peer, metadata = {}, options = {}) {
    const limit = Math.max(1, Math.min(20000, Number(options.limit) || 1000));
    const checkpointMessageId = Math.max(0, Number(options.checkpointMessageId) || 0);
    const baselineMessageId = Math.max(0, Number(options.baselineMessageId) || 0);
    const requestedLookback = Number(options.lookback);
    const lookback = Math.max(0, Math.min(1000, Number.isFinite(requestedLookback) ? requestedLookback : 200));
    const minId = options.ignoreBaseline
      ? 0
      : Math.max(baselineMessageId, checkpointMessageId - lookback);
    const storedCursorMessageId = Math.max(0, Number(options.syncCursorMessageId) || 0);
    const storedTargetMessageId = Math.max(0, Number(options.syncTargetMessageId) || 0);
    const sinceMs = options.since ? new Date(options.since).getTime() : 0;
    const messages = [];
    let hasMore = false;
    let stopped = false;
    this.syncStopRequested = false;
    this.publicState({ status: 'syncing', error: '' });
    try {
      for await (const message of this.client.iterMessages(peer, {
        limit: limit + 1,
        minId,
        ...(storedCursorMessageId ? { offsetId: storedCursorMessageId } : {}),
        waitTime: 0.5,
      })) {
        if (this.syncStopRequested) {
          stopped = true;
          hasMore = messages.length > 0 || storedCursorMessageId > 0;
          break;
        }
        const dateMs = message?.date instanceof Date ? message.date.getTime() : Number(message?.date || 0) * 1000;
        if (sinceMs && dateMs && dateMs < sinceMs) break;
        if (messages.length >= limit) {
          hasMore = true;
          break;
        }
        messages.push(message);
        if (typeof options.onProgress === 'function' && (messages.length === 1 || messages.length % 100 === 0)) {
          options.onProgress({ fetched: messages.length, limit });
        }
      }
      const envelopes = telegramApiMessagesToEnvelopes(messages, {
        accountKey: this.secret?.accountKey || this.state.accountKey,
        chatKey: metadata.chatKey || 'telegram_group',
        sourceLabel: `Telegram API · ${metadata.sourceLabel || '群组'}`,
      });
      const fetchedIds = envelopes.map(message => Number(message.messageId) || 0).filter(Boolean);
      const maxFetchedMessageId = Math.max(0, ...fetchedIds);
      const targetMessageId = Math.max(storedTargetMessageId, checkpointMessageId, baselineMessageId, maxFetchedMessageId);
      const nextCursorMessageId = hasMore
        ? Math.max(0, Number(envelopes[envelopes.length - 1]?.messageId) || storedCursorMessageId)
        : 0;
      const checkpointComplete = !hasMore;
      const nextCheckpointMessageId = checkpointComplete ? targetMessageId : checkpointMessageId;
      this.log('info', 'telegram_group_messages_fetched', {
        accountKey: this.secret?.accountKey || '',
        chatKey: metadata.chatKey || '',
        sourceLabel: metadata.sourceLabel || '',
        fetched: envelopes.length,
        baselineMessageId,
        checkpointMessageId,
        nextCheckpointMessageId,
        syncCursorMessageId: nextCursorMessageId,
        syncTargetMessageId: checkpointComplete ? 0 : targetMessageId,
        hasMore,
        stopped,
      });
      this.publicState({ status: 'ready', error: '' });
      return {
        messages: envelopes,
        checkpointMessageId: nextCheckpointMessageId,
        checkpointComplete,
        syncCursorMessageId: nextCursorMessageId,
        syncTargetMessageId: checkpointComplete ? 0 : targetMessageId,
        hasMore,
        stopped,
        maxFetchedMessageId,
        accountKey: this.secret?.accountKey || '',
        accountLabel: this.secret?.accountLabel || '',
        chatKey: metadata.chatKey || '',
        chatType: metadata.chatType || '',
        sourceLabel: metadata.sourceLabel || '',
      };
    } catch (error) {
      const clean = cleanTelegramError(error);
      this.log('error', 'telegram_group_messages_fetch_failed', {
        ...clean,
        chatKey: metadata.chatKey || '',
        sourceLabel: metadata.sourceLabel || '',
      });
      this.publicState({ status: 'error', error: clean.message, waitSeconds: clean.seconds });
      throw new Error(clean.seconds ? `${clean.message}；需等待 ${clean.seconds} 秒` : clean.message);
    } finally {
      this.syncStopRequested = false;
    }
  }
}

module.exports = {
  TelegramUserService,
  cleanTelegramError,
  accountLabel,
  normalizeTelegramNetworkConfig,
  defaultTelegramTransportCandidates,
};
