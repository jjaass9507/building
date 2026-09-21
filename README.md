# 建物管理平台

建物管理平台是一個以 **Flask + Tailwind CSS + Vanilla JavaScript** 建置的建物資訊視覺化儀表板。系統會讀取建物樓層資料，整理成可互動的矩陣式看板，協助快速查看各廠棟、樓層、面積配置、無塵室面積、生產週邊、廠務設施、公設與樓高等資訊。

---

## 專案特色

- **建物矩陣視覺化**：以廠棟為欄、樓層為列，呈現各樓層空間資訊。
- **多種顯示模式**：可切換「面積」、「樓高」、「製程」檢視模式。
- **面積單位切換**：支援 `m²` 與 `坪` 兩種顯示單位。
- **比例 / 數值切換**：面積堆疊條可切換顯示比例或實際數值。
- **已成廠 / 未成廠篩選**：可選擇是否將未成廠資料納入總計。
- **廠棟篩選**：支援全部廠棟或單一 / 多廠棟篩選。
- **深色模式**：支援 light / dark theme，並透過 `localStorage` 記憶使用者偏好。
- **側邊資訊面板**：點擊樓層或廠棟後，可顯示更詳細的資料摘要。
- **單棟 3D 示意圖**：由現有樓層資料自動堆疊單棟模型，可旋轉、縮放、展開樓層並點選查看空間組成。
- **Windows AD 身份辨識**：透過 IIS Windows Integrated Authentication 取得 `REMOTE_USER`。
- **角色權限控管**：透過 `permissions.json` 設定 `admin`、`user`、`viewer`。
- **Admin 網頁上傳更新資料**：admin 可直接在頁面上傳樓層面積 Excel，系統自動清洗並更新 `data.json`。
- **Admin 表格式資料維護**：管理人員可在接近原始 Excel 欄位順序的介面新增、修改、移動或刪除建物與樓層資料。
- **雙格式 Excel 匯出**：提供可重新上傳的人員閱讀版，以及固定工作表、固定英文欄位的標準資料版。
- **異動稽核與衝突防護**：每次平台維護必須填寫生效日期、異動類型與原因，並保留來源、維護人員、面積淨異動與修改摘要；多人同時編輯時阻止舊版本覆蓋新資料。
- **資料版本留存**：每次更新前會先把上一版 `data.json` 備份到 `data_backups/`。
- **IIS 部署支援**：HttpPlatformHandler + Waitress，已包含 `web.config` 範例與一鍵部署腳本。
- **存取紀錄**：後端會記錄使用者帳號、IP、操作、上傳與權限拒絕紀錄至 `access_log.txt`。

---

## 技術架構

### 後端

- Python
- Flask
- Waitress（WSGI server）
- Pandas
- OpenPyXL
- JSON API
- PostgreSQL 18 + psycopg 3（可選資料來源，見「PostgreSQL 資料庫」章節）
- IIS HttpPlatformHandler 部署設定
- Windows Integrated Authentication / `REMOTE_USER`
- Role-Based Access Control（`permissions.json` 或資料庫）

### 前端

- HTML
- Tailwind CSS CDN
- Lucide Icons CDN
- Vanilla JavaScript ES Modules
- LocalStorage theme state

---

## 目錄結構

```text
building/
├── app.py
├── wsgi.py                    # Waitress / HttpPlatformHandler 進入點
├── db.py                      # PostgreSQL 連線池與 .env 載入
├── data_processor.py          # Excel 清洗與 data.json 轉換邏輯
├── building_data_manager.py   # 資料驗證、版本、稽核與雙格式 Excel 匯出
├── web.config
├── README.md
├── requirements.txt
├── .env.example               # 部署機環境設定範本（複製成 .env 後填寫）
├── .env                       # 資料庫帳密等機密，不納入版控
├── permissions.json           # 角色權限設定檔
├── data.json                  # 執行時資料檔，需自行放置於專案根目錄
├── data_changes.json          # 平台資料維護異動紀錄，不納入版控
├── access_log.txt             # 執行後自動產生的使用者存取紀錄
├── app.log                    # 應用程式 log
├── secret_key.txt             # 登入 session 簽章金鑰，首次啟動自動產生，不納入版控
├── migrations/                # PostgreSQL schema migration
│   ├── 001_init.sql           # building schema：主表、稽核、權限、存取紀錄
│   ├── 002_views.sql          # building_api schema：對外 view 層
│   └── 003_roles_grants.sql   # 角色與授權（需要 CREATEROLE，通常由 DBA 執行）
├── store/                     # 資料存取層，app.py 只透過這裡讀寫
│   ├── __init__.py            # 門面：依 DATA_BACKEND 分派，並處理雙寫
│   ├── json_store.py          # 地端 JSON 檔案
│   └── pg_store.py            # PostgreSQL（回傳結構與 JSON 檔完全相同）
├── scripts/
│   ├── deploy-iis.ps1         # IIS 部署（獨立網站或子應用程式）
│   ├── switch-site.ps1        # 正式切換：把線上網址改指到新版，失敗自動回退
│   ├── run-migrations.ps1     # 套用 schema、匯入資料與 hash 驗收
│   ├── run_migrations.py      # migration 執行器
│   ├── migrate_json_to_pg.py  # 地端 JSON → PostgreSQL 匯入與驗收
│   ├── check-deployment.ps1   # 部署前後環境自動檢查
│   └── setup-ad-login.ps1     # 設定 IIS 驗證（匿名 + Windows 並存）
├── logs/                      # HttpPlatformHandler 的 stdout log，不納入版控
├── wheels/                    # 離線部署用的 wheel 套件，不納入版控
├── venv/                      # 部署機的虛擬環境，不納入版控也不可搬移
├── uploads/                   # admin 上傳的原始 Excel 留存，不納入版控
├── processed/                 # 清洗後 Excel 與暫存 JSON，不納入版控
├── data_backups/              # data.json 舊版備份，不納入版控
├── templates/
│   ├── index.html
│   ├── login.html             # 登入畫面（Windows SSO + AD 帳密登入）
│   └── 403.html               # 無權限存取頁面
└── static/
    ├── css/
    │   └── style.css
    └── js/
        ├── main.js
        ├── building-data-admin.js # Admin 表格式資料維護介面
        ├── building-3d.js      # 單棟 3D 樓層模型與互動
        ├── data.js
        ├── utils.js
        └── components.js
```

> 注意：`data.json`、`access_log.txt`、`app.log`、`uploads/`、`processed/`、`data_backups/` 是執行或部署時產生 / 放置的資料，不建議納入版控。

---

## 核心檔案說明

### `app.py`

Flask 後端主程式，負責：

- 初始化 Flask app
- 判斷目前是 Python 腳本模式或 EXE 打包模式
- 設定 `templates` 與 `static` 路徑
- 提供首頁 `/`
- 提供目前使用者 API `/api/me`
- 提供資料 API `/api/data`
- 提供雙格式 Excel 匯出 API `/api/export-data/<export_mode>`
- 提供 admin 資料維護 API `/api/admin/building-data`
- 提供 admin 上傳 API `/api/admin/upload-data`
- 讀取根目錄下的 `data.json`
- 讀取根目錄下的 `permissions.json`
- 透過 `REMOTE_USER` / Windows token 取得 Windows AD 使用者（單一登入）
- 沒有 Windows 身分時導向 `/login` 登入畫面，並以 `ldap3` 驗證 AD 帳號密碼
- 依角色檢查使用者是否允許存取頁面 / API
- 上傳 Excel 後先備份上一版 `data.json`，再更新目前資料
- 記錄使用者存取資訊到 `access_log.txt`
- 由 `wsgi.py` 匯出成 `wsgi:application`，供 Waitress / HttpPlatformHandler 啟動

主要路由：

| Route | Method | 權限 | 說明 |
|---|---|---|---|
| `/` | GET | admin / user / viewer | 回傳 `templates/index.html` |
| `/login` | GET | 匿名 | 登入畫面（自動 SSO ＋ AD 帳密表單） |
| `/auth/sso` | GET | 匿名（IIS 端關閉匿名） | Windows 單一登入探測 |
| `/api/auth/status` | GET | 匿名 | 回傳目前登入狀態，永遠 200 |
| `/api/auth/login` | POST | 匿名 | AD 帳號密碼登入 |
| `/api/auth/logout` | POST | 匿名 | 登出（前端呼叫） |
| `/logout` | GET | 匿名 | 登出並回到登入畫面 |
| `/api/me` | GET | admin / user / viewer | 回傳目前使用者帳號與角色 |
| `/api/data` | GET | admin / user / viewer | 讀取 `data.json` 並回傳 JSON |
| `/api/export-data/readable` | GET | admin / user / viewer | 匯出接近原始 Input 的人員閱讀版 Excel，可重新上傳 |
| `/api/export-data/standard` | GET | admin / user / viewer | 匯出固定資料表與英文欄位的標準資料版 Excel，可重新上傳 |
| `/api/admin/building-data` | GET | admin | 讀取可維護資料、revision、筆數與最近異動紀錄 |
| `/api/admin/building-data` | POST | admin | 驗證 revision 後儲存整批建物資料、備份舊版並寫入異動紀錄 |
| `/api/admin/upload-data` | POST | admin | 上傳 Excel，清洗、備份舊版並更新 `data.json` |

---

### `data_processor.py`

Excel 清洗與 JSON 轉換模組，由 `/api/admin/upload-data` 呼叫。

處理流程：

```text
上傳原始 Excel
    ↓
以 header=1 讀取 Excel
    ↓
移除欄位名稱與內容中的換行 / 空白
    ↓
依欄位設定擷取樓層資料與棟別資料
    ↓
補齊缺失的廠務子系統欄位為 0
    ↓
清洗樓層名稱，過濾有效樓層
    ↓
輸出標準格式 Excel 到 processed/
    ↓
將標準格式 Excel 轉成巢狀 JSON
    ↓
輸出新的 data.json
```

目前支援的廠務設施子系統欄位：

```text
純水、廢水、給排水、空調、抽氣、氣體、電力、弱電、消防、監控、監控/弱電/消防
```

若有子系統資料，系統會將 `廠務設施面積(M2)` 轉成：

```json
{
  "value": 1600,
  "details": {
    "純水": 300,
    "廢水": 200,
    "空調": 500,
    "電力": 600
  }
}
```

若母欄位與子系統加總不一致，系統仍會保留資料，並在上傳結果中回傳 warning。

上傳時會自動辨識兩種格式：

- 原始／人員閱讀版：第一張工作表第 2 列是既有中文欄位標題。
- 標準資料版：包含 `building_master` 與 `floor_area_detail` 工作表，以穩定 ID 關聯建物及樓層。

---

## 單棟 3D 示意圖

每一棟建物標題右側都有 `3D` 按鈕，廠棟概況側邊欄也可開啟 3D 示意圖。模型直接使用 `/api/data` 回傳的既有樓層資料，不需要維護第二份模型資料。

- 樓層順序依樓層名稱解析結果排列，地下樓層會位於模型底部。
- 樓板尺寸依各樓層的樓地板面積做相對縮放。
- 以暖白工程圖背景與霧白樓板維持低干擾閱讀；選取樓層使用青綠色，未成廠樓層使用橘色虛線區別。
- 支援滑鼠拖曳旋轉、`Ctrl`＋滾輪縮放、左右旋轉、立體／正視切換與重設視角。
- 點選模型樓層或圖上的樓層標註，可直接查看該層面積、製程、樓高與荷重。
- `ALL` 是樓層未定的全棟規劃資料，只納入彙整，不會建立虛構樓板。

> 此功能是依資料比例產生的資訊示意圖，用於樓層結構與空間配置比較，不代表實際建築外型或 BIM 模型。

### 3D 閱讀介面優化

- 採用方案 C 的暖白工程圖解風格，保留可旋轉、縮放的 CSS 3D 實心量體。
- 所有樓層共用同一核心筒、基座與屋頂，維持單一完整建築；樓層再多也不拆成多段或多欄。
- 樓層包含頂面、正面、側面、窗帶與轉角收邊，呈現清楚的厚度、陰影與空間方向。
- 樓高／荷重／製程／面積一次顯示一種，樓層名稱與指標直接放在該樓層的 3D 正面結構內，與樓層共用同一個 3D transform，旋轉與縮放時不會偏離。
- 移除固定在右側、與模型分離的樓層清單。點選樓層後，完整資料卡會顯示在選取樓層附近。
- 模型依可用高度自動縮放，桌面版盡量在不捲動的情況下呈現完整樓層；不縮小標籤文字來勉強塞入。
- 支援拖曳旋轉、`Ctrl`＋滾輪縮放、左右旋轉、立體／正視切換與重設視角。
- 選取樓層使用青綠色，未成廠樓層使用橘色虛線；支援深色模式。
- 所有功能使用原生 CSS／JavaScript，沒有新增正式套件。

> 圖中樓板間距、厚度與尺寸皆為示意，不用於判斷實際樓高、平面位置或工程尺寸。

---

### `permissions.json`

角色權限設定檔，放在專案根目錄。系統目前支援三種角色：

| 角色 | 說明 |
|---|---|
| `admins` | 系統管理者，可看到網頁上傳資料區塊，並可呼叫 `/api/admin/upload-data` |
| `users` | 一般使用者，可使用主要平台功能 |
| `viewers` | 檢視者，可進入平台查看資料 |

目前格式：

```json
{
  "admins": [
    "Local-Dev"
  ],
  "users": [],
  "viewers": []
}
```

正式部署到 IIS 並啟用 Windows Integrated Authentication 後，帳號通常會是：

```text
DOMAIN\username
```

請依實際 AD 帳號加入，例如：

```json
{
  "admins": [
    "ASE\\mattchen"
  ],
  "users": [
    "ASE\\user01"
  ],
  "viewers": [
    "ASE\\viewer01"
  ]
}
```

> JSON 字串中的反斜線需寫成 `\\`，例如 `ASE\\user01`。

---

## 登入流程（Windows SSO ＋ AD 登入畫面）

```text
使用者開啟平台網址
    ↓
IIS：應用程式根目錄允許匿名 → request 一定進得到 Flask
    ↓
Flask 檢查身分（session 手動登入 → Windows SSO）
    ↓
沒有身分 → 導向 /login 登入畫面
    ↓
登入頁背景呼叫 /auth/sso（IIS 上唯一關閉匿名的路徑）
    ├─ 網域內電腦：自動帶入 Windows 身分 → 無聲登入，直接進系統
    └─ 非網域電腦：跳出 Windows 帳密視窗
           ├─ 使用者輸入 → 完成 SSO 進入系統
           └─ 使用者按取消 → 停留在登入畫面，改輸入 AD 帳號密碼
                    ↓
              POST /api/auth/login → ldap3 SIMPLE bind 驗證 AD 密碼
                    ↓
              驗證成功 → 寫入 session → 進入系統
    ↓
Flask 讀取 permissions.json，比對 admin / user / viewer
    ↓
有權限：進入頁面或 API
無權限：頁面顯示 403.html（附「改用其他 AD 帳號登入」），API 回傳 403 JSON
```

**重點：使用者按掉 Windows 帳密視窗時，不會再看到 IIS 的錯誤畫面，而是本系統的登入頁。**

### 登入相關路由

| 路由 | 用途 | 匿名可存取 |
|---|---|---|
| `GET /login` | 登入畫面（自動 SSO ＋ AD 帳密表單） | ✅ |
| `GET /auth/sso` | Windows SSO 探測，回 `{ok, username, role, authorized}` | ❌（IIS 關閉匿名） |
| `GET /api/auth/status` | 目前登入狀態（永遠回 200） | ✅ |
| `POST /api/auth/login` | AD 帳密登入 `{username, password}` | ✅ |
| `POST /api/auth/logout` | 登出（前端用） | ✅ |
| `GET /logout` | 登出並回到登入畫面（右上角登出按鈕） | ✅ |

> 所有「未登入」的回應一律不使用 HTTP 401。IIS 會攔截 401 並再彈一次 Windows 帳密視窗，
> 所以未登入的 API 回 `403 + {"error": "unauthenticated"}`，前端據此導向登入頁。

### AD 設定（web.config 的 environmentVariables、`.env` 或系統環境變數）

| 設定 | 說明 | 範例 |
|---|---|---|
| `AD_SERVER` | LDAP 位址，用 NetBIOS 網域名最單純 | `ldap://ASE` |
| `AD_DOMAIN` | 完整網域名稱（UPN 格式備援用） | `ase.com.tw` |
| `AD_NETBIOS` | NetBIOS 網域名，留空自動推導 | `ASE` |
| `AD_TIMEOUT` | LDAP 連線逾時秒數（預設 5） | `5` |
| `APP_SECRET_KEY` | session cookie 簽章金鑰；留空會自動產生 `secret_key.txt` | 隨機字串 |
| `APP_SSO_PROBE` | 是否啟用 Windows 單一登入探測（預設 `true`） | `true` / `false` |
| `APP_DEV_USER` | 本機開發用假身分，**正式機請勿設定** | `Local-Dev` |
| `AD_MOCK` | 本機開發用：不連 AD，任何密碼都通過，**正式機請勿設定** | `true` |

AD 密碼驗證使用 `ldap3` 的 **SIMPLE bind**（不是 NTLM）。
Python 3.9+ 搭配 OpenSSL 3.0 已停用 MD4，NTLM bind 會直接失敗（`unsupported hash type MD4`），
SIMPLE bind 不需要 MD4。bind 帳號格式依序嘗試 `NETBIOS\帳號` → `帳號@網域` → `帳號`。

### 帳號比對規則

同一個人在不同來源寫法不同（SSO 是 `ASE\K11879`，手動登入是 `K11879`），
系統比對權限名單時會自動拆解 `網域\帳號`、`帳號@網域`、純帳號三種寫法，
因此 `permissions.json` 填哪一種都可以對得起來。
（權限改由資料庫管理後規則相同：`building.user_roles` 同時存完整寫法與去網域的短寫法，
兩邊都比對，結果與檔案版完全等價。）

### 本機開發

本機沒有 IIS，也就沒有 Windows 身分。直接執行 `python app.py` 時會自動以
`Local-Dev` 身分登入（`permissions.json` 預設把 `Local-Dev` 放在 `admins`）。
若要測試登入畫面本身，可設定環境變數 `AD_MOCK=true` 並清掉 `APP_DEV_USER`。

---

## Admin 資料更新流程

admin 登入後，頁面上方會顯示「資料更新」區塊，可上傳 `.xlsx` 檔案。

系統更新流程：

```text
admin 選擇 Excel
    ↓
POST /api/admin/upload-data
    ↓
儲存原始上傳檔到 uploads/
    ↓
若目前已有 data.json，先複製到 data_backups/
    ↓
使用 data_processor.py 清洗 Excel
    ↓
輸出清洗後 Excel 到 processed/
    ↓
產生新的暫存 JSON
    ↓
轉換成功後覆蓋根目錄 data.json
    ↓
前端重新載入 /api/data 更新畫面
```

備份檔命名格式：

```text
data_YYYYMMDD_HHMMSS_USERNAME.json
```

### 平台資料維護

Admin 可由頁面上方「資料維護」進入表格式編輯器：

1. `樓層面積`：維護樓層、狀態、預計成廠年份、製程、各類面積、廠務子系統、樓高與荷重，也可移動樓層到其他棟別。
2. `建物基本資料`：維護棟別、基地面積、容積率、建蔽率、開挖深度、耐震係數及停車位。
3. `異動紀錄`：查看最近 30 次平台維護的人員、時間、原因與新增／刪除／修改摘要。

儲存時前端會帶入載入資料時的 `revision`。若其他管理人員已先完成儲存，API 回傳 HTTP 409，使用者必須重新載入，避免直接覆蓋較新的資料。

### Excel 匯出格式

| 格式 | 主要工作表 | 用途 |
|---|---|---|
| 人員閱讀版 | `建物面積總表`、`年度新增明細`、`異動紀錄`、`資料說明` | 延續原始 Input 標題位置、欄位順序與棟別群組；第一張工作表可重新上傳 |
| 標準資料版 | `metadata`、`building_master`、`floor_area_detail`、`change_log`、`data_dictionary` | 系統交換、資料分析與再次匯入；面積固定使用 m² |

平台資料首次經由維護功能儲存後，會在建物與樓層資料中加入 `_building_id`、`_floor_id`。這兩個欄位是穩定識別碼，名稱修改時不會改變。

---

## API 回傳範例

### `/api/me`

```json
{
  "username": "ASE\\mattchen",
  "role": "admin",
  "auth_type": "sso",
  "logout_url": "/logout"
}
```

`auth_type` 可能為 `sso`（Windows 單一登入）、`manual`（AD 帳密登入）或 `dev`（本機開發身分）。

### 尚未登入時（`/api/me` 等需要權限的 API）

```json
{
  "error": "unauthenticated",
  "message": "尚未登入，請先登入。",
  "login_url": "/login"
}
```

HTTP 狀態碼為 **403**（刻意不用 401，避免 IIS 攔截後再彈出 Windows 帳密視窗）。
前端收到後會自動導向 `login_url`。

### `/api/admin/upload-data` 成功

```json
{
  "success": true,
  "message": "資料更新成功，上一版資料已完成留存。",
  "uploaded_file": "樓層面積資訊-Update20260417_(Security C).xlsx",
  "backup_file": "data_20260512_153000_ASE_mattchen.json",
  "rows": 120,
  "buildings": 42,
  "warnings": []
}
```

### API 無權限時

```json
{
  "error": "forbidden",
  "message": "你目前沒有權限存取此資源。",
  "username": "ASE\\unknown",
  "role": null
}
```

---

## `data.json` 資料格式

系統預期 `data.json` 放在專案根目錄，且格式為陣列。每個元素代表一個廠棟，廠棟內包含多個樓層。

範例：

```json
[
  {
    "棟別": "K18",
    "基地面積(M2)": 10000,
    "容積率": 0.6,
    "建蔽率": 0.4,
    "開挖深度(M)": 12,
    "耐震係數(gal)": 400,
    "樓層": [
      {
        "樓層": "1F",
        "樓地板面積(M2)": 5000,
        "樓層高度(cm)": 600,
        "無塵室面積(M2)": 1200,
        "生產週邊(M2)": 800,
        "廠務設施面積(M2)": 1500,
        "公設(含其他)(公式)(M2)": 1500,
        "進駐製程": "製程名稱",
        "狀態": "已成廠"
      }
    ]
  }
]
```

---

## 本機執行方式

### 1. 建立 Python 環境

建議使用 Python 3.11 以上版本。

```bash
python -m venv .venv
```

Windows：

```bash
.venv\Scripts\activate
```

macOS / Linux：

```bash
source .venv/bin/activate
```

### 2. 安裝套件

```bash
pip install -r requirements.txt
```

### 3. 準備資料檔與權限檔

請在專案根目錄放置或確認：

```text
permissions.json
```

`data.json` 可以手動放置，也可以由 admin 在網頁上傳 Excel 後自動產生。

若沒有 `data.json`，`/api/data` 會回傳空陣列 `[]`。

若沒有 `permissions.json` 或格式錯誤，系統會採用安全預設：只允許 `Local-Dev` 作為 `admin`，方便本機測試，但正式部署時請務必建立正確權限設定。

### 4. 啟動開發伺服器

目前 `app.py` 的 `app.run()` 是註解狀態：

```python
# app.run(host='0.0.0.0', port=5020)
```

若要本機測試，可暫時取消註解，或使用 Flask CLI：

```bash
flask --app app run --host 0.0.0.0 --port 5020
```

啟動後開啟：

```text
http://127.0.0.1:5020
```

---

## PostgreSQL 資料庫

平台的資料來源由環境變數 `DATA_BACKEND` 決定：

| 值 | 資料來源 |
|---|---|
| `json`（預設） | 地端 JSON 檔案，行為與導入資料庫前完全相同 |
| `postgres` | PostgreSQL 18；寫入同時鏡射回 JSON 檔 |

所有檔案讀寫都集中在 `store/` 這一層：

```text
store/
├── __init__.py     門面：依 DATA_BACKEND 分派讀取、處理雙寫
├── json_store.py   地端 JSON 檔案
└── pg_store.py     PostgreSQL
```

`app.py` 只呼叫 `store.*`，不再直接碰檔案，所以切換資料來源不需要改路由。

### 雙寫與退路

`postgres` 模式下，寫入會先進資料庫（資料、版本快照與稽核紀錄在**同一個交易**內
完成），成功後再把同一份資料鏡射回 JSON 檔。

這樣做是為了保留退路：切換期間若資料庫出狀況，把 `DATA_BACKEND` 改回 `json`
重啟就能回到檔案版，而且檔案內容是最新的。確認穩定後把 `DATA_MIRROR_JSON`
設成 `false` 即可停掉鏡射。

鏡射失敗**不會**讓使用者的請求失敗 —— 此時資料庫已經是真實來源，檔案只是備援。
失敗會記進 log，並在 API 回應的 `warnings` 帶一則訊息讓維運人員看得到。

### 資料表設計重點

- **關聯式為主，JSONB 只用在稽核快照。** 年度成長趨勢、製程分群、面積佔比這些
  分析本質上都是 group by + sum，關聯式做這些是幾行 SQL。
- **`data_backups/` 的「整包還原」語意由 `building.dataset_snapshots` 保留**，
  每個 revision 存一份完整 jsonb，可回溯任一版本。
- **沒有做 SCD-2 時序表。** 年度資訊是 `floors` 的欄位，不是紀錄的生效期間，
  做時序表只會讓每個查詢都要加 `WHERE valid_to IS NULL`。
- **面積一律 `numeric` 不用浮點數**，避免大量 SUM 與百分比運算累積誤差。
- **樂觀鎖沿用現有的 `dataset_revision`**，存檔時對 `building.dataset_state`
  下條件式 UPDATE，影響 0 列就回 409，行為與檔案版完全一致。
- **欄位名稱沿用 `build_standard_workbook()` 既有的英文對照**，
  Excel 匯出、資料表、對外 view 三者同一套語意。

### schema 分層

| Schema | 內容 | 可存取的角色 |
|---|---|---|
| `building` | 內部表 | `building_app`（DML）、`building_migrate`（DDL） |
| `building_api` | 對外 view 層 | `building_reader`（唯讀） |

外部 BI 只看得到 `building_api`，連內部表的存在都看不到，
這樣內部結構怎麼重構都不會打壞別人的報表。

### 欄位字典

欄位說明只定義在 `building_data_manager.DATA_DICTIONARY_ROWS` 一處，由
`scripts/run_migrations.py` 同步到 `building.data_dictionary`，再經
`building_api.v_data_dictionary` 提供給外部查詢（該 view 會一併給出對應的
完整 view 名稱，外部不用自己拼）。

- 標準資料版 Excel 的 `data_dictionary` 工作表在 `postgres` 模式下**讀資料庫那張表**，
  所以 DBA 在資料庫端補的說明會直接反映到匯出檔，不必改程式。
- `json` 模式（或資料庫讀不到時）退回程式裡的定義，匯出不會因此失敗。
- 要新增或修改說明：改 `DATA_DICTIONARY_ROWS`，再重跑一次
  `.\scripts\run-migrations.ps1`（schema 沒變動時也會同步字典）。
- migration 只建表不塞資料，就是為了避免 SQL 裡再存一份而各自漂移。

### 本機開發環境（免安裝版，不需要 Docker）

與專案既有的 PortablePython 做法一致：用 binaries zip，不需要管理員權限，
不註冊 Windows 服務，砍掉就是刪資料夾。

```powershell
# 1. 下載 postgresql-18.x-windows-x64-binaries.zip，解壓到 C:\dev\pgsql18

# 2. 初始化（PG 18 已棄用 md5，一律用 scram-sha-256）
C:\dev\pgsql18\bin\initdb.exe -D C:\dev\pgdata `
    -U postgres -A scram-sha-256 -E UTF8 `
    --locale-provider=builtin --locale=C.UTF-8 --pwprompt

# 3. 起在 5433，避開之後可能安裝的其他 PostgreSQL
C:\dev\pgsql18\bin\pg_ctl.exe start -D C:\dev\pgdata `
    -l C:\dev\pgdata\server.log -o "-p 5433"

# 4. 建資料庫
C:\dev\pgsql18\bin\psql.exe -p 5433 -U postgres -c "CREATE DATABASE building ENCODING 'UTF8';"
```

`--locale-provider=builtin` 是刻意的：這個 provider 不依賴 OS 的 glibc / ICU 版本，
可避免「換台機器後 collation 版本不同導致索引失效」這個經典問題 ——
本機和公司 Server 的 ICU 版本幾乎不可能一樣。需要中文排序的地方再明確加
`COLLATE "zh-Hant-x-icu"` 即可。

> Python 端不需要另外安裝 PostgreSQL client：`psycopg[binary]` 的 wheel 內含 libpq。

### 建立 schema 與匯入資料

```powershell
# 0. 準備連線設定
Copy-Item .env.example .env     # 填入 PGHOST / PGDATABASE / PGUSER / PGPASSWORD

# 1. 先看會做什麼
.\scripts\run-migrations.ps1 -DryRun

# 2. 建立 schema
#    003_roles_grants.sql 需要 CREATEROLE 權限，若由 DBA 執行請加 -SkipRoles
.\scripts\run-migrations.ps1

# 3. 匯入地端 JSON 並驗收
.\scripts\run-migrations.ps1 -MigrateData

# 4. 之後隨時可重新驗證資料庫與 JSON 檔是否一致（不寫入）
.\scripts\run-migrations.ps1 -VerifyOnly
```

### 驗收方式

匯入的驗收條件是 **hash 相等**：

```text
dataset_revision(從 PostgreSQL 讀回來) == dataset_revision(從 data.json 讀)
```

`dataset_revision()` 是整包資料的 sha256（`building_data_manager.py` 既有的函式）。
hash 相同就代表沒有任何欄位在搬運途中走樣，不需要另外寫一整套逐欄位比對。
`pg_store.load_current_data()` 因此有一條硬約束：**回傳的巢狀中文 JSON 必須與
`data.json` 完全相同**，前端 `data.js`、Excel 匯出與既有測試才能一行都不用改。

### 切換到 PostgreSQL

驗收全部 PASS 之後：

```powershell
# 1. 把 .env 的 DATA_BACKEND 改成 postgres（DATA_MIRROR_JSON 先維持 true）
# 2. 重啟網站
Restart-WebAppPool -Name "Pool-BuildingPlatform"
# 3. 確認
.\scripts\check-deployment.ps1 -SiteName BuildingPlatform
```

要退回檔案版的話，把 `DATA_BACKEND` 改回 `json` 再重啟即可 ——
鏡射開著的期間 JSON 檔一直是最新的。

### 一致性測試

`tests/test_backend_parity.py` 會把同一串操作（讀取、資料維護、樂觀鎖衝突、
製程分群、需求趨勢、Excel 匯出）分別跑在兩種 backend 上，逐一比對 API 回應，
並確認鏡射回 JSON 的內容與純檔案模式完全相同。

沒有設定資料庫連線時會自動 skip；要實際跑：

```bash
PGHOST=... PGPORT=... PGDATABASE=... PGUSER=... PGPASSWORD=... \
    python -m pytest tests/test_backend_parity.py -v
```

### migration 規範

`migrations/*.sql` 依檔名排序執行，套用紀錄與 sha256 存在
`building.schema_migrations`。**已經上過正式機的 migration 視為不可變**，
要改請新增一個檔案；執行器偵測到已套用檔案的內容有變動時會提出警告但不重跑。

---

## IIS 部署注意事項

本平台以 **HttpPlatformHandler + Waitress** 部署，與公司其他 Python 服務一致。
IIS 直接管理 Python 程序的生命週期（自動啟動、崩潰重啟、停站時一併結束），
取代已停止維護的 wfastcgi，也不需要 NSSM / WinSW 之類的服務管理器。

### 一鍵部署

在目標 Server 上以**系統管理員**身分執行：

```powershell
.\scripts\deploy-iis.ps1 -AppRoot "D:\WebServices\BuildingPlatform" -Port 8001
```

腳本會依序處理 IIS 功能安裝、HttpPlatformHandler 檢查、Python 尋找、venv 建立與
套件安裝、執行期資料夾、`web.config` 路徑替換、AppPool 與網站建立、目錄權限、
Windows 驗證設定，最後直接起一次 Waitress 做冒煙測試。可重複執行。

常用參數：

| 參數 | 用途 |
|---|---|
| `-Offline` | 從 `wheels\` 離線安裝套件（內網無法連 PyPI 時） |
| `-RecreateVenv` | 先刪除既有 venv 再重建（部署目錄搬動過就必須用） |
| `-SkipSite` | 只更新程式與套件，不動 IIS 站台（日常更新版本） |
| `-SkipFeatures` | 略過 IIS 角色/功能安裝 |
| `-SeedFrom` | 從既有部署複製一份資料檔過來（平行部署用，不修改來源） |
| `-ReplaceExistingSite` | 允許接管已存在且指向其他目錄的 IIS 網站 |
| `-FullIisReset` | 結束時執行 `iisreset`（預設只重啟本次的應用程式集區） |

### 掛載方式：獨立網站 vs 子應用程式

| 方式 | 網址 | 參數 |
|---|---|---|
| 獨立網站 | `http://主機:8001/` | `-SiteName` + `-Port` |
| 子應用程式 | `http://主機/building_platform` | `-ParentSite` + `-AppPath` |

掛成子應用程式時，腳本會自動把 `web.config` 的 `APP_URL_PREFIX` 填成該路徑。
**這一項沒填的話每一頁都會是 404**：IIS 轉進來的 `PATH_INFO` 帶著前綴，
Flask 拿 `/building_platform` 去比對只定義在 `/` 的路由當然對不上。
填對之後前端會自動跟上（後端把它寫進 `window.APP_BASE`），不需要改 JS。

### 平行部署（不動既有站台）

新版要先跟舊版並存驗證時，用**另一個目錄**部署一套。

獨立網站的話換網站名稱與連接埠：

```powershell
.\scripts\deploy-iis.ps1 `
    -AppRoot  "D:\WebServices\BuildingPlatform-v2" `
    -SiteName "BuildingPlatform-v2" `
    -Port     8002 `
    -SeedFrom "D:\WebServices\BuildingPlatform"
```

子應用程式的話換路徑（線上是 `/building_platform`，先在 `/building_platform_v2` 驗）：

```powershell
.\scripts\deploy-iis.ps1 `
    -AppRoot    "D:\WebServices\BuildingPlatform-v2" `
    -ParentSite "Default Web Site" `
    -AppPath    "building_platform_v2" `
    -SeedFrom   "D:\WebServices\BuildingPlatform"
```

> 子應用程式建議用「同樣掛成子應用程式、但換路徑」的方式驗，而不是臨時改成獨立網站。
> 這樣路徑前綴、驗證設定與前端 `APP_BASE` 都會走到跟正式環境相同的程式碼路徑，
> 切換當天才不會第一次執行到沒驗過的東西。

腳本針對平行部署有三道保護：

- **網站名稱撞到既有站台**（且指向不同目錄）→ 直接中止，不會把既有站台接管過來。
  確實要接管才加 `-ReplaceExistingSite`。
- **連接埠已被其他站台佔用** → 直接中止並提示換一個。
- **應用程式集區正被其他站台使用** → 直接中止；兩個站台共用集區會共享 Python 程序。

另外預設**不執行 `iisreset`**（那會重啟整台機器的所有站台），
只重啟本次部署的應用程式集區。第一次安裝 HttpPlatformHandler 時才需要
另外跑一次 `iisreset`。

平行部署後要知道的幾件事：

| 項目 | 說明 |
|---|---|
| 資料 | `-SeedFrom` 是**複製**不是共用。部署後兩邊各走各的，舊站台的新異動不會同步過來 |
| 登入 | 兩個站台各有自己的 `secret_key.txt`，session 互相獨立 |
| 舊站台 | 完全不受影響，仍走原本的 wfastcgi `web.config` |
| 驗收完成後 | 用 `scripts\switch-site.ps1` 正式切換，確認無誤再移除舊站台 |

### 正式切換（子應用程式）

驗證完成後，把線上網址改指到新版：

```powershell
.\scripts\switch-site.ps1 `
    -ParentSite "Default Web Site" `
    -AppPath    "building_platform" `
    -NewRoot    "D:\WebServices\BuildingPlatform-v2" `
    -NewAppPool "Pool-BuildingPlatform-v2"
```

腳本會照這個順序做，**任何一步失敗都自動回退**：

1. 記錄目前狀態到 `logs\cutover-state.json`
2. 停止舊版的應用程式集區 —— 切換窗口從這裡開始
3. 把舊目錄的資料檔複製到新目錄
4. 新版若已接 PostgreSQL，重跑匯入並驗收 hash
5. 複製 `secret_key.txt`，已登入的使用者不會被登出
6. 設定 `APP_URL_PREFIX` 為正式路徑
7. 應用程式改指到新目錄
8. 重設 Windows 驗證（驗證設定是綁在路徑上的）
9. 冒煙測試 `/api/auth/status`（不需登入、永遠回 200）

第 3 步是最容易被忽略的：平行驗證期間舊版的資料已經往前走，
不重新同步就切過去會吃掉這段異動。所以**一定要先停舊版再同步**，順序不能反。

先看會做什麼：

```powershell
.\scripts\switch-site.ps1 ... -WhatIfOnly
```

回退：

```powershell
.\scripts\switch-site.ps1 `
    -ParentSite "Default Web Site" `
    -AppPath    "building_platform" `
    -NewRoot    "D:\WebServices\BuildingPlatform-v2" `
    -Rollback
```

> 回退期間若有人已經在新版改過資料，那些異動不會自動回到舊目錄。
> 切換窗口盡量挑沒人使用的時段，就是為了縮小這個風險。
> 舊目錄不會被腳本刪除或修改，跑順一兩週再清。

### 前置需求

1. **HttpPlatformHandler v2.0**：IIS 不內建，必須另外安裝 MSI
   （<https://www.iis.net/downloads/microsoft/httpplatformhandler>）。
   未安裝時所有請求都會回 HTTP 500。
2. **IIS 功能**：Web Server、Windows 驗證、**CGI**
   （`Web-CGI` 是 HttpPlatformHandler 的前置需求，不能省略）。
3. **Python 3.11 以上，且必須勾選「Install for all users」**
   （會裝到 `C:\Program Files\PythonXX`）。裝在 `C:\Users\...\AppData\` 底下的 Python，
   IIS 應用程式集區帳號無法存取，程序永遠起不來（IIS 回 502）。

### 離線部署

venv 在建立時會寫死 Python 的絕對路徑，**複製或搬移 venv 到別的路徑或機器一定會壞**
（`Fatal error in launcher: Unable to create process ...`）。因此搬移的是原始碼與
`wheels/`，venv 一律在部署機的最終路徑重建。

開發機打包（Python 版本必須與部署機相同）：

```powershell
pip download -r requirements.txt -d wheels `
    --platform win_amd64 --python-version 3.11 --only-binary=:all:
```

部署機安裝：

```powershell
.\scripts\deploy-iis.ps1 -Offline
```

### 逐項檢查清單

1. 確認 IIS 已啟用 CGI 與 Windows 驗證，且已安裝 HttpPlatformHandler。
2. 確認 IIS 驗證設定（**與登入畫面直接相關，請務必照做**）：

   | 路徑 | 匿名驗證 | Windows 驗證 |
   |---|---|---|
   | 應用程式根目錄 | **啟用** | 啟用 |
   | `<應用程式>/auth/sso` | **停用** | 啟用 |

   根目錄開放匿名，使用者按掉 Windows 帳密視窗時 request 才進得到 Flask，
   由程式導向自家登入畫面；`/auth/sso` 關閉匿名，網域內電腦才能繼續單一登入。

   這兩個區段預設鎖在 `applicationHost.config`，寫進 `web.config` 會出現 HTTP 500.19，
   請以系統管理員身分執行：

   ```powershell
   # 掛在網站根目錄
   .\scripts\setup-ad-login.ps1 -SiteName "Default Web Site"

   # 掛在 http://server/building_platform
   .\scripts\setup-ad-login.ps1 -SiteName "Default Web Site" -AppPath "building_platform"
   ```

   設定完成後執行 `iisreset /restart`。
3. 確認已安裝 `ldap3`（AD 帳密登入用），並在 `web.config` 的 `environmentVariables`
   填好 `AD_SERVER`。
4. 確認 `web.config` 的 `processPath` 指向部署目錄底下 `venv\Scripts\waitress-serve.exe`，
   且 `forwardWindowsAuthToken="true"`。**少了這個屬性，IIS 的驗證結果不會傳給 Python，
   單一登入會完全失效。**
5. 確認 `PYTHONPATH` 指向專案根目錄（Waitress 靠它找到 `wsgi:application`），
   且 `PYTHONUNBUFFERED=1`（沒設的話 `logs\python.log` 會一直是空的，排錯時沒有線索）。
6. 確認 IIS App Pool 身分有權限讀取專案目錄。
7. 確認 IIS App Pool 身分有權限寫入：
   - `logs/`（HttpPlatformHandler 的 stdout log）
   - `data.json`
   - `access_log.txt`
   - `app.log`
   - `secret_key.txt`（登入 session 金鑰，第一次啟動時自動產生；
     若不想給寫入權限，改在 `web.config` 填 `APP_SECRET_KEY`）
   - `uploads/`
   - `processed/`
   - `data_backups/`
8. 確認 `permissions.json` 已設定正式 AD 帳號。
9. Windows 整合驗證的身分來源依序為 `REMOTE_USER` / `LOGON_USER` / `AUTH_USER`；
   `/auth/sso` 另外會解析 `forwardWindowsAuthToken` 傳來的 `X-IIS-WindowsAuthToken`
   （讀 token 的 SID 反查帳號）。
10. 網域內電腦若仍會跳出 Windows 帳密視窗，請把平台網址加入瀏覽器的
    「近端內部網路」信任區（可用 GPO 統一派送）；沒加入時仍可用登入畫面輸入 AD 帳密。
11. 若 admin 要上傳大檔案，需確認 IIS request limit 與 Flask `MAX_CONTENT_LENGTH` 設定，目前 Flask 限制為 50MB。
12. **資料庫密碼不要寫進 `web.config`**。這個檔案有進版控，寫進去就等於 commit 進 git。
    連線資訊放部署機的 `.env`（見 `.env.example`），該檔案已列入 `.gitignore`。

### 常見錯誤

| 狀況 | 原因與處理 |
|---|---|
| HTTP 500（所有頁面） | HttpPlatformHandler 未安裝，裝 MSI 後 `iisreset` |
| HTTP 502 | Python 程序起不來。看 `logs\python.log`；常見是 import 錯誤或套件缺失 |
| `logs\python.log` 是空的 | `PYTHONUNBUFFERED=1` 沒設，或 `logs\` 不存在／AppPool 沒寫入權限 |
| `Fatal error in launcher` | venv 被搬移過。用 `deploy-iis.ps1 -RecreateVenv` 在最終路徑重建 |
| `No Python at '...AppData'` | Python 裝在使用者目錄。重裝並勾「Install for all users」 |
| `unsupported hash type MD4` | ldap3 要用 SIMPLE bind，不要用 NTLM（本專案已是 SIMPLE） |
| SSO 抓到 `Administrator` | 不能用 `ImpersonateLoggedOnUser`，要讀 token 的 SID（本專案已是這個做法） |
| HTTP 503 | AppPool 已停止，到 IIS 管理員重新啟動 |
| `SERVER_NAME: waitress.invalid` | 直接打到 Waitress 的動態 port 繞過了 IIS，請走 IIS 站台的 port |

### 部署前後自動檢查

`scripts/check-deployment.ps1` 會讀取 `web.config` 的 `httpPlatform` 設定，檢查
venv 與 Waitress、`forwardWindowsAuthToken`、HttpPlatformHandler 模組、IIS 功能、
專案檔案、`permissions.json`、執行期資料夾寫入權限、`.env` 是否存在且權限已收斂、
`DATA_BACKEND` 設定、AD 網域加入狀態，以及前端 CDN 連線是否正常。
`DATA_BACKEND=postgres` 時還會實際連一次資料庫並確認 migration 已套用。
在目標 Server 上、專案根目錄執行：

```powershell
.\scripts\check-deployment.ps1
```

若有指定 IIS 網站名稱，可額外檢查該網站的實體路徑與 Windows Authentication 設定：

```powershell
.\scripts\check-deployment.ps1 -SiteName "BuildingPlatform"
```

有任何 `FAIL` 項目時腳本會回傳非 0 的 Exit Code，可用於部署流程自動判斷。

---

## 使用者存取紀錄

每次使用者進入首頁 `/`、上傳資料或被拒絕存取時，系統會記錄：

- 使用者帳號
- IP
- 操作，例如 `View Dashboard`、`Upload Data`、`Upload Data Failed`、`Access Denied`
- 角色
- 上傳檔案名稱
- 備份檔案
- 被拒絕時的路徑與需要角色
- 時間戳記

輸出位置：

```text
access_log.txt
```

---

## 開發備註

- 前端目前採用 ES Modules，因此需透過 HTTP server 執行，不建議直接用檔案方式開啟 HTML。
- Tailwind CSS 與 Lucide Icons 使用 CDN，部署環境需能連線至 CDN，否則需改為本地化資源。
- `components.js` 內含大量 UI HTML template，若後續功能持續擴充，建議逐步拆分為更細的元件模組。
- `data.json` 目前以檔案方式管理，若資料量變大或需要多人同時更新，可考慮改為資料庫。
- 若要接正式 AD 群組，可保留 `require_roles()`，只替換 `get_user_role()` 的角色查詢來源。

---

## 後續可改善項目

- 新增 `data.sample.json`
- 增加資料備份還原功能
- 增加上傳紀錄查詢頁
- 將 CDN 資源改成本地靜態檔
- 將 `components.js` 拆分為 Header、Matrix、Panel 等模組
- 將 `permissions.json` 改接 AD Group 或資料庫
- 依角色隱藏 / 顯示更多前端功能按鈕
- 補上 API 錯誤畫面與資料格式驗證
- 增加部署文件，例如 IIS 設定截圖或 SOP
