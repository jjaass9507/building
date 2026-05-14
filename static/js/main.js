import { processRawData } from './data.js';
import { formatArea } from './utils.js';
import { renderHeader, renderMatrix, renderPanel } from './components.js';

// --- 狀態管理 (State) ---
const state = {
    displayMode: 'area',
    barLabelType: 'val',
    selectedZone: null,
    selectedBuilding: null,
    filterBuildings: [],
    unit: 'ping',
    includeUnfinished: false,
    isDarkMode: localStorage.getItem('theme') === 'dark',
    currentUser: null,
    uploadStatus: null,
    isUploading: false,
    isTrendOpen: false,
    isFilterCollapsed: true
};

const HIDDEN_MATRIX_FLOORS = new Set(['ALL']);
const isHiddenMatrixFloor = (floor) => HIDDEN_MATRIX_FLOORS.has(String(floor || '').toUpperCase().trim());
let trendChart = null;

if (state.isDarkMode) {
    document.documentElement.classList.add('dark');
}

let appData = {
    source: [],
    processed: [],
    meta: {},
    sortedFloors: []
};

const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const formatFloorLoadValue = (value) => {
    const num = Number(value || 0);
    if (!Number.isFinite(num) || num <= 0) return '-';
    return num.toLocaleString(undefined, { maximumFractionDigits: 0 });
};

const formatFloorLoadCell = (value) => {
    const loadText = formatFloorLoadValue(value);
    return `
        <span class="font-mono font-bold text-lg text-slate-700 dark:text-slate-200 leading-tight">${escapeHtml(loadText)}</span>
        <span class="block text-[10px] text-slate-400 font-bold leading-tight mt-0.5">kgf/m²</span>
    `;
};

const createLoadModeButton = () => `
    <button onclick="window.app.updateState('displayMode', 'load')" class="flex items-center gap-1 px-2 py-1 rounded text-base transition-all ${state.displayMode === 'load' ? 'bg-slate-700 dark:bg-blue-600 text-white shadow-sm font-bold' : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'}">
        <i data-lucide="scale" class="w-3 h-3"></i> 荷重
    </button>`;

const createTrendButton = () => `
    <button onclick="window.app.openTrendModal()" class="flex items-center gap-1 px-3 py-1 rounded text-base transition-all bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-blue-50 hover:text-blue-700 dark:hover:bg-slate-700 font-bold">
        <i data-lucide="line-chart" class="w-3.5 h-3.5"></i> 成長趨勢
    </button>`;

const createFilterToggleButton = () => `
    <button onclick="window.app.toggleFilterPanel()" class="flex items-center gap-1 px-3 py-1 rounded text-base transition-all ${state.isFilterCollapsed ? 'bg-slate-800 dark:bg-blue-600 text-white border border-slate-800 dark:border-blue-600 shadow-sm' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'} font-bold">
        <i data-lucide="${state.isFilterCollapsed ? 'sliders-horizontal' : 'chevron-up'}" class="w-3.5 h-3.5"></i>
        ${state.isFilterCollapsed ? '展開篩選' : '收合篩選'}
    </button>`;

const applyCompactHeader = (headerHtml) => {
    if (!state.isFilterCollapsed) return headerHtml;

    return headerHtml
        .replace(
            '<div class="h-px w-full bg-slate-100 dark:bg-slate-800"></div>',
            '<div class="hidden h-px w-full bg-slate-100 dark:bg-slate-800"></div>'
        )
        .replace(
            '<div class="flex flex-col xl:flex-row gap-4 items-start">',
            '<div class="hidden flex-col xl:flex-row gap-4 items-start">'
        )
        .replace(
            '<div class="flex flex-wrap items-center gap-6 px-1 py-1 border-t border-slate-50 dark:border-slate-800 mt-1">',
            '<div class="hidden flex-wrap items-center gap-6 px-1 py-1 border-t border-slate-50 dark:border-slate-800 mt-1">'
        )
        .replace(
            '<div class="max-w-[1920px] mx-auto px-4 py-3">',
            '<div class="max-w-[1920px] mx-auto px-4 py-2">'
        );
};

const injectHeaderButtons = (headerHtml) => {
    let nextHtml = headerHtml;

    if (!nextHtml.includes("displayMode', 'load'")) {
        nextHtml = nextHtml.replace(
            /(<button onclick="window\.app\.updateState\('displayMode', 'height'\)"[\s\S]*?<\/button>)/,
            `$1${createLoadModeButton()}`
        );
    }

    if (!nextHtml.includes('openTrendModal')) {
        nextHtml = nextHtml.replace(
            /(<\/div>\s*<\/div>\s*<div class="hidden xl:block w-px h-8 bg-slate-200 dark:bg-slate-700 shrink-0"><\/div>)/,
            `${createTrendButton()}</div></div><div class="hidden xl:block w-px h-8 bg-slate-200 dark:bg-slate-700 shrink-0"></div>`
        );
    }

    if (!nextHtml.includes('toggleFilterPanel')) {
        nextHtml = nextHtml.replace(
            /(<button onclick="window\.app\.updateState\('isDarkMode',[\s\S]*?<\/button>)/,
            `$1${createFilterToggleButton()}`
        );
    }

    return applyCompactHeader(nextHtml);
};

const parseExpectedYear = (value) => {
    const text = String(value || '').trim().toUpperCase();
    if (!text) return null;
    const match = text.match(/Y\s*(\d{1,4})/i) || text.match(/(\d{4})/);
    if (!match) return null;
    const num = Number(match[1]);
    return Number.isFinite(num) ? num : null;
};

const formatYearLabel = (year) => year === 0 ? '現況' : `Y${year}`;

const buildAreaTrendData = () => {
    const yearlyAdditions = new Map();
    let baseClean = 0;
    let baseProd = 0;

    appData.processed.forEach(item => {
        const year = parseExpectedYear(item.expectedCompletionYear);
        const clean = Number(item.cleanRoomArea || 0);
        const prod = Number(item.prodArea || 0);

        if (year === null) {
            baseClean += clean;
            baseProd += prod;
            return;
        }

        const current = yearlyAdditions.get(year) || { clean: 0, prod: 0 };
        current.clean += clean;
        current.prod += prod;
        yearlyAdditions.set(year, current);
    });

    const years = Array.from(yearlyAdditions.keys()).sort((a, b) => a - b);
    const labels = ['現況', ...years.map(formatYearLabel)];
    const cleanValues = [baseClean];
    const prodValues = [baseProd];
    const additions = [{ year: 0, clean: baseClean, prod: baseProd }];

    let runningClean = baseClean;
    let runningProd = baseProd;

    years.forEach(year => {
        const add = yearlyAdditions.get(year) || { clean: 0, prod: 0 };
        runningClean += add.clean;
        runningProd += add.prod;
        cleanValues.push(runningClean);
        prodValues.push(runningProd);
        additions.push({ year, clean: add.clean, prod: add.prod });
    });

    return { labels, cleanValues, prodValues, additions };
};

const renderTrendModal = () => {
    if (!state.isTrendOpen) return '';
    const trend = buildAreaTrendData();
    const latestClean = trend.cleanValues[trend.cleanValues.length - 1] || 0;
    const latestProd = trend.prodValues[trend.prodValues.length - 1] || 0;
    const latestTotal = latestClean + latestProd;
    const cleanDisplay = formatArea(latestClean, state.unit);
    const prodDisplay = formatArea(latestProd, state.unit);
    const totalDisplay = formatArea(latestTotal, state.unit);

    return `
        <div class="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4" onclick="window.app.closeTrendModal()">
            <section class="w-full max-w-6xl max-h-[90vh] overflow-auto rounded-2xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-700" onclick="event.stopPropagation()">
                <div class="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur px-6 py-4">
                    <div>
                        <div class="flex items-center gap-2">
                            <span class="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm"><i data-lucide="line-chart" class="w-5 h-5"></i></span>
                            <h2 class="text-xl font-black text-slate-800 dark:text-slate-100">無塵室 & 生產週邊面積成長趨勢</h2>
                        </div>
                        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">依「預計成廠年份」累計；沒有年份的已成廠資料歸入現況基準。</p>
                    </div>
                    <button onclick="window.app.closeTrendModal()" class="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200">
                        <i data-lucide="x" class="w-6 h-6"></i>
                    </button>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-3 gap-3 px-6 pt-5">
                    <div class="rounded-xl border border-sky-100 dark:border-sky-900/50 bg-sky-50 dark:bg-sky-950/30 p-4">
                        <div class="text-sm font-bold text-sky-600 dark:text-sky-300">累計無塵室面積</div>
                        <div class="mt-1 text-2xl font-black text-slate-800 dark:text-white">${cleanDisplay.val}<span class="ml-1 text-sm text-slate-400">${cleanDisplay.unit}</span></div>
                    </div>
                    <div class="rounded-xl border border-emerald-100 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/30 p-4">
                        <div class="text-sm font-bold text-emerald-600 dark:text-emerald-300">累計生產週邊面積</div>
                        <div class="mt-1 text-2xl font-black text-slate-800 dark:text-white">${prodDisplay.val}<span class="ml-1 text-sm text-slate-400">${prodDisplay.unit}</span></div>
                    </div>
                    <div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 p-4">
                        <div class="text-sm font-bold text-slate-500 dark:text-slate-300">合計面積</div>
                        <div class="mt-1 text-2xl font-black text-slate-800 dark:text-white">${totalDisplay.val}<span class="ml-1 text-sm text-slate-400">${totalDisplay.unit}</span></div>
                    </div>
                </div>

                <div class="px-6 py-5">
                    <div class="h-[420px] rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-4">
                        <canvas id="area-trend-chart"></canvas>
                    </div>
                </div>

                <div class="px-6 pb-6">
                    <h3 class="mb-3 text-sm font-black text-slate-600 dark:text-slate-300">年度新增明細</h3>
                    <div class="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
                        <table class="w-full text-sm">
                            <thead class="bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-300">
                                <tr>
                                    <th class="px-4 py-2 text-left">年份</th>
                                    <th class="px-4 py-2 text-right">新增無塵室</th>
                                    <th class="px-4 py-2 text-right">新增生產週邊</th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
                                ${trend.additions.map(row => {
                                    const clean = formatArea(row.clean, state.unit);
                                    const prod = formatArea(row.prod, state.unit);
                                    return `
                                        <tr class="bg-white dark:bg-slate-900">
                                            <td class="px-4 py-2 font-bold text-slate-700 dark:text-slate-200">${formatYearLabel(row.year)}</td>
                                            <td class="px-4 py-2 text-right font-mono text-slate-700 dark:text-slate-200">${clean.val} ${clean.unit}</td>
                                            <td class="px-4 py-2 text-right font-mono text-slate-700 dark:text-slate-200">${prod.val} ${prod.unit}</td>
                                        </tr>`;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            </section>
        </div>`;
};

const drawTrendChart = () => {
    if (!state.isTrendOpen) return;
    const canvas = document.getElementById('area-trend-chart');
    if (!canvas || typeof Chart === 'undefined') return;

    if (trendChart) {
        trendChart.destroy();
        trendChart = null;
    }

    const trend = buildAreaTrendData();
    const toUnitValue = (value) => state.unit === 'ping' ? value * 0.3025 : value;
    const unitLabel = state.unit === 'ping' ? '坪' : 'm²';
    const textColor = state.isDarkMode ? '#CBD5E1' : '#334155';
    const gridColor = state.isDarkMode ? 'rgba(148,163,184,0.18)' : 'rgba(148,163,184,0.28)';

    trendChart = new Chart(canvas, {
        type: 'line',
        data: {
            labels: trend.labels,
            datasets: [
                {
                    label: `累計無塵室面積 (${unitLabel})`,
                    data: trend.cleanValues.map(toUnitValue),
                    borderColor: '#0EA5E9',
                    backgroundColor: 'rgba(14, 165, 233, 0.12)',
                    tension: 0.35,
                    fill: true,
                    pointRadius: 4,
                    pointHoverRadius: 6
                },
                {
                    label: `累計生產週邊面積 (${unitLabel})`,
                    data: trend.prodValues.map(toUnitValue),
                    borderColor: '#10B981',
                    backgroundColor: 'rgba(16, 185, 129, 0.10)',
                    tension: 0.35,
                    fill: true,
                    pointRadius: 4,
                    pointHoverRadius: 6
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { color: textColor, font: { weight: 'bold' } } },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.dataset.label}: ${Math.round(ctx.parsed.y).toLocaleString()} ${unitLabel}`
                    }
                }
            },
            scales: {
                x: { ticks: { color: textColor, font: { weight: 'bold' } }, grid: { color: gridColor } },
                y: {
                    beginAtZero: true,
                    ticks: { color: textColor, callback: (value) => Number(value).toLocaleString() },
                    grid: { color: gridColor }
                }
            }
        }
    });
};

const renderAdminUploadPanel = () => {
    if (state.currentUser?.role !== 'admin') return '';

    const status = state.uploadStatus;
    const statusHtml = status ? `
        <div class="mt-3 rounded-lg border ${status.success ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'} px-4 py-3 text-sm">
            <div class="font-bold">${escapeHtml(status.message)}</div>
            ${status.backup_file ? `<div class="mt-1 text-xs opacity-80">上一版備份：${escapeHtml(status.backup_file)}</div>` : ''}
            ${status.rows !== undefined ? `<div class="mt-1 text-xs opacity-80">樓層筆數：${escapeHtml(status.rows)}，棟別數：${escapeHtml(status.buildings)}</div>` : ''}
            ${status.warnings?.length ? `
                <details class="mt-2">
                    <summary class="cursor-pointer font-bold">轉換警告 ${status.warnings.length} 筆</summary>
                    <ul class="mt-2 list-disc pl-5 space-y-1">
                        ${status.warnings.slice(0, 20).map(w => `<li>${escapeHtml(w)}</li>`).join('')}
                    </ul>
                </details>` : ''}
        </div>` : '';

    return `
        <section class="mx-2 md:mx-6 mt-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-sm p-3 transition-colors">
            <div class="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
                <div>
                    <div class="flex items-center gap-2">
                        <span class="inline-flex items-center rounded-full bg-blue-50 dark:bg-blue-900/40 px-2.5 py-1 text-xs font-black text-blue-700 dark:text-blue-300">ADMIN</span>
                        <h2 class="text-lg font-black text-slate-800 dark:text-slate-100">資料更新</h2>
                    </div>
                    <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">上傳樓層面積資訊 Excel（.xlsx）後，系統會先備份上一版 data.json，再更新目前資料。</p>
                </div>
                <form class="flex flex-col sm:flex-row gap-2 sm:items-center" onsubmit="window.app.uploadDataFile(event)">
                    <input id="admin-data-file" name="file" type="file" accept=".xlsx" class="block w-full sm:w-80 text-sm text-slate-500 dark:text-slate-300 file:mr-4 file:rounded-full file:border-0 file:bg-slate-800 file:px-4 file:py-2 file:text-sm file:font-bold file:text-white hover:file:bg-slate-700 dark:file:bg-blue-600 dark:hover:file:bg-blue-500" ${state.isUploading ? 'disabled' : ''}>
                    <button type="submit" class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-black text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60" ${state.isUploading ? 'disabled' : ''}>${state.isUploading ? '更新中...' : '上傳並更新'}</button>
                </form>
            </div>
            ${statusHtml}
        </section>`;
};

const loadData = async () => {
    const res = await fetch('/api/data', { cache: 'no-store' });
    if (!res.ok) throw new Error('API Error');
    const rawData = await res.json();
    const result = processRawData(rawData);
    appData.source = rawData;
    appData.processed = result.processedData;
    appData.meta = result.buildingMeta;
    appData.sortedFloors = result.sortedFloorLabels;
};

const render = () => {
    const scrollContainer = document.getElementById('matrix-scroll-container');
    const savedScrollLeft = scrollContainer ? scrollContainer.scrollLeft : 0;
    const savedScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
    const app = document.getElementById('app');

    const dataForTotal = state.includeUnfinished
        ? appData.processed
        : appData.processed.filter(d => d.status !== '未成廠' || isHiddenMatrixFloor(d.floor));

    const totalArea = dataForTotal.reduce((acc, curr) => acc + (curr.area || 0), 0);
    const totalClean = dataForTotal.reduce((acc, curr) => acc + (curr.cleanRoomArea || 0), 0);
    const totals = {
        area: formatArea(totalArea, state.unit),
        cleanRoom: formatArea(totalClean, state.unit)
    };

    const allNames = Object.keys(appData.meta);
    const activeBuildings = state.filterBuildings.length > 0 ? state.filterBuildings : allNames;

    const presentFloors = new Set();
    activeBuildings.forEach(bldg => {
        appData.processed
            .filter(d => d.building === bldg && !isHiddenMatrixFloor(d.floor))
            .forEach(d => presentFloors.add(d.floor));
    });
    const activeFloors = appData.sortedFloors.filter(f => presentFloors.has(f) && !isHiddenMatrixFloor(f));

    const summaryMatrixRows = appData.processed.map(item => (
        isHiddenMatrixFloor(item.floor)
            ? { ...item, floor: '__BUILDING_SUMMARY__', isSummaryOnly: true }
            : item
    ));

    const matrixData = state.displayMode === 'load'
        ? summaryMatrixRows.map(item => ({ ...item, usageLabel: formatFloorLoadCell(item.floorLoad) }))
        : summaryMatrixRows;

    const dataMap = {};
    matrixData
        .filter(item => !item.isSummaryOnly)
        .forEach(item => { dataMap[`${item.building}-${item.floor}`] = item; });

    const headerHtml = injectHeaderButtons(renderHeader(state, allNames, totals, appData.processed));

    app.innerHTML = `
        ${headerHtml}
        ${renderAdminUploadPanel()}
        <main class="flex-1 p-2 md:p-4 overflow-hidden flex flex-col relative bg-slate-50 dark:bg-slate-950 transition-colors duration-300">
            ${renderMatrix(state, activeBuildings, activeFloors, matrixData, dataMap, appData.meta)}
        </main>
        ${renderPanel(state, appData.meta, appData.processed)}
        ${renderTrendModal()}
    `;

    lucide.createIcons();
    setTimeout(drawTrendChart, 0);

    const newScrollContainer = document.getElementById('matrix-scroll-container');
    if (newScrollContainer) {
        newScrollContainer.scrollLeft = savedScrollLeft;
        newScrollContainer.scrollTop = savedScrollTop;
    }
};

window.app = {
    updateState: (k, v) => {
        state[k] = v;
        if (k === 'isDarkMode') {
            if (v) {
                document.documentElement.classList.add('dark');
                localStorage.setItem('theme', 'dark');
            } else {
                document.documentElement.classList.remove('dark');
                localStorage.setItem('theme', 'light');
            }
        }
        render();
    },
    toggleFilterPanel: () => {
        state.isFilterCollapsed = !state.isFilterCollapsed;
        render();
    },
    openTrendModal: () => {
        state.isTrendOpen = true;
        render();
    },
    closeTrendModal: () => {
        state.isTrendOpen = false;
        if (trendChart) {
            trendChart.destroy();
            trendChart = null;
        }
        render();
    },
    selectZone: (id) => {
        state.selectedZone = appData.processed.find(d => d.id === id);
        state.selectedBuilding = null;
        render();
    },
    selectBuilding: (b) => {
        state.selectedBuilding = b;
        state.selectedZone = null;
        render();
    },
    closePanel: () => {
        state.selectedZone = null;
        state.selectedBuilding = null;
        render();
    },
    toggleBuilding: (bldg) => {
        if (bldg === 'ALL') {
            state.filterBuildings = [];
        } else if (state.filterBuildings.includes(bldg)) {
            state.filterBuildings = state.filterBuildings.filter(b => b !== bldg);
        } else {
            state.filterBuildings.push(bldg);
        }
        render();
    },
    uploadDataFile: async (event) => {
        event.preventDefault();
        const fileInput = document.getElementById('admin-data-file');
        const file = fileInput?.files?.[0];

        if (!file) {
            state.uploadStatus = { success: false, message: '請先選擇要上傳的 .xlsx 檔案。' };
            render();
            return;
        }

        const formData = new FormData();
        formData.append('file', file);
        state.isUploading = true;
        state.uploadStatus = null;
        render();

        try {
            const res = await fetch('/api/admin/upload-data', { method: 'POST', body: formData });
            const result = await res.json();

            if (!res.ok || !result.success) {
                throw new Error(result.message || '資料更新失敗');
            }

            state.uploadStatus = {
                success: true,
                message: result.message || '資料更新成功。',
                backup_file: result.backup_file,
                rows: result.rows,
                buildings: result.buildings,
                warnings: result.warnings || []
            };

            await loadData();
            state.selectedZone = null;
            state.selectedBuilding = null;
            fileInput.value = '';
        } catch (e) {
            state.uploadStatus = { success: false, message: e.message || '資料更新失敗。' };
        } finally {
            state.isUploading = false;
            render();
        }
    }
};

const init = async () => {
    try {
        const meRes = await fetch('/api/me', { cache: 'no-store' });
        if (meRes.ok) {
            state.currentUser = await meRes.json();
        }

        await loadData();

        if (window.innerWidth < 768) {
            const allBuildings = Object.keys(appData.meta);
            const target = 'K18';
            if (allBuildings.includes(target)) {
                state.filterBuildings = [target];
            }
        }

        render();
    } catch (e) {
        console.error(e);
        document.getElementById('app').innerHTML = `<div class="p-10 text-center text-red-500">載入失敗: ${escapeHtml(e.message)}</div>`;
    }
};

init();