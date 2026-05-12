import json
import math
import os
from typing import Any, Dict, List, Optional

# --- 欄位對應設定 ---

floor_columns_setting = {
    '棟別': '棟別',
    '樓層': '樓層',
    '狀態': '狀態',
    '進駐製程': '進駐製程',
    '樓層高度(M)': '樓層高度(cm)',
    '無塵室淨高(M)': '無塵室淨高(cm)',
    '樓地板面積(M2)': '樓地板面積(M2)',
    '無塵室面積(M2)': '無塵室面積(M2)',
    '生產週邊(M2)': '生產週邊(M2)',
    '公設(含其他)(公式)(M2)': '公設(含其他)(公式)(M2)',
    '廠務設施面積(M2)': '廠務設施面積(M2)',
    '樓層載重kgf/m2': '樓層載重kgf/m2'
}

facility_sub_columns = {
    '純水': '純水',
    '廢水': '廢水',
    '給排水': '給排水',
    '空調': '空調',
    '抽氣': '抽氣',
    '氣體': '氣體',
    '電力': '電力',
    '弱電': '弱電',
    '消防': '消防',
    '監控': '監控',
    '監控/弱電/消防': '其他'
}

floor_columns_setting.update(facility_sub_columns)

building_columns_setting = {
    '棟別': '棟別',
    '基地面積(M2)': '基地面積(M2)',
    '容積率': '容積率',
    '建蔽率': '建蔽率',
    '開挖深度(M)': '開挖深度(M)',
    '耐震係數(gal)': '耐震係數(gal)',
    '汽車停車位': '汽車停車位',
    '機車停車位': '機車停車位'
}

SHEET_NAME_MASTER = '廠棟標準格式'
SHEET_NAME_DETAIL = '樓層標準格式'
FACILITY_MAIN_KEY = '廠務設施面積(M2)'
JOIN_KEY = '棟別'


class DataProcessError(Exception):
    """資料轉換失敗。"""


def get_pandas():
    """
    延遲載入 pandas，避免 pandas / numpy 環境異常時導致整個 Flask app 無法啟動。
    只有 admin 執行 Excel 上傳轉換時才會真正 import pandas。
    """
    try:
        import pandas as pd
        return pd
    except Exception as exc:
        raise DataProcessError(
            "Excel 資料處理套件載入失敗，請確認 PortablePython 內 pandas、numpy、openpyxl 已正確安裝。"
            f" 原始錯誤：{exc}"
        ) from exc


def clean_dict(row: Dict[str, Any], pd_module) -> Dict[str, Any]:
    """移除 NaN 與空字串。"""
    return {
        k: v for k, v in row.items()
        if not pd_module.isna(v) and v != ""
    }


def to_float(value: Any) -> float:
    try:
        return float(value)
    except (ValueError, TypeError):
        return 0.0


def excel_sheets_to_nested_data(file_path: str, warnings: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    """將標準格式 Excel 轉成前端使用的巢狀 JSON 資料結構。"""
    pd = get_pandas()
    warnings = warnings if warnings is not None else []

    try:
        df_master = pd.read_excel(file_path, sheet_name=SHEET_NAME_MASTER)
        df_detail = pd.read_excel(file_path, sheet_name=SHEET_NAME_DETAIL)
    except ValueError as exc:
        raise DataProcessError(
            f"JSON 轉換失敗：請確認 Excel 內是否有 '{SHEET_NAME_MASTER}' 或 '{SHEET_NAME_DETAIL}'。"
        ) from exc

    floor_map: Dict[str, List[Dict[str, Any]]] = {}
    sub_keys = list(facility_sub_columns.values())

    for row in df_detail.to_dict(orient='records'):
        cleaned_floor = clean_dict(row, pd)

        sub_total = 0.0
        sub_items_dict: Dict[str, float] = {}
        has_sub_data = False

        for sub_key in sub_keys:
            if sub_key in cleaned_floor:
                value = to_float(cleaned_floor[sub_key])
                if value > 0:
                    sub_total += value
                    sub_items_dict[sub_key] = value
                    has_sub_data = True
                del cleaned_floor[sub_key]

        main_value = 0.0
        if FACILITY_MAIN_KEY in cleaned_floor:
            main_value = to_float(cleaned_floor[FACILITY_MAIN_KEY])

        if has_sub_data:
            if main_value == 0:
                main_value = sub_total

            cleaned_floor[FACILITY_MAIN_KEY] = {
                "value": main_value,
                "details": sub_items_dict
            }

            if not math.isclose(main_value, sub_total, abs_tol=0.01):
                building_name = cleaned_floor.get(JOIN_KEY, '未知棟別')
                floor_name = cleaned_floor.get('樓層', '未知樓層')
                warnings.append(
                    f"【{building_name}】{floor_name} 的設施面積總和不符，母欄位 {main_value}，子項加總 {sub_total}，已保留 details。"
                )

        elif FACILITY_MAIN_KEY in cleaned_floor:
            cleaned_floor[FACILITY_MAIN_KEY] = {
                "value": main_value,
                "details": {}
            }

        building_key = row.get(JOIN_KEY)
        if building_key:
            floor_map.setdefault(building_key, [])
            cleaned_floor.pop(JOIN_KEY, None)
            floor_map[building_key].append(cleaned_floor)

    final_data: List[Dict[str, Any]] = []
    for row in df_master.to_dict(orient='records'):
        cleaned_master = clean_dict(row, pd)
        building_id = row.get(JOIN_KEY)
        cleaned_master['樓層'] = floor_map.get(building_id, [])
        final_data.append(cleaned_master)

    return final_data


def process_excel_file(input_path: str, cleaned_excel_path: str, json_output_path: str) -> Dict[str, Any]:
    """
    將使用者上傳的原始 Excel 清洗成標準格式 Excel，再轉成 data.json。

    回傳：
    {
        success: bool,
        rows: int,
        buildings: int,
        warnings: list[str],
        cleaned_excel_path: str,
        json_output_path: str
    }
    """
    pd = get_pandas()
    warnings: List[str] = []

    try:
        df = pd.read_excel(input_path, header=1)
    except Exception as exc:
        raise DataProcessError(f"讀取 Excel 失敗：{exc}") from exc

    df.columns = df.columns.astype(str).str.replace('\n', '', regex=False).str.replace(' ', '', regex=False)
    df = df.replace(r'\n', '', regex=True)

    missing_floor = [col for col in floor_columns_setting.keys() if col not in df.columns]
    critical_missing = [col for col in missing_floor if col not in facility_sub_columns]

    if critical_missing:
        raise DataProcessError(f"樓層設定錯誤：找不到必要欄位 {critical_missing}")

    for sub_col in facility_sub_columns:
        if sub_col not in df.columns:
            df[sub_col] = 0
            warnings.append(f"Excel 未包含子系統欄位「{sub_col}」，已自動補 0。")

    df_floor = df[list(floor_columns_setting.keys())].rename(columns=floor_columns_setting)
    target_building_col = floor_columns_setting['棟別']
    target_floor_col = floor_columns_setting['樓層']

    df_floor[target_building_col] = df_floor[target_building_col].ffill()
    df_floor = df_floor.dropna(subset=[target_floor_col])
    df_floor = df_floor[df_floor[target_floor_col].astype(str).str.contains('F|筏基', case=False, na=False, regex=True)]
    df_floor[target_floor_col] = df_floor[target_floor_col].astype(str).str.replace(r'\(.*?\)', '', regex=True)
    df_floor[target_floor_col] = df_floor[target_floor_col].str.replace(r'（.*?）', '', regex=True)
    df_floor[target_floor_col] = df_floor[target_floor_col].str.strip()

    missing_bldg = [col for col in building_columns_setting.keys() if col not in df.columns]
    if missing_bldg:
        raise DataProcessError(f"棟別設定錯誤：找不到必要欄位 {missing_bldg}")

    df_building = df[list(building_columns_setting.keys())].rename(columns=building_columns_setting)
    building_col_name = building_columns_setting['棟別']
    df_building[building_col_name] = df_building[building_col_name].ffill()
    df_building = df_building.drop_duplicates(subset=[building_col_name], keep='first')
    df_building = df_building.dropna(subset=[building_col_name])

    os.makedirs(os.path.dirname(cleaned_excel_path), exist_ok=True)
    os.makedirs(os.path.dirname(json_output_path), exist_ok=True)

    try:
        with pd.ExcelWriter(cleaned_excel_path, engine='openpyxl') as writer:
            df_floor.to_excel(writer, sheet_name=SHEET_NAME_DETAIL, index=False)
            df_building.to_excel(writer, sheet_name=SHEET_NAME_MASTER, index=False)
    except PermissionError as exc:
        raise DataProcessError("存檔失敗：請確認清洗後的 Excel 檔案沒有被開啟。") from exc

    final_data = excel_sheets_to_nested_data(cleaned_excel_path, warnings=warnings)

    with open(json_output_path, 'w', encoding='utf-8') as f:
        json.dump(final_data, f, ensure_ascii=False, indent=4, default=str)

    return {
        "success": True,
        "rows": int(len(df_floor)),
        "buildings": int(len(final_data)),
        "warnings": warnings,
        "cleaned_excel_path": cleaned_excel_path,
        "json_output_path": json_output_path
    }
