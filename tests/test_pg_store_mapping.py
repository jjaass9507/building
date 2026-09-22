"""store.pg_store 的欄位對應測試（不需要資料庫）。

真正的 SQL 行為要連資料庫才測得到，但「巢狀中文 JSON → 關聯式資料列」這段
純粹是對應邏輯，錯了就會整包資料走樣，值得單獨測。
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from building_data_manager import normalize_dataset  # noqa: E402
from store import pg_store  # noqa: E402


SAMPLE = [{
    "棟別": "K18",
    "基地面積(M2)": 10000,
    "容積率": 0.6,
    "建蔽率": 0.4,
    "開挖深度(M)": 12,
    "耐震係數(gal)": 400,
    "汽車停車位": 120,
    "機車停車位": 300,
    "樓層": [
        {
            "樓層": "B1", "狀態": "已成廠", "預計成廠年份": "", "進駐製程": "封裝",
            "樓層高度(cm)": "600", "無塵室淨高(cm)": "",
            "樓地板面積(M2)": 5000.5, "無塵室面積(M2)": 1200, "生產週邊(M2)": 800,
            "公設(含其他)(公式)(M2)": 1500, "樓層載重kgf/m2": 1000,
            "廠務設施面積(M2)": {"value": 1500, "details": {"純水": 300, "空調": 1200}},
        },
        {
            "樓層": "RF", "狀態": "未成廠", "預計成廠年份": "2028", "進駐製程": "",
            "樓層高度(cm)": "", "無塵室淨高(cm)": "",
            "樓地板面積(M2)": 900, "無塵室面積(M2)": 0, "生產週邊(M2)": 0,
            "公設(含其他)(公式)(M2)": 900, "樓層載重kgf/m2": 500,
            "廠務設施面積(M2)": 0,
        },
    ],
}]


class FloorWeightTest(unittest.TestCase):
    """必須與前端 static/js/utils.js 的 getFloorWeight() 完全一致。"""

    def test_matches_frontend_rules(self):
        cases = {
            'ALL': 9999.0,   # 未成廠且樓層未定的虛擬樓層，固定排最上面
            'B1': -1.0, 'B2': -2.0, 'B': -1.0,
            '1F': 1.0, '2F': 2.0, '10F': 10.0,
            'RF': 101.0, 'R1F': 101.0, 'R3F': 103.0, 'PH': 101.0,
        }
        for name, expected in cases.items():
            self.assertEqual(pg_store._floor_weight(name), expected, name)

    def test_blank_floor_name(self):
        self.assertIsNone(pg_store._floor_weight(''))
        self.assertIsNone(pg_store._floor_weight(None))


class RowMappingTest(unittest.TestCase):
    def setUp(self):
        self.data = normalize_dataset(SAMPLE)

    def test_building_row(self):
        row = pg_store._building_rows(self.data)[0]
        self.assertEqual(row['building_code'], 'K18')
        self.assertEqual(row['site_area_m2'], 10000.0)
        self.assertEqual(row['floor_area_ratio'], 0.6)
        self.assertEqual(row['building_coverage_ratio'], 0.4)
        self.assertEqual(row['excavation_depth_m'], 12.0)
        self.assertEqual(row['seismic_coefficient_gal'], 400.0)
        self.assertEqual(row['car_parking_spaces'], 120.0)
        self.assertEqual(row['motorcycle_parking_spaces'], 300.0)
        self.assertEqual(row['sort_order'], 0)
        self.assertTrue(row['building_id'])

    def test_floor_rows(self):
        rows = pg_store._floor_rows(self.data)
        self.assertEqual(len(rows), 2)

        b1 = rows[0]
        self.assertEqual(b1['floor_name'], 'B1')
        self.assertEqual(b1['status'], '已成廠')
        self.assertEqual(b1['floor_area_m2'], 5000.5)
        self.assertEqual(b1['cleanroom_area_m2'], 1200.0)
        self.assertEqual(b1['production_support_area_m2'], 800.0)
        self.assertEqual(b1['public_area_m2'], 1500.0)
        self.assertEqual(b1['facility_area_m2'], 1500.0)
        self.assertEqual(b1['floor_load_kgf_m2'], 1000.0)
        self.assertEqual(b1['floor_height_cm'], '600')
        self.assertEqual(b1['floor_weight'], -1.0)
        # 沒填年份 → 存 NULL，不要存 0
        self.assertIsNone(b1['expected_completion_year_num'])
        self.assertEqual(b1['expected_completion_year_raw'], '')

        rf = rows[1]
        self.assertEqual(rf['status'], '未成廠')
        self.assertEqual(rf['expected_completion_year_raw'], '2028')
        self.assertEqual(rf['expected_completion_year_num'], 2028)
        self.assertEqual(rf['sort_order'], 1)

    def test_relative_year_is_parsed(self):
        data = normalize_dataset([{
            "棟別": "K19", "樓層": [{"樓層": "1F", "預計成廠年份": "Y26"}],
        }])
        row = pg_store._floor_rows(data)[0]
        self.assertEqual(row['expected_completion_year_raw'], 'Y26')
        self.assertEqual(row['expected_completion_year_num'], 26)

    def test_facility_rows_keep_only_supplied_keys(self):
        # 只存來源有的 key。補上其他類別的零值會讓資料讀回來時與原始 JSON 不同，
        # dataset_revision 的 hash 就對不上了。
        rows = pg_store._facility_rows(self.data)
        self.assertEqual(
            sorted((r['facility_key'], r['area_m2']) for r in rows),
            [('空調', 1200.0), ('純水', 300.0)],
        )

    def test_unknown_status_falls_back(self):
        data = normalize_dataset([{
            "棟別": "K20", "樓層": [{"樓層": "1F", "狀態": "亂填"}],
        }])
        self.assertEqual(pg_store._floor_rows(data)[0]['status'], '已成廠')


if __name__ == '__main__':
    unittest.main()
