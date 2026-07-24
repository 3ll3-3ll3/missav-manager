const twitter = require('./twitter');
const badnews = require('./badnews');

const manifests = Object.freeze([
  twitter.manifest,
  badnews.manifest,
  Object.freeze({
    id: 'missav',
    label: 'MissAV',
    description: '番号查询、详情标签与 Raindrop 同步',
    category: 'av',
    categoryLabel: '影片工具',
    icon: 'tags',
    accent: 'green',
    defaultPage: 'process',
    pages: ['process', 'sites', 'results', 'sync'],
    queueKey: 'missav',
    capabilities: Object.freeze({
      telegram: true,
      fileInput: true,
      timeRange: true,
      network: true,
      accountAction: false,
      persistentResults: true,
    }),
  }),
  Object.freeze({
    id: 'av123',
    label: '123AV',
    description: '番号查询与账号收藏',
    category: 'av',
    categoryLabel: '影片工具',
    icon: 'bookmark-check',
    accent: 'amber',
    defaultPage: 'process',
    pages: ['process', 'sites', 'results'],
    queueKey: 'av123',
    capabilities: Object.freeze({
      telegram: true,
      fileInput: true,
      timeRange: true,
      network: true,
      accountAction: true,
      persistentResults: true,
    }),
  }),
]);

const byId = new Map(manifests.map(manifest => [manifest.id, manifest]));

function listTools() {
  return manifests.map(manifest => ({
    ...manifest,
    pages: [...manifest.pages],
    capabilities: { ...manifest.capabilities },
  }));
}

function getTool(id) {
  const manifest = byId.get(String(id || ''));
  return manifest ? {
    ...manifest,
    pages: [...manifest.pages],
    capabilities: { ...manifest.capabilities },
  } : null;
}

function hasTool(id) {
  return byId.has(String(id || ''));
}

function groupTools() {
  const groups = [];
  const byCategory = new Map();
  for (const tool of listTools()) {
    if (!byCategory.has(tool.category)) {
      const group = { id: tool.category, label: tool.categoryLabel, tools: [] };
      byCategory.set(tool.category, group);
      groups.push(group);
    }
    byCategory.get(tool.category).tools.push(tool);
  }
  return groups;
}

module.exports = {
  listTools,
  getTool,
  hasTool,
  groupTools,
};
