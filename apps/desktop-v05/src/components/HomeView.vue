<script setup lang="ts">
import type { PrototypeInfo, ViewName } from "../types";

defineProps<{ info: PrototypeInfo | null }>();
const emit = defineEmits<{ navigate: [view: ViewName] }>();

const tools = [
  {
    name: "海角链接",
    state: "首个正式工具",
    description: "从 Telegram 或文件提取可访问帖子链接，作为新架构的第一条完整流程。",
    tone: "active",
  },
  {
    name: "推特博主",
    state: "待迁移",
    description: "提取 #标签中的博主名，分别输出名称和主页链接。",
    tone: "planned",
  },
  {
    name: "Bad.news",
    state: "待迁移",
    description: "提取帖子链接并过滤官网 App、广告和无关地址。",
    tone: "planned",
  },
  {
    name: "MissAV",
    state: "阶段 2",
    description: "番号查询、标签清洗、永久库与 Raindrop 同步将拆成可暂停任务。",
    tone: "planned",
  },
  {
    name: "123AV",
    state: "暂用 v0.4.5",
    description: "查询和收藏逻辑暂不搬迁，待新任务底座稳定后单独重做。",
    tone: "legacy",
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
      <span>原型数据行</span>
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
        <button v-if="tool.tone === 'active'" disabled>阶段 1 接入完整流程</button>
        <button v-else class="quiet-button" disabled>尚未开放</button>
      </article>
    </div>
  </section>

  <section class="prototype-section">
    <div class="section-heading">
      <div>
        <span class="section-kicker">阶段 0 验证台</span>
        <h2>先证明新底座不卡、不丢任务、不碰旧库</h2>
      </div>
    </div>
    <div class="prototype-grid">
      <button class="prototype-card" @click="emit('navigate', 'grid')">
        <span class="prototype-index">01</span>
        <strong>10 万行统一数据表</strong>
        <small>虚拟滚动、全文搜索、分页、选择、编辑与 CSV 导出</small>
      </button>
      <button class="prototype-card" @click="emit('navigate', 'tasks')">
        <span class="prototype-index">02</span>
        <strong>可靠后台任务</strong>
        <small>暂停、继续、取消、进度持久化与意外退出恢复</small>
      </button>
      <button class="prototype-card" @click="emit('navigate', 'migration')">
        <span class="prototype-index">03</span>
        <strong>旧库只读迁移报告</strong>
        <small>先检查完整性、表规模与映射，不自动写入任何数据库</small>
      </button>
    </div>
  </section>
</template>
