<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { TabulatorFull as Tabulator } from "tabulator-tables";
import {
  queryPrototypeRecords,
  seedPrototypeRecords,
  updatePrototypeRecord,
} from "../api";
import type { PrototypeRecord } from "../types";

const emit = defineEmits<{ recordsChanged: [] }>();
const tableHost = ref<HTMLElement | null>(null);
const search = ref("");
const total = ref(0);
const message = ref("准备加载数据");
const busy = ref(false);
let table: Tabulator | null = null;
let searchTimer: number | undefined;

async function loadPage(page = 1, size = 200) {
  const result = await queryPrototypeRecords(page, size, search.value);
  total.value = result.total;
  message.value = `已显示第 ${result.page}/${result.lastPage} 页，共 ${result.total.toLocaleString()} 行`;
  return {
    last_page: result.lastPage,
    last_row: result.total,
    data: result.data,
  };
}

async function refreshTable() {
  if (!table) return;
  try {
    await table.setData("records");
  } catch (error) {
    message.value = `读取失败：${String(error)}`;
  }
}

async function seed() {
  busy.value = true;
  message.value = "正在事务写入 100,000 行测试数据…";
  const started = performance.now();
  try {
    const count = await seedPrototypeRecords();
    const seconds = ((performance.now() - started) / 1000).toFixed(2);
    message.value = `原型库已有 ${count.toLocaleString()} 行，生成耗时 ${seconds} 秒`;
    emit("recordsChanged");
    await refreshTable();
  } catch (error) {
    message.value = `生成失败：${String(error)}`;
  } finally {
    busy.value = false;
  }
}

function scheduleSearch() {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(refreshTable, 260);
}

function exportCsv() {
  table?.download("csv", "v05-prototype-records.csv", { bom: true });
}

onMounted(() => {
  if (!tableHost.value) return;
  table = new Tabulator(tableHost.value, {
    height: "calc(100vh - 326px)",
    minHeight: 420,
    layout: "fitColumns",
    placeholder: "暂无数据，可先生成 10 万行测试数据",
    selectableRows: true,
    selectableRowsRangeMode: "click",
    pagination: true,
    paginationMode: "remote",
    paginationSize: 200,
    paginationSizeSelector: [100, 200, 500],
    ajaxURL: "records",
    ajaxRequestFunc: async (_url, _config, params) => {
      const page = Number(params.page ?? 1);
      const size = Number(params.size ?? 200);
      return loadPage(page, size);
    },
    index: "id",
    rowHeader: {
      formatter: "rowSelection",
      titleFormatter: "rowSelection",
      headerSort: false,
      resizable: false,
      frozen: true,
      width: 48,
    },
    columns: [
      { title: "ID", field: "id", width: 88, hozAlign: "right", headerSort: false },
      { title: "编号 / 主键", field: "code", editor: "input", minWidth: 180 },
      { title: "来源工具", field: "source", editor: "input", width: 140 },
      {
        title: "状态",
        field: "status",
        editor: "list",
        editorParams: { values: ["待处理", "已完成", "需复查", "已跳过"] },
        width: 126,
      },
      { title: "标签", field: "tags", editor: "input", minWidth: 200 },
      { title: "备注", field: "notes", editor: "input", minWidth: 260 },
      { title: "更新时间", field: "updatedAt", minWidth: 215 },
    ],
  });

  table.on("cellEdited", async (cell) => {
    const data = cell.getRow().getData() as PrototypeRecord;
    const field = cell.getField();
    try {
      await updatePrototypeRecord(data.id, field, String(cell.getValue() ?? ""));
      message.value = `${data.code} 的“${cell.getColumn().getDefinition().title}”已保存`;
    } catch (error) {
      cell.restoreOldValue();
      message.value = `保存失败：${String(error)}`;
    }
  });
});

onBeforeUnmount(() => {
  window.clearTimeout(searchTimer);
  table?.destroy();
  table = null;
});
</script>

<template>
  <section class="page-intro compact">
    <div>
      <span class="section-kicker">性能与交互原型</span>
      <h2>统一数据表</h2>
      <p>数据库分页只读取当前页；双击单元格即可编辑，Ctrl / Shift 支持范围多选。</p>
    </div>
    <div class="action-row">
      <button class="primary-button" :disabled="busy" @click="seed">
        {{ busy ? "生成中…" : "生成 10 万行样本" }}
      </button>
      <button class="quiet-button" @click="exportCsv">导出当前页 CSV</button>
    </div>
  </section>

  <section class="grid-panel">
    <div class="grid-toolbar">
      <label class="search-box">
        <span>全文搜索</span>
        <input v-model="search" placeholder="编号、来源、标签或备注" @input="scheduleSearch" />
      </label>
      <strong>{{ total.toLocaleString() }} 行</strong>
    </div>
    <div ref="tableHost" class="data-grid-host"></div>
    <div class="status-line">{{ message }}</div>
  </section>
</template>
