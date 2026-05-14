import { getFloorWeight } from './utils.js';

const toNumber = (value) => {
    const num = Number(value || 0);
    return Number.isFinite(num) ? num : 0;
};

const toText = (value) => {
    if (value === null || value === undefined) return '';
    return String(value).trim();
};

const isUnknownFloorSummary = (floorName) => String(floorName || '').toUpperCase().trim() === 'ALL';

export const processRawData = (data) => {
    const tempFloors = new Set();
    const processedData = []; 
    const buildingMeta = {};

    if (!Array.isArray(data)) {
        console.error("嚴重錯誤: 資料格式不正確", data);
        return { processedData, buildingMeta, sortedFloorLabels: [] };
    }

    data.forEach((b, index) => {
        const bName = b["棟別"] || `未命名棟別-${index + 1}`;
        const floors = Array.isArray(b["樓層"]) ? b["樓層"] : [];

        if (!Array.isArray(b["樓層"])) {
            console.warn(`⚠️ 警告: [${bName}] 缺少 "樓層" 欄位，已略過。`);
        }

        buildingMeta[bName] = {
            baseArea: toNumber(b["基地面積(M2)"]),
            capacityRate: toNumber(b["容積率"]),
            coverageRate: toNumber(b["建蔽率"]),
            digDepth: toNumber(b["開挖深度(M)"]),
            seismic: toNumber(b["耐震係數(gal)"]),
            floorsCount: floors.length 
        };

        floors.forEach(f => {
            const fName = f["樓層"];
            if (!fName) return;

            tempFloors.add(fName);
            
            const rawProcess = f["進駐製程"];
            const safeProcess = (rawProcess && String(rawProcess).trim().length > 0) ? rawProcess : '非製程';

            const rawStatus = f["狀態"];
            const floorStatus = (rawStatus && String(rawStatus).trim() === '未成廠') ? '未成廠' : '已成廠';
            const expectedCompletionYear = toText(f["預計成廠年份"]);

            const rawTotalArea = toNumber(f["樓地板面積(M2)"]);
            const fCleanArea = toNumber(f["無塵室面積(M2)"]);
            const fProdArea = toNumber(f["生產週邊(M2)"]);
            const fFacArea = f["廠務設施面積(M2)"] || 0;
            const fFacValue = (typeof fFacArea === 'object' && fFacArea !== null) ? toNumber(fFacArea.value) : toNumber(fFacArea);
            const fPubArea = toNumber(f["公設(含其他)(公式)(M2)"]);
            const fFloorLoad = toNumber(f["樓層載重kgf/m2"]);

            // ALL 是樓層未定時的資料承載列。
            // 若尚未有樓地板面積，但已填分類面積，外層單棟比例圖需要分母才能顯示。
            const categoryAreaTotal = fCleanArea + fProdArea + fFacValue + fPubArea;
            const fTotalArea = rawTotalArea > 0
                ? rawTotalArea
                : (isUnknownFloorSummary(fName) ? categoryAreaTotal : rawTotalArea);

            processedData.push({
                id: `${bName}-${fName}`,
                building: bName,
                floor: fName,
                floorWeight: getFloorWeight(fName),
                area: fTotalArea,
                height: toNumber(f["樓層高度(cm)"]),
                floorLoad: fFloorLoad,
                expectedCompletionYear,
                cleanRoomArea: fCleanArea,
                prodArea: fProdArea,
                facArea: fFacArea,
                pubArea: fPubArea,
                cleanRoomPct: fTotalArea > 0 ? fCleanArea / fTotalArea : 0,
                prodPct: fTotalArea > 0 ? fProdArea / fTotalArea : 0,
                facPct: fTotalArea > 0 ? fFacValue / fTotalArea : 0,
                pubPct: fTotalArea > 0 ? fPubArea / fTotalArea : 0,
                processLabel: safeProcess,
                usageLabel: safeProcess,
                status: floorStatus
            });
        });
    });

    const sortedFloorLabels = Array.from(tempFloors).sort((a, b) => {
        return getFloorWeight(b) - getFloorWeight(a);
    });

    return { processedData, buildingMeta, sortedFloorLabels };
};