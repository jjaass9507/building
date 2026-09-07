import { formatArea } from './utils.js';

const COLORS = {
    clean: '#0ea5e9',
    prod: '#10b981',
    fac: '#f59e0b',
    pub: '#94a3b8'
};

const getValue = (value) => {
    if (value && typeof value === 'object') {
        return Number(value.value ?? value.val ?? 0) || 0;
    }
    return Number(value || 0) || 0;
};

const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const encodeHandlerValue = (value) => encodeURIComponent(String(value ?? '')).replace(/'/g, '%27');

const measurement = (value, unit) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0
        ? `${number.toLocaleString('zh-TW', { maximumFractionDigits: 2 })} ${unit}` : '未提供';
};

const floorFacts = (floor) => `<span class="building-3d-facts"><span>樓高 <strong>${measurement(floor.height, 'm')}</strong></span><span>荷重 <strong>${measurement(floor.floorLoad, 'kgf/m²')}</strong></span><span class="building-3d-process">製程 <strong>${escapeHtml(floor.usageLabel || '未提供')}</strong></span></span>`;

const isSummaryFloor = (floor) => String(floor || '').trim().toUpperCase() === 'ALL';

const floorParts = (floor) => [
    { key: 'clean', label: '無塵室', value: getValue(floor.cleanRoomArea), color: COLORS.clean },
    { key: 'prod', label: '生產週邊', value: getValue(floor.prodArea), color: COLORS.prod },
    { key: 'fac', label: '廠務設施', value: getValue(floor.facArea), color: COLORS.fac },
    { key: 'pub', label: '公設／其他', value: getValue(floor.pubArea), color: COLORS.pub }
];

const buildFloorGradient = (floor) => {
    const parts = floorParts(floor).filter(item => item.value > 0);
    const total = parts.reduce((sum, item) => sum + item.value, 0);
    if (total <= 0) return 'linear-gradient(135deg, #cbd5e1, #94a3b8)';

    let cursor = 0;
    const stops = [];
    parts.forEach((item, index) => {
        const start = cursor;
        cursor = index === parts.length - 1 ? 100 : cursor + (item.value / total) * 100;
        stops.push(`${item.color} ${start.toFixed(2)}%`, `${item.color} ${cursor.toFixed(2)}%`);
    });
    return `linear-gradient(90deg, ${stops.join(', ')})`;
};

const renderMetric = (label, value, unit, colorClass = 'text-slate-800 dark:text-white') => {
    const formatted = formatArea(value, unit);
    return `
        <div class="border-l-2 border-slate-200 dark:border-slate-700 pl-3">
            <div class="text-[11px] font-bold text-slate-400">${label}</div>
            <div class="mt-0.5 font-mono text-lg font-black ${colorClass}">${formatted.val}<span class="ml-1 text-[11px] text-slate-400">${formatted.unit}</span></div>
        </div>`;
};

const renderFloorComposition = (floor, unit) => {
    const area = getValue(floor.area);
    return floorParts(floor).map(item => {
        const pct = area > 0 ? Math.min(100, (item.value / area) * 100) : 0;
        const formatted = formatArea(item.value, unit);
        return `
            <div>
                <div class="mb-1 flex items-center justify-between gap-3 text-xs">
                    <span class="flex items-center gap-2 font-bold text-slate-600 dark:text-slate-300">
                        <span class="h-2.5 w-2.5" style="background:${item.color}"></span>${item.label}
                    </span>
                    <span class="font-mono font-bold text-slate-700 dark:text-slate-200">${formatted.val} ${formatted.unit}</span>
                </div>
                <div class="h-1.5 overflow-hidden bg-slate-100 dark:bg-slate-700">
                    <div class="h-full" style="width:${pct.toFixed(2)}%;background:${item.color}"></div>
                </div>
            </div>`;
    }).join('');
};

const renderEmptyBuilding = (buildingName, unknownSummary) => `
    <div class="flex h-full min-h-[360px] flex-col items-center justify-center border border-dashed border-slate-300 bg-slate-50 px-8 text-center dark:border-slate-700 dark:bg-slate-950/40">
        <i data-lucide="layers-3" class="h-12 w-12 text-slate-300 dark:text-slate-600"></i>
        <h3 class="mt-4 text-lg font-black text-slate-700 dark:text-slate-200">${escapeHtml(buildingName)} 尚無可建立模型的樓層</h3>
        <p class="mt-2 max-w-md text-sm leading-6 text-slate-500 dark:text-slate-400">請在樓層資料填入實際樓層名稱後，系統就會依樓層順序、樓地板面積與樓高自動產生 3D 示意圖。</p>
        ${unknownSummary ? '<p class="mt-3 border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">目前只有「ALL」全棟規劃資料，未納入樓層模型。</p>' : ''}
    </div>`;

export const renderBuilding3DModal = (state, buildingMeta, processedData) => {
    if (!state.isBuilding3DOpen || !state.building3DName) return '';

    const buildingName = state.building3DName;
    const allRows = processedData.filter(item => item.building === buildingName);
    const floors = allRows
        .filter(item => !isSummaryFloor(item.floor))
        .sort((a, b) => a.floorWeight - b.floorWeight);
    const unknownSummary = allRows.some(item => isSummaryFloor(item.floor));
    const meta = buildingMeta[buildingName] || {};
    const maxArea = Math.max(1, ...floors.map(item => getValue(item.area)));
    const totalArea = floors.reduce((sum, item) => sum + getValue(item.area), 0);
    const totalHeight = floors.reduce((sum, item) => sum + Math.max(0, Number(item.height || 0)), 0);
    const selected = floors.find(item => item.id === state.selected3DFloorId) || floors[floors.length - 1] || null;
    const floorIntervals = Math.max(1, floors.length - 1);
    const gap = state.isBuilding3DExpanded
        ? Math.max(7, Math.min(52, 350 / floorIntervals))
        : Math.max(7, Math.min(30, 250 / floorIntervals));
    const callouts = [...floors].reverse().map(floor => `
        <button type="button" class="building-3d-callout ${selected?.id === floor.id ? 'is-selected' : ''}"
            data-floor-callout="${escapeHtml(floor.id)}" aria-pressed="${selected?.id === floor.id}"
            onclick="window.app.select3DFloor(decodeURIComponent('${encodeHandlerValue(floor.id)}'))">
            <span class="building-3d-callout-title">${escapeHtml(floor.floor)}<small>${escapeHtml(floor.status)}</small></span>
            ${floorFacts(floor)}
        </button>`).join('');

    const floorModels = floors.map((floor, index) => {
        const areaRatio = Math.sqrt(Math.max(0, getValue(floor.area)) / maxArea);
        const width = Math.round(230 + 150 * areaRatio);
        const depth = Math.round(108 + 72 * areaRatio);
        const level = (index - (floors.length - 1) / 2) * gap;
        const selectedClass = selected?.id === floor.id ? 'is-selected' : '';
        const plannedClass = floor.status === '未成廠' ? 'is-planned' : '';
        const encodedFloorId = encodeHandlerValue(floor.id);

        return `
            <div class="building-3d-floor ${selectedClass} ${plannedClass}" style="--floor-width:${width}px;--floor-depth:${depth}px;--floor-level:${level}px;--floor-color:${buildFloorGradient(floor)};--floor-order:${index}">
                <button type="button" class="building-3d-volume" onclick="window.app.select3DFloor(decodeURIComponent('${encodedFloorId}'))" aria-label="查看 ${escapeHtml(floor.floor)} 樓層資訊">
                    <span class="building-3d-top"></span>
                    <span class="building-3d-front"></span>
                    <span class="building-3d-side"></span>
                    <span class="building-3d-label" data-floor-anchor="${escapeHtml(floor.id)}">${escapeHtml(floor.floor)}</span>
                </button>
            </div>`;
    }).join('');

    const selectedDetail = selected ? `
        <section class="building-3d-detail">
            <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                    <div class="text-xs font-bold text-blue-600 dark:text-blue-400">目前選取樓層</div>
                    <h3 class="mt-1 text-xl font-black text-slate-900 dark:text-white">${escapeHtml(selected.floor)} · ${escapeHtml(selected.usageLabel || '非製程')}</h3>
                </div>
                <div class="flex gap-2">
                    <span class="border px-2 py-1 text-xs font-bold ${selected.status === '未成廠' ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300' : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'}">${escapeHtml(selected.status)}</span>
                    <span class="border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-bold text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">樓高 ${Number(selected.height || 0) > 0 ? `${escapeHtml(selected.height)} m` : '-'}</span>
                </div>
            </div>
            <div class="building-3d-detail-facts">${floorFacts(selected)}
                <div class="building-3d-detail-area">樓地板面積 <strong>${formatArea(getValue(selected.area), state.unit).val} ${formatArea(getValue(selected.area), state.unit).unit}</strong></div>
            </div>
            <h4 class="building-3d-section-title">空間組成</h4>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">${renderFloorComposition(selected, state.unit)}</div>
        </section>` : '';

    return `
        <div class="fixed inset-0 z-[110] bg-slate-950/70 p-2 md:p-5" onclick="window.app.closeBuilding3D()">
            <section role="dialog" aria-modal="true" aria-labelledby="building-3d-title" class="building-3d-dialog mx-auto flex h-full max-h-[94vh] w-full max-w-[1500px] flex-col overflow-hidden border border-slate-200 bg-slate-50 shadow-2xl dark:border-slate-700 dark:bg-slate-950" onclick="event.stopPropagation()">
                <header class="flex flex-none flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-white px-5 py-4 dark:border-slate-800 dark:bg-slate-900">
                    <div class="flex items-center gap-3">
                        <span class="inline-flex h-10 w-10 items-center justify-center bg-slate-800 text-white dark:bg-blue-600"><i data-lucide="box" class="h-5 w-5"></i></span>
                        <div>
                            <div class="text-[11px] font-black uppercase tracking-[0.18em] text-blue-600 dark:text-blue-400">Single Building View</div>
                            <h2 id="building-3d-title" class="text-xl font-black text-slate-900 dark:text-white">${escapeHtml(buildingName)} 單棟 3D 示意圖</h2>
                        </div>
                    </div>
                    <div class="flex items-center gap-2">
                        <button type="button" onclick="window.app.setBuilding3DView('overview')" class="building-3d-tool px-3 text-xs font-bold">全棟</button>
                        <button type="button" onclick="window.app.setBuilding3DView('exploded')" class="building-3d-tool px-3 text-xs font-bold ${state.isBuilding3DExpanded ? 'is-active' : ''}">分層閱讀</button>
                        <button type="button" onclick="window.app.setBuilding3DView('front')" class="building-3d-tool px-3 text-xs font-bold">正視</button>
                        <button type="button" onclick="window.app.rotateBuilding3D(-15)" class="building-3d-tool" title="向左旋轉"><i data-lucide="rotate-ccw" class="h-4 w-4"></i></button>
                        <button type="button" onclick="window.app.resetBuilding3DView()" class="building-3d-tool gap-1 px-3 text-xs font-bold" title="重設視角"><i data-lucide="scan" class="h-4 w-4"></i><span class="hidden sm:inline">重設</span></button>
                        <button type="button" onclick="window.app.rotateBuilding3D(15)" class="building-3d-tool" title="向右旋轉"><i data-lucide="rotate-cw" class="h-4 w-4"></i></button>
                        <button type="button" onclick="window.app.toggleBuilding3DExpanded()" class="building-3d-tool gap-1 px-3 text-xs font-bold ${state.isBuilding3DExpanded ? 'is-active' : ''}" title="切換樓層間距"><i data-lucide="unfold-vertical" class="h-4 w-4"></i><span class="hidden sm:inline">分層</span></button>
                        <button type="button" onclick="window.app.closeBuilding3D()" class="building-3d-tool ml-1" title="關閉"><i data-lucide="x" class="h-5 w-5"></i></button>
                    </div>
                </header>

                <div class="building-3d-layout grid min-h-0 flex-1 grid-cols-1 overflow-y-auto xl:grid-cols-[minmax(0,1fr)_330px] xl:overflow-hidden">
                    <div class="flex min-h-0 flex-col overflow-visible xl:overflow-auto">
                        <div class="grid grid-cols-2 gap-3 border-b border-slate-200 bg-white px-5 py-3 sm:grid-cols-4 dark:border-slate-800 dark:bg-slate-900">
                            <div class="border-l-2 border-slate-200 pl-3 dark:border-slate-700">
                                <div class="text-[11px] font-bold text-slate-400">實際樓層</div>
                                <div class="mt-0.5 font-mono text-lg font-black text-slate-800 dark:text-white">${floors.length.toLocaleString()}<span class="ml-1 text-[11px] text-slate-400">層</span></div>
                            </div>
                            ${renderMetric('總樓地板', totalArea, state.unit)}
                            ${renderMetric('基地面積', Number(meta.baseArea || 0), state.unit)}
                            <div class="border-l-2 border-slate-200 pl-3 dark:border-slate-700">
                                <div class="text-[11px] font-bold text-slate-400">樓高加總</div>
                                <div class="mt-0.5 font-mono text-lg font-black text-slate-800 dark:text-white">${totalHeight > 0 ? totalHeight.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '-'}<span class="ml-1 text-[11px] text-slate-400">m</span></div>
                            </div>
                        </div>

                        <div class="building-3d-canvas min-h-[430px] flex-1 overflow-hidden">
                            ${floors.length ? `
                                <div class="building-3d-scene" data-building-3d-scene>
                                    <div class="building-3d-axis-label">拖曳空白處旋轉 · 滾輪縮放 · 點選樓層對照資訊</div>
                                    <div class="building-3d-view-note">${state.isBuilding3DExpanded ? '分層閱讀' : '全棟檢視'}<small>示意間距，非實際樓高比例</small></div>
                                    <svg class="building-3d-connectors" aria-hidden="true"></svg>
                                    <div class="building-3d-callouts" aria-label="各樓層關鍵資訊">${callouts}</div>
                                    <div class="building-3d-ground"></div>
                                    <div class="building-3d-stage" data-building-3d-stage style="--building-angle:${Number(state.building3DRotation ?? -38)}deg;--building-tilt:${Number(state.building3DTilt ?? 58)}deg;--building-zoom:${Number(state.building3DZoom ?? 1)}">
                                        ${floorModels}
                                    </div>
                                </div>` : renderEmptyBuilding(buildingName, unknownSummary)}
                        </div>
                    </div>

                    <aside class="min-h-0 overflow-visible border-t border-slate-200 bg-slate-100/80 p-4 xl:overflow-y-auto xl:border-l xl:border-t-0 dark:border-slate-800 dark:bg-slate-900/60">
                        <div class="mb-3 flex items-center justify-between">
                            <h3 class="text-sm font-black text-slate-700 dark:text-slate-200">樓層資訊</h3>
                            <span class="text-[11px] font-bold text-slate-400">與模型同步</span>
                        </div>
                        ${selectedDetail || '<p>尚無樓層資料</p>'}
                        <div class="mt-5 border-t border-slate-200 pt-4 dark:border-slate-700">
                            <div class="mb-3 text-xs font-black text-slate-500 dark:text-slate-300">圖面色彩</div>
                            <div class="grid grid-cols-2 gap-2 text-[11px] font-bold text-slate-500 dark:text-slate-400">
                                <span class="flex items-center gap-2"><i class="h-2.5 w-2.5" style="background:${COLORS.clean}"></i>無塵室</span>
                                <span class="flex items-center gap-2"><i class="h-2.5 w-2.5" style="background:${COLORS.prod}"></i>生產週邊</span>
                                <span class="flex items-center gap-2"><i class="h-2.5 w-2.5" style="background:${COLORS.fac}"></i>廠務設施</span>
                                <span class="flex items-center gap-2"><i class="h-2.5 w-2.5" style="background:${COLORS.pub}"></i>公設／其他</span>
                            </div>
                            <p class="mt-3 text-[11px] leading-5 text-slate-400">彩色分帶表示選取樓層的分類面積組成，不代表實際平面配置。未成廠以虛線呈現。樓板為相對尺寸示意，不代表建築外型或實際樓高比例。</p>
                        </div>
                    </aside>
                </div>
            </section>
        </div>`;
};

let disposeScene = () => {};
export const bindBuilding3DInteractions = (state) => {
    disposeScene();
    disposeScene = () => {};
    if (!state.isBuilding3DOpen) return;
    const scene = document.querySelector('[data-building-3d-scene]');
    const stage = document.querySelector('[data-building-3d-stage]');
    if (!scene || !stage || scene.dataset.bound === 'true') return;
    scene.dataset.bound = 'true';

    const connectors = scene.querySelector('.building-3d-connectors');
    const rail = scene.querySelector('.building-3d-callouts');
    const updateConnectors = () => {
        if (!scene.isConnected) return;
        const bounds = scene.getBoundingClientRect();
        const railBounds = rail.getBoundingClientRect();
        connectors.replaceChildren();
        for (const label of rail.querySelectorAll('[data-floor-callout]')) {
            if (!label.classList.contains('is-selected')) continue;
            const anchor = [...stage.querySelectorAll('[data-floor-anchor]')].find(el => el.dataset.floorAnchor === label.dataset.floorCallout);
            if (!anchor) continue;
            const a = anchor.getBoundingClientRect(), b = label.getBoundingClientRect();
            const y = b.top + b.height / 2;
            if (y < railBounds.top || y > railBounds.bottom) continue;
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            const x1 = a.right - bounds.left, y1 = a.top + a.height / 2 - bounds.top;
            const x2 = b.left - bounds.left, y2 = y - bounds.top;
            line.setAttribute('d', `M ${x1} ${y1} H ${x2 - 18} V ${y2} H ${x2}`);
            line.setAttribute('class', label.classList.contains('is-selected') ? 'is-selected' : '');
            connectors.append(line);
        }
    };
    rail.addEventListener('scroll', updateConnectors);
    rail.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
    const selectedLabel = rail.querySelector('.is-selected');
    if (selectedLabel) rail.scrollTop = Math.max(0, selectedLabel.offsetTop - rail.clientHeight / 2);
    const fitView = () => {
        if (!scene.isConnected) return;
        stage.style.setProperty('--building-zoom', '1');
        const faces = [...stage.querySelectorAll('.building-3d-top')].map(el => el.getBoundingClientRect());
        const width = Math.max(...faces.map(b => b.right)) - Math.min(...faces.map(b => b.left));
        const height = Math.max(...faces.map(b => b.bottom)) - Math.min(...faces.map(b => b.top));
        const availableWidth = Math.max(100, rail.offsetLeft - 44);
        const fit = Math.min(1.1, availableWidth / Math.max(1, width), (scene.clientHeight - 140) / Math.max(1, height));
        stage.style.setProperty('--building-zoom', String(Math.max(.08, fit) * Number(state.building3DZoom ?? 1)));
        updateConnectors();
    };
    requestAnimationFrame(fitView);
    const observer = new ResizeObserver(() => {
        if (!scene.isConnected) observer.disconnect();
        else fitView();
    });
    observer.observe(scene);
    disposeScene = () => observer.disconnect();

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startAngle = Number(state.building3DRotation ?? -38);
    let startTilt = Number(state.building3DTilt ?? 58);

    const applyView = () => {
        stage.style.setProperty('--building-angle', `${state.building3DRotation}deg`);
        stage.style.setProperty('--building-tilt', `${state.building3DTilt}deg`);
        fitView();
    };

    scene.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.target.closest('button, .building-3d-callouts')) return;
        dragging = true;
        startX = event.clientX;
        startY = event.clientY;
        startAngle = Number(state.building3DRotation ?? -38);
        startTilt = Number(state.building3DTilt ?? 58);
        scene.classList.add('is-dragging');
        scene.setPointerCapture?.(event.pointerId);
    });

    scene.addEventListener('pointermove', event => {
        if (!dragging) return;
        state.building3DRotation = startAngle + (event.clientX - startX) * 0.35;
        state.building3DTilt = Math.max(35, Math.min(75, startTilt - (event.clientY - startY) * 0.22));
        applyView();
    });

    const stopDragging = event => {
        if (!dragging) return;
        dragging = false;
        scene.classList.remove('is-dragging');
        scene.releasePointerCapture?.(event.pointerId);
    };
    scene.addEventListener('pointerup', stopDragging);
    scene.addEventListener('pointercancel', stopDragging);

    scene.addEventListener('wheel', event => {
        event.preventDefault();
        const direction = event.deltaY > 0 ? -0.06 : 0.06;
        state.building3DZoom = Math.max(0.65, Math.min(1.35, Number(state.building3DZoom ?? 1) + direction));
        applyView();
    }, { passive: false });
};
