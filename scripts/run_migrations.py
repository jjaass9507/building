"""套用 migrations/ 底下的 SQL migration。

用 Python 而不是 psql，是因為部署機不見得裝了 PostgreSQL 的命令列工具，
但一定會有 venv 裡的 psycopg（requirements.txt 已列）。

用法：

    python scripts/run_migrations.py --list        # 只看狀態，不執行
    python scripts/run_migrations.py --dry-run     # 顯示會套用哪些，不執行
    python scripts/run_migrations.py               # 套用未執行的 migration
    python scripts/run_migrations.py --skip-roles  # 略過需要 CREATEROLE 的 003

每個檔案套用後會把版本與 sha256 記進 building.schema_migrations。
已套用過的檔案若內容被改動，會提出警告但不重跑 ——
migration 一旦上過正式機就該視為不可變，要改請新增一個檔案。
"""

import argparse
import hashlib
import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_APP_ROOT = os.path.dirname(_SCRIPT_DIR)
if _APP_ROOT not in sys.path:
    sys.path.insert(0, _APP_ROOT)

import db  # noqa: E402

MIGRATIONS_DIR = os.path.join(_APP_ROOT, 'migrations')

_BOOTSTRAP_SQL = """
CREATE SCHEMA IF NOT EXISTS building;
CREATE TABLE IF NOT EXISTS building.schema_migrations (
    version    text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now(),
    applied_by text NOT NULL DEFAULT current_user,
    checksum   text
);
"""


def _log(message):
    print(message, flush=True)


def _checksum(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def discover(skip_roles=False):
    if not os.path.isdir(MIGRATIONS_DIR):
        raise RuntimeError(f"找不到 migrations 目錄：{MIGRATIONS_DIR}")
    files = sorted(f for f in os.listdir(MIGRATIONS_DIR) if f.endswith('.sql'))
    if skip_roles:
        files = [f for f in files if 'roles' not in f]
    return files


def applied_state(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('building.schema_migrations')")
        if cur.fetchone()[0] is None:
            return {}
        cur.execute("SELECT version, checksum FROM building.schema_migrations")
        return dict(cur.fetchall())


def main():
    parser = argparse.ArgumentParser(description='套用 PostgreSQL migration')
    parser.add_argument('--list', action='store_true', help='只顯示每個 migration 的狀態')
    parser.add_argument('--dry-run', action='store_true', help='顯示會套用哪些，但不執行')
    parser.add_argument('--skip-roles', action='store_true',
                        help='略過 003_roles_grants.sql（需要 CREATEROLE 權限，通常由 DBA 執行）')
    args = parser.parse_args()

    _log(f"資料庫目標：{db.describe_target()}")

    try:
        files = discover(skip_roles=args.skip_roles)
    except RuntimeError as exc:
        _log(str(exc))
        return 2

    if not files:
        _log("沒有找到任何 migration 檔。")
        return 0

    try:
        # migration 檔自己帶 BEGIN/COMMIT，所以整份檔案交給伺服器自行管理交易。
        with db.connection() as conn:
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute(_BOOTSTRAP_SQL)

            done = applied_state(conn)
            pending = []

            _log('')
            for name in files:
                path = os.path.join(MIGRATIONS_DIR, name)
                with open(path, 'r', encoding='utf-8') as handle:
                    body = handle.read()
                digest = _checksum(body)

                if name not in done:
                    pending.append((name, body, digest))
                    _log(f"  [pending] {name}")
                elif done[name] and done[name] != digest:
                    _log(f"  [CHANGED] {name} —— 已套用過但檔案內容有變動，"
                         f"不會重跑。要修改請新增一個 migration 檔。")
                else:
                    _log(f"  [applied] {name}")

            if args.list:
                return 0
            if not pending:
                _log('')
                _log("沒有需要套用的 migration。")
                return 0
            if args.dry_run:
                _log('')
                _log(f"--dry-run：會套用 {len(pending)} 個檔案，但沒有實際執行。")
                return 0

            _log('')
            for name, body, digest in pending:
                _log(f"套用 {name} …")
                with conn.cursor() as cur:
                    cur.execute(body)
                    cur.execute(
                        """
                        INSERT INTO building.schema_migrations (version, checksum)
                        VALUES (%s, %s)
                        ON CONFLICT (version) DO UPDATE SET checksum = EXCLUDED.checksum
                        """,
                        (name, digest),
                    )
                _log(f"  完成 {name}")

        _log('')
        _log(f"結果：已套用 {len(pending)} 個 migration。")
        return 0

    except db.DatabaseNotConfigured as exc:
        _log('')
        _log(f"資料庫未設定：{exc}")
        return 3
    except Exception as exc:  # noqa: BLE001
        _log('')
        _log(f"套用失敗：{type(exc).__name__}: {exc}")
        return 1
    finally:
        db.close_pool()


if __name__ == '__main__':
    sys.exit(main())
