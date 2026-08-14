import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/bundle.mjs";

const security = await loadModule("lib/mtproto-security.ts");
const coreSecurity = await loadModule("lib/security.ts");

test("Telegram Session 使用带随机 IV 的 AES-GCM 加密并可往返恢复", async () => {
  const secret = "test-only-encryption-secret-that-is-long-enough";
  const session = "1AQA-test-session-not-a-real-credential";
  const first = await security.encryptMtprotoSession(session, secret);
  const second = await security.encryptMtprotoSession(session, secret);
  assert.match(first, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.notEqual(first, second);
  assert.equal(await security.decryptMtprotoSession(first, secret), session);
  assert.ok(!first.includes(session));
});

test("Telegram Session 拒绝短密钥、替换密钥和篡改密文", async () => {
  await assert.rejects(() => security.encryptMtprotoSession("session", "too-short"), /至少 32/);
  const secret = "test-only-encryption-secret-that-is-long-enough";
  const payload = await security.encryptMtprotoSession("session", secret);
  await assert.rejects(() => security.decryptMtprotoSession(payload, "another-test-secret-that-is-also-long-enough"), /无法解密/);
  await assert.rejects(() => security.decryptMtprotoSession(payload.slice(0, -2) + "xx", secret), /无法解密/);
});

test("Telegram 登录输入只接受国际手机号和数字验证码", () => {
  assert.equal(security.normalizeInternationalPhone("+65 9123-4567"), "+6591234567");
  assert.throws(() => security.normalizeInternationalPhone("91234567"), /国际格式/);
  assert.equal(security.normalizeTelegramCode("12 345"), "12345");
  assert.throws(() => security.normalizeTelegramCode("12ab"), /格式无效/);
});

test("Telegram 追踪号不会被手机号脱敏规则破坏", () => {
  const traceId = security.createMtprotoTraceId();
  assert.match(traceId, /^tg-r[0-9a-f]{4}-s[0-9a-f]{4}-t[0-9a-f]{4}-u[0-9a-f]{4}$/);
  assert.equal(coreSecurity.redact(traceId), traceId);
});

test("Telegram 登录错误只返回安全枚举，不回显原始敏感内容", () => {
  assert.match(security.safeMtprotoError({ errorMessage: "PHONE_CODE_INVALID" }), /验证码不正确/);
  assert.match(security.safeMtprotoError(new Error("SESSION_PASSWORD_NEEDED")), /两步验证/);
  assert.match(security.safeMtprotoError({ errorMessage: "AUTH_TOKEN_EXPIRED", message: "opaque-token" }), /二维码已失效/);
  assert.match(security.safeMtprotoError({ errorMessage: "PHONE_NUMBER_UNOCCUPIED" }), /尚未注册/);
  assert.match(security.safeMtprotoError({ errorMessage: "FLOOD_WAIT_42" }), /42 秒/);
  assert.deepEqual(security.classifyMtprotoError(new Error("WebSocket connection to wss://venus.web.telegram.org failed")), {
    code: "WS_CONNECT_FAILED",
    message: "Telegram WebSocket 通道连接失败，请稍后重试",
  });
  assert.deepEqual(security.classifyMtprotoError(new Error("Request was unsuccessful 1 time(s)")), {
    code: "MTPROTO_RETRY_EXHAUSTED",
    message: "Telegram 在切换数据中心或初始化连接后仍未完成请求",
  });
  assert.deepEqual(
    security.classifyMtprotoError(
      new Error(
        "Concurrent usage of the current session from multiple connections was detected, the current session was invalidated by the server for security reasons! (caused by InvokeWithLayer)",
      ),
    ),
    {
      code: "SESSION_CONCURRENT_INVALIDATED",
      message:
        "Telegram 检测到同一 Session 被重复连接，当前 Session 已失效。请到全局 Telegram 中心重新登录一次",
    },
  );
  assert.deepEqual(
    security.classifyMtprotoError({
      code: "TELEGRAM_SESSION_BUSY",
      message: "opaque worker detail",
    }),
    {
      code: "TELEGRAM_SESSION_BUSY",
      message:
        "上一项 Telegram 个人账号操作仍在安全收尾，请稍后重试；系统已阻止重复连接",
    },
  );
  const safe = security.safeMtprotoError(new Error("phone +6591234567 password=hunter2 session=secret"));
  assert.equal(safe, "Telegram 登录请求失败");
  assert.doesNotMatch(safe, /6591234567|hunter2|session=secret/);
});

test("Telegram 未知登录异常生成可定位且不含凭据的脱敏诊断", () => {
  const error = Object.assign(
    new TypeError("socket failed for phone +6591234567 password=hunter2 session=secret"),
    {
      code: "ERR_TEST_SOCKET",
      errorMessage: "tg://login?token=opaque-login-token",
      cause: Object.assign(new Error("api_hash=very-secret-hash"), { code: "CAUSE_TEST" }),
    },
  );
  const diagnostic = security.describeMtprotoError(error);
  assert.equal(diagnostic.name, "TypeError");
  assert.equal(diagnostic.code, "ERR_TEST_SOCKET");
  assert.equal(diagnostic.cause.code, "CAUSE_TEST");
  const serialized = JSON.stringify(diagnostic);
  assert.match(serialized, /ERR_TEST_SOCKET|CAUSE_TEST/);
  assert.doesNotMatch(serialized, /6591234567|hunter2|opaque-login-token|very-secret-hash/);
});
