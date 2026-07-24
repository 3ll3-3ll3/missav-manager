(function exposeToolShell(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ToolShell = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createToolShell() {
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character]);
  }

  function groupTools(manifests = []) {
    const groups = [];
    const byCategory = new Map();
    for (const tool of manifests) {
      if (!byCategory.has(tool.category)) {
        const group = { id: tool.category, label: tool.categoryLabel, tools: [] };
        byCategory.set(tool.category, group);
        groups.push(group);
      }
      byCategory.get(tool.category).tools.push(tool);
    }
    return groups;
  }

  function buildToolHomeHtml(manifests = []) {
    return groupTools(manifests).map(group => `
      <section class="tool-home-category" data-tool-category="${escapeHtml(group.id)}">
        <div class="tool-home-category-head"><h3>${escapeHtml(group.label)}</h3><span>${group.tools.length} 个工具</span></div>
        <div class="tool-card-grid">${group.tools.map(tool => `
          <button class="tool-entry-card tool-accent-${escapeHtml(tool.accent)}" type="button" data-open-tool="${escapeHtml(tool.id)}">
            <span class="tool-entry-icon"><i data-lucide="${escapeHtml(tool.icon)}"></i></span>
            <span class="tool-entry-copy"><strong>${escapeHtml(tool.label)}</strong><small>${escapeHtml(tool.description)}</small></span>
            <span class="tool-entry-meta">
              <i>${tool.capabilities.persistentResults ? '数据库记录' : '会话结果'}</i>
              <i>${tool.capabilities.network ? '网站任务' : '本地过滤'}</i>
              <b data-tool-status="${escapeHtml(tool.id)}">空闲</b>
            </span>
          </button>`).join('')}</div>
      </section>`).join('');
  }

  return {
    escapeHtml,
    groupTools,
    buildToolHomeHtml,
  };
});
