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
    includeUnfinished: false, // [補回]
    isDarkMode: localStorage.getItem('theme') === 'dark' // [補回] 從記憶讀取
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

    // 1. 取得所有廠棟名稱
    const allNames = Object.keys(appData.meta);
    const activeBuildings = state.filterBuildings.length > 0 ? state.filterBuildings : allNames;

    // 2. 動態篩選樓層
    const presentFloors = new Set();
    activeBuildings.forEach(bldg => {
        appData.processed.filter(d => d.building === bldg).forEach(d => presentFloors.add(d.floor));
    });
    const activeFloors = appData.sortedFloors.filter(f => presentFloors.has(f));

    // 3. 建立 Map 加速查找
    const dataMap = {};
    appData.processed.forEach(item => { dataMap[`${item.building}-${item.floor}`] = item; });

    // 4. 組合 HTML
    app.innerHTML = `
        ${renderHeader(state, allNames, totals, appData.processed)}
        <main class="flex-1 p-2 md:p-6 overflow-hidden flex flex-col relative bg-slate-50 dark:bg-slate-950 transition-colors duration-300">
            ${renderMatrix(state, activeBuildings, activeFloors, appData.processed, dataMap, appData.meta)} 
        </main>
        ${renderPanel(state, appData.meta, appData.processed)}
    `;

    lucide.createIcons();

    // 還原捲動
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
        // [關鍵修正] 補回深色模式的主題切換邏輯
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
    }
};

// --- 初始化 ---
const init = async () => {
    try {
        const res = await fetch('/api/data');
        if (!res.ok) throw new Error("API Error");
        const rawData = await res.json();
        
        const result = processRawData(rawData);
        appData.processed = result.processedData;
        appData.meta = result.buildingMeta;
        appData.sortedFloors = result.sortedFloorLabels;

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
        document.getElementById('app').innerHTML = `<div class="p-10 text-center text-red-500">載入失敗: ${e.message}</div>`;
    }
};

init();