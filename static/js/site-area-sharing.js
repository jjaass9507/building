import { formatArea, apiUrl } from './utils.js';

const CONFIG_KEY = 'site_area_sharing';
const DEFAULT_CONFIG = {
  schema_version: '1.0',
  groups: [
    {
      group_id: 'K11_K11B',
      group_name: 'K11 / K11B 共用基地',
      buildings: ['K11', 'K11B', 'K11B(停車場)'],
      site_area_m2: null,
      note: 'K11 與 K11B 共用基地面積，總基地面積只計算一次。'
    },
    {
      group_id: 'K27_K27B',
      group_name: 'K27 / K27B 共用基地',
      buildings: ['K27', 'K27B'],
      site_area_m2: null,
      note: 'K27 與 K27B 共用基地面積，總基地面積只計算一次。'
    }
  ]
};

let currentUser = null;
let rawData = [];
let utilityData = null;
let siteConfig = null;
let isEditorOpen = false;
let observerInstalled = false;

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const toNumber = (value) => {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
};

const canonicalName = (value) => String(value || '')
  .replace(/（.*?）/g, '')
  .replace(/\(.*?\)/g, '')
  .replace(/\s+/g, '')
  .trim()
  .toUpperCase();

const normalizeText = (value) => String(value || '').replace(/\s+/g, '').trim();

async function fetchJson(url, fallback) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return fallback;
    return await res.json();
  } catch (_) {
    return fallback;
  }
}

function normalizeUtilityTrends(data) {
  const next = data || { schema_version: '1.0', metrics: [] };
  next.metrics = Array.isArray(next.metrics) ? next.metrics : [];
  next.metrics.forEach(metric => {
    metric.series = Array.isArray(metric.series) ? metric.series : [];
    metric.series.forEach(point => {
      if (point.year_key === 'Y1') { point.year_key = 'Y26'; point.year_label = 'Y26'; }
      if (point.year_key === 'Y2') { point.year_key = 'Y27'; point.year_label = 'Y27'; }
    });
  });
  return next;
}

function normalizeConfig(config) {
  const source = config && Array.isArray(config.groups) ? config : DEFAULT_CONFIG;
  return {
    schema_version: source.schema_version || '1.0',
    updated_at: source.updated_at || '',
    updated_by: source.updated_by || '',
    groups: (source.groups || []).map((group, index) => ({
      group_id: group.group_id || `SITE_AREA_GROUP_${index + 1}`,
      group_name: group.group_name || `共用基地群組 ${index + 1}`,
      buildings: Array.isArray(group.buildings) ? group.buildings : String(group.buildings || '').split(/[,，\n]/).map(item => item.trim()).filter(Boolean),
      site_area_m2: group.site_area_m2 === null || group.site_area_m2 === undefined || group.site_area_m2 === '' ? null : toNumber(group.site_area_m2),
      note: group.note || ''
    }))
  };
}

function getBuildingNames() {
  return rawData.map(item => item?.['棟別']).filter(Boolean);
}

function getActualNameResolver() {
  const exact = new Map();
  const canonical = new Map();
  getBuildingNames().forEach(name => {
    exact.set(String(name), String(name));
    if (!canonical.has(canonicalName(name))) canonical.set(canonicalName(name), String(name));
  });

  return (name) => {
    const text = String(name || '').trim();
    if (!text) return null;
    return exact.get(text) || canonical.get(canonicalName(text)) || text;
  };
}

function getResolvedGroups() {
  const resolveName = getActualNameResolver();
  return normalizeConfig(siteConfig).groups.map(group => {
    const buildings = [];
    const seen = new Set();
    group.buildings.forEach(name => {
      const actual = resolveName(name);
      if (!actual || seen.has(actual)) return;
      seen.add(actual);
      buildings.push(actual);
    });
    return { ...group, buildings };
  }).filter(group => group.buildings.length > 1);
}

function getSharedMap() {
  const map = new Map();
  getResolvedGroups().forEach(group => {
    group.buildings.forEach(building => {
      const others = group.buildings.filter(item => item !== building);
      map.set(building, { group, others });
    });
  });
  return map;
}

function buildingIncluded(building, includeUnfinished) {
  if (includeUnfinished) return true;
  const floors = Array.isArray(building?.['樓層']) ? building['樓層'] : [];
  if (!floors.length) return false;
  return floors.some(floor => String(floor?.['狀態'] || '').trim() !== '未成廠');
}

function getHeaderUnit() {
  const header = document.querySelector('header');
  const floorMetric = Array.from(header?.querySelectorAll('div') || [])
    .find(el => el.textContent.includes('總樓地板:'));
  const text = floorMetric?.textContent || '';
  return text.includes('坪') ? 'ping' : 'm2';
}

function getIncludeUnfinishedState() {
  return Boolean(document.querySelector('header input[type="checkbox"]')?.checked);
}

function calculateTotalSiteArea() {
  const includeUnfinished = getIncludeUnfinishedState();
  const eligible = rawData.filter(building => buildingIncluded(building, includeUnfinished));
  const eligibleNames = new Set(eligible.map(building => String(building?.['棟別'] || '')));
  const byName = new Map(eligible.map(building => [String(building?.['棟別'] || ''), building]));
  const sharedMap = getSharedMap();
  const counted = new Set();
  let total = 0;

  eligible.forEach(building => {
    const name = String(building?.['棟別'] || '');
    if (!name) return;
    const shared = sharedMap.get(name);

    if (shared) {
      const groupNames = shared.group.buildings.filter(item => eligibleNames.has(item));
      if (groupNames.length > 1) {
        const countKey = `group:${shared.group.group_id}:${groupNames.sort().join('|')}`;
        if (counted.has(countKey)) return;
        counted.add(countKey);

        const override = toNumber(shared.group.site_area_m2);
        const groupArea = override > 0
          ? override
          : Math.max(...groupNames.map(item => toNumber(byName.get(item)?.['基地面積(M2)'])), 0);
        total += groupArea;
        return;
      }
    }

    total += toNumber(building?.['基地面積(M2)']);
  });

  return total;
}

function injectTotalSiteArea() {
  const header = document.querySelector('header');
  if (!header || !rawData.length) return;

  header.querySelectorAll('[data-site-area-total="true"]').forEach(el => el.remove());

  const cleanMetric = Array.from(header.querySelectorAll('div.flex.items-baseline'))
    .find(el => el.textContent.includes('總無塵室:'));
  if (!cleanMetric) return;

  const total = formatArea(calculateTotalSiteArea(), getHeaderUnit());
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-site-area-total', 'true');
  wrapper.className = 'contents';
  wrapper.innerHTML = `
    <div class="w-px h-3 bg-slate-300 dark:bg-slate-700" data-site-area-total="true"></div>
    <div class="flex items-baseline gap-1.5" data-site-area-total="true" title="共用基地面積群組只計算一次">
      <span class="text-[18px] font-bold text-slate-500 dark:text-slate-400">總基地面積:</span>
      <span class="font-mono text-[22px] font-black text-emerald-600 dark:text-emerald-400">${total.val}</span>
      <span class="text-[18px] text-emerald-500 dark:text-emerald-400">${total.unit}</span>
    </div>`;
  cleanMetric.insertAdjacentElement('afterend', wrapper);
}

function injectBuildingSharedBadges() {
  const matrix = document.getElementById('matrix-scroll-container');
  if (!matrix) return;
  matrix.querySelectorAll('[data-site-area-share-badge="true"]').forEach(el => el.remove());

  const sharedMap = getSharedMap();
  if (!sharedMap.size) return;

  sharedMap.forEach(({ others }, building) => {
    const candidates = Array.from(matrix.querySelectorAll('h1,h2,h3,h4,span,div'))
      .filter(el => normalizeText(el.textContent) === normalizeText(building));

    candidates.slice(0, 3).forEach(el => {
      const badge = document.createElement('div');
      badge.setAttribute('data-site-area-share-badge', 'true');
      badge.className = 'mt-1 inline-flex max-w-[190px] items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-black text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300';
      badge.title = `基地面積與 ${others.join('、')} 共用，總基地面積不重複計算`;
      badge.innerHTML = `<i data-lucide="link-2" class="w-3 h-3 shrink-0"></i><span class="truncate">基地共用：${escapeHtml(others.join(' / '))}</span>`;
      el.insertAdjacentElement('afterend', badge);
    });
  });

  window.lucide?.createIcons?.();
}

function applySiteAreaEnhancements() {
  injectTotalSiteArea();
  injectBuildingSharedBadges();
}

function renderFloatingButton() {
  if (!currentUser || currentUser.role !== 'admin' || document.getElementById('site-area-sharing-admin-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'site-area-sharing-admin-btn';
  btn.className = 'fixed right-5 bottom-20 z-[90] flex items-center gap-2 rounded-full bg-emerald-600 px-5 py-3 text-sm font-black text-white shadow-xl hover:bg-emerald-700 transition-all';
  btn.innerHTML = '<i data-lucide="map" class="w-4 h-4"></i> 基地面積共用設定';
  btn.addEventListener('click', openEditor);
  document.body.appendChild(btn);
  window.lucide?.createIcons?.();
}

function groupRowsHtml() {
  const config = normalizeConfig(siteConfig);
  return config.groups.map((group, index) => `
    <tr class="bg-white dark:bg-slate-900" data-site-group-row="${index}">
      <td class="px-4 py-3 align-top">
        <input data-site-field="group_name" data-site-index="${index}" class="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 font-bold text-slate-700 dark:text-slate-100" value="${escapeHtml(group.group_name)}">
        <div class="mt-1 text-xs text-slate-400">${escapeHtml(group.group_id)}</div>
      </td>
      <td class="px-4 py-3 align-top">
        <textarea data-site-field="buildings" data-site-index="${index}" rows="2" class="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 font-mono text-sm font-bold text-slate-700 dark:text-slate-100" placeholder="例：K11, K11B">${escapeHtml(group.buildings.join(', '))}</textarea>
        <div class="mt-1 text-[11px] text-slate-400">請用逗號、全形逗號或換行分隔棟別；可輸入 K11B 或 K11B(停車場)。</div>
      </td>
      <td class="px-4 py-3 align-top text-right">
        <input data-site-field="site_area_m2" data-site-index="${index}" type="number" step="0.01" class="w-36 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-right font-mono font-bold text-slate-700 dark:text-slate-100" value="${group.site_area_m2 ?? ''}" placeholder="自動">
        <div class="mt-1 text-[11px] text-slate-400">留空＝取群組內最大基地面積</div>
      </td>
      <td class="px-4 py-3 align-top">
        <textarea data-site-field="note" data-site-index="${index}" rows="2" class="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-700 dark:text-slate-100">${escapeHtml(group.note)}</textarea>
      </td>
      <td class="px-4 py-3 align-top text-right">
        <button data-site-delete="${index}" class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-black text-red-600 hover:bg-red-100 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">刪除</button>
      </td>
    </tr>`).join('');
}

function renderEditor() {
  if (!isEditorOpen) return;
  document.getElementById('site-area-sharing-admin-modal')?.remove();
  const buildings = getBuildingNames();
  const config = normalizeConfig(siteConfig);
  const modal = document.createElement('div');
  modal.id = 'site-area-sharing-admin-modal';
  modal.className = 'fixed inset-0 z-[135] flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4';
  modal.innerHTML = `
    <section class="w-full max-w-6xl max-h-[90vh] overflow-auto rounded-2xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-700" onclick="event.stopPropagation()">
      <div class="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur px-6 py-4">
        <div>
          <div class="flex items-center gap-2"><span class="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-600 text-white"><i data-lucide="map" class="w-5 h-5"></i></span><h2 class="text-xl font-black text-slate-800 dark:text-slate-100">基地面積共用設定</h2></div>
          <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">設定同一基地由多個棟別共用時，前台會標註共用關係，且總基地面積只計算一次。</p>
        </div>
        <button id="site-area-close" class="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"><i data-lucide="x" class="w-6 h-6"></i></button>
      </div>
      <div class="px-6 py-5 space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 p-4">
          <div class="text-sm text-slate-500 dark:text-slate-300">
            可用棟別：<span class="font-bold text-slate-700 dark:text-slate-100">${escapeHtml(buildings.join('、') || '-')}</span>
            <div class="mt-1 text-xs text-slate-400">最後更新：${escapeHtml(config.updated_at || '-')}｜更新者：${escapeHtml(config.updated_by || '-')}</div>
          </div>
          <div class="flex gap-2"><button id="site-area-add-group" class="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2 text-sm font-black text-slate-600 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800">新增共用群組</button><button id="site-area-save" class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-black text-white shadow-sm hover:bg-emerald-700">儲存設定</button></div>
        </div>
        <div class="overflow-auto rounded-xl border border-slate-200 dark:border-slate-800">
          <table class="w-full min-w-[980px] text-sm">
            <thead class="bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-300"><tr><th class="px-4 py-3 text-left">群組名稱</th><th class="px-4 py-3 text-left">共用棟別</th><th class="px-4 py-3 text-right">共用基地面積(M²)</th><th class="px-4 py-3 text-left">備註</th><th class="px-4 py-3 text-right">操作</th></tr></thead>
            <tbody class="divide-y divide-slate-100 dark:divide-slate-800">${groupRowsHtml()}</tbody>
          </table>
        </div>
        <div id="site-area-status" class="hidden rounded-lg px-4 py-3 text-sm font-bold"></div>
      </div>
    </section>`;

  modal.addEventListener('click', closeEditor);
  document.body.appendChild(modal);
  modal.querySelectorAll('input,textarea').forEach(input => input.addEventListener('input', syncEditorInput));
  modal.querySelector('#site-area-close')?.addEventListener('click', closeEditor);
  modal.querySelector('#site-area-add-group')?.addEventListener('click', addGroup);
  modal.querySelector('#site-area-save')?.addEventListener('click', saveEditor);
  modal.querySelectorAll('[data-site-delete]').forEach(button => button.addEventListener('click', deleteGroup));
  window.lucide?.createIcons?.();
}

async function openEditor() {
  await ensureDataLoaded(true);
  isEditorOpen = true;
  renderEditor();
}

function closeEditor() {
  isEditorOpen = false;
  document.getElementById('site-area-sharing-admin-modal')?.remove();
}

function syncEditorInput(event) {
  const input = event.target;
  const index = Number(input.dataset.siteIndex);
  const field = input.dataset.siteField;
  const config = normalizeConfig(siteConfig);
  const group = config.groups[index];
  if (!group) return;

  if (field === 'buildings') group.buildings = input.value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean);
  else if (field === 'site_area_m2') group.site_area_m2 = input.value === '' ? null : toNumber(input.value);
  else group[field] = input.value;
  siteConfig = config;
}

function addGroup(event) {
  event.stopPropagation();
  const config = normalizeConfig(siteConfig);
  const nextIndex = config.groups.length + 1;
  config.groups.push({ group_id: `SITE_AREA_GROUP_${Date.now()}`, group_name: `共用基地群組 ${nextIndex}`, buildings: [], site_area_m2: null, note: '' });
  siteConfig = config;
  renderEditor();
}

function deleteGroup(event) {
  event.stopPropagation();
  const index = Number(event.currentTarget.dataset.siteDelete);
  const config = normalizeConfig(siteConfig);
  config.groups.splice(index, 1);
  siteConfig = config;
  renderEditor();
}

function showStatus(message, ok = true) {
  const status = document.getElementById('site-area-status');
  if (!status) return;
  status.className = `rounded-lg px-4 py-3 text-sm font-bold ${ok ? 'border border-emerald-200 bg-emerald-50 text-emerald-700' : 'border border-red-200 bg-red-50 text-red-700'}`;
  status.textContent = message;
}

async function saveEditor(event) {
  event.stopPropagation();
  try {
    utilityData = normalizeUtilityTrends(utilityData || await fetchJson(apiUrl('/api/utility-trends'), { metrics: [] }));
    const config = normalizeConfig(siteConfig);
    const validGroups = config.groups.filter(group => group.buildings.length > 1);
    utilityData[CONFIG_KEY] = {
      ...config,
      groups: validGroups,
      updated_at: new Date().toISOString(),
      updated_by: currentUser?.username || 'admin'
    };

    const res = await fetch(apiUrl('/api/admin/utility-trends'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(utilityData)
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.message || '儲存失敗');

    utilityData = normalizeUtilityTrends(result.data);
    siteConfig = normalizeConfig(utilityData[CONFIG_KEY]);
    showStatus(result.backup_file ? `儲存成功，已備份上一版：${result.backup_file}` : '儲存成功');
    applySiteAreaEnhancements();
  } catch (error) {
    showStatus(error.message || '儲存失敗', false);
  }
}

async function ensureDataLoaded(force = false) {
  if (!force && rawData.length && utilityData && siteConfig) return;
  const [me, data, utility] = await Promise.all([
    fetchJson(apiUrl('/api/me'), null),
    fetchJson(apiUrl('/api/data'), []),
    fetchJson(apiUrl('/api/utility-trends'), { metrics: [] })
  ]);
  currentUser = me || currentUser;
  rawData = Array.isArray(data) ? data : [];
  utilityData = normalizeUtilityTrends(utility);
  siteConfig = normalizeConfig(utilityData[CONFIG_KEY]);
}

function installObserver() {
  if (observerInstalled) return;
  const app = document.getElementById('app');
  if (!app) return;
  observerInstalled = true;
  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(applySiteAreaEnhancements, 80);
  }).observe(app, { childList: true, subtree: true });
}

async function init() {
  await ensureDataLoaded();
  renderFloatingButton();
  installObserver();
  applySiteAreaEnhancements();
}

init().catch(error => console.warn('基地面積共用設定初始化失敗', error));
