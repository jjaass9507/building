// Run from the repository root: node --test tests/trend-reference.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'static/js/trend-reference.js'), 'utf8')
    .replace("import { apiUrl } from './utils.js?v=20260916-unified-scope';", "const apiUrl = path => path;")
    .replaceAll('export ', '');
const context = vm.createContext({});
vm.runInContext(source, context);
const run = code => vm.runInContext(code, context);

test('reference area follows the selected trend metric', () => {
    context.rowsFixture = [
        { building:'K18', cleanRoomArea:100, prodArea:40 },
        { building:'K18', cleanRoomArea:50, prodArea:10 },
        { building:'K5', cleanRoomArea:999, prodArea:999 }
    ];
    assert.equal(run("getTrendReferenceArea(rowsFixture, 'K18', 'clean')"), 150);
    assert.equal(run("getTrendReferenceArea(rowsFixture, 'K18', 'prod')"), 50);
});

test('annual area converts to an equivalent reference building count', () => {
    assert.equal(run('getEquivalentBuildingCount(375, 150)'), 2.5);
    assert.equal(run('formatEquivalentBuildingCount(2.5)'), '2.50');
    assert.equal(run('getEquivalentBuildingCount(375, 0)'), null);
});

test('only the first two configured reference buildings are exposed', () => {
    context.configFixture = { buildings:['K18', 'K5', 'K9'] };
    assert.deepEqual(Array.from(run('configuredTrendReferences(configFixture)')), ['K18', 'K5']);
});
