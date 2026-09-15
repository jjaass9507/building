// Run from the repository root: node --test tests/trend-overlay.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'static/js/trend-overlay.js'), 'utf8')
  .replace("import { processRawData } from './data.js';", 'const processRawData = value => ({ processedData: value });')
  .replace("import { formatArea, apiUrl } from './utils.js';", "const formatArea = value => ({ val: String(value), unit: 'm²' }); const apiUrl = value => value;");

const context = vm.createContext({
  window: { addEventListener() {} },
  document: { querySelectorAll: () => [] },
  setInterval: () => 1,
  clearInterval() {},
  console
});
vm.runInContext(source, context);
const run = code => vm.runInContext(code, context);

test('area axis renders one master toggle and marks every yearly detail', () => {
  context.axisData = {
    rows: [
      { year: 25, buildings: [], annual: 0 },
      { year: 26, buildings: ['K18'], annual: 100, buildingDetails: [{ name: 'K18', area: 100 }] },
      { year: 27, buildings: ['K19'], annual: 200, buildingDetails: [{ name: 'K19', area: 200 }] }
    ]
  };
  const html = run("renderBuildingAxisDetails(axisData, METRICS.production_area)");
  assert.equal((html.match(/data-trend-axis-toggle=/g) || []).length, 1);
  assert.equal((html.match(/data-trend-axis-year/g) || []).length, 2);
  assert.ok(html.includes('全部展開'));
  assert.ok(!html.includes('<details'));
  assert.ok(!html.includes('<summary'));
  assert.ok(!html.includes('chevron-down'));
});

test('master toggle expands and collapses all yearly details together', () => {
  const details = [0, 1].map(() => ({ hidden: true }));
  const label = { textContent: '' };
  const attributes = new Map([['data-trend-axis-toggle', 'production_area']]);
  const button = {
    disabled: false,
    getAttribute: name => attributes.get(name),
    setAttribute: (name, value) => attributes.set(name, value),
    querySelector: () => label,
    addEventListener(type, handler) { this[type] = handler; }
  };
  context.document = {
    querySelectorAll: selector => selector === '[data-trend-axis-toggle]' ? [button] : [],
    getElementById: () => ({ querySelectorAll: () => details })
  };

  run('bindBuildingAxisToggles()');
  assert.equal(label.textContent, '全部展開');
  button.click({ stopPropagation() {} });
  assert.ok(details.every(item => !item.hidden));
  assert.equal(label.textContent, '全部收合');
  button.click({ stopPropagation() {} });
  assert.ok(details.every(item => item.hidden));
  assert.equal(label.textContent, '全部展開');
});

test('addition amount and ratio text use right alignment', () => {
  assert.ok(source.includes("ctx.textAlign = 'right';"));
  assert.ok(source.includes('ctx.fillText(line, left + width - 7'));
});
