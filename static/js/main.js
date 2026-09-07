import { processRawData } from './data.js';
import { formatArea, apiUrl } from './utils.js';
import { renderHeader, renderMatrix, renderPanel, renderCompareTable } from './components.js';
import { renderBuilding3DModal, bindBuilding3DInteractions } from './building-3d.js?v=20260907-single-metric';

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
    trendMetric: 'clean',
    isFilterCollapsed: true,
    isCompareTableOpen: false,
    compareMode: 'value',
    compareExpanded: [],
    isBuilding3DOpen: false,
    building3DName: null,
    selected3DFloorId: null,
    building3DRotation: -38,
    building3DTilt: 58,
    building3DZoom: 1,
    isBuilding3DExpanded: false
};

const HIDDEN_MATRIX_FLOORS = new Set(['ALL']);
const isHiddenMatrixFloor = (floor) => HIDDEN_MATRIX_FLOORS.has(String(floor || '').toUpperCase().trim());
let trendCharts = { cumulative: null, annual: null };

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

const createCompareTableButton = () => `
    <button onclick="window.app.toggleCompareTable()" class="flex items-center gap-1 px-3 py-1 rounded text-base transition-all ${state.isCompareTableOpen ? 'bg-slate-700 dark:bg-blue-600 text-white shadow-sm font-bold border border-slate-700 dark:border-blue-600' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-blue-50 hover:text-blue-700 dark:hover:bg-slate-700 font-bold'}">
        <i data-lucide="table-2" class="w-3.5 h-3.5"></i> 比較表
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
            `${createCompareTableButton()}${createTrendButton()}</div></div><div class="hidden xl:block w-px h-8 bg-slate-200 dark:bg-slate-700 shrink-0"></div>`
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

const trendMetricOptions = {
    clean: {
        key: 'clean',
        label: '無塵室面積',
        shortLabel: '無塵室',
        color: '#0EA5E9',
        bgColor: 'rgba(14, 165, 233, 0.12)',
        borderClass: 'border-sky-100 dark:border-sky-900/50',
        bgClass: 'bg-sky-50 dark:bg-sky-950/30',
        textClass: 'text-sky-600 dark:text-sky-300'
    },
    prod: {
        key: 'prod',
        label: '生產週邊面積',
        shortLabel: '生產週邊',
        color: '#10B981',
        bgColor: 'rgba(16, 185, 129, 0.12)',
        borderClass: 'border-emerald-100 dark:border-emerald-900/50',
        bgClass: 'bg-emerald-50 dark:bg-emerald-950/30',
        textClass: 'text-emerald-600 dark:text-emerald-300'
    }
};

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
    const additions = [{ year: 0, clean: baseClean, prod: baseProd, cleanRate: null, prodRate: null }];

    let runningClean = baseClean;
    let runningProd = baseProd;

    years.forEach(year => {
        const add = yearlyAdditions.get(year) || { clean: 0, prod: 0 };
        const cleanRate = runningClean > 0 ? add.clean / runningClean : null;
        const prodRate = runningProd > 0 ? add.prod / runningProd : null;

        runningClean += add.clean;
        runningProd += add.prod;

        cleanValues.push(runningClean);
        prodValues.push(runningProd);
        additions.push({ year, clean: add.clean, prod: add.prod, cleanRate, prodRate });
    });

    return { labels, cleanValues, prodValues, additions };
};

const getTrendSeries = (trend) => {
    const metric = trendMetricOptions[state.trendMetric] || trendMetricOptions.clean;
    const cumulativeValues = state.trendMetric === 'prod' ? trend.prodValues : trend.cleanValues;
    const annualValues = trend.additions.map(row => state.trendMetric === 'prod' ? row.prod : row.clean);
    const annualRates = trend.additions.map(row => state.trendMetric === 'prod' ? row.prodRate : row.cleanRate);
    const latest = cumulativeValues[cumulativeValues.length - 1] || 0;
    const latestAnnual = annualValues[annualValues.length - 1] || 0;
    const latestRate = annualRates[annualRates.length - 1];

    return { metric, cumulativeValues, annualValues, annualRates, latest, latestAnnual, latestRate };
};

const formatGrowthRate = (rate) => {
    if (rate === null || rate === undefined || !Number.isFinite(rate)) return '-';
    return `${(rate * 100).toFixed(1)}%`;
};

const renderTrendMetricButton = (key, label) => `
    <button onclick="window.app.setTrendMetric('${key}')" class="px-4 py-2 rounded-xl text-sm font-black transition-all ${state.trendMetric === key ? 'bg-blue-600 text-white shadow-sm' : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'}">
        ${label}
    </button>`;

const renderTrendModal = () => {
    if (!state.isTrendOpen) return '';

    const trend = buildAreaTrendData();
    const series = getTrendSeries(trend);
    const latestDisplay = formatArea(series.latest, state.unit);
    const latestAnnualDisplay = formatArea(series.latestAnnual, state.unit);
    const totalClean = trend.cleanValues[trend.cleanValues.length - 1] || 0;
    const totalProd = trend.prodValues[trend.prodValues.length - 1] || 0;
    const totalDisplay = formatArea(totalClean + totalProd, state.unit);

    return `
        <div class="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4" onclick="window.app.closeTrendModal()">
            <section class="w-full max-w-7xl max-h-[92vh] overflow-auto rounded-2xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-700" onclick="event.stopPropagation()">
                <div class="sticky top-0 z-10 flex flex-col xl:flex-row xl:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur px-6 py-4">
                    <div>
                        <div class="flex items-center gap-2">
                            <span class="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm"><i data-lucide="line-chart" class="w-5 h-5"></i></span>
                            <h2 class="text-xl font-black text-slate-800 dark:text-slate-100">面積成長趨勢</h2>
                        </div>
                        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">依「預計成廠年份」累計；沒有年份的已成廠資料歸入現況基準。上圖為累計總量，下圖為年度新增量。</p>
                    </div>
                    <div class="flex items-center gap-2">
                        ${renderTrendMetricButton('clean', '無塵室面積')}
                        ${renderTrendMetricButton('prod', '生產週邊面積')}
                        <button onclick="window.app.closeTrendModal()" class="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200">
                            <i data-lucide="x" class="w-6 h-6"></i>
                        </button>
                    </div>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-3 gap-3 px-6 pt-5">
                    <div class="rounded-xl border ${series.metric.borderClass} ${series.metric.bgClass} p-4">
                        <div class="text-sm font-bold ${series.metric.textClass}">目前累計${series.metric.shortLabel}</div>
                        <div class="mt-1 text-2xl font-black text-slate-800 dark:text-white">${latestDisplay.val}<span class="ml-1 text-sm text-slate-400">${latestDisplay.unit}</span></div>
                    </div>
                    <div class="rounded-xl border border-indigo-100 dark:border-indigo-900/50 bg-indigo-50 dark:bg-indigo-950/30 p-4">
                        <div class="text-sm font-bold text-indigo-600 dark:text-indigo-300">最後年度新增量</div>
                        <div class="mt-1 text-2xl font-black text-slate-800 dark:text-white">${latestAnnualDisplay.val}<span class="ml-1 text-sm text-slate-400">${latestAnnualDisplay.unit}</span></div>
                        <div class="mt-1 text-xs font-bold text-slate-400">年增率：${formatGrowthRate(series.latestRate)}</div>
                    </div>
                    <div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 p-4">
                        <div class="text-sm font-bold text-slate-500 dark:text-slate-300">無塵室 + 生產週邊合計</div>
                        <div class="mt-1 text-2xl font-black text-slate-800 dark:text-white">${totalDisplay.val}<span class="ml-1 text-sm text-slate-400">${totalDisplay.unit}</span></div>
                    </div>
                </div>

                <div class="px-6 py-5 space-y-5">
                    <div class="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-4">
                        <div class="mb-3 flex items-center justify-between">
                            <h3 class="text-sm font-black text-slate-600 dark:text-slate-300">累計總面積趨勢｜${series.metric.label}</h3>
                            <span class="text-xs font-bold text-slate-400">折線圖 / 絕對數字</span>
                        </div>
                        <div class="h-[300px]"><canvas id="area-cumulative-chart"></canvas></div>
                    </div>

                    <div class="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-4">
                        <div class="mb-3 flex items-center justify-between">
                            <h3 class="text-sm font-black text-slate-600 dark:text-slate-300">年增面積量｜${series.metric.label}</h3>
                            <span class="text-xs font-bold text-slate-400">柱狀圖 / 絕對數字 + 年增比例</span>
                        </div>
                        <div class="h-[300px]"><canvas id="area-annual-chart"></canvas></div>
                    </div>
                </div>

                <div class="px-6 pb-6">
                    <h3 class="mb-3 text-sm font-black text-slate-600 dark:text-slate-300">${series.metric.shortLabel}年度明細</h3>
                    <div class="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
                        <table class="w-full text-sm">
                            <thead class="bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-300">
                                <tr>
                                    <th class="px-4 py-2 text-left">年份</th>
                                    <th class="px-4 py-2 text-right">年度新增量</th>
                                    <th class="px-4 py-2 text-right">年增比例</th>
                                    <th class="px-4 py-2 text-right">累計總面積</th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
                                ${trend.additions.map((row, idx) => {
                                    const annual = formatArea(series.annualValues[idx] || 0, state.unit);
                                    const cumulative = formatArea(series.cumulativeValues[idx] || 0, state.unit);
                                    return `
                                        <tr class="bg-white dark:bg-slate-900">
                                            <td class="px-4 py-2 font-bold text-slate-700 dark:text-slate-200">${formatYearLabel(row.year)}</td>
                                            <td class="px-4 py-2 text-right font-mono text-slate-700 dark:text-slate-200">${annual.val} ${annual.unit}</td>
                                            <td class="px-4 py-2 text-right font-mono text-slate-500 dark:text-slate-300">${formatGrowthRate(series.annualRates[idx])}</td>
                                            <td class="px-4 py-2 text-right font-mono text-slate-700 dark:text-slate-200">${cumulative.val} ${cumulative.unit}</td>
                                        </tr>`;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            </section>
        </div>`;
};

const destroyTrendCharts = () => {
    Object.values(trendCharts).forEach(chart => {
        if (chart) chart.destroy();
    });
    trendCharts = { cumulative: null, annual: null };
};

const drawTrendChart = () => {
    if (!state.isTrendOpen) return;
    const cumulativeCanvas = document.getElementById('area-cumulative-chart');
    const annualCanvas = document.getElementById('area-annual-chart');
    if (!cumulativeCanvas || !annualCanvas || typeof Chart === 'undefined') return;

    destroyTrendCharts();

    const trend = buildAreaTrendData();
    const series = getTrendSeries(trend);
    const toUnitValue = (value) => state.unit === 'ping' ? value * 0.3025 : value;
    const unitLabel = state.unit === 'ping' ? '坪' : 'm²';
    const textColor = state.isDarkMode ? '#CBD5E1' : '#334155';
    const mutedColor = state.isDarkMode ? '#94A3B8' : '#64748B';
    const gridColor = state.isDarkMode ? 'rgba(148,163,184,0.18)' : 'rgba(148,163,184,0.28)';

    const annualDisplayValues = series.annualValues.map(toUnitValue);
    const cumulativeDisplayValues = series.cumulativeValues.map(toUnitValue);

    const barValueLabelPlugin = {
        id: 'barValueLabelPlugin',
        afterDatasetsDraw(chart) {
            const { ctx } = chart;
            ctx.save();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.font = 'bold 11px sans-serif';
            ctx.fillStyle = mutedColor;

            chart.getDatasetMeta(0).data.forEach((bar, index) => {
                const value = annualDisplayValues[index] || 0;
                if (value <= 0) return;
                const rate = formatGrowthRate(series.annualRates[index]);
                const label = `${Math.round(value).toLocaleString()} ${unitLabel}${rate !== '-' ? ` / ${rate}` : ''}`;
                ctx.fillText(label, bar.x, bar.y - 6);
            });
            ctx.restore();
        }
    };

    trendCharts.cumulative = new Chart(cumulativeCanvas, {
        type: 'line',
        data: {
            labels: trend.labels,
            datasets: [{
                label: `累計${series.metric.label} (${unitLabel})`,
                data: cumulativeDisplayValues,
                borderColor: series.metric.color,
                backgroundColor: series.metric.bgColor,
                tension: 0.35,
                fill: true,
                pointRadius: 4,
                pointHoverRadius: 6
            }]
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

    trendCharts.annual = new Chart(annualCanvas, {
        type: 'bar',
        data: {
            labels: trend.labels,
            datasets: [{
                label: `年增${series.metric.label} (${unitLabel})`,
                data: annualDisplayValues,
                borderColor: series.metric.color,
                backgroundColor: series.metric.bgColor,
                borderWidth: 2,
                borderRadius: 8,
                maxBarThickness: 64
            }]
        },
        plugins: [barValueLabelPlugin],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { top: 24 } },
            plugins: {
                legend: { labels: { color: textColor, font: { weight: 'bold' } } },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const value = Math.round(ctx.parsed.y).toLocaleString();
                            const rate = formatGrowthRate(series.annualRates[ctx.dataIndex]);
                            return `年增量: ${value} ${unitLabel}｜年增比例: ${rate}`;
                        }
                    }
                }
            },
            scales: {
                x: { ticks: { color: textColor, font: { weight: 'bold' } }, grid: { display: false } },
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
    const res = await fetch(apiUrl('/api/data'), { cache: 'no-store' });
    if (!res.ok) throw new Error('API Error');
    const rawData = await res.json();
    const result = processRawData(rawData);
    appData.source = rawData;
    appData.processed = result.processedData;
    appData.meta = result.buildingMeta;
    appData.sortedFloors = result.sortedFloorLabels;
};

const render = () => {
    const saved3DScroll = document.querySelector('.building-3d-layout')?.scrollTop || 0;
    const scrollContainer = document.getElementById('matrix-scroll-container');
    const savedScrollLeft = scrollContainer ? scrollContainer.scrollLeft : 0;
    const savedScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
    const app = document.getElementById('app');

    const dataForTotal = state.includeUnfinished
        ? appData.processed
        : appData.processed.filter(d => d.status !== '未成廠' || isHiddenMatrixFloor(d.floor));

    // 其他模組 (基地面積共用設定等) 需要知道目前的單位與未成廠開關。
    // 以前是去 header 反推，會誤判 (標題列本來就有「坪」按鈕)，改成直接公開狀態。
    window.APP_STATE = {
        unit: state.unit,
        includeUnfinished: state.includeUnfinished
    };

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
            ${state.isCompareTableOpen
                // 比較表要看到完整規劃，未成廠也要列入，不受標題列「包含未成廠」開關影響。
                ? renderCompareTable(state, activeBuildings, appData.processed, appData.meta, appData.sortedFloors)
                : renderMatrix(state, activeBuildings, activeFloors, matrixData, dataMap, appData.meta)}
        </main>
        ${renderPanel(state, appData.meta, appData.processed)}
        ${renderTrendModal()}
        ${renderBuilding3DModal(state, appData.meta, appData.processed)}
    `;

    lucide.createIcons();
    setTimeout(drawTrendChart, 0);
    setTimeout(() => {
        bindBuilding3DInteractions(state);
        const layout = document.querySelector('.building-3d-layout');
        if (layout) layout.scrollTop = saved3DScroll;
    }, 0);

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
    setTrendMetric: (metric) => {
        if (!trendMetricOptions[metric]) return;
        state.trendMetric = metric;
        render();
    },
    toggleFilterPanel: () => {
        state.isFilterCollapsed = !state.isFilterCollapsed;
        render();
    },
    toggleCompareTable: () => {
        state.isCompareTableOpen = !state.isCompareTableOpen;
        render();
    },
    toggleCompareExpand: (bldg) => {
        state.compareExpanded = state.compareExpanded.includes(bldg)
            ? state.compareExpanded.filter(b => b !== bldg)
            : [...state.compareExpanded, bldg];
        render();
    },
    openTrendModal: () => {
        state.isTrendOpen = true;
        render();
    },
    closeTrendModal: () => {
        state.isTrendOpen = false;
        destroyTrendCharts();
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
    openBuilding3D: (buildingName) => {
        const floors = appData.processed
            .filter(item => item.building === buildingName && String(item.floor || '').trim().toUpperCase() !== 'ALL')
            .sort((a, b) => a.floorWeight - b.floorWeight);
        state.isBuilding3DOpen = true;
        state.building3DName = buildingName;
        state.selected3DFloorId = floors[floors.length - 1]?.id || null;
        state.building3DRotation = -38;
        state.building3DTilt = 58;
        state.building3DZoom = 1;
        state.isBuilding3DExpanded = true;
        render();
    },
    closeBuilding3D: () => {
        state.isBuilding3DOpen = false;
        state.building3DName = null;
        state.selected3DFloorId = null;
        render();
    },
    select3DFloor: (floorId) => {
        state.selected3DFloorId = floorId;
        state.building3DShowDetails = true;
        render();
    },
    setBuilding3DMetric: (metric) => {
        if (!['height', 'floorLoad', 'usage', 'area'].includes(metric)) return;
        state.building3DMetric = metric;
        render();
    },
    setBuilding3DSpacing: (spacing) => {
        if (!['compact', 'standard', 'wide'].includes(spacing)) return;
        state.building3DSpacing = spacing;
        state.isBuilding3DExpanded = true;
        render();
    },
    rotateBuilding3D: (degrees) => {
        state.building3DRotation = Number(state.building3DRotation || 0) + Number(degrees || 0);
        render();
    },
    resetBuilding3DView: () => {
        state.building3DRotation = -38;
        state.building3DTilt = 58;
        state.building3DZoom = 1;
        render();
    },
    setBuilding3DView: (view) => {
        if (!['overview', 'exploded', 'front'].includes(view)) return;
        state.isBuilding3DExpanded = view !== 'overview';
        state.building3DRotation = view === 'front' ? 0 : -38;
        state.building3DTilt = view === 'front' ? 90 : 58;
        state.building3DZoom = 1;
        render();
    },
    toggleBuilding3DExpanded: () => {
        state.isBuilding3DExpanded = !state.isBuilding3DExpanded;
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
            const res = await fetch(apiUrl('/api/admin/upload-data'), { method: 'POST', body: formData });
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

document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.isBuilding3DOpen) {
        window.app.closeBuilding3D();
    }
});

const init = async () => {
    try {
        const meRes = await fetch(apiUrl('/api/me'), { cache: 'no-store' });
        if (meRes.ok) {
            state.currentUser = await meRes.json();
        } else if (meRes.status === 403) {
            // 後端已無身分 (例如 session 過期、或使用者按掉 Windows 驗證視窗)：
            // 導去登入頁，不要停在載入中的畫面。
            const body = await meRes.json().catch(() => ({}));
            if (body.error === 'unauthenticated') {
                window.location.replace(body.login_url || apiUrl('/login'));
                return;
            }
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
