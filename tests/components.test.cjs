// Run from the repository root: node --test tests/components.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const utils = fs.readFileSync(path.join(root, 'static/js/utils.js'), 'utf8').replaceAll('export ', '');
const source = fs.readFileSync(path.join(root, 'static/js/components.js'), 'utf8')
    .replace("import { formatArea, formatPct, getCellStyle } from './utils.js';", utils)
    .replaceAll('export ', '');
const context = vm.createContext({});
vm.runInContext(source, context);
const run = code => vm.runInContext(code, context);

test('clean-room ratio uses total floor area and safely handles zero', () => {
    assert.equal(run('getAreaRatio(200, 1000)'), 0.2);
    assert.equal(run('getAreaRatio(200, 0)'), 0);
});

test('building header shows clean-room area and its floor-area ratio', () => {
    context.stateFixture = { unit:'m2', selectedZone:null };
    context.rowsFixture = [{
        id:'K18-1F', building:'K18', floor:'1F', area:1000, cleanRoomArea:200,
        prodArea:300, facArea:100, pubArea:400, status:'已成廠'
    }];
    context.metaFixture = { K18:{ baseArea:500, coverageRate:.5, capacityRate:2 } };
    const html = run("renderMatrix(stateFixture, ['K18'], [], rowsFixture, {}, metaFixture)");
    assert.ok(html.includes('無塵室面積'));
    assert.ok(html.includes('比例 20%'));
    assert.ok(html.includes('200'));
});
