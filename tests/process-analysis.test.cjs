// Run from the repository root: node --test tests/process-analysis.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const utils = fs.readFileSync(path.join(root, 'static/js/utils.js'), 'utf8').replaceAll('export ', '');
const source = fs.readFileSync(path.join(root, 'static/js/process-analysis.js'), 'utf8')
    .replace("import { apiUrl, filterRowsByScope, formatArea, formatPct } from './utils.js?v=20260916-unified-scope';", utils)
    .replaceAll('export ', '');
const context = vm.createContext({});
vm.runInContext(source, context);
const run = code => vm.runInContext(code, context);

test('multiple process labels are classified as mixed', () => {
    for (const label of ['研磨/清洗', '研磨／清洗', '研磨、清洗', '研磨 + 清洗', '研磨；清洗']) {
        context.labelFixture = label;
        assert.equal(run('classifyProcess(labelFixture)'), '混合');
    }
    assert.equal(run("classifyProcess('研磨')"), '研磨');
    assert.equal(run("classifyProcess('非製程')"), '未分類');
});

test('clean-room areas aggregate by process, mixed and configured parent group', () => {
    context.rowsFixture = [
        { building:'K18', status:'已成廠', processLabel:'研磨', cleanRoomArea:100 },
        { building:'K18', status:'已成廠', processLabel:'研磨/清洗', cleanRoomArea:50 },
        { building:'K18', status:'已成廠', processLabel:'研磨、清洗', cleanRoomArea:20 },
        { building:'K18', status:'已成廠', processLabel:'', cleanRoomArea:10 },
        { building:'K18', status:'未成廠', processLabel:'清洗', cleanRoomArea:200 },
        { building:'K5', status:'已成廠', processLabel:'研磨', cleanRoomArea:999 }
    ];
    context.configFixture = { groups:[{ id:'g1', name:'前段製程', processes:['研磨', '清洗'] }] };
    const result = run("buildProcessAnalysis(rowsFixture, configFixture, {includeUnfinished:false, buildings:['K18']})");
    assert.equal(result.total, 180);
    assert.deepEqual(Array.from(result.processes, row => [row.process, row.area, row.group]), [
        ['研磨', 100, '前段製程'],
        ['混合', 70, '混合'],
        ['未分類', 10, '未分群']
    ]);
    const withUnfinished = run("buildProcessAnalysis(rowsFixture, configFixture, {includeUnfinished:true, buildings:['K18']})");
    assert.equal(withUnfinished.total, 380);
});

test('all aggregate views share building and unfinished scope rules', () => {
    context.scopeRowsFixture = [
        { building:'K18', floor:'1F', status:'已成廠', cleanRoomArea:100 },
        { building:'K18', floor:'ALL', status:'未成廠', cleanRoomArea:200 },
        { building:'K5', floor:'1F', status:'已成廠', cleanRoomArea:999 }
    ];
    const established = run("filterRowsByScope(scopeRowsFixture, {includeUnfinished:false, buildings:['K18']})");
    assert.deepEqual(Array.from(established, row => [row.building, row.floor, row.cleanRoomArea]), [
        ['K18', '1F', 100]
    ]);
    const withPlanned = run("filterRowsByScope(scopeRowsFixture, {includeUnfinished:true, buildings:['K18']})");
    assert.equal(withPlanned.reduce((sum, row) => sum + row.cleanRoomArea, 0), 300);
});
