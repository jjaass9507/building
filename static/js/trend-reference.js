import { apiUrl } from './utils.js?v=20260916-unified-scope';

const escapeHtml = value => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

export const configuredTrendReferences = config => (
    Array.isArray(config?.buildings)
        ? config.buildings.map(value => String(value || '').trim()).filter(Boolean).slice(0, 2)
        : []
);

export const getTrendReferenceArea = (rows, building, metric) => {
    const key = metric === 'prod' ? 'prodArea' : 'cleanRoomArea';
    return (Array.isArray(rows) ? rows : [])
        .filter(row => row.building === building)
        .reduce((sum, row) => sum + (Number(row[key]) || 0), 0);
};

export const getEquivalentBuildingCount = (area, referenceArea) => {
    const numerator = Number(area) || 0;
    const denominator = Number(referenceArea) || 0;
    return denominator > 0 ? numerator / denominator : null;
};

export const formatEquivalentBuildingCount = count => {
    if (count === null || count === undefined || !Number.isFinite(count)) return '-';
    if (count === 0) return '0';
    return count >= 10 ? count.toFixed(1) : count.toFixed(2);
};

export const fetchTrendReferenceConfig = async () => {
    const response = await fetch(apiUrl('/api/trend-reference'), { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message || '趨勢比較基準載入失敗。');
    return result.data || { schema_version: '1.0', buildings: [] };
};

export const openTrendReferenceAdmin = ({ buildingNames, config, onSaved }) => {
    const names = [...new Set((Array.isArray(buildingNames) ? buildingNames : []).map(String))]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, 'zh-TW', { numeric: true }));
    const selected = configuredTrendReferences(config);
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/70 p-4';
    const options = current => names.map(name => `<option value="${escapeHtml(name)}" ${name === current ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('');
    modal.innerHTML = `
        <section class="w-full max-w-lg border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-900">
            <div class="flex items-start justify-between gap-4">
                <div><div class="text-xs font-black uppercase tracking-[0.16em] text-indigo-600">Admin Setting</div><h2 class="mt-1 text-xl font-black text-slate-900 dark:text-white">成長趨勢比較基準</h2></div>
                <button type="button" data-close class="p-2 text-slate-400 hover:text-slate-700 dark:hover:text-white">✕</button>
            </div>
            <p class="mt-3 text-sm text-slate-500 dark:text-slate-400">指定兩棟供使用者切換。等效棟數會依目前選擇的無塵室或生產週邊面積計算。</p>
            <form class="mt-5 space-y-4">
                <label class="block text-sm font-bold text-slate-700 dark:text-slate-200">比較基準一<select name="first" class="mt-1 w-full border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-800">${options(selected[0])}</select></label>
                <label class="block text-sm font-bold text-slate-700 dark:text-slate-200">比較基準二<select name="second" class="mt-1 w-full border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-800">${options(selected[1])}</select></label>
                <div data-message class="hidden border px-3 py-2 text-sm font-bold"></div>
                <div class="flex justify-end gap-2"><button type="button" data-close class="border border-slate-300 px-4 py-2 text-sm font-bold dark:border-slate-700">取消</button><button type="submit" class="bg-indigo-600 px-4 py-2 text-sm font-black text-white">儲存設定</button></div>
            </form>
        </section>`;
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', close));
    modal.addEventListener('click', event => { if (event.target === modal) close(); });
    modal.querySelector('form').addEventListener('submit', async event => {
        event.preventDefault();
        const message = modal.querySelector('[data-message]');
        const form = new FormData(event.currentTarget);
        const buildings = [form.get('first'), form.get('second')].map(value => String(value || '').trim());
        message.className = 'border px-3 py-2 text-sm font-bold border-red-200 bg-red-50 text-red-700';
        message.classList.remove('hidden');
        if (buildings.some(name => !name) || new Set(buildings).size !== 2) {
            message.textContent = '請選擇兩棟不同的廠棟。';
            return;
        }
        try {
            const response = await fetch(apiUrl('/api/admin/trend-reference'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ schema_version: '1.0', buildings })
            });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.message || '儲存失敗。');
            await onSaved?.(result.data);
            close();
        } catch (error) {
            message.textContent = error.message || '儲存失敗。';
        }
    });
};
