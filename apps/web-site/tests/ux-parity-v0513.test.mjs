import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadModule, projectFile } from "./helpers/bundle.mjs";

const selection = await loadModule("lib/table-selection.ts");
const taskStatus = await loadModule("lib/task-status.ts");
const bindingFilter = await loadModule("lib/telegram-binding-filter.ts");

test("一级导航严格保留六项，历史、规则、迁移、恢复点和 Windows 说明进入二级页面", async () => {
  const source = await readFile(projectFile("app/workbench.tsx"), "utf8");
  const navBlock = source.match(/const NAV:[\s\S]*?\n\];/)?.[0] || "";
  for (const label of [
    "工具首页",
    "处理中心",
    "数据中心",
    "Telegram",
    "日志",
    "设置",
  ])
    assert.match(navBlock, new RegExp(label));
  for (const label of ["处理历史", "规则库", "迁移", "恢复点", "Windows 说明"])
    assert.doesNotMatch(navBlock, new RegExp(label));
  assert.match(source, /const DATA_TABS/);
  assert.match(source, /Windows 说明/);
  assert.match(source, /TG 内容工具箱/);
});

test("首页五张卡直达五个独立路由，各工具使用自己的 Windows 对齐阶段", async () => {
  const workbench = await readFile(projectFile("app/workbench.tsx"), "utf8");
  const panel = await readFile(
    projectFile("app/components/tool-panel.tsx"),
    "utf8",
  );
  for (const tool of ["twitter", "badnews", "haijiao", "missav", "av123"])
    assert.match(panel, new RegExp(`id: "${tool}"`));
  for (const stage of [
    "1 输入",
    "2 结果",
    "3 历史",
    "3 浏览器脚本",
    "4 历史",
    "3 本地任务",
  ])
    assert.match(panel, new RegExp(stage));
  assert.match(workbench, /`#tool\/\$\{tool\}`/);
  assert.match(workbench, /kind === "tool"/);
  assert.match(panel, /手动 \/ 文件/);
  assert.match(panel, /Telegram 消息/);
  assert.match(workbench, /openTool\(tool\.id\)/);
  assert.match(
    workbench,
    /TOOL_DEFINITIONS\.map\(\(definition\) => <div key=\{definition\.id\}/,
  );
  assert.match(
    workbench,
    /hidden=\{view !== "tool" \|\| activeTool !== definition\.id\}/,
  );
  assert.doesNotMatch(panel, /setTool\(/);
});

test("工具内刷新同步只接受当前工具已绑定来源并复用全局游标和检查点", async () => {
  const panel = await readFile(
    projectFile("app/components/telegram-panel.tsx"),
    "utf8",
  );
  const route = await readFile(
    projectFile("app/api/telegram/route.ts"),
    "utf8",
  );
  const server = await readFile(projectFile("lib/server-telegram.ts"), "utf8");
  for (const label of [
    "刷新同步消息",
    "历史回拉",
    "一键处理所有未处理",
    "复制所选消息",
  ])
    assert.match(panel, new RegExp(label));
  assert.match(route, /sync-tool-sources/);
  assert.match(route, /resolveBoundToolSyncSources/);
  assert.match(route, /pullTelegramBot\(\)/);
  assert.match(
    server,
    /JOIN tool_source_bindings b ON b\.source_id=s\.id AND b\.tool=\?/,
  );
  assert.match(panel, /复用全局连接、Bot offset、统一消息池与来源检查点/);
  assert.doesNotMatch(
    panel,
    /start-phone|start-qr|TELEGRAM_BOT_TOKEN|fetch\([^)]*getUpdates/,
  );
});

test("默认绑定编辑器突出当前工具、待新增待移除及其他工具绑定，高级入口保留五列矩阵", async () => {
  const settings = await readFile(
    projectFile("app/components/telegram-settings.tsx"),
    "utf8",
  );
  for (const label of [
    "当前工具绑定编辑器",
    "当前工具待新增",
    "当前工具待移除",
    "其他工具：",
    "高级入口：查看和编辑五列全局矩阵",
  ])
    assert.match(settings, new RegExp(label));
  assert.match(settings, /initialTool/);
  assert.match(settings, /current-binding-row/);
});

test("Telegram 全局中心拆分连接、来源、绑定和同步刷新，并显示真实流式进度", async () => {
  const settings = await readFile(
    projectFile("app/components/telegram-settings.tsx"),
    "utf8",
  );
  const route = await readFile(
    projectFile("app/api/telegram/route.ts"),
    "utf8",
  );
  const server = await readFile(projectFile("lib/server-telegram.ts"), "utf8");
  for (const view of ["connections", "sources", "bindings", "syncs"]) {
    assert.ok(route.includes(`params.get("view") === "${view}"`));
    assert.ok(settings.includes(`view=${view}`));
  }
  for (const area of ["connection", "sync", "binding", "source"])
    assert.match(settings, new RegExp(`busy\\.${area}`));
  for (const token of [
    "pull-stream",
    "sync-personal-stream",
    "Telegram 拉取进度",
    "remoteMs",
    "databaseMs",
    "ETA",
  ])
    assert.match(`${route}\n${settings}`, new RegExp(token));
  assert.match(settings, /官方 JSON 已作为单一导入批次处理/);
  assert.doesNotMatch(settings, /messages\.slice\([^)]*,\s*10\)/);
  assert.match(
    server,
    /telegram_tool_queue_tool_status_date_id_idx|message_date/,
  );
});

test("群组绑定面板默认折叠，并支持名称、用户名、ID 搜索和状态筛选", async () => {
  const settings = await readFile(
    projectFile("app/components/telegram-settings.tsx"),
    "utf8",
  );
  for (const label of [
    "选择群组 / 频道",
    "默认收起，点击后搜索并勾选",
    "搜索群组名称、@用户名或 Telegram ID",
    "仅待保存变化",
    "已绑定其他工具",
    "清除筛选",
  ])
    assert.match(settings, new RegExp(label));
  assert.match(settings, /<details className="binding-source-disclosure">/);
  assert.doesNotMatch(
    settings,
    /<details className="binding-source-disclosure" open/,
  );
  assert.match(settings, /filteredBindingSources\.map/);

  const source = {
    name: "摄影交流群",
    username: "Photo_Group",
    external_chat_id: "-1009988",
    chat_type: "supergroup",
  };
  assert.equal(
    bindingFilter.matchesTelegramBindingSearch(source, "摄影"),
    true,
  );
  assert.equal(
    bindingFilter.matchesTelegramBindingSearch(source, "@photo_group"),
    true,
  );
  assert.equal(
    bindingFilter.matchesTelegramBindingSearch(source, "-1009988"),
    true,
  );
  assert.equal(
    bindingFilter.matchesTelegramBindingSearch(source, "不存在"),
    false,
  );
  assert.equal(
    bindingFilter.matchesTelegramBindingScope("changed", {
      before: false,
      after: true,
      hasOtherBindings: false,
    }),
    true,
  );
  assert.equal(
    bindingFilter.matchesTelegramBindingScope("bound", {
      before: true,
      after: false,
      hasOtherBindings: false,
    }),
    false,
  );
  assert.equal(
    bindingFilter.matchesTelegramBindingScope("other", {
      before: false,
      after: false,
      hasOtherBindings: true,
    }),
    true,
  );
});

test("表格选择支持单击替换、Ctrl 切换、Shift 区间及 Ctrl+Shift 追加", () => {
  const page = ["a", "b", "c", "d"];
  let state = { mode: "ids", ids: new Set() };
  let anchor = null;
  ({ selection: state, anchor } = selection.toggleTableRow(
    state,
    page,
    1,
    anchor,
    {},
  ));
  assert.deepEqual([...state.ids], ["b"]);
  ({ selection: state, anchor } = selection.toggleTableRow(
    state,
    page,
    3,
    anchor,
    { ctrlKey: true },
  ));
  assert.deepEqual([...state.ids], ["b", "d"]);
  ({ selection: state, anchor } = selection.toggleTableRow(
    state,
    page,
    1,
    anchor,
    { shiftKey: true },
  ));
  assert.deepEqual([...state.ids], ["b", "c", "d"]);
  ({ selection: state, anchor } = selection.toggleTableRow(
    state,
    page,
    0,
    anchor,
    { shiftKey: true, ctrlKey: true },
  ));
  assert.deepEqual([...state.ids].sort(), ["a", "b", "c", "d"]);
});

test("旧任务阶段映射到八个统一中文状态", () => {
  assert.equal(taskStatus.taskStatusLabel("new"), "待处理");
  assert.equal(taskStatus.taskStatusLabel("website"), "运行中");
  assert.equal(taskStatus.taskStatusLabel("review"), "需要人工处理");
  assert.equal(taskStatus.taskStatusLabel("error"), "等待重试");
  assert.equal(taskStatus.taskStatusLabel("failed"), "等待重试");
  assert.equal(taskStatus.taskStatusLabel("retrying"), "等待重试");
  assert.equal(taskStatus.taskStatusLabel("partial_success"), "部分完成");
  assert.equal(taskStatus.taskStatusLabel("needs_review"), "需要人工处理");
  assert.equal(taskStatus.taskStatusLabel("canceled"), "已取消");
  assert.equal(taskStatus.taskStatusLabel("done"), "已完成");
  assert.equal(taskStatus.taskStatusLabel("completed"), "已完成");
  assert.deepEqual(taskStatus.TASK_STATUSES, [
    "pending",
    "running",
    "paused",
    "completed",
    "partial_completed",
    "retry_waiting",
    "needs_manual",
    "cancelled",
  ]);
});

test("结果、消息、任务和历史表保留键盘、筛选、分页、列设置、手机卡片和导出语义", async () => {
  const files = await Promise.all(
    [
      "app/components/result-table.tsx",
      "app/components/telegram-panel.tsx",
      "app/components/task-center.tsx",
      "app/components/history-panel.tsx",
    ].map((file) => readFile(projectFile(file), "utf8")),
  );
  for (const source of files) {
    for (const token of ["Delete", "Enter", "Arrow", "列设置", "全选筛选结果"])
      assert.match(source, new RegExp(token));
    assert.match(source, /key\.toLowerCase\(\) === "a"/);
    assert.match(
      source,
      /mobile-(?:table-card|result-cards|telegram-list|task-list|history-list)/,
    );
  }
  assert.match(files[0], /TXT/);
  assert.match(files[1], /CSV/);
  assert.match(files[2], /export/);
  const css = await readFile(projectFile("app/globals.css"), "utf8");
  assert.match(
    css,
    /@media\(max-width:760px\)\{\.mobile-result-cards,.mobile-task-list,.mobile-telegram-list,.mobile-history-list\{display:grid\}\}/,
  );
  assert.doesNotMatch(
    css,
    /\.mobile-result-cards,.mobile-task-list,.mobile-telegram-list\{display:grid/,
  );
});

test("批量操作栏文字高对比可见，并按处理状态与复制导出分组", async () => {
  const panel = await readFile(
    projectFile("app/components/telegram-panel.tsx"),
    "utf8",
  );
  const css = await readFile(projectFile("app/globals.css"), "utf8");
  for (const label of [
    "当前选择",
    "处理状态",
    "标为已忽略",
    "恢复待处理",
    "复制 / 导出",
    "复制所选消息",
    "导出 TXT",
    "导出 CSV",
    "清除选择",
  ]) {
    assert.match(panel, new RegExp(label.replace("/", "\\/")));
  }
  assert.match(panel, /className="bulkbar telegram-bulkbar"/);
  assert.match(
    css,
    /\.bulkbar button:not\(\.primary\)\{[^}]*background:#f8fcf7;[^}]*color:#264a35/,
  );
  assert.match(
    css,
    /\.bulkbar button\.primary\{[^}]*background:#1f7448;[^}]*color:#fff/,
  );
  assert.match(
    css,
    /\.telegram-bulkbar\{position:static;display:grid;grid-template-columns:1fr/,
  );
  assert.match(css, /\.bulkbar-buttons button\{min-height:40px/);
});

test("已清理和无结果噪声不进入工作列表，处理进度与结果执行面板形成完整数据流", async () => {
  const panel = await readFile(
    projectFile("app/components/telegram-panel.tsx"),
    "utf8",
  );
  const route = await readFile(
    projectFile("app/api/telegram/route.ts"),
    "utf8",
  );
  const server = await readFile(projectFile("lib/server-telegram.ts"), "utf8");
  const toolPanel = await readFile(
    projectFile("app/components/tool-panel.tsx"),
    "utf8",
  );
  const css = await readFile(projectFile("app/globals.css"), "utf8");

  assert.match(server, /if \(!input\.includeCleaned\)/);
  assert.match(server, /COALESCE\(m\.body_deleted_at,''\)/);
  assert.match(server, /telegramQueueRowHasCandidate/);
  assert.match(server, /candidateHintClause/);
  assert.match(route, /includeNoise/);
  assert.doesNotMatch(panel, /显示已清理记录（仅审计）/);
  assert.doesNotMatch(panel, /原始正文已清理/);
  assert.match(panel, /条可处理消息/);
  assert.match(panel, /formatMessageDate/);
  assert.match(route, /process-stream/);
  assert.match(route, /ReadableStream/);
  assert.match(server, /onProgress/);
  for (const label of [
    "正在建立操作前恢复点",
    "正在按当前工具规则处理消息",
    "正在保存结果与处理历史",
    "处理完成，结果已送入结果面板",
  ]) {
    assert.match(server, new RegExp(label));
  }
  for (const label of ["处理进度", "已提取", "已用时"])
    assert.match(panel, new RegExp(label));
  assert.match(panel, /onProcessed\(result\)/);
  assert.match(toolPanel, /receiveTelegramResults/);
  assert.match(toolPanel, /const next = Array\.isArray\(result\.results\)/);
  assert.match(toolPanel, /setResults\(next\)/);
  for (const label of [
    "2 结果",
    "Telegram 处理完成并已保存历史",
    "当前作用范围",
    "TXT",
    "独立工具工作区",
  ]) {
    assert.match(toolPanel, new RegExp(label));
  }
  assert.match(css, /\.operation-progress-card/);
  assert.match(css, /\.result-stage-actions/);
});

test("五个结果页默认显示字段级纯文本，并分别复制当前筛选或所选范围", async () => {
  const output = await loadModule("lib/tool-output.ts");
  const panel = await readFile(
    projectFile("app/components/plain-output-panel.tsx"),
    "utf8",
  );
  const rows = [
    {
      resultKey: "a",
      primaryValue: "Alice",
      secondaryValue: "https://x.com/Alice",
      status: "success",
      tags: [],
      source: "one",
    },
    {
      resultKey: "b",
      primaryValue: "alice",
      secondaryValue: "https://example.com/not-trusted",
      status: "success",
      tags: [],
      source: "two",
    },
    {
      resultKey: "c",
      primaryValue: "Bob",
      secondaryValue: "https://twitter.com/Bob",
      status: "success",
      tags: [],
      source: "three",
    },
  ];
  assert.deepEqual(output.toolOutputFields("twitter", rows), [
    { key: "primary", label: "博主名", values: ["Alice", "Bob"] },
    {
      key: "secondary",
      label: "主页链接",
      values: ["https://x.com/Alice", "https://twitter.com/Bob"],
    },
  ]);
  assert.deepEqual(
    output.toolOutputFields("badnews", [
      { ...rows[0], primaryValue: "https://bad.news/t/1" },
    ]),
    [
      {
        key: "primary",
        label: "帖子直达链接",
        values: ["https://bad.news/t/1"],
      },
    ],
  );
  for (const label of [
    "复制当前筛选",
    "复制所选",
    "浏览器拒绝访问剪贴板",
    "一行一个",
  ])
    assert.match(panel, new RegExp(label));
  assert.doesNotMatch(panel, /join\("\\t"\)/);
});

test("提取保存使用隐藏暂存运行与最终 D1 批量提交，失败不会形成可见半历史", async () => {
  const store = await readFile(projectFile("lib/server-store.ts"), "utf8");
  assert.match(store, /__building__:/);
  assert.match(store, /Large runs are staged in bounded batches/);
  assert.match(
    store,
    /INSERT INTO permanent_records[\s\S]*FROM content_results WHERE run_id=\?/,
  );
  assert.match(store, /UPDATE content_runs SET input_kind=\?/);
  assert.match(
    store,
    /DELETE FROM content_runs WHERE id=\? AND input_kind LIKE '__building__:%'/,
  );
});

test("123AV 本地任务与 MissAV 脚本页呈现明确范围、预览和完整交接产物", async () => {
  const toolPanel = await readFile(
    projectFile("app/components/tool-panel.tsx"),
    "utf8",
  );
  const missav = await readFile(
    projectFile("app/components/missav-script-panel.tsx"),
    "utf8",
  );
  for (const label of [
    "task_id,code,url,status",
    "匹配",
    "未匹配",
    "重复",
    "坏行",
    "确认事务写入",
    "只重导出异常 / 待核验",
  ])
    assert.match(toolPanel, new RegExp(label.replace("/", "\\/")));
  for (const label of [
    "完整只读脚本",
    "参考女优Tag命中",
    "需要查找",
    "其他",
    "第一层黑名单",
    "第二层黑名单",
    "下载 .js",
  ])
    assert.match(missav, new RegExp(label.replace(".", "\\.")));
});

test("业务表格提供查找替换、批量修改、列顺序宽度、展开和完整键盘操作", async () => {
  const table = await readFile(
    projectFile("app/components/result-table.tsx"),
    "utf8",
  );
  for (const label of [
    "查找替换与批量修改",
    "按当前范围替换",
    "按当前范围批量修改",
    "列显示、顺序与宽度",
    "展开表格",
    "退出展开",
  ])
    assert.match(table, new RegExp(label));
  for (const token of [
    "Ctrl+V",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Delete",
    "Enter",
  ])
    assert.match(table, new RegExp(token.replace("+", "\\+")));
  assert.match(table, /moveColumn/);
  assert.match(table, /columnWidths/);
});

test("处理中心七阶段分开计数，并在单任务详情复用对应工具纯文本字段", async () => {
  const tasks = await readFile(
    projectFile("app/components/task-center.tsx"),
    "utf8",
  );
  for (const label of [
    "全部",
    "新收到",
    "已过滤",
    "待网站操作",
    "待复查",
    "异常",
    "已完成",
    "所选任务内容",
    "打开完整任务",
  ])
    assert.match(tasks, new RegExp(label));
  assert.doesNotMatch(tasks, /已过滤 \/ 待网站操作/);
  assert.match(tasks, /<PlainOutputPanel/);
  assert.match(tasks, /phase, stage: status/);
});

test("MissAV 三套规则可逐行编辑、分别导入导出，并可从脚本页直达", async () => {
  const library = await readFile(
    projectFile("app/components/library-panel.tsx"),
    "utf8",
  );
  const panel = await readFile(
    projectFile("app/components/tool-panel.tsx"),
    "utf8",
  );
  for (const label of [
    "参考女优 Tag 库",
    "第一层黑名单",
    "第二层黑名单",
    "导入并预览替换",
    "导出参考库",
    "导出第一层",
    "导出第二层",
  ])
    assert.match(library, new RegExp(label));
  assert.match(panel, /编辑参考 Tag 与两层黑名单/);
});

test("刷新失败可恢复、技术详情默认折叠，网络错误不会被描述成未找到", async () => {
  const errorNotice = await readFile(
    projectFile("app/components/error-notice.tsx"),
    "utf8",
  );
  const tasks = await readFile(
    projectFile("app/components/task-center.tsx"),
    "utf8",
  );
  assert.match(errorNotice, /刷新重试/);
  assert.match(errorNotice, /查看脱敏技术详情/);
  assert.match(errorNotice, /网络请求失败/);
  assert.match(tasks, /网络错误不会归类为未找到/);
});

test("高影响写入先建恢复点，Telegram 恢复点可实际恢复", async () => {
  const telegram = await readFile(
    projectFile("lib/server-telegram.ts"),
    "utf8",
  );
  const store = await readFile(projectFile("lib/server-store.ts"), "utf8");
  const audit = await readFile(projectFile("lib/server-audit.ts"), "utf8");
  assert.match(telegram, /createTelegramQueueSnapshot/);
  assert.match(telegram, /处理 \$\{tool\} Telegram 队列前自动恢复点/);
  assert.match(store, /保存 \$\{name\} 前自动恢复点/);
  assert.match(audit, /createTaskSnapshot/);
  assert.match(audit, /snapshot\.entity === "task_inbox"/);
  assert.match(audit, /snapshot\.entity === "telegram_migration"/);
  assert.match(audit, /snapshot\.entity === "telegram_queue"/);
  assert.match(audit, /ON CONFLICT\(\$\{primaryKey\}\)/);
});

test("Telegram 和任务写接口继续强制身份校验", async () => {
  for (const file of ["app/api/telegram/route.ts", "app/api/tasks/route.ts"]) {
    const source = await readFile(projectFile(file), "utf8");
    const count = source.match(/requireAuthenticated\(request\)/g)?.length || 0;
    assert.ok(count >= 2, `${file} must protect reads and writes`);
  }
  const telegram = await readFile(
    projectFile("lib/server-telegram.ts"),
    "utf8",
  );
  assert.match(telegram, /WHERE q\.tool=\? AND q\.id IN/);
  assert.match(telegram, /不属于当前工具或绑定已变化/);
});
