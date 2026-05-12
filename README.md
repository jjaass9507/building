# ASE 建物管理平台

ASE 建物管理平台是一個以 **Flask + Tailwind CSS + Vanilla JavaScript** 建置的建物資訊視覺化儀表板。系統會讀取建物樓層資料，整理成可互動的矩陣式看板，協助快速查看各廠棟、樓層、面積配置、無塵室面積、生產週邊、廠務設施、公設與樓高等資訊。

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
- **IIS / FastCGI 部署支援**：已包含 `web.config` 設定範例。
- **存取紀錄**：後端會記錄使用者帳號與 IP 至 `access_log.txt`。

---

## 技術架構

### 後端

- Python
- Flask
- JSON API
- IIS FastCGI / wfastcgi 部署設定

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
├── web.config
├── README.md
├── data.json                  # 執行時資料檔，需自行放置於專案根目錄
├── access_log.txt             # 執行後自動產生的使用者存取紀錄
├── app.log                    # IIS / wfastcgi log，依 web.config 設定產生
├── templates/
│   └── index.html
└── static/
    ├── css/
    │   └── style.css
    └── js/
        ├── main.js
        ├── data.js
        ├── utils.js
        └── components.js
```

> 注意：目前 repository 中不一定包含 `data.json`、`access_log.txt`、`app.log`，這些通常是部署或執行時產生 / 放置的檔案。

---

## 核心檔案說明

### `app.py`

Flask 後端主程式，負責：

- 初始化 Flask app
- 判斷目前是 Python 腳本模式或 EXE 打包模式
- 設定 `templates` 與 `static` 路徑
- 提供首頁 `/`
- 提供資料 API `/api/data`
- 讀取根目錄下的 `data.json`
- 記錄使用者存取資訊到 `access_log.txt`
- 支援 IIS 透過 `WSGI_HANDLER=app.app` 呼叫

主要路由：

| Route | Method | 說明 |
|---|---|---|
| `/` | GET | 回傳 `templates/index.html` |
| `/api/data` | GET | 讀取 `data.json` 並回傳 JSON |

---

### `templates/index.html`

前端入口頁，負責：

- 載入 Tailwind CSS CDN
- 載入 Lucide Icons CDN
- 套用 light / dark theme 初始狀態
- 載入 `static/css/style.css`
- 載入 `static/js/main.js`
- 顯示系統載入中的 loading 畫面

---

### `static/js/main.js`

前端主控制器，負責：

- 管理畫面狀態 `state`
- 呼叫 `/api/data` 載入資料
- 呼叫 `processRawData()` 處理原始資料
- 呼叫 `renderHeader()`、`renderMatrix()`、`renderPanel()` 組合畫面
- 處理深色模式切換
- 處理廠棟篩選
- 處理點選樓層 / 廠棟後的側邊面板
- 保留矩陣捲動位置，避免重新 render 後跳回起點

---

### `static/js/data.js`

資料轉換模組，負責將 `data.json` 的原始資料整理成前端容易使用的格式。

主要輸出：

- `processedData`：逐樓層攤平後的資料
- `buildingMeta`：各廠棟基本資訊
- `sortedFloorLabels`：排序後的樓層清單

支援欄位包含：

- 棟別
- 樓層
- 基地面積
- 容積率
- 建蔽率
- 開挖深度
- 耐震係數
- 樓地板面積
- 樓層高度
- 無塵室面積
- 生產週邊
- 廠務設施面積
- 公設 / 其他
- 進駐製程
- 狀態：`已成廠` / `未成廠`

---

### `static/js/utils.js`

共用工具函式，包含：

- `getFloorWeight()`：樓層排序權重，例如 B1、1F、RF、PH
- `formatArea()`：面積格式化，支援 `m²` 與 `坪`
- `formatPct()`：百分比格式化
- `getCellStyle()`：格子基礎樣式

---

### `static/js/components.js`

前端畫面元件模組，負責產生主要 HTML UI：

- Header 區塊
- 廠棟篩選按鈕
- 總樓地板 / 總無塵室統計
- 顯示模式切換
- 面積堆疊條
- 樓層矩陣
- 側邊資訊面板
- 廠務設施細項 tooltip
- 已成廠 / 未成廠呈現邏輯

---

### `static/css/style.css`

補充樣式，包含：

- 隱藏捲軸但保留滾動功能
- 側邊面板滑入動畫
- grid cell 點擊動畫
- 手機版橫向捲動優化

---

### `web.config`

IIS 部署設定檔，主要用於：

- 設定 FastCGI handler
- 指定 Python 執行檔與 `wfastcgi.py`
- 指定 `WSGI_HANDLER=app.app`
- 指定 `PYTHONPATH`
- 指定 `WSGI_LOG`

目前設定路徑範例：

```xml
D:\FAC_Web\BuildingPlatform\PortablePython3.11.5\python.exe
D:\FAC_Web\BuildingPlatform\PortablePython3.11.5\wfastcgi.py
D:\FAC_Web\BuildingPlatform
```

部署到其他環境時，需要依實際路徑調整。

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

### 廠務設施細項格式

`廠務設施面積(M2)` 可為數字，也可擴充為物件格式，提供細項 tooltip 使用：

```json
{
  "樓層": "2F",
  "樓地板面積(M2)": 5000,
  "廠務設施面積(M2)": {
    "value": 1600,
    "details": {
      "純水": 300,
      "廢水": 200,
      "空調": 500,
      "電力": 600
    }
  }
}
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

目前專案主要依賴 Flask：

```bash
pip install flask
```

若部署 IIS FastCGI，則需要額外安裝：

```bash
pip install wfastcgi
```

### 3. 準備資料檔

請在專案根目錄放置：

```text
data.json
```

若沒有 `data.json`，`/api/data` 會回傳空陣列 `[]`。

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
2. 確認 Python 與 `wfastcgi.py` 路徑與 `web.config` 一致。
3. 確認 `PYTHONPATH` 指向專案根目錄。
4. 確認 IIS App Pool 身分有權限讀取專案目錄。
5. 確認 IIS App Pool 身分有權限寫入：
   - `access_log.txt`
   - `app.log`
6. 確認 `data.json` 已放置於專案根目錄。
7. 若使用 Windows 整合驗證，`app.py` 會嘗試從 `REMOTE_USER` 取得使用者帳號。

---

## 使用者存取紀錄

每次使用者進入首頁 `/` 時，系統會記錄：

- 使用者帳號
- IP
- 操作：`View Dashboard`
- 時間戳記

輸出位置：

```text
access_log.txt
```

本機執行時若沒有 IIS 的 `REMOTE_USER`，會顯示為：

```text
Local-Dev
```

---

## 開發備註

- 前端目前採用 ES Modules，因此需透過 HTTP server 執行，不建議直接用檔案方式開啟 HTML。
- Tailwind CSS 與 Lucide Icons 使用 CDN，部署環境需能連線至 CDN，否則需改為本地化資源。
- `components.js` 內含大量 UI HTML template，若後續功能持續擴充，建議逐步拆分為更細的元件模組。
- `data.json` 若資料量變大，可考慮改為資料庫或後端分頁 API。
- 若要正式版控相依套件，建議新增 `requirements.txt`。

---

## 後續可改善項目

- 新增 `requirements.txt`
- 新增 `.gitignore`
- 新增 `data.sample.json`
- 將 CDN 資源改成本地靜態檔
- 將 `components.js` 拆分為 Header、Matrix、Panel 等模組
- 補上 API 錯誤畫面與資料格式驗證
- 增加部署文件，例如 IIS 設定截圖或 SOP
