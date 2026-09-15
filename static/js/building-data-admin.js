import { apiUrl } from './utils.js';

const BUILDING_FIELDS = [
    ['棟別', '棟別', 'text'],
    ['基地面積(M2)', '基地面積(M²)', 'number'],
    ['容積率', '容積率', 'number'],
    ['建蔽率', '建蔽率', 'number'],
    ['開挖深度(M)', '開挖深度(M)', 'number'],
    ['耐震係數(gal)', '耐震係數(gal)', 'number'],
    ['汽車停車位', '汽車停車位', 'number'],
    ['機車停車位', '機車停車位', 'number']
];

const FLOOR_FIELDS = [
    ['樓層', '樓層', 'text'],
    ['狀態', '狀態', 'status'],
    ['預計成廠年份', '預計成廠年份', 'text'],
    ['進駐製程', '進駐製程', 'text'],
    ['樓地板面積(M2)', '樓地板面積(M²)', 'number'],
    ['無塵室面積(M2)', '無塵室面積(M²)', 'number'],
    ['生產週邊(M2)', '生產週邊(M²)', 'number'],
    ['廠務設施面積(M2)', '廠務設施面積(M²)', 'facility'],
    ['公設(含其他)(公式)(M2)', '公設面積(M²)', 'number'],
    ['facility:純水', '純水(M²)', 'facilityDetail'],
    ['facility:廢水', '廢水(M²)', 'facilityDetail'],
    ['facility:給排水', '給排水(M²)', 'facilityDetail'],
    ['facility:空調', '空調(M²)', 'facilityDetail'],
    ['facility:抽氣', '抽氣(M²)', 'facilityDetail'],
    ['facility:氣體', '氣體(M²)', 'facilityDetail'],
    ['facility:電力', '電力(M²)', 'facilityDetail'],
    ['facility:弱電', '弱電(M²)', 'facilityDetail'],
    ['facility:消防', '消防(M²)', 'facilityDetail'],
    ['facility:監控', '監控(M²)', 'facilityDetail'],
    ['facility:其他', '監控/弱電/消防(M²)', 'facilityDetail'],
    ['樓層高度(cm)', '樓層高度（原始內容）', 'text'],
    ['無塵室淨高(cm)', '無塵室淨高（原始內容）', 'text'],
    ['樓層載重kgf/m2', '樓層載重(kgf/m²)', 'number']
];

const localDate = () => {
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60000;
    return new Date(now.getTime() - offset).toISOString().slice(0, 10);
};

const CHANGE_TYPE_LABELS = {
    ADD: '新增', ADJUST: '資料修正', EXPAND: '擴建', REDUCE: '面積減少', DEMOLISH: '拆除', IMPORT: 'Excel 匯入'
};

const editor = {
    open: false,
    loading: false,
    saving: false,
    tab: 'floors',
    data: [],
    revision: '',
    counts: { buildings: 0, floors: 0 },
    auditRecords: [],
    message: null,
    effectiveDate: localDate(),
    changeType: 'ADJUST',
    changeReason: '',
    sourceReference: ''
};

const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const makeId = (prefix) => {
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${id}`;
};

const getFacilityValue = (floor) => {
    const value = floor?.['廠務設施面積(M2)'];
    return typeof value === 'object' && value !== null ? Number(value.value || 0) : Number(value || 0);
};

const recalculateCounts = () => {
    editor.counts = {
        buildings: editor.data.length,
        floors: editor.data.reduce((sum, building) => sum + (building['樓層'] || []).length, 0)
    };
};

const inputClass = (wide = false) => `rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-sm text-slate-800 dark:text-slate-100 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-900 ${wide ? 'min-w-[180px]' : 'min-w-[120px]'}`;

const renderFieldInput = (kind, recordId, field, type, value, buildingId = '') => {
    const attrs = `data-editor-kind="${kind}" data-record-id="${escapeHtml(recordId)}" data-field="${escapeHtml(field)}" ${buildingId ? `data-building-id="${escapeHtml(buildingId)}"` : ''}`;
    if (type === 'status') {
        return `<select ${attrs} class="${inputClass()}">
            <option value="已成廠" ${value === '已成廠' ? 'selected' : ''}>已成廠</option>
            <option value="未成廠" ${value === '未成廠' ? 'selected' : ''}>未成廠</option>
        </select>`;
    }
    const numeric = ['number', 'facility', 'facilityDetail'].includes(type);
    return `<input ${attrs} type="${numeric ? 'number' : 'text'}" ${numeric ? 'step="0.01"' : ''} value="${escapeHtml(value)}" class="${inputClass(type === 'text')}">`;
};

const renderBuildingRows = () => editor.data.map((building) => `
    <tr class="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40">
        ${BUILDING_FIELDS.map(([field, , type]) => `<td class="px-2 py-2 align-top">${renderFieldInput('building', building._building_id, field, type, building[field] ?? '')}</td>`).join('')}
        <td class="sticky right-0 bg-white dark:bg-slate-900 px-2 py-2 text-right">
            <button type="button" data-delete-building="${escapeHtml(building._building_id)}" class="rounded-md border border-red-200 px-3 py-1.5 text-xs font-bold text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950">刪除</button>
        </td>
    </tr>`).join('');

const renderFloorRows = () => editor.data.flatMap((building) => (building['樓層'] || []).map((floor) => `
    <tr class="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40">
        <td class="sticky left-0 z-10 bg-white dark:bg-slate-900 px-2 py-2 align-top">
            <select data-editor-kind="floor" data-record-id="${escapeHtml(floor._floor_id)}" data-building-id="${escapeHtml(building._building_id)}" data-field="__building_id" class="${inputClass(true)}">
                ${editor.data.map(option => `<option value="${escapeHtml(option._building_id)}" ${option._building_id === building._building_id ? 'selected' : ''}>${escapeHtml(option['棟別'])}</option>`).join('')}
            </select>
        </td>
        ${FLOOR_FIELDS.map(([field, , type]) => {
            const value = type === 'facility'
                ? getFacilityValue(floor)
                : type === 'facilityDetail'
                    ? Number(floor?.['廠務設施面積(M2)']?.details?.[field.split(':')[1]] || 0)
                    : (floor[field] ?? '');
            return `<td class="px-2 py-2 align-top">${renderFieldInput('floor', floor._floor_id, field, type, value, building._building_id)}</td>`;
        }).join('')}
        <td class="sticky right-0 bg-white dark:bg-slate-900 px-2 py-2 text-right">
            <button type="button" data-delete-floor="${escapeHtml(floor._floor_id)}" data-building-id="${escapeHtml(building._building_id)}" class="rounded-md border border-red-200 px-3 py-1.5 text-xs font-bold text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950">刪除</button>
        </td>
    </tr>`)).join('');

const renderTable = () => {
    const isBuildings = editor.tab === 'buildings';
    const fields = isBuildings ? BUILDING_FIELDS : FLOOR_FIELDS;
    const emptyText = isBuildings ? '目前沒有建物資料。' : '目前沒有樓層資料。';
    const rows = isBuildings ? renderBuildingRows() : renderFloorRows();
    return `
        <div class="min-h-0 flex-1 overflow-auto border-y border-slate-200 dark:border-slate-800">
            <table class="min-w-max w-full border-collapse text-sm">
                <thead class="sticky top-0 z-20 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-200">
                    <tr>
                        ${isBuildings ? '' : '<th class="sticky left-0 z-30 bg-slate-100 dark:bg-slate-800 px-3 py-2 text-left">棟別</th>'}
                        ${fields.map(([, label]) => `<th class="px-3 py-2 text-left whitespace-nowrap">${escapeHtml(label)}</th>`).join('')}
                        <th class="sticky right-0 z-30 bg-slate-100 dark:bg-slate-800 px-3 py-2 text-right">操作</th>
                    </tr>
                </thead>
                <tbody class="bg-white dark:bg-slate-900">${rows || `<tr><td colspan="${fields.length + 2}" class="px-6 py-16 text-center text-slate-400">${emptyText}</td></tr>`}</tbody>
            </table>
        </div>`;
};

const renderAudit = () => {
    if (editor.tab !== 'audit') return '';
    const rows = editor.auditRecords.map(record => {
        const summary = record.summary || {};
        return `<tr class="border-b border-slate-100 dark:border-slate-800">
            <td class="px-3 py-2 whitespace-nowrap">${escapeHtml(record.effective_date || '-')}</td>
            <td class="px-3 py-2 whitespace-nowrap font-bold">${escapeHtml(CHANGE_TYPE_LABELS[record.change_type] || record.change_type || '-')}</td>
            <td class="px-3 py-2 font-bold">${escapeHtml(record.changed_by)}</td>
            <td class="px-3 py-2 min-w-[260px]">${escapeHtml(record.reason)}</td>
            <td class="px-3 py-2 whitespace-nowrap text-right font-mono ${Number(summary.area_delta_m2 || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}">${Number(summary.area_delta_m2 || 0).toLocaleString()} m²</td>
            <td class="px-3 py-2 whitespace-nowrap text-slate-500">建物 +${summary.buildings_added || 0} / -${summary.buildings_removed || 0}，樓層 +${summary.floors_added || 0} / -${summary.floors_removed || 0}，修改 ${summary.floors_updated || 0}</td>
        </tr>`;
    }).join('');
    return `<div class="min-h-0 flex-1 overflow-auto border-y border-slate-200 dark:border-slate-800">
        <table class="w-full text-sm"><thead class="sticky top-0 bg-slate-100 dark:bg-slate-800"><tr><th class="px-3 py-2 text-left">生效日期</th><th class="px-3 py-2 text-left">類型</th><th class="px-3 py-2 text-left">維護人員</th><th class="px-3 py-2 text-left">異動原因</th><th class="px-3 py-2 text-right">面積淨異動</th><th class="px-3 py-2 text-left">摘要</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="px-6 py-16 text-center text-slate-400">目前沒有平台維護紀錄。</td></tr>'}</tbody></table>
    </div>`;
};

const renderEditor = () => {
    document.getElementById('building-data-admin-modal')?.remove();
    if (!editor.open) return;

    const modal = document.createElement('div');
    modal.id = 'building-data-admin-modal';
    modal.className = 'fixed inset-0 z-[150] bg-slate-950/55 p-3 md:p-6';
    modal.innerHTML = `
        <section class="mx-auto flex h-full max-w-[1800px] flex-col overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-slate-900">
            <header class="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800 xl:flex-row xl:items-center xl:justify-between">
                <div>
                    <div class="flex items-center gap-3"><span class="rounded bg-slate-900 px-2 py-1 text-xs font-black text-white dark:bg-blue-600">ADMIN</span><h2 class="text-xl font-black text-slate-800 dark:text-white">建物面積資料維護</h2></div>
                    <p class="mt-1 text-sm text-slate-500">欄位排列延續原始 Excel；計算結果由平台依明細重新產生。</p>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                    <button type="button" data-export-mode="readable" class="rounded-md border border-slate-300 px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">匯出人員閱讀版</button>
                    <button type="button" data-export-mode="standard" class="rounded-md border border-slate-300 px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">匯出標準資料版</button>
                    <button type="button" id="building-data-admin-close" class="rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800">✕</button>
                </div>
            </header>

            ${editor.loading ? '<div class="flex flex-1 items-center justify-center text-slate-500">載入資料中...</div>' : `
                <div class="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                    <div class="flex items-center gap-2">
                        ${[['floors', '樓層面積'], ['buildings', '建物基本資料'], ['audit', '異動紀錄']].map(([key, label]) => `<button type="button" data-editor-tab="${key}" class="rounded-md px-3 py-2 text-sm font-black ${editor.tab === key ? 'bg-slate-800 text-white dark:bg-blue-600' : 'border border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-300'}">${label}</button>`).join('')}
                        <span class="ml-2 text-xs font-bold text-slate-400">${editor.counts.buildings} 棟・${editor.counts.floors} 層</span>
                    </div>
                    ${editor.tab === 'audit' ? '' : `<button type="button" id="building-data-add-row" class="rounded-md bg-blue-600 px-4 py-2 text-sm font-black text-white hover:bg-blue-700">${editor.tab === 'buildings' ? '新增建物' : '新增樓層'}</button>`}
                </div>
                ${editor.tab === 'audit' ? renderAudit() : renderTable()}
                <footer class="border-t border-slate-200 px-5 py-4 dark:border-slate-800">
                    ${editor.message ? `<div class="mb-3 rounded-md px-3 py-2 text-sm font-bold ${editor.message.success ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300'}">${escapeHtml(editor.message.text)}</div>` : ''}
                    <div class="grid grid-cols-1 gap-3 xl:grid-cols-[150px_160px_minmax(240px,1fr)_minmax(220px,1fr)_auto_auto] xl:items-end">
                        <label><span class="mb-1 block text-xs font-black text-slate-500">生效日期（必填）</span><input id="building-data-effective-date" type="date" value="${escapeHtml(editor.effectiveDate)}" class="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"></label>
                        <label><span class="mb-1 block text-xs font-black text-slate-500">異動類型（必填）</span><select id="building-data-change-type" class="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950">${[['ADD', '新增'], ['ADJUST', '資料修正'], ['EXPAND', '擴建'], ['REDUCE', '面積減少'], ['DEMOLISH', '拆除']].map(([value, label]) => `<option value="${value}" ${editor.changeType === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
                        <label><span class="mb-1 block text-xs font-black text-slate-500">本次異動原因（必填）</span><input id="building-data-change-reason" value="${escapeHtml(editor.changeReason)}" maxlength="500" placeholder="例如：依核准資料修正 K18 面積" class="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"></label>
                        <label><span class="mb-1 block text-xs font-black text-slate-500">資料來源／文件編號</span><input id="building-data-source-reference" value="${escapeHtml(editor.sourceReference)}" maxlength="500" placeholder="例如：FAC-2026-0915" class="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"></label>
                        <button type="button" id="building-data-reload" class="self-end rounded-md border border-slate-300 px-4 py-2 text-sm font-bold text-slate-600 dark:border-slate-700 dark:text-slate-200">重新載入</button>
                        <button type="button" id="building-data-save" ${editor.saving || editor.tab === 'audit' ? 'disabled' : ''} class="self-end rounded-md bg-emerald-600 px-5 py-2 text-sm font-black text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50">${editor.saving ? '儲存中...' : '儲存變更'}</button>
                    </div>
                </footer>`}
        </section>`;
    document.body.appendChild(modal);
    bindEditorEvents(modal);
};

const findBuilding = (id) => editor.data.find(building => building._building_id === id);

const findFloor = (buildingId, floorId) => findBuilding(buildingId)?.['樓層']?.find(floor => floor._floor_id === floorId);

const applyInputChange = (target) => {
    const kind = target.dataset.editorKind;
    const recordId = target.dataset.recordId;
    const field = target.dataset.field;
    const buildingId = target.dataset.buildingId;
    const value = target.type === 'number' ? Number(target.value || 0) : target.value;

    if (kind === 'building') {
        const building = findBuilding(recordId);
        if (building) building[field] = value;
        return;
    }

    if (kind !== 'floor') return;
    const floor = findFloor(buildingId, recordId);
    if (!floor) return;
    if (field === '__building_id') {
        if (value === buildingId) return;
        const source = findBuilding(buildingId);
        const destination = findBuilding(value);
        if (!source || !destination) return;
        source['樓層'] = source['樓層'].filter(item => item._floor_id !== recordId);
        destination['樓層'].push(floor);
        renderEditor();
    } else if (field === '廠務設施面積(M2)') {
        const current = floor[field];
        floor[field] = { value, details: typeof current === 'object' && current ? (current.details || {}) : {} };
    } else if (field.startsWith('facility:')) {
        const detailKey = field.slice('facility:'.length);
        const current = floor['廠務設施面積(M2)'];
        floor['廠務設施面積(M2)'] = {
            value: typeof current === 'object' && current ? Number(current.value || 0) : Number(current || 0),
            details: { ...(typeof current === 'object' && current ? (current.details || {}) : {}), [detailKey]: value }
        };
    } else {
        floor[field] = value;
    }
};

const addBuilding = () => {
    let index = editor.data.length + 1;
    let name = `新建物-${index}`;
    while (editor.data.some(item => item['棟別'] === name)) name = `新建物-${++index}`;
    editor.data.push({
        _building_id: makeId('BLD'), 棟別: name, '基地面積(M2)': 0, 容積率: 0, 建蔽率: 0,
        '開挖深度(M)': 0, '耐震係數(gal)': 0, 汽車停車位: 0, 機車停車位: 0, 樓層: []
    });
    recalculateCounts();
    renderEditor();
};

const addFloor = () => {
    if (!editor.data.length) addBuilding();
    const building = editor.data[0];
    let index = (building['樓層'] || []).length + 1;
    let floorName = `${index}F`;
    while (building['樓層'].some(item => item['樓層'] === floorName)) floorName = `${++index}F`;
    building['樓層'].push({
        _floor_id: makeId('FLR'), 樓層: floorName, 狀態: '已成廠', 預計成廠年份: '', 進駐製程: '',
        '樓地板面積(M2)': 0, '無塵室面積(M2)': 0, '生產週邊(M2)': 0,
        '廠務設施面積(M2)': { value: 0, details: {} }, '公設(含其他)(公式)(M2)': 0,
        '樓層高度(cm)': 0, '無塵室淨高(cm)': 0, '樓層載重kgf/m2': 0
    });
    recalculateCounts();
    renderEditor();
};

const loadEditorData = async () => {
    editor.loading = true;
    editor.message = null;
    renderEditor();
    try {
        const response = await fetch(apiUrl('/api/admin/building-data'), { cache: 'no-store' });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || '資料載入失敗。');
        editor.data = result.data || [];
        editor.revision = result.revision || '';
        editor.counts = result.counts || { buildings: 0, floors: 0 };
        editor.auditRecords = result.audit_records || [];
    } catch (error) {
        editor.message = { success: false, text: error.message || '資料載入失敗。' };
    } finally {
        editor.loading = false;
        renderEditor();
    }
};

const saveEditorData = async () => {
    const reason = editor.changeReason.trim();
    if (!reason) {
        editor.message = { success: false, text: '請填寫本次異動原因。' };
        renderEditor();
        return;
    }
    editor.saving = true;
    editor.message = null;
    renderEditor();
    try {
        const response = await fetch(apiUrl('/api/admin/building-data'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: editor.data,
                revision: editor.revision,
                reason,
                effective_date: editor.effectiveDate,
                change_type: editor.changeType,
                source_reference: editor.sourceReference.trim()
            })
        });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || '資料儲存失敗。');
        editor.data = result.data;
        editor.revision = result.revision;
        editor.counts = result.counts;
        editor.changeReason = '';
        editor.sourceReference = '';
        editor.message = { success: true, text: `${result.message} 上一版備份：${result.backup_file || '無'}` };
        window.dispatchEvent(new CustomEvent('building-data-saved'));
        await loadEditorData();
        editor.message = { success: true, text: '建物面積資料已更新，前台資料已同步重新載入。' };
    } catch (error) {
        editor.message = { success: false, text: error.message || '資料儲存失敗。' };
    } finally {
        editor.saving = false;
        renderEditor();
    }
};

function bindEditorEvents(modal) {
    modal.querySelector('#building-data-admin-close')?.addEventListener('click', () => {
        editor.open = false;
        renderEditor();
    });
    modal.querySelectorAll('[data-editor-tab]').forEach(button => button.addEventListener('click', () => {
        editor.tab = button.dataset.editorTab;
        editor.message = null;
        renderEditor();
    }));
    modal.querySelectorAll('[data-export-mode]').forEach(button => button.addEventListener('click', () => {
        window.location.assign(apiUrl(`/api/export-data/${button.dataset.exportMode}`));
    }));
    modal.querySelectorAll('[data-editor-kind]').forEach(input => input.addEventListener('change', () => applyInputChange(input)));
    modal.querySelector('#building-data-add-row')?.addEventListener('click', () => editor.tab === 'buildings' ? addBuilding() : addFloor());
    modal.querySelector('#building-data-reload')?.addEventListener('click', loadEditorData);
    modal.querySelector('#building-data-save')?.addEventListener('click', saveEditorData);
    modal.querySelector('#building-data-effective-date')?.addEventListener('input', event => { editor.effectiveDate = event.target.value; });
    modal.querySelector('#building-data-change-type')?.addEventListener('change', event => { editor.changeType = event.target.value; });
    modal.querySelector('#building-data-change-reason')?.addEventListener('input', event => { editor.changeReason = event.target.value; });
    modal.querySelector('#building-data-source-reference')?.addEventListener('input', event => { editor.sourceReference = event.target.value; });
    modal.querySelectorAll('[data-delete-building]').forEach(button => button.addEventListener('click', () => {
        const building = findBuilding(button.dataset.deleteBuilding);
        if (!building || !confirm(`確定刪除「${building['棟別']}」及其全部樓層資料？儲存前仍可重新載入復原。`)) return;
        editor.data = editor.data.filter(item => item._building_id !== building._building_id);
        recalculateCounts();
        renderEditor();
    }));
    modal.querySelectorAll('[data-delete-floor]').forEach(button => button.addEventListener('click', () => {
        const building = findBuilding(button.dataset.buildingId);
        const floor = findFloor(button.dataset.buildingId, button.dataset.deleteFloor);
        if (!building || !floor || !confirm(`確定刪除「${building['棟別']} / ${floor['樓層']}」？儲存前仍可重新載入復原。`)) return;
        building['樓層'] = building['樓層'].filter(item => item._floor_id !== floor._floor_id);
        recalculateCounts();
        renderEditor();
    }));
}

window.buildingDataAdmin = {
    open: () => {
        editor.open = true;
        editor.tab = 'floors';
        loadEditorData();
    },
    export: (mode) => window.location.assign(apiUrl(`/api/export-data/${mode}`))
};

document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && editor.open) {
        editor.open = false;
        renderEditor();
    }
});
