"""建立／更新本服務的兩個資料庫帳號。

    svc_building_mgmt_migrator  跑 migration 用，擁有 schema 與物件（DDL）
    svc_building_mgmt_rw        應用程式日常使用，只有 DML

密碼以互動方式輸入，**不落檔案、不進指令歷史、不寫 log**。
需要用有 CREATEROLE 權限的帳號連線（通常是 DBA 給的管理帳號）。

用法：

    # 互動式輸入密碼
    python scripts/create_db_users.py --admin-user postgres

    # 只看目前狀態，不做任何變更
    python scripts/create_db_users.py --admin-user postgres --status

帳號已存在時只更新密碼與 LOGIN 屬性，不會動既有授權。
授權本身由 migrations/003_roles_grants.sql 負責。
"""

import argparse
import getpass
import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_APP_ROOT = os.path.dirname(_SCRIPT_DIR)
if _APP_ROOT not in sys.path:
    sys.path.insert(0, _APP_ROOT)

import db  # noqa: E402

SERVICE_USERS = [
    ('svc_building_mgmt_migrator', '跑 migration（DDL）'),
    ('svc_building_mgmt_rw', '應用程式日常使用（DML）'),
]

MIN_PASSWORD_LENGTH = 12


def _log(message):
    print(message, flush=True)


def _connect(admin_user, admin_password):
    """以管理帳號連線。沿用 .env 的主機／資料庫設定，只換帳號密碼。"""
    import psycopg

    # 直接改行程內的環境變數，讓 libpq 從 PGPASSWORD 讀密碼，
    # 密碼就不會出現在連線字串裡（連線字串會被寫進 log）
    previous_user = os.environ.get('PGUSER')
    previous_password = os.environ.get('PGPASSWORD')
    os.environ['PGUSER'] = admin_user
    if admin_password:
        os.environ['PGPASSWORD'] = admin_password
    try:
        return psycopg.connect(db.build_conninfo()), (previous_user, previous_password)
    except Exception:
        if previous_user is None:
            os.environ.pop('PGUSER', None)
        else:
            os.environ['PGUSER'] = previous_user
        if previous_password is None:
            os.environ.pop('PGPASSWORD', None)
        else:
            os.environ['PGPASSWORD'] = previous_password
        raise


def _role_status(conn):
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT rolname, rolcanlogin
            FROM pg_roles
            WHERE rolname = ANY(%s)
            """,
            ([name for name, _ in SERVICE_USERS],),
        )
        return dict(cur.fetchall())


def _prompt_password(username, purpose):
    _log('')
    _log(f"  {username}  （{purpose}）")
    while True:
        first = getpass.getpass('    請輸入密碼（輸入時不會顯示）：')
        if not first:
            _log('    略過這個帳號。')
            return None
        if len(first) < MIN_PASSWORD_LENGTH:
            _log(f'    密碼至少要 {MIN_PASSWORD_LENGTH} 個字元，請重新輸入。')
            continue
        second = getpass.getpass('    請再輸入一次確認：')
        if first != second:
            _log('    兩次輸入不一致，請重新輸入。')
            continue
        return first


def main():
    parser = argparse.ArgumentParser(description='建立／更新資料庫服務帳號')
    parser.add_argument('--admin-user', required=True,
                        help='有 CREATEROLE 權限的帳號（例如 postgres 或 DBA 給的管理帳號）')
    parser.add_argument('--status', action='store_true',
                        help='只顯示目前狀態，不做任何變更')
    args = parser.parse_args()

    _log(f"資料庫目標：{db.describe_target()}")
    _log(f"管理帳號　：{args.admin_user}")

    try:
        admin_password = os.environ.get('PGADMIN_PASSWORD')
        if not admin_password:
            admin_password = getpass.getpass(f"請輸入 {args.admin_user} 的密碼（輸入時不會顯示）：")

        conn, saved_env = _connect(args.admin_user, admin_password)
    except db.DatabaseNotConfigured as exc:
        _log('')
        _log(f"資料庫未設定：{exc}")
        return 3
    except Exception as exc:  # noqa: BLE001
        _log('')
        _log(f"連線失敗：{type(exc).__name__}: {exc}")
        return 1

    try:
        conn.autocommit = True
        status = _role_status(conn)

        _log('')
        _log('--- 目前狀態 ' + '-' * 48)
        for name, purpose in SERVICE_USERS:
            if name not in status:
                state = '不存在'
            elif status[name]:
                state = '已存在，可登入'
            else:
                state = '已存在，尚未啟用登入'
            _log(f"  {name:<30} {state}")

        if args.status:
            _log('')
            _log('--status：沒有做任何變更。')
            return 0

        _log('')
        _log('--- 設定密碼 ' + '-' * 48)
        _log('  直接按 Enter 可略過該帳號（保留現況）。')

        changed = []
        for name, purpose in SERVICE_USERS:
            password = _prompt_password(name, purpose)
            if password is None:
                continue
            with conn.cursor() as cur:
                # 用參數化的 format 避免密碼被字串拼接進 SQL 文字
                from psycopg import sql
                if name in status:
                    cur.execute(
                        sql.SQL("ALTER ROLE {} LOGIN PASSWORD {}").format(
                            sql.Identifier(name), sql.Literal(password)))
                else:
                    cur.execute(
                        sql.SQL("CREATE ROLE {} LOGIN PASSWORD {}").format(
                            sql.Identifier(name), sql.Literal(password)))
            changed.append(name)
            _log('    已設定。')

        _log('')
        if not changed:
            _log('沒有帳號被變更。')
            return 0

        _log(f"完成，已設定 {len(changed)} 個帳號：{'、'.join(changed)}")
        _log('')
        _log('接下來：')
        _log('  1. 執行 .\\scripts\\run-migrations.ps1 建立 schema 與授權')
        _log('  2. 把 svc_building_mgmt_rw 的帳密填進部署目錄的 .env')
        _log('     （PGUSER / PGPASSWORD）')
        _log('  3. migration 用的帳密填 PGUSER_MIGRATOR / PGPASSWORD_MIGRATOR')
        return 0

    finally:
        conn.close()
        previous_user, previous_password = saved_env
        if previous_user is None:
            os.environ.pop('PGUSER', None)
        else:
            os.environ['PGUSER'] = previous_user
        if previous_password is None:
            os.environ.pop('PGPASSWORD', None)
        else:
            os.environ['PGPASSWORD'] = previous_password


if __name__ == '__main__':
    sys.exit(main())
