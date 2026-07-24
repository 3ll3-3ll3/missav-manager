(function initSheetTable(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SheetTable = api;
})(typeof window !== 'undefined' ? window : globalThis, function createSheetTable(root) {
  const MIN_COLUMN_WIDTH = 48;

  function normalizeCellText(value) {
    return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\t/g, ' ').trim();
  }

  function rowsToTSV(headers, rows) {
    return [headers, ...(rows || [])]
      .map(row => (row || []).map(normalizeCellText).join('\t'))
      .join('\n');
  }

  function movePosition(row, column, rowCount, columnCount, key) {
    let nextRow = Math.max(0, Math.min(rowCount - 1, Number(row) || 0));
    let nextColumn = Math.max(0, Math.min(columnCount - 1, Number(column) || 0));
    if (key === 'ArrowUp') nextRow--;
    if (key === 'ArrowDown') nextRow++;
    if (key === 'ArrowLeft') nextColumn--;
    if (key === 'ArrowRight') nextColumn++;
    if (key === 'Home') nextColumn = 0;
    if (key === 'End') nextColumn = columnCount - 1;
    return {
      row: Math.max(0, Math.min(rowCount - 1, nextRow)),
      column: Math.max(0, Math.min(columnCount - 1, nextColumn)),
    };
  }

  function tableKey(table) {
    const explicit = table.dataset.sheetKey || table.id;
    if (explicit) return explicit;
    const header = Array.from(table.querySelectorAll('thead th')).map(cell => normalizeCellText(cell.textContent)).join('|');
    let hash = 0;
    for (let i = 0; i < header.length; i++) hash = ((hash << 5) - hash + header.charCodeAt(i)) | 0;
    return `table-${Math.abs(hash)}`;
  }

  function persistWidths(table) {
    if (!root?.localStorage) return;
    const widths = Array.from(table.querySelectorAll('thead th')).map(cell => Math.round(cell.getBoundingClientRect().width));
    try { root.localStorage.setItem(`missav_sheet_widths_${tableKey(table)}`, JSON.stringify(widths)); } catch {}
  }

  function applyColumnWidth(table, index, width) {
    const normalized = Math.max(MIN_COLUMN_WIDTH, Math.round(Number(width) || MIN_COLUMN_WIDTH));
    Array.from(table.rows).forEach(row => {
      const cell = row.cells[index];
      if (!cell) return;
      cell.style.width = `${normalized}px`;
      cell.style.minWidth = `${normalized}px`;
      cell.style.maxWidth = `${normalized}px`;
    });
  }

  function restoreWidths(table) {
    if (!root?.localStorage) return;
    try {
      const widths = JSON.parse(root.localStorage.getItem(`missav_sheet_widths_${tableKey(table)}`) || '[]');
      if (Array.isArray(widths)) widths.forEach((width, index) => applyColumnWidth(table, index, width));
    } catch {}
  }

  function dataCells(table) {
    return Array.from(table.querySelectorAll('tbody tr')).map(row => Array.from(row.cells));
  }

  function activateCell(table, cell, focus = true) {
    if (!cell) return;
    table.querySelectorAll('.sheet-active-cell').forEach(item => item.classList.remove('sheet-active-cell'));
    cell.classList.add('sheet-active-cell');
    cell.tabIndex = 0;
    if (focus) cell.focus({ preventScroll: true });
  }

  async function copyText(value) {
    if (root?.navigator?.clipboard?.writeText) return root.navigator.clipboard.writeText(value);
    if (!root?.document) return;
    const area = root.document.createElement('textarea');
    area.value = value;
    root.document.body.appendChild(area);
    area.select();
    root.document.execCommand('copy');
    area.remove();
  }

  function bindResizer(table, th, index) {
    if (th.querySelector(':scope > .sheet-column-resizer')) return;
    const handle = root.document.createElement('span');
    handle.className = 'sheet-column-resizer';
    handle.title = '拖动调整列宽；双击自动适配';
    handle.addEventListener('dblclick', event => {
      event.preventDefault();
      event.stopPropagation();
      const cells = Array.from(table.rows).map(row => row.cells[index]).filter(Boolean);
      cells.forEach(cell => { cell.style.width = ''; cell.style.minWidth = ''; cell.style.maxWidth = ''; });
      const best = Math.min(520, Math.max(MIN_COLUMN_WIDTH, ...cells.map(cell => Math.ceil(cell.scrollWidth + 22))));
      applyColumnWidth(table, index, best);
      persistWidths(table);
    });
    handle.addEventListener('pointerdown', event => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = th.getBoundingClientRect().width;
      handle.setPointerCapture?.(event.pointerId);
      table.classList.add('sheet-resizing');
      const move = moveEvent => applyColumnWidth(table, index, startWidth + moveEvent.clientX - startX);
      const stop = () => {
        root.document.removeEventListener('pointermove', move);
        root.document.removeEventListener('pointerup', stop);
        table.classList.remove('sheet-resizing');
        persistWidths(table);
      };
      root.document.addEventListener('pointermove', move);
      root.document.addEventListener('pointerup', stop, { once: true });
    });
    th.appendChild(handle);
  }

  function refreshTable(table) {
    Array.from(table.querySelectorAll('thead th')).forEach((th, index) => bindResizer(table, th, index));
    Array.from(table.querySelectorAll('tbody td')).forEach(cell => {
      if (!cell.hasAttribute('tabindex')) cell.tabIndex = -1;
    });
  }

  function enhanceTable(table) {
    if (!table) return table;
    const currentKey = tableKey(table);
    if (table.dataset.sheetReady === '1') {
      refreshTable(table);
      if (table.dataset.sheetActiveKey !== currentKey) {
        table.dataset.sheetActiveKey = currentKey;
        restoreWidths(table);
      }
      return table;
    }
    table.dataset.sheetReady = '1';
    table.dataset.sheetActiveKey = currentKey;
    table.classList.add('sheet-table');
    refreshTable(table);
    restoreWidths(table);

    table.addEventListener('click', event => {
      if (event.target.closest('input, textarea, select, button, a, .sheet-column-resizer')) return;
      const cell = event.target.closest('td');
      if (cell && table.contains(cell)) activateCell(table, cell, false);
    });
    table.addEventListener('keydown', event => {
      const interactive = event.target.closest('input, textarea, select, button, a');
      if (interactive) return;
      const active = event.target.closest('td') || table.querySelector('.sheet-active-cell');
      if (!active) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        const selection = root.getSelection?.();
        if (!selection || selection.isCollapsed) {
          event.preventDefault();
          copyText(normalizeCellText(active.innerText));
        }
        return;
      }
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const matrix = dataCells(table);
      const rowIndex = matrix.findIndex(row => row.includes(active));
      const columnIndex = rowIndex >= 0 ? matrix[rowIndex].indexOf(active) : -1;
      if (rowIndex < 0 || columnIndex < 0) return;
      event.preventDefault();
      const next = movePosition(rowIndex, columnIndex, matrix.length, Math.max(...matrix.map(row => row.length)), event.key);
      activateCell(table, matrix[next.row]?.[next.column] || matrix[next.row]?.at(-1));
    });
    table.addEventListener('mouseover', event => {
      const cell = event.target.closest('td');
      if (cell && cell.scrollWidth > cell.clientWidth && !cell.title) cell.title = normalizeCellText(cell.innerText);
    });
    return table;
  }

  function enhanceAll(scope) {
    if (!root?.document) return [];
    const container = scope || root.document;
    const tables = Array.from(container.querySelectorAll?.('.result-table, .library-table, .csv-table') || []);
    return tables.map(enhanceTable);
  }

  if (root?.document) {
    const start = () => {
      enhanceAll(root.document);
      const observer = new MutationObserver(mutations => {
        if (mutations.some(mutation => mutation.addedNodes.length)) enhanceAll(root.document);
        root.document.querySelectorAll('.sheet-table').forEach(refreshTable);
      });
      observer.observe(root.document.body, { childList: true, subtree: true });
    };
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }

  return { normalizeCellText, rowsToTSV, movePosition, enhanceTable, enhanceAll };
});
