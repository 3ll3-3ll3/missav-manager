const test = require('node:test');
const assert = require('node:assert/strict');

const shell = require('../renderer/tool-shell');

test('groups tool manifests and builds an escaped dedicated home', () => {
  const manifests = [{
    id: 'sample',
    label: '<Sample>',
    description: 'local',
    category: 'text',
    categoryLabel: '文本工具',
    accent: 'blue',
    icon: 'filter',
    capabilities: { persistentResults: false, network: false },
  }, {
    id: 'network',
    label: 'Network',
    description: 'remote',
    category: 'av',
    categoryLabel: '影片工具',
    accent: 'green',
    icon: 'tags',
    capabilities: { persistentResults: true, network: true },
  }];
  const groups = shell.groupTools(manifests);
  assert.deepEqual(groups.map(group => group.id), ['text', 'av']);
  const html = shell.buildToolHomeHtml(manifests);
  assert.match(html, /data-open-tool="sample"/);
  assert.match(html, /&lt;Sample&gt;/);
  assert.match(html, /会话结果/);
  assert.match(html, /数据库记录/);
});
