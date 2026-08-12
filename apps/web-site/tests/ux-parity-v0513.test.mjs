import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadModule, projectFile } from "./helpers/bundle.mjs";

const selection = await loadModule("lib/table-selection.ts");
const taskStatus = await loadModule("lib/task-status.ts");

test("一级导航严格保留六项，历史、规则、迁移、恢复点和 Windows 说明进入二级页面", async () => {
  const source = await readFile(projectFile("app/workbench.tsx"), "utf8");
  const navBlock = source.match(/const NAV:[\s\S]*?\n\];/)?.[0] || "";
  for (const label of ["工具首页", "处理中心", "数据中心", "Telegram", "日志", "设置"]) assert.match(navBlock, new RegExp(label));
  for (const label of ["处理历史", "规则库", "迁移", "恢复点", "Windows 说明"]) assert.doesNotMatch(navBlock, new RegExp(label));
  assert.match(source, /const DATA_TABS/);
  assert.match(source, /Windows 说明/);
  assert.match(source, /TG 内容工具箱/);
});

test("首页提供五个独立工具，每个工具固定五阶段", async () => {
  const workbench = await readFile(projectFile("app/workbench.tsx"), "utf8");
  const panel = await readFile(projectFile("app/components/tool-panel.tsx"), "utf8");
  for (const tool of ["twitter", "badnews", "haijiao", "missav", "av123"]) assert.match(panel, new RegExp(`id: "${tool}"`));
  for (const stage of ["1 输入", "2 Telegram 消息", "3 结果", "4 执行/导出", "5 历史"]) assert.match(panel, new RegExp(stage.replace("/", "\\/")));
  assert.match(workbench, /openTool\(tool\.id\)/);
  assert.doesNotMatch(panel, /setTool\(/);
});

test("工具内刷新同步只接受当前工具已绑定来源并复用全局游标和检查点", async () => {
  const panel = await readFile(projectFile("app/components/telegram-panel.tsx"), "utf8");
  const route = await readFile(projectFile("app/api/telegram/route.ts"), "utf8");
  const server = await readFile(projectFile("lib/server-telegram.ts"), "utf8");
  for (const label of ["刷新同步消息", "历史回拉", "一键处理所有未处理", "复制所选消息"]) assert.match(panel, new RegExp(label));
  assert.match(route, /sync-tool-sources/);
  assert.match(route, /resolveBoundToolSyncSources/);
  assert.match(route, /pullTelegramBot\(\)/);
  assert.match(server, /JOIN tool_source_bindings b ON b\.source_id=s\.id AND b\.tool=\?/);
  assert.match(panel, /复用全局连接、Bot offset、统一消息池与来源检查点/);
  assert.doesNotMatch(panel, /start-phone|start-qr|TELEGRAM_BOT_TOKEN|fetch\([^)]*getUpdates/);
});

test("默认绑定编辑器突出当前工具、待新增待移除及其他工具绑定，高级入口保留五列矩阵", async () => {
  const settings = await readFile(projectFile("app/components/telegram-settings.tsx"), "utf8");
  for (const label of ["当前工具绑定编辑器", "当前工具待新增", "当前工具待移除", "其他工具：", "高级入口：查看和编辑五列全局矩阵"]) assert.match(settings, new RegExp(label));
  assert.match(settings, /initialTool/);
  assert.match(settings, /current-binding-row/);
});

test("表格选择支持单击替换、Ctrl 切换、Shift 区间及 Ctrl+Shift 追加", () => {
  const page = ["a", "b", "c", "d"];
  let state = { mode: "ids", ids: new Set() };
  let anchor = null;
  ({ selection: state, anchor } = selection.toggleTableRow(state, page, 1, anchor, {}));
  assert.deepEqual([...state.ids], ["b"]);
  ({ selection: state, anchor } = selection.toggleTableRow(state, page, 3, anchor, { ctrlKey: true }));
  assert.deepEqual([...state.ids], ["b", "d"]);
  ({ selection: state, anchor } = selection.toggleTableRow(state, page, 1, anchor, { shiftKey: true }));
  assert.deepEqual([...state.ids], ["b", "c", "d"]);
  ({ selection: state, anchor } = selection.toggleTableRow(state, page, 0, anchor, { shiftKey: true, ctrlKey: true }));
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
  assert.deepEqual(taskStatus.TASK_STATUSES, ["pending", "running", "paused", "completed", "partial_completed", "retry_waiting", "needs_manual", "cancelled"]);
});

test("结果、消息、任务和历史表保留键盘、筛选、分页、列设置、手机卡片和导出语义", async () => {
  const files = await Promise.all([
    "app/components/result-table.tsx",
    "app/components/telegram-panel.tsx",
    "app/components/task-center.tsx",
    "app/components/history-panel.tsx",
  ].map((file) => readFile(projectFile(file), "utf8")));
  for (const source of files) {
    for (const token of ["Delete", "Enter", "Arrow", "列设置", "全选筛选结果"]) assert.match(source, new RegExp(token));
    assert.match(source, /key\.toLowerCase\(\) === "a"/);
    assert.match(source, /mobile-(?:table-card|result-cards|telegram-list|task-list|history-list)/);
  }
  assert.match(files[0], /TXT/);
  assert.match(files[1], /CSV/);
  assert.match(files[2], /export/);
  const css = await readFile(projectFile("app/globals.css"), "utf8");
  assert.match(css, /@media\(max-width:760px\)\{\.mobile-result-cards,.mobile-task-list,.mobile-telegram-list,.mobile-history-list\{display:grid\}\}/);
  assert.doesNotMatch(css, /\.mobile-result-cards,.mobile-task-list,.mobile-telegram-list\{display:grid/);
});

test("刷新失败可恢复、技术详情默认折叠，网络错误不会被描述成未找到", async () => {
  const errorNotice = await readFile(projectFile("app/components/error-notice.tsx"), "utf8");
  const tasks = await readFile(projectFile("app/components/task-center.tsx"), "utf8");
  assert.match(errorNotice, /刷新重试/);
  assert.match(errorNotice, /查看脱敏技术详情/);
  assert.match(errorNotice, /网络请求失败/);
  assert.match(tasks, /网络错误不会归类为未找到/);
});

test("高影响写入先建恢复点，Telegram 恢复点可实际恢复", async () => {
  const telegram = await readFile(projectFile("lib/server-telegram.ts"), "utf8");
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
  const telegram = await readFile(projectFile("lib/server-telegram.ts"), "utf8");
  assert.match(telegram, /WHERE q\.tool=\? AND q\.id IN/);
  assert.match(telegram, /不属于当前工具或绑定已变化/);
});
