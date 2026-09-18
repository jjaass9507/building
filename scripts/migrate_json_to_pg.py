"""把地端 JSON 資料匯入 PostgreSQL，並驗證零失真。

驗收方式刻意用專案已有的 `dataset_revision()`：它是整包資料的 sha256，
**匯入前後 hash 相同就證明沒有任何欄位在搬運途中走樣**，
不需要另外寫一整套逐欄位比對。

用法：

    # 先看會搬些什麼，不寫入資料庫
    python scripts/migrate_json_to_pg.py --dry-run

    # 實際匯入（資料庫必須已跑過 migrations/001、002）
    python scripts/migrate_json_to_pg.py

    # 只驗證目前資料庫內容與 JSON 檔一致（不寫入）
    python scripts/migrate_json_to_pg.py --verify-only

連線資訊來自環境變數或部署目錄的 .env（見 .env.example）。
"""

import argparse
import json
import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_APP_ROOT = os.path.dirname(_SCRIPT_DIR)
if _APP_ROOT not in sys.path:
    sys.path.insert(0, _APP_ROOT)

import db  # noqa: E402
from building_data_manager import (  # noqa: E402
    BuildingDataError,
    dataset_counts,
    dataset_revision,
    normalize_dataset,
)
from store import pg_store  # noqa: E402


FILES = {
    'data': 'data.json',
    'process_groups': 'process_groups.json',
    'trend_reference': 'trend_reference.json',
    'utility_trends': 'utility_trends.json',
    'permissions': 'permissions.json',
    'audit': 'data_changes.json',
}


class MigrationError(RuntimeError):
    pass


def _read_json(path, default):
    if not os.path.exists(path):
        return default, False
    with open(path, 'r', encoding='utf-8') as handle:
        return json.load(handle), True


def _log(message):
    print(message, flush=True)


def _section(title):
    _log('')
    _log(f"--- {title} " + '-' * max(0, 60 - len(title)))


# =============================================================================
# 各資料項的匯入
# =============================================================================

def migrate_dataset(app_root, username, dry_run):
    path = os.path.join(app_root, FILES['data'])
    raw, exists = _read_json(path, [])
    if not exists:
        _log(f"[skip] 找不到 {FILES['data']}，視為空資料集")
    if not isinstance(raw, list):
        raise MigrationError("data.json 根節點必須是陣列。")

    normalized = normalize_dataset(raw)
    revision = dataset_revision(normalized)
    counts = dataset_counts(normalized)
    _log(f"[read] 建物 {counts['buildings']} 棟 / 樓層 {counts['floors']} 層")
    _log(f"[read] revision = {revision}")

    if dry_run:
        return revision, counts

    pg_store.save_current_data(
        normalized,
        new_revision=revision,
        counts=counts,
        username=username,
        expected_revision=None,   # 初次匯入：不做樂觀鎖檢查
        # 匯入本身不是業務異動，不另外產生稽核紀錄；
        # 真正的歷史由 migrate_audit_records() 照搬 data_changes.json。
        audit=None,
        snapshot=True,
    )
    _log("[write] 建物資料已寫入")
    return revision, counts


def migrate_audit_records(app_root, dry_run):
    path = os.path.join(app_root, FILES['audit'])
    records, exists = _read_json(path, [])
    if not exists or not isinstance(records, list) or not records:
        _log(f"[skip] 沒有 {FILES['audit']} 可搬")
        return 0

    _log(f"[read] 稽核紀錄 {len(records)} 筆")
    if dry_run:
        return len(records)

    with db.transaction() as cur:
        # 重跑時先清空，避免同一批紀錄被匯入兩次
        cur.execute("DELETE FROM building.data_change_log")
        for record in records:
            summary = record.get('summary') or {}
            cur.execute(
                """
                INSERT INTO building.data_change_log (
                    changed_at, effective_date, change_type, changed_by, reason,
                    source_reference, revision_before, revision_after, backup_file,
                    summary, counts
                ) VALUES (
                    COALESCE(%(changed_at)s::timestamptz, now()),
                    COALESCE(%(effective_date)s::date, CURRENT_DATE),
                    %(change_type)s, %(changed_by)s, %(reason)s, %(source_reference)s,
                    %(revision_before)s, %(revision_after)s, %(backup_file)s,
                    %(summary)s::jsonb, %(counts)s::jsonb
                )
                """,
                {
                    'changed_at': record.get('changed_at') or None,
                    'effective_date': record.get('effective_date') or None,
                    'change_type': (record.get('change_type') or 'ADJUST').upper(),
                    'changed_by': record.get('changed_by') or '',
                    'reason': record.get('reason') or '',
                    'source_reference': record.get('source_reference') or '',
                    'revision_before': record.get('revision_before'),
                    'revision_after': record.get('revision_after'),
                    'backup_file': record.get('backup_file'),
                    'summary': json.dumps(summary, ensure_ascii=False),
                    'counts': json.dumps(record.get('counts') or {}, ensure_ascii=False),
                },
            )
    _log(f"[write] 稽核紀錄已寫入 {len(records)} 筆")
    return len(records)


def migrate_process_groups(app_root, username, dry_run):
    path = os.path.join(app_root, FILES['process_groups'])
    data, exists = _read_json(path, None)
    if not exists or not isinstance(data, dict):
        _log(f"[skip] 沒有 {FILES['process_groups']} 可搬")
        return None
    groups = data.get('groups') or []
    _log(f"[read] 製程大群組 {len(groups)} 組 / "
         f"製程 {sum(len(g.get('processes') or []) for g in groups)} 個")
    if not dry_run:
        pg_store.write_process_groups(data, username)
        _log("[write] 製程大群組已寫入")
    return data


def migrate_trend_reference(app_root, username, dry_run):
    path = os.path.join(app_root, FILES['trend_reference'])
    data, exists = _read_json(path, None)
    if not exists or not isinstance(data, dict):
        _log(f"[skip] 沒有 {FILES['trend_reference']} 可搬")
        return None
    _log(f"[read] 趨勢比較基準 {len(data.get('buildings') or [])} 棟")
    if not dry_run:
        pg_store.write_trend_reference(data, username)
        _log("[write] 趨勢比較基準已寫入")
    return data


def migrate_utility_trends(app_root, username, dry_run):
    path = os.path.join(app_root, FILES['utility_trends'])
    data, exists = _read_json(path, None)
    if not exists or not isinstance(data, dict):
        _log(f"[skip] 沒有 {FILES['utility_trends']} 可搬")
        return None
    metrics = data.get('metrics') or []
    _log(f"[read] 需求趨勢 {len(metrics)} 項 / "
         f"資料點 {sum(len(m.get('series') or []) for m in metrics)} 筆")
    if not dry_run:
        pg_store.write_utility_trends(data, username)
        _log("[write] 需求趨勢已寫入")
    return data


def migrate_permissions(app_root, username, dry_run):
    path = os.path.join(app_root, FILES['permissions'])
    data, exists = _read_json(path, None)
    if not exists or not isinstance(data, dict):
        _log(f"[skip] 沒有 {FILES['permissions']} 可搬")
        return None
    counts = {k: len(data.get(k) or []) for k in ('admins', 'users', 'viewers')}
    _log(f"[read] 權限 admin {counts['admins']} / user {counts['users']} / viewer {counts['viewers']}")
    if not dry_run:
        pg_store.write_permissions(data, username)
        _log("[write] 權限名單已寫入")
    return data


# =============================================================================
# 驗收
# =============================================================================

def verify(app_root, expected_revision):
    """把資料庫的內容讀回來，用 dataset_revision 的 hash 比對。"""
    failures = []

    _section('驗收')

    pg_data = normalize_dataset(pg_store.load_current_data())
    pg_revision = dataset_revision(pg_data)
    _log(f"JSON  revision = {expected_revision}")
    _log(f"PG    revision = {pg_revision}")
    if pg_revision == expected_revision:
        _log("[PASS] 建物資料 hash 一致 —— 匯入零失真")
    else:
        failures.append('建物資料 hash 不一致')
        _log("[FAIL] 建物資料 hash 不一致")

    state_revision = pg_store.current_revision()
    if state_revision == pg_revision:
        _log("[PASS] dataset_state.revision 與實際資料一致")
    else:
        failures.append('dataset_state.revision 與實際資料不一致')
        _log(f"[FAIL] dataset_state.revision = {state_revision}，與實際資料不一致")

    # 設定類資料只比對關鍵內容，因為 updated_at 之類的欄位本來就會被重寫
    file_groups, has_groups = _read_json(os.path.join(app_root, FILES['process_groups']), None)
    if has_groups and isinstance(file_groups, dict):
        pg_groups = pg_store.load_process_groups()
        before = [(g.get('id'), g.get('name'), list(g.get('processes') or []))
                  for g in (file_groups.get('groups') or [])]
        after = [(g.get('id'), g.get('name'), list(g.get('processes') or []))
                 for g in (pg_groups.get('groups') or [])]
        if before == after:
            _log("[PASS] 製程大群組一致")
        else:
            failures.append('製程大群組不一致')
            _log("[FAIL] 製程大群組不一致")

    file_trends, has_trends = _read_json(os.path.join(app_root, FILES['utility_trends']), None)
    if has_trends and isinstance(file_trends, dict):
        pg_trends = pg_store.load_utility_trends()
        before = [
            (m.get('metric_key'), [(p.get('year_key'), float(p.get('value') or 0))
                                   for p in (m.get('series') or [])])
            for m in (file_trends.get('metrics') or [])
        ]
        after = [
            (m.get('metric_key'), [(p.get('year_key'), float(p.get('value') or 0))
                                   for p in (m.get('series') or [])])
            for m in (pg_trends.get('metrics') or [])
        ]
        if before == after:
            _log("[PASS] 需求趨勢一致")
        else:
            failures.append('需求趨勢不一致')
            _log("[FAIL] 需求趨勢不一致")

    file_ref, has_ref = _read_json(os.path.join(app_root, FILES['trend_reference']), None)
    if has_ref and isinstance(file_ref, dict):
        pg_ref = pg_store.load_trend_reference()
        if list(file_ref.get('buildings') or []) == list(pg_ref.get('buildings') or []):
            _log("[PASS] 趨勢比較基準一致")
        else:
            failures.append('趨勢比較基準不一致')
            _log("[FAIL] 趨勢比較基準不一致")

    file_perm, has_perm = _read_json(os.path.join(app_root, FILES['permissions']), None)
    if has_perm and isinstance(file_perm, dict):
        pg_perm = pg_store.load_permissions()
        for bucket in ('admins', 'users', 'viewers'):
            before = sorted((str(x).strip().lower() for x in (file_perm.get(bucket) or [])))
            after = sorted(pg_perm.get(bucket) or [])
            if before != after:
                failures.append(f'權限名單 {bucket} 不一致')
                _log(f"[FAIL] 權限名單 {bucket} 不一致：{before} vs {after}")
        if not any(f.startswith('權限名單') for f in failures):
            _log("[PASS] 權限名單一致")

    return failures


# =============================================================================

def main():
    parser = argparse.ArgumentParser(description='把地端 JSON 資料匯入 PostgreSQL')
    parser.add_argument('--app-root', default=_APP_ROOT, help='專案根目錄（預設自動偵測）')
    parser.add_argument('--username', default='migration', help='寫入稽核欄位的執行者名稱')
    parser.add_argument('--dry-run', action='store_true', help='只讀取與顯示，不寫入資料庫')
    parser.add_argument('--verify-only', action='store_true', help='不寫入，只驗證資料庫與 JSON 一致')
    args = parser.parse_args()

    app_root = os.path.abspath(args.app_root)
    _log(f"專案根目錄：{app_root}")
    _log(f"資料庫目標：{db.describe_target()}")

    try:
        if args.verify_only:
            raw, _ = _read_json(os.path.join(app_root, FILES['data']), [])
            expected = dataset_revision(normalize_dataset(raw))
            failures = verify(app_root, expected)
        else:
            _section('讀取地端資料')
            revision, _counts = migrate_dataset(app_root, args.username, args.dry_run)
            migrate_process_groups(app_root, args.username, args.dry_run)
            migrate_trend_reference(app_root, args.username, args.dry_run)
            migrate_utility_trends(app_root, args.username, args.dry_run)
            migrate_permissions(app_root, args.username, args.dry_run)
            migrate_audit_records(app_root, args.dry_run)

            if args.dry_run:
                _log('')
                _log('--dry-run：沒有寫入任何資料。')
                return 0

            pg_store.ensure_access_log_partitions()
            failures = verify(app_root, revision)

        _log('')
        if failures:
            _log(f"結果：失敗（{len(failures)} 項）")
            for item in failures:
                _log(f"  - {item}")
            return 1
        _log("結果：全部通過")
        return 0

    except (BuildingDataError, MigrationError) as exc:
        _log('')
        _log(f"資料錯誤：{exc}")
        return 2
    except db.DatabaseNotConfigured as exc:
        _log('')
        _log(f"資料庫未設定：{exc}")
        return 3
    finally:
        db.close_pool()


if __name__ == '__main__':
    sys.exit(main())
