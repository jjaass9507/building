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
- **Windows AD 身份辨識**：透過 IIS Windows Integrated Authentication 取得 `REMOTE_USER`。
- **角色權限控管**：透過 `permissions.json` 設定 `admin`、`user`、`viewer`。
- **Admin 網頁上傳更新資料**：admin 可直接在頁面上傳樓層面積 Excel，系統自動清洗並更新 `data.json`。
- **資料版本留存**：每次更新前會先把上一版 `data.json` 備份到 `data_backups/`。
- **IIS / FastCGI 部署支援**：已包含 `web.config` 設定範例。
- **存取紀錄**：後端會記錄使用者帳號、IP、操作、上傳與權限拒絕紀錄至 `access_log.txt`。

---

## 技術架構

### 後端

- Python
- Flask
- Pandas
- OpenPyXL
- JSON API
- IIS FastCGI / wfastcgi 部署設定
- Windows Integrated Authentication / `REMOTE_USER`
- JSON-based Role-Based Access Control

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
├── data_processor.py          # Excel 清洗與 data.json 轉換邏輯
├── web.config
├── README.md
├── requirements.txt
├── permissions.json           # 角色權限設定檔
├── data.json                  # 執行時資料檔，需自行放置於專案根目錄
├── access_log.txt             # 執行後自動產生的使用者存取紀錄
├── app.log                    # IIS / wfastcgi log，依 web.config 設定產生
├── uploads/                   # admin 上傳的原始 Excel 留存，不納入版控
├── processed/                 # 清洗後 Excel 與暫存 JSON，不納入版控
├── data_backups/              # data.json 舊版備份，不納入版控
├── templates/
│   ├── index.html
│   └── 403.html               # 無權限存取頁面
└── static/
    ├── css/
    │   └── style.css
    └── js/
        ├── main.js
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
- 提供 admin 上傳 API `/api/admin/upload-data`
- 讀取根目錄下的 `data.json`
- 讀取根目錄下的 `permissions.json`
- 透過 `REMOTE_USER` 取得 Windows AD 使用者
- 依角色檢查使用者是否允許存取頁面 / API
- 上傳 Excel 後先備份上一版 `data.json`，再更新目前資料
- 記錄使用者存取資訊到 `access_log.txt`
- 支援 IIS 透過 `WSGI_HANDLER=app.app` 呼叫

主要路由：

| Route | Method | 權限 | 說明 |
|---|---|---|---|
| `/` | GET | admin / user / viewer | 回傳 `templates/index.html` |
| `/api/me` | GET | admin / user / viewer | 回傳目前使用者帳號與角色 |
| `/api/data` | GET | admin / user / viewer | 讀取 `data.json` 並回傳 JSON |
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

## 權限控管流程

```text
使用者進入系統
    ↓
IIS Windows Integrated Authentication 完成身份驗證
    ↓
Flask 從 request.environ['REMOTE_USER'] 取得 AD 帳號
    ↓
Flask 讀取 permissions.json
    ↓
比對使用者屬於 admin / user / viewer 哪個角色
    ↓
有權限：允許進入頁面或 API
無權限：頁面顯示 403.html，API 回傳 403 JSON
```

若本機開發沒有 `REMOTE_USER`，系統會使用：

```text
Local-Dev
```

因此預設 `permissions.json` 會把 `Local-Dev` 放在 `admins`，方便本機測試。

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

---

## API 回傳範例

### `/api/me`

```json
{
  "username": "ASE\\mattchen",
  "role": "admin"
}
```

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

## IIS 部署注意事項

1. 確認 IIS 已啟用 CGI / FastCGI。
2. 確認 IIS 已啟用 Windows Authentication，並視需求關閉 Anonymous Authentication。
3. 確認 Python 與 `wfastcgi.py` 路徑與 `web.config` 一致。
4. 確認 `PYTHONPATH` 指向專案根目錄。
5. 確認 IIS App Pool 身分有權限讀取專案目錄。
6. 確認 IIS App Pool 身分有權限寫入：
   - `data.json`
   - `access_log.txt`
   - `app.log`
   - `uploads/`
   - `processed/`
   - `data_backups/`
7. 確認 `permissions.json` 已設定正式 AD 帳號。
8. 若使用 Windows 整合驗證，`app.py` 會從 `REMOTE_USER` 取得使用者帳號。
9. 若 admin 要上傳大檔案，需確認 IIS request limit 與 Flask `MAX_CONTENT_LENGTH` 設定，目前 Flask 限制為 50MB。

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
