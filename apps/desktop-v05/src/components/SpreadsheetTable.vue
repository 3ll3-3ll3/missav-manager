<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { TabulatorFull as Tabulator, type CellComponent, type ColumnDefinition, type RowComponent } from "tabulator-tables";

export interface SpreadsheetColumn extends ColumnDefinition {
  detailLabel?: string;
  longText?: boolean;
  filterable?: boolean;
}

const props = withDefaults(defineProps<{
  tableId: string;
  rows: Array<Record<string, unknown>>;
  columns: SpreadsheetColumn[];
  rowKey?: string;
  editable?: boolean;
  selectable?: boolean;
  height?: string;
  emptyText?: string;
  selectedKeys?: Array<string | number>;
  totalSelected?: number;
  serverSelection?: boolean;
}>(), {
  rowKey: "id",
  editable: true,
  selectable: true,
  height: "min(62vh, 680px)",
  emptyText: "没有匹配数据。",
  selectedKeys: () => [],
  totalSelected: 0,
  serverSelection: false,
});

const emit = defineEmits<{
  cellEdited: [payload: { row: Record<string, unknown>; field: string; value: unknown; oldValue: unknown }];
  selectionChange: [keys: Array<string | number>];
  deleteSelected: [keys: Array<string | number>];
  rowActivate: [row: Record<string, unknown>];
  selectAllFiltered: [];
  clearAllSelection: [];
}>();

const host = ref<HTMLElement | null>(null);
const wrapText = ref(false);
const expanded = ref(false);
const detailRow = ref<Record<string, unknown> | null>(null);
const editorOpen = ref(false);
const editorField = ref("");
const editorLabel = ref("");
const editorValue = ref("");
const editorOriginal = ref<unknown>("");
const replaceOpen = ref(false);
const replaceField = ref("");
const replaceFind = ref("");
const replaceWith = ref("");
const replaceSelectedOnly = ref(true);
let table: Tabulator | null = null;
let syncingSelection = false;
let activeCell: CellComponent | null = null;

const detailColumns = computed(() => props.columns.filter((column) => column.field && column.visible !== false));
const selectedCount = computed(() => props.totalSelected || props.selectedKeys.length);

function fieldName(column: SpreadsheetColumn) {
  return typeof column.field === "string" ? column.field : "";
}

function displayValue(value: unknown) {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function columnMenu() {
  return props.columns.filter((column) => column.field).map((column) => ({
    label: `<span class="table-menu-check">${table?.getColumn(String(column.field))?.isVisible() ? "✓" : ""}</span>${String(column.title || column.field)}`,
    action: (_event: Event, target: { toggle: () => void }) => target.toggle(),
  }));
}

function openLargeEditor(cell: CellComponent) {
  if (!props.editable) return;
  const column = props.columns.find((candidate) => candidate.field === cell.getField());
  editorField.value = cell.getField();
  editorLabel.value = String(column?.detailLabel || column?.title || cell.getField());
  editorOriginal.value = cell.getValue();
  editorValue.value = displayValue(cell.getValue());
  detailRow.value = cell.getRow().getData() as Record<string, unknown>;
  editorOpen.value = true;
}

function normalizeColumns(): ColumnDefinition[] {
  const columns = props.columns.map((source, index) => {
    const { detailLabel: _detailLabel, longText: _longText, filterable: _filterable, ...tabulatorColumn } = source;
    const column: ColumnDefinition = { ...tabulatorColumn };
    column.headerMenu = column.headerMenu || columnMenu;
    column.headerFilter = source.filterable === false ? undefined : (column.headerFilter === undefined ? "input" : column.headerFilter);
    column.resizable = true;
    if (props.editable && column.editable !== false && column.field) {
      column.editor = column.editor || (source.longText ? "textarea" : "input");
      column.editable = true;
    } else {
      column.editable = false;
    }
    if (index === 0) column.frozen = column.frozen ?? true;
    return column;
  });
  if (props.selectable) {
    columns.unshift({
      title: "",
      formatter: "rowSelection",
      titleFormatter: "rowSelection",
      headerSort: false,
      resizable: false,
      frozen: true,
      width: 48,
      minWidth: 48,
      hozAlign: "center",
      vertAlign: "middle",
      cellClick: (_event: UIEvent, cell: CellComponent) => cell.getRow().toggleSelect(),
    });
  }
  return columns;
}

function buildTable() {
  if (!host.value) return;
  table = new Tabulator(host.value, {
    index: props.rowKey,
    data: props.rows,
    columns: normalizeColumns(),
    height: "100%",
    layout: "fitDataStretch",
    placeholder: props.emptyText,
    movableColumns: true,
    resizableColumnFit: false,
    selectableRows: props.selectable,
    selectableRowsRangeMode: "click",
    history: props.editable,
    clipboard: true,
    clipboardCopyRowRange: "selected",
    clipboardPasteAction: props.editable ? "range" : "replace",
    editTriggerEvent: "dblclick",
    selectableRange: props.editable,
    selectableRangeColumns: props.editable,
    selectableRangeRows: props.editable,
    selectableRangeClearCells: props.editable,
    persistence: { columns: true, filter: true, sort: true },
    persistenceID: `tg-toolbox-${props.tableId}`,
    columnDefaults: { minWidth: 90, tooltip: true, vertAlign: "middle" },
  });
  table.on("rowClick", (_event: UIEvent, row: RowComponent) => {
      detailRow.value = row.getData() as Record<string, unknown>;
      emit("rowActivate", detailRow.value);
    });
  table.on("cellClick", (_event: UIEvent, cell: CellComponent) => {
      activeCell = cell;
      const element = cell.getElement();
      element.tabIndex = 0;
      element.focus({ preventScroll: true });
    });
  table.on("rowDblClick", (_event: UIEvent, row: RowComponent) => {
      detailRow.value = row.getData() as Record<string, unknown>;
      const first = row.getCells().find((cell) => props.columns.find((column) => column.field === cell.getField())?.longText);
      if (first) openLargeEditor(first);
    });
  table.on("cellDblClick", (_event: UIEvent, cell: CellComponent) => openLargeEditor(cell));
  table.on("cellEdited", (cell: CellComponent) => emit("cellEdited", {
      row: cell.getRow().getData() as Record<string, unknown>,
      field: cell.getField(),
      value: cell.getValue(),
      oldValue: cell.getOldValue(),
    }));
  table.on("rowSelectionChanged", (_data: unknown[], rows: RowComponent[]) => {
      if (syncingSelection) return;
      emit("selectionChange", rows.map((row) => row.getData()[props.rowKey] as string | number));
    });
  void nextTick(syncSelectedRows);
}

function syncSelectedRows() {
  if (!table) return;
  syncingSelection = true;
  table.deselectRow();
  const current = new Set(props.selectedKeys.map(String));
  for (const row of table.getRows()) {
    const key = row.getData()[props.rowKey];
    if (current.has(String(key))) row.select();
  }
  syncingSelection = false;
}

function selectCurrentPage() {
  if (!table) return;
  table.getRows("visible").forEach((row) => row.select());
}

function selectFiltered() {
  if (props.serverSelection) {
    emit("selectAllFiltered");
    return;
  }
  if (!table) return;
  table.getRows("active").forEach((row) => row.select());
}

function clearSelection() {
  table?.deselectRow();
  emit("selectionChange", []);
  emit("clearAllSelection");
}

function copySelected() {
  if (!table) return;
  table.copyToClipboard("selected");
}

function undoEdit() { table?.undo(); }
function redoEdit() { table?.redo(); }
function actionSelection() {
  if (props.serverSelection) return props.selectedKeys;
  return table?.getSelectedData().map((row: Record<string, unknown>) => row[props.rowKey] as string | number) || props.selectedKeys;
}
function requestDeleteSelected() { emit("deleteSelected", actionSelection()); }
function openDetailEditor(column: SpreadsheetColumn) {
  if (!detailRow.value) return;
  const row = table?.getRow(detailRow.value[props.rowKey] as string | number);
  const cell = row?.getCell(fieldName(column));
  if (cell) openLargeEditor(cell);
}
function openReplace() { replaceField.value = fieldName(props.columns.find((column) => column.editable !== false && column.field) || props.columns[0]); replaceFind.value = ""; replaceWith.value = ""; replaceOpen.value = true; }
function applyReplace() {
  if (!table || !replaceField.value || !replaceFind.value) return;
  const rows = replaceSelectedOnly.value && table.getSelectedRows().length ? table.getSelectedRows() : table.getRows("active");
  let changed = 0;
  for (const row of rows) {
    const cell = row.getCell(replaceField.value); if (!cell) continue;
    const before = displayValue(cell.getValue()); if (!before.includes(replaceFind.value)) continue;
    cell.setValue(before.replaceAll(replaceFind.value, replaceWith.value)); changed += 1;
  }
  replaceOpen.value = false;
  if (!changed) window.alert("当前范围没有找到可替换内容。");
}

function saveLargeEditor() {
  if (!detailRow.value || !editorField.value) return;
  const value = editorValue.value;
  emit("cellEdited", { row: detailRow.value, field: editorField.value, value, oldValue: editorOriginal.value });
  const key = detailRow.value[props.rowKey];
  table?.getRow(key as string | number)?.update({ [editorField.value]: value });
  detailRow.value = { ...detailRow.value, [editorField.value]: value };
  editorOpen.value = false;
}

function keydown(event: KeyboardEvent) {
  if (!host.value?.contains(document.activeElement) && document.activeElement !== host.value) return;
  const target = event.target as HTMLElement | null;
  if (target?.matches("input, textarea, select") || target?.isContentEditable) return;
  if (event.key === "Escape") {
    if (editorOpen.value) editorOpen.value = false;
    else if (expanded.value) expanded.value = false;
    else clearSelection();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
    event.preventDefault();
    selectFiltered();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault(); table?.undo();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
    event.preventDefault(); table?.redo();
  } else if (event.key === "Enter" && activeCell && props.editable) {
    const column = props.columns.find((candidate) => candidate.field === activeCell?.getField());
    if (column?.editable !== false) { event.preventDefault(); activeCell.edit(); }
  } else if (event.key === "ArrowLeft" && activeCell) {
    event.preventDefault(); activeCell.navigateLeft();
  } else if (event.key === "ArrowRight" && activeCell) {
    event.preventDefault(); activeCell.navigateRight();
  } else if (event.key === "ArrowUp" && activeCell) {
    event.preventDefault(); activeCell.navigateUp();
  } else if (event.key === "ArrowDown" && activeCell) {
    event.preventDefault(); activeCell.navigateDown();
  } else if (event.key === "Delete" && selectedCount.value) {
    event.preventDefault();
    emit("deleteSelected", actionSelection());
  }
}

watch(() => props.rows, async (rows) => {
  if (!table) return;
  await table.replaceData(rows);
  syncSelectedRows();
}, { deep: false });
watch(() => props.selectedKeys, syncSelectedRows, { deep: true });
watch(wrapText, (enabled) => {
  host.value?.classList.toggle("wrap-cells", enabled);
  table?.redraw(true);
});
watch(expanded, async () => { await nextTick(); table?.redraw(true); });

onMounted(() => { buildTable(); window.addEventListener("keydown", keydown); });
onBeforeUnmount(() => { window.removeEventListener("keydown", keydown); table?.destroy(); table = null; activeCell = null; });

defineExpose({ selectCurrentPage, selectFiltered, clearSelection, copySelected, table: () => table });
</script>

<template>
  <section :class="['spreadsheet-shell', { expanded }]">
    <div class="spreadsheet-toolbar">
      <div class="spreadsheet-selection">
        <strong>{{ selectedCount.toLocaleString() }}</strong><span>已选</span>
      </div>
      <button class="quiet-button small" type="button" @click="selectCurrentPage">全选当前页</button>
      <button class="quiet-button small" type="button" @click="selectFiltered">全选筛选结果</button>
      <button class="quiet-button small" type="button" @click="clearSelection">清除选择</button>
      <button class="quiet-button small" type="button" :disabled="!selectedCount" @click="copySelected">{{ serverSelection ? "复制本页已选 TSV" : "复制 TSV" }}</button>
      <button v-if="editable" class="quiet-button small" type="button" @click="undoEdit">撤销</button>
      <button v-if="editable" class="quiet-button small" type="button" @click="redoEdit">重做</button>
      <button v-if="editable" class="quiet-button small" type="button" @click="openReplace">查找替换</button>
      <label class="checkbox-line"><input v-model="wrapText" type="checkbox" />自动换行</label>
      <button class="quiet-button small" type="button" @click="expanded = !expanded">{{ expanded ? "还原" : "展开表格" }}</button>
      <button v-if="editable" class="danger-button small" type="button" :disabled="!selectedCount" @click="requestDeleteSelected">删除所选</button>
    </div>
    <div class="spreadsheet-main" :style="expanded ? undefined : { height }">
      <div ref="host" class="spreadsheet-grid" tabindex="0"></div>
      <aside class="spreadsheet-detail">
        <div class="detail-heading"><strong>行详情</strong><small>单击查看 · 双击大编辑</small></div>
        <template v-if="detailRow">
          <label v-for="column in detailColumns" :key="fieldName(column)">
            <span>{{ column.detailLabel || column.title }}</span>
            <textarea v-if="column.longText" :value="displayValue(detailRow[fieldName(column)])" readonly rows="4" @dblclick="openDetailEditor(column)"></textarea>
            <input v-else :value="displayValue(detailRow[fieldName(column)])" readonly @dblclick="openDetailEditor(column)" />
          </label>
        </template>
        <div v-else class="detail-empty">选择一行后在这里查看完整内容。</div>
      </aside>
    </div>
    <p class="spreadsheet-hint">单击选择；Ctrl 增减，Shift 连选；Ctrl+A 选择当前筛选结果；方向键移动，Enter 编辑，Delete 删除；可拖动列宽和列顺序，表头菜单可隐藏列。</p>
  </section>

  <div v-if="editorOpen" class="modal-backdrop" @click.self="editorOpen = false">
    <section class="large-cell-editor">
      <div class="section-heading compact-heading"><div><span class="section-kicker">大字段编辑器</span><h3>{{ editorLabel }}</h3></div><button class="quiet-button small" @click="editorOpen = false">关闭</button></div>
      <textarea v-model="editorValue" autofocus rows="18"></textarea>
      <div class="action-row"><button class="primary-button" @click="saveLargeEditor">保存修改</button><button class="quiet-button" @click="editorOpen = false">取消</button></div>
    </section>
  </div>
  <div v-if="replaceOpen" class="modal-backdrop" @click.self="replaceOpen = false">
    <section class="large-cell-editor replace-editor"><div class="section-heading compact-heading"><div><span class="section-kicker">表格批量操作</span><h3>查找并替换</h3></div><button class="quiet-button small" @click="replaceOpen = false">关闭</button></div><div class="form-grid"><label>字段<select v-model="replaceField"><option v-for="column in columns.filter(item => item.editable !== false && item.field)" :key="fieldName(column)" :value="fieldName(column)">{{ column.title }}</option></select></label><label>查找<input v-model="replaceFind" /></label><label>替换为<input v-model="replaceWith" /></label><label class="checkbox-line"><input v-model="replaceSelectedOnly" type="checkbox" />有选中行时只处理选中行</label></div><div class="action-row"><button class="primary-button" :disabled="!replaceFind" @click="applyReplace">执行替换</button><button class="quiet-button" @click="replaceOpen = false">取消</button></div></section>
  </div>
</template>
