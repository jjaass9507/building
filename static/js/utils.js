// 樓層排序權重計算
export const getFloorWeight = (floorStr) => {
    const str = floorStr.toUpperCase();
    
    // 地下室 (B1, B2...) -> 權重為負數
    if (str.startsWith('B')) {
        const num = parseInt(str.replace(/[^0-9]/g, '')) || 1;
        return -num;
    }
    
    // 頂樓 (RF, R1F, R2F...) -> 權重 100 + 樓層數
    // 這樣 R3F(103) 會比 R1F(101) 大，排序時 R3F 會在上面
    if (str.startsWith('R') || str === 'PH') {
        const num = parseInt(str.replace(/[^0-9]/g, '')) || 1;
        return 100 + num; 
    }
    
    // 一般樓層 (1F, 2F...) -> 權重為樓層數
    return parseInt(str.replace(/[^0-9]/g, '')) || 0;
};

// 面積格式化 (依據單位)
export const formatArea = (value, unit = 'm2') => {
    const val = value || 0;
    if (unit === 'ping') {
        return { 
            val: (val * 0.3025).toLocaleString(undefined, {maximumFractionDigits: 0}), 
            unit: '坪' 
        };
    }
    return { 
        val: val.toLocaleString(undefined, {maximumFractionDigits: 0}), 
        unit: 'm²' 
    };
};

// 百分比格式化
export const formatPct = (value) => {
    if (value === undefined || value === null) return '0';
    return (value * 100).toFixed(0);
};

// 取得共用樣式
export const getCellStyle = () => {
    return 'bg-white text-slate-700 border-slate-200 hover:border-blue-500 hover:shadow-md hover:text-blue-600';
};