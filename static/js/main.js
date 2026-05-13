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
    isUploading: false
};

// 初始主題檢查
if (state.isDarkMode) {
    document.documentElement.classList.add('dark');
}

// 資料快取
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

const injectLoadModeButton = (headerHtml) => {
    if (headerHtml.includes("displayMode', 'load'")) return headerHtml;

    return headerHtml.replace(
        /(<button onclick="window\.app\.updateState\('displayMode', 'height'\)"[\s\S]*?<\/button>)/,
        `$1${createLoadModeButton()}`
    );
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
        <section class="mx-2 md:mx-6 mt-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-sm p-4 transition-colors">
            <div class="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
                <div>
                    <div class="flex items-center gap-2">
                        <span class="inline-flex items-center rounded-full bg-blue-50 dark:bg-blue-900/40 px-2.5 py-1 text-xs font-black text-blue-700 dark:text-blue-300">ADMIN</span>
                        <h2 class="text-lg font-black text-slate-800 dark:text-slate-100">資料更新</h2>
                    </div>
                    <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                        上傳樓層面積資訊 Excel（.xlsx）後，系統會先備份上一版 data.json，再更新目前資料。
                    </p>
                </div>
                <form class="flex flex-col sm:flex-row gap-2 sm:items-center" onsubmit="window.app.uploadDataFile(event)">
                    <input id="admin-data-file" name="file" type="file" accept=".xlsx" class="block w-full sm:w-80 text-sm text-slate-500 dark:text-slate-300 file:mr-4 file:rounded-full file:border-0 file:bg-slate-800 file:px-4 file:py-2 file:text-sm file:font-bold file:text-white hover:file:bg-slate-700 dark:file:bg-blue-600 dark:hover:file:bg-blue-500" ${state.isUploading ? 'disabled' : ''}>
                    <button type="submit" class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-black text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60" ${state.isUploading ? 'disabled' : ''}>
                        ${state.isUploading ? '更新中...' : '上傳並更新'}
                    </button>
                </form>
            </div>
            ${statusHtml}
        </section>`;
};

const loadData = async () => {
    const res = await fetch('/api/data', { cache: 'no-store' });
    if (!res.ok) throw new Error("API Error");
    const rawData = await res.json();
    const result = processRawData(rawData);
    appData.source = rawData;
    appData.processed = result.processedData;
    appData.meta = result.buildingMeta;
    appData.sortedFloors = result.sortedFloorLabels;
};

// --- 更新畫面 ---
const render = () => {
    const scrollContainer = document.getElementById('matrix-scroll-container');
    let savedScrollLeft = 0;
    let savedScrollTop = 0;
    if (scrollContainer) {
        savedScrollLeft = scrollContainer.scrollLeft;
        savedScrollTop = scrollContainer.scrollTop;
    }

    const app = document.getElementById('app');

    // 計算總計邏輯
    const dataForTotal = state.includeUnfinished 
        ? appData.processed 
        : appData.processed.filter(d => d.status !== '未成廠');

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
        appData.processed.filter(d => d.building === bldg).forEach(d => presentFloors.add(d.floor));
    });
    const activeFloors = appData.sortedFloors.filter(f => presentFloors.has(f));

    const matrixData = state.displayMode === 'load'
        ? appData.processed.map(item => ({
            ...item,
            usageLabel: formatFloorLoadCell(item.floorLoad)
        }))
        : appData.processed;

    const dataMap = {};
    matrixData.forEach(item => { dataMap[`${item.building}-${item.floor}`] = item; });

    const headerHtml = injectLoadModeButton(renderHeader(state, allNames, totals, appData.processed));

    app.innerHTML = `
        ${headerHtml}
        ${renderAdminUploadPanel()}
        <main class="flex-1 p-2 md:p-6 overflow-hidden flex flex-col relative bg-slate-50 dark:bg-slate-950 transition-colors duration-300">
            ${renderMatrix(state, activeBuildings, activeFloors, matrixData, dataMap, appData.meta)} 
        </main>
        ${renderPanel(state, appData.meta, appData.processed)}
    `;

    lucide.createIcons();

    const newScrollContainer = document.getElementById('matrix-scroll-container');
    if (newScrollContainer) {
        newScrollContainer.scrollLeft = savedScrollLeft;
        newScrollContainer.scrollTop = savedScrollTop;
    }
};

// --- 公開方法 ---
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
        } else {
            if (state.filterBuildings.includes(bldg)) {
                state.filterBuildings = state.filterBuildings.filter(b => b !== bldg);
            } else {
                state.filterBuildings.push(bldg);
            }
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
            const res = await fetch('/api/admin/upload-data', {
                method: 'POST',
                body: formData
            });
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
            state.uploadStatus = {
                success: false,
                message: e.message || '資料更新失敗。'
            };
        } finally {
            state.isUploading = false;
            render();
        }
    }
};

// --- 初始化 ---
const init = async () => {
    try {
        const meRes = await fetch('/api/me', { cache: 'no-store' });
        if (meRes.ok) {
            state.currentUser = await meRes.json();
        }

        await loadData();
        
        if (window.innerWidth < 768) {
            const allBuildings = Object.keys(appData.meta);
            const target = "K18"; 
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