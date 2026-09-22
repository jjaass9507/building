# 交接說明

這份文件是給**接手繼續做下去的人**看的：目前做到哪、下一步做什麼、
哪些東西還沒被真正驗證過、還有哪些事要問人。

- 設計決策與過程 → [`WORKLOG.md`](WORKLOG.md)
- 操作與部署細節 → [`README.md`](README.md)

分支：`claude/confident-dirac-ryha2o`（尚未合併回 main）

---

## 一句話現況

程式與 SQL 都寫完也驗過了，**但只在 Linux 容器 + PostgreSQL 16 上驗過**；
所有 PowerShell 部署腳本一次都沒有在 Windows 上執行過。
正式機尚未部署，資料仍然是 JSON 檔在跑。

---

## 做完了什麼

| 項目 | 狀態 |
|---|---|
| `building_mgmt` schema（表、view、角色授權） | ✅ 寫完並實測套用 |
| 地端 JSON → PostgreSQL 匯入與 hash 驗收 | ✅ 實測通過 |
| `store/` 資料存取層（`json` / `postgres` 雙 backend） | ✅ 完成 |
| `app.py` 改走 store 層，PostgreSQL 模式下雙寫 JSON | ✅ 完成 |
| 兩種 backend 的行為一致性測試 | ✅ 全數通過 |
| 部署方式改為 HttpPlatformHandler + Waitress | ⚠️ 寫完，未在 Windows 執行過 |
| 平行部署 / 正式切換 / 離線打包腳本 | ⚠️ 寫完，未在 Windows 執行過 |

測試結果：

| 情境 | 結果 |
|---|---|
| `DATA_BACKEND=json` | 15 passed, 2 skipped |
| 含資料庫（以 `svc_building_mgmt_rw` 連線） | 17 passed |
| JS 測試 | 5 個全過 |

---

## ⚠️ 還沒被真正驗證的部分

這幾項是接手後**第一批要親手確認**的，不要當成已經沒問題：

### 1. 所有 PowerShell 腳本都沒有在 Windows 上跑過

`deploy-iis.ps1`、`switch-site.ps1`、`build-offline-bundle.ps1`、
`create-db-users.ps1`、`check-deployment.ps1`、`run-migrations.ps1`
都是在 Linux 容器裡寫的，語法有檢查過，但**沒有任何一次實際執行**。

因此正式機上第一次執行時，請一律先用預演模式：

```powershell
.\scripts\deploy-iis.ps1 ... -WhatIfOnly
.\scripts\switch-site.ps1 ... -WhatIfOnly
```

`run-migrations.ps1` 對應的是 `-DryRun`。

腳本目標環境是 **PowerShell 5.1**（Windows Server 內建版本），
已避開 7.x 才有的語法；若發現相容性問題，方向往這裡找。

### 2. PG 18 的 `RETURNING OLD` 沒有在真的 PG 18 上跑過

開發容器裝不到 PG 18（PGDG 的 apt 來源被 proxy 擋住），實際驗證用的是 PG 16。

`store/pg_store.py:346` 會依 `server_version` 分支：

- `>= 180000` → `UPDATE ... RETURNING OLD.revision`
- 其他 → `SELECT ... FOR UPDATE` 再 UPDATE（**這條才是實際驗過的那條**）

兩條路徑拿的是同一把 row lock，語意相同，但接到正式機的 PG 18 之後，
請務必實際觸發一次樂觀鎖衝突（兩個瀏覽器同時開資料維護，都存檔）
確認會回 HTTP 409。這是唯一只在 PG 18 上才會走到的程式碼路徑。

### 3. 正式機的 `utility_trends.json` 欄位沒有比對過

一致性測試用的是專案內的測試資料。正式機那份的欄位若與測試資料不同，
`pg_store` 對 `utility_trends` 的存取可能漏欄位。

驗證方法很簡單 —— 匯入後跑 hash 驗收即可，不相等就是有欄位走樣：

```powershell
.\scripts\run-migrations.ps1 -VerifyOnly
```

### 4. 離線打包只驗到「下載得到 wheel」

`pip download` 在容器內確認過會產出 21 個 `win_amd64` wheel、零個 sdist，
但**驗證步驟（建 venv、`--no-index` 安裝、`pip check`、import）本身沒跑過**，
因為容器不是 Windows。打包當天請在**可連網的 Windows 開發機**上跑完整流程。

---

## 下一步：正式機部署順序

使用者的環境：**只有正式機、沒有測試機**，正式機**連不到外網**，
平台掛在 `Default Web Site` 底下的子應用程式（情境 B）。

因此策略是：**平行部署到另一個路徑先驗，驗完再切換。**

### Step 1　開發機（可連網）離線打包

```powershell
# 先確認正式機的 Python 版本，兩邊必須一致
.\scripts\build-offline-bundle.ps1 -PythonVersion 3.11 -Zip
```

另外手動下載兩個腳本抓不到的東西帶進內網：

| 項目 | 來源 |
|---|---|
| Python Windows 安裝程式 | <https://www.python.org/downloads/windows/>（**務必勾 Install for all users**） |
| HttpPlatformHandler v2.0 MSI | <https://www.iis.net/downloads/microsoft/httpplatformhandler> |

### Step 2　正式機：建立資料庫帳號

資料庫用公司既有的主機，只需要新增兩個服務帳號：

```powershell
.\scripts\create-db-users.ps1 -AdminUser postgres
```

需要 CREATEROLE 權限。密碼由互動式輸入，不落檔案也不進指令歷史。

**要先請 DBA 做**（migrator 第一次建 schema 需要資料庫層級的 CREATE）：

```sql
GRANT CREATE, CONNECT ON DATABASE <資料庫名> TO svc_building_mgmt_migrator;
```

### Step 3　正式機：平行部署到 `/building_platform_v2`

```powershell
.\scripts\deploy-iis.ps1 -Offline `
    -AppRoot    "D:\WebServices\BuildingPlatform-v2" `
    -ParentSite "Default Web Site" `
    -AppPath    "building_platform_v2" `
    -SeedFrom   "D:\WebServices\BuildingPlatform" `
    -WhatIfOnly        # 先預演，確認無誤再拿掉這行
```

腳本對平行部署有三道保護（名稱／連接埠／應用程式集區撞到既有站台就直接中止），
但第一次還是請先預演。`-SeedFrom` 是**複製**不是共用。

> 用「同樣掛成子應用程式、只換路徑」的方式驗，不要臨時改成獨立網站 ——
> 這樣路徑前綴、驗證設定、前端 `APP_BASE` 才會走到跟正式環境相同的程式碼路徑。

### Step 4　正式機：建 schema、匯資料

```powershell
.\scripts\run-migrations.ps1 -DryRun       # 先看會做什麼
.\scripts\run-migrations.ps1               # 建 schema
.\scripts\run-migrations.ps1 -MigrateData  # 匯入並 hash 驗收
```

`003_roles_grants.sql` 需要 CREATEROLE，由 DBA 執行的話這裡加 `-SkipRoles`。

### Step 5　在 v2 上實測

`.env` 先維持 `DATA_BACKEND=json` 驗一輪（確認部署方式本身沒問題），
再改成 `postgres` 驗第二輪（確認資料庫這條路沒問題）。兩輪都要測：

- 登入（網域內電腦自動 SSO、非網域電腦 AD 帳密）
- 每一頁能開、3D 示意圖能轉
- 資料維護的新增／修改／刪除／搬移樓層
- **樂觀鎖**：兩個瀏覽器同時開，都存檔 → 第二個要回 409
- 兩種 Excel 匯出都能下載且能重新上傳
- `scripts\check-deployment.ps1 -SiteName ...` 沒有 FAIL

### Step 6　正式切換

```powershell
.\scripts\switch-site.ps1 `
    -ParentSite "Default Web Site" `
    -AppPath    "building_platform" `
    -NewRoot    "D:\WebServices\BuildingPlatform-v2" `
    -NewAppPool "Pool-BuildingPlatform-v2" `
    -WhatIfOnly        # 先預演
```

腳本 9 個步驟中任何一步失敗都會自動回退。**第 3 步（停舊版後再同步資料）
的順序不能反** —— 平行驗證期間舊版的資料已經往前走，不先同步就切過去會吃掉那段異動。

回退指令見 README 的「正式切換」章節。舊目錄腳本不會刪，跑順一兩週再清。

---

## 還沒接、但表已經建好的功能

| Phase | 內容 | 現況 |
|---|---|---|
| 3 | 停掉 JSON 鏡射（`DATA_MIRROR_JSON=false`） | 測試已經涵蓋這個行為，等資料庫穩定後改設定即可 |
| 4 | 權限（`permissions.json`）改讀資料庫 | `building_mgmt.user_roles`／`user_role_changes` 已建好，`pg_store.find_role()` 也寫好了，但 `app.py` 還是讀檔案 |
| 5 | 存取紀錄（`access_log.txt`）改寫資料庫 | `building_mgmt.access_log`（按月分割）與 `pg_store.append_access_log()` 已備妥，`app.py` 還是寫檔案 |

Phase 4 / 5 都是「表和函式都在了，只差把 `app.py` 接過去」。
刻意沒一次做完，是為了讓這次的變更範圍收在「資料搬家」而不是「順便改權限模型」。

---

## 要確認的事

### 要問 DBA

- [ ] `GRANT CREATE, CONNECT ON DATABASE <資料庫名> TO svc_building_mgmt_migrator;`（Step 2 的前置）
- [ ] 資料庫的 encoding 是不是 UTF8、locale provider 為何
- [ ] 這台主機的連線數上限，與 `.env` 的 `BUILDING_DB_POOL_MAX`（預設 8）是否衝突
  —— IIS 每個 worker process 都有自己的連線池，要一起算
- [ ] 備份策略是否已涵蓋新的 `building_mgmt` schema
- [ ] 是否強制 SSL（`.env` 預設 `PGSSLMODE=require` + `PGCHANNELBINDING=require`，
  若主機沒開會連不上）
- [ ] 外部 BI 若要接，由 DBA 建帳號後 `GRANT` 進 `building_mgmt_reader` 群組

### 要自己確認

- [ ] 把舊 `web.config` 的 AD 設定（`AD_SERVER` / `AD_DOMAIN` / `AD_NETBIOS`）抄到新的
  —— 新的 `web.config` 是重寫的，這幾項是空的
- [ ] **使用者端的瀏覽器**能不能連到 4 個 CDN（Tailwind / Lucide / Chart.js / xlsx）。
  Server 連不到外網不影響，因為那是瀏覽器載入的；但若使用者端也連不到，
  就需要把資源本地化 —— 那是獨立的一件事，Tailwind CDN 是 JIT 編譯器，
  本地化要加建置步驟，不是把檔案抓下來放著就好
- [ ] 正式機的 `permissions.json` 內容要跟著複製過去（`-SeedFrom` 會帶，但請確認）

---

## 幾個容易踩到的地雷

1. **`APP_URL_PREFIX` 沒填 → 每一頁 404。**
   掛成子應用程式時必填，`deploy-iis.ps1` 的 `-AppPath` 會自動填進 `web.config`。
   手動改 `web.config` 的話不要漏掉。

2. **venv 不能搬。**
   建立時會寫死 Python 絕對路徑，複製到別的路徑或機器一定壞
   （`Fatal error in launcher`）。搬的是原始碼與 `wheels\`，venv 在最終路徑重建。

3. **Python 必須勾「Install for all users」。**
   裝在 `C:\Users\...\AppData\` 底下的 Python，IIS 應用程式集區帳號讀不到，
   程序永遠起不來（IIS 回 502）。

4. **資料庫密碼不要寫進 `web.config`。**
   那個檔案有進版控。連線資訊放部署機的 `.env`（已列入 `.gitignore`）。
   `check-deployment.ps1` 偵測到密碼出現在 `web.config` 會直接 FAIL。

5. **`app.py` 是這個 repo 裡唯一使用 CRLF 的檔案。**
   用工具改寫它時注意不要轉成 LF，否則整個檔案都會變成 diff。

6. **新增 view 時要同步補 `003_roles_grants.sql` 的授權清單。**
   表與 view 同在一個 schema，隔離靠的是逐一授權 `v_` 開頭的 view，
   不是靠「不給 USAGE」。漏補的話外部帳號看不到新 view。

---

## 檔案地圖（這次新增／大改的）

```text
db.py                          PostgreSQL 連線池、.env 載入、連線字串（不含密碼）
store/__init__.py              門面：依 DATA_BACKEND 分派，處理雙寫
store/json_store.py            地端 JSON（由 app.py 原封搬過來）
store/pg_store.py              PostgreSQL（回傳結構必須與 data.json 完全相同）
wsgi.py                        Waitress / HttpPlatformHandler 進入點

migrations/001_init.sql        building_mgmt schema 的所有表
migrations/002_views.sql       7 個對外 v_ view
migrations/003_roles_grants.sql 角色、擁有權歸位、授權與防呆

scripts/run_migrations.py      migration 執行器（含欄位字典同步）
scripts/migrate_json_to_pg.py  JSON → PG 匯入與 hash 驗收
scripts/create_db_users.py     互動式建立服務帳號
scripts/deploy-iis.ps1         部署（獨立網站或子應用程式）
scripts/switch-site.ps1        正式切換，失敗自動回退
scripts/build-offline-bundle.ps1 離線打包並驗證

tests/test_backend_parity.py   兩種 backend 的行為一致性
tests/test_pg_store_mapping.py pg_store 的純函式對應（不需要資料庫）
```
