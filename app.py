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
permission_file_path = os.path.join(base_dir, 'permissions.json')
log_file_path = os.path.join(base_dir, 'access_log.txt')
upload_dir = os.path.join(base_dir, 'uploads')
backup_dir = os.path.join(base_dir, 'data_backups')
processed_dir = os.path.join(base_dir, 'processed')
cleaned_excel_path = os.path.join(processed_dir, '樓層面積資訊_系統匯入檔.xlsx')

ALLOWED_UPLOAD_EXTENSIONS = {'.xlsx'}

# 印出路徑資訊供偵錯
print("--------------------------------------------------")
print(f"目前執行模式: {'打包 EXE' if getattr(sys, 'frozen', False) else 'Python 腳本'}")
print(f"程式所在位置: {base_dir}")
print(f"尋找 HTML 位置: {template_path}")
print(f"權限設定位置: {permission_file_path}")
print(f"資料備份位置: {backup_dir}")
print(f"Log 紀錄位置: {log_file_path}")
print("--------------------------------------------------")

# --- 2. 初始化 Flask ---

app = Flask(__name__, 
            template_folder=template_path,
            static_folder=static_path)

app.config['JSON_AS_ASCII'] = False
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB

# --- 3. 設定 Logging (紀錄使用者進入) ---

logging.basicConfig(
    filename=log_file_path,
    level=logging.INFO,
    format='%(asctime)s - %(message)s',
    encoding='utf-8'
)

def get_client_ip():
    """取得客戶端 IP。"""
    if request.headers.getlist("X-Forwarded-For"):
        return request.headers.getlist("X-Forwarded-For")[0]
    return request.remote_addr

def get_current_user():
    """
    從 IIS Windows Integrated Authentication 取得目前 AD 使用者。
    本機開發時若沒有 REMOTE_USER，預設為 Local-Dev。
    """
    return request.environ.get('REMOTE_USER') or 'Local-Dev'

def log_user_access(username, action='View Dashboard', extra=''):
    """紀錄使用者資訊與 IP。"""
    ip = get_client_ip()
    extra_msg = f" | {extra}" if extra else ""
    logging.info(f"User: {username} | IP: {ip} | Action: {action}{extra_msg}")

# --- 4. 身份與權限控管 ---

def load_permissions():
    """
    載入 permissions.json。
    若檔案不存在或格式錯誤，採用安全預設：只允許 Local-Dev 作為 admin。
    """
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
    """統一帳號比對格式，避免大小寫造成權限判斷失敗。"""
    return (username or '').strip().lower()

def get_user_role(username):
    """根據 permissions.json 判斷使用者角色。"""
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
    """判斷目前請求是否為 API。"""
    return request.path.startswith('/api/')

def require_roles(*allowed_roles):
    """
    Route 權限控管 decorator。
    使用範例：@require_roles("admin", "user", "viewer")
    """
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

                return render_template(
                    '403.html',
                    username=username,
                    role=role,
                    required_roles=allowed_roles
                ), 403

            return func(*args, **kwargs)

        return wrapper
    return decorator

# --- 5. 資料上傳與版本留存 ---

def ensure_runtime_dirs():
    """確保上傳、備份與處理後資料夾存在。"""
    for folder in [upload_dir, backup_dir, processed_dir]:
        os.makedirs(folder, exist_ok=True)

def is_allowed_upload(filename):
    """限制只允許上傳 .xlsx。"""
    _, ext = os.path.splitext(filename or '')
    return ext.lower() in ALLOWED_UPLOAD_EXTENSIONS

def backup_current_data(username):
    """覆蓋 data.json 前，先備份上一版。"""
    if not os.path.exists(data_file_path):
        return None

    ensure_runtime_dirs()
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    safe_user = secure_filename(username.replace('\\', '_').replace('/', '_')) or 'unknown'
    backup_filename = f"data_{timestamp}_{safe_user}.json"
    backup_path = os.path.join(backup_dir, backup_filename)
    shutil.copy2(data_file_path, backup_path)
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
    """回傳目前登入使用者與角色，供前端做功能顯示控制。"""
    username = get_current_user()
    role = get_user_role(username)
    return jsonify({
        "username": username,
        "role": role
    })

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

@app.route('/api/admin/upload-data', methods=['POST'])
@require_roles("admin")
def upload_data_file():
    """admin 專用：上傳樓層面積 Excel，清洗後更新 data.json，並備份上一版。"""
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

        log_user_access(
            username,
            action='Upload Data',
            extra=f"File: {uploaded_file.filename} | Backup: {backup_path or 'none'} | Rows: {result.get('rows')} | Buildings: {result.get('buildings')}"
        )

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
    # 注意：在 IIS 環境下，IIS 會透過 web.config 呼叫 app 物件，不會執行這段 __main__
    print("本地伺服器已啟動，請開啟瀏覽器 (僅供開發測試用)...")
    # app.run(host='0.0.0.0', port=5020)