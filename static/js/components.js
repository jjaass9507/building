import { formatArea, formatPct, getCellStyle } from './utils.js';

// --- 全域樣式設定 (參數化維護) ---
const STYLE_CONFIG = {
    // [1] 廠棟排序清單
    BUILDING_ORDER: [
        'K18', 'K25', 'K24', 'K22', 'K21', 'K27', 'K27-P2', 'K3B(雙葉A)', 'K12B(雙葉B)', 'K18B', 
        'KL-office', 'KL-1 FAB', 'K19A(楠電)', 'K13B', 'K7', 'K12', 'K8', 'K9', 'K9B', 'K15', 
        'K5', 'K5II', 'K1', 'K2', 'K3', 'K4', 'K6', 'K6A', 'K6B', 'K6E', 'K10', 'K10A', 'K11', 
        'K11B(停車場)', 'K14A', 'K14B', 'K14C', 'K16', 'K17', 'K23', 'K26', 'M1'
    ],

    // [2] 尺寸與高度
    ROW_HEIGHT: "h-14",           
    HEADER_HEIGHT: "h-52",        
    
    // [3] 字體大小控制
    FONT_SIZE_FLOOR: "text-base", 
    FONT_SIZE_CELL: "text-sm",    
    FONT_SIZE_BAR: "text-[12px]", 
    HEADER_INFO_LABEL: "text-[11px]", 
    HEADER_INFO_VAL: "text-[13px]",   
    HEADER_INFO_TAG: "text-[10px]",
    BAR_DESC_LABEL: "text-[10px] font-bold text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-800 px-1 rounded-sm flex items-center justify-center [writing-mode:vertical-lr] py-1",

    // [4] 配色方案
    COLORS: {
        CLEAN: 'bg-sky-500 dark:bg-sky-600',
        PROD: 'bg-emerald-500 dark:bg-emerald-600',
        FAC: 'bg-amber-500 dark:bg-amber-600',
        PUB: 'bg-slate-400 dark:bg-slate-600',
        
        // ★ 高對比現代配色 (Visual Priority)
        SUB_FAC: {
            '純水': 'bg-blue-500 dark:bg-blue-500',          
            '廢水': 'bg-indigo-500 dark:bg-indigo-500',      
            '給排水': 'bg-cyan-500 dark:bg-cyan-500',        
            '空調': 'bg-teal-500 dark:bg-teal-500',          
            '抽氣': 'bg-lime-500 dark:bg-lime-500',          
            '氣體': 'bg-fuchsia-500 dark:bg-fuchsia-500',    
            '電力': 'bg-yellow-400 dark:bg-yellow-400',      
            '弱電': 'bg-violet-500 dark:bg-violet-500',      
            '消防': 'bg-rose-500 dark:bg-rose-500',          
            '監控': 'bg-orange-500 dark:bg-orange-500',      
            '其他': 'bg-gray-400 dark:bg-gray-500',          
            'DEFAULT': 'bg-pink-500 dark:bg-pink-500'
        }
    }          
};

// --- 內部輔助函式 ---

// ★ 修正：統一且安全的數值讀取
// 無論傳入的是數字、字串還是物件，永遠回傳正確的 Number
const getVal = (data) => {
    if (data === null || data === undefined) return 0;
    
    let val = 0;
    if (typeof data === 'object') {
        // 優先找 .value (新標準)，其次找 .val (舊相容)
        val = data.value !== undefined ? Number(data.value) : (data.val !== undefined ? Number(data.val) : 0);
    } else {
        val = Number(data);
    }
    // 最終防呆：如果是 NaN 就回傳 0
    return Number.isFinite(val) ? val : 0;
};

// ★ 獲取細項描述字串 (用於 Tooltip)
const getDetailsTooltip = (label, data, formattedVal) => {
    const details = (data && typeof data === 'object' && data.details) ? data.details : null;
    
    if (details && Object.keys(details).length > 0) {
        const detailsStr = Object.entries(details)
            .map(([k, v]) => `${k}: ${Math.round(v * 10) / 10}`)
            .join(', ');
        return `${label}: ${formattedVal} (${detailsStr})`;
    }
    return `${label}: ${formattedVal}`;
};

const formatRateToPct = (val) => (!val || val === 0) ? '-%' : `${Math.round(val * 100)}%`;

const sortBuildings = (names) => {
    const order = STYLE_CONFIG.BUILDING_ORDER;
    return [...names].sort((a, b) => {
        let idxA = order.indexOf(a), idxB = order.indexOf(b);
        const weightA = idxA === -1 ? 999 : idxA, weightB = idxB === -1 ? 999 : idxB;
        return weightA !== weightB ? weightA - weightB : a.localeCompare(b);
    });
};

const getLabelByState = (pct, val, type) => (pct < 12) ? '' : (type === 'pct' ? `${Math.round(pct)}%` : val);

// ===============================================
// 1. 生成單一格子內容 (Matrix Cell) - 強制重算版
// ===============================================
const getCellContent = (zone, state) => {
    if (!zone) return '';
    const { displayMode, barLabelType, unit } = state;
    const { COLORS } = STYLE_CONFIG;

    if (displayMode === 'area') {
        // ★ 關鍵修正：不信任 zone.facPct，改為現場重算
        // 使用 getVal 確保拿到正確數字
        const vTotalVal = getVal(zone.area);
        const vCleanVal = getVal(zone.cleanRoomArea);
        const vProdVal = getVal(zone.prodArea);
        const vFacVal = getVal(zone.facArea);
        const vPubVal = getVal(zone.pubArea);

        // 重新計算百分比 (分母為 0 則給 0)
        const pClean = vTotalVal > 0 ? Math.round((vCleanVal / vTotalVal) * 100) : 0;
        const pProd = vTotalVal > 0 ? Math.round((vProdVal / vTotalVal) * 100) : 0;
        const pFac  = vTotalVal > 0 ? Math.round((vFacVal / vTotalVal) * 100) : 0;
        const pPub  = vTotalVal > 0 ? Math.round((vPubVal / vTotalVal) * 100) : 0;

        // 格式化顯示文字
        const vClean = formatArea(vCleanVal, unit).val;
        const vProd = formatArea(vProdVal, unit).val;
        const vFac = formatArea(vFacVal, unit).val;
        const vPub = formatArea(vPubVal, unit).val;
        const vTotal = formatArea(vTotalVal, unit).val;

        // 產生 Tooltip
        const tooltipFac = getDetailsTooltip('廠務設施', zone.facArea, vFac);

        return `
            <div class="flex flex-col w-full h-full justify-center px-1 group">
                <div class="flex flex-col items-center mb-0.5"> 
                    <span class="font-mono font-bold ${STYLE_CONFIG.FONT_SIZE_CELL} text-slate-700 dark:text-slate-200 transition-colors">${vTotal}</span>
                </div>
                <div class="w-full h-5 flex bg-slate-100 dark:bg-slate-800 rounded-sm overflow-hidden text-[10px] font-bold text-white shadow-sm ring-1 ring-slate-200/50 dark:ring-slate-700">
                    ${pClean > 0 ? `<div class="${COLORS.CLEAN} flex items-center justify-center border-r border-white/10" style="width: ${pClean}%" title="無塵室: ${vClean}">${getLabelByState(pClean, vClean, barLabelType)}</div>` : ''}
                    ${pProd > 0 ? `<div class="${COLORS.PROD} flex items-center justify-center border-r border-white/10" style="width: ${pProd}%" title="生產週邊: ${vProd}">${getLabelByState(pProd, vProd, barLabelType)}</div>` : ''}
                    
                    ${pFac > 0 ? `<div class="${COLORS.FAC} flex items-center justify-center border-r border-white/10" style="width: ${pFac}%" title="${tooltipFac}">${getLabelByState(pFac, vFac, barLabelType)}</div>` : ''}
                    
                    ${pPub > 0 ? `<div class="${COLORS.PUB} flex items-center justify-center" style="width: ${pPub}%" title="公設: ${vPub}">${getLabelByState(pPub, vPub, barLabelType)}</div>` : ''}
                </div>
            </div>`;
    } else if (displayMode === 'height') {
        return `<div class="flex flex-col items-center justify-center h-full"><span class="font-mono font-bold text-lg text-slate-700 dark:text-slate-200">${zone.height}</span><span class="text-[10px] text-slate-400 font-bold">m</span></div>`;
    }
    return `<div class="flex items-center justify-center text-center px-2 w-full h-full"><span class="font-bold text-xs text-slate-700 dark:text-slate-300 line-clamp-2">${zone.usageLabel}</span></div>`;
};

// 2. 渲染 Header
export const renderHeader = (state, allBuildingNames, totals, processedData) => {
    // ... (維持原樣，不需要變動) ...
    const { unit, displayMode, barLabelType, filterBuildings, includeUnfinished, isDarkMode } = state;
    const { area, cleanRoom } = totals;
    const { COLORS } = STYLE_CONFIG;

    const buildingStatusMap = {}; 
    if (processedData) {
        processedData.forEach(d => {
            if (buildingStatusMap[d.building] !== 'unfinished') {
                buildingStatusMap[d.building] = (d.status === '未成廠') ? 'unfinished' : 'established';
            }
        });
    }

    const sortedAll = sortBuildings(allBuildingNames);
    const establishedBuildings = sortedAll.filter(name => buildingStatusMap[name] !== 'unfinished');
    const unfinishedBuildings = sortedAll.filter(name => buildingStatusMap[name] === 'unfinished');

    const btnClass = (isActive, type = 'normal') => {
        if (!isActive) return 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:border-slate-400';
        return type === 'unfinished' 
            ? 'bg-amber-500 text-white shadow-sm font-bold border-amber-500' 
            : 'bg-slate-700 dark:bg-blue-600 text-white shadow-sm font-bold border-slate-700 dark:border-blue-600';
    };

    const renderBuildingBtn = (b, type) => `
        <button onclick="window.app.toggleBuilding('${b}')" 
            class="px-3 py-1 text-[13px] font-bold rounded-full border transition-all whitespace-nowrap ${btnClass(filterBuildings.includes(b), type)}">
            ${b}
        </button>`;

    return `
        <header class="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-50 shadow-sm flex-none transition-colors">
            <div class="max-w-[1920px] mx-auto px-4 py-3">
                <div class="flex flex-col gap-3">
                    <div class="flex flex-col md:flex-row md:items-center justify-between gap-2">
                        <div class="flex items-center gap-3">
                            <div class="bg-slate-800 dark:bg-blue-600 p-1.5 rounded shrink-0 transition-colors">
                                <i data-lucide="building-2" class="text-white w-5 h-5"></i>
                            </div>
                            <h1 class="text-[24px] font-bold text-slate-800 dark:text-slate-100 tracking-tight mr-4">ASE建物管理平台</h1>
                            <div class="flex items-center gap-3 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 px-3 py-1 rounded-md shadow-sm">
                                <div class="flex items-baseline gap-1.5">
                                    <span class="text-[18px] font-bold text-slate-500 dark:text-slate-400">總樓地板:</span>
                                    <span class="font-mono text-[22px] font-black text-slate-800 dark:text-white">${area.val}</span>
                                    <span class="text-[18px] text-slate-400 dark:text-slate-500">${area.unit}</span>
                                </div>
                                <div class="w-px h-3 bg-slate-300 dark:bg-slate-700"></div>
                                <div class="flex items-baseline gap-1.5">
                                    <span class="text-[18px] font-bold text-slate-500 dark:text-slate-400">總無塵室:</span>
                                    <span class="font-mono text-[22px] font-black text-sky-600 dark:text-sky-400">${cleanRoom.val}</span>
                                    <span class="text-[18px] text-sky-400 dark:text-sky-500">${cleanRoom.unit}</span>
                                </div>
                                <label class="inline-flex items-center cursor-pointer group ml-2 border-l border-slate-200 dark:border-slate-700 pl-4">
                                    <div class="relative">
                                        <input type="checkbox" class="sr-only peer" ${includeUnfinished ? 'checked' : ''} onchange="window.app.updateState('includeUnfinished', this.checked)">
                                        <div class="w-9 h-5 bg-slate-200 dark:bg-slate-700 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-amber-500"></div>
                                    </div>
                                    <span class="ms-2 text-[16px] font-bold ${includeUnfinished ? 'text-amber-600' : 'text-slate-400 dark:text-slate-500'} uppercase tracking-wider transition-colors">包含未成廠</span>
                                </label>
                                <button onclick="window.app.updateState('isDarkMode', ${!isDarkMode})" class="ml-2 p-1.5 rounded-full hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors text-slate-500 dark:text-slate-400">
                                    <i data-lucide="${isDarkMode ? 'sun' : 'moon'}" class="w-5 h-5"></i>
                                </button>
                            </div>
                        </div>
                    </div>

                    <div class="h-px w-full bg-slate-100 dark:bg-slate-800"></div>

                    <div class="flex flex-col xl:flex-row gap-4 items-start">
                        <div class="flex flex-wrap items-center gap-2 shrink-0">
                            <div class="flex gap-0.5 bg-slate-100 dark:bg-slate-800 p-0.5 rounded-md">
                                <button onclick="window.app.updateState('unit', 'm2')" class="px-2 py-1 text-base rounded transition-all ${unit === 'm2' ? 'bg-slate-700 dark:bg-blue-600 text-white shadow-sm font-bold' : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'}">M²</button>
                                <button onclick="window.app.updateState('unit', 'ping')" class="px-2 py-1 text-base rounded transition-all ${unit === 'ping' ? 'bg-slate-700 dark:bg-blue-600 text-white shadow-sm font-bold' : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'}">坪</button>
                            </div>
                            <div class="flex gap-0.5 bg-slate-100 dark:bg-slate-800 p-0.5 rounded-md">
                                <button onclick="window.app.updateState('barLabelType', 'pct')" class="px-2 py-1 text-base rounded transition-all ${barLabelType === 'pct' ? 'bg-slate-700 dark:bg-blue-600 text-white shadow-sm font-bold' : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'}">比例</button>
                                <button onclick="window.app.updateState('barLabelType', 'val')" class="px-2 py-1 text-base rounded transition-all ${barLabelType === 'val' ? 'bg-slate-700 dark:bg-blue-600 text-white shadow-sm font-bold' : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'}">數值</button>
                            </div>
                            <div class="flex gap-0.5 bg-slate-100 dark:bg-slate-800 p-0.5 rounded-md">
                                <button onclick="window.app.updateState('displayMode', 'usage')" class="flex items-center gap-1 px-2 py-1 rounded text-base transition-all ${displayMode === 'usage' ? 'bg-slate-700 dark:bg-blue-600 text-white shadow-sm font-bold' : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'}"><i data-lucide="layout-grid" class="w-3 h-3"></i> 製程</button>
                                <button onclick="window.app.updateState('displayMode', 'area')" class="flex items-center gap-1 px-2 py-1 rounded text-base transition-all ${displayMode === 'area' ? 'bg-slate-700 dark:bg-blue-600 text-white shadow-sm font-bold' : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'}"><i data-lucide="maximize" class="w-3 h-3"></i> 面積</button>
                                <button onclick="window.app.updateState('displayMode', 'height')" class="flex items-center gap-1 px-2 py-1 rounded text-base transition-all ${displayMode === 'height' ? 'bg-slate-700 dark:bg-blue-600 text-white shadow-sm font-bold' : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'}"><i data-lucide="ruler" class="w-3 h-3"></i> 樓高</button>
                            </div>
                        </div>
                        
                        <div class="hidden xl:block w-px h-8 bg-slate-200 dark:bg-slate-700 shrink-0"></div>
                        
                        <div class="flex items-start gap-2 bg-slate-50 dark:bg-slate-800/50 p-2 rounded-lg border border-slate-100 dark:border-slate-800 w-full">
                            
                            <div class="flex items-center gap-2 shrink-0 mt-0.5">
                                <div class="flex items-center gap-1 text-base font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider px-1">
                                    <i data-lucide="filter" class="w-3.5 h-3.5"></i> 篩選
                                </div>
                                <button onclick="window.app.toggleBuilding('ALL')" 
                                    class="px-3 py-1 text-[14px] font-bold rounded-full border transition-all ${filterBuildings.length === 0 ? 'bg-slate-800 dark:bg-blue-600 text-white border-slate-800 dark:border-blue-600 shadow-sm' : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:border-slate-400'}">
                                    All
                                </button>
                                <div class="w-px h-6 bg-slate-300 dark:bg-slate-700 mx-1"></div>
                            </div>

                            <div class="flex flex-wrap gap-x-4 gap-y-2 w-full items-center">
                                <div class="flex items-center gap-1.5">
                                    <span class="text-[11px] font-bold text-slate-400 dark:text-slate-500 whitespace-nowrap">已成廠:</span>
                                    <div class="flex flex-wrap gap-1.5">
                                        ${establishedBuildings.map(b => renderBuildingBtn(b, 'established')).join('')}
                                    </div>
                                </div>

                                ${unfinishedBuildings.length > 0 ? `
                                <div class="flex items-center gap-1.5">
                                    <span class="text-[11px] font-bold text-amber-600 dark:text-amber-500 whitespace-nowrap">未成廠:</span>
                                    <div class="flex flex-wrap gap-1.5">
                                        ${unfinishedBuildings.map(b => renderBuildingBtn(b, 'unfinished')).join('')}
                                    </div>
                                </div>` : ''}
                            </div>
                        </div>
                    </div>

                    <div class="flex flex-wrap items-center gap-6 px-1 py-1 border-t border-slate-50 dark:border-slate-800 mt-1">
                        <div class="flex items-center gap-2 text-[14px] font-bold text-slate-500 dark:text-slate-400"><div class="w-3 h-3 rounded-full ${COLORS.CLEAN}"></div> 無塵室</div>
                        <div class="flex items-center gap-2 text-[14px] font-bold text-slate-500 dark:text-slate-400"><div class="w-3 h-3 rounded-full ${COLORS.PROD}"></div> 生產週邊</div>
                        <div class="flex items-center gap-2 text-[14px] font-bold text-slate-500 dark:text-slate-400"><div class="w-3 h-3 rounded-full ${COLORS.FAC}"></div> 廠務設施</div>
                        <div class="flex items-center gap-2 text-[14px] font-bold text-slate-500 dark:text-slate-400"><div class="w-3 h-3 rounded-full ${COLORS.PUB}"></div> 公設/其他</div>
                    </div>
                </div>
            </div>
        </header>`;
};

// 3. 渲染矩陣 (修正：統一屬性名稱 value, 解決 NaN 問題)
export const renderMatrix = (state, activeBuildings, activeFloors, processedData, dataMap, buildingMeta) => {
    const { ROW_HEIGHT, HEADER_HEIGHT, FONT_SIZE_FLOOR, COLORS, HEADER_INFO_LABEL, HEADER_INFO_VAL, HEADER_INFO_TAG, BAR_DESC_LABEL } = STYLE_CONFIG;
    const sortedActive = sortBuildings(activeBuildings);

    return `
        <div id="matrix-scroll-container" class="flex-1 overflow-auto bg-slate-50 dark:bg-slate-950 rounded-xl shadow-inner border border-slate-200 dark:border-slate-800 relative transition-colors">
            <div class="flex items-start min-w-max pb-16 justify-start">
                <div class="flex flex-col sticky left-0 z-40 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 shadow-lg">
                    <div class="${HEADER_HEIGHT} w-12 md:w-20 flex items-center justify-center font-bold text-slate-400 text-sm sticky top-0 z-50 bg-white dark:bg-slate-900 border-b-4 border-slate-700 dark:border-blue-600">樓層</div>
                    ${activeFloors.map(floorLabel => `<div class="${ROW_HEIGHT} w-12 md:w-20 flex items-center justify-center font-bold text-slate-700 dark:text-slate-200 ${FONT_SIZE_FLOOR} font-mono border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors bg-white dark:bg-slate-900">${floorLabel}</div>`).join('')}
                </div>
                ${sortedActive.map(bldg => {
                    const meta = buildingMeta[bldg]; 
                    const bZones = processedData.filter(d => d.building === bldg);
                    
                    // --- 1. 全棟匯總計算 ---
                    const bTotal = bZones.reduce((acc, curr) => acc + getVal(curr.area), 0);
                    const bC_Area = bZones.reduce((acc, c) => acc + getVal(c.cleanRoomArea), 0);
                    const bP_Area = bZones.reduce((acc, c) => acc + getVal(c.prodArea), 0);
                    const bU_Area = bZones.reduce((acc, c) => acc + getVal(c.pubArea), 0);
                    
                    // ★ 廠務全棟匯總
                    let bF_Area = 0;
                    let bF_Details = {};
                    
                    bZones.forEach(z => {
                        bF_Area += getVal(z.facArea); 
                        // 累加細項
                        if (z.facArea && typeof z.facArea === 'object' && z.facArea.details) {
                            Object.entries(z.facArea.details).forEach(([k, v]) => {
                                bF_Details[k] = (bF_Details[k] || 0) + v;
                            });
                        }
                    });

                    // --- 2. 生產樓層匯總計算 ---
                    const prodOnlyZones = bZones.filter(z => getVal(z.cleanRoomArea) > 0);
                    const pTotal = prodOnlyZones.reduce((acc, curr) => acc + getVal(curr.area), 0);
                    const pC_Area = prodOnlyZones.reduce((acc, c) => acc + getVal(c.cleanRoomArea), 0);
                    const pP_Area = prodOnlyZones.reduce((acc, c) => acc + getVal(c.prodArea), 0);
                    const pU_Area = prodOnlyZones.reduce((acc, c) => acc + getVal(c.pubArea), 0);
                    
                    // ★ 廠務生產區匯總
                    let pF_Area = 0;
                    let pF_Details = {};
                    
                    prodOnlyZones.forEach(z => {
                        pF_Area += getVal(z.facArea);
                        if (z.facArea && typeof z.facArea === 'object' && z.facArea.details) {
                            Object.entries(z.facArea.details).forEach(([k, v]) => {
                                pF_Details[k] = (pF_Details[k] || 0) + v;
                            });
                        }
                    });

                    // 內部函式：渲染文字
                    const renderBarContent = (pct, val) => {
                        // 降低顯示門檻，並確保 pct 是有效數字
                        if (isNaN(pct) || pct < 4) return ''; 
                        return `
                            <div class="flex flex-col items-center justify-center leading-tight py-0.5 text-white">
                                <span class="font-bold text-[11px]">${val}</span>
                                <span class="text-[9px] opacity-90 font-medium">${Math.round(pct)}%</span>
                            </div>`;
                    };

                    // ★ 內部函式：渲染進度條
                    const renderBar = (totalArea, clean, prod, facData, pub) => {
                        // 1. 解構 facData：這裡統一使用 .value，確保能抓到數值
                        // facData = { value: 100, details: {...} }
                        let facVal = 0;
                        if (facData && typeof facData === 'object') {
                            facVal = Number(facData.value || 0); // 關鍵修正：只讀 value
                        } else {
                            facVal = Number(facData) || 0;
                        }

                        // 2. 準備 Tooltip
                        const facDetails = (facData && typeof facData === 'object' && facData.details) ? facData.details : null;
                        const facTooltip = getDetailsTooltip('廠務設施', { details: facDetails }, formatArea(facVal, state.unit).val);

                        // 3. 計算百分比 (分母防呆)
                        const safeTotal = totalArea || 1; // 避免除以 0
                        const pc = totalArea > 0 ? (clean / safeTotal) * 100 : 0;
                        const pp = totalArea > 0 ? (prod / safeTotal) * 100 : 0;
                        const pf = totalArea > 0 ? (facVal / safeTotal) * 100 : 0;
                        const pb = totalArea > 0 ? (pub / safeTotal) * 100 : 0;
                        
                        // 4. 格式化顯示數值
                        const vc = formatArea(clean, state.unit).val;
                        const vp = formatArea(prod, state.unit).val;
                        const vf = formatArea(facVal, state.unit).val;
                        const vu = formatArea(pub, state.unit).val;

                        return `
                        <div class="flex-1 h-8 flex rounded-sm overflow-hidden bg-slate-100 dark:bg-slate-700 shadow-inner ring-1 ring-slate-200 dark:ring-slate-700">
                            ${pc > 0 ? `<div class="${COLORS.CLEAN} flex items-center justify-center border-r border-white/10" style="width: ${pc}%" title="無塵室: ${vc}">${renderBarContent(pc, vc)}</div>` : ''}
                            ${pp > 0 ? `<div class="${COLORS.PROD} flex items-center justify-center border-r border-white/10" style="width: ${pp}%" title="生產週邊: ${vp}">${renderBarContent(pp, vp)}</div>` : ''}
                            
                            ${pf > 0 ? `<div class="${COLORS.FAC} flex items-center justify-center border-r border-white/10" style="width: ${pf}%" title="${facTooltip}">${renderBarContent(pf, vf)}</div>` : ''}
                            
                            ${pb > 0 ? `<div class="${COLORS.PUB} flex items-center justify-center" style="width: ${pb}%" title="公設: ${vu}">${renderBarContent(pb, vu)}</div>` : ''}
                        </div>`;
                    };

                    return `
                    <div class="flex flex-col">
                        <div onclick="window.app.selectBuilding('${bldg}')" class="flex flex-col justify-between items-center ${HEADER_HEIGHT} text-center border-b-4 border-slate-700 dark:border-blue-600 sticky top-0 z-30 w-[40vw] md:w-72 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors bg-white dark:bg-slate-900 border-r border-slate-100 dark:border-slate-800 pt-1 pb-1 shadow-sm">
                            <div class="flex items-center gap-1.5 text-lg md:text-2xl font-black text-slate-800 dark:text-slate-100">${bldg} <i data-lucide="info" class="w-3.5 h-3.5 text-slate-400"></i></div>
                            <div class="flex flex-col gap-1 w-full px-2">
                                <div class="flex justify-between items-center px-2 py-0.5 bg-slate-50 dark:bg-slate-800 rounded border border-slate-100 dark:border-slate-700">
                                    <span class="${HEADER_INFO_LABEL} font-bold text-slate-700 dark:text-slate-400">基地面積</span>
                                    <div class="flex items-baseline gap-1">
                                        <span class="font-bold ${HEADER_INFO_VAL} text-slate-700 dark:text-slate-200">${formatArea(meta.baseArea, state.unit).val}</span>
                                        <span class="text-[10px] text-slate-400">${state.unit === 'ping' ? '坪' : 'M²'}</span>
                                        <span class="ml-1 ${HEADER_INFO_TAG} font-bold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 px-1 rounded border border-blue-100 dark:border-blue-800">建蔽 ${formatRateToPct(meta.coverageRate)}</span>
                                    </div>
                                </div>
                                <div class="flex justify-between items-center px-2 py-0.5 bg-slate-50 dark:bg-slate-800 rounded border border-slate-100 dark:border-slate-700">
                                    <span class="${HEADER_INFO_LABEL} font-bold text-slate-700 dark:text-slate-400">總樓地板</span>
                                    <div class="flex items-baseline gap-1">
                                        <span class="font-bold ${HEADER_INFO_VAL} text-slate-700 dark:text-slate-200">${formatArea(bTotal, state.unit).val}</span>
                                        <span class="text-[10px] text-slate-400">${state.unit === 'ping' ? '坪' : 'M²'}</span>
                                        <span class="ml-1 ${HEADER_INFO_TAG} font-bold text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/30 px-1 rounded border border-orange-100 dark:border-orange-800">容積 ${formatRateToPct(meta.capacityRate)}</span>
                                    </div>
                                </div>
                            </div>
                            <div class="flex flex-col gap-1 w-[94%] mt-1 mb-1">
                                <div class="flex gap-1 items-stretch"><div class="${BAR_DESC_LABEL}">全棟</div>${renderBar(bTotal, bC_Area, bP_Area, {value: bF_Area, details: bF_Details}, bU_Area)}</div>
                                <div class="flex gap-1 items-stretch"><div class="${BAR_DESC_LABEL}">生產</div>${renderBar(pTotal, pC_Area, pP_Area, {value: pF_Area, details: pF_Details}, pU_Area)}</div>
                            </div>
                        </div>
                        ${activeFloors.map(floor => {
                            const zoneData = dataMap[`${bldg}-${floor}`];
                            const commonClasses = `${ROW_HEIGHT} w-[40vw] md:w-72 relative border-r border-b border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900`;
                            if (!zoneData) return `<div class="${commonClasses} bg-slate-50/50 dark:bg-slate-800/30 diagonal-stripes opacity-60"></div>`;
                            const isSelected = state.selectedZone && state.selectedZone.id === zoneData.id;
                            return `<div class="${commonClasses} ${isSelected ? 'z-20' : 'z-0'}"><div onclick="window.app.selectZone('${zoneData.id}')" class="w-full h-full px-1 py-1 cursor-pointer transition-all duration-200 ${isSelected ? 'bg-blue-50/80 dark:bg-blue-900/30 ring-2 ring-blue-500 ring-inset' : 'hover:bg-slate-50 dark:hover:bg-slate-800'}">${getCellContent(zoneData, state)}</div></div>`;
                        }).join('')}
                    </div>`;
                }).join('')}
            </div>
        </div>`;
};

// 3b. 渲染面積比較表 (廠棟總覽，可展開至樓層明細)
export const renderCompareTable = (state, activeBuildings, processedData, buildingMeta, sortedFloors) => {
    const { unit, compareMode, compareExpanded } = state;
    const { COLORS } = STYLE_CONFIG;
    const sortedActive = sortBuildings(activeBuildings);
    const isAllFloor = (floor) => String(floor || '').toUpperCase().trim() === 'ALL';
    const unitLabel = unit === 'ping' ? '坪' : 'm²';

    const sumFor = (zones, key) => zones.reduce((acc, z) => acc + getVal(z[key]), 0);

    const metricCell = (value, totalArea, cls) => {
        if (compareMode === 'pct') {
            const pct = totalArea > 0 ? Math.round((value / totalArea) * 100) : 0;
            return `<span class="font-mono ${cls}">${pct}%</span>`;
        }
        return `<span class="font-mono ${cls}">${formatArea(value, unit).val}</span>`;
    };

    const renderRow = (label, zones, { baseArea = null, indent = 0, expandable = false, expanded = false, onToggle = '', emphasize = false } = {}) => {
        const totalArea = sumFor(zones, 'area');
        const rowBg = indent > 0
            ? 'bg-slate-50/70 dark:bg-slate-800/30'
            : 'bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800/60';
        const labelCls = emphasize
            ? 'font-black text-slate-800 dark:text-slate-100'
            : indent > 0
                ? 'font-medium text-slate-500 dark:text-slate-400'
                : 'font-bold text-slate-700 dark:text-slate-200';

        return `
            <tr class="${rowBg} border-b border-slate-100 dark:border-slate-800 transition-colors">
                <td class="px-4 py-2.5">
                    <div class="flex items-center gap-1.5" style="padding-left: ${indent * 1.75}rem">
                        ${expandable
                            ? `<button onclick="${onToggle}" class="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors shrink-0"><i data-lucide="${expanded ? 'chevron-down' : 'chevron-right'}" class="w-4 h-4 text-slate-400"></i></button>`
                            : `<span class="w-5 shrink-0 inline-block"></span>`}
                        <span class="${labelCls}">${label}</span>
                    </div>
                </td>
                <td class="px-4 py-2.5 text-right font-mono text-slate-500 dark:text-slate-400">${baseArea !== null ? formatArea(baseArea, unit).val : '-'}</td>
                <td class="px-4 py-2.5 text-right font-mono ${emphasize ? 'font-black text-slate-800 dark:text-white' : 'font-bold text-slate-700 dark:text-slate-200'}">${formatArea(totalArea, unit).val}</td>
                <td class="px-4 py-2.5 text-right">${metricCell(sumFor(zones, 'cleanRoomArea'), totalArea, 'text-slate-700 dark:text-slate-200')}</td>
                <td class="px-4 py-2.5 text-right">${metricCell(sumFor(zones, 'prodArea'), totalArea, 'text-slate-700 dark:text-slate-200')}</td>
                <td class="px-4 py-2.5 text-right">${metricCell(sumFor(zones, 'facArea'), totalArea, 'text-slate-700 dark:text-slate-200')}</td>
                <td class="px-4 py-2.5 text-right">${metricCell(sumFor(zones, 'pubArea'), totalArea, 'text-slate-700 dark:text-slate-200')}</td>
            </tr>`;
    };

    const allZones = processedData.filter(d => sortedActive.includes(d.building));
    const totalBaseArea = sortedActive.reduce((acc, b) => acc + Number(buildingMeta[b]?.baseArea || 0), 0);

    const summaryRow = renderRow('全廠棟', allZones, { baseArea: totalBaseArea, emphasize: true });

    const buildingRows = sortedActive.map(bldg => {
        const meta = buildingMeta[bldg] || {};
        const bZones = allZones.filter(d => d.building === bldg);
        const isExpanded = compareExpanded.includes(bldg);
        const bRow = renderRow(bldg, bZones, {
            baseArea: meta.baseArea,
            indent: 1,
            expandable: true,
            expanded: isExpanded,
            onToggle: `window.app.toggleCompareExpand('${bldg}')`
        });

        if (!isExpanded) return bRow;

        const buildingFloors = (sortedFloors || []).filter(f => !isAllFloor(f) && bZones.some(z => z.floor === f));
        const floorRows = buildingFloors.map(floor => {
            const fZones = bZones.filter(z => z.floor === floor);
            return renderRow(floor, fZones, { indent: 2 });
        }).join('');

        return bRow + floorRows;
    }).join('');

    return `
        <div class="flex-1 overflow-auto bg-slate-50 dark:bg-slate-950 rounded-xl shadow-inner border border-slate-200 dark:border-slate-800 transition-colors flex flex-col">
            <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 sticky top-0 z-20">
                <div class="flex items-center gap-3">
                    <div class="flex items-center gap-2 text-sm font-black text-slate-700 dark:text-slate-200">
                        <i data-lucide="table-2" class="w-4 h-4 text-slate-400"></i> 面積比較表
                    </div>
                    <span class="text-xs font-bold text-slate-400">單位：${unitLabel}｜點擊廠棟列可展開樓層明細</span>
                </div>
                <div class="flex gap-0.5 bg-slate-100 dark:bg-slate-800 p-0.5 rounded-md">
                    <button onclick="window.app.updateState('compareMode', 'value')" class="px-3 py-1 text-sm rounded transition-all ${compareMode !== 'pct' ? 'bg-slate-700 dark:bg-blue-600 text-white shadow-sm font-bold' : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700'}">實際數值</button>
                    <button onclick="window.app.updateState('compareMode', 'pct')" class="px-3 py-1 text-sm rounded transition-all ${compareMode === 'pct' ? 'bg-slate-700 dark:bg-blue-600 text-white shadow-sm font-bold' : 'bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700'}">佔比</button>
                </div>
            </div>
            <div class="overflow-auto flex-1">
                <table class="w-full text-sm">
                    <thead class="bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-300 sticky top-0 z-10">
                        <tr>
                            <th class="px-4 py-3 text-left text-xs font-black uppercase tracking-wider">廠棟 / 樓層</th>
                            <th class="px-4 py-3 text-right text-xs font-black uppercase tracking-wider">基地面積</th>
                            <th class="px-4 py-3 text-right text-xs font-black uppercase tracking-wider">樓地板面積</th>
                            <th class="px-4 py-3 text-right text-xs font-black uppercase tracking-wider"><span class="inline-flex items-center gap-1.5"><span class="w-2 h-2 rounded-full ${COLORS.CLEAN}"></span>無塵室面積</span></th>
                            <th class="px-4 py-3 text-right text-xs font-black uppercase tracking-wider"><span class="inline-flex items-center gap-1.5"><span class="w-2 h-2 rounded-full ${COLORS.PROD}"></span>生產周邊</span></th>
                            <th class="px-4 py-3 text-right text-xs font-black uppercase tracking-wider"><span class="inline-flex items-center gap-1.5"><span class="w-2 h-2 rounded-full ${COLORS.FAC}"></span>廠務設施面積</span></th>
                            <th class="px-4 py-3 text-right text-xs font-black uppercase tracking-wider"><span class="inline-flex items-center gap-1.5"><span class="w-2 h-2 rounded-full ${COLORS.PUB}"></span>公設(含其他)</span></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${summaryRow}
                        ${buildingRows}
                    </tbody>
                </table>
            </div>
        </div>`;
};

// 4. 渲染詳情面板
export const renderPanel = (state, buildingMeta, processedData) => {
    const { selectedBuilding, selectedZone, unit } = state;
    const { COLORS } = STYLE_CONFIG;

    // ★ 內部輔助：渲染子系統堆疊條
    const renderSubBar = (totalVal, details) => {
        if (!details || Object.keys(details).length === 0 || totalVal <= 0) return '';
        
        // 計算各子項目的佔比與 HTML
        const barsHtml = Object.entries(details).map(([k, v]) => {
            // ★ 防呆：避免除以 0 或 NaN
            const safeTotal = totalVal || 1;
            const pct = (v / safeTotal) * 100;
            const colorClass = COLORS.SUB_FAC[k] || COLORS.SUB_FAC.DEFAULT;
            const valStr = formatArea(v, unit).val;
            
            // 只有寬度 > 0 且非 NaN 才渲染
            if (pct <= 0 || isNaN(pct)) return '';
            
            return `
                <div class="${colorClass} flex items-center justify-center border-r border-white/10 first:rounded-l-sm last:rounded-r-sm last:border-0 transition-all hover:brightness-110 relative group" 
                     style="width: ${pct}%">
                    <div class="opacity-0 group-hover:opacity-100 transition-opacity absolute bottom-full mb-1 bg-slate-800 text-white text-[10px] px-2 py-1 rounded whitespace-nowrap z-10 pointer-events-none">
                        ${k}: ${valStr} (${Math.round(pct)}%)
                    </div>
                </div>`;
        }).join('');

        // 渲染圖例 (Legend)
        const legendsHtml = Object.entries(details).map(([k, v]) => {
            const colorClass = COLORS.SUB_FAC[k] || COLORS.SUB_FAC.DEFAULT;
            const valStr = formatArea(v, unit).val;
            const safeTotal = totalVal || 1;
            const pct = Math.round((v / safeTotal) * 100);
            
            return `
                <div class="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                    <div class="w-2 h-2 rounded-full ${colorClass}"></div>
                    <span>${k}</span>
                    <span class="font-mono font-bold text-slate-800 dark:text-slate-200">${valStr}</span>
                    <span class="text-[10px] text-slate-400">(${isNaN(pct) ? 0 : pct}%)</span>
                </div>`;
        }).join('');

        return `
            <div class="mt-2 pl-3 border-l-2 border-slate-200 dark:border-slate-700 ml-1">
                <div class="h-2 flex w-full bg-slate-100 dark:bg-slate-700 rounded-sm overflow-visible mb-2 ring-1 ring-slate-200 dark:ring-slate-600">
                    ${barsHtml}
                </div>
                <div class="flex flex-wrap gap-x-4 gap-y-1">
                    ${legendsHtml}
                </div>
            </div>
        `;
    };

    const renderProgress = (label, color, fmt, pctNum, detailsObj = null, rawTotalValue = 0) => {
        return `
        <div>
            <div class="flex justify-between text-sm mb-1.5">
                <span class="text-slate-600 dark:text-slate-400 flex items-center gap-2 font-medium">
                    <div class="w-2.5 h-2.5 rounded-full ${color} ring-2 ring-white dark:ring-slate-800 shadow-sm"></div>${label}
                </span> 
                <span class="font-bold text-slate-800 dark:text-slate-200 font-mono text-base">${fmt.val} <span class="text-xs text-slate-400 font-medium">(${isNaN(pctNum) ? 0 : Math.round(pctNum*100)}%)</span></span>
            </div>
            
            <div class="h-2.5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden shadow-inner">
                <div class="h-full ${color} transition-all duration-700 ease-out" style="width: ${isNaN(pctNum) ? 0 : pctNum*100}%"></div>
            </div>

            ${ renderSubBar(rawTotalValue, detailsObj) }
        </div>`;
    };

    // --- 渲染內容邏輯 (Building / Zone) ---

    if (selectedBuilding) {
        const meta = buildingMeta[selectedBuilding];
        const bZones = processedData.filter(d => d.building === selectedBuilding);
        
        // 加總計算 (記得使用 getVal)
        const bT = bZones.reduce((acc, curr) => acc + getVal(curr.area), 0);
        const bC = bZones.reduce((acc, c) => acc + getVal(c.cleanRoomArea), 0);
        const bP = bZones.reduce((acc, c) => acc + getVal(c.prodArea), 0);
        const bU = bZones.reduce((acc, c) => acc + getVal(c.pubArea), 0);
        
        // 廠務設施加總 (含細項)
        let bF = 0;
        const bF_Details = {}; 
        bZones.forEach(c => {
            const rawFac = c.facArea; 
            bF += getVal(rawFac);     

            if (typeof rawFac === 'object' && rawFac.details) {
                Object.entries(rawFac.details).forEach(([key, val]) => {
                    bF_Details[key] = (bF_Details[key] || 0) + val;
                });
            }
        });

        // 避免除以 0
        const safeTotal = bT || 1;

        return `
            <div class="fixed inset-y-0 right-0 w-full md:w-[480px] bg-white/95 dark:bg-slate-900/95 backdrop-blur shadow-2xl z-50 transform border-l border-slate-200 dark:border-slate-800 flex flex-col slide-in-right transition-colors">
                <div class="p-8 bg-gradient-to-br from-slate-800 to-slate-900 text-white relative overflow-hidden">
                    <div class="flex justify-between items-start mb-6 relative z-10">
                        <div class="flex items-center gap-2 text-xs font-bold bg-white/20 px-3 py-1.5 rounded-full backdrop-blur-sm border border-white/10"><i data-lucide="factory" class="w-3.5 h-3.5"></i> 廠棟概況</div>
                        <button onclick="window.app.closePanel()" class="p-1.5 hover:bg-white/20 rounded-full transition-colors"><i data-lucide="x" class="w-6 h-6"></i></button>
                    </div>
                    <h2 class="text-4xl font-extrabold mt-2 tracking-tight relative z-10">${selectedBuilding}</h2>
                </div>
                <div class="flex-1 overflow-y-auto p-8 bg-slate-50 dark:bg-slate-900 space-y-8">
                    <div class="grid grid-cols-2 gap-5">
                        <div class="bg-white dark:bg-slate-800 p-5 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm"><div class="text-xs font-bold text-slate-400 mb-2 uppercase tracking-wider">基地面積</div><div class="text-2xl font-bold text-slate-800 dark:text-white font-mono">${formatArea(meta.baseArea, unit).val} <span class="text-sm font-medium text-slate-500">${unit === 'ping' ? '坪' : 'M²'}</span></div></div>
                        <div class="bg-white dark:bg-slate-800 p-5 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm"><div class="text-xs font-bold text-slate-400 mb-2 uppercase tracking-wider">總樓地板</div><div class="text-2xl font-bold text-slate-800 dark:text-white font-mono">${formatArea(bT, unit).val} <span class="text-sm font-medium text-slate-500">${unit === 'ping' ? '坪' : 'M²'}</span></div></div>
                    </div>
                    <div><h3 class="text-sm font-bold text-slate-900 dark:text-slate-100 mb-5 flex items-center gap-2"><i data-lucide="pie-chart" class="w-4 h-4 text-blue-500"></i> 全棟佔比分析</h3>
                        <div class="space-y-6 bg-white dark:bg-slate-800 p-6 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm">
                            ${renderProgress('無塵室', COLORS.CLEAN, formatArea(bC, unit), bC/safeTotal)}
                            ${renderProgress('生產週邊', COLORS.PROD, formatArea(bP, unit), bP/safeTotal)}
                            ${renderProgress('廠務設施', COLORS.FAC, formatArea(bF, unit), bF/safeTotal, bF_Details, bF)} 
                            ${renderProgress('公設(含其他)', COLORS.PUB, formatArea(bU, unit), bU/safeTotal)}
                        </div>
                    </div>
                    <div class="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden shadow-sm">
                        <div class="px-6 py-4 border-b border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 flex items-center gap-2"><i data-lucide="clipboard-list" class="w-4 h-4 text-slate-400"></i><h3 class="font-bold text-slate-800 dark:text-slate-100 text-sm">建築技術指標</h3></div>
                        <div class="divide-y divide-slate-100 dark:divide-slate-700 text-sm">
                            <div class="p-4 flex justify-between hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"><span class="text-slate-500 dark:text-slate-400 font-medium">容積率</span><span class="font-bold text-slate-800 dark:text-white font-mono text-lg">${formatRateToPct(meta.capacityRate)}</span></div>
                            <div class="p-4 flex justify-between hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"><span class="text-slate-500 dark:text-slate-400 font-medium">建蔽率</span><span class="font-bold text-slate-800 dark:text-white font-mono text-lg">${formatRateToPct(meta.coverageRate)}</span></div>
                            <div class="p-4 flex justify-between hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"><span class="text-slate-500 dark:text-slate-400 font-medium">開挖深度</span><span class="font-bold text-slate-800 dark:text-white font-mono">${meta.digDepth} M</span></div>
                        </div>
                    </div>
                </div>
            </div><div onclick="window.app.closePanel()" class="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm transition-opacity"></div>`;
    }

    if (selectedZone) {
        const z = selectedZone;
        const facDetails = (typeof z.facArea === 'object' && z.facArea.details) ? z.facArea.details : null;
        const facVal = getVal(z.facArea);

        // ★ 重新計算總面積，防止 z.area 為 0 或失效
        const safeTotal = getVal(z.area) || 1;

        const statusBadge = z.status === '未成廠' 
            ? `<span class="bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800 px-3 py-1 rounded-full text-xs font-bold">未成廠</span>` 
            : `<span class="bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 px-3 py-1 rounded-full text-xs font-bold">已成廠</span>`;
        
        return `
            <div class="fixed inset-y-0 right-0 w-full md:w-[480px] bg-white/95 dark:bg-slate-900/95 backdrop-blur shadow-2xl z-50 transform border-l border-slate-200 dark:border-slate-800 flex flex-col slide-in-right transition-colors">
                <div class="p-8 border-b border-slate-100 dark:border-slate-800 relative bg-white dark:bg-slate-900">
                    <div class="flex justify-between items-start mb-6"><div class="flex items-center gap-2 text-xs font-bold text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 px-3 py-1.5 rounded-full border border-slate-200 dark:border-slate-700"><i data-lucide="building-2" class="w-3.5 h-3.5"></i> ${z.building}</div><button onclick="window.app.closePanel()" class="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition-colors"><i data-lucide="x" class="w-6 h-6"></i></button></div>
                    <div class="flex flex-col gap-4"><h2 class="text-3xl font-black text-slate-800 dark:text-white tracking-tight">${z.floor} - ${z.usageLabel}</h2><div class="flex items-center gap-3">${statusBadge}<span class="text-xs font-medium text-slate-400 bg-slate-50 dark:bg-slate-800 px-2.5 py-1 rounded border border-slate-100 dark:border-slate-700">樓高 <span class="font-mono text-slate-700 dark:text-slate-200 font-bold">${z.height}</span> m</span></div></div>
                </div>
                <div class="flex-1 overflow-y-auto p-8 bg-slate-50/50 dark:bg-slate-900/50 space-y-6">
                    <div><h3 class="text-sm font-bold text-slate-900 dark:text-slate-100 mb-5 flex items-center gap-2"><i data-lucide="pie-chart" class="w-4 h-4 text-blue-500"></i> 空間分析</h3>
                    <div class="space-y-6 bg-white dark:bg-slate-800 p-6 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm">
                        ${renderProgress('無塵室', COLORS.CLEAN, formatArea(getVal(z.cleanRoomArea), unit), getVal(z.cleanRoomArea)/safeTotal)}
                        ${renderProgress('生產週邊', COLORS.PROD, formatArea(getVal(z.prodArea), unit), getVal(z.prodArea)/safeTotal)}
                        ${renderProgress('廠務設施', COLORS.FAC, formatArea(facVal, unit), facVal/safeTotal, facDetails, facVal)}
                        ${renderProgress('公設(含其他)', COLORS.PUB, formatArea(getVal(z.pubArea), unit), getVal(z.pubArea)/safeTotal)}
                    </div></div>
                    <div><h3 class="text-sm font-bold text-slate-900 dark:text-slate-100 mb-5 flex items-center gap-2"><i data-lucide="ruler" class="w-4 h-4 text-purple-500"></i> 面積明細表</h3><div class="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden text-sm shadow-sm"><div class="flex justify-between p-5 border-b border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 font-bold text-slate-800 dark:text-slate-100"><span class="text-slate-600 dark:text-slate-400">總樓地板</span><span class="font-mono text-xl">${formatArea(getVal(z.area), unit).val} ${unit === 'ping' ? '坪' : 'M²'}</span></div></div></div>
                </div>
            </div><div onclick="window.app.closePanel()" class="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm transition-opacity"></div>`;
    }
    return '';
};