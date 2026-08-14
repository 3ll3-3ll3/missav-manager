"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import QRCode from "qrcode";
import { parseTelegramOfficialJson } from "../../lib/telegram";
import {
  matchesTelegramBindingScope,
  matchesTelegramBindingSearch,
  type TelegramBindingScope,
} from "../../lib/telegram-binding-filter";
import type { ToolId } from "../../lib/types";

const TELEGRAM_TOOLS = [
  "twitter",
  "badnews",
  "haijiao",
  "missav",
  "av123",
] as const;
const TELEGRAM_TOOL_LABELS: Record<string, string> = {
  twitter: "推特博主",
  badnews: "Bad.news",
  haijiao: "海角帖子",
  missav: "MissAV",
  av123: "123AV",
};

type Tab = "connections" | "sources" | "bindings" | "syncs";
type Source = {
  id: string;
  name: string;
  kind: string;
  external_key: string;
  external_chat_id: string;
  connection_id: string;
  chat_type: string;
  username: string;
  access_status: string;
  archived: number;
  message_count: number;
  pending_count: number;
  last_sync_at: string;
  latest_remote_message_id: string;
  incremental_checkpoint_id: string;
  last_error: string;
};
type Binding = {
  source_id: string;
  tool: string;
  history_mode: string;
  history_limit: number;
  history_from: string;
};
type Connection = {
  connection_id: string;
  kind: string;
  label: string;
  status: string;
  account_label: string;
  network_status: string;
  last_success_at: string;
  last_error: string;
};
type BotState = {
  webhook_status?: string;
  last_checked_at?: string;
  next_update_offset?: number;
} | null;
type Hub = {
  configured: boolean;
  connections: Connection[];
  sources: Source[];
  bindings: Binding[];
  syncRuns: Array<Record<string, unknown>>;
  readStates: Array<Record<string, unknown>>;
  botState: BotState;
  executionModel: "request_scoped";
};
type HubPart = "connections" | "sources" | "bindings" | "syncs";
type HubSyncProgress = {
  status: "running" | "completed" | "failed";
  phase: string;
  label: string;
  current: number;
  total: number;
  page: number;
  received: number;
  scanned: number;
  inserted: number;
  startedAt: number;
  remoteMs: number;
  databaseMs: number;
  totalMs: number;
  elapsedMs: number;
};
type MtprotoStatus = {
  apiConfigured: boolean;
  encryptionConfigured: boolean;
  authorized: boolean;
  accountLabel: string;
  stage:
    | "idle"
    | "waiting_qr"
    | "waiting_code"
    | "waiting_password"
    | "authorized";
  mode: "" | "qr" | "phone";
  expiresAt: string;
  transport: "" | "cloudflare_tcp_with_websocket_fallback";
  executionModel: "request_scoped";
  liveConnection: boolean;
};
type MtprotoProbe = {
  tcpReachable: boolean;
  websocketReachable: boolean;
  tcpElapsedMs: number;
  websocketElapsedMs: number;
  conclusion: string;
};
const EMPTY_MTPROTO: MtprotoStatus = {
  apiConfigured: false,
  encryptionConfigured: false,
  authorized: false,
  accountLabel: "",
  stage: "idle",
  mode: "",
  expiresAt: "",
  transport: "",
  executionModel: "request_scoped",
  liveConnection: false,
};
const STATUS_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 30_000;

function bindingDraft(bindings: Binding[]) {
  const next: Record<string, Set<string>> = {};
  for (const tool of TELEGRAM_TOOLS)
    next[tool] = new Set(
      bindings
        .filter((item) => item.tool === tool)
        .map((item) => item.source_id),
    );
  return next;
}

async function api(
  url: string,
  options?: RequestInit,
  timeoutMs = ACTION_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      ...options,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({ error: "请求失败" }));
    if (!response.ok) throw new Error(payload.error || "请求失败");
    return payload;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw new Error("状态读取超时，请点击刷新重试");
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

async function streamHubSync(
  action: "pull-stream" | "sync-personal-stream",
  values: Record<string, unknown>,
  onProgress: (progress: Record<string, unknown>) => void,
) {
  const response = await fetch("/api/telegram", {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...values }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "请求失败" }));
    throw new Error(body.error || "Telegram 同步失败");
  }
  if (!response.body) throw new Error("浏览器无法读取同步进度，请刷新后重试");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: Record<string, unknown> | null = null;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as {
      type?: string;
      progress?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: string;
    };
    if (event.type === "progress" && event.progress) onProgress(event.progress);
    else if (event.type === "complete" && event.result)
      completed = event.result;
    else if (event.type === "error")
      throw new Error(event.error || "Telegram 同步失败");
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) consume(line);
    if (done) break;
  }
  consume(buffer);
  if (!completed) throw new Error("同步连接提前结束，请刷新同步记录后重试");
  return completed as unknown as Record<string, unknown>;
}

function hubSyncTimings(result: Record<string, unknown>) {
  const timings =
    result.timings && typeof result.timings === "object"
      ? (result.timings as Record<string, unknown>)
      : {};
  const sources = Array.isArray(timings.sources)
    ? (timings.sources as Array<Record<string, unknown>>)
    : [];
  return {
    remoteMs:
      Number(timings.remoteMs || 0) ||
      sources.reduce((sum, row) => sum + Number(row.remoteMs || 0), 0),
    databaseMs:
      Number(timings.databaseMs || 0) ||
      sources.reduce((sum, row) => sum + Number(row.databaseMs || 0), 0),
    totalMs: Number(timings.totalMs || 0),
  };
}

export default function TelegramSettingsPanel({
  initialTool,
}: {
  initialTool?: ToolId;
}) {
  const [tab, setTab] = useState<Tab>(initialTool ? "bindings" : "connections");
  const [hub, setHub] = useState<Hub>({
    configured: false,
    connections: [],
    sources: [],
    bindings: [],
    syncRuns: [],
    readStates: [],
    botState: null,
    executionModel: "request_scoped",
  });
  const [mtproto, setMtproto] = useState<MtprotoStatus>(EMPTY_MTPROTO);
  const [hubLoadState, setHubLoadState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [mtprotoLoadState, setMtprotoLoadState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [busy, setBusy] = useState({
    connection: false,
    sync: false,
    binding: false,
    source: false,
  });
  const [notice, setNotice] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [qrImage, setQrImage] = useState("");
  const [qrExpiresAt, setQrExpiresAt] = useState("");
  const [probe, setProbe] = useState<MtprotoProbe | null>(null);
  const [sourceSearch, setSourceSearch] = useState("");
  const [sourceType, setSourceType] = useState("");
  const [sourceAccess, setSourceAccess] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedSources, setSelectedSources] = useState<Set<string>>(
    new Set(),
  );
  const [selectedTool, setSelectedTool] = useState<string>(
    initialTool || TELEGRAM_TOOLS[0],
  );
  const [draftBindings, setDraftBindings] = useState<
    Record<string, Set<string>>
  >({});
  const [bindingSearch, setBindingSearch] = useState("");
  const [bindingScope, setBindingScope] = useState<TelegramBindingScope>("all");
  const [historyMode, setHistoryMode] = useState<
    "since_now" | "cached" | "recent" | "from_date"
  >("since_now");
  const [historyLimit, setHistoryLimit] = useState("100");
  const [historyFrom, setHistoryFrom] = useState("");
  const [syncMode, setSyncMode] = useState<
    "incremental" | "recent" | "range" | "history"
  >("incremental");
  const [syncLimit, setSyncLimit] = useState("200");
  const [syncStart, setSyncStart] = useState("");
  const [syncEnd, setSyncEnd] = useState("");
  const [syncProgress, setSyncProgress] = useState<HubSyncProgress | null>(
    null,
  );

  function setBusyArea(area: keyof typeof busy, value: boolean) {
    setBusy((current) => ({ ...current, [area]: value }));
  }

  const load = useCallback(async () => {
    setHubLoadState("loading");
    setMtprotoLoadState("loading");
    try {
      const [connections, sources, bindings, syncs] = await Promise.all([
        api("/api/telegram?view=connections", undefined, STATUS_TIMEOUT_MS),
        api(
          "/api/telegram?view=sources&page=1&pageSize=200",
          undefined,
          STATUS_TIMEOUT_MS,
        ),
        api("/api/telegram?view=bindings", undefined, STATUS_TIMEOUT_MS),
        api("/api/telegram?view=syncs", undefined, STATUS_TIMEOUT_MS),
      ]);
      const nextHub = {
        ...connections,
        ...sources,
        ...bindings,
        ...syncs,
      } as Hub & { mtproto?: MtprotoStatus };
      setHub(nextHub);
      setMtproto(nextHub.mtproto || EMPTY_MTPROTO);
      setHubLoadState("ready");
      setMtprotoLoadState("ready");
      setDraftBindings((current) =>
        Object.keys(current).length
          ? current
          : bindingDraft(nextHub.bindings as Binding[]),
      );
      setNotice("");
    } catch (error) {
      setHubLoadState("error");
      setMtprotoLoadState("error");
      setNotice(
        error instanceof Error ? error.message : "Telegram 状态读取失败",
      );
    }
  }, []);

  async function refreshParts(parts: HubPart[], resetBindings = false) {
    const unique = [...new Set(parts)];
    const values = await Promise.all(
      unique.map(async (part) => {
        const suffix = part === "sources" ? "&page=1&pageSize=200" : "";
        return [
          part,
          await api(
            `/api/telegram?view=${part}${suffix}`,
            undefined,
            STATUS_TIMEOUT_MS,
          ),
        ] as const;
      }),
    );
    const patch: Record<string, unknown> = {};
    for (const [, value] of values) Object.assign(patch, value);
    setHub((current) => ({ ...current, ...patch }) as Hub);
    const connectionPatch = values.find(
      ([part]) => part === "connections",
    )?.[1];
    if (connectionPatch?.mtproto)
      setMtproto(connectionPatch.mtproto as MtprotoStatus);
    const bindingPatch = values.find(([part]) => part === "bindings")?.[1];
    if (resetBindings && bindingPatch?.bindings)
      setDraftBindings(bindingDraft(bindingPatch.bindings as Binding[]));
  }

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  async function runAction(
    action: string,
    values: Record<string, unknown> = {},
  ) {
    setBusyArea("connection", true);
    try {
      const result = await api("/api/telegram/mtproto", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...values }),
      });
      if (result.qrUrl) {
        setQrImage(
          await QRCode.toDataURL(result.qrUrl, {
            width: 280,
            margin: 2,
            errorCorrectionLevel: "M",
          }),
        );
        setQrExpiresAt(result.qrExpiresAt || "");
      }
      if (result.stage)
        setMtproto((current) => ({
          ...current,
          ...result,
          authorized: result.stage === "authorized" ? true : current.authorized,
        }));
      if (result.stage === "authorized") {
        setPhone("");
        setCode("");
        setPassword("");
        setQrImage("");
        setQrExpiresAt("");
        setNotice(
          `Telegram 个人账号登录成功：${result.accountLabel || "Session 已加密保存"}`,
        );
      } else if (result.stage === "waiting_password") {
        setCode("");
        setQrImage("");
        setQrExpiresAt("");
        setNotice("验证码已通过，请输入两步验证密码");
      } else if (action === "start-phone")
        setNotice(
          `验证码已发送到 Telegram ${result.delivery === "sms" ? "短信" : "App"}`,
        );
      else if (action === "cancel") {
        setPhone("");
        setCode("");
        setPassword("");
        setQrImage("");
        setNotice("登录已取消，登录锁已释放");
      } else if (action === "logout")
        setNotice(
          result.remoteLoggedOut
            ? "已退出 Telegram 并删除网站 Session"
            : "网站端 Session 已删除，远端注销未确认",
        );
      await refreshParts(["connections"]);
    } catch (error) {
      if (action === "poll-qr") {
        setQrImage("");
        setQrExpiresAt("");
        setMtproto((current) => ({
          ...current,
          stage: "idle",
          mode: "",
          expiresAt: "",
        }));
      }
      setNotice(
        error instanceof Error ? error.message : "Telegram 登录操作失败",
      );
      await refreshParts(["connections"]);
    } finally {
      setBusyArea("connection", false);
    }
  }

  async function probeMtprotoChannel() {
    setBusyArea("connection", true);
    setNotice("");
    try {
      const result = (await api("/api/telegram/mtproto/probe", {
        method: "POST",
      })) as MtprotoProbe;
      setProbe(result);
      setNotice(
        result.tcpReachable || result.websocketReachable
          ? "至少一个传输端点可达；这只证明网络路径，不代表 MTProto 登录或 Session 已可用"
          : "Telegram TCP 与 WebSocket 均不可达，请稍后重试",
      );
    } catch (error) {
      setProbe(null);
      setNotice(
        error instanceof Error ? error.message : "Telegram 通道检测失败",
      );
    } finally {
      setBusyArea("connection", false);
    }
  }

  useEffect(() => {
    if (mtproto.stage !== "waiting_qr" || busy.connection) return;
    const timer = setTimeout(
      () => void runAction("poll-qr"),
      qrImage ? 5_000 : 250,
    );
    return () => clearTimeout(timer);
    // QR polling intentionally follows the server-side flow state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mtproto.stage, busy.connection, qrImage]);

  const filteredSources = useMemo(
    () =>
      hub.sources.filter((source) => {
        const query = sourceSearch.trim().toLowerCase();
        return (
          (!query ||
            `${source.name} ${source.username} ${source.external_chat_id} ${source.connection_id}`
              .toLowerCase()
              .includes(query)) &&
          (!sourceType || source.chat_type === sourceType) &&
          (!sourceAccess || source.access_status === sourceAccess) &&
          (includeArchived || !source.archived)
        );
      }),
    [hub.sources, sourceSearch, sourceType, sourceAccess, includeArchived],
  );

  function toggleSource(id: string) {
    setSelectedSources((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleBinding(tool: string, sourceId: string) {
    setDraftBindings((current) => {
      const next = { ...current, [tool]: new Set(current[tool] || []) };
      if (next[tool].has(sourceId)) next[tool].delete(sourceId);
      else next[tool].add(sourceId);
      return next;
    });
  }
  function diffCount() {
    let added = 0;
    let removed = 0;
    for (const tool of TELEGRAM_TOOLS) {
      const before = new Set(
        hub.bindings
          .filter((item) => item.tool === tool)
          .map((item) => item.source_id),
      );
      const after = draftBindings[tool] || new Set<string>();
      for (const id of after) if (!before.has(id)) added += 1;
      for (const id of before) if (!after.has(id)) removed += 1;
    }
    return { added, removed };
  }
  async function saveBindings() {
    const changes: Array<Record<string, unknown>> = [];
    for (const tool of TELEGRAM_TOOLS) {
      const before = new Set(
        hub.bindings
          .filter((item) => item.tool === tool)
          .map((item) => item.source_id),
      );
      const after = draftBindings[tool] || new Set<string>();
      const ids = new Set([...before, ...after]);
      for (const sourceId of ids)
        if (before.has(sourceId) !== after.has(sourceId))
          changes.push({
            sourceId,
            tool,
            enabled: after.has(sourceId),
            historyMode,
            historyLimit: Number(historyLimit) || 0,
            historyFrom,
          });
    }
    if (!changes.length) {
      setNotice("没有待保存的绑定变化");
      return;
    }
    setBusyArea("binding", true);
    try {
      const result = await api("/api/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "save-bindings", changes }),
      });
      setNotice(
        `绑定已一次提交：新增 ${result.added}，移除 ${result.removed}，保持 ${result.unchanged}；恢复点 ${String(result.snapshotId || "").slice(0, 8)}… 已建立`,
      );
      await refreshParts(["bindings", "sources"], true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "绑定保存失败");
    } finally {
      setBusyArea("binding", false);
    }
  }
  async function updateSource(
    sourceId: string,
    values: Record<string, unknown>,
  ) {
    setBusyArea("source", true);
    try {
      await api("/api/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "source-update", sourceId, ...values }),
      });
      await refreshParts(["sources"]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "来源设置保存失败");
    } finally {
      setBusyArea("source", false);
    }
  }
  async function markRead(sourceId: string) {
    setBusyArea("source", true);
    try {
      const result = await api("/api/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "mark-read", sourceId }),
      });
      setNotice(`已标记到本地确认的安全位置 ${result.maxId}`);
      await refreshParts(["sources"]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "手动已读失败");
    } finally {
      setBusyArea("source", false);
    }
  }
  async function deleteConnection(kind: "bot" | "personal") {
    if (
      !window.confirm(
        `删除${kind === "bot" ? " Bot" : "个人账号"}全局连接？系统会先建立恢复点，来源和消息历史保留。`,
      )
    )
      return;
    setBusyArea("connection", true);
    try {
      const result = await api("/api/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action:
            kind === "bot"
              ? "delete-bot-connection"
              : "delete-personal-connection",
        }),
      });
      setNotice(
        `${kind === "bot" ? "Bot" : "个人账号"}连接记录已删除；来源历史保留；恢复点 ${String(result.snapshotId || "").slice(0, 8)}… 已建立`,
      );
      await refreshParts(["connections", "sources"]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "连接删除失败");
    } finally {
      setBusyArea("connection", false);
    }
  }
  async function discover() {
    setBusyArea("source", true);
    try {
      const result = await api("/api/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "discover" }),
      });
      setNotice(`个人账号会话库已刷新：发现 ${result.discovered} 个群组/频道`);
      await refreshParts(["connections", "sources"]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "会话发现失败");
    } finally {
      setBusyArea("source", false);
    }
  }
  async function checkBot() {
    setBusyArea("connection", true);
    try {
      const result = await api("/api/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "check-bot" }),
      });
      setNotice(
        `Bot 连接验证通过：${result.identity}；webhook 未占用 getUpdates`,
      );
      await refreshParts(["connections"]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Bot 连接验证失败");
    } finally {
      setBusyArea("connection", false);
    }
  }
  async function pullBot() {
    setBusyArea("sync", true);
    const startedAt = performance.now();
    setSyncProgress({
      status: "running",
      phase: "connecting",
      label: "正在连接 Telegram Bot",
      current: 0,
      total: 0,
      page: 0,
      received: 0,
      scanned: 0,
      inserted: 0,
      startedAt,
      remoteMs: 0,
      databaseMs: 0,
      totalMs: 0,
      elapsedMs: 0,
    });
    try {
      const result = await streamHubSync("pull-stream", {}, (progress) =>
        setSyncProgress((current) => ({
          ...(current as HubSyncProgress),
          status: "running",
          phase: String(progress.phase || "pulling"),
          label: String(progress.label || "正在拉取 Telegram Bot"),
          page: Number(progress.page || 0),
          received: Number(progress.received || 0),
          inserted: Number(progress.inserted || 0),
          elapsedMs: performance.now() - startedAt,
        })),
      );
      const timings = hubSyncTimings(result);
      setSyncProgress((current) => ({
        ...(current as HubSyncProgress),
        status: "completed",
        phase: "completed",
        label: "Bot 拉取与安全入库完成",
        remoteMs: timings.remoteMs,
        databaseMs: timings.databaseMs,
        totalMs: timings.totalMs,
        elapsedMs: timings.totalMs || performance.now() - startedAt,
      }));
      setNotice(
        `Bot 全局接收完成：${Number(result.pages || 0)} 页，新增 ${Number(result.inserted || 0)}，编辑 ${Number(result.edited || 0)}，删除 ${Number(result.deleted || 0)}，重复 ${Number(result.duplicates || 0)}，分发队列 ${Number(result.queues || 0)}；网络 ${timings.remoteMs.toFixed(0)} ms，本地 ${timings.databaseMs.toFixed(0)} ms`,
      );
      await refreshParts(["connections", "sources", "syncs"]);
    } catch (error) {
      setSyncProgress((current) =>
        current
          ? {
              ...current,
              status: "failed",
              phase: "failed",
              label: error instanceof Error ? error.message : "Bot 接收失败",
              totalMs: performance.now() - startedAt,
              elapsedMs: performance.now() - startedAt,
            }
          : current,
      );
      setNotice(error instanceof Error ? error.message : "Bot 接收失败");
    } finally {
      setBusyArea("sync", false);
    }
  }
  async function syncPersonal() {
    if (!selectedSources.size) {
      setNotice("请先在会话库选择来源");
      return;
    }
    setBusyArea("sync", true);
    const startedAt = performance.now();
    let completedInserted = 0;
    let completedScanned = 0;
    setSyncProgress({
      status: "running",
      phase: "connecting",
      label: "正在连接 Telegram 个人账号",
      current: 0,
      total: selectedSources.size,
      page: 0,
      received: 0,
      scanned: 0,
      inserted: 0,
      startedAt,
      remoteMs: 0,
      databaseMs: 0,
      totalMs: 0,
      elapsedMs: 0,
    });
    try {
      const result = await streamHubSync(
        "sync-personal-stream",
        {
          sourceIds: [...selectedSources],
          mode: syncMode,
          limit: Number(syncLimit) || 200,
          start: syncStart,
          end: syncEnd,
        },
        (progress) => {
          if (progress.phase === "source_completed") {
            completedInserted += Number(progress.inserted || 0);
            completedScanned += Number(progress.scanned || 0);
          }
          setSyncProgress((current) => ({
            ...(current as HubSyncProgress),
            status: "running",
            phase: String(progress.phase || "pulling"),
            label: String(progress.label || "正在同步个人来源"),
            current: Number(progress.current || 0),
            total: Number(progress.total || selectedSources.size),
            scanned: completedScanned || Number(progress.scanned || 0),
            inserted: completedInserted,
            elapsedMs: performance.now() - startedAt,
          }));
        },
      );
      const timings = hubSyncTimings(result);
      setSyncProgress((current) => ({
        ...(current as HubSyncProgress),
        status: "completed",
        phase: "completed",
        label: "个人来源同步与检查点提交完成",
        current: Number(result.sources || selectedSources.size),
        scanned: Number(result.scanned || 0),
        inserted: Number(result.inserted || 0),
        remoteMs: timings.remoteMs,
        databaseMs: timings.databaseMs,
        totalMs: timings.totalMs,
        elapsedMs: timings.totalMs || performance.now() - startedAt,
      }));
      setNotice(
        `个人账号同步完成：扫描 ${Number(result.scanned || 0)}，新增 ${Number(result.inserted || 0)}，编辑 ${Number(result.edited || 0)}，删除 ${Number(result.deleted || 0)}，重复 ${Number(result.duplicates || 0)}；连接 ${Number((result.timings as Record<string, unknown> | undefined)?.connectionMs || 0).toFixed(0)} ms，远端 ${timings.remoteMs.toFixed(0)} ms，入库 ${timings.databaseMs.toFixed(0)} ms${result.hasMore ? "；仍有后续页" : ""}`,
      );
      await refreshParts(["connections", "sources", "syncs"]);
    } catch (error) {
      setSyncProgress((current) =>
        current
          ? {
              ...current,
              status: "failed",
              phase: "failed",
              label:
                error instanceof Error ? error.message : "个人账号同步失败",
              totalMs: performance.now() - startedAt,
              elapsedMs: performance.now() - startedAt,
            }
          : current,
      );
      setNotice(error instanceof Error ? error.message : "个人账号同步失败");
    } finally {
      setBusyArea("sync", false);
    }
  }
  async function importJson(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusyArea("sync", true);
    try {
      const messages = parseTelegramOfficialJson(JSON.parse(await file.text()));
      const result = await api(
        "/api/telegram",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "import", messages }),
        },
        120_000,
      );
      const timings = result.timings || {};
      setNotice(
        `官方 JSON 已作为单一导入批次处理：扫描 ${Number(result.received || 0).toLocaleString()}，新增 ${Number(result.inserted || 0).toLocaleString()}，重复 ${Number(result.duplicates || 0).toLocaleString()}；哈希 ${Number(timings.hashMs || 0).toFixed(0)} ms，数据库与分发 ${Number(timings.databaseAndDispatchMs || 0).toFixed(0)} ms`,
      );
      await refreshParts(["connections", "sources", "syncs"]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "官方 JSON 导入失败");
    } finally {
      setBusyArea("sync", false);
    }
  }

  const diff = diffCount();
  const originalCurrentBindings = new Set(
    hub.bindings
      .filter((item) => item.tool === selectedTool)
      .map((item) => item.source_id),
  );
  const currentDraftBindings = draftBindings[selectedTool] || new Set<string>();
  const currentToolDiff = {
    added: [...currentDraftBindings].filter(
      (id) => !originalCurrentBindings.has(id),
    ).length,
    removed: [...originalCurrentBindings].filter(
      (id) => !currentDraftBindings.has(id),
    ).length,
  };
  const activeBindingSources = hub.sources.filter((source) => !source.archived);
  const selectedBindingSources = activeBindingSources.filter((source) =>
    currentDraftBindings.has(source.id),
  );
  const filteredBindingSources = activeBindingSources.filter((source) => {
    const before = originalCurrentBindings.has(source.id);
    const after = currentDraftBindings.has(source.id);
    const hasOtherBindings = TELEGRAM_TOOLS.some(
      (tool) =>
        tool !== selectedTool &&
        (draftBindings[tool] || new Set()).has(source.id),
    );
    return (
      matchesTelegramBindingSearch(source, bindingSearch) &&
      matchesTelegramBindingScope(bindingScope, {
        before,
        after,
        hasOtherBindings,
      })
    );
  });
  return (
    <div className="stack-lg telegram-settings">
      <section className="callout telegram-layer-callout">
        <strong>Telegram 三层连接模型</strong>
        <p>
          全局连接 → 全局群组/频道会话库 → 工具永久绑定 →
          工具内本次选择。连接、绑定和本次选择不会再共用一个状态。
        </p>
      </section>
      <section className="settings-tabs" aria-label="Telegram 设置分区">
        {(
          [
            ["connections", "连接账号"],
            ["sources", "会话库"],
            ["bindings", "工具绑定"],
            ["syncs", "同步记录"],
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </section>

      {syncProgress && (
        <section
          className={`operation-progress-card ${syncProgress.status}`}
          aria-live="polite"
        >
          <div className="section-heading">
            <div>
              <span className="eyebrow">Telegram 拉取进度</span>
              <strong>{syncProgress.label}</strong>
            </div>
            <span className="batch-status">
              {syncProgress.status === "running"
                ? syncProgress.total > 0
                  ? `${syncProgress.current}/${syncProgress.total} 个来源`
                  : `第 ${Math.max(1, syncProgress.page)} 页`
                : syncProgress.status === "completed"
                  ? "完成"
                  : "失败"}
            </span>
          </div>
          <div className="progress-track" aria-hidden="true">
            <span
              style={{
                width: `${syncProgress.status === "completed" ? 100 : syncProgress.total > 0 ? Math.max(4, (syncProgress.current / syncProgress.total) * 100) : 35}%`,
              }}
            />
          </div>
          <div className="progress-metrics">
            <span>
              已拉取/扫描{" "}
              {Math.max(syncProgress.received, syncProgress.scanned)}
            </span>
            <span>新增 {syncProgress.inserted}</span>
            <span>已用时 {(syncProgress.elapsedMs / 1_000).toFixed(1)} 秒</span>
            {syncProgress.remoteMs > 0 && (
              <span>远端 {syncProgress.remoteMs.toFixed(0)} ms</span>
            )}
            {syncProgress.databaseMs > 0 && (
              <span>数据库 {syncProgress.databaseMs.toFixed(0)} ms</span>
            )}
            {syncProgress.status === "running" &&
              syncProgress.current > 0 &&
              syncProgress.total > syncProgress.current &&
              syncProgress.elapsedMs > 1_500 && (
                <span>
                  ETA 约
                  {Math.ceil(
                    (syncProgress.elapsedMs / syncProgress.current / 1_000) *
                      (syncProgress.total - syncProgress.current),
                  )}{" "}
                  秒
                </span>
              )}
          </div>
        </section>
      )}

      {tab === "connections" && (
        <div className="stack-md">
          <section className="card">
            <div className="section-heading">
              <div>
                <span className="eyebrow">全局连接</span>
                <h3>Bot API</h3>
              </div>
              <span
                className={`batch-status ${hub.botState?.webhook_status === "clear" ? "applied" : ""}`}
              >
                {hubLoadState === "loading"
                  ? "正在检测"
                  : hubLoadState === "error"
                    ? "读取失败"
                    : !hub.configured
                      ? "未配置"
                      : hub.botState?.webhook_status === "conflict"
                        ? "Webhook 冲突"
                        : hub.botState?.webhook_status === "clear"
                          ? "可接收"
                          : "Secret 已配置"}
              </span>
            </div>
            <p>
              Bot 只在这里配置和消费。全局游标先检查 webhook，再调用唯一一处{" "}
              <code>getUpdates</code>；五个工具不会争抢或重复推进游标。
            </p>
            <div className="button-row">
              <button
                disabled={
                  hubLoadState !== "ready" || !hub.configured || busy.connection
                }
                onClick={checkBot}
              >
                验证身份与 Webhook
              </button>
              <button
                className="primary"
                disabled={
                  hubLoadState !== "ready" ||
                  !hub.configured ||
                  busy.sync ||
                  hub.botState?.webhook_status === "conflict"
                }
                onClick={pullBot}
              >
                手动接收 Bot 更新
              </button>
              <button onClick={() => setTab("sources")}>查看全局会话库</button>
            </div>
          </section>
          <section className="card">
            <div className="section-heading">
              <div>
                <span className="eyebrow">全局连接</span>
                <h3>
                  {mtproto.authorized
                    ? "个人账号 Session 已就绪"
                    : "个人账号 MTProto"}
                </h3>
              </div>
              <span
                className={`batch-status ${mtproto.authorized ? "applied" : ""}`}
              >
                {mtproto.authorized
                  ? "Session 可按需恢复"
                  : mtprotoLoadState === "loading"
                    ? "正在检测"
                    : mtprotoLoadState === "error"
                      ? "读取失败"
                      : "未完成登录"}
              </span>
            </div>
            <p>
              二维码、手机号、验证码、两步验证和加密 Session
              只在这个全局连接中心出现；工具页面不会要求重新登录。Sites Worker
              不保持跨请求长连接，每次发现、同步或已读都会用加密 Session
              按需重连并在请求结束时断开。
            </p>
            <div className="mtproto-config-row">
              <span
                className={`batch-status ${mtprotoLoadState === "ready" && mtproto.apiConfigured ? "applied" : ""}`}
              >
                API{" "}
                {mtprotoLoadState === "loading"
                  ? "检测中"
                  : mtprotoLoadState === "error"
                    ? "读取失败"
                    : mtproto.apiConfigured
                      ? "已配置"
                      : "未配置"}
              </span>
              <span
                className={`batch-status ${mtprotoLoadState === "ready" && mtproto.encryptionConfigured ? "applied" : ""}`}
              >
                Session 加密{" "}
                {mtprotoLoadState === "loading"
                  ? "检测中"
                  : mtprotoLoadState === "error"
                    ? "读取失败"
                    : mtproto.encryptionConfigured
                      ? "已配置"
                      : "未配置"}
              </span>
              <span
                className={`batch-status ${mtproto.transport === "cloudflare_tcp_with_websocket_fallback" ? "applied" : ""}`}
              >
                请求级 TCP → WebSocket 回退
              </span>
            </div>
            {mtproto.authorized ? (
              <div className="mtproto-account">
                <div>
                  <span className="status-dot" />
                  <strong>{mtproto.accountLabel || "Telegram 账号"}</strong>
                  <small>Session 已加密保存；手机号不会显示或写入日志。</small>
                </div>
                <div className="button-row">
                  <button
                    disabled={busy.connection}
                    onClick={() => runAction("restore")}
                  >
                    验证并恢复 Session
                  </button>
                  <button
                    className="danger"
                    disabled={busy.connection}
                    onClick={() => runAction("logout")}
                  >
                    退出并删除网站 Session
                  </button>
                </div>
              </div>
            ) : (
              <div className="mtproto-login-grid">
                <div className="mtproto-login-method">
                  <h4>二维码登录</h4>
                  {mtproto.stage === "waiting_qr" && qrImage ? (
                    <div className="qr-login">
                      <Image
                        unoptimized
                        src={qrImage}
                        alt="Telegram 一次性登录二维码"
                        width={280}
                        height={280}
                      />
                      <p>Telegram 手机端 → 设置 → 设备 → 链接桌面设备</p>
                      <small>
                        {qrExpiresAt
                          ? `有效期至 ${new Date(qrExpiresAt).toLocaleTimeString("zh-CN")}`
                          : "二维码会自动刷新"}
                      </small>
                    </div>
                  ) : (
                    <p>扫码后网站会在全局连接中心恢复登录状态。</p>
                  )}
                  <button
                    className="primary"
                    disabled={
                      busy.connection ||
                      !mtproto.apiConfigured ||
                      !mtproto.encryptionConfigured ||
                      mtproto.stage === "waiting_code" ||
                      mtproto.stage === "waiting_password"
                    }
                    onClick={() =>
                      runAction(
                        mtproto.stage === "waiting_qr" ? "poll-qr" : "start-qr",
                      )
                    }
                  >
                    {mtproto.stage === "waiting_qr"
                      ? "立即检查扫码"
                      : "生成登录二维码"}
                  </button>
                </div>
                <div className="mtproto-login-method">
                  <h4>手机号登录</h4>
                  {mtproto.stage === "waiting_password" ? (
                    <label className="field">
                      <span>两步验证密码</span>
                      <input
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        placeholder="只在本次请求中使用"
                      />
                    </label>
                  ) : (
                    <>
                      <label className="field">
                        <span>国际格式手机号</span>
                        <input
                          type="tel"
                          autoComplete="tel"
                          value={phone}
                          onChange={(event) => setPhone(event.target.value)}
                          placeholder="例如 +6591234567"
                        />
                      </label>
                      {mtproto.stage === "waiting_code" && (
                        <label className="field">
                          <span>Telegram 验证码</span>
                          <input
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            value={code}
                            onChange={(event) => setCode(event.target.value)}
                            placeholder="4–8 位验证码"
                          />
                        </label>
                      )}
                    </>
                  )}
                  {mtproto.stage === "waiting_password" ? (
                    <button
                      className="primary"
                      disabled={busy.connection || !password}
                      onClick={() => runAction("submit-password", { password })}
                    >
                      提交两步验证密码
                    </button>
                  ) : mtproto.stage === "waiting_code" ? (
                    <button
                      className="primary"
                      disabled={busy.connection || !phone || !code}
                      onClick={() => runAction("submit-code", { phone, code })}
                    >
                      提交验证码
                    </button>
                  ) : (
                    <button
                      disabled={
                        busy.connection ||
                        !phone ||
                        !mtproto.apiConfigured ||
                        !mtproto.encryptionConfigured ||
                        mtproto.stage === "waiting_qr"
                      }
                      onClick={() => runAction("start-phone", { phone })}
                    >
                      发送验证码
                    </button>
                  )}
                </div>
              </div>
            )}
            {!mtproto.authorized && mtproto.stage !== "idle" && (
              <div className="button-row mtproto-cancel-row">
                <span className="subtle">当前阶段：{mtproto.stage}</span>
                <button
                  className="danger"
                  disabled={busy.connection}
                  onClick={() => runAction("cancel")}
                >
                  取消并解锁
                </button>
              </div>
            )}
            <details className="mtproto-probe">
              <summary>Telegram 传输端点诊断</summary>
              <div className="button-row">
                <button
                  disabled={busy.connection}
                  onClick={probeMtprotoChannel}
                >
                  仅检测 TCP 与 WebSocket 可达性
                </button>
                {probe && (
                  <>
                    <span
                      className={`batch-status ${probe.tcpReachable ? "applied" : ""}`}
                    >
                      TCP {probe.tcpReachable ? "可达" : "失败"} ·{" "}
                      {probe.tcpElapsedMs} ms
                    </span>
                    <span
                      className={`batch-status ${probe.websocketReachable ? "applied" : ""}`}
                    >
                      WebSocket {probe.websocketReachable ? "可达" : "失败"} ·{" "}
                      {probe.websocketElapsedMs} ms
                    </span>
                  </>
                )}
              </div>
              {probe && (
                <small>
                  {probe.conclusion}；端点可达不等于 MTProto 授权或 Session
                  恢复成功。
                </small>
              )}
            </details>
          </section>
          <section className="card">
            <span className="eyebrow">持久状态（不是常驻 Socket）</span>
            <div className="connection-grid">
              {hub.connections.map((connection) => (
                <article
                  key={connection.connection_id}
                  className="connection-card"
                >
                  <div>
                    <strong>
                      {connection.label || connection.connection_id}
                    </strong>
                    <small>
                      {connection.kind === "personal"
                        ? "个人 API"
                        : connection.kind === "bot"
                          ? "Bot API"
                          : "文件导入"}{" "}
                      · {connection.network_status || "未知网络"}
                    </small>
                  </div>
                  <span
                    className={`batch-status ${["connected", "ready", "session_ready"].includes(connection.status) ? "applied" : ""}`}
                  >
                    {connection.status}
                  </span>
                  {connection.last_error && (
                    <p className="error-text">{connection.last_error}</p>
                  )}
                </article>
              ))}
            </div>
          </section>
        </div>
      )}

      {tab === "sources" && (
        <section className="card">
          <div className="source-toolbar">
            <select
              value={sourceAccess}
              onChange={(event) => setSourceAccess(event.target.value)}
            >
              <option value="">全部访问状态</option>
              <option value="accessible">可访问</option>
              <option value="inaccessible">不可访问</option>
            </select>
            <button onClick={() => setIncludeArchived((value) => !value)}>
              {includeArchived ? "隐藏已停用来源" : "显示已停用来源"}
            </button>
          </div>
        </section>
      )}
      {tab === "sources" && (
        <div className="stack-md">
          <section className="card">
            <div className="section-heading">
              <div>
                <span className="eyebrow">全局来源</span>
                <h3>{hub.sources.length.toLocaleString()} 个群组 / 频道</h3>
              </div>
              <span className="subtle">最多按 100 个来源设计</span>
            </div>
            <div className="button-row">
              <button
                className="primary"
                disabled={busy.source || !mtproto.authorized}
                onClick={discover}
              >
                刷新个人账号会话
              </button>
              <label className="file-button">
                <input
                  type="file"
                  accept=".json"
                  disabled={busy.sync}
                  onChange={importJson}
                />
                导入 Telegram 官方 JSON
              </label>
              <button
                onClick={() =>
                  setSelectedSources(
                    new Set(filteredSources.map((source) => source.id)),
                  )
                }
              >
                全选当前筛选
              </button>
              <button onClick={() => setSelectedSources(new Set())}>
                清空选择
              </button>
            </div>
            <div className="source-toolbar">
              <input
                value={sourceSearch}
                onChange={(event) => setSourceSearch(event.target.value)}
                placeholder="搜索名称、用户名、Telegram ID"
              />
              <select
                value={sourceType}
                onChange={(event) => setSourceType(event.target.value)}
              >
                <option value="">全部类型</option>
                <option value="group">普通群</option>
                <option value="supergroup">超级群</option>
                <option value="channel">广播频道</option>
              </select>
            </div>
            <div className="source-action-row">
              <select
                value={syncMode}
                onChange={(event) =>
                  setSyncMode(event.target.value as typeof syncMode)
                }
              >
                <option value="incremental">从最新位置增量</option>
                <option value="recent">最近 N 条（不推进增量）</option>
                <option value="range">指定时间范围（不推进增量）</option>
                <option value="history">从本地最早处继续（不推进增量）</option>
              </select>
              <input
                type="number"
                min="1"
                max="20000"
                value={syncLimit}
                onChange={(event) => setSyncLimit(event.target.value)}
              />
              <input
                type="datetime-local"
                value={syncStart}
                onChange={(event) => setSyncStart(event.target.value)}
              />
              <input
                type="datetime-local"
                value={syncEnd}
                onChange={(event) => setSyncEnd(event.target.value)}
              />
              <button
                disabled={
                  busy.sync || !selectedSources.size || !mtproto.authorized
                }
                onClick={syncPersonal}
              >
                同步所选个人来源
              </button>
            </div>
          </section>
          <section className="card source-table-wrap">
            <div className="source-table desktop-only">
              <div className="source-table-head">
                <span>会话</span>
                <span>类型 / ID</span>
                <span>连接</span>
                <span>本地状态</span>
                <span>已读策略</span>
                <span>安全已读</span>
                <span />
              </div>
              {filteredSources.map((source) => {
                const readState = hub.readStates.find(
                  (row) => String(row.source_id) === source.id,
                );
                return (
                  <div
                    className={`source-table-row ${selectedSources.has(source.id) ? "selected" : ""}`}
                    key={source.id}
                  >
                    <label>
                      <input
                        type="checkbox"
                        checked={selectedSources.has(source.id)}
                        onChange={() => toggleSource(source.id)}
                      />
                      <strong>{source.name}</strong>
                      <small>
                        {source.username
                          ? `@${source.username.replace(/^@/, "")}`
                          : "无用户名"}
                      </small>
                    </label>
                    <span>
                      {source.chat_type || "未知"}
                      <small>{source.external_chat_id}</small>
                    </span>
                    <span>
                      {source.connection_id === "telegram-personal"
                        ? "个人 API"
                        : source.connection_id === "telegram-bot"
                          ? "Bot"
                          : "导入"}
                    </span>
                    <span>
                      {Number(source.message_count || 0).toLocaleString()} 条
                      <small>
                        待处理{" "}
                        {Number(source.pending_count || 0).toLocaleString()} ·{" "}
                        {source.access_status}
                      </small>
                    </span>
                    <select
                      value={String(readState?.policy || "never")}
                      onChange={(event) =>
                        updateSource(source.id, {
                          readPolicy: event.target.value,
                        })
                      }
                    >
                      <option value="safe_auto">safe_auto</option>
                      <option value="never">never</option>
                      <option value="manual">manual</option>
                    </select>
                    <button
                      disabled={
                        busy.source ||
                        source.connection_id !== "telegram-personal" ||
                        String(readState?.policy || "never") === "never" ||
                        !String(readState?.safe_read_message_id || "")
                      }
                      onClick={() => markRead(source.id)}
                    >
                      至 {String(readState?.safe_read_message_id || "-")}
                    </button>
                    <button
                      onClick={() =>
                        updateSource(source.id, {
                          archived: !Boolean(source.archived),
                        })
                      }
                    >
                      {source.archived ? "重新启用" : "停用"}
                    </button>
                  </div>
                );
              })}
              {!filteredSources.length && (
                <div className="empty compact">
                  <strong>没有符合条件的会话</strong>
                  <p>先完成全局连接、刷新会话或导入官方 JSON。</p>
                </div>
              )}
            </div>
            <div className="mobile-source-list mobile-only">
              {filteredSources.map((source) => (
                <label key={source.id} className="mobile-source-card">
                  <input
                    type="checkbox"
                    checked={selectedSources.has(source.id)}
                    onChange={() => toggleSource(source.id)}
                  />
                  <strong>{source.name}</strong>
                  <small>
                    {source.chat_type} · {source.external_chat_id} ·{" "}
                    {source.connection_id}
                  </small>
                  <small>
                    {Number(source.message_count || 0).toLocaleString()} 条 ·
                    待处理 {Number(source.pending_count || 0).toLocaleString()}
                  </small>
                </label>
              ))}
            </div>
          </section>
        </div>
      )}

      {tab === "bindings" && (
        <section className="card binding-editor-card">
          <div className="section-heading">
            <div>
              <span className="eyebrow">当前工具绑定编辑器</span>
              <h3>{TELEGRAM_TOOL_LABELS[selectedTool]}</h3>
            </div>
            <div className="button-row">
              <span className="batch-status pending-add">
                当前工具待新增 {currentToolDiff.added}
              </span>
              <span className="batch-status pending-remove">
                当前工具待移除 {currentToolDiff.removed}
              </span>
              <button
                className="primary"
                disabled={busy.binding}
                onClick={saveBindings}
              >
                一次提交全部变化
              </button>
            </div>
          </div>
          <p>
            默认只编辑当前工具，避免误触其他工具。每个来源同时显示其他工具已有绑定；取消当前工具绑定不会删除历史、正文或其他工具队列。
          </p>
          <div className="binding-controls">
            <label>
              <span>当前工具</span>
              <select
                value={selectedTool}
                onChange={(event) => setSelectedTool(event.target.value)}
              >
                {TELEGRAM_TOOLS.map((tool) => (
                  <option key={tool} value={tool}>
                    {TELEGRAM_TOOL_LABELS[tool]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>新增绑定历史范围</span>
              <select
                value={historyMode}
                onChange={(event) =>
                  setHistoryMode(event.target.value as typeof historyMode)
                }
              >
                <option value="since_now">从现在开始（默认）</option>
                <option value="cached">使用现有本地缓存</option>
                <option value="recent">回拉最近 N 条</option>
                <option value="from_date">从指定时间开始</option>
              </select>
            </label>
            <input
              type="number"
              min="0"
              max="20000"
              value={historyLimit}
              onChange={(event) => setHistoryLimit(event.target.value)}
              placeholder="最近 N 条"
            />
            <input
              type="datetime-local"
              value={historyFrom}
              onChange={(event) => setHistoryFrom(event.target.value)}
            />
          </div>
          <div
            className="binding-selection-overview"
            aria-label="当前工具绑定概览"
          >
            <span>
              <strong>{selectedBindingSources.length}</strong> 当前选择
            </span>
            <span>
              <strong>{activeBindingSources.length}</strong> 可选群组/频道
            </span>
            <span>
              <strong>{currentToolDiff.added + currentToolDiff.removed}</strong>{" "}
              待保存变化
            </span>
          </div>
          <details className="binding-source-disclosure">
            <summary>
              <span>
                <strong>选择群组 / 频道</strong>
                <small>默认收起，点击后搜索并勾选</small>
              </span>
              <span className="binding-summary-count">
                已选 {selectedBindingSources.length} /{" "}
                {activeBindingSources.length}
              </span>
            </summary>
            <div className="binding-picker-body">
              <div className="binding-picker-toolbar">
                <label className="binding-search-field">
                  <span>搜索群组</span>
                  <input
                    type="search"
                    value={bindingSearch}
                    onChange={(event) => setBindingSearch(event.target.value)}
                    placeholder="搜索群组名称、@用户名或 Telegram ID"
                    aria-label="搜索待绑定群组"
                  />
                </label>
                <label>
                  <span>显示范围</span>
                  <select
                    value={bindingScope}
                    onChange={(event) =>
                      setBindingScope(
                        event.target.value as TelegramBindingScope,
                      )
                    }
                  >
                    <option value="all">全部群组</option>
                    <option value="bound">当前已选择</option>
                    <option value="unbound">尚未选择</option>
                    <option value="changed">仅待保存变化</option>
                    <option value="other">已绑定其他工具</option>
                  </select>
                </label>
                <button
                  type="button"
                  disabled={!bindingSearch && bindingScope === "all"}
                  onClick={() => {
                    setBindingSearch("");
                    setBindingScope("all");
                  }}
                >
                  清除筛选
                </button>
              </div>
              <div className="binding-results-meta" aria-live="polite">
                <span>显示 {filteredBindingSources.length} 个结果</span>
                <small>普通单击即可勾选，不需要 Ctrl 或 Shift</small>
              </div>
              <div className="current-tool-binding-list">
                {filteredBindingSources.map((source) => {
                  const before = originalCurrentBindings.has(source.id);
                  const after = currentDraftBindings.has(source.id);
                  const state =
                    !before && after
                      ? "pending-add"
                      : before && !after
                        ? "pending-remove"
                        : after
                          ? "bound"
                          : "unbound";
                  const otherTools = TELEGRAM_TOOLS.filter(
                    (tool) =>
                      tool !== selectedTool &&
                      (draftBindings[tool] || new Set()).has(source.id),
                  );
                  return (
                    <label
                      key={source.id}
                      className={`current-binding-row ${state}`}
                    >
                      <input
                        type="checkbox"
                        checked={after}
                        onChange={() => toggleBinding(selectedTool, source.id)}
                      />
                      <span>
                        <strong>{source.name}</strong>
                        <small>
                          {source.username
                            ? `@${source.username.replace(/^@/, "")} · `
                            : ""}
                          {source.chat_type} · {source.external_chat_id}
                        </small>
                      </span>
                      <span className={`binding-state ${state}`}>
                        {state === "pending-add"
                          ? "待新增"
                          : state === "pending-remove"
                            ? "待移除"
                            : state === "bound"
                              ? "当前已绑定"
                              : "未绑定"}
                      </span>
                      <small className="other-bindings">
                        其他工具：
                        {otherTools.length
                          ? otherTools
                              .map((tool) => TELEGRAM_TOOL_LABELS[tool])
                              .join("、")
                          : "无"}
                      </small>
                    </label>
                  );
                })}
                {!filteredBindingSources.length && (
                  <div className="empty compact binding-empty">
                    <strong>没有符合条件的群组</strong>
                    <p>尝试清除搜索词或切换显示范围。</p>
                  </div>
                )}
              </div>
            </div>
          </details>
          <details className="advanced-binding-matrix">
            <summary>
              高级入口：查看和编辑五列全局矩阵（总待新增 {diff.added} / 待移除{" "}
              {diff.removed}）
            </summary>
            <div className="binding-matrix">
              <div className="binding-matrix-head">
                <span>会话</span>
                {TELEGRAM_TOOLS.map((tool) => (
                  <span key={tool}>
                    {TELEGRAM_TOOL_LABELS[tool]}
                    <small>{(draftBindings[tool] || new Set()).size} 个</small>
                  </span>
                ))}
              </div>
              {filteredBindingSources.map((source) => (
                <div className="binding-matrix-row" key={source.id}>
                  <div>
                    <strong>{source.name}</strong>
                    <small>
                      {source.chat_type} · {source.external_chat_id}
                    </small>
                  </div>
                  {TELEGRAM_TOOLS.map((tool) => (
                    <label
                      key={tool}
                      className={`binding-cell ${tool === selectedTool ? "current-tool" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={(draftBindings[tool] || new Set()).has(
                          source.id,
                        )}
                        onChange={() => toggleBinding(tool, source.id)}
                        aria-label={`${source.name} · ${TELEGRAM_TOOL_LABELS[tool]}`}
                      />
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </details>
        </section>
      )}

      {tab === "syncs" && (
        <section className="card">
          <div className="section-heading">
            <div>
              <span className="eyebrow">只读审计</span>
              <h3>同步记录</h3>
            </div>
            <button onClick={load}>刷新</button>
          </div>
          <div className="sync-table">
            {hub.syncRuns.map((run) => (
              <article key={String(run.id)}>
                <div>
                  <strong>
                    {String(run.transport)} · {String(run.mode)}
                  </strong>
                  <small>
                    {String(run.started_at)} →{" "}
                    {String(run.ended_at || "进行中")}
                  </small>
                </div>
                <span
                  className={`batch-status ${run.status === "completed" ? "applied" : ""}`}
                >
                  {String(run.status)}
                  {Number(run.has_more || 0) ? " · 有后续页" : ""}
                </span>
                <p>
                  扫描 {Number(run.scanned_count || 0).toLocaleString()} · 新增{" "}
                  {Number(run.inserted_count || 0).toLocaleString()} · 编辑{" "}
                  {Number(run.edited_count || 0).toLocaleString()} · 删除{" "}
                  {Number(run.deleted_count || 0).toLocaleString()} · 重复{" "}
                  {Number(run.duplicate_count || 0).toLocaleString()} · 队列{" "}
                  {Number(run.queue_count || 0).toLocaleString()} · 已读{" "}
                  {String(run.read_result || "not_attempted")}
                </p>
                {String(run.error_message || "").length > 0 && (
                  <small className="error-text">
                    {String(run.error_message)}
                  </small>
                )}
              </article>
            ))}
            {!hub.syncRuns.length && (
              <div className="empty compact">
                <strong>还没有同步记录</strong>
                <p>Bot、个人 API 或官方导入完成后会在这里保留审计记录。</p>
              </div>
            )}
          </div>
        </section>
      )}
      {tab === "connections" && (
        <section className="card">
          <span className="eyebrow">连接维护</span>
          <p className="subtle">
            删除连接只删除对应网站连接状态；来源、消息正文、绑定和工具结果保留。
          </p>
          <div className="button-row">
            <button
              className="danger"
              disabled={busy.connection}
              onClick={() => deleteConnection("bot")}
            >
              删除 Bot 连接记录
            </button>
            <button
              className="danger"
              disabled={busy.connection || !mtproto.authorized}
              onClick={() => deleteConnection("personal")}
            >
              删除个人连接并注销
            </button>
          </div>
        </section>
      )}
      {notice && <div className="notice">{notice}</div>}
    </div>
  );
}
