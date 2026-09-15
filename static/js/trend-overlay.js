import { processRawData } from './data.js';
import { formatArea, apiUrl } from './utils.js';

const OVERLAY_VERSION = 'axis-buildings-dynamic-area-unit-v6';
const BASELINE_YEAR = 25;
const BASELINE_LABEL = 'Y25';

const METRICS = {
  clean: { key: 'clean', type: 'area', label: '無塵室面積', annualLabel: '年增無塵室面積', cumulativeLabel: '累積無塵室面積', color: '#0EA5E9', bg: 'rgba(14,165,233,.18)', card: 'bg-sky-50 dark:bg-sky-950/30 border-sky-100 dark:border-sky-900/50 text-sky-600 dark:text-sky-300' },
  production_area: { key: 'production_area', type: 'area', label: '生產面積', annualLabel: '年增生產面積', cumulativeLabel: '累積生產面積', color: '#10B981', bg: 'rgba(16,185,129,.18)', card: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-100 dark:border-emerald-900/50 text-emerald-600 dark:text-emerald-300' },
  power_demand: { key: 'power_demand', type: 'utility', label: '電力需求', annualLabel: '年增電力需求', cumulativeLabel: '累積電力需求', unit: 'kW', color: '#F59E0B', bg: 'rgba(245,158,11,.18)', card: 'bg-amber-50 dark:bg-amber-950/30 border-amber-100 dark:border-amber-900/50 text-amber-600 dark:text-amber-300' },
  water_demand: { key: 'water_demand', type: 'utility', label: '用水需求', annualLabel: '年增用水需求', cumulativeLabel: '累積用水需求', unit: 'CMD', color: '#6366F1', bg: 'rgba(99,102,241,.18)', card: 'bg-indigo-50 dark:bg-indigo-950/30 border-indigo-100 dark:border-indigo-900/50 text-indigo-600 dark:text-indigo-300' }
};

let selected = ['clean', 'production_area', 'power_demand', 'water_demand'];
let charts = {};
let trendCache = null;

const normalizeYearCode = (year) => {
  const num = Number(year);
  if (!Number.isFinite(num)) return null;
  if (num >= 2000 && num <= 2099) return num - 2000;
  return num;
};
const parseYear = (value) => {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return null;
  const match = text.match(/Y\s*(\d{1,4})/i) || text.match(/(\d{4})/);
  const year = match ? normalizeYearCode(match[1]) : null;
  return Number.isFinite(year) ? year : null;
};
const formatYearLabel = (year) => year === BASELINE_YEAR || year === 'current' ? BASELINE_LABEL : `Y${year}`;
const formatRate = (rate) => rate === null || rate === undefined || !Number.isFinite(rate) ? '-' : `${(rate * 100).toFixed(1)}%`;
const toPing = (value) => value * 0.3025;
const getAreaUnit = () => window.APP_STATE?.unit === 'm2' ? 'm2' : 'ping';
const fmt = (value, metric) => metric.type === 'area' ? formatArea(value, getAreaUnit()) : { val: Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }), unit: metric.unit || '' };
const rawValue = (value, metric) => metric.type === 'area' && getAreaUnit() === 'ping' ? toPing(value) : Number(value || 0);
const chartValue = rawValue;
const formatChartNumber = (value, metric) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: metric.type === 'area' ? 0 : 2 });
const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');
const pad2 = (num) => String(num).padStart(2, '0');
const timestampForFilename = () => {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
};

async function fetchJson(url, fallback) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return fallback;
    return await res.json();
  } catch (_) {
    return fallback;
  }
}
function makeSeries(rows) { return { labels: rows.map(row => row.label), annual: rows.map(row => row.annual), rates: rows.map(row => row.rate), cumulative: rows.map(row => row.cumulative), rows }; }

function buildAreaTrend(rawData) {
  const { processedData } = processRawData(rawData || []);
  const base = { clean: 0, production_area: 0 };
  const yearlyAdditions = new Map();

  processedData.forEach((item) => {
    const year = parseYear(item.expectedCompletionYear);
    const clean = Number(item.cleanRoomArea || 0);
    const prodAround = Number(item.prodArea || 0);
    const productionArea = clean + prodAround;

    // 沒有預計年份或年份小於等於 Y25 的資料，作為 Y25 基準量。
    if (year === null || year <= BASELINE_YEAR) {
      base.clean += clean;
      base.production_area += productionArea;
      return;
    }

    const current = yearlyAdditions.get(year) || {
      clean: 0,
      production_area: 0,
      buildings: new Map()
    };
    current.clean += clean;
    current.production_area += productionArea;

    const building = current.buildings.get(item.building) || { clean: 0, production_area: 0 };
    building.clean += clean;
    building.production_area += productionArea;
    current.buildings.set(item.building, building);
    yearlyAdditions.set(year, current);
  });

  const years = Array.from(yearlyAdditions.keys()).sort((a, b) => a - b);
  const result = {};
  ['clean', 'production_area'].forEach((key) => {
    let running = base[key] || 0;
    const rows = [{
      year: BASELINE_YEAR,
      label: BASELINE_LABEL,
      annual: 0,
      rate: null,
      cumulative: running,
      buildings: [],
      buildingDetails: []
    }];

    years.forEach((year) => {
      const addition = yearlyAdditions.get(year);
      const add = addition?.[key] || 0;
      const rate = running > 0 ? add / running : null;
      const buildingDetails = Array.from(addition?.buildings?.entries?.() || [])
        .map(([name, areas]) => ({ name, area: Number(areas[key] || 0) }))
        .filter((item) => item.area > 0)
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
      running += add;
      rows.push({
        year,
        label: formatYearLabel(year),
        annual: add,
        rate,
        cumulative: running,
        buildings: buildingDetails.map((item) => item.name),
        buildingDetails
      });
    });
    result[key] = makeSeries(rows);
  });
  return result;
}

function buildUtilityTrend(utilityData) {
  const result = {};
  (utilityData?.metrics || []).forEach((metric) => {
    const key = metric.metric_key;
    if (!METRICS[key]) return;
    METRICS[key].label = metric.metric_name || METRICS[key].label;
    METRICS[key].annualLabel = metric.annual_label || METRICS[key].annualLabel;
    METRICS[key].cumulativeLabel = metric.cumulative_label || METRICS[key].cumulativeLabel;
    METRICS[key].unit = metric.unit || METRICS[key].unit;
    const sorted = [...(metric.series || [])].sort((a, b) => {
      const yearA = parseYear(a.year_key);
      const yearB = parseYear(b.year_key);
      if (a.is_baseline || a.year_key === 'current' || yearA === null || yearA <= BASELINE_YEAR) return -1;
      if (b.is_baseline || b.year_key === 'current' || yearB === null || yearB <= BASELINE_YEAR) return 1;
      return (yearA ?? 9999) - (yearB ?? 9999);
    });
    let running = 0;
    const rows = [];
    sorted.forEach((point) => {
      const pointYear = parseYear(point.year_key);
      const isBase = point.is_baseline || point.year_key === 'current' || pointYear === null || pointYear <= BASELINE_YEAR;
      const value = Number(point.value || 0);
      if (isBase) {
        running += value;
        if (!rows.length) rows.push({ year: BASELINE_YEAR, label: BASELINE_LABEL, annual: 0, rate: null, cumulative: running });
        else rows[0].cumulative = running;
        return;
      }
      const rate = running > 0 ? value / running : null;
      running += value;
      rows.push({ year: pointYear, label: point.year_label && point.year_label !== '現況' ? point.year_label : formatYearLabel(pointYear), annual: value, rate, cumulative: running });
    });
    result[key] = makeSeries(rows.length ? rows : [{ year: BASELINE_YEAR, label: BASELINE_LABEL, annual: 0, rate: null, cumulative: 0 }]);
  });
  return result;
}

async function buildTrendData() {
  if (trendCache) return trendCache;
  const [rawData, utilityData] = await Promise.all([fetchJson(apiUrl('/api/data'), []), fetchJson(apiUrl('/api/utility-trends'), { metrics: [] })]);
  trendCache = { metrics: { ...buildAreaTrend(rawData), ...buildUtilityTrend(utilityData) } };
  return trendCache;
}
function destroyCharts() { Object.values(charts).forEach((chart) => chart?.destroy?.()); charts = {}; }
function closeTrendOverlay() { destroyCharts(); document.getElementById('trend-overlay-v2')?.remove(); }
function renderMetricButton(metric) { const active = selected.includes(metric.key); return `<button data-trend-metric="${metric.key}" class="px-3 py-2 rounded-xl text-sm font-black transition-all ${active ? 'bg-blue-600 text-white shadow-sm' : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'}">${active ? '✓ ' : ''}${metric.label}</button>`; }
function renderAreaUnitButton(unit, label) {
  const active = getAreaUnit() === unit;
  return `<button data-trend-unit="${unit}" class="px-3 py-2 text-sm font-black transition-colors ${active ? 'bg-slate-800 dark:bg-slate-100 text-white dark:text-slate-900' : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700'}">${label}</button>`;
}
function renderBuildingAxisDetails(data, metric) {
  if (metric.type !== 'area') return '';
  const columnCount = Math.max(data.rows.length, 1);
  return `<div class="mt-1 border-t border-slate-100 dark:border-slate-800 pl-[58px] pr-5 pt-2">
    <div class="grid items-start gap-1" style="grid-template-columns: repeat(${columnCount}, minmax(0, 1fr));">
      ${data.rows.map((row, index) => {
        if (index === 0) {
          return '<div class="px-1 text-center text-[10px] font-bold text-slate-400">現況基準</div>';
        }
        const count = row.buildings?.length || 0;
        return `<details class="group min-w-0 text-center">
          <summary class="mx-auto inline-flex max-w-full cursor-pointer list-none items-center justify-center gap-1 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-1.5 py-1 text-[10px] font-black text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-600">
            <span class="truncate">${count ? `新增 ${count} 棟` : '無新增'}</span>
            ${count ? '<i data-lucide="chevron-down" class="h-3 w-3 shrink-0 transition-transform group-open:rotate-180"></i>' : ''}
          </summary>
          ${count ? `<div class="mt-1 rounded border border-blue-100 dark:border-blue-900/60 bg-blue-50 dark:bg-blue-950/30 px-1 py-1.5 text-[10px] font-bold leading-4 text-blue-700 dark:text-blue-300">${row.buildings.map(escapeHtml).join('<br>')}</div>` : ''}
        </details>`;
      }).join('')}
    </div>
    <p class="mt-2 text-center text-[10px] font-bold text-slate-400">新增廠棟位於對應年份正下方，點擊可展開；預設收合。</p>
  </div>`;
}

function renderChartSection(metric, trend) {
  const data = trend.metrics[metric.key];
  if (!data) return '';
  const latest = fmt(data.cumulative.at(-1) || 0, metric);
  const latestAnnual = fmt(data.annual.at(-1) || 0, metric);
  const isArea = metric.type === 'area';
  const latestBuildings = data.rows.at(-1)?.buildings || [];

  return `<section class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 px-4 py-3">
    <div class="flex flex-col xl:flex-row xl:items-start justify-between gap-2 mb-2">
      <div>
        <div class="flex items-center gap-2">
          <span class="inline-flex h-7 w-7 items-center justify-center rounded-lg border ${metric.card}"><i data-lucide="${isArea ? 'area-chart' : 'bar-chart-3'}" class="w-4 h-4"></i></span>
          <h3 class="text-base font-black text-slate-700 dark:text-slate-100">${metric.label}</h3>
        </div>
        <p class="mt-1 text-xs font-bold text-slate-400">${isArea
          ? '以 Y25 為現況基準；灰色為前期累積，彩色區段為當年新增，柱頂為年度累積面積。'
          : 'Y25 作為累積基準；圖中同時顯示年度新增量與累積需求。'}</p>
      </div>
      <div class="grid grid-cols-2 gap-2 min-w-[300px]">
        <div class="rounded-lg border p-2 ${metric.card}">
          <div class="text-xs font-bold">${metric.cumulativeLabel}</div>
          <div class="mt-0.5 text-lg font-black text-slate-800 dark:text-white">${latest.val}<span class="ml-1 text-xs text-slate-400">${latest.unit}</span></div>
        </div>
        <div class="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 p-2">
          <div class="text-xs font-bold text-slate-500 dark:text-slate-300">最後年度新增</div>
          <div class="mt-0.5 text-lg font-black text-slate-800 dark:text-white">${latestAnnual.val}<span class="ml-1 text-xs text-slate-400">${latestAnnual.unit}</span></div>
          <div class="text-[11px] font-bold text-slate-400">新增比例：${formatRate(data.rates.at(-1))}</div>
          ${isArea && latestBuildings.length ? `<div class="truncate text-[11px] font-bold text-slate-400">廠棟：${escapeHtml(latestBuildings.join('、'))}</div>` : ''}
        </div>
      </div>
    </div>
    <div class="h-[360px]"><canvas id="trend-chart-${metric.key}"></canvas></div>
    ${renderBuildingAxisDetails(data, metric)}
  </section>`;
}

function renderBuildingTable(trend) {
  const metric = METRICS.production_area;
  const data = trend.metrics.production_area;
  if (!data) return '';
  const rows = data.rows.filter((row) => row.year > BASELINE_YEAR);
  const totalBuildings = new Set(rows.flatMap((row) => row.buildings || [])).size;

  return `<details id="trend-building-details" class="group rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950">
    <summary class="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 select-none">
      <div class="flex items-center gap-3">
        <span class="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-300"><i data-lucide="building-2" class="w-4 h-4"></i></span>
        <div>
          <h3 class="text-sm font-black text-slate-700 dark:text-slate-100">年度新增廠棟與面積</h3>
          <p class="text-xs font-bold text-slate-400">${rows.length} 個年度・${totalBuildings} 棟廠棟，點擊展開明細</p>
        </div>
      </div>
      <i data-lucide="chevron-down" class="w-5 h-5 text-slate-400 transition-transform group-open:rotate-180"></i>
    </summary>
    <div class="border-t border-slate-200 dark:border-slate-800 p-4">
      <div class="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
        <table class="w-full min-w-[760px] text-sm">
          <thead class="bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-300">
            <tr>
              <th class="px-4 py-2.5 text-left">年份</th>
              <th class="px-4 py-2.5 text-left">新增廠棟</th>
              <th class="px-4 py-2.5 text-right">各棟新增面積</th>
              <th class="px-4 py-2.5 text-right">年度新增面積</th>
              <th class="px-4 py-2.5 text-right">累積面積</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
            ${rows.length ? rows.map((row) => {
              const annual = fmt(row.annual, metric);
              const cumulative = fmt(row.cumulative, metric);
              return `<tr class="bg-white dark:bg-slate-900 align-top">
                <td class="px-4 py-3 font-black text-slate-700 dark:text-slate-200">${row.label}</td>
                <td class="px-4 py-3 font-bold text-slate-700 dark:text-slate-200">${row.buildings?.length ? row.buildings.map(escapeHtml).join('、') : '—'}</td>
                <td class="px-4 py-3 text-right text-xs leading-5 text-slate-500 dark:text-slate-300">
                  ${row.buildingDetails?.length ? row.buildingDetails.map((item) => {
                    const area = fmt(item.area, metric);
                    return `<div><span class="font-bold">${escapeHtml(item.name)}</span>：${area.val} ${area.unit}</div>`;
                  }).join('') : '—'}
                </td>
                <td class="px-4 py-3 text-right font-mono font-bold text-slate-700 dark:text-slate-200">${annual.val} ${annual.unit}</td>
                <td class="px-4 py-3 text-right font-mono font-black text-blue-700 dark:text-blue-300">${cumulative.val} ${cumulative.unit}</td>
              </tr>`;
            }).join('') : '<tr><td colspan="5" class="px-4 py-8 text-center font-bold text-slate-400">目前沒有新增廠棟資料</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  </details>`;
}

function renderTables(trend) {
  const utilityKeys = selected.filter((key) => METRICS[key]?.type === 'utility');
  if (!utilityKeys.length) return '';

  return `<details class="group rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950">
    <summary class="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 select-none">
      <div class="flex items-center gap-3">
        <span class="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-500"><i data-lucide="table-2" class="w-4 h-4"></i></span>
        <div><h3 class="text-sm font-black text-slate-700 dark:text-slate-100">電力與用水年度明細</h3><p class="text-xs font-bold text-slate-400">點擊展開數值表</p></div>
      </div>
      <i data-lucide="chevron-down" class="w-5 h-5 text-slate-400 transition-transform group-open:rotate-180"></i>
    </summary>
    <div class="space-y-5 border-t border-slate-200 dark:border-slate-800 p-4">
      ${utilityKeys.map((key) => {
        const metric = METRICS[key];
        const data = trend.metrics[key];
        if (!data) return '';
        return `<div>
          <h4 class="mb-2 text-sm font-black ${metric.card} inline-flex rounded-lg border px-3 py-1">${metric.label}</h4>
          <div class="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
            <table class="w-full text-sm">
              <thead class="bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-300"><tr><th class="px-4 py-2 text-left">年份</th><th class="px-4 py-2 text-right">年度新增</th><th class="px-4 py-2 text-right">年增比例</th><th class="px-4 py-2 text-right">累積總量</th></tr></thead>
              <tbody class="divide-y divide-slate-100 dark:divide-slate-800">${data.rows.map((row) => {
                const annual = fmt(row.annual, metric);
                const cumulative = fmt(row.cumulative, metric);
                return `<tr class="bg-white dark:bg-slate-900"><td class="px-4 py-2 font-bold text-slate-700 dark:text-slate-200">${row.label}</td><td class="px-4 py-2 text-right font-mono text-slate-700 dark:text-slate-200">${annual.val} ${annual.unit}</td><td class="px-4 py-2 text-right font-mono text-slate-500 dark:text-slate-300">${formatRate(row.rate)}</td><td class="px-4 py-2 text-right font-mono text-slate-700 dark:text-slate-200">${cumulative.val} ${cumulative.unit}</td></tr>`;
              }).join('')}</tbody>
            </table>
          </div>
        </div>`;
      }).join('')}
    </div>
  </details>`;
}

function exportSelectedTrends(trend) {
  const rows = [];
  selected.forEach((key) => {
    const metric = METRICS[key];
    const data = trend.metrics[key];
    if (!data) return;
    data.rows.forEach((row) => rows.push({
      指標: metric.label,
      年份: row.label,
      單位: metric.type === 'area' ? (getAreaUnit() === 'ping' ? '坪' : 'm²') : metric.unit,
      年度新增: rawValue(row.annual, metric),
      年增比例: row.rate == null ? '' : `${(row.rate * 100).toFixed(1)}%`,
      累積總量: rawValue(row.cumulative, metric),
      新增廠棟: row.buildings?.join('、') || ''
    }));
  });
  if (!rows.length) { alert('請至少選取一個要匯出的指標。'); return; }
  if (!window.XLSX) { alert('Excel 匯出元件尚未載入，請重新整理頁面後再試。'); return; }

  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet['!cols'] = [
    { wch: 18 }, { wch: 12 }, { wch: 10 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 36 }
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '成長趨勢');
  XLSX.writeFile(workbook, `${timestampForFilename()}_(Security C).xlsx`);
}
async function openTrendOverlay() {
  const trend = await buildTrendData(); destroyCharts(); document.getElementById('trend-overlay-v2')?.remove();
  const productionArea = fmt(trend.metrics.production_area?.cumulative.at(-1) || 0, METRICS.production_area);
  const overlay = document.createElement('div'); overlay.id = 'trend-overlay-v2'; overlay.className = 'fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4';
  overlay.innerHTML = `<section class="w-full max-w-7xl max-h-[92vh] overflow-auto rounded-2xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-700" onclick="event.stopPropagation()"><div class="sticky top-0 z-10 flex flex-col xl:flex-row xl:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur px-6 py-4"><div><div class="flex items-center gap-2"><span class="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm"><i data-lucide="line-chart" class="w-5 h-5"></i></span><h2 class="text-xl font-black text-slate-800 dark:text-slate-100">成長趨勢</h2></div><p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Y25 為現況基準；生產面積 = 無塵室面積 + 生產週邊面積；可匯出目前勾選的趨勢資料。</p></div><div class="flex flex-wrap items-center gap-2">${Object.values(METRICS).map(renderMetricButton).join('')}<div class="inline-flex overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">${renderAreaUnitButton('ping', '坪')}${renderAreaUnitButton('m2', 'm²')}</div><button id="trend-export-v2" class="px-3 py-2 rounded-xl text-sm font-black bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm"><i data-lucide="download" class="inline-block w-4 h-4 mr-1"></i>匯出XLSX</button><button id="trend-close-v2" class="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"><i data-lucide="x" class="w-6 h-6"></i></button></div></div><div class="px-6 pt-4"><div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-4 py-3 inline-block"><div class="text-sm font-bold text-slate-500 dark:text-slate-300">生產面積合計</div><div class="mt-1 text-2xl font-black text-slate-800 dark:text-white">${productionArea.val}<span class="ml-1 text-sm text-slate-400">${productionArea.unit}</span></div><div class="mt-1 text-xs font-bold text-slate-400">無塵室面積 + 生產週邊面積</div></div></div><div class="px-6 py-4 space-y-3">${selected.length ? selected.map((key) => renderChartSection(METRICS[key], trend)).join('') : '<div class="rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 p-10 text-center text-slate-400 font-bold">請至少選取一個指標</div>'}${renderBuildingTable(trend)}${renderTables(trend)}</div></section>`;
  overlay.addEventListener('click', closeTrendOverlay); document.body.appendChild(overlay);
  document.getElementById('trend-close-v2')?.addEventListener('click', closeTrendOverlay);
  document.getElementById('trend-export-v2')?.addEventListener('click', (event) => { event.stopPropagation(); exportSelectedTrends(trend); });
  document.querySelectorAll('[data-trend-metric]').forEach((button) => button.addEventListener('click', async (event) => { event.stopPropagation(); const key = button.getAttribute('data-trend-metric'); selected = selected.includes(key) ? selected.filter((item) => item !== key) : [...selected, key]; await openTrendOverlay(); }));
  document.querySelectorAll('[data-trend-unit]').forEach((button) => button.addEventListener('click', async (event) => {
    event.stopPropagation();
    const unit = button.getAttribute('data-trend-unit');
    if (!['ping', 'm2'].includes(unit) || unit === getAreaUnit()) return;
    window.app?.updateState?.('unit', unit);
    await openTrendOverlay();
  }));
  lucide?.createIcons?.(); drawCharts(trend);
}
function drawRoundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
function drawCharts(trend) {
  if (typeof Chart === 'undefined') return;
  const isDark = document.documentElement.classList.contains('dark');
  const textColor = isDark ? '#CBD5E1' : '#334155';
  const mutedColor = isDark ? '#94A3B8' : '#64748B';
  const labelBg = isDark ? 'rgba(15,23,42,.94)' : 'rgba(255,255,255,.96)';
  const labelStroke = isDark ? 'rgba(148,163,184,.35)' : 'rgba(148,163,184,.35)';
  const gridColor = isDark ? 'rgba(148,163,184,.18)' : 'rgba(148,163,184,.28)';

  selected.forEach((key) => {
    const metric = METRICS[key];
    const data = trend.metrics[key];
    const canvas = document.getElementById(`trend-chart-${key}`);
    if (!data || !canvas) return;

    const isArea = metric.type === 'area';
    const annual = data.annual.map((value) => chartValue(value, metric));
    const cumulative = data.cumulative.map((value) => chartValue(value, metric));
    const previousCumulative = cumulative.map((value, index) => Math.max(0, value - (annual[index] || 0)));
    const unit = isArea ? (getAreaUnit() === 'ping' ? '坪' : 'm²') : metric.unit;
    const maxAnnual = Math.max(...annual, 0);
    const maxCumulative = Math.max(...cumulative, 0);

    const valueLabelPlugin = {
      id: `trendLabels-${key}`,
      afterDatasetsDraw(chart) {
        const { ctx, chartArea } = chart;
        const totalElements = chart.getDatasetMeta(isArea ? 1 : 1).data;
        ctx.save();
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        totalElements.forEach((element, index) => {
          const value = cumulative[index] || 0;
          if (value <= 0) return;
          const label = `${formatChartNumber(value, metric)} ${unit}`;
          const paddingX = 7;
          const width = ctx.measureText(label).width + paddingX * 2;
          const height = 22;
          const left = Math.min(Math.max(element.x - width / 2, chartArea.left + 2), chartArea.right - width - 2);
          const top = Math.max(chartArea.top + 2, element.y - 30);

          ctx.fillStyle = labelBg;
          ctx.strokeStyle = metric.color;
          ctx.lineWidth = 1;
          drawRoundedRect(ctx, left, top, width, height, 6);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = textColor;
          ctx.fillText(label, left + width / 2, top + height / 2);
        });

        if (isArea) {
          const additionElements = chart.getDatasetMeta(1).data;
          additionElements.forEach((element, index) => {
            const addition = annual[index] || 0;
            if (addition <= 0) return;

            const lines = [
              `+${formatChartNumber(addition, metric)} ${unit}`,
              `+${formatRate(data.rates[index])}`
            ];
            ctx.font = 'bold 10px sans-serif';
            const width = Math.max(...lines.map((line) => ctx.measureText(line).width)) + 14;
            const height = 34;
            const segmentTop = element.y;
            const segmentBottom = element.base;
            const segmentHeight = Math.abs(segmentBottom - segmentTop);
            let left = element.x - width / 2;
            let top = segmentTop + (segmentHeight - height) / 2;

            if (segmentHeight < height + 6) {
              left = element.x + element.width / 2 + 6;
              top = segmentTop - 2;
            }
            left = Math.min(Math.max(left, chartArea.left + 2), chartArea.right - width - 2);
            top = Math.min(Math.max(top, chartArea.top + 2), chartArea.bottom - height - 2);

            ctx.fillStyle = metric.color;
            ctx.strokeStyle = isDark ? '#E2E8F0' : '#FFFFFF';
            ctx.lineWidth = 1;
            drawRoundedRect(ctx, left, top, width, height, 6);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#FFFFFF';
            lines.forEach((line, lineIndex) => {
              ctx.fillText(line, left + width / 2, top + 10 + lineIndex * 14);
            });
          });
        }
        ctx.restore();
      }
    };

    const datasets = isArea
      ? [
          {
            type: 'bar',
            label: `前期累積 (${unit})`,
            data: previousCumulative,
            borderColor: isDark ? '#64748B' : '#94A3B8',
            backgroundColor: isDark ? 'rgba(100,116,139,.42)' : 'rgba(148,163,184,.32)',
            borderWidth: 1,
            borderRadius: { bottomLeft: 6, bottomRight: 6 },
            maxBarThickness: 72,
            stack: 'cumulative',
            yAxisID: 'cumulativeAxis'
          },
          {
            type: 'bar',
            label: `當年新增 (${unit})`,
            data: annual,
            borderColor: metric.color,
            backgroundColor: metric.color,
            borderWidth: 2,
            borderRadius: { topLeft: 6, topRight: 6 },
            maxBarThickness: 72,
            stack: 'cumulative',
            yAxisID: 'cumulativeAxis'
          }
        ]
      : [
          { type: 'bar', label: `${metric.annualLabel} (${unit})`, data: annual, borderColor: metric.color, backgroundColor: metric.bg, borderWidth: 2, borderRadius: 6, maxBarThickness: 46, yAxisID: 'annualAxis', order: 2 },
          { type: 'line', label: `${metric.cumulativeLabel} (${unit})`, data: cumulative, borderColor: metric.color, backgroundColor: metric.bg, tension: .35, fill: false, pointRadius: 4, pointHoverRadius: 6, yAxisID: 'cumulativeAxis', order: 1 }
        ];

    charts[key] = new Chart(canvas, {
      data: { labels: data.labels, datasets },
      plugins: [valueLabelPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 40, right: 20, bottom: 8, left: 8 } },
        plugins: {
          legend: { labels: { color: textColor, font: { weight: 'bold' }, padding: 18 } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                if (isArea) {
                  return ctx.datasetIndex === 1
                    ? `${ctx.dataset.label}: ${formatChartNumber(ctx.parsed.y, metric)} ${unit}（${formatRate(data.rates[ctx.dataIndex])}）`
                    : `${ctx.dataset.label}: ${formatChartNumber(ctx.parsed.y, metric)} ${unit}`;
                }
                return ctx.dataset.type === 'bar'
                  ? `${ctx.dataset.label}: ${formatChartNumber(ctx.parsed.y, metric)} ${unit}｜年增比例: ${formatRate(data.rates[ctx.dataIndex])}`
                  : `${ctx.dataset.label}: ${formatChartNumber(ctx.parsed.y, metric)} ${unit}`;
              },
              afterLabel: (ctx) => isArea && data.rows[ctx.dataIndex]?.buildings?.length
                ? `本年新增：${data.rows[ctx.dataIndex].buildings.join('、')}`
                : '',
              footer: (items) => isArea && items.length
                ? `年度累積：${formatChartNumber(cumulative[items[0].dataIndex], metric)} ${unit}`
                : ''
            }
          }
        },
        scales: {
          x: {
            ticks: { color: textColor, font: { weight: 'bold' }, maxRotation: 0, autoSkip: false },
            grid: { display: false },
            stacked: isArea
          },
          annualAxis: {
            display: !isArea,
            beginAtZero: true,
            suggestedMax: maxAnnual > 0 ? maxAnnual * 1.5 : 10,
            position: 'left',
            ticks: { color: textColor, callback: (value) => Number(value).toLocaleString() },
            grid: { color: gridColor },
            title: { display: !isArea, text: `${metric.annualLabel} (${unit})`, color: mutedColor, font: { weight: 'bold' } }
          },
          cumulativeAxis: {
            beginAtZero: isArea,
            stacked: isArea,
            suggestedMax: maxCumulative > 0 ? maxCumulative * 1.15 : 10,
            position: isArea ? 'left' : 'right',
            ticks: { color: textColor, callback: (value) => Number(value).toLocaleString() },
            grid: { color: isArea ? gridColor : undefined, drawOnChartArea: isArea },
            title: { display: true, text: `${metric.cumulativeLabel} (${unit})`, color: mutedColor, font: { weight: 'bold' } }
          }
        }
      }
    });
  });
}

function install() {
  if (!window.app?.openTrendModal) return false;
  window.app.openTrendModal = async () => { trendCache = null; try { await openTrendOverlay(); } catch (error) { console.error('成長趨勢開啟失敗', error); alert('成長趨勢開啟失敗，請查看 console。'); } };
  window.app.closeTrendModal = closeTrendOverlay;
  window.app.__trendOverlayInstalled = OVERLAY_VERSION;
  return true;
}
const timer = setInterval(() => { if (install()) clearInterval(timer); }, 100);
window.addEventListener('beforeunload', () => clearInterval(timer));
