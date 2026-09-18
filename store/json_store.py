"""地端 JSON 檔案版的資料存取。

這裡的邏輯是從 app.py 原封搬過來的，**行為刻意維持完全相同**：
一樣的檔名、一樣的縮排、一樣的原子替換方式、一樣的備份命名規則。
Phase 2 只是把讀寫的位置從路由檔搬到存取層，不是重寫。

路徑預設是本套件的上一層目錄；app.py 打包成 EXE 時 base_dir 的推導方式不同，
所以由 app.py 在啟動時呼叫 configure() 覆寫。
"""

import json
import logging
import os
import shutil
from datetime import datetime

from werkzeug.utils import secure_filename

import building_data_manager

_BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Paths:
    """依 base_dir 推導出的所有檔案與資料夾位置。"""

    def __init__(self, base_dir):
        self.base_dir = base_dir
        self.data = os.path.join(base_dir, 'data.json')
        self.utility_trends = os.path.join(base_dir, 'utility_trends.json')
        self.process_groups = os.path.join(base_dir, 'process_groups.json')
        self.trend_reference = os.path.join(base_dir, 'trend_reference.json')
        self.permissions = os.path.join(base_dir, 'permissions.json')
        self.data_changes = os.path.join(base_dir, 'data_changes.json')

        self.uploads = os.path.join(base_dir, 'uploads')
        self.processed = os.path.join(base_dir, 'processed')
        self.data_backups = os.path.join(base_dir, 'data_backups')
        self.utility_backups = os.path.join(base_dir, 'utility_trend_backups')
        self.process_group_backups = os.path.join(base_dir, 'process_group_backups')
        self.trend_reference_backups = os.path.join(base_dir, 'trend_reference_backups')

    @property
    def runtime_dirs(self):
        return [
            self.uploads, self.data_backups, self.utility_backups,
            self.process_group_backups, self.trend_reference_backups, self.processed,
        ]


paths = Paths(_BASE_DIR)


def configure(base_dir):
    """設定專案根目錄。app.py 啟動時呼叫一次。"""
    global paths
    paths = Paths(base_dir)
    return paths


def ensure_runtime_dirs():
    for folder in paths.runtime_dirs:
        os.makedirs(folder, exist_ok=True)


def safe_username(username):
    return secure_filename((username or '').replace('\\', '_').replace('/', '_')) or 'unknown'


def _write_atomic(target_path, data, indent, prefix):
    """先寫暫存檔再原子替換，避免寫入中斷留下半份 JSON。"""
    ensure_runtime_dirs()
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
    temp_path = os.path.join(paths.processed, f"{prefix}_{timestamp}.json")
    with open(temp_path, 'w', encoding='utf-8') as handle:
        json.dump(data, handle, ensure_ascii=False, indent=indent)
    os.replace(temp_path, target_path)


def _backup(source_path, backup_dir, prefix, username, timestamp_fmt='%Y%m%d_%H%M%S'):
    if not os.path.exists(source_path):
        return None
    ensure_runtime_dirs()
    timestamp = datetime.now().strftime(timestamp_fmt)
    backup_filename = f"{prefix}_{timestamp}_{safe_username(username)}.json"
    backup_path = os.path.join(backup_dir, backup_filename)
    shutil.copy2(source_path, backup_path)
    return backup_path


def _read_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, 'r', encoding='utf-8') as handle:
        return json.load(handle)


# =============================================================================
# 建物資料
# =============================================================================

def load_current_data():
    data = _read_json(paths.data, [])
    if not isinstance(data, list):
        # 由呼叫端轉成 BuildingDataError；這一層不依賴 app 的例外型別
        raise ValueError("data.json 根節點必須是陣列。")
    return data


def write_current_data(data):
    _write_atomic(paths.data, data, indent=4, prefix='data_maintenance_pending')


def backup_current_data(username):
    return _backup(paths.data, paths.data_backups, 'data', username)


def append_audit_record(record, max_records=1000):
    # 沿用 building_data_manager 既有的實作，不另外寫一份
    building_data_manager.append_audit_record(paths.data_changes, record, max_records)


def load_audit_records(limit=None):
    """回傳稽核紀錄（舊到新）。檔案不存在或格式壞掉時回傳空 list。"""
    records = building_data_manager.load_audit_records(paths.data_changes)
    return records[-limit:] if limit else records


# =============================================================================
# 設定類
# =============================================================================

def load_process_groups(default):
    return _read_json(paths.process_groups, default)


def write_process_groups(data):
    _write_atomic(paths.process_groups, data, indent=2, prefix='process_groups_pending')


def backup_process_groups(username):
    # 原本就帶微秒，保持檔名格式一致
    return _backup(paths.process_groups, paths.process_group_backups, 'process_groups',
                   username, timestamp_fmt='%Y%m%d_%H%M%S_%f')


def load_trend_reference(default):
    return _read_json(paths.trend_reference, default)


def write_trend_reference(data):
    _write_atomic(paths.trend_reference, data, indent=2, prefix='trend_reference_pending')


def backup_trend_reference(username):
    return _backup(paths.trend_reference, paths.trend_reference_backups, 'trend_reference',
                   username, timestamp_fmt='%Y%m%d_%H%M%S_%f')


def load_utility_trends(default):
    return _read_json(paths.utility_trends, default)


def write_utility_trends(data):
    _write_atomic(paths.utility_trends, data, indent=2, prefix='utility_trends_pending')


def backup_utility_trends(username):
    return _backup(paths.utility_trends, paths.utility_backups, 'utility_trends', username)


# =============================================================================
# 權限
# =============================================================================

def load_permissions(default):
    if not os.path.exists(paths.permissions):
        logging.warning("permissions.json not found: %s", paths.permissions)
        return default
    permissions = _read_json(paths.permissions, None)
    if permissions is None:
        return default
    if not isinstance(permissions, dict):
        raise ValueError("permissions.json root must be an object")
    return {
        "admins": permissions.get("admins", []),
        "users": permissions.get("users", []),
        "viewers": permissions.get("viewers", []),
    }
