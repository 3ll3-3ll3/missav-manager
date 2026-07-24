const test = require('node:test');
const assert = require('node:assert/strict');
const { TelegramUserService, cleanTelegramError } = require('../src/telegramClient');

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('等待模拟 Telegram 状态超时');
}

class FakeTelegramClient {
  constructor(session = '') {
    this.savedSession = session;
    this.session = { save: () => this.savedSession || 'safe-session-value' };
    this.authorized = Boolean(session);
    this.disconnected = false;
    this.loggedOut = false;
    this.messages = [
      { id: 12, date: new Date('2026-07-21T00:02:00Z'), message: 'SSIS-469' },
      { id: 11, date: new Date('2026-07-21T00:01:00Z'), message: 'SONE-314' },
    ];
    this.dialogs = [
      {
        id: { toString: () => '-1001001' },
        title: '番号收集一群',
        inputEntity: { peer: 'group-1' },
        entity: { megagroup: true, creator: true, username: 'codes_one' },
        isUser: false,
        isGroup: true,
        isChannel: true,
        archived: false,
        message: { id: 10, date: new Date('2026-07-21T00:00:00Z') },
      },
      {
        id: { toString: () => '9001' },
        title: '普通私聊',
        inputEntity: { peer: 'user-1' },
        entity: {},
        isUser: true,
        isGroup: false,
        isChannel: false,
      },
    ];
  }

  async start(callbacks) {
    assert.equal(typeof callbacks.phoneNumber, 'string');
    assert.equal(await callbacks.phoneCode(true), '12345');
    assert.equal(await callbacks.password('hint'), 'two-factor');
    this.authorized = true;
  }

  async connect() {}
  async checkAuthorization() { return this.authorized; }
  async getMe() { return { id: 42n, firstName: 'Test', lastName: 'User', username: 'tester' }; }
  async disconnect() { this.disconnected = true; }
  async logOut() { this.loggedOut = true; this.authorized = false; }
  async getDialogs() { return this.dialogs; }
  async *iterMessages(entity) {
    this.lastMessageEntity = entity;
    for (const message of this.messages) yield message;
  }
}

test('runs interactive Telegram user authorization without exposing or logging credentials', async () => {
  let storedSecret = null;
  const states = [];
  const logs = [];
  const fake = new FakeTelegramClient();
  const service = new TelegramUserService({
    createClient: () => fake,
    readSecret: () => storedSecret,
    writeSecret: value => { storedSecret = value; },
    clearSecret: () => { storedSecret = null; },
    emitState: state => states.push(state),
    log: (level, event, data) => logs.push({ level, event, data }),
  });

  const started = service.startAuthorization({
    apiId: 123456,
    apiHash: '0123456789abcdef0123456789abcdef',
    phoneNumber: '+8613800000000',
  });
  assert.ok(['connecting', 'waiting_code'].includes(started.status));
  await waitFor(() => service.state.status === 'waiting_code');
  service.submitAuthValue('code', '12345');
  await waitFor(() => service.state.status === 'waiting_password');
  service.submitAuthValue('password', 'two-factor');
  await waitFor(() => service.state.status === 'ready');

  assert.equal(storedSecret.session, 'safe-session-value');
  assert.equal(storedSecret.apiHash, '0123456789abcdef0123456789abcdef');
  assert.equal(storedSecret.accountKey, '42');
  assert.equal(service.status().accountLabel, 'Test User');
  const publicPayload = JSON.stringify(states);
  const logPayload = JSON.stringify(logs);
  for (const secret of ['safe-session-value', '0123456789abcdef0123456789abcdef', '12345', 'two-factor', '+8613800000000']) {
    assert.equal(publicPayload.includes(secret), false);
    assert.equal(logPayload.includes(secret), false);
  }

  const listed = await service.listGroupDialogs();
  assert.equal(listed.groups.length, 1);
  assert.equal(listed.groups[0].chatKey, '-1001001');
  assert.equal(listed.groups[0].owned, true);
  const synced = await service.syncGroupMessages({
    chatKey: '-1001001',
    baselineMessageId: 10,
    checkpointMessageId: 10,
    lookback: 2,
    limit: 100,
  });
  assert.equal(synced.messages.length, 2);
  assert.equal(synced.checkpointMessageId, 12);
  assert.equal(synced.chatKey, '-1001001');
  assert.equal(fake.lastMessageEntity.peer, 'group-1');
  assert.deepEqual(synced.messages.flatMap(message => message.codes), ['SSIS-469', 'SONE-314']);

  await service.logOut();
  assert.equal(storedSecret, null);
  assert.equal(service.status().configured, false);
});

test('runs cancellable QR authorization, refresh-safe state, and optional 2FA without exposing the token', async () => {
  let storedSecret = null;
  let loginUrl = '';
  const states = [];
  const logs = [];
  class FakeQrTelegramClient extends FakeTelegramClient {
    async signInUserWithQrCode(credentials, callbacks) {
      assert.equal(credentials.apiId, 123456);
      assert.equal(credentials.apiHash, '0123456789abcdef0123456789abcdef');
      await callbacks.qrCode({
        token: Buffer.from('short-lived-qr-token'),
        expires: Math.floor(Date.now() / 1000) + 30,
      });
      assert.equal(await callbacks.password('QR two-factor hint'), 'qr-two-factor');
      this.authorized = true;
      return this.getMe();
    }
  }
  const fake = new FakeQrTelegramClient();
  const service = new TelegramUserService({
    createClient: () => fake,
    readSecret: () => storedSecret,
    writeSecret: value => { storedSecret = value; },
    emitState: state => states.push(state),
    log: (level, event, data) => logs.push({ level, event, data }),
    renderQrCode: async value => {
      loginUrl = value;
      return 'data:image/png;base64,c2FmZS1xci1pbWFnZQ==';
    },
  });

  service.startQrAuthorization({
    apiId: 123456,
    apiHash: '0123456789abcdef0123456789abcdef',
  });
  await waitFor(() => service.state.status === 'waiting_password');
  const qrState = states.find(state => state.status === 'waiting_qr');
  assert.ok(qrState);
  assert.equal(qrState.qrDataUrl, 'data:image/png;base64,c2FmZS1xci1pbWFnZQ==');
  assert.ok(qrState.qrExpiresAt > Date.now());
  assert.match(loginUrl, /^tg:\/\/login\?token=/);
  service.submitAuthValue('password', 'qr-two-factor');
  await waitFor(() => service.state.status === 'ready');

  assert.equal(storedSecret.session, 'safe-session-value');
  assert.equal(storedSecret.accountKey, '42');
  const publicPayload = JSON.stringify(states);
  const logPayload = JSON.stringify(logs);
  for (const secret of ['short-lived-qr-token', loginUrl, 'qr-two-factor', '0123456789abcdef0123456789abcdef']) {
    assert.equal(publicPayload.includes(secret), false);
    assert.equal(logPayload.includes(secret), false);
  }
});

test('cancels an active QR login without saving a partial session', async () => {
  let storedSecret = null;
  class CancellableQrClient extends FakeTelegramClient {
    async signInUserWithQrCode(_credentials, callbacks) {
      await callbacks.qrCode({
        token: Buffer.from('cancel-me'),
        expires: Math.floor(Date.now() / 1000) + 30,
      });
      await new Promise((resolve, reject) => {
        callbacks.abortSignal.addEventListener('abort', () => {
          const error = new Error('QR login aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
      return this.getMe();
    }
  }
  const service = new TelegramUserService({
    createClient: () => new CancellableQrClient(),
    readSecret: () => storedSecret,
    writeSecret: value => { storedSecret = value; },
    renderQrCode: async () => 'data:image/png;base64,Y2FuY2Vs',
  });
  service.startQrAuthorization({
    apiId: 123456,
    apiHash: '0123456789abcdef0123456789abcdef',
  });
  await waitFor(() => service.state.status === 'waiting_qr');
  const status = await service.cancelAuthorization();
  assert.equal(status.status, 'disconnected');
  assert.equal(status.qrDataUrl, '');
  assert.equal(storedSecret, null);
});

test('restores an encrypted session through the injected secret store', async () => {
  const fake = new FakeTelegramClient('existing-session');
  const service = new TelegramUserService({
    createClient: session => {
      assert.equal(session, 'existing-session');
      return fake;
    },
    readSecret: () => ({
      apiId: 123456,
      apiHash: '0123456789abcdef0123456789abcdef',
      session: 'existing-session',
      accountKey: '42',
      accountLabel: 'Stored Account',
    }),
    writeSecret: () => {},
  });
  const status = await service.connectStored();
  assert.equal(status.status, 'ready');
  assert.equal(status.accountKey, '42');
});

test('sanitizes phone numbers, long credentials, and FLOOD_WAIT durations', () => {
  const clean = cleanTelegramError(new Error(`FLOOD_WAIT_37 phone +8613800000000 tg://login?token=${'a'.repeat(43)} secret A`.repeat(100)));
  assert.equal(clean.seconds, 37);
  assert.equal(clean.message.includes('+8613800000000'), false);
  assert.equal(clean.message.includes('a'.repeat(43)), false);
  assert.ok(clean.message.length <= 1000);
});

test('keeps an independent continuation cursor when a selected group exceeds one sync limit', async () => {
  class PaginatedClient extends FakeTelegramClient {
    constructor() {
      super('existing-session');
      this.messages = Array.from({ length: 7 }, (_value, index) => ({
        id: 17 - index,
        date: new Date(`2026-07-21T00:0${6 - index}:00Z`),
        message: `CODE-${17 - index}`,
      }));
    }

    async *iterMessages(_entity, options = {}) {
      const rows = this.messages
        .filter(message => message.id > Number(options.minId || 0))
        .filter(message => !options.offsetId || message.id < Number(options.offsetId));
      for (const message of rows.slice(0, Number(options.limit) || rows.length)) yield message;
    }
  }

  const fake = new PaginatedClient();
  const service = new TelegramUserService({
    createClient: () => fake,
    readSecret: () => ({
      apiId: 123456,
      apiHash: '0123456789abcdef0123456789abcdef',
      session: 'existing-session',
      accountKey: '42',
      accountLabel: 'Stored Account',
    }),
    writeSecret: () => {},
  });
  await service.connectStored();
  await service.listGroupDialogs();
  const first = await service.syncGroupMessages({
    chatKey: '-1001001',
    baselineMessageId: 10,
    checkpointMessageId: 10,
    lookback: 0,
    limit: 3,
  });
  assert.deepEqual(first.messages.map(message => Number(message.messageId)), [17, 16, 15]);
  assert.equal(first.checkpointComplete, false);
  assert.equal(first.checkpointMessageId, 10);
  assert.equal(first.syncCursorMessageId, 15);
  assert.equal(first.syncTargetMessageId, 17);

  const second = await service.syncGroupMessages({
    chatKey: '-1001001',
    baselineMessageId: 10,
    checkpointMessageId: first.checkpointMessageId,
    syncCursorMessageId: first.syncCursorMessageId,
    syncTargetMessageId: first.syncTargetMessageId,
    lookback: 0,
    limit: 10,
  });
  assert.deepEqual(second.messages.map(message => Number(message.messageId)), [14, 13, 12, 11]);
  assert.equal(second.checkpointComplete, true);
  assert.equal(second.checkpointMessageId, 17);
  assert.equal(second.syncCursorMessageId, 0);
  assert.equal(second.syncTargetMessageId, 0);
});

test('uses the binding baseline to skip old group history and only fetch later messages', async () => {
  class IncrementalClient extends FakeTelegramClient {
    constructor() {
      super('existing-session');
      this.messages = [
        { id: 102, date: new Date('2026-07-21T00:02:00Z'), message: 'SSIS-469' },
        { id: 101, date: new Date('2026-07-21T00:01:00Z'), message: 'SONE-314' },
      ];
      this.dialogs[0].message.id = 102;
    }

    async *iterMessages(_entity, options = {}) {
      for (const message of this.messages.filter(row => row.id > Number(options.minId || 0))) yield message;
    }
  }

  const fake = new IncrementalClient();
  const service = new TelegramUserService({
    createClient: () => fake,
    readSecret: () => ({
      apiId: 123456,
      apiHash: '0123456789abcdef0123456789abcdef',
      session: 'existing-session',
      accountKey: '42',
      accountLabel: 'Stored Account',
    }),
    writeSecret: () => {},
  });
  await service.connectStored();
  await service.listGroupDialogs();

  const initial = await service.syncGroupMessages({
    chatKey: '-1001001',
    baselineMessageId: 102,
    checkpointMessageId: 102,
    lookback: 20,
    limit: 100,
  });
  assert.equal(initial.messages.length, 0);
  assert.equal(initial.checkpointMessageId, 102);

  fake.messages.unshift({ id: 103, date: new Date('2026-07-21T00:03:00Z'), message: 'ABF-354' });
  const incremental = await service.syncGroupMessages({
    chatKey: '-1001001',
    baselineMessageId: 102,
    checkpointMessageId: 102,
    lookback: 20,
    limit: 100,
  });
  assert.deepEqual(incremental.messages.flatMap(message => message.codes), ['ABF-354']);
  assert.equal(incremental.checkpointMessageId, 103);
});
