import { apiUrl } from './utils.js';

let currentUser = null;
let utilityData = null;
let isEditorOpen = false;

const DEFAULT_START_YEAR = 26;
const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const yearNumber = (key) => Number(String(key || '').replace(/[^0-9]/g, '')) || null;
const makeYearKey = (year) => `Y${year}`;

async function fetchMe() { const res = await fetch(apiUrl('/api/me'), { cache: 'no-store' }); if (!res.ok) return null; return res.json(); }
async function fetchUtilityTrends() { const res = await fetch(apiUrl('/api/utility-trends'), { cache: 'no-store' }); if (!res.ok) throw new Error('無法讀取需求趨勢資料'); return res.json(); }

function normalizeData(data) {
  const next = data || { schema_version: '1.0', metrics: [] };
  next.metrics = Array.isArray(next.metrics) ? next.metrics : [];
  next.metrics.forEach(metric => {
    metric.series = Array.isArray(metric.series) ? metric.series : [];
    metric.series.forEach(point => {
      if (point.year_key === 'Y1') { point.year_key = 'Y26'; point.year_label = 'Y26'; }
      if (point.year_key === 'Y2') { point.year_key = 'Y27'; point.year_label = 'Y27'; }
    });
    if (!metric.series.some(point => point.is_baseline || point.year_key === 'current')) metric.series.unshift({ year_key: 'current', year_label: '現況', value: 0, is_baseline: true, note: '目前既有基準值' });
    ['Y26', 'Y27'].forEach(key => { if (!metric.series.some(point => point.year_key === key)) metric.series.push({ year_key: key, year_label: key, value: 0, is_baseline: false, note: '預計新增需求' }); });
  });
  return next;
}

function getAllYearKeys(data) {
  const map = new Map();
  data.metrics.forEach(metric => metric.series.forEach(point => map.set(point.year_key, point.year_label)));
  const keys = Array.from(map.keys()).sort((a, b) => {
    if (a === 'current') return -1;
    if (b === 'current') return 1;
    return (yearNumber(a) || 9999) - (yearNumber(b) || 9999);
  });
  return keys.map(key => ({ key, label: map.get(key) || key }));
}

function getPoint(metric, yearKey) {
  let point = metric.series.find(item => item.year_key === yearKey);
  if (!point) { point = { year_key: yearKey, year_label: yearKey === 'current' ? '現況' : yearKey, value: 0, is_baseline: yearKey === 'current', note: '' }; metric.series.push(point); }
  return point;
}

function renderFloatingButton() {
  if (!currentUser || currentUser.role !== 'admin' || document.getElementById('utility-trend-admin-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'utility-trend-admin-btn';
  btn.className = 'fixed right-5 bottom-5 z-[90] flex items-center gap-2 rounded-full bg-indigo-600 px-5 py-3 text-sm font-black text-white shadow-xl hover:bg-indigo-700 transition-all';
  btn.innerHTML = '<i data-lucide="settings-2" class="w-4 h-4"></i> 需求趨勢設定';
  btn.addEventListener('click', openEditor);
  document.body.appendChild(btn);
  window.lucide?.createIcons?.();
}

function renderEditor() {
  if (!isEditorOpen || !utilityData) return;
  document.getElementById('utility-trend-admin-modal')?.remove();
  const years = getAllYearKeys(utilityData);
  const modal = document.createElement('div');
  modal.id = 'utility-trend-admin-modal';
  modal.className = 'fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4';
  modal.innerHTML = `<section class="w-full max-w-6xl max-h-[90vh] overflow-auto rounded-2xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-700" onclick="event.stopPropagation()"><div class="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur px-6 py-4"><div><div class="flex items-center gap-2"><span class="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 text-white"><i data-lucide="settings-2" class="w-5 h-5"></i></span><h2 class="text-xl font-black text-slate-800 dark:text-slate-100">需求趨勢設定</h2></div><p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Admin 可調整電力與用水需求。年度由現況往 Y26、Y27、Y28 逐年新增；現況是累積基準，年度欄位是新增需求。</p></div><button id="utility-close" class="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"><i data-lucide="x" class="w-6 h-6"></i></button></div><div class="px-6 py-5 space-y-4"><div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 p-4"><div class="text-sm text-slate-500 dark:text-slate-300">最後更新：<span class="font-bold text-slate-700 dark:text-slate-100">${escapeHtml(utilityData.updated_at || '-')}</span>｜更新者：<span class="font-bold text-slate-700 dark:text-slate-100">${escapeHtml(utilityData.updated_by || '-')}</span></div><div class="flex gap-2"><button id="utility-add-year" class="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2 text-sm font-black text-slate-600 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800">新增年度</button><button id="utility-save" class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-black text-white shadow-sm hover:bg-indigo-700">儲存設定</button></div></div><div class="overflow-auto rounded-xl border border-slate-200 dark:border-slate-800"><table class="w-full min-w-[900px] text-sm"><thead class="bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-300"><tr><th class="px-4 py-3 text-left">指標</th><th class="px-4 py-3 text-left">單位</th>${years.map(year => `<th class="px-4 py-3 text-right">${escapeHtml(year.label)}</th>`).join('')}</tr></thead><tbody class="divide-y divide-slate-100 dark:divide-slate-800">${utilityData.metrics.map((metric, metricIndex) => `<tr class="bg-white dark:bg-slate-900"><td class="px-4 py-3"><input data-field="metric_name" data-metric-index="${metricIndex}" class="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 font-bold text-slate-700 dark:text-slate-100" value="${escapeHtml(metric.metric_name)}"><div class="mt-1 text-xs text-slate-400">${escapeHtml(metric.metric_key)}</div></td><td class="px-4 py-3"><input data-field="unit" data-metric-index="${metricIndex}" class="w-24 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 font-bold text-slate-700 dark:text-slate-100" value="${escapeHtml(metric.unit || '')}"></td>${years.map(year => { const point = getPoint(metric, year.key); return `<td class="px-4 py-3 text-right"><input data-field="value" data-metric-index="${metricIndex}" data-year-key="${escapeHtml(year.key)}" type="number" step="0.01" class="w-32 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-right font-mono font-bold text-slate-700 dark:text-slate-100" value="${escapeHtml(point.value ?? 0)}"><div class="mt-1 text-[11px] text-slate-400">${point.is_baseline ? '累積基準' : '年度新增'}</div></td>`; }).join('')}</tr>`).join('')}</tbody></table></div><div id="utility-status" class="hidden rounded-lg px-4 py-3 text-sm font-bold"></div></div></section>`;
  modal.addEventListener('click', closeEditor);
  document.body.appendChild(modal);
  document.getElementById('utility-close')?.addEventListener('click', closeEditor);
  document.getElementById('utility-add-year')?.addEventListener('click', addYear);
  document.getElementById('utility-save')?.addEventListener('click', saveEditor);
  modal.querySelectorAll('input').forEach(input => input.addEventListener('input', syncInput));
  window.lucide?.createIcons?.();
}

async function openEditor() { try { utilityData = normalizeData(await fetchUtilityTrends()); isEditorOpen = true; renderEditor(); } catch (error) { alert(error.message || '需求趨勢設定開啟失敗'); } }
function closeEditor() { isEditorOpen = false; document.getElementById('utility-trend-admin-modal')?.remove(); }
function syncInput(event) { const input = event.target; const metric = utilityData.metrics[Number(input.dataset.metricIndex)]; if (!metric) return; if (input.dataset.field === 'metric_name') metric.metric_name = input.value; if (input.dataset.field === 'unit') metric.unit = input.value; if (input.dataset.field === 'value') getPoint(metric, input.dataset.yearKey).value = Number(input.value || 0); }
function addYear() { const nums = getAllYearKeys(utilityData).filter(y => y.key !== 'current').map(y => yearNumber(y.key)).filter(Boolean); const nextYear = Math.max(DEFAULT_START_YEAR - 1, ...nums) + 1; const key = makeYearKey(nextYear); utilityData.metrics.forEach(metric => { if (!metric.series.some(point => point.year_key === key)) metric.series.push({ year_key: key, year_label: key, value: 0, is_baseline: false, note: '預計新增需求' }); }); renderEditor(); }
function showStatus(message, ok = true) { const status = document.getElementById('utility-status'); if (!status) return; status.className = `rounded-lg px-4 py-3 text-sm font-bold ${ok ? 'border border-emerald-200 bg-emerald-50 text-emerald-700' : 'border border-red-200 bg-red-50 text-red-700'}`; status.textContent = message; }
async function saveEditor() { try { const res = await fetch(apiUrl('/api/admin/utility-trends'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(utilityData) }); const result = await res.json(); if (!res.ok) throw new Error(result.message || '儲存失敗'); utilityData = normalizeData(result.data); showStatus(result.backup_file ? `儲存成功，已備份上一版：${result.backup_file}` : '儲存成功'); } catch (error) { showStatus(error.message || '儲存失敗', false); } }
async function init() { try { currentUser = await fetchMe(); renderFloatingButton(); } catch (error) { console.warn('需求趨勢設定初始化失敗', error); } }
init();
