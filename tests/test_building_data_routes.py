import json
import os
import tempfile
import unittest
from unittest.mock import patch

import app as app_module
from building_data_manager import normalize_dataset
from test_building_data_manager import SAMPLE_DATA


class BuildingDataRouteTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.data_path = os.path.join(self.folder.name, "data.json")
        self.audit_path = os.path.join(self.folder.name, "data_changes.json")
        self.backup_path = os.path.join(self.folder.name, "backups")
        self.processed_path = os.path.join(self.folder.name, "processed")
        with open(self.data_path, "w", encoding="utf-8") as handle:
            json.dump(normalize_dataset(SAMPLE_DATA), handle, ensure_ascii=False)

        self.patches = [
            patch.object(app_module, "data_file_path", self.data_path),
            patch.object(app_module, "data_changes_file_path", self.audit_path),
            patch.object(app_module, "backup_dir", self.backup_path),
            patch.object(app_module, "processed_dir", self.processed_path),
        ]
        for item in self.patches:
            item.start()

        app_module.app.config.update(TESTING=True)
        self.client = app_module.app.test_client()
        with self.client.session_transaction() as session:
            session["user"] = "Local-Dev"
            session["auth_type"] = "dev"

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
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


if __name__ == "__main__":
    unittest.main()
