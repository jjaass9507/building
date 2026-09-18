"""資料存取層門面。

讀取走哪一邊由環境變數 `DATA_BACKEND` 決定：

    DATA_BACKEND=json       地端 JSON 檔案（預設，行為與導入資料庫前完全相同）
    DATA_BACKEND=postgres   PostgreSQL

**Phase 2 的雙寫**：`DATA_BACKEND=postgres` 時，寫入會先進資料庫（含樂觀鎖、
版本快照與稽核紀錄，同一個交易內完成），成功後再把同一份資料鏡射回 JSON 檔。

這樣做的理由是保留退路：切換期間若資料庫出狀況，把 `DATA_BACKEND` 改回 `json`
重啟就能回到檔案版，而且檔案的內容是最新的。鏡射由 `DATA_MIRROR_JSON` 控制，
Phase 3 確認穩定後設成 `false` 即可停掉。

鏡射失敗不會讓使用者的請求失敗 —— 此時資料庫已經是真實來源，
檔案只是備援；失敗會記進 log 並在 API 回應帶一則警告，讓維運人員看得到。
"""

import logging
import os

from db import backend_name
from . import json_store

__all__ = [
    'RevisionConflict', 'backend_name', 'configure', 'describe',
    'load_current_data', 'save_current_data', 'backup_current_data', 'load_audit_records',
    'load_process_groups', 'write_process_groups', 'backup_process_groups',
    'load_trend_reference', 'write_trend_reference', 'backup_trend_reference',
    'load_utility_trends', 'write_utility_trends', 'backup_utility_trends',
    'load_permissions',
]


class RevisionConflict(RuntimeError):
    """資料已被其他人更新（對應 API 的 409）。"""

    def __init__(self, current_revision=''):
        super().__init__("資料已被其他管理人員更新，請重新載入後再修改。")
        self.current_revision = current_revision


def configure(base_dir):
    """設定專案根目錄（JSON 檔案的位置）。app.py 啟動時呼叫一次。"""
    return json_store.configure(base_dir)


def use_postgres():
    return backend_name() == 'postgres'


def mirror_json():
    """postgres 模式下是否要把寫入鏡射回 JSON 檔。"""
    if not use_postgres():
        return False
    raw = (os.environ.get('DATA_MIRROR_JSON', 'true') or '').strip().lower()
    return raw not in ('0', 'false', 'no', 'off')


def describe():
    """給啟動訊息與健康檢查用的一行說明。"""
    if not use_postgres():
        return '地端 JSON 檔案'
    return 'PostgreSQL' + ('（同時鏡射回 JSON 檔）' if mirror_json() else '')


def _pg():
    """延遲載入 pg_store：json 模式下不該因為缺 psycopg 而啟動失敗。"""
    from . import pg_store
    return pg_store


def _mirror(action, describe_action):
    """執行一次鏡射寫入。失敗時回傳警告字串，不往外丟例外。"""
    try:
        action()
        return None
    except Exception as exc:  # noqa: BLE001 - 鏡射失敗不該讓請求失敗
        logging.exception("鏡射到 JSON 檔失敗：%s", describe_action)
        return (f"資料已寫入資料庫，但同步回 {describe_action} 失敗："
                f"{type(exc).__name__}: {exc}。檔案版備援目前不是最新的。")


# =============================================================================
# 建物資料
# =============================================================================

def load_current_data():
    if use_postgres():
        return _pg().load_current_data()
    return json_store.load_current_data()


def backup_current_data(username):
    """備份目前的 data.json。

    postgres 模式下版本快照已經寫進 dataset_snapshots，這裡備份的是 JSON 備援檔；
    停掉鏡射之後就沒有備份的必要了。
    """
    if use_postgres() and not mirror_json():
        return None
    return json_store.backup_current_data(username)


def save_current_data(data, *, new_revision, counts, username,
                      expected_revision=None, audit=None):
    """整包覆寫建物資料。回傳鏡射警告字串（沒有問題時為 None）。

    postgres 模式下資料、版本快照與稽核紀錄在同一個交易內完成；
    `expected_revision` 對不上會丟 RevisionConflict。
    """
    if use_postgres():
        try:
            _pg().save_current_data(
                data,
                new_revision=new_revision,
                counts=counts,
                username=username,
                expected_revision=expected_revision,
                audit=audit,
            )
        except _pg().RevisionConflict as exc:
            raise RevisionConflict(exc.current_revision) from exc

        if not mirror_json():
            return None

        def write_mirror():
            json_store.write_current_data(data)
            if audit:
                json_store.append_audit_record(audit)

        return _mirror(write_mirror, 'data.json / data_changes.json')

    json_store.write_current_data(data)
    if audit:
        json_store.append_audit_record(audit)
    return None


def load_audit_records(limit=None):
    """稽核紀錄（舊到新）。"""
    if use_postgres():
        return _pg().load_audit_records(limit or 1000)
    return json_store.load_audit_records(limit)


# =============================================================================
# 設定類
# =============================================================================

def load_process_groups(default):
    if use_postgres():
        return _pg().load_process_groups()
    return json_store.load_process_groups(default)


def write_process_groups(data, username=None):
    if use_postgres():
        _pg().write_process_groups(data, username)
        if not mirror_json():
            return None
        return _mirror(lambda: json_store.write_process_groups(data), 'process_groups.json')

    json_store.write_process_groups(data)
    return None


def load_trend_reference(default):
    if use_postgres():
        return _pg().load_trend_reference()
    return json_store.load_trend_reference(default)


def write_trend_reference(data, username=None):
    if use_postgres():
        _pg().write_trend_reference(data, username)
        if not mirror_json():
            return None
        return _mirror(lambda: json_store.write_trend_reference(data), 'trend_reference.json')

    json_store.write_trend_reference(data)
    return None


def load_utility_trends(default):
    if use_postgres():
        return _pg().load_utility_trends()
    return json_store.load_utility_trends(default)


def write_utility_trends(data, username=None):
    if use_postgres():
        _pg().write_utility_trends(data, username)
        if not mirror_json():
            return None
        return _mirror(lambda: json_store.write_utility_trends(data), 'utility_trends.json')

    json_store.write_utility_trends(data)
    return None


def backup_utility_trends(username):
    if use_postgres() and not mirror_json():
        return None
    return json_store.backup_utility_trends(username)


def backup_process_groups(username):
    if use_postgres() and not mirror_json():
        return None
    return json_store.backup_process_groups(username)


def backup_trend_reference(username):
    if use_postgres() and not mirror_json():
        return None
    return json_store.backup_trend_reference(username)


# =============================================================================
# 權限
#
# 權限改由資料庫管理是 Phase 4 的事，這裡先固定讀檔案。
# =============================================================================

def load_permissions(default):
    return json_store.load_permissions(default)
