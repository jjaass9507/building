# 工作紀錄

記錄「PostgreSQL 串接 + IIS 部署方式更新」這條線的設計決策與已完成的工作。
目的是讓之後接手的人知道**為什麼這樣做**，而不只是做了什麼。

相關文件：

- [`HANDOFF.md`](HANDOFF.md) — 目前狀態、待辦事項與下一步
- [`README.md`](README.md) — 使用與部署說明

---

## 背景

原本的平台把所有資料放在地端 JSON 檔案（`data.json` 等 7 份），
以 IIS + wfastcgi 部署，掛成 `Default Web Site` 底下的子應用程式。

這次要做兩件事：

1. 把資料改存進公司既有的 PostgreSQL 18 主機
2. 部署方式改成與公司其他 Python 服務一致（HttpPlatformHandler + Waitress）

---

## 分階段計畫

刻意切成小步，每一步都能獨立驗收、獨立回退。

| Phase | 內容 | 狀態 |
|---|---|---|
| 0 | schema、連線層、migration 機制 | ✅ 完成 |
| 1 | 資料匯入與 hash 驗收 | ✅ 完成 |
| 2 | `app.py` 讀寫切到 store 層，支援雙寫 | ✅ 完成 |
| 3 | 停掉 JSON 鏡射（`DATA_MIRROR_JSON=false`） | ⬜ 待資料庫穩定後 |
| 4 | 權限（`permissions.json`）進資料庫 | ⬜ 未開始 |
| 5 | 存取紀錄（`access_log.txt`）進資料庫 | ⬜ 未開始 |

---

## 核心設計決策

### 1. 關聯式為主，JSONB 只用在稽核快照

年度成長趨勢、製程分群、面積佔比這些分析本質上都是 group by + sum，
關聯式做這些是幾行 SQL。把整包 JSON 塞進一個 `jsonb` 欄位等於把資料庫當檔案系統用。

但 `data_backups/` 的「整包還原」語意有價值，所以用
`building_mgmt.dataset_snapshots(revision, doc jsonb)` 保留，兩全。

### 2. 不做 SCD-2 時序表

年度資訊是 `floors` 的**欄位**（`預計成廠年份`），不是紀錄的生效期間。
做時序表會讓每個查詢都要加 `WHERE valid_to IS NULL`，複雜度翻倍卻換不到東西。
「現況表 + 快照表 + 異動 log」已涵蓋現有的稽核需求。

### 3. 面積一律 `numeric` 不用浮點數

畫面到處在做 SUM 與百分比，浮點誤差會累積成對不起來的總計。

### 4. 樂觀鎖沿用既有的 `dataset_revision`

存檔時對 `dataset_state` 下條件式 UPDATE，影響 0 列就回 409，
行為與檔案版完全一致。這一列的 row lock 同時序列化了後續所有寫入，
不需要額外的 advisory lock。

PG 18 可以用 `UPDATE ... RETURNING OLD.revision` 一次往返完成
「比對 revision」與「取得異動前的 revision」。較舊的版本改用
`SELECT ... FOR UPDATE` 再 UPDATE，取得的是同一把 row lock，只差一次往返。

### 5. 欄位命名沿用既有的 Excel 對照

`build_standard_workbook()` 早就把中文欄位對到英文 snake_case
（`building_master` / `floor_area_detail`）。那份就是現成的 schema，
不需要重新命名，Excel 匯出、資料表、對外 view 三者同一套語意。

### 6. 廠務設施明細用長表不用寬欄位

`_facility_value()` 實際接受**任意 key 的 dict**，長表才是忠實對應。
要寬表給 Excel / BI 時由 view 做 pivot。

### 7. store 層的硬約束：回傳結構必須與 JSON 檔完全相同

`pg_store.load_current_data()` 回傳的巢狀中文 JSON 必須與 `data.json`
逐鍵相同。守住這條，前端 `data.js`、Excel 匯出、既有測試就一行都不用改，
驗收也只需要比對 `dataset_revision()` 的 sha256。

### 8. 單一 schema + `v_` 前綴（2026-09-22 調整）

原本分 `building` / `building_api` 兩個 schema。改成 `building_mgmt` 單一 schema，
表與 view 靠 `v_` 前綴區分，因為在共用的資料庫主機上要一眼看出是哪個系統的資料。

代價是隔離方式必須改：原本靠「不給內部 schema 的 USAGE」，
現在改成**逐一授權 `v_` 開頭的 view**。`003` 最後加了一段防呆——
只要有非 `v_` 開頭的物件被授權給 reader，migration 直接失敗。

### 9. 部署改成 HttpPlatformHandler + Waitress

wfastcgi 已停止維護，Microsoft 官方建議改用 HttpPlatformHandler，
公司其他 Python 服務也都是這個架構。`app.py` 不用改，
它早就支援 `X-IIS-WindowsAuthToken`。

---

## 已完成的工作

### Phase 0 + 1（commit `a281c90`）

- `migrations/001_init.sql`：主表、廠務設施長表、製程分群、需求趨勢、權限、
  版本快照、稽核、按月分割的存取紀錄
- `migrations/002_views.sql`：7 個對外 view
- `migrations/003_roles_grants.sql`：角色與授權
- `db.py`：延遲初始化的連線池，連線字串不含密碼
- `store/pg_store.py`：以 `json_agg` 在資料庫端組出巢狀結構，`MERGE` 寫入
- `scripts/run_migrations.py`、`scripts/migrate_json_to_pg.py`
- IIS 從 wfastcgi 改為 HttpPlatformHandler，新增 `wsgi.py`
- `scripts/deploy-iis.ps1`、`scripts/run-migrations.ps1`

### Phase 2（commit `c52dc98`）

- `store/json_store.py`：把 `app.py` 的檔案讀寫原封搬過來（搬移不是重寫）
- `store/__init__.py`：依 `DATA_BACKEND` 分派，`postgres` 模式下寫入鏡射回 JSON
- `app.py` 不再直接碰檔案，全部走 `store.*`
- 新增 `tests/test_backend_parity.py`：同一串操作跑在兩種 backend 上逐一比對回應

### 部署工具強化

| commit | 內容 |
|---|---|
| `ca9485e` | 平行部署保護：名稱／連接埠／集區衝突都在建立任何東西前擋下 |
| `6f9d94f` | 支援 IIS 子應用程式；新增 `switch-site.ps1` 正式切換腳本 |
| `a953004` | `deploy-iis.ps1` 加 `-WhatIfOnly` 預演模式 |
| `a13ca75` | `build-offline-bundle.ps1` 離線打包並驗證 |
| `bd18286` | 內網環境的防呆訊息 |

### 資料庫調整

| commit | 內容 |
|---|---|
| `6d85555` | 欄位字典改為單一定義處，Excel 匯出改查資料表 |
| `e02999d` | schema 改名 `building_mgmt`，合併成單一 schema |
| `fe12e7e` | 建立 `svc_building_mgmt_rw` / `svc_building_mgmt_migrator` 兩個服務帳號 |

---

## 開發過程中發現並修掉的問題

這些都是實際跑起來才撞到的，記下來避免重蹈覆轍。

### 資料庫

1. **`utility_trends` 過一趟資料庫會多出 `description` 欄位**
   一致性測試抓到的。`pg_store` 原本用固定欄位重建 top-level，
   改成原樣保存 `metrics` 以外的所有欄位。

2. **`CREATE SCHEMA IF NOT EXISTS` 即使 schema 已存在也需要資料庫層級的 CREATE 權限**
   migrator 帳號只有 schema 擁有權，日常 migration 會被擋。
   改成先 `to_regnamespace()` 檢查再建立。

3. **`ALTER SCHEMA OWNER` 不會改既有物件的擁有權**
   若 001/002 是 DBA 的管理帳號先跑的，migrator 之後連 `schema_migrations`
   都寫不進去。`003` 增加一段把 schema 內所有物件的擁有權整批歸位。

4. **identity 序列不能單獨改擁有者**
   上一條的歸位對 identity 序列會失敗（PostgreSQL 擋下 linked to table 的序列），
   整個 `003` 因此 rollback。改成排除依附母表的序列。

### 部署腳本

5. **原本會誤蓋既有站台**
   `-SiteName` 打到既有站台時，腳本會直接把它的 `physicalPath` 改指到新目錄，
   等於接管線上服務，而且沒有任何提示。現在會直接中止。

6. **`iisreset` 會重啟整台機器的所有站台**
   平行部署時這代表既有服務也斷線。改成預設只重啟本次的應用程式集區。

7. **`web.config` 少了 `APP_URL_PREFIX`**
   本專案掛成子應用程式，少這一項每一頁都是 404。而且原本的平行部署方式
   （臨時改成獨立網站）根本不會走到那段邏輯，要到切換當天才第一次執行。

### 測試

8. **`.env` 設成 postgres 之後，路由測試會跑去連資料庫而失敗**
   那組測試驗的是檔案版，現在把 `DATA_BACKEND=json` 釘住。

9. **一致性測試用 `TRUNCATE` 等於沒驗到真實權限**
   `TRUNCATE` 需要表的擁有權，但應用程式實際用的 `svc_building_mgmt_rw`
   只有 DML。改用 `DELETE`。

### 工具

10. **Python 改寫檔案時把 `app.py` 從 CRLF 轉成 LF**
    整個檔案變成 diff，掩蓋了真正的變更。已還原（本 repo 只有 `app.py` 用 CRLF）。

---

## 驗證方式

### 資料匯入：hash 相等

驗收條件刻意用專案既有的 `dataset_revision()`——它是整包資料的 sha256：

```
dataset_revision(從 PostgreSQL 讀回來) == dataset_revision(從 data.json 讀)
```

hash 相同就代表沒有任何欄位在搬運途中走樣，不需要另外寫一整套逐欄位比對。

### 行為一致性：逐一比對 API 回應

`tests/test_backend_parity.py` 把同一串操作（讀取、資料維護、樂觀鎖衝突、
製程分群、需求趨勢、Excel 匯出）分別跑在兩種 backend 上，逐一比對回應，
並確認鏡射回 JSON 的內容與純檔案模式相同。

### 權限邊界

以 `svc_building_mgmt_rw` 實際連線測試：讀表、寫表、查 view 通過；
建表、刪表、改欄位全部被拒。外部唯讀帳號只拿得到 7 個 view，19 個內部表全擋。

### 目前的測試結果

| 情境 | 結果 |
|---|---|
| `DATA_BACKEND=json` | 15 passed, 2 skipped |
| 含資料庫（以 rw 帳號） | 17 passed |
| JS 測試 | 5 個全過 |
| 資料匯入 hash 驗收 | 全數通過 |

---

## 沒有做的事（刻意）

- **沒有做完整的時序／版本查詢**：見決策 2
- **沒有把 CDN 資源本地化**：Tailwind / Lucide / Chart.js / xlsx 仍走 CDN。
  那些是**瀏覽器**載入的，Server 連不到外網不影響。但若使用者端也連不到，
  就需要本地化——那是獨立的一件事（Tailwind CDN 是 JIT 編譯器，
  本地化需要加建置步驟）。
- **權限與存取紀錄還沒進資料庫**：Phase 4 / 5，表已經建好但程式沒接。
