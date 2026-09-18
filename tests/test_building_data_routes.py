import json
import os
import tempfile
import unittest

import app as app_module
import store
from building_data_manager import normalize_dataset
from test_building_data_manager import SAMPLE_DATA


class BuildingDataRouteTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.data_path = os.path.join(self.folder.name, "data.json")
        self.audit_path = os.path.join(self.folder.name, "data_changes.json")
        self.permissions_path = os.path.join(self.folder.name, "permissions.json")
        with open(self.data_path, "w", encoding="utf-8") as handle:
            json.dump(normalize_dataset(SAMPLE_DATA), handle, ensure_ascii=False)
        with open(self.permissions_path, "w", encoding="utf-8") as handle:
            json.dump({"admins": ["Local-Dev"], "users": [], "viewers": []}, handle)

        # 所有檔案位置都由存取層決定，測試只要把它指到暫存目錄即可。
        self._previous_base_dir = store.json_store.paths.base_dir
        store.configure(self.folder.name)

        app_module.app.config.update(TESTING=True)
        self.client = app_module.app.test_client()
        with self.client.session_transaction() as session:
            session["user"] = "Local-Dev"
            session["auth_type"] = "dev"

    def tearDown(self):
        store.configure(self._previous_base_dir)
        self.folder.cleanup()

    def test_admin_can_load_update_and_export(self):
        load_response = self.client.get("/api/admin/building-data")
        self.assertEqual(load_response.status_code, 200)
        loaded = load_response.get_json()
        self.assertEqual(loaded["counts"], {"buildings": 1, "floors": 2})

        loaded["data"][0]["樓層"][0]["樓地板面積(M2)"] = 5250
        save_response = self.client.post("/api/admin/building-data", json={
            "data": loaded["data"],
            "revision": loaded["revision"],
            "reason": "單元測試修正面積",
            "effective_date": "2026-09-15",
            "change_type": "ADJUST",
            "source_reference": "TEST-001",
        })
        self.assertEqual(save_response.status_code, 200)
        self.assertEqual(save_response.get_json()["summary"]["floors_updated"], 1)

        readable = self.client.get("/api/export-data/readable")
        self.assertEqual(readable.status_code, 200)
        self.assertEqual(readable.mimetype, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        self.assertGreater(len(readable.data), 1000)

        standard = self.client.get("/api/export-data/standard")
        self.assertEqual(standard.status_code, 200)
        self.assertGreater(len(standard.data), 1000)

        with open(self.audit_path, "r", encoding="utf-8") as handle:
            audit = json.load(handle)
        self.assertEqual(audit[-1]["reason"], "單元測試修正面積")

    def test_process_groups_can_be_managed_and_reject_duplicate_assignment(self):
        empty_response = self.client.get("/api/process-groups")
        self.assertEqual(empty_response.status_code, 200)
        self.assertEqual(empty_response.get_json()["data"]["groups"], [])

        save_response = self.client.post("/api/admin/process-groups", json={"groups": [
            {"id": "front", "name": "前段製程", "processes": ["研磨", "清洗"]},
            {"id": "back", "name": "後段製程", "processes": ["封裝"]},
        ]})
        self.assertEqual(save_response.status_code, 200)
        saved = save_response.get_json()["data"]
        self.assertEqual(saved["updated_by"], "Local-Dev")
        self.assertEqual(saved["groups"][0]["processes"], ["研磨", "清洗"])

        duplicate_response = self.client.post("/api/admin/process-groups", json={"groups": [
            {"name": "群組一", "processes": ["研磨"]},
            {"name": "群組二", "processes": ["研磨"]},
        ]})
        self.assertEqual(duplicate_response.status_code, 400)
        self.assertIn("不可重複分群", duplicate_response.get_json()["message"])

    def test_trend_reference_requires_two_existing_distinct_buildings(self):
        empty_response = self.client.get("/api/trend-reference")
        self.assertEqual(empty_response.status_code, 200)
        self.assertEqual(empty_response.get_json()["data"]["buildings"], [])

        dataset = normalize_dataset(SAMPLE_DATA + [{**SAMPLE_DATA[0], "棟別": "K5"}])
        with open(self.data_path, "w", encoding="utf-8") as handle:
            json.dump(dataset, handle, ensure_ascii=False)

        save_response = self.client.post("/api/admin/trend-reference", json={"buildings": ["K18", "K5"]})
        self.assertEqual(save_response.status_code, 200)
        self.assertEqual(save_response.get_json()["data"]["buildings"], ["K18", "K5"])

        duplicate_response = self.client.post("/api/admin/trend-reference", json={"buildings": ["K18", "K18"]})
        self.assertEqual(duplicate_response.status_code, 400)
        self.assertIn("兩棟不同", duplicate_response.get_json()["message"])

        missing_response = self.client.post("/api/admin/trend-reference", json={"buildings": ["K18", "K99"]})
        self.assertEqual(missing_response.status_code, 400)
        self.assertIn("找不到廠棟", missing_response.get_json()["message"])


if __name__ == "__main__":
    unittest.main()
