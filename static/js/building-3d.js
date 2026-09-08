import { formatArea } from './utils.js';

const getValue = (value) => {
    if (value && typeof value === 'object') {
        return Number(value.value ?? value.val ?? 0) || 0;
    }
    return Number(value || 0) || 0;
};

const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');


const measurement = (value, unit) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0
        ? `${number.toLocaleString('zh-TW', { maximumFractionDigits: 2 })} ${unit}` : '未提供';
};

const floorFacts = (floor) => `<span class="building-3d-facts"><span>樓高 <strong>${measurement(floor.height, 'm')}</strong></span><span>荷重 <strong>${measurement(floor.floorLoad, 'kgf/m²')}</strong></span><span class="building-3d-process">製程 <strong>${escapeHtml(floor.usageLabel || '未提供')}</strong></span></span>`;

const isSummaryFloor = (floor) => String(floor || '').trim().toUpperCase() === 'ALL';
const METRICS = { height: '樓高', floorLoad: '荷重', usage: '製程', area: '面積' };
const metricValue = (floor, metric, unit) => {
    if (metric === 'usage') return escapeHtml(floor.usageLabel || '未提供');
    if (metric === 'area') {
        if (!(getValue(floor.area) > 0)) return '未提供';
        const area = formatArea(getValue(floor.area), unit);
        return `${area.val} ${area.unit}`;
    }
    return measurement(floor[metric], metric === 'floorLoad' ? 'kgf/m²' : 'm');
};

const renderEmptyBuilding = (buildingName, unknownSummary) => `
    <div class="flex h-full min-h-[360px] flex-col items-center justify-center border border-dashed border-slate-300 bg-slate-50 px-8 text-center dark:border-slate-700 dark:bg-slate-950/40">
        <i data-lucide="layers-3" class="h-12 w-12 text-slate-300 dark:text-slate-600"></i>
        <h3 class="mt-4 text-lg font-black text-slate-700 dark:text-slate-200">${escapeHtml(buildingName)} 尚無可建立模型的樓層</h3>
        <p class="mt-2 max-w-md text-sm leading-6 text-slate-500 dark:text-slate-400">請在樓層資料填入實際樓層名稱後，系統就會依樓層順序、樓地板面積與樓高自動產生 3D 示意圖。</p>
        ${unknownSummary ? '<p class="mt-3 border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">目前只有「ALL」全棟規劃資料，未納入樓層模型。</p>' : ''}
    </div>`;


// A fixed orthographic projection keeps every label on its own facade.
// Coordinates are screen pixels; the model adapts, text never scales below 13px.
let sceneData = [];
export const renderBuilding3DModal = (state, buildingMeta, processedData) => {
    if (!state.isBuilding3DOpen || !state.building3DName) return '';
    sceneData = processedData;
    return `<div class="building-3d-backdrop" onclick="window.app.closeBuilding3D()">
        <section class="building-3d-dialog" role="dialog" aria-modal="true" aria-labelledby="building-3d-title" onclick="event.stopPropagation()">
            <header class="building-3d-header">
                <div><div class="building-3d-eyebrow">BUILDING / FLOOR INFORMATION</div><h2 id="building-3d-title">${escapeHtml(state.building3DName)} · 樓層立體總覽</h2></div>
                <div class="building-3d-tools">
                    <button class="building-3d-tool ${state.building3DView !== 'front' ? 'is-active' : ''}" aria-pressed="${state.building3DView !== 'front'}" onclick="window.app.setBuilding3DView('overview')">立體</button>
                    <button class="building-3d-tool ${state.building3DView === 'front' ? 'is-active' : ''}" aria-pressed="${state.building3DView === 'front'}" onclick="window.app.setBuilding3DView('front')">正視</button>
                    <button class="building-3d-tool" onclick="window.app.closeBuilding3D()" aria-label="關閉樓層立體總覽">關閉 ×</button>
                </div>
            </header>
            <div class="building-3d-metric-toolbar"><span>樓層顯示</span>${Object.entries(METRICS).map(([key,label])=>`<button class="${state.building3DMetric === key ? 'is-active' : ''}" aria-pressed="${state.building3DMetric === key}" onclick="window.app.setBuilding3DMetric('${key}')">${label}</button>`).join('')}</div>
            <div class="building-3d-summary" data-building-3d-summary></div>
            <div class="building-3d-layout"><div class="building-3d-scene" data-building-3d-scene></div></div>
            <footer class="building-3d-footer"><span>指標直接標於樓層立面 · 點選查看完整資料</span><span>示意量體，非實際建築尺寸</span></footer>
        </section></div>`;
};

let disposeScene = () => {};
export const bindBuilding3DInteractions = (state) => {
    disposeScene();
    disposeScene = () => {};
    if (!state.isBuilding3DOpen) return;
    const scene = document.querySelector('[data-building-3d-scene]');
    if (!scene) return;
    // renderBuilding3DModal's data is captured by the wrapper below, not duplicated.
    const processedData = sceneData;
    const rows = processedData.filter(row => row.building === state.building3DName);
    const floors = rows.filter(row => !isSummaryFloor(row.floor)).sort((a,b) => a.floorWeight - b.floorWeight);
    const metric = Object.hasOwn(METRICS, state.building3DMetric) ? state.building3DMetric : 'usage';
    const area = formatArea(floors.reduce((sum,f) => sum + getValue(f.area),0), state.unit);
    const summary = document.querySelector('[data-building-3d-summary]');
    summary.innerHTML = `<span>實際樓層 <strong>${floors.length} 層</strong></span><span>總樓地板 <strong>${area.val} ${area.unit}</strong></span><span class="building-3d-legend">青綠：選取樓層 <i></i> 橘色虛線：未成廠</span>`;
    if (!floors.length) {
        scene.innerHTML = renderEmptyBuilding(state.building3DName, rows.some(f => isSummaryFloor(f.floor)));
        return;
    }
    let selectedId = state.selected3DFloorId;
    let openDetailId = null;
    let focusedId = null;
    const plainMetric = floor => {
        const element = document.createElement('span');
        element.innerHTML = metricValue(floor,metric,state.unit);
        return element.textContent;
    };
    const showDetail = (id) => {
        const floor = floors.find(f=>String(f.id)===id);
        if (!floor) return;
        selectedId = floor.id;
        state.selected3DFloorId = floor.id;
        openDetailId = id;
        focusedId = id;
        draw();
    };
    const draw = () => {
        if (!scene.isConnected) return;
        const w = scene.clientWidth, h = scene.clientHeight;
        if (w < 1 || h < 1) return;
        const n = floors.length;
        // Very tall buildings split into explicitly named, consecutive ranges.
        // This preserves readable text and all-floor visibility without scrolling.
        const capacity = Math.max(1, Math.floor((h - 100) / 32));
        const columns = Math.min(Math.max(1, Math.ceil(n / capacity)), Math.max(1, Math.floor(w / 270)));
        const perColumn = Math.ceil(n / columns);
        const dense = (h - 100) / perColumn < 32;
        const canvasHeight = dense ? perColumn * 32 + 100 : h;
        scene.classList.toggle('has-overflow', dense);
        const colWidth = w / columns;
        const step = Math.min(70, (canvasHeight - 100) / perColumn);
        const depthX = state.building3DView === 'front' ? 0 : Math.min(65, colWidth * .14);
        const depthY = state.building3DView === 'front' ? 0 : Math.min(28, step * .4);
        const maxArea = Math.max(1,...floors.map(f=>getValue(f.area)));
        const parts = [];
        const geometry = new Map();
        for (let col=0;col<columns;col++) {
            const group = floors.slice(col*perColumn,(col+1)*perColumn);
            if (!group.length) continue;
            const maxWidth = Math.min(580,colWidth-52-depthX);
            const baseX = col*colWidth + (colWidth-maxWidth-depthX)/2;
            const bottom = (canvasHeight + group.length*step)/2 + depthY/2;
            const top = bottom-group.length*step;
            const baseY = bottom+5;
            parts.push(`<path class="floor-podium" d="M ${baseX-10} ${baseY} h ${maxWidth+20} l ${depthX} ${-depthY} v 7 l ${-depthX} ${depthY} h ${-maxWidth-20} Z"/>`);
            if (columns>1) parts.push(`<text class="floor-range" x="${baseX}" y="${top-depthY-15}">${escapeHtml(group[0].floor)}–${escapeHtml(group.at(-1).floor)} · 樓層 ${col+1}/${columns}</text>`);
            group.forEach((floor,index)=>{
                // Width variation is schematic; enforce enough facade for the label.
                const width = maxWidth*(.85+.15*Math.sqrt(Math.max(0,getValue(floor.area))/maxArea));
                const x=baseX+(maxWidth-width)/2, y=bottom-(index+1)*step;
                const id=String(floor.id), value=plainMetric(floor);
                geometry.set(id,{x,y,width,step});
                parts.push(`<g class="floor-unit ${String(selectedId)===id?'is-selected':''} ${floor.status==='未成廠'?'is-planned':''}" data-floor-id="${escapeHtml(id)}" tabindex="0" role="button" aria-pressed="${String(selectedId)===id}" aria-label="${escapeHtml(floor.floor+'，'+METRICS[metric]+' '+value+'，'+(floor.status||'狀態未提供'))}">
                    <title>${escapeHtml(floor.floor+' · '+METRICS[metric]+' '+value+' · '+(floor.status||'狀態未提供'))}</title>
                    <path class="floor-top" d="M ${x} ${y} l ${depthX} ${-depthY} h ${width} l ${-depthX} ${depthY} Z"/>
                    <path class="floor-side" d="M ${x+width} ${y} l ${depthX} ${-depthY} v ${step-2} l ${-depthX} ${depthY} Z"/>
                    <rect class="floor-front" x="${x}" y="${y}" width="${width}" height="${step-2}"/>
                    <path class="floor-edge" d="M ${x} ${y+step-5} h ${width}"/>
                    <text class="floor-name" x="${x+12}" y="${y+(step-2)/2}" dominant-baseline="middle">${escapeHtml(floor.floor)}</text>
                    <text class="floor-value" data-max-width="${Math.max(25,width-95)}" x="${x+78}" y="${y+(step-2)/2}" dominant-baseline="middle">${escapeHtml(value)}</text>
                </g>`);
            });
        }
        scene.innerHTML = `<svg class="building-floor-svg" width="${w}" height="${canvasHeight}" viewBox="0 0 ${w} ${canvasHeight}" aria-label="${escapeHtml(state.building3DName)} 各樓層${METRICS[metric]}立體示意">${parts.join('')}</svg>${dense?'<div class="building-3d-density-note">畫面高度不足，保留可讀字級；可捲動查看其餘樓層。</div>':''}`;
        scene.querySelectorAll('.floor-value').forEach(text=>{
            const full=text.textContent;
            const limit=Number(text.dataset.maxWidth);
            let chars=Array.from(full);
            while(text.getComputedTextLength()>limit && chars.length>0) {
                chars.pop(); text.textContent=chars.join('')+'…';
            }
        });
        if (openDetailId !== null) {
            const floor=floors.find(f=>String(f.id)===openDetailId);
            const box=geometry.get(openDetailId);
            if (floor && box) {
                const detail=document.createElement('section');
                detail.className='building-3d-detail';
                detail.setAttribute('aria-label',`${floor.floor} 完整資訊`);
                const area=formatArea(getValue(floor.area),state.unit);
                detail.innerHTML=`<div class="building-3d-detail-heading"><strong>${escapeHtml(floor.floor)} · ${escapeHtml(floor.status||'狀態未提供')}</strong><button data-close-detail aria-label="關閉樓層詳細資訊">×</button></div>${floorFacts(floor)}<div class="building-3d-detail-area">樓地板面積 <strong>${area.val} ${area.unit}</strong></div>`;
                scene.append(detail);
                const dw=detail.offsetWidth,dh=detail.offsetHeight;
                const left=Math.max(8,Math.min(w-dw-8,box.x+box.width-dw));
                const below=box.y+box.step+8;
                const top=below+dh<canvasHeight-8?below:Math.max(8,box.y-dh-8);
                detail.style.left=`${left}px`; detail.style.top=`${top}px`;
                const anchorX = Math.max(left+12,Math.min(left+dw-12,box.x+box.width/2));
                const fromY = top<box.y ? box.y : box.y+box.step-2;
                const toY = top<box.y ? top+dh : top;
                const line=document.createElementNS('http://www.w3.org/2000/svg','path');
                line.setAttribute('class','floor-detail-connector');
                line.setAttribute('d',`M ${anchorX} ${fromY} V ${toY}`);
                scene.querySelector('svg').append(line);
            }
        }
        if (focusedId!==null) {
            [...scene.querySelectorAll('[data-floor-id]')].find(el=>el.dataset.floorId===focusedId)?.focus({preventScroll:true});
        }
    };
    const click = event => {
        if(event.target.closest('[data-close-detail]')) {openDetailId=null;draw();return;}
        const floor=event.target.closest('[data-floor-id]');
        if(floor) showDetail(floor.dataset.floorId);
    };
    const keydown = event => {
        if(event.key==='Escape' && openDetailId!==null) {event.stopPropagation();openDetailId=null;draw();return;}
        const floor=event.target.closest('[data-floor-id]');
        if(floor && (event.key==='Enter'||event.key===' ')) {event.preventDefault();showDetail(floor.dataset.floorId);}
    };
    scene.addEventListener('click',click);
    scene.addEventListener('keydown',keydown);
    const observer=new ResizeObserver(draw);
    observer.observe(scene);
    draw();
    disposeScene=()=>{observer.disconnect();scene.removeEventListener('click',click);scene.removeEventListener('keydown',keydown);};
};
