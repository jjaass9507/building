import { formatArea } from './utils.js';

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
const METRICS = { height: '樓高', floorLoad: '荷重', usage: '製程', area: '面積' };
const metricValue = (floor, metric, unit) => {
    if (metric === 'usage') return escapeHtml(floor.usageLabel || '未提供');
    if (metric === 'area') {
        if (!(getValue(floor.area) > 0)) return '未提供';
        const area = formatArea(getValue(floor.area), unit);
        return `${area.val} ${area.unit}`;
    }
    return measurement(floor[metric], metric === 'floorLoad' ? 'kgf/m²' : 'm');
};

const renderMetric = (label, value, unit, colorClass = 'text-slate-800 dark:text-white') => {
    const formatted = formatArea(value, unit);
    return `
        <div class="border-l-2 border-slate-200 dark:border-slate-700 pl-3">
            <div class="text-[11px] font-bold text-slate-400">${label}</div>
            <div class="mt-0.5 font-mono text-lg font-black ${colorClass}">${formatted.val}<span class="ml-1 text-[11px] text-slate-400">${formatted.unit}</span></div>
        </div>`;
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
    const selected = floors.find(item => item.id === state.selected3DFloorId) || null;
    const floorIntervals = Math.max(0, floors.length - 1);
    const metric = Object.prototype.hasOwnProperty.call(METRICS, state.building3DMetric) ? state.building3DMetric : 'usage';
    const gap = 32;
    const volumeHeight = 30;
    const coreSpan = floorIntervals * gap + volumeHeight + 18;
    const coreBottom = -(floors.length - 1) * gap / 2 - 9;
    const floorModels = floors.map((floor, index) => {
        const areaRatio = Math.sqrt(Math.max(0, getValue(floor.area)) / maxArea);
        const width = Math.round(230 + 150 * areaRatio);
        const depth = Math.round(108 + 72 * areaRatio);
        const level = (index - (floors.length - 1) / 2) * gap;
        const selectedClass = selected?.id === floor.id ? 'is-selected' : '';
        const plannedClass = floor.status === '未成廠' ? 'is-planned' : '';
        const encodedFloorId = encodeHandlerValue(floor.id);

        return `
            <div class="building-3d-floor ${selectedClass} ${plannedClass}" style="--floor-width:${width}px;--floor-depth:${depth}px;--floor-level:${level}px;--floor-order:${index}">
                <button type="button" class="building-3d-volume" onclick="window.app.select3DFloor(decodeURIComponent('${encodedFloorId}'))" aria-label="查看 ${escapeHtml(floor.floor)} 樓層資訊">
                    <span class="building-3d-top"><span class="building-3d-roof-line"></span></span>
                    <span class="building-3d-front" data-floor-face="${escapeHtml(floor.id)}">
                        <span class="building-3d-window-band"></span>
                        <span class="building-3d-face-info">
                            <strong>${escapeHtml(floor.floor)}</strong>
                            <span>${metricValue(floor, metric, state.unit)}</span>
                        </span>
                    </span>
                    <span class="building-3d-side"><span class="building-3d-window-band"></span></span>
                    <span class="building-3d-corner"></span>
                </button>
            </div>`;
    }).join('');

    const selectedArea = selected ? formatArea(getValue(selected.area), state.unit) : null;
    const selectedDetail = selected ? `
        <section class="building-3d-detail building-3d-overlay-detail">
            <div class="building-3d-detail-heading">
                <div>
                    <div class="building-3d-detail-kicker">選取樓層</div>
                    <h3>${escapeHtml(selected.floor)} · ${escapeHtml(selected.usageLabel || '非製程')}</h3>
                </div>
                <span class="building-3d-status ${selected.status === '未成廠' ? 'is-planned' : ''}">${escapeHtml(selected.status || '未提供')}</span>
            </div>
            <div class="building-3d-detail-facts">${floorFacts(selected)}
                <div class="building-3d-detail-area">樓地板面積 <strong>${selectedArea.val} ${selectedArea.unit}</strong></div>
            </div>
        </section>` : '';

    return `
        <div class="fixed inset-0 z-[110] bg-slate-950/70 p-2 md:p-5" onclick="window.app.closeBuilding3D()">
            <section role="dialog" aria-modal="true" aria-labelledby="building-3d-title" class="building-3d-dialog mx-auto flex h-full max-h-[94vh] w-full max-w-[1500px] flex-col overflow-hidden border border-slate-200 bg-slate-50 shadow-2xl dark:border-slate-700 dark:bg-slate-950" onclick="event.stopPropagation()">
                <header class="flex flex-none flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-white px-5 py-4 dark:border-slate-800 dark:bg-slate-900">
                    <div class="flex items-center gap-3">
                        <span class="inline-flex h-10 w-10 items-center justify-center bg-slate-800 text-white dark:bg-blue-600"><i data-lucide="box" class="h-5 w-5"></i></span>
                        <div>
                            <div class="building-3d-eyebrow">Architectural Floor View</div>
                            <h2 id="building-3d-title" class="text-xl font-black text-slate-900 dark:text-white">${escapeHtml(buildingName)} 單棟 3D 示意圖</h2>
                        </div>
                    </div>
                    <div class="flex items-center gap-2">
                        <button type="button" onclick="window.app.setBuilding3DView('overview')" class="building-3d-tool px-3 text-xs font-bold ${state.building3DView !== 'front' ? 'is-active' : ''}">立體</button>
                        <button type="button" onclick="window.app.setBuilding3DView('front')" class="building-3d-tool px-3 text-xs font-bold ${state.building3DView === 'front' ? 'is-active' : ''}">正視</button>
                        <button type="button" onclick="window.app.rotateBuilding3D(-15)" class="building-3d-tool" title="向左旋轉"><i data-lucide="rotate-ccw" class="h-4 w-4"></i></button>
                        <button type="button" onclick="window.app.resetBuilding3DView()" class="building-3d-tool gap-1 px-3 text-xs font-bold" title="重設視角"><i data-lucide="scan" class="h-4 w-4"></i><span class="hidden sm:inline">重設</span></button>
                        <button type="button" onclick="window.app.rotateBuilding3D(15)" class="building-3d-tool" title="向右旋轉"><i data-lucide="rotate-cw" class="h-4 w-4"></i></button>
                        <button type="button" onclick="window.app.closeBuilding3D()" class="building-3d-tool ml-1" title="關閉"><i data-lucide="x" class="h-5 w-5"></i></button>
                    </div>
                </header>

                <div class="building-3d-metric-toolbar">
                    <span>顯示指標</span>
                    ${Object.entries(METRICS).map(([key, label]) => `<button type="button" aria-pressed="${key === metric}" class="${key === metric ? 'is-active' : ''}" onclick="window.app.setBuilding3DMetric('${key}')">${label}</button>`).join('')}
                </div>
                <div class="building-3d-layout min-h-0 flex-1 overflow-hidden">
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

                        <div class="building-3d-canvas min-h-0 flex-1 overflow-hidden">
                            ${floors.length ? `
                                <div class="building-3d-scene" data-building-3d-scene style="--floor-count:${floors.length}">
                                    <div class="building-3d-axis-label">拖曳旋轉 · Ctrl＋滾輪縮放 · 全樓層自動適應畫面</div>
                                    <div class="building-3d-view-note">完整建築量體<small>點選樓層或標籤查看資料</small></div>
                                    ${selectedDetail}
                                    <div class="building-3d-ground"></div>
                                    <div class="building-3d-stage" data-building-3d-stage style="--building-angle:${Number(state.building3DRotation ?? -38)}deg;--building-tilt:${Number(state.building3DTilt ?? 58)}deg;--building-zoom:${Number(state.building3DZoom ?? 1)}">
                                        <div class="building-3d-core" style="--core-span:${coreSpan}px;--core-bottom:${coreBottom}px" aria-hidden="true">
                                            <span class="building-3d-core-top"></span>
                                            <span class="building-3d-core-front"></span>
                                            <span class="building-3d-core-side"></span>
                                        </div>
                                        <div class="building-3d-podium" style="--podium-level:${coreBottom - 22}px" aria-hidden="true"><span></span></div>
                                        ${floorModels}
                                        <div class="building-3d-roof-cap" style="--roof-level:${coreBottom + coreSpan + 4}px" aria-hidden="true"><span></span></div>
                                    </div>
                                </div>` : renderEmptyBuilding(buildingName, unknownSummary)}
                        </div>
                    </div>

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

    const updateSelectedDetail = () => {
        if (!scene.isConnected) return;
        const detail = scene.querySelector('.building-3d-overlay-detail');
        const selectedFace = stage.querySelector('.building-3d-floor.is-selected .building-3d-front');
        if (!detail || !selectedFace) return;
        const bounds = scene.getBoundingClientRect();
        const faceBounds = selectedFace.getBoundingClientRect();
        const detailWidth = detail.offsetWidth;
        const detailHeight = detail.offsetHeight;
        const preferredLeft = faceBounds.right - bounds.left + 18;
        const alternateLeft = faceBounds.left - bounds.left - detailWidth - 18;
        const left = preferredLeft + detailWidth < scene.clientWidth - 8 ? preferredLeft : Math.max(8, alternateLeft);
        const faceCenterY = faceBounds.top + faceBounds.height / 2 - bounds.top;
        const top = Math.max(8, Math.min(scene.clientHeight - detailHeight - 8, faceCenterY - detailHeight / 2));
        detail.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    };
    const fitView = () => {
        if (!scene.isConnected) return;
        stage.style.left = '50%';
        stage.style.top = '52%';
        stage.style.setProperty('--building-zoom', '1');
        const modelSelector = '.building-3d-top,.building-3d-front,.building-3d-side,.building-3d-podium > span,.building-3d-roof-cap > span';
        const modelBounds = () => [...stage.querySelectorAll(modelSelector)].map(el => el.getBoundingClientRect());
        const faces = modelBounds();
        if (!faces.length) return;
        const width = Math.max(...faces.map(b => b.right)) - Math.min(...faces.map(b => b.left));
        const height = Math.max(...faces.map(b => b.bottom)) - Math.min(...faces.map(b => b.top));
        const availableWidth = Math.max(160, scene.clientWidth - 100);
        const availableHeight = Math.max(120, scene.clientHeight - 80);
        const fit = Math.min(1.08, availableWidth / Math.max(1, width), availableHeight / Math.max(1, height));
        stage.style.setProperty('--building-zoom', String(Math.max(.035, fit) * Number(state.building3DZoom ?? 1)));
        requestAnimationFrame(() => {
            if (!scene.isConnected) return;
            const scaled = modelBounds();
            const left = Math.min(...scaled.map(b => b.left));
            const right = Math.max(...scaled.map(b => b.right));
            const top = Math.min(...scaled.map(b => b.top));
            const bottom = Math.max(...scaled.map(b => b.bottom));
            const sceneBounds = scene.getBoundingClientRect();
            const shiftX = sceneBounds.left + scene.clientWidth / 2 - (left + right) / 2;
            const shiftY = sceneBounds.top + scene.clientHeight / 2 - (top + bottom) / 2;
            stage.style.left = `${scene.clientWidth / 2 + shiftX}px`;
            stage.style.top = `${scene.clientHeight * .52 + shiftY}px`;
            requestAnimationFrame(updateSelectedDetail);
        });
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
        if (event.button !== 0 || event.target.closest('button, .building-3d-overlay-detail')) return;
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
        state.building3DView = 'overview';
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
        if (!event.ctrlKey) return;
        event.preventDefault();
        const direction = event.deltaY > 0 ? -0.06 : 0.06;
        state.building3DZoom = Math.max(0.65, Math.min(1.35, Number(state.building3DZoom ?? 1) + direction));
        applyView();
    }, { passive: false });
};

