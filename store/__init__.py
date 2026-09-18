"""資料存取層。

目前提供 PostgreSQL 實作（`pg_store`）。app.py 仍走原本的地端 JSON 檔案，
等 Phase 2 再把路由切過來，切換開關是環境變數 `DATA_BACKEND`：

    DATA_BACKEND=json       地端 JSON 檔案（預設，行為與現在完全相同）
    DATA_BACKEND=postgres   PostgreSQL

分兩階段是刻意的：這一版只負責把資料搬進 PostgreSQL 並用 dataset_revision
的 hash 證明零失真，不動任何既有行為，確認無誤後再切讀、再切寫。
"""

from db import backend_name  # noqa: F401  （對外沿用同一個判斷函式）

__all__ = ['backend_name']
