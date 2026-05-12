import sys
import os
from flask import Flask, render_template, jsonify, request
import json
import logging
from datetime import datetime
from functools import wraps

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

# 印出路徑資訊供偵錯
print("--------------------------------------------------")
print(f"目前執行模式: {'打包 EXE' if getattr(sys, 'frozen', False) else 'Python 腳本'}")
print(f"程式所在位置: {base_dir}")
print(f"尋找 HTML 位置: {template_path}")
print(f"權限設定位置: {permission_file_path}")
print(f"Log 紀錄位置: {log_file_path}")
print("--------------------------------------------------")

# --- 2. 初始化 Flask ---

app = Flask(__name__, 
            template_folder=template_path,
            static_folder=static_path)

app.config['JSON_AS_ASCII'] = False

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

# --- 5. 路由設定 ---

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
    """回傳目前登入使用者與角色，供前端未來做功能顯示控制。"""
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

# --- 6. 啟動伺服器 ---

if __name__ == '__main__':
    # 注意：在 IIS 環境下，IIS 會透過 web.config 呼叫 app 物件，不會執行這段 __main__
    print("本地伺服器已啟動，請開啟瀏覽器 (僅供開發測試用)...")
    # app.run(host='0.0.0.0', port=5020)