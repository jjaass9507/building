"""PostgreSQL 連線管理。

設計重點：

* **延遲初始化**：import 這個模組不會連線。`DATA_BACKEND=json` 時整個連線池
  不會被建立，本機沒有 PostgreSQL 也能照常開發。
* **密碼不進 DSN**：連線字串本身不含密碼（密碼走 PGPASSWORD），
  所以 DSN 可以安心寫進 log 與錯誤訊息。
* **.env 由這裡載入**：沿用公司其他 IIS 服務的慣例，機密放部署機的 `.env`，
  不進版控、不寫在 web.config 裡（web.config 是進版控的）。
* **連線檢查**：IIS 應用程式集區回收、DB 端斷線之後，池子裡可能留著死連線，
  所以借出前一律 check 一次。
"""

import logging
import os
from contextlib import contextmanager

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# .env 是選配：沒有 python-dotenv 或沒有 .env 檔時就純粹讀系統環境變數。
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(_BASE_DIR, '.env'))
except ImportError:  # pragma: no cover - 部署機一定會裝，本機可略過
    pass


class DatabaseNotConfigured(RuntimeError):
    """沒有設定連線資訊，或 psycopg 沒安裝。"""


def _env(name, default=''):
    value = os.environ.get(name, default)
    return value.strip() if isinstance(value, str) else value


def _env_int(name, default):
    raw = _env(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        logging.warning("環境變數 %s 不是整數（%r），改用預設值 %s", name, raw, default)
        return default


def backend_name():
    """目前使用的資料來源：'json'（地端檔案）或 'postgres'。"""
    return (_env('DATA_BACKEND', 'json') or 'json').lower()


def build_conninfo():
    """組出不含密碼的連線字串。

    優先用 BUILDING_DB_DSN；沒設定時用標準 libpq 的 PG* 變數組。
    密碼永遠走 PGPASSWORD 環境變數，不放進這個字串。
    """
    dsn = _env('BUILDING_DB_DSN')
    if dsn:
        return dsn

    host = _env('PGHOST')
    dbname = _env('PGDATABASE')
    user = _env('PGUSER')
    if not (host and dbname and user):
        raise DatabaseNotConfigured(
            "缺少資料庫連線設定。請設定 BUILDING_DB_DSN，"
            "或同時設定 PGHOST / PGDATABASE / PGUSER（密碼放 PGPASSWORD）。"
        )

    parts = [
        f"host={host}",
        f"port={_env('PGPORT', '5432')}",
        f"dbname={dbname}",
        f"user={user}",
        # 公司內網也走 TLS；scram-sha-256 搭配 channel binding 可防中間人轉發驗證。
        f"sslmode={_env('PGSSLMODE', 'require')}",
        f"application_name={_env('PGAPPNAME', 'building-platform')}",
        # 連不上時不要卡著整個 request
        f"connect_timeout={_env_int('PGCONNECT_TIMEOUT', 10)}",
    ]
    channel_binding = _env('PGCHANNELBINDING')
    if channel_binding:
        parts.append(f"channel_binding={channel_binding}")
    return ' '.join(parts)


def describe_target():
    """給 log 與檢查腳本用的簡短描述，不含任何機密。"""
    try:
        conninfo = build_conninfo()
    except DatabaseNotConfigured as exc:
        return f"(未設定: {exc})"
    # BUILDING_DB_DSN 可能被人直接塞了密碼，保險起見過濾掉
    return ' '.join(
        token for token in conninfo.split()
        if not token.lower().startswith('password=')
    )


_pool = None


def get_pool():
    """取得（必要時建立）連線池。"""
    global _pool
    if _pool is not None:
        return _pool

    try:
        from psycopg_pool import ConnectionPool
    except ImportError as exc:  # pragma: no cover
        raise DatabaseNotConfigured(
            "沒有安裝 psycopg，無法使用 PostgreSQL。請安裝 psycopg[binary] 與 psycopg-pool。"
        ) from exc

    conninfo = build_conninfo()
    max_size = _env_int('BUILDING_DB_POOL_MAX', 8)
    min_size = min(_env_int('BUILDING_DB_POOL_MIN', 1), max_size)

    _pool = ConnectionPool(
        conninfo=conninfo,
        min_size=min_size,
        max_size=max_size,
        # AppPool 回收或 DB 重啟後池子裡會留死連線，借出前先確認還活著
        check=ConnectionPool.check_connection,
        # 連不上時不要無限等待，讓 request 快速失敗並落到降級路徑
        timeout=_env_int('BUILDING_DB_POOL_TIMEOUT', 15),
        open=True,
        name='building-platform',
    )
    logging.info("PostgreSQL 連線池已建立：%s", describe_target())
    return _pool


def close_pool():
    """關閉連線池（測試與腳本結束時用）。"""
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


@contextmanager
def connection():
    """借一條連線，autocommit 關閉，離開時自動 commit／rollback。"""
    with get_pool().connection() as conn:
        yield conn


@contextmanager
def transaction():
    """在單一交易內執行，回傳 cursor。

    離開 with 區塊時正常結束就 commit，丟例外就 rollback。
    """
    with get_pool().connection() as conn:
        with conn.transaction():
            with conn.cursor() as cur:
                yield cur


def ping():
    """回傳 (是否連得上, 說明字串)，給健康檢查與部署檢查腳本用。"""
    try:
        with connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT version()")
                version = cur.fetchone()[0]
        return True, version
    except DatabaseNotConfigured as exc:
        return False, str(exc)
    except Exception as exc:  # noqa: BLE001 - 這裡就是要把任何連線問題轉成訊息
        return False, f"{type(exc).__name__}: {exc}"


def applied_migrations():
    """已套用的 migration 版本清單。找不到表時回傳空 list。"""
    with connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass('building_mgmt.schema_migrations')")
            if cur.fetchone()[0] is None:
                return []
            cur.execute(
                "SELECT version FROM building_mgmt.schema_migrations ORDER BY version"
            )
            return [row[0] for row in cur.fetchall()]
