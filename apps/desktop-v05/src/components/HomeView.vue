<script setup lang="ts">
import type { AppInfo, ViewName } from "../types";

defineProps<{ info: AppInfo | null }>();
const emit = defineEmits<{ navigate: [view: ViewName] }>();

const tools = [
  {
    id: "haijiao",
    name: "海角链接",
    state: "可用",
    description: "从 Telegram、粘贴内容或多个文件提取可访问帖子链接。",
    tone: "active",
  },
  {
    id: "twitter",
    name: "推特博主",
    state: "可用",
    description: "提取 #标签中的博主名，分别输出名称和主页链接。",
    tone: "active",
  },
  {
    id: "badnews",
    name: "Bad.news",
    state: "可用",
    description: "提取帖子链接并过滤官网 App、广告和无关地址。",
    tone: "active",
  },
  {
    id: "missav",
    name: "MissAV",
    state: "独立工作区",
    description: "提取并规范番号，保存永久历史，生成可直接粘贴到浏览器运行的完整脚本。",
    tone: "active",
  },
  {
    id: "av123",
    name: "123AV",
    state: "独立工作区",
    description: "番号提取、查询和账号收藏独立于 MissAV，按网站单独限速。",
    tone: "active",
  },
];
</script>

<template>
  <section class="hero-panel">
    <div>
      <span class="section-kicker">新的产品入口</span>
      <h2>先选工具，再开始一项清楚的任务</h2>
      <p>不再把输入、运行、同步、数据库和所有网站塞进同一页。每个工具只显示当下需要的内容。</p>
    </div>
    <div class="hero-stat">
      <strong>{{ info?.recordCount.toLocaleString() ?? 0 }}</strong>
      <span>永久业务记录</span>
    </div>
  </section>

  <section>
    <div class="section-heading">
      <div>
        <span class="section-kicker">内容工具</span>
        <h2>选择要处理的内容</h2>
      </div>
    </div>
    <div class="tool-grid">
      <article v-for="tool in tools" :key="tool.name" class="tool-card" :class="tool.tone">
        <div class="tool-card-head">
          <h3>{{ tool.name }}</h3>
          <span class="state-chip">{{ tool.state }}</span>
        </div>
        <p>{{ tool.description }}</p>
        <button @click="emit('navigate', `tool:${tool.id}` as ViewName)">打开工具</button>
      </article>
    </div>
  </section>

  <section class="management-section">
    <div class="section-heading">
      <div>
        <span class="section-kicker">管理与维护</span>
        <h2>数据、处理历史和旧库迁移各自独立</h2>
      </div>
    </div>
    <div class="management-grid">
      <button class="management-card" @click="emit('navigate', 'tasks')">
        <span class="management-index">01</span>
        <strong>统一处理中心</strong>
        <small>新收到、已过滤、待网站操作、待复查、异常和已完成任务分组处理</small>
      </button>
      <button class="management-card" @click="emit('navigate', 'data')">
        <span class="management-index">02</span>
        <strong>10 万行统一数据中心</strong>
        <small>真实业务数据的全文搜索、分页、选择、编辑与 CSV 导出</small>
      </button>
      <button class="management-card" @click="emit('navigate', 'sources')">
        <span class="management-index">03</span>
        <strong>Telegram 来源</strong>
        <small>群组与频道可多选绑定多个工具，退出后的旧来源可删除</small>
      </button>
      <button class="management-card" @click="emit('navigate', 'logs')">
        <span class="management-index">04</span>
        <strong>运行日志</strong>
        <small>集中查看网络、同步和数据库问题，敏感凭据不会写入日志</small>
      </button>
      <button class="management-card" @click="emit('navigate', 'settings')">
        <span class="management-index">05</span>
        <strong>设置与备份</strong>
        <small>独立管理代理、网站速度、数据库自动备份与恢复</small>
      </button>
      <button class="management-card" @click="emit('navigate', 'migration')">
        <span class="management-index">06</span>
        <strong>v0.4.5 数据迁移</strong>
        <small>旧库始终只读；迁移前自动备份，完整归档后映射进新数据中心</small>
      </button>
    </div>
  </section>
</template>
