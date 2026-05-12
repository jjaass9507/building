import { getFloorWeight } from './utils.js';

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
            baseArea: b["基地面積(M2)"] || 0,
            capacityRate: b["容積率"] || 0,
            coverageRate: b["建蔽率"] || 0,
            digDepth: b["開挖深度(M)"] || 0,
            seismic: b["耐震係數(gal)"] || 0,
            floorsCount: floors.length 
        };

        floors.forEach(f => {
            const fName = f["樓層"];
            if (!fName) return;

            tempFloors.add(fName);
            
            const rawProcess = f["進駐製程"];
            const safeProcess = (rawProcess && String(rawProcess).trim().length > 0) ? rawProcess : '非製程';

            // [新增] 狀態判斷邏輯
            // 如果 "狀態" 欄位是 "未成廠"，就標記為 "未成廠"
            // 否則 (包含空值、undefined、或其他的)，預設為 "已成廠"
            const rawStatus = f["狀態"];
            const floorStatus = (rawStatus && rawStatus.trim() === '未成廠') ? '未成廠' : '已成廠';

            const fTotalArea = f["樓地板面積(M2)"] || 0;
            const fCleanArea = f["無塵室面積(M2)"] || 0;
            const fProdArea = f["生產週邊(M2)"] || 0;
            const fFacArea = f["廠務設施面積(M2)"] || 0;
            const fPubArea = f["公設(含其他)(公式)(M2)"] || 0;

            processedData.push({
                id: `${bName}-${fName}`,
                building: bName,
                floor: fName,
                floorWeight: getFloorWeight(fName),
                area: fTotalArea,
                height: f["樓層高度(cm)"] || 0,
                cleanRoomArea: fCleanArea,
                prodArea: fProdArea,
                facArea: fFacArea,
                pubArea: fPubArea,
                cleanRoomPct: fTotalArea > 0 ? fCleanArea / fTotalArea : 0,
                prodPct: fTotalArea > 0 ? fProdArea / fTotalArea : 0,
                facPct: fTotalArea > 0 ? fFacArea / fTotalArea : 0,
                pubPct: fTotalArea > 0 ? fPubArea / fTotalArea : 0,
                usageLabel: safeProcess,
                status: floorStatus // [新增] 將狀態存入
            });
        });
    });

    const sortedFloorLabels = Array.from(tempFloors).sort((a, b) => {
        return getFloorWeight(b) - getFloorWeight(a);
    });

    return { processedData, buildingMeta, sortedFloorLabels };
};