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
const mainSource = fs.readFileSync(path.join(root, 'static/js/main.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'static/css/style.css'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const run = code => vm.runInContext(code, context);

test('building names are escaped and a closed viewer renders nothing', () => {
    assert.equal(run('renderBuilding3DModal({isBuilding3DOpen:false},{},[])'), '');
    context.singleRow = [{id:'1',building:'<img src=x onerror=alert(1)>',floor:'1F',floorWeight:1,area:100,height:4.8,floorLoad:1000,usageLabel:'製程',status:'已成廠'}];
    const html = run(`renderBuilding3DModal({isBuilding3DOpen:true,building3DName:'<img src=x onerror=alert(1)>',building3DMetric:'usage',building3DView:'overview',building3DRotation:-38,building3DTilt:58,building3DZoom:1,selected3DFloorId:null,unit:'m2'},{},singleRow)`);
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;img'));
    assert.ok(html.includes('data-building-3d-scene'));
    assert.ok(html.includes('building-3d-stage'));
    assert.ok(!html.includes('building-3d-callouts'));
    assert.ok(!html.includes('building-floor-svg'));
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


test('RF roof floors do not render an extra top slab', () => {
    for (const floor of ['RF', 'R1F', 'R2F', '1RF']) {
        assert.equal(run(`isRoofFloor('${floor}')`), true);
    }
    for (const floor of ['B1F', '1F', 'RFA']) {
        assert.equal(run(`isRoofFloor('${floor}')`), false);
    }

    context.roofRows = [
        { id:'1f', building:'K18', floor:'1F', floorWeight:1, area:4000, height:4.8, floorLoad:1000, usageLabel:'製程', status:'已成廠' },
        { id:'rf', building:'K18', floor:'RF', floorWeight:99, area:4000, height:4.8, floorLoad:1000, usageLabel:'屋頂', status:'已成廠' }
    ];
    const html = run(`renderBuilding3DModal({isBuilding3DOpen:true,building3DName:'K18',building3DMetric:'usage',building3DView:'overview',building3DRotation:0,building3DTilt:90,building3DZoom:1,selected3DFloorId:null,unit:'m2'},{},roofRows)`);
    assert.equal((html.match(/class="building-3d-floor /g) || []).length, 2);
    assert.equal((html.match(/class="building-3d-top"/g) || []).length, 1);
});

test('all floors remain in one continuous 3D building', () => {
    const data = Array.from({ length: 24 }, (_, index) => ({
        id: String(index), building: 'K18', floor: `${index + 1}F`, floorWeight: index + 1,
        area: 4000, height: 4.8, floorLoad: 1000, usageLabel: '製程', status: '已成廠'
    }));
    context.floorRows = data;
    const html = run(`renderBuilding3DModal({isBuilding3DOpen:true,building3DName:'K18',building3DMetric:'usage',building3DView:'overview',building3DRotation:-38,building3DTilt:58,building3DZoom:1,selected3DFloorId:null,unit:'m2'},{},floorRows)`);
    assert.equal((html.match(/class="building-3d-stage"/g) || []).length, 1);
    assert.equal((html.match(/class="building-3d-core"/g) || []).length, 1);
    assert.equal((html.match(/class="building-3d-podium"/g) || []).length, 1);
    assert.equal((html.match(/class="building-3d-floor /g) || []).length, 24);
    assert.equal((html.match(/data-floor-face=/g) || []).length, 24);
    assert.equal((html.match(/class="building-3d-face-info"/g) || []).length, 24);
    assert.ok(!html.includes('building-3d-floor-tags')); 
    assert.ok(!html.includes('building-3d-roof-cap'));
});

test('front view is the default and reset target', () => {
    assert.match(mainSource, /building3DRotation:\s*0,\s*\n\s*building3DTilt:\s*90,/);
    assert.match(mainSource, /building3DView:\s*'front'/);
    assert.match(mainSource, /resetBuilding3DView:[\s\S]*?building3DView = 'front';[\s\S]*?building3DRotation = 0;[\s\S]*?building3DTilt = 90;/);
});

test('facade labels opt into measured text fitting without overflow', () => {
    context.longLabelRows = [{
        id:'long', building:'K18', floor:'B12F', floorWeight:1, area:4000, height:4.8,
        floorLoad:1000, usageLabel:'非常長的製程用途名稱必須保持在邊框裡', status:'已成廠'
    }];
    const html = run(`renderBuilding3DModal({isBuilding3DOpen:true,building3DName:'K18',building3DMetric:'usage',building3DView:'front',building3DRotation:0,building3DTilt:90,building3DZoom:1,selected3DFloorId:null,unit:'m2'},{},longLabelRows)`);
    assert.equal((html.match(/data-fit-text/g) || []).length, 2);
    assert.ok(source.includes('fitTextToContainer'));
    assert.ok(source.includes('scrollWidth <= availableWidth'));
    assert.ok(source.includes('scrollHeight <= availableHeight'));
});

test('auto fit can enlarge the whole building beyond the old fixed cap', () => {
    assert.equal(run('getContainScale({width:400,height:200,availableWidth:1200,availableHeight:800})'), 3);
    assert.ok(!source.includes('Math.min(1.08'));
    assert.match(cssSource, /scale3d\(var\(--building-zoom\),var\(--building-zoom\),var\(--building-zoom\)\)/);
});

test('raft foundation is always rendered as the bottom floor', () => {
    context.floorOrderRows = [
        { floor:'1F', floorWeight:1 },
        { floor:'筏基層', floorWeight:999 },
        { floor:'B2F', floorWeight:-2 }
    ];
    assert.equal(run('floorOrderRows.sort(compare3DFloors).map(item => item.floor).join(",")'), '筏基層,B2F,1F');
    assert.ok(!source.includes('building-3d-roof-cap'));
    assert.ok(!cssSource.includes('.building-3d-roof-cap'));
});
