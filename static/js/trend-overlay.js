import { processRawData } from './data.js';
import { formatArea } from './utils.js';

const OVERLAY_VERSION = 'prod-area-export-v2';

const METRICS = {
  clean: { key: 'clean', type: 'area', label: '無塵室面積', annualLabel: '年增無塵室面積', cumulativeLabel: '累積無塵室面積', color: '#0EA5E9', bg: 'rgba(14,165,233,.18)', card: 'bg-sky-50 dark:bg-sky-950/30 border-sky-100 dark:border-sky-900/50 text-sky-600 dark:text-sky-300' },
  production_area: { key: 'production_area', type: 'area', label: '生產面積', annualLabel: '年增生產面積', cumulativeLabel: '累積生產面積', color: '#10B981', bg: 'rgba(16,185,129,.18)', card: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-100 dark:border-emerald-900/50 text-emerald-600 dark:text-emerald-300' },
  power_demand: { key: 'power_demand', type: 'utility', label: '電力需求', annualLabel: '年增電力需求', cumulativeLabel: '累積電力需求', unit: 'kW', color: '#F59E0B', bg: 'rgba(245,158,11,.18)', card: 'bg-amber-50 dark:bg-amber-950/30 border-amber-100 dark:border-amber-900/50 text-amber-600 dark:text-amber-300' },
  water_demand: { key: 'water_demand', type: 'utility', label: '用水需求', annualLabel: '年增用水需求', cumulativeLabel: '累積用水需求', unit: 'CMD', color: '#6366F1', bg: 'rgba(99,102,241,.18)', card: 'bg-indigo-50 dark:bg-indigo-950/30 border-indigo-100 dark:border-indigo-900/50 text-indigo-600 dark:text-indigo-300' }
};

let selected = ['clean', 'production_area', 'power_demand', 'water_demand'];
let charts = {};
let trendCache = null;

const parseYear = (value) => {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return null;
  const match = text.match(/Y\s*(\d{1,4})/i) || text.match(/(\d{4})/);
  const year = match ? Number(match[1]) : null;
  return Number.isFinite(year) ? year : null;
};
const formatRate = (rate) => rate === null || rate === undefined || !Number.isFinite(rate) ? '-' : `${(rate * 100).toFixed(1)}%`;
const toPing = (value) => value * 0.3025;
const fmt = (value, metric) => metric.type === 'area' ? formatArea(value, 'ping') : { val: Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }), unit: metric.unit || '' };
const rawValue = (value, metric) => metric.type === 'area' ? toPing(value) : Number(value || 0);
const chartValue = rawValue;
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
    if (item.status !== '未成廠' || year === null) {
      base.clean += clean;
      base.production_area += productionArea;
      return;
    }
    const current = yearlyAdditions.get(year) || { clean: 0, production_area: 0 };
    current.clean += clean;
    current.production_area += productionArea;
    yearlyAdditions.set(year, current);
  });
  const years = Array.from(yearlyAdditions.keys()).sort((a, b) => a - b);
  const result = {};
  ['clean', 'production_area'].forEach((key) => {
    let running = base[key] || 0;
    const rows = [{ year: 0, label: '現況', annual: 0, rate: null, cumulative: running }];
    years.forEach((year) => {
      const add = yearlyAdditions.get(year)?.[key] || 0;
      const rate = running > 0 ? add / running : null;
      running += add;
      rows.push({ year, label: `Y${year}`, annual: add, rate, cumulative: running });
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
      if (a.is_baseline || a.year_key === 'current') return -1;
      if (b.is_baseline || b.year_key === 'current') return 1;
      return (parseYear(a.year_key) ?? 9999) - (parseYear(b.year_key) ?? 9999);
    });
    let running = 0;
    const rows = sorted.map((point) => {
      const isBase = point.is_baseline || point.year_key === 'current';
      const value = Number(point.value || 0);
      if (isBase) { running += value; return { year: 'current', label: point.year_label || '現況', annual: 0, rate: null, cumulative: running }; }
      const rate = running > 0 ? value / running : null;
      running += value;
      return { year: point.year_key, label: point.year_label || point.year_key, annual: value, rate, cumulative: running };
    });
    result[key] = makeSeries(rows.length ? rows : [{ year: 'current', label: '現況', annual: 0, rate: null, cumulative: 0 }]);
  });
  return result;
}

async function buildTrendData() {
  if (trendCache) return trendCache;
  const [rawData, utilityData] = await Promise.all([fetchJson('/api/data', []), fetchJson('/api/utility-trends', { metrics: [] })]);
  trendCache = { metrics: { ...buildAreaTrend(rawData), ...buildUtilityTrend(utilityData) } };
  return trendCache;
}
function destroyCharts() { Object.values(charts).forEach((chart) => chart?.destroy?.()); charts = {}; }
function closeTrendOverlay() { destroyCharts(); document.getElementById('trend-overlay-v2')?.remove(); }
function renderMetricButton(metric) { const active = selected.includes(metric.key); return `<button data-trend-metric="${metric.key}" class="px-3 py-2 rounded-xl text-sm font-black transition-all ${active ? 'bg-blue-600 text-white shadow-sm' : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'}">${active ? '✓ ' : ''}${metric.label}</button>`; }
function renderChartSection(metric, trend) {
  const data = trend.metrics[metric.key]; if (!data) return '';
  const latest = fmt(data.cumulative.at(-1) || 0, metric); const latestAnnual = fmt(data.annual.at(-1) || 0, metric);
  return `<section class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 px-4 py-3"><div class="flex flex-col xl:flex-row xl:items-start justify-between gap-2 mb-2"><div><div class="flex items-center gap-2"><span class="inline-flex h-7 w-7 items-center justify-center rounded-lg border ${metric.card}"><i data-lucide="bar-chart-3" class="w-4 h-4"></i></span><h3 class="text-base font-black text-slate-700 dark:text-slate-100">${metric.label}</h3></div><p class="mt-1 text-xs font-bold text-slate-400">同一張圖表內呈現「累積趨勢折線」與「年增變化柱狀」，現況只作為累積基準。</p></div><div class="grid grid-cols-2 gap-2 min-w-[280px]"><div class="rounded-lg border p-2 ${metric.card}"><div class="text-xs font-bold">${metric.cumulativeLabel}</div><div class="mt-0.5 text-lg font-black text-slate-800 dark:text-white">${latest.val}<span class="ml-1 text-xs text-slate-400">${latest.unit}</span></div></div><div class="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 p-2"><div class="text-xs font-bold text-slate-500 dark:text-slate-300">最後年度新增</div><div class="mt-0.5 text-lg font-black text-slate-800 dark:text-white">${latestAnnual.val}<span class="ml-1 text-xs text-slate-400">${latestAnnual.unit}</span></div><div class="text-[11px] font-bold text-slate-400">年增率：${formatRate(data.rates.at(-1))}</div></div></div></div><div class="h-[320px]"><canvas id="trend-chart-${metric.key}"></canvas></div></section>`;
}
function renderTables(trend) {
  if (!selected.length) return '';
  return `<section class="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-4"><div class="mb-4 flex items-center gap-2"><span class="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-500"><i data-lucide="table-2" class="w-4 h-4"></i></span><h3 class="text-base font-black text-slate-700 dark:text-slate-100">年度明細表</h3></div><div class="space-y-5">${selected.map((key) => { const metric = METRICS[key]; const data = trend.metrics[key]; if (!data) return ''; return `<div><h4 class="mb-2 text-sm font-black ${metric.card} inline-flex rounded-lg border px-3 py-1">${metric.label}</h4><div class="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800"><table class="w-full text-sm"><thead class="bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-300"><tr><th class="px-4 py-2 text-left">年份</th><th class="px-4 py-2 text-right">年度新增</th><th class="px-4 py-2 text-right">年增比例</th><th class="px-4 py-2 text-right">累積總量</th></tr></thead><tbody class="divide-y divide-slate-100 dark:divide-slate-800">${data.rows.map((row) => { const annual = fmt(row.annual, metric); const cumulative = fmt(row.cumulative, metric); return `<tr class="bg-white dark:bg-slate-900"><td class="px-4 py-2 font-bold text-slate-700 dark:text-slate-200">${row.label}</td><td class="px-4 py-2 text-right font-mono text-slate-700 dark:text-slate-200">${annual.val} ${annual.unit}</td><td class="px-4 py-2 text-right font-mono text-slate-500 dark:text-slate-300">${formatRate(row.rate)}</td><td class="px-4 py-2 text-right font-mono text-slate-700 dark:text-slate-200">${cumulative.val} ${cumulative.unit}</td></tr>`; }).join('')}</tbody></table></div></div>`; }).join('')}</div></section>`;
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
      單位: metric.type === 'area' ? '坪' : metric.unit,
      年度新增: rawValue(row.annual, metric),
      年增比例: row.rate == null ? '' : `${(row.rate * 100).toFixed(1)}%`,
      累積總量: rawValue(row.cumulative, metric)
    }));
  });
  if (!rows.length) { alert('請至少選取一個要匯出的指標。'); return; }
  if (!window.XLSX) { alert('Excel 匯出元件尚未載入，請重新整理頁面後再試。'); return; }

  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet['!cols'] = [
    { wch: 18 }, { wch: 12 }, { wch: 10 }, { wch: 16 }, { wch: 14 }, { wch: 16 }
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '成長趨勢');
  XLSX.writeFile(workbook, `${timestampForFilename()}_(Security C).xlsx`);
}
async function openTrendOverlay() {
  const trend = await buildTrendData(); destroyCharts(); document.getElementById('trend-overlay-v2')?.remove();
  const productionArea = fmt(trend.metrics.production_area?.cumulative.at(-1) || 0, METRICS.production_area);
  const overlay = document.createElement('div'); overlay.id = 'trend-overlay-v2'; overlay.className = 'fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4';
  overlay.innerHTML = `<section class="w-full max-w-7xl max-h-[92vh] overflow-auto rounded-2xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-700" onclick="event.stopPropagation()"><div class="sticky top-0 z-10 flex flex-col xl:flex-row xl:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur px-6 py-4"><div><div class="flex items-center gap-2"><span class="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm"><i data-lucide="line-chart" class="w-5 h-5"></i></span><h2 class="text-xl font-black text-slate-800 dark:text-slate-100">成長趨勢</h2></div><p class="mt-1 text-sm text-slate-500 dark:text-slate-400">生產面積 = 無塵室面積 + 生產週邊面積；可匯出目前勾選的趨勢資料。</p></div><div class="flex flex-wrap items-center gap-2">${Object.values(METRICS).map(renderMetricButton).join('')}<button id="trend-export-v2" class="px-3 py-2 rounded-xl text-sm font-black bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm"><i data-lucide="download" class="inline-block w-4 h-4 mr-1"></i>匯出XLSX</button><button id="trend-close-v2" class="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"><i data-lucide="x" class="w-6 h-6"></i></button></div></div><div class="px-6 pt-4"><div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-4 py-3 inline-block"><div class="text-sm font-bold text-slate-500 dark:text-slate-300">生產面積合計</div><div class="mt-1 text-2xl font-black text-slate-800 dark:text-white">${productionArea.val}<span class="ml-1 text-sm text-slate-400">${productionArea.unit}</span></div><div class="mt-1 text-xs font-bold text-slate-400">無塵室面積 + 生產週邊面積</div></div></div><div class="px-6 py-4 space-y-3">${selected.length ? selected.map((key) => renderChartSection(METRICS[key], trend)).join('') : '<div class="rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 p-10 text-center text-slate-400 font-bold">請至少選取一個指標</div>'}${renderTables(trend)}</div></section>`;
  overlay.addEventListener('click', closeTrendOverlay); document.body.appendChild(overlay);
  document.getElementById('trend-close-v2')?.addEventListener('click', closeTrendOverlay);
  document.getElementById('trend-export-v2')?.addEventListener('click', (event) => { event.stopPropagation(); exportSelectedTrends(trend); });
  document.querySelectorAll('[data-trend-metric]').forEach((button) => button.addEventListener('click', async (event) => { event.stopPropagation(); const key = button.getAttribute('data-trend-metric'); selected = selected.includes(key) ? selected.filter((item) => item !== key) : [...selected, key]; await openTrendOverlay(); }));
  lucide?.createIcons?.(); drawCharts(trend);
}
function drawCharts(trend) {
  if (typeof Chart === 'undefined') return;
  const textColor = document.documentElement.classList.contains('dark') ? '#CBD5E1' : '#334155'; const mutedColor = document.documentElement.classList.contains('dark') ? '#94A3B8' : '#64748B'; const gridColor = document.documentElement.classList.contains('dark') ? 'rgba(148,163,184,.18)' : 'rgba(148,163,184,.28)';
  selected.forEach((key) => { const metric = METRICS[key]; const data = trend.metrics[key]; const canvas = document.getElementById(`trend-chart-${key}`); if (!data || !canvas) return; const annual = data.annual.map((v) => chartValue(v, metric)); const cumulative = data.cumulative.map((v) => chartValue(v, metric)); const unit = metric.type === 'area' ? '坪' : metric.unit; const maxAnnual = Math.max(...annual, 0), minCumulative = Math.min(...cumulative.filter((v) => v > 0), 0), maxCumulative = Math.max(...cumulative, 0), cumulativePadding = Math.max((maxCumulative - minCumulative) * 0.16, maxCumulative * 0.06, 1); const labelPlugin = { id: `trendLabels-${key}`, afterDatasetsDraw(chart) { const { ctx } = chart; const bars = chart.getDatasetMeta(0).data; ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.font = 'bold 11px sans-serif'; ctx.fillStyle = mutedColor; bars.forEach((bar, index) => { const value = annual[index] || 0; if (index === 0 || value <= 0) return; ctx.fillText(`${Math.round(value).toLocaleString()} ${unit} / ${formatRate(data.rates[index])}`, bar.x, bar.y - 8); }); ctx.restore(); } };
    charts[key] = new Chart(canvas, { data: { labels: data.labels, datasets: [{ type: 'bar', label: `${metric.annualLabel} (${unit})`, data: annual, borderColor: metric.color, backgroundColor: metric.bg, borderWidth: 2, borderRadius: 8, maxBarThickness: 50, yAxisID: 'annualAxis', order: 2 }, { type: 'line', label: `${metric.cumulativeLabel} (${unit})`, data: cumulative, borderColor: metric.color, backgroundColor: metric.bg, tension: .35, fill: false, pointRadius: 4, pointHoverRadius: 6, yAxisID: 'cumulativeAxis', order: 1 }] }, plugins: [labelPlugin], options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, layout: { padding: { top: 28, right: 8, bottom: 0 } }, plugins: { legend: { labels: { color: textColor, font: { weight: 'bold' } } }, tooltip: { callbacks: { label: (ctx) => ctx.dataset.type === 'bar' ? `${ctx.dataset.label}: ${Math.round(ctx.parsed.y).toLocaleString()} ${unit}｜年增比例: ${formatRate(data.rates[ctx.dataIndex])}` : `${ctx.dataset.label}: ${Math.round(ctx.parsed.y).toLocaleString()} ${unit}` } } }, scales: { x: { ticks: { color: textColor, font: { weight: 'bold' } }, grid: { display: false } }, annualAxis: { beginAtZero: true, suggestedMax: maxAnnual > 0 ? maxAnnual * 2.05 : 10, position: 'left', ticks: { color: textColor, callback: (value) => Number(value).toLocaleString() }, grid: { color: gridColor }, title: { display: true, text: `${metric.annualLabel} (${unit})`, color: mutedColor, font: { weight: 'bold' } } }, cumulativeAxis: { min: Math.max(0, minCumulative - cumulativePadding), suggestedMax: maxCumulative + cumulativePadding, position: 'right', ticks: { color: textColor, callback: (value) => Number(value).toLocaleString() }, grid: { drawOnChartArea: false }, title: { display: true, text: `${metric.cumulativeLabel} (${unit})`, color: mutedColor, font: { weight: 'bold' } } } } } }); });
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
