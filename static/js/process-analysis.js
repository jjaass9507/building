import { apiUrl, filterRowsByScope, formatArea, formatPct } from './utils.js?v=20260916-unified-scope';

const MIXED_PROCESS = '混合';
const UNCLASSIFIED_PROCESS = '未分類';
const UNGROUPED_GROUP = '未分群';
const PROCESS_SEPARATORS = /[、,，;；/／＋+＆&|\n\r]+/;
const GROUP_COLORS = ['#0284C7', '#059669', '#7C3AED', '#EA580C', '#DB2777', '#0891B2', '#4F46E5', '#65A30D'];
const SPECIAL_COLORS = { [MIXED_PROCESS]: '#D97706', [UNGROUPED_GROUP]: '#64748B' };
const STATUS_COLORS = { established: '#0F8C88', unfinished: '#D97706' };

const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const numericValue = (value) => {
    if (value && typeof value === 'object') return Number(value.value ?? value.val ?? 0) || 0;
    return Number(value || 0) || 0;
};

export const classifyProcess = (value) => {
    const text = String(value ?? '').trim();
    if (!text || ['-', 'N/A', 'NA', '非製程'].includes(text.toUpperCase())) return UNCLASSIFIED_PROCESS;
    const parts = text.split(PROCESS_SEPARATORS).map(item => item.trim()).filter(Boolean);
    return parts.length > 1 ? MIXED_PROCESS : (parts[0] || UNCLASSIFIED_PROCESS);
};

const normalizedGroups = (config) => Array.isArray(config?.groups) ? config.groups : [];

const processGroupLookup = (config) => {
    const lookup = new Map();
    normalizedGroups(config).forEach((group, groupIndex) => {
        const name = String(group?.name || '').trim();
        if (!name) return;
        (Array.isArray(group.processes) ? group.processes : []).forEach(process => {
            const key = String(process || '').trim();
            if (key && !lookup.has(key)) lookup.set(key, { name, groupIndex });
        });
    });
    return lookup;
};

export const buildProcessAnalysis = (rows, config, options = {}) => {
    const processTotals = new Map();

    // 製程分析固定同時呈現已成廠與未成廠，只沿用目前選取的廠棟範圍。
    filterRowsByScope(rows, { ...options, includeUnfinished: true }).forEach(row => {
        const cleanArea = numericValue(row.cleanRoomArea);
        if (!(cleanArea > 0)) return;
        const process = classifyProcess(row.processLabel ?? row.usageLabel);
        const totals = processTotals.get(process) || { establishedArea: 0, unfinishedArea: 0 };
        if (row.status === '未成廠') totals.unfinishedArea += cleanArea;
        else totals.establishedArea += cleanArea;
        processTotals.set(process, totals);
    });

    const lookup = processGroupLookup(config);
    const configuredGroups = normalizedGroups(config).map((group, index) => ({ name: String(group.name || '').trim(), index }));
    const getGroup = (process) => {
        if (process === MIXED_PROCESS) return { name: MIXED_PROCESS, groupIndex: configuredGroups.length };
        if (process === UNCLASSIFIED_PROCESS) return { name: UNGROUPED_GROUP, groupIndex: configuredGroups.length + 1 };
        return lookup.get(process) || { name: UNGROUPED_GROUP, groupIndex: configuredGroups.length + 1 };
    };

    const processes = [...processTotals.entries()].map(([process, statusTotals]) => {
        const group = getGroup(process);
        const area = statusTotals.establishedArea + statusTotals.unfinishedArea;
        return { process, area, ...statusTotals, group: group.name, groupIndex: group.groupIndex };
    }).sort((a, b) => a.groupIndex - b.groupIndex || b.area - a.area || a.process.localeCompare(b.process, 'zh-TW'));

    const groupTotals = new Map();
    processes.forEach(row => {
        const totals = groupTotals.get(row.group) || { establishedArea: 0, unfinishedArea: 0 };
        totals.establishedArea += row.establishedArea;
        totals.unfinishedArea += row.unfinishedArea;
        groupTotals.set(row.group, totals);
    });
    const groups = [...groupTotals.entries()].map(([name, statusTotals]) => ({
        name,
        ...statusTotals,
        area: statusTotals.establishedArea + statusTotals.unfinishedArea
    }));
    const total = processes.reduce((sum, row) => sum + row.area, 0);
    const establishedTotal = processes.reduce((sum, row) => sum + row.establishedArea, 0);
    const unfinishedTotal = processes.reduce((sum, row) => sum + row.unfinishedArea, 0);
    return { processes, groups, total, establishedTotal, unfinishedTotal };
};

const colorMapFor = (analysis, config) => {
    const map = new Map();
    normalizedGroups(config).forEach((group, index) => map.set(group.name, GROUP_COLORS[index % GROUP_COLORS.length]));
    analysis.groups.forEach(group => {
        if (!map.has(group.name)) map.set(group.name, SPECIAL_COLORS[group.name] || GROUP_COLORS[map.size % GROUP_COLORS.length]);
    });
    return map;
};

export const fetchProcessGroupConfig = async () => {
    const response = await fetch(apiUrl('/api/process-groups'), { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message || '製程大群組設定載入失敗。');
    return result.data || { schema_version: '1.0', groups: [] };
};

export const renderProcessAnalysisModal = (state, rows, config, buildings) => {
    if (!state.isProcessAnalysisOpen) return '';
    const analysis = buildProcessAnalysis(rows, config, { buildings });
    const colors = colorMapFor(analysis, config);
    const unitLabel = state.unit === 'ping' ? '坪' : 'M²';
    const scope = buildings?.length ? `${buildings.length} 棟已選廠棟` : '全部廠棟';

    return `
        <div class="fixed inset-0 z-[105] flex items-center justify-center bg-slate-950/65 p-3 md:p-5" onclick="window.app.closeProcessAnalysis()">
            <section class="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900" onclick="event.stopPropagation()">
                <header class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-700">
                    <div>
                        <div class="text-[11px] font-black uppercase tracking-[0.18em] text-sky-600">Cleanroom Process Analysis</div>
                        <h2 class="mt-1 text-xl font-black text-slate-900 dark:text-white">By 製程無塵室面積</h2>
                        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">${escapeHtml(scope)} · 固定同時呈現已成廠與未成廠 · 複數製程統一歸入「混合」</p>
                    </div>
                    <button type="button" onclick="window.app.closeProcessAnalysis()" class="inline-flex h-9 w-9 items-center justify-center border border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800" title="關閉"><i data-lucide="x" class="h-5 w-5"></i></button>
                </header>
                <div class="min-h-0 flex-1 overflow-auto p-5">
                    ${analysis.total > 0 ? `
                        <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                            ${analysis.groups.map(group => {
                                const area = formatArea(group.area, state.unit);
                                const established = formatArea(group.establishedArea, state.unit);
                                const unfinished = formatArea(group.unfinishedArea, state.unit);
                                return `<div class="border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/70">
                                    <div class="flex items-center gap-2 text-xs font-bold text-slate-500 dark:text-slate-400"><span class="h-2.5 w-2.5" style="background:${colors.get(group.name)}"></span>${escapeHtml(group.name)}</div>
                                    <div class="mt-1 font-mono text-lg font-black text-slate-800 dark:text-white">${area.val} <span class="text-xs text-slate-400">${area.unit}</span></div>
                                    <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-bold"><span style="color:${STATUS_COLORS.established}">已成廠 ${established.val} ${established.unit}</span><span style="color:${STATUS_COLORS.unfinished}">未成廠 ${unfinished.val} ${unfinished.unit}</span></div>
                                </div>`;
                            }).join('')}
                        </div>
                        <div class="mt-4 flex flex-wrap items-center gap-4 text-xs font-bold text-slate-600 dark:text-slate-300"><span class="inline-flex items-center gap-2"><span class="h-3 w-3" style="background:${STATUS_COLORS.established}"></span>已成廠</span><span class="inline-flex items-center gap-2"><span class="h-3 w-3" style="background:${STATUS_COLORS.unfinished}"></span>未成廠</span><span class="font-normal text-slate-400">各製程以狀態分色堆疊，合計長度為該製程總面積。</span></div>
                        <div class="mt-5 border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-950/30" style="height:${Math.max(360, Math.min(900, analysis.processes.length * 36 + 90))}px"><canvas id="process-cleanroom-chart"></canvas></div>
                        <div class="mt-5 overflow-hidden border border-slate-200 dark:border-slate-700">
                            <table class="w-full border-collapse text-sm">
                                <thead class="bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300"><tr><th class="px-4 py-2 text-left">大群組</th><th class="px-4 py-2 text-left">製程</th><th class="px-4 py-2 text-right">已成廠</th><th class="px-4 py-2 text-right">未成廠</th><th class="px-4 py-2 text-right">合計</th><th class="px-4 py-2 text-right">占比</th></tr></thead>
                                <tbody class="divide-y divide-slate-100 dark:divide-slate-800">${analysis.processes.map(row => {
                                    const area = formatArea(row.area, state.unit);
                                    const established = formatArea(row.establishedArea, state.unit);
                                    const unfinished = formatArea(row.unfinishedArea, state.unit);
                                    return `<tr><td class="px-4 py-2 font-bold text-slate-600 dark:text-slate-300">${escapeHtml(row.group)}</td><td class="px-4 py-2 text-slate-700 dark:text-slate-200">${escapeHtml(row.process)}</td><td class="px-4 py-2 text-right font-mono font-bold" style="color:${STATUS_COLORS.established}">${established.val} ${established.unit}</td><td class="px-4 py-2 text-right font-mono font-bold" style="color:${STATUS_COLORS.unfinished}">${unfinished.val} ${unfinished.unit}</td><td class="px-4 py-2 text-right font-mono font-bold">${area.val} ${area.unit}</td><td class="px-4 py-2 text-right font-mono">${formatPct(row.area / analysis.total)}%</td></tr>`;
                                }).join('')}</tbody>
                            </table>
                        </div>` : `<div class="flex min-h-[360px] items-center justify-center border border-dashed border-slate-300 text-sm font-bold text-slate-500 dark:border-slate-700">目前範圍沒有可加總的無塵室面積。</div>`}
                </div>
                <footer class="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400"><span>圖表單位：${unitLabel}</span><span>大群組僅套用於單一製程；「混合」固定獨立統計。</span></footer>
            </section>
        </div>`;
};

let processChart = null;
export const destroyProcessAnalysisChart = () => {
    processChart?.destroy();
    processChart = null;
};

export const drawProcessAnalysisChart = (state, rows, config, buildings) => {
    const canvas = document.getElementById('process-cleanroom-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    destroyProcessAnalysisChart();
    const analysis = buildProcessAnalysis(rows, config, { buildings });
    const toDisplay = value => state.unit === 'ping' ? value * 0.3025 : value;
    const unitLabel = state.unit === 'ping' ? '坪' : 'm²';
    processChart = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: analysis.processes.map(row => row.process),
            datasets: [{
                label: `已成廠 (${unitLabel})`,
                data: analysis.processes.map(row => toDisplay(row.establishedArea)),
                backgroundColor: STATUS_COLORS.established,
                borderWidth: 0,
                borderRadius: 2
            }, {
                label: `未成廠 (${unitLabel})`,
                data: analysis.processes.map(row => toDisplay(row.unfinishedArea)),
                backgroundColor: STATUS_COLORS.unfinished,
                borderWidth: 0,
                borderRadius: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            plugins: {
                legend: { display: true, position: 'top', align: 'end' },
                tooltip: { callbacks: { afterLabel: context => `大群組：${analysis.processes[context.dataIndex]?.group || UNGROUPED_GROUP}` } }
            },
            scales: {
                x: { stacked: true, beginAtZero: true, ticks: { callback: value => Number(value).toLocaleString() }, title: { display: true, text: `無塵室面積 (${unitLabel})` } },
                y: { stacked: true, ticks: { autoSkip: false } }
            }
        }
    });
};

const discoverSingleProcesses = (rows) => [...new Set((Array.isArray(rows) ? rows : [])
    .map(row => classifyProcess(row.processLabel ?? row.usageLabel))
    .filter(value => ![MIXED_PROCESS, UNCLASSIFIED_PROCESS].includes(value)))]
    .sort((a, b) => a.localeCompare(b, 'zh-TW'));

let adminState = null;

const renderProcessGroupAdmin = () => {
    document.getElementById('process-group-admin-modal')?.remove();
    if (!adminState) return;
    const assigned = new Map();
    adminState.groups.forEach((group, groupIndex) => group.processes.forEach(process => assigned.set(process, groupIndex)));
    const visibleProcesses = adminState.processes.filter(process => !adminState.query || process.toLowerCase().includes(adminState.query.toLowerCase()));
    const modal = document.createElement('div');
    modal.id = 'process-group-admin-modal';
    modal.className = 'fixed inset-0 z-[170] bg-slate-950/60 p-3 md:p-6';
    modal.innerHTML = `
        <section class="mx-auto flex h-full max-w-6xl flex-col overflow-hidden border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
            <header class="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 dark:border-slate-700">
                <div><div class="text-[11px] font-black uppercase tracking-[0.18em] text-sky-600">ADMIN</div><h2 class="mt-1 text-xl font-black text-slate-900 dark:text-white">製程大群組設定</h2><p class="mt-1 text-sm text-slate-500 dark:text-slate-400">建立大群組並指定單一製程；複數製程樓層固定歸入「混合」，不參與設定。</p></div>
                <button type="button" data-admin-close class="inline-flex h-9 w-9 items-center justify-center border border-slate-200 dark:border-slate-700"><i data-lucide="x" class="h-5 w-5"></i></button>
            </header>
            <div class="flex flex-wrap items-center gap-2 border-b border-slate-200 px-5 py-3 dark:border-slate-700"><button type="button" data-add-group class="bg-slate-800 px-4 py-2 text-sm font-black text-white dark:bg-blue-600">新增大群組</button><input data-process-search value="${escapeHtml(adminState.query)}" placeholder="搜尋製程" class="min-w-[240px] border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"><span class="text-xs text-slate-500">${adminState.processes.length} 個可設定製程</span></div>
            <div class="min-h-0 flex-1 overflow-auto p-5">
                ${adminState.message ? `<div class="mb-4 border px-4 py-3 text-sm font-bold ${adminState.message.success ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}">${escapeHtml(adminState.message.text)}</div>` : ''}
                <div class="space-y-4">${adminState.groups.map((group, groupIndex) => `
                    <section class="border border-slate-200 dark:border-slate-700">
                        <div class="flex items-center gap-2 border-b border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800"><input data-group-name="${groupIndex}" value="${escapeHtml(group.name)}" placeholder="大群組名稱" maxlength="80" class="min-w-0 flex-1 border border-slate-300 bg-white px-3 py-2 text-sm font-bold dark:border-slate-600 dark:bg-slate-950"><button type="button" data-delete-group="${groupIndex}" class="border border-red-200 px-3 py-2 text-xs font-black text-red-600">刪除</button></div>
                        <div class="grid gap-1 p-3 sm:grid-cols-2 lg:grid-cols-3">${visibleProcesses.map(process => {
                            const owner = assigned.get(process);
                            const checked = owner === groupIndex;
                            const assignedElsewhere = owner !== undefined && owner !== groupIndex;
                            return `<label class="flex items-center gap-2 border px-2 py-2 text-xs ${checked ? 'border-sky-300 bg-sky-50 text-sky-800' : 'border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300'}"><input type="checkbox" data-group-process="${groupIndex}" data-process="${escapeHtml(process)}" ${checked ? 'checked' : ''}><span class="truncate">${escapeHtml(process)}</span>${assignedElsewhere ? '<span class="ml-auto text-[10px] text-slate-400">已分群</span>' : ''}</label>`;
                        }).join('')}</div>
                    </section>`).join('') || '<div class="border border-dashed border-slate-300 p-10 text-center text-sm font-bold text-slate-500">尚未建立大群組。</div>'}</div>
            </div>
            <footer class="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4 dark:border-slate-700"><button type="button" data-admin-close class="border border-slate-300 px-4 py-2 text-sm font-bold dark:border-slate-700">取消</button><button type="button" data-save-groups class="bg-emerald-600 px-5 py-2 text-sm font-black text-white disabled:opacity-50" ${adminState.saving ? 'disabled' : ''}>${adminState.saving ? '儲存中...' : '儲存設定'}</button></footer>
        </section>`;
    document.body.appendChild(modal);
    window.lucide?.createIcons();

    modal.querySelectorAll('[data-admin-close]').forEach(button => button.addEventListener('click', () => { adminState = null; renderProcessGroupAdmin(); }));
    modal.querySelector('[data-add-group]')?.addEventListener('click', () => {
        adminState.groups.push({ id: `group-${Date.now()}`, name: '', processes: [] });
        renderProcessGroupAdmin();
    });
    modal.querySelector('[data-process-search]')?.addEventListener('input', event => {
        adminState.query = event.target.value;
        const query = adminState.query.trim().toLowerCase();
        modal.querySelectorAll('[data-group-process]').forEach(input => {
            input.closest('label')?.classList.toggle('hidden', Boolean(query) && !String(input.dataset.process || '').toLowerCase().includes(query));
        });
    });
    modal.querySelectorAll('[data-group-name]').forEach(input => input.addEventListener('input', event => { adminState.groups[Number(input.dataset.groupName)].name = event.target.value; }));
    modal.querySelectorAll('[data-delete-group]').forEach(button => button.addEventListener('click', () => { adminState.groups.splice(Number(button.dataset.deleteGroup), 1); renderProcessGroupAdmin(); }));
    modal.querySelectorAll('[data-group-process]').forEach(input => input.addEventListener('change', () => {
        const groupIndex = Number(input.dataset.groupProcess);
        const process = input.dataset.process;
        adminState.groups.forEach(group => { group.processes = group.processes.filter(item => item !== process); });
        if (input.checked) adminState.groups[groupIndex].processes.push(process);
        renderProcessGroupAdmin();
    }));
    modal.querySelector('[data-save-groups]')?.addEventListener('click', saveProcessGroups);
};

const saveProcessGroups = async () => {
    const emptyName = adminState.groups.some(group => !String(group.name || '').trim());
    if (emptyName) {
        adminState.message = { success: false, text: '每個大群組都必須填寫名稱。' };
        renderProcessGroupAdmin();
        return;
    }
    adminState.saving = true;
    adminState.message = null;
    renderProcessGroupAdmin();
    try {
        const response = await fetch(apiUrl('/api/admin/process-groups'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groups: adminState.groups })
        });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || '製程大群組設定儲存失敗。');
        adminState.groups = normalizedGroups(result.data).map(group => ({ ...group, processes: [...group.processes] }));
        adminState.saving = false;
        adminState.message = { success: true, text: '製程大群組設定已儲存。' };
        await adminState.onSaved?.(result.data);
        renderProcessGroupAdmin();
    } catch (error) {
        adminState.saving = false;
        adminState.message = { success: false, text: error.message || '儲存失敗。' };
        renderProcessGroupAdmin();
    }
};

export const openProcessGroupAdmin = ({ rows, config, onSaved }) => {
    adminState = {
        processes: discoverSingleProcesses(rows),
        groups: normalizedGroups(config).map(group => ({ id: group.id, name: group.name, processes: [...(group.processes || [])] })),
        query: '', saving: false, message: null, onSaved
    };
    renderProcessGroupAdmin();
};
