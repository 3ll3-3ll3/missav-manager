const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../src/tools/registry');

test('tool registry exposes four isolated tools with stable capabilities', () => {
  const tools = registry.listTools();
  assert.deepEqual(tools.map(tool => tool.id), ['twitter', 'badnews', 'missav', 'av123']);
  assert.equal(new Set(tools.map(tool => tool.id)).size, tools.length);
  assert.equal(registry.getTool('twitter').capabilities.persistentResults, false);
  assert.equal(registry.getTool('badnews').capabilities.network, false);
  assert.equal(registry.getTool('missav').pages.includes('sync'), true);
  assert.equal(registry.getTool('av123').capabilities.accountAction, true);
  assert.equal(registry.getTool('missing'), null);
});

test('tool registry groups tools for the dedicated home page', () => {
  const groups = registry.groupTools();
  assert.deepEqual(groups.map(group => group.label), ['文本提取', '影片工具']);
  assert.deepEqual(groups[0].tools.map(tool => tool.id), ['twitter', 'badnews']);
  assert.deepEqual(groups[1].tools.map(tool => tool.id), ['missav', 'av123']);
});
