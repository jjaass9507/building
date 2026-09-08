// Run from the repository root: node --test tests/building-3d.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const utils = fs.readFileSync(path.join(root, 'static/js/utils.js'), 'utf8').replaceAll('export ', '');
const source = fs.readFileSync(path.join(root, 'static/js/building-3d.js'), 'utf8')
    .replace("import { formatArea } from './utils.js';", utils).replaceAll('export ', '');
const context = vm.createContext({});
vm.runInContext(source, context);
const run = code => vm.runInContext(code, context);

test('building names are escaped and a closed viewer renders nothing', () => {
    assert.equal(run('renderBuilding3DModal({isBuilding3DOpen:false},{},[])'), '');
    const html = run(`renderBuilding3DModal({isBuilding3DOpen:true,building3DName:'<img src=x onerror=alert(1)>',building3DMetric:'usage'},{},[])`);
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;img'));
    assert.ok(html.includes('data-building-3d-scene'));
    assert.ok(!html.includes('building-3d-callouts'));
});

test('missing measurements are not displayed as fabricated zero values', () => {
    for (const metric of ['height', 'floorLoad', 'area']) {
        assert.equal(run(`metricValue({}, '${metric}', 'm2')`), '未提供');
        assert.equal(run(`metricValue({${metric}:0}, '${metric}', 'm2')`), '未提供');
    }
    assert.equal(run("metricValue({height:4.8}, 'height', 'm2')"), '4.8 m');
    assert.equal(run("metricValue({floorLoad:1000}, 'floorLoad', 'm2')"), '1,000 kgf/m²');
});

test('process labels are escaped in both metric and full detail content', () => {
    const unsafe = { usageLabel: '<svg onload="alert(1)">', height: 4.8 };
    context.floorFixture = unsafe;
    assert.ok(!run("metricValue(floorFixture,'usage','m2')").includes('<svg'));
    assert.ok(!run('floorFacts(floorFixture)').includes('<svg'));
});

test('ALL is a summary, while basement and roof labels remain real floors', () => {
    assert.equal(run("isSummaryFloor(' all ')"), true);
    for (const floor of ['B2', 'B1', '1F', 'RF']) {
        assert.equal(run(`isSummaryFloor('${floor}')`), false);
    }
});
