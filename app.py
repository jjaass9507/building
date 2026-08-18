import sys
import os
import shutil
from flask import Flask, render_template, jsonify, request
import json
import logging
from datetime import datetime
from functools import wraps
from werkzeug.utils import secure_filename

from data_processor import DataProcessError, process_excel_file

# --- 1. 路徑處理邏輯 ---

def get_base_path():
    """ 取得程式執行的真實目錄 """
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    else:
        return os.path.dirname(os.path.abspath(__file__))

base_dir = get_base_path()
template_path = os.path.join(base_dir, 'templates')
static_path = os.path.join(base_dir, 'static')
data_file_path = os.path.join(base_dir, 'data.json')
utility_trends_file_path = os.path.join(base_dir, 'utility_trends.json')
permission_file_path = os.path.join(base_dir, 'permissions.json')
log_file_path = os.path.join(base_dir, 'access_log.txt')
upload_dir = os.path.join(base_dir, 'uploads')
backup_dir = os.path.join(base_dir, 'data_backups')
utility_backup_dir = os.path.join(base_dir, 'utility_trend_backups')
processed_dir = os.path.join(base_dir, 'processed')
cleaned_excel_path = os.path.join(processed_dir, '樓層面積資訊_系統匯入檔.xlsx')

ALLOWED_UPLOAD_EXTENSIONS = {'.xlsx'}

print("--------------------------------------------------")
print(f"目前執行模式: {'打包 EXE' if getattr(sys, 'frozen', False) else 'Python 腳本'}")
print(f"程式所在位置: {base_dir}")
print(f"尋找 HTML 位置: {template_path}")
print(f"權限設定位置: {permission_file_path}")
print(f"資料備份位置: {backup_dir}")
print(f"需求趨勢備份位置: {utility_backup_dir}")
print(f"Log 紀錄位置: {log_file_path}")
print("--------------------------------------------------")

# --- 2. 初始化 Flask ---

app = Flask(__name__, template_folder=template_path, static_folder=static_path)
app.config['JSON_AS_ASCII'] = False
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024


class PrefixMiddleware:
    """
    部署成 IIS 子應用程式 (例如掛在 /building_platform 底下) 時，wfastcgi 傳進來的
    PATH_INFO 會保留應用程式前綴，SCRIPT_NAME 卻是空字串，導致 Flask 拿
    '/building_platform' 去比對只定義在 '/' 的路由，結果每一頁都是 404。

    這裡把前綴從 PATH_INFO 搬到 SCRIPT_NAME，Flask 才能正確比對路由，
    url_for() 產生的網址也才會帶上前綴 (static 檔案才不會 404)。

    前綴由 APP_URL_PREFIX 指定；wfastcgi 會把 web.config 的 appSettings
    放進環境變數，所以在 appSettings 加一行即可：
        <add key="APP_URL_PREFIX" value="/building_platform" />
    沒設定時不做任何處理，部署在網站根目錄的環境不受影響。
    """

    def __init__(self, wsgi_app, prefix=''):
        self.wsgi_app = wsgi_app
        stripped = (prefix or '').strip('/')
        self.prefix = f"/{stripped}" if stripped else ''

    def __call__(self, environ, start_response):
        if self.prefix:
            path = environ.get('PATH_INFO', '')
            if path == self.prefix or path.startswith(f"{self.prefix}/"):
                environ['PATH_INFO'] = path[len(self.prefix):] or '/'
                environ['SCRIPT_NAME'] = self.prefix
        return self.wsgi_app(environ, start_response)


app.wsgi_app = PrefixMiddleware(app.wsgi_app, os.environ.get('APP_URL_PREFIX', ''))

# --- 3. Logging ---

logging.basicConfig(
    filename=log_file_path,
    level=logging.INFO,
    format='%(asctime)s - %(message)s',
    encoding='utf-8'
)

def get_client_ip():
    if request.headers.getlist("X-Forwarded-For"):
        return request.headers.getlist("X-Forwarded-For")[0]
    return request.remote_addr

def get_current_user():
    return request.environ.get('REMOTE_USER') or 'Local-Dev'

def log_user_access(username, action='View Dashboard', extra=''):
    ip = get_client_ip()
    extra_msg = f" | {extra}" if extra else ""
    logging.info(f"User: {username} | IP: {ip} | Action: {action}{extra_msg}")

# --- 4. 身份與權限控管 ---

def load_permissions():
    default_permissions = {
        "admins": ["Local-Dev"],
        "users": [],
        "viewers": []
    }

    if not os.path.exists(permission_file_path):
        logging.warning(f"permissions.json not found: {permission_file_path}")
        return default_permissions

    try:
        with open(permission_file_path, 'r', encoding='utf-8') as f:
            permissions = json.load(f)

        if not isinstance(permissions, dict):
            raise ValueError("permissions.json root must be an object")

        return {
            "admins": permissions.get("admins", []),
            "users": permissions.get("users", []),
            "viewers": permissions.get("viewers", [])
        }
    except Exception as e:
        logging.error(f"Failed to load permissions.json: {e}")
        return default_permissions

def normalize_identity(username):
    return (username or '').strip().lower()

def get_user_role(username):
    permissions = load_permissions()
    normalized_user = normalize_identity(username)

    role_map = [
        ("admin", permissions.get("admins", [])),
        ("user", permissions.get("users", [])),
        ("viewer", permissions.get("viewers", []))
    ]

    for role, members in role_map:
        normalized_members = [normalize_identity(member) for member in members]
        if normalized_user in normalized_members:
            return role

    return None

def is_api_request():
    return request.path.startswith('/api/')

def require_roles(*allowed_roles):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            username = get_current_user()
            role = get_user_role(username)

            if role not in allowed_roles:
                log_user_access(
                    username,
                    action='Access Denied',
                    extra=f"Path: {request.path} | Role: {role or 'unauthorized'} | Required: {','.join(allowed_roles)}"
                )

                if is_api_request():
                    return jsonify({
                        "error": "forbidden",
                        "message": "你目前沒有權限存取此資源。",
                        "username": username,
                        "role": role
                    }), 403

                return render_template('403.html', username=username, role=role, required_roles=allowed_roles), 403

            return func(*args, **kwargs)

        return wrapper
    return decorator

# --- 5. 資料上傳與版本留存 ---

def ensure_runtime_dirs():
    for folder in [upload_dir, backup_dir, utility_backup_dir, processed_dir]:
        os.makedirs(folder, exist_ok=True)

def is_allowed_upload(filename):
    _, ext = os.path.splitext(filename or '')
    return ext.lower() in ALLOWED_UPLOAD_EXTENSIONS

def safe_username(username):
    return secure_filename(username.replace('\\', '_').replace('/', '_')) or 'unknown'

def backup_current_data(username):
    if not os.path.exists(data_file_path):
        return None

    ensure_runtime_dirs()
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    backup_filename = f"data_{timestamp}_{safe_username(username)}.json"
    backup_path = os.path.join(backup_dir, backup_filename)
    shutil.copy2(data_file_path, backup_path)
    return backup_path

def create_default_utility_trends():
    return {
        "schema_version": "1.0",
        "updated_at": datetime.now().isoformat(),
        "updated_by": "system",
        "description": "電力與用水需求成長趨勢資料。",
        "display_settings": {
            "default_unit_mode": "engineering",
            "show_current_as_baseline_only": True,
            "chart_mode": "cumulative_line_plus_annual_bar"
        },
        "metrics": [
            {
                "metric_key": "power_demand",
                "metric_name": "電力需求",
                "unit": "kW",
                "annual_label": "年增電力需求",
                "cumulative_label": "累積電力需求",
                "description": "年度新增電力需求與累積電力需求。現況只作為累積基準，不列入年增。",
                "series": [
                    {"year_key": "current", "year_label": "現況", "value": 0, "is_baseline": True, "note": "目前既有電力需求基準值"},
                    {"year_key": "Y1", "year_label": "Y1", "value": 0, "is_baseline": False, "note": "預計新增電力需求"}
                ]
            },
            {
                "metric_key": "water_demand",
                "metric_name": "用水需求",
                "unit": "CMD",
                "annual_label": "年增用水需求",
                "cumulative_label": "累積用水需求",
                "description": "年度新增用水需求與累積用水需求。現況只作為累積基準，不列入年增。",
                "series": [
                    {"year_key": "current", "year_label": "現況", "value": 0, "is_baseline": True, "note": "目前既有用水需求基準值"},
                    {"year_key": "Y1", "year_label": "Y1", "value": 0, "is_baseline": False, "note": "預計新增用水需求"}
                ]
            }
        ]
    }

def load_utility_trends():
    if not os.path.exists(utility_trends_file_path):
        return create_default_utility_trends()

    with open(utility_trends_file_path, 'r', encoding='utf-8') as f:
        return json.load(f)

def validate_utility_trends(payload):
    if not isinstance(payload, dict):
        raise ValueError("需求趨勢資料必須是 JSON object。")
    metrics = payload.get("metrics")
    if not isinstance(metrics, list) or not metrics:
        raise ValueError("metrics 必須是非空陣列。")

    for metric in metrics:
        if not isinstance(metric, dict):
            raise ValueError("metric 必須是 object。")
        if not metric.get("metric_key") or not metric.get("metric_name"):
            raise ValueError("每個 metric 都必須有 metric_key 與 metric_name。")
        if not isinstance(metric.get("series"), list) or not metric.get("series"):
            raise ValueError(f"{metric.get('metric_name')} 必須有 series 陣列。")
        for point in metric["series"]:
            if not point.get("year_key") or not point.get("year_label"):
                raise ValueError("每筆 series 都必須有 year_key 與 year_label。")
            try:
                point["value"] = float(point.get("value", 0) or 0)
            except Exception:
                raise ValueError(f"{metric.get('metric_name')} / {point.get('year_label')} 的 value 必須是數字。")
            point["is_baseline"] = bool(point.get("is_baseline", False))
    return payload

def backup_utility_trends(username):
    if not os.path.exists(utility_trends_file_path):
        return None

    ensure_runtime_dirs()
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    backup_filename = f"utility_trends_{timestamp}_{safe_username(username)}.json"
    backup_path = os.path.join(utility_backup_dir, backup_filename)
    shutil.copy2(utility_trends_file_path, backup_path)
    return backup_path

# --- 6. 路由設定 ---

@app.route('/')
@require_roles("admin", "user", "viewer")
def index():
    user = get_current_user()
    role = get_user_role(user)
    log_user_access(user, action='View Dashboard', extra=f"Role: {role}")
    return render_template('index.html')

@app.route('/api/me')
@require_roles("admin", "user", "viewer")
def get_me():
    username = get_current_user()
    role = get_user_role(username)
    return jsonify({"username": username, "role": role})

@app.route('/api/data')
@require_roles("admin", "user", "viewer")
def get_data():
    try:
        if not os.path.exists(data_file_path):
            return jsonify([])
        with open(data_file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/utility-trends')
@require_roles("admin", "user", "viewer")
def get_utility_trends():
    try:
        return jsonify(load_utility_trends())
    except Exception as e:
        return jsonify({"error": "load_failed", "message": str(e)}), 500

@app.route('/api/admin/utility-trends', methods=['POST'])
@require_roles("admin")
def update_utility_trends():
    username = get_current_user()
    payload = request.get_json(silent=True)
    if payload is None:
        return jsonify({"error": "invalid_json", "message": "請提供 JSON 格式資料。"}), 400

    try:
        data = validate_utility_trends(payload)
        data["schema_version"] = data.get("schema_version") or "1.0"
        data["updated_at"] = datetime.now().isoformat()
        data["updated_by"] = username
        data.setdefault("display_settings", {
            "default_unit_mode": "engineering",
            "show_current_as_baseline_only": True,
            "chart_mode": "cumulative_line_plus_annual_bar"
        })

        ensure_runtime_dirs()
        backup_path = backup_utility_trends(username)
        temp_path = os.path.join(processed_dir, f"utility_trends_pending_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json")
        with open(temp_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        shutil.move(temp_path, utility_trends_file_path)

        log_user_access(username, action='Update Utility Trends', extra=f"Backup: {backup_path or 'none'}")
        return jsonify({
            "success": True,
            "message": "需求趨勢資料已更新。",
            "backup_file": os.path.basename(backup_path) if backup_path else None,
            "data": data
        })
    except ValueError as e:
        return jsonify({"error": "validation_failed", "message": str(e)}), 400
    except Exception as e:
        logging.exception("Unexpected utility trend update error")
        return jsonify({"error": "update_failed", "message": str(e)}), 500

@app.route('/api/admin/upload-data', methods=['POST'])
@require_roles("admin")
def upload_data_file():
    username = get_current_user()

    if 'file' not in request.files:
        return jsonify({"error": "missing_file", "message": "請選擇要上傳的 Excel 檔案。"}), 400

    uploaded_file = request.files['file']
    if not uploaded_file or uploaded_file.filename == '':
        return jsonify({"error": "empty_filename", "message": "上傳檔案名稱不可為空。"}), 400

    if not is_allowed_upload(uploaded_file.filename):
        return jsonify({"error": "invalid_file_type", "message": "僅支援 .xlsx 檔案。"}), 400

    ensure_runtime_dirs()

    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    original_filename = secure_filename(uploaded_file.filename)
    upload_path = os.path.join(upload_dir, f"{timestamp}_{original_filename}")
    temp_json_path = os.path.join(processed_dir, f"data_pending_{timestamp}.json")

    try:
        uploaded_file.save(upload_path)
        backup_path = backup_current_data(username)

        result = process_excel_file(
            input_path=upload_path,
            cleaned_excel_path=cleaned_excel_path,
            json_output_path=temp_json_path
        )

        shutil.move(temp_json_path, data_file_path)

        log_user_access(username, action='Upload Data', extra=f"File: {uploaded_file.filename} | Backup: {backup_path or 'none'} | Rows: {result.get('rows')} | Buildings: {result.get('buildings')}")

        return jsonify({
            "success": True,
            "message": "資料更新成功，上一版資料已完成留存。" if backup_path else "資料更新成功，目前沒有舊版 data.json 可備份。",
            "uploaded_file": uploaded_file.filename,
            "backup_file": os.path.basename(backup_path) if backup_path else None,
            "rows": result.get("rows"),
            "buildings": result.get("buildings"),
            "warnings": result.get("warnings", [])
        })

    except DataProcessError as e:
        log_user_access(username, action='Upload Data Failed', extra=str(e))
        if os.path.exists(temp_json_path):
            os.remove(temp_json_path)
        return jsonify({"error": "data_process_failed", "message": str(e)}), 400
    except Exception as e:
        logging.exception("Unexpected upload error")
        if os.path.exists(temp_json_path):
            os.remove(temp_json_path)
        return jsonify({"error": "upload_failed", "message": str(e)}), 500

# --- 7. 啟動伺服器 ---

if __name__ == '__main__':
    print("本地伺服器已啟動，請開啟瀏覽器 (僅供開發測試用)...")
    # app.run(host='0.0.0.0', port=5020)
