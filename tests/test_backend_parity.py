"""兩種 DATA_BACKEND 的行為一致性測試。

同一串操作分別跑在 `json` 與 `postgres` 上，比對每一個 API 回應是否相同。
這是 Phase 2 的驗收：切換資料來源不應該讓前端看到任何差異。

需要一個已經套用過 migrations 的 PostgreSQL。沒有設定連線資訊時整個檔案會 skip：

    PGHOST=... PGPORT=... PGDATABASE=... PGUSER=... PGPASSWORD=... \
        python -m pytest tests/test_backend_parity.py -v
"""

import copy
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as app_module  # noqa: E402
import db  # noqa: E402
import store  # noqa: E402
from building_data_manager import normalize_dataset  # noqa: E402
from test_building_data_manager import SAMPLE_DATA  # noqa: E402


def _database_available():
    try:
        db.build_conninfo()
    except db.DatabaseNotConfigured:
        return False, '沒有設定資料庫連線資訊'
    ok, message = db.ping()
    if not ok:
        return False, message
    applied = db.applied_migrations()
    if not applied:
        return False, '資料庫尚未套用 migration'
    return True, ''


_DB_OK, _DB_REASON = _database_available()

# 每次寫入都會變動、本來就不該相同的欄位
VOLATILE_KEYS = {'updated_at', 'changed_at', 'backup_file', 'warnings'}


def _strip_volatile(value):
    """遞迴移除時間戳與備份檔名，只留下真正該一致的內容。"""
    if isinstance(value, dict):
        return {k: _strip_volatile(v) for k, v in value.items() if k not in VOLATILE_KEYS}
    if isinstance(value, list):
        return [_strip_volatile(v) for v in value]
    return value


@unittest.skipUnless(_DB_OK, f'需要可用的 PostgreSQL：{_DB_REASON}')
class BackendParityTests(unittest.TestCase):
    """同一串操作在兩種 backend 上要得到相同的 API 回應。"""

    def setUp(self):
        self._previous_backend = os.environ.get('DATA_BACKEND')
        self._previous_base_dir = store.json_store.paths.base_dir
        app_module.app.config.update(TESTING=True)

    def tearDown(self):
        if self._previous_backend is None:
            os.environ.pop('DATA_BACKEND', None)
        else:
            os.environ['DATA_BACKEND'] = self._previous_backend
        store.configure(self._previous_base_dir)
        db.close_pool()

    # -- 測試情境 ------------------------------------------------------------

    def _scenario(self, client):
        """一串涵蓋讀取、維護、設定與匯出的操作，回傳每一步的結果。"""
        steps = []

        def record(name, response, body=True):
            item = {'step': name, 'status': response.status_code}
            if body and response.mimetype == 'application/json':
                item['body'] = _strip_volatile(response.get_json())
            else:
                # 匯出的是 Excel，只比對有沒有成功產生
                item['bytes_over_1k'] = len(response.data) > 1000
            steps.append(item)
            return response

        record('GET /api/data', client.get('/api/data'))

        load = record('GET /api/admin/building-data', client.get('/api/admin/building-data'))
        loaded = load.get_json()

        # 改一個面積再存回去
        updated = copy.deepcopy(loaded['data'])
        updated[0]['樓層'][0]['樓地板面積(M2)'] = 5250
        record('POST /api/admin/building-data', client.post('/api/admin/building-data', json={
            'data': updated,
            'revision': loaded['revision'],
            'reason': '一致性測試修正面積',
            'effective_date': '2026-09-15',
            'change_type': 'ADJUST',
            'source_reference': 'PARITY-001',
        }))

        # 帶舊的 revision 再存一次，兩邊都應該回 409
        record('POST /api/admin/building-data（舊 revision）',
               client.post('/api/admin/building-data', json={
                   'data': updated,
                   'revision': loaded['revision'],
                   'reason': '應該被擋下',
                   'effective_date': '2026-09-15',
                   'change_type': 'ADJUST',
               }))

        record('GET /api/admin/building-data（存檔後）', client.get('/api/admin/building-data'))

        record('POST /api/admin/process-groups', client.post('/api/admin/process-groups', json={
            'groups': [
                {'id': 'front', 'name': '前段製程', 'processes': ['研磨', '清洗']},
                {'id': 'back', 'name': '後段製程', 'processes': ['封裝']},
            ]
        }))
        record('GET /api/process-groups', client.get('/api/process-groups'))

        # 同一個製程指到兩個群組，兩邊都要被擋下
        record('POST /api/admin/process-groups（重複分群）',
               client.post('/api/admin/process-groups', json={
                   'groups': [
                       {'name': '群組一', 'processes': ['研磨']},
                       {'name': '群組二', 'processes': ['研磨']},
                   ]
               }))

        record('POST /api/admin/utility-trends', client.post('/api/admin/utility-trends', json={
            'metrics': [{
                'metric_key': 'power_demand',
                'metric_name': '電力需求',
                'unit': 'kW',
                'annual_label': '年增電力需求',
                'cumulative_label': '累積電力需求',
                'description': '',
                'series': [
                    {'year_key': 'current', 'year_label': '現況', 'value': 100, 'is_baseline': True, 'note': ''},
                    {'year_key': 'Y26', 'year_label': 'Y26', 'value': 50, 'is_baseline': False, 'note': ''},
                ],
            }]
        }))
        record('GET /api/utility-trends', client.get('/api/utility-trends'))

        record('GET /api/export-data/readable', client.get('/api/export-data/readable'), body=False)
        record('GET /api/export-data/standard', client.get('/api/export-data/standard'), body=False)

        return steps

    # -- 兩種 backend 各跑一次 ------------------------------------------------

    def _prepare_folder(self, folder):
        with open(os.path.join(folder, 'data.json'), 'w', encoding='utf-8') as handle:
            json.dump(normalize_dataset(SAMPLE_DATA), handle, ensure_ascii=False)
        with open(os.path.join(folder, 'permissions.json'), 'w', encoding='utf-8') as handle:
            json.dump({'admins': ['Local-Dev'], 'users': [], 'viewers': []}, handle)

    def _client(self):
        client = app_module.app.test_client()
        with client.session_transaction() as session:
            session['user'] = 'Local-Dev'
            session['auth_type'] = 'dev'
        return client

    def _reset_database(self):
        """把資料庫清成剛跑完 migration 的狀態。"""
        with db.connection() as conn:
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute("""
                    TRUNCATE building_mgmt.buildings,
                             building_mgmt.process_groups,
                             building_mgmt.utility_metrics,
                             building_mgmt.app_settings,
                             building_mgmt.dataset_snapshots,
                             building_mgmt.data_change_log
                    RESTART IDENTITY CASCADE
                """)
                cur.execute("""
                    UPDATE building_mgmt.dataset_state
                       SET revision = %s, building_count = 0, floor_count = 0
                     WHERE id = 1
                """, ('4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',))

    def _run(self, backend, folder):
        os.environ['DATA_BACKEND'] = backend
        self._prepare_folder(folder)
        store.configure(folder)
        if backend == 'postgres':
            self._reset_database()
            # 資料庫是空的，先用 JSON 的起始內容灌進去，兩邊才是同一個起點
            seed = normalize_dataset(json.load(open(os.path.join(folder, 'data.json'), encoding='utf-8')))
            from building_data_manager import dataset_counts, dataset_revision
            store.save_current_data(seed, new_revision=dataset_revision(seed),
                                    counts=dataset_counts(seed), username='parity-setup')
        return self._scenario(self._client())

    def test_json_and_postgres_produce_identical_responses(self):
        with tempfile.TemporaryDirectory() as json_folder:
            json_steps = self._run('json', json_folder)
            json_data_file = json.load(open(os.path.join(json_folder, 'data.json'), encoding='utf-8'))

        with tempfile.TemporaryDirectory() as pg_folder:
            pg_steps = self._run('postgres', pg_folder)
            # 雙寫：postgres 模式下 JSON 檔也應該被鏡射成同一份內容
            pg_data_file = json.load(open(os.path.join(pg_folder, 'data.json'), encoding='utf-8'))

        self.assertEqual(len(json_steps), len(pg_steps))
        for json_step, pg_step in zip(json_steps, pg_steps):
            self.assertEqual(json_step['step'], pg_step['step'])
            self.assertEqual(json_step, pg_step, f"步驟「{json_step['step']}」兩種 backend 結果不同")

        self.assertEqual(json_data_file, pg_data_file,
                         '鏡射回 JSON 的內容與純 JSON 模式不一致')

    def test_mirror_can_be_disabled(self):
        """DATA_MIRROR_JSON=false 時不應該再寫 JSON 檔（Phase 3 的行為）。"""
        previous = os.environ.get('DATA_MIRROR_JSON')
        os.environ['DATA_MIRROR_JSON'] = 'false'
        try:
            with tempfile.TemporaryDirectory() as folder:
                os.environ['DATA_BACKEND'] = 'postgres'
                self._prepare_folder(folder)
                store.configure(folder)
                self._reset_database()

                from building_data_manager import dataset_counts, dataset_revision
                seed = normalize_dataset(json.load(open(os.path.join(folder, 'data.json'), encoding='utf-8')))
                store.save_current_data(seed, new_revision=dataset_revision(seed),
                                        counts=dataset_counts(seed), username='parity-setup')

                data_path = os.path.join(folder, 'data.json')
                before = open(data_path, encoding='utf-8').read()

                client = self._client()
                loaded = client.get('/api/admin/building-data').get_json()
                updated = copy.deepcopy(loaded['data'])
                updated[0]['樓層'][0]['樓地板面積(M2)'] = 9999
                response = client.post('/api/admin/building-data', json={
                    'data': updated,
                    'revision': loaded['revision'],
                    'reason': '停用鏡射測試',
                    'effective_date': '2026-09-15',
                    'change_type': 'ADJUST',
                })
                self.assertEqual(response.status_code, 200)

                # 資料庫更新了，但 JSON 檔沒有被動到
                self.assertEqual(open(data_path, encoding='utf-8').read(), before)
                self.assertEqual(
                    store.load_current_data()[0]['樓層'][0]['樓地板面積(M2)'], 9999)
        finally:
            if previous is None:
                os.environ.pop('DATA_MIRROR_JSON', None)
            else:
                os.environ['DATA_MIRROR_JSON'] = previous


if __name__ == '__main__':
    unittest.main()
