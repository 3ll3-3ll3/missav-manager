const test = require('node:test');
const assert = require('node:assert/strict');

const sheet = require('../renderer/sheet-table');

test('serializes rows as spreadsheet-friendly TSV', () => {
  assert.equal(sheet.rowsToTSV(['番号', '备注'], [['ABF-354', '第一行\n第二行'], ['SONE-314', 'a\tb']]), '番号\t备注\nABF-354\t第一行 第二行\nSONE-314\ta b');
});

test('moves active cell inside table boundaries', () => {
  assert.deepEqual(sheet.movePosition(1, 1, 3, 4, 'ArrowRight'), { row: 1, column: 2 });
  assert.deepEqual(sheet.movePosition(0, 0, 3, 4, 'ArrowUp'), { row: 0, column: 0 });
  assert.deepEqual(sheet.movePosition(2, 2, 3, 4, 'End'), { row: 2, column: 3 });
});
