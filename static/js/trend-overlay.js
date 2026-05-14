import { processRawData } from './data.js';
import { formatArea } from './utils.js';

const METRICS = {
  clean: { key: 'clean', label: '無塵室面積', short: '無塵室', color: '#0EA5E9', bg: 'rgba(14,165,233,.18)', card: 'bg-sky-50 dark:bg-sky-950/30 border-sky-100 dark:border-sky-900/50 text-sky-600 dark:text-sky-300' },
  prod: { key: 'prod', label: '生產週邊面積', short: '生產週邊', color: '#10B981', bg: 'rgba(16,185,129,.18)', card: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-100 dark:border-emerald-900/50 text-emerald-600 dark:text-emerald-300' }
};

let selected = ['clean', 'prod'];
let charts = {};
let trendCache = null;

const parseYear = (value) => {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return null;
  const match = text.match(/Y\s*(\d{1,4})/i) || text.match(/(\d{4})/);
  const year = match ? Number(match[1]) : null;
  return Number.isFinite(year) ? year : null;
};

const yearLabel = (year) => year === 0 ? '現況' : `Y${year}`;
const formatRate = (rate) => rate === null || rate === undefined || !Number.isFinite(rate) ? '-' : `${(rate * 100).toFixed(1)}%`;
const unitLabel = () => '坪';
const toUnit = (value) => value * 0.3025;
const displayArea = (value) => formatArea(value, 'ping');

async function buildTrendData() {
  if (trendCache) return trendCache;

  const response = await fetch('/api/data', { cache: 'no-store' });
  if (!response.ok) throw new Error('無法讀取 /api/data');

  const rawData = await response.json();
  const { processedData } = processRawData(rawData);
  const base = { clean: 0, prod: 0 };
  const yearlyAdditions = new Map();

  processedData.forEach((item) => {
    const year = parseYear(item.expectedCompletionYear);
    const clean = Number(item.cleanRoomArea || 0);
    const prod = Number(item.prodArea || 0);

    if (item.status !== '未成廠' || year === null) {
      base.clean += clean;
      base.prod += prod;
      return;
    }

    const current = yearlyAdditions.get(year) || { clean: 0, prod: 0 };
    current.clean += clean;
    current.prod += prod;
    yearlyAdditions.set(year, current);
  });

  const years = Array.from(yearlyAdditions.keys()).sort((a, b) => a - b);
  const trend = { labels: ['現況', ...years.map(yearLabel)], metrics: {} };

  Object.keys(METRICS).forEach((key) => {
    let running = base[key] || 0;
    const cumulative = [running];
    const annual = [0];
    const rates = [null];
    const rows = [{ year: 0, annual: 0, rate: null, cumulative: running }];

    years.forEach((year) => {
      const add = yearlyAdditions.get(year)?.[key] || 0;
      const rate = running > 0 ? add / running : null;
      running += add;
      annual.push(add);
      rates.push(rate);
      cumulative.push(running);
      rows.push({ year, annual: add, rate, cumulative: running });
    });

    trend.metrics[key] = { annual, rates, cumulative, rows };
  });

  trendCache = trend;
  return trend;
}

function destroyCharts() {
  Object.values(charts).forEach((chart) => chart?.destroy?.());
  charts = {};
}

function closeTrendOverlay() {
  destroyCharts();
  document.getElementById('trend-overlay-v2')?.remove();
}

function renderMetricButton(metric) {
  const active = selected.includes(metric.key);
  return `
    <button data-trend-metric="${metric.key}" class="px-4 py-2 rounded-xl text-sm font-black transition-all ${active ? 'bg-blue-600 text-white shadow-sm' : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'}">
      ${active ? '✓ ' : ''}${metric.label}
    </button>`;
}

function renderChartSection(metric, trend) {
  const data = trend.metrics[metric.key];
  const latest = displayArea(data.cumulative[data.cumulative.length - 1] || 0);
  const latestAnnual = displayArea(data.annual[data.annual.length - 1] || 0);

  return `
    <section class="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-4">
      <div class="flex flex-col xl:flex-row xl:items-start justify-between gap-3 mb-4">
        <div>
          <div class="flex items-center gap-2">
            <span class="inline-flex h-8 w-8 items-center justify-center rounded-xl border ${metric.card}"><i data-lucide="bar-chart-3" class="w-4 h-4"></i></span>
            <h3 class="text-base font-black text-slate-700 dark:text-slate-100">${metric.label}</h3>
          </div>
          <p class="mt-1 text-xs font-bold text-slate-400">同一張圖表內呈現「累積總面積折線」與「年增面積柱狀」。柱狀圖刻度已壓低，與趨勢線保留較明顯間距。</p>
        </div>
        <div class="grid grid-cols-2 gap-2 min-w-[280px]">
          <div class="rounded-xl border p-3 ${metric.card}">
            <div class="text-xs font-bold">累積總面積</div>
            <div class="mt-1 text-xl font-black text-slate-800 dark:text-white">${latest.val}<span class="ml-1 text-xs text-slate-400">${latest.unit}</span></div>
          </div>
          <div class="rounded-xl border border-indigo-100 dark:border-indigo-900/50 bg-indigo-50 dark:bg-indigo-950/30 p-3">
            <div class="text-xs font-bold text-indigo-600 dark:text-indigo-300">最後年度新增</div>
            <div class="mt-1 text-xl font-black text-slate-800 dark:text-white">${latestAnnual.val}<span class="ml-1 text-xs text-slate-400">${latestAnnual.unit}</span></div>
            <div class="mt-1 text-[11px] font-bold text-slate-400">年增率：${formatRate(data.rates[data.rates.length - 1])}</div>
          </div>
        </div>
      </div>
      <div class="h-[390px]"><canvas id="trend-chart-${metric.key}"></canvas></div>
    </section>`;
}

function renderTables(trend) {
  if (!selected.length) return '';
  return `
    <section class="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-4">
      <div class="mb-4 flex items-center gap-2">
        <span class="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-500"><i data-lucide="table-2" class="w-4 h-4"></i></span>
        <h3 class="text-base font-black text-slate-700 dark:text-slate-100">年度明細表</h3>
      </div>
      <div class="space-y-5">
        ${selected.map((key) => {
          const metric = METRICS[key];
          const data = trend.metrics[key];
          return `
            <div>
              <h4 class="mb-2 text-sm font-black ${metric.card} inline-flex rounded-lg border px-3 py-1">${metric.label}</h4>
              <div class="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
                <table class="w-full text-sm">
                  <thead class="bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-300">
                    <tr>
                      <th class="px-4 py-2 text-left">年份</th>
                      <th class="px-4 py-2 text-right">年增面積</th>
                      <th class="px-4 py-2 text-right">年增比例</th>
                      <th class="px-4 py-2 text-right">累積總面積</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
                    ${data.rows.map((row) => {
                      const annual = displayArea(row.annual);
                      const cumulative = displayArea(row.cumulative);
                      return `
                        <tr class="bg-white dark:bg-slate-900">
                          <td class="px-4 py-2 font-bold text-slate-700 dark:text-slate-200">${yearLabel(row.year)}</td>
                          <td class="px-4 py-2 text-right font-mono text-slate-700 dark:text-slate-200">${annual.val} ${annual.unit}</td>
                          <td class="px-4 py-2 text-right font-mono text-slate-500 dark:text-slate-300">${formatRate(row.rate)}</td>
                          <td class="px-4 py-2 text-right font-mono text-slate-700 dark:text-slate-200">${cumulative.val} ${cumulative.unit}</td>
                        </tr>`;
                    }).join('')}
                  </tbody>
                </table>
              </div>
            </div>`;
        }).join('')}
      </div>
    </section>`;
}

async function openTrendOverlay() {
  const trend = await buildTrendData();
  destroyCharts();
  document.getElementById('trend-overlay-v2')?.remove();

  const total = displayArea((trend.metrics.clean.cumulative.at(-1) || 0) + (trend.metrics.prod.cumulative.at(-1) || 0));
  const overlay = document.createElement('div');
  overlay.id = 'trend-overlay-v2';
  overlay.className = 'fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4';
  overlay.innerHTML = `
    <section class="w-full max-w-7xl max-h-[92vh] overflow-auto rounded-2xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-700" onclick="event.stopPropagation()">
      <div class="sticky top-0 z-10 flex flex-col xl:flex-row xl:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur px-6 py-4">
        <div>
          <div class="flex items-center gap-2">
            <span class="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm"><i data-lucide="line-chart" class="w-5 h-5"></i></span>
            <h2 class="text-xl font-black text-slate-800 dark:text-slate-100">面積成長趨勢</h2>
          </div>
          <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">上方集中呈現圖表，下方集中呈現明細表；現況只作為累積基準，不列入年增面積。</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          ${Object.values(METRICS).map(renderMetricButton).join('')}
          <button id="trend-close-v2" class="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"><i data-lucide="x" class="w-6 h-6"></i></button>
        </div>
      </div>

      <div class="px-6 pt-5">
        <div class="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 p-4 inline-block">
          <div class="text-sm font-bold text-slate-500 dark:text-slate-300">無塵室 + 生產週邊合計</div>
          <div class="mt-1 text-2xl font-black text-slate-800 dark:text-white">${total.val}<span class="ml-1 text-sm text-slate-400">${total.unit}</span></div>
        </div>
      </div>

      <div class="px-6 py-5 space-y-5">
        ${selected.length ? selected.map((key) => renderChartSection(METRICS[key], trend)).join('') : '<div class="rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 p-10 text-center text-slate-400 font-bold">請至少選取一個面積指標</div>'}
        ${renderTables(trend)}
      </div>
    </section>`;

  overlay.addEventListener('click', closeTrendOverlay);
  document.body.appendChild(overlay);
  document.getElementById('trend-close-v2')?.addEventListener('click', closeTrendOverlay);
  document.querySelectorAll('[data-trend-metric]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const key = button.getAttribute('data-trend-metric');
      selected = selected.includes(key) ? selected.filter((item) => item !== key) : [...selected, key];
      await openTrendOverlay();
    });
  });

  lucide?.createIcons?.();
  drawCharts(trend);
}

function drawCharts(trend) {
  if (typeof Chart === 'undefined') return;

  const textColor = document.documentElement.classList.contains('dark') ? '#CBD5E1' : '#334155';
  const mutedColor = document.documentElement.classList.contains('dark') ? '#94A3B8' : '#64748B';
  const gridColor = document.documentElement.classList.contains('dark') ? 'rgba(148,163,184,.18)' : 'rgba(148,163,184,.28)';
  const uLabel = unitLabel();

  selected.forEach((key) => {
    const metric = METRICS[key];
    const data = trend.metrics[key];
    const annual = data.annual.map(toUnit);
    const cumulative = data.cumulative.map(toUnit);
    const canvas = document.getElementById(`trend-chart-${key}`);
    if (!canvas) return;

    const maxAnnual = Math.max(...annual, 0);
    const minCumulative = Math.min(...cumulative.filter((value) => value > 0), 0);
    const maxCumulative = Math.max(...cumulative, 0);
    const cumulativePadding = Math.max((maxCumulative - minCumulative) * 0.18, maxCumulative * 0.08, 1);

    const labelPlugin = {
      id: `trendLabels-${key}`,
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        const bars = chart.getDatasetMeta(0).data;
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.font = 'bold 11px sans-serif';
        ctx.fillStyle = mutedColor;
        bars.forEach((bar, index) => {
          const value = annual[index] || 0;
          if (index === 0 || value <= 0) return;
          ctx.fillText(`${Math.round(value).toLocaleString()} ${uLabel} / ${formatRate(data.rates[index])}`, bar.x, bar.y - 8);
        });
        ctx.restore();
      }
    };

    charts[key] = new Chart(canvas, {
      data: {
        labels: trend.labels,
        datasets: [
          {
            type: 'bar',
            label: `年增${metric.label} (${uLabel})`,
            data: annual,
            borderColor: metric.color,
            backgroundColor: metric.bg,
            borderWidth: 2,
            borderRadius: 8,
            maxBarThickness: 52,
            yAxisID: 'annualAxis',
            order: 2
          },
          {
            type: 'line',
            label: `累積${metric.label} (${uLabel})`,
            data: cumulative,
            borderColor: metric.color,
            backgroundColor: metric.bg,
            tension: .35,
            fill: false,
            pointRadius: 4,
            pointHoverRadius: 6,
            yAxisID: 'cumulativeAxis',
            order: 1
          }
        ]
      },
      plugins: [labelPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 34, right: 8 } },
        plugins: {
          legend: { labels: { color: textColor, font: { weight: 'bold' } } },
          tooltip: {
            callbacks: {
              label: (ctx) => ctx.dataset.type === 'bar'
                ? `${ctx.dataset.label}: ${Math.round(ctx.parsed.y).toLocaleString()} ${uLabel}｜年增比例: ${formatRate(data.rates[ctx.dataIndex])}`
                : `${ctx.dataset.label}: ${Math.round(ctx.parsed.y).toLocaleString()} ${uLabel}`
            }
          }
        },
        scales: {
          x: { ticks: { color: textColor, font: { weight: 'bold' } }, grid: { display: false } },
          annualAxis: {
            beginAtZero: true,
            suggestedMax: maxAnnual > 0 ? maxAnnual * 2.2 : 10,
            position: 'left',
            ticks: { color: textColor, callback: (value) => Number(value).toLocaleString() },
            grid: { color: gridColor },
            title: { display: true, text: `年增面積 (${uLabel})`, color: mutedColor, font: { weight: 'bold' } }
          },
          cumulativeAxis: {
            min: Math.max(0, minCumulative - cumulativePadding),
            suggestedMax: maxCumulative + cumulativePadding,
            position: 'right',
            ticks: { color: textColor, callback: (value) => Number(value).toLocaleString() },
            grid: { drawOnChartArea: false },
            title: { display: true, text: `累積總面積 (${uLabel})`, color: mutedColor, font: { weight: 'bold' } }
          }
        }
      }
    });
  });
}

function install() {
  if (!window.app?.openTrendModal || window.app.__trendOverlayInstalled) return false;
  window.app.openTrendModal = async () => {
    try {
      await openTrendOverlay();
    } catch (error) {
      console.error('成長趨勢開啟失敗', error);
      alert('成長趨勢開啟失敗，請查看 console。');
    }
  };
  window.app.closeTrendModal = closeTrendOverlay;
  window.app.__trendOverlayInstalled = true;
  return true;
}

const timer = setInterval(() => {
  if (install()) clearInterval(timer);
}, 100);

window.addEventListener('beforeunload', () => clearInterval(timer));
