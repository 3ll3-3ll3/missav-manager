(function initExplorerSelection(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ExplorerSelection = api;
})(typeof window !== 'undefined' ? window : globalThis, function createExplorerSelection() {
  function normalizeIds(values) {
    return (values || []).map(Number).filter(Number.isFinite);
  }

  function applySelection(options = {}) {
    const orderedIds = normalizeIds(options.orderedIds);
    const clickedId = Number(options.clickedId);
    const existing = new Set(normalizeIds(options.selectedIds));
    const ctrlKey = Boolean(options.ctrlKey);
    const shiftKey = Boolean(options.shiftKey);
    const validAnchor = orderedIds.includes(Number(options.anchorId)) ? Number(options.anchorId) : null;

    if (!Number.isFinite(clickedId) || !orderedIds.includes(clickedId)) {
      return { selectedIds: [...existing], anchorId: validAnchor };
    }

    if (shiftKey) {
      const anchorId = validAnchor ?? clickedId;
      const anchorIndex = orderedIds.indexOf(anchorId);
      const clickedIndex = orderedIds.indexOf(clickedId);
      const start = Math.min(anchorIndex, clickedIndex);
      const end = Math.max(anchorIndex, clickedIndex);
      const range = orderedIds.slice(start, end + 1);
      const selected = ctrlKey ? new Set(existing) : new Set();
      for (const id of range) selected.add(id);
      return { selectedIds: [...selected], anchorId };
    }

    if (ctrlKey) {
      if (existing.has(clickedId)) existing.delete(clickedId);
      else existing.add(clickedId);
      return { selectedIds: [...existing], anchorId: clickedId };
    }

    return { selectedIds: [clickedId], anchorId: clickedId };
  }

  return { applySelection };
});
