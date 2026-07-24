const test = require('node:test');
const assert = require('node:assert/strict');

const { applySelection } = require('../renderer/explorer-selection');

const ids = [10, 20, 30, 40, 50, 60];

test('applies Windows Explorer style record selection', () => {
  let state = applySelection({ orderedIds: ids, clickedId: 20 });
  assert.deepEqual(state, { selectedIds: [20], anchorId: 20 });

  state = applySelection({ orderedIds: ids, selectedIds: state.selectedIds, anchorId: state.anchorId, clickedId: 40, ctrlKey: true });
  assert.deepEqual(new Set(state.selectedIds), new Set([20, 40]));
  assert.equal(state.anchorId, 40);

  state = applySelection({ orderedIds: ids, selectedIds: state.selectedIds, anchorId: state.anchorId, clickedId: 60, shiftKey: true });
  assert.deepEqual(state, { selectedIds: [40, 50, 60], anchorId: 40 });

  state = applySelection({ orderedIds: ids, selectedIds: [10], anchorId: 20, clickedId: 40, ctrlKey: true, shiftKey: true });
  assert.deepEqual(new Set(state.selectedIds), new Set([10, 20, 30, 40]));
  assert.equal(state.anchorId, 20);

  state = applySelection({ orderedIds: ids, selectedIds: [20, 40], anchorId: 40, clickedId: 40, ctrlKey: true });
  assert.deepEqual(state, { selectedIds: [20], anchorId: 40 });
});
