import sys
import os
import shutil
import secrets
import base64
import struct
import time
from flask import Flask, render_template, jsonify, request, session, redirect, url_for, send_file
import json
import logging
from datetime import datetime, timedelta
from functools import wraps
from werkzeug.utils import secure_filename

from data_processor import DataProcessError, process_excel_file
from building_data_manager import (
    BuildingDataError,
    append_audit_record,
    build_readable_workbook,
    build_standard_workbook,
    dataset_counts,
    dataset_revision,
    load_audit_records,
    normalize_dataset,
    summarize_changes,
)

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
process_groups_file_path = os.path.join(base_dir, 'process_groups.json')
permission_file_path = os.path.join(base_dir, 'permissions.json')
log_file_path = os.path.join(base_dir, 'access_log.txt')
upload_dir = os.path.join(base_dir, 'uploads')
backup_dir = os.path.join(base_dir, 'data_backups')
utility_backup_dir = os.path.join(base_dir, 'utility_trend_backups')
process_group_backup_dir = os.path.join(base_dir, 'process_group_backups')
processed_dir = os.path.join(base_dir, 'processed')
cleaned_excel_path = os.path.join(processed_dir, '樓層面積資訊_系統匯入檔.xlsx')
data_changes_file_path = os.path.join(base_dir, 'data_changes.json')

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


def env_text(name, default=''):
    value = os.environ.get(name, default)
    return value.strip() if isinstance(value, str) else default


def env_flag(name, default=False):
    value = env_text(name).lower()
    if not value:
        return default
    return value in ('1', 'true', 'yes', 'on')


# --- 2-1. AD / 登入相關設定 (由 web.config 的 appSettings 或系統環境變數提供) ---

AD_SERVER = env_text('AD_SERVER')            # 例：ldap://ASE 或 ldap://ad.company.com
AD_DOMAIN = env_text('AD_DOMAIN')            # 例：ase.company.com (UPN 用)
AD_NETBIOS = env_text('AD_NETBIOS')          # 例：ASE；未設定時自動由 AD_SERVER / AD_DOMAIN 推導
try:
    AD_TIMEOUT = int(env_text('AD_TIMEOUT') or 5)
except ValueError:
    AD_TIMEOUT = 5
AD_MOCK = env_flag('AD_MOCK')                # 僅供本機開發：不連 AD，任何密碼都通過
SSO_PROBE_ENABLED = env_flag('APP_SSO_PROBE', True)
DEV_USER = env_text('APP_DEV_USER')          # 本機開發用的假身分，正式機請勿設定
secret_key_path = os.path.join(base_dir, 'secret_key.txt')


def load_secret_key():
    """
    session cookie 的簽章金鑰。
    優先讀環境變數 APP_SECRET_KEY；沒有的話在程式目錄產生 secret_key.txt 並沿用，
    這樣 IIS 重啟或 FastCGI 換 process 時，使用者不會被迫重新登入。
    """
    configured = env_text('APP_SECRET_KEY')
    if configured:
        return configured

    try:
        if os.path.exists(secret_key_path):
            with open(secret_key_path, 'r', encoding='utf-8') as f:
                saved = f.read().strip()
            if saved:
                return saved

        generated = secrets.token_hex(32)
        with open(secret_key_path, 'w', encoding='utf-8') as f:
            f.write(generated)
        return generated
    except Exception as e:
        print(f"[WARN] 無法讀寫 secret_key.txt ({e})，改用暫時金鑰，重啟後登入狀態會失效。")
        return secrets.token_hex(32)


app.secret_key = load_secret_key()
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(hours=12)


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

def log_user_access(username, action='View Dashboard', extra=''):
    ip = get_client_ip()
    extra_msg = f" | {extra}" if extra else ""
    logging.info(f"User: {username or 'anonymous'} | IP: {ip} | Action: {action}{extra_msg}")

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

def identity_variants(username):
    """
    同一個人在不同來源會有不同寫法：
      Windows SSO    -> 'ASE\\K11879' 或 'K11879@ase.company.com'
      AD 手動登入    -> 'K11879'
    permissions.json 不管填哪一種都要能對得起來，所以把可能的寫法都列出來比對。
    """
    normalized = normalize_identity(username)
    if not normalized:
        return set()

    variants = {normalized}
    if '\\' in normalized:
        variants.add(normalized.split('\\')[-1])
    if '@' in normalized:
        variants.add(normalized.split('@')[0])
    variants.discard('')
    return variants

def get_user_role(username):
    permissions = load_permissions()
    user_variants = identity_variants(username)
    if not user_variants:
        return None

    role_map = [
        ("admin", permissions.get("admins", [])),
        ("user", permissions.get("users", [])),
        ("viewer", permissions.get("viewers", []))
    ]

    for role, members in role_map:
        for member in members:
            if user_variants & identity_variants(member):
                return role

    return None

def is_api_request():
    return request.path.startswith('/api/')

# --- 4-1. Windows SSO 身分解析 ---

def clean_username(raw):
    """把 'DOMAIN\\user' / 'user@domain' 統一成純帳號。"""
    value = (raw or '').strip()
    if not value:
        return ''
    if '\\' in value:
        value = value.split('\\')[-1]
    if '@' in value:
        value = value.split('@')[0]
    return value.strip()

def username_from_windows_token(token_handle):
    """
    IIS 開啟 forwardWindowsAuthToken 時，會用 X-IIS-WindowsAuthToken 傳一個 token handle。
    正確做法是讀 token 的 SID 再反查帳號 (LookupAccountSid)；
    千萬不要用 ImpersonateLoggedOnUser + GetUserNameEx，那會拿到 IIS 處理程序自己的帳號。
    """
    if sys.platform != 'win32':
        return ''

    try:
        import ctypes
        from ctypes import wintypes

        advapi32 = ctypes.windll.advapi32
        advapi32.GetTokenInformation.argtypes = [
            wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
            wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
        advapi32.GetTokenInformation.restype = wintypes.BOOL
        advapi32.LookupAccountSidW.argtypes = [
            wintypes.LPCWSTR, ctypes.c_void_p,
            wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD),
            wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD),
            ctypes.POINTER(wintypes.DWORD)]
        advapi32.LookupAccountSidW.restype = wintypes.BOOL

        token_user = 1
        size = wintypes.DWORD(0)
        advapi32.GetTokenInformation(token_handle, token_user, None, 0, ctypes.byref(size))
        if size.value == 0:
            return ''

        buffer = ctypes.create_string_buffer(size.value)
        if not advapi32.GetTokenInformation(token_handle, token_user, buffer, size, ctypes.byref(size)):
            return ''

        psid = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0]
        name = ctypes.create_unicode_buffer(256)
        name_len = wintypes.DWORD(256)
        domain = ctypes.create_unicode_buffer(256)
        domain_len = wintypes.DWORD(256)
        sid_type = wintypes.DWORD()

        if not advapi32.LookupAccountSidW(None, psid, name, ctypes.byref(name_len),
                                          domain, ctypes.byref(domain_len), ctypes.byref(sid_type)):
            return ''
        return name.value or ''
    except Exception as e:
        logging.warning(f"Decode X-IIS-WindowsAuthToken failed: {e}")
        return ''

def username_from_ntlm_header(auth_header):
    """瀏覽器用 NTLM 驗證時，Type-3 訊息裡就帶著帳號，可直接解析。"""
    try:
        raw = base64.b64decode((auth_header or '').split(' ', 1)[-1].strip())
        if len(raw) < 44 or struct.unpack_from('<I', raw, 8)[0] != 3:
            return ''
        name_len = struct.unpack_from('<H', raw, 36)[0]
        name_offset = struct.unpack_from('<I', raw, 40)[0]
        return raw[name_offset:name_offset + name_len].decode('utf-16-le')
    except Exception:
        return ''

def get_sso_username(trust_forwarded_token=False):
    """
    取得 IIS Windows 驗證帶進來的帳號。

    REMOTE_USER / LOGON_USER / AUTH_USER 是 IIS 自己填的伺服器變數，任何路徑都可信任。
    X-IIS-WindowsAuthToken 與 Authorization 是 HTTP header，只有在「已關閉匿名驗證」的
    /auth/sso 這條路徑上才採信 (trust_forwarded_token=True)，避免匿名路徑被偽造 header 冒充身分。
    """
    environ = request.environ

    for key in ('REMOTE_USER', 'LOGON_USER', 'AUTH_USER'):
        username = clean_username(environ.get(key))
        if username:
            return username

    if not trust_forwarded_token:
        return ''

    token = environ.get('HTTP_X_IIS_WINDOWSAUTHTOKEN')
    if token:
        try:
            username = clean_username(username_from_windows_token(int(token, 16)))
            if username:
                return username
        except ValueError:
            logging.warning("X-IIS-WindowsAuthToken 格式不是十六進位字串，忽略。")

    auth_header = environ.get('HTTP_AUTHORIZATION', '')
    if auth_header.upper().startswith('NTLM '):
        username = clean_username(username_from_ntlm_header(auth_header))
        if username:
            return username

    return ''

# --- 4-2. 目前使用者 (session 手動登入 > Windows SSO > 開發用假身分) ---

def get_current_user():
    """回傳目前使用者帳號；沒有身分時回傳空字串 (代表尚未登入)。"""
    session_user = session.get('user')
    if session_user:
        return session_user

    if session.get('logged_out'):
        return ''

    sso_user = get_sso_username()
    if sso_user:
        return sso_user

    return DEV_USER

def get_auth_type():
    if session.get('user'):
        return session.get('auth_type') or 'manual'
    if session.get('logged_out'):
        return None
    if get_sso_username():
        return 'sso'
    if DEV_USER:
        return 'dev'
    return None

def sign_in(username, auth_type):
    session.clear()
    session.permanent = True
    session['user'] = username
    session['auth_type'] = auth_type

def sign_out():
    session.clear()
    session.permanent = True
    # 沒有這個旗標的話，登出後下一個 request 又會被 Windows SSO 自動帶回同一個帳號，
    # 使用者永遠切換不了帳號。
    session['logged_out'] = True

def safe_next_target(raw):
    """只允許站內相對路徑，避免被導到外部網站。"""
    target = (raw or '').strip()
    if not target.startswith('/') or target.startswith('//') or '\\' in target:
        return url_for('index')
    return target

# --- 4-3. AD 帳密驗證 (手動登入) ---

login_failures = {}
LOGIN_MAX_FAILURES = 5
LOGIN_LOCK_SECONDS = 60

def ad_login_available():
    return bool(AD_SERVER) or AD_MOCK

def resolve_netbios():
    if AD_NETBIOS:
        return AD_NETBIOS.upper()
    host = AD_SERVER.replace('ldaps://', '').replace('ldap://', '').split('/')[0].split(':')[0]
    if host and '.' not in host:
        return host.upper()
    if AD_DOMAIN:
        return AD_DOMAIN.split('.')[0].upper()
    return ''

def ad_bind_candidates(username):
    """AD bind 帳號格式的優先順序：NETBIOS\\user -> user@domain -> user。"""
    candidates = []
    netbios = resolve_netbios()
    if netbios:
        candidates.append(f"{netbios}\\{username}")
    if AD_DOMAIN:
        candidates.append(f"{username}@{AD_DOMAIN}")
    candidates.append(username)

    unique = []
    for item in candidates:
        if item not in unique:
            unique.append(item)
    return unique

def verify_ad_password(username, password):
    """
    用 LDAP SIMPLE bind 驗證 AD 帳密，bind 成功就代表密碼正確。
    回傳 (是否通過, 失敗原因代碼)。

    註：不用 NTLM bind，因為 OpenSSL 3.0 已停用 MD4，NTLM 會直接噴
    'unsupported hash type MD4'；SIMPLE bind 不需要 MD4。
    """
    if not username or not password.strip():
        return False, 'empty_credentials'

    if AD_MOCK:
        logging.warning(f"AD_MOCK 已啟用，未實際驗證 AD 密碼：{username}")
        return True, ''

    if not AD_SERVER:
        return False, 'not_configured'

    try:
        from ldap3 import Server, Connection, NONE, SIMPLE
        from ldap3.core.exceptions import LDAPException, LDAPSocketOpenError
    except ImportError:
        logging.error("缺少 ldap3 套件，無法進行 AD 手動登入驗證。")
        return False, 'ldap3_missing'

    server = Server(AD_SERVER, get_info=NONE, connect_timeout=AD_TIMEOUT)
    last_error = ''

    for bind_user in ad_bind_candidates(username):
        try:
            conn = Connection(
                server,
                user=bind_user,
                password=password,
                authentication=SIMPLE,
                auto_bind=True,
                receive_timeout=AD_TIMEOUT
            )
            conn.unbind()
            return True, ''
        except LDAPSocketOpenError as e:
            logging.error(f"無法連線 AD 伺服器 {AD_SERVER}: {e}")
            return False, 'server_unreachable'
        except LDAPException as e:
            last_error = str(e)
        except Exception as e:
            last_error = str(e)

    if last_error:
        logging.info(f"AD bind 失敗 ({username}): {last_error}")
    return False, 'invalid_credentials'

def login_lock_remaining(key):
    record = login_failures.get(key)
    if not record:
        return 0
    count, last_failed_at = record
    if count < LOGIN_MAX_FAILURES:
        return 0
    remaining = int(LOGIN_LOCK_SECONDS - (time.time() - last_failed_at))
    if remaining <= 0:
        login_failures.pop(key, None)
        return 0
    return remaining

def record_login_failure(key):
    count, _ = login_failures.get(key, (0, 0))
    login_failures[key] = (count + 1, time.time())

# --- 4-4. 權限裝飾器 ---

def require_roles(*allowed_roles):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            username = get_current_user()

            # 尚未取得任何身分 (匿名進站、或按掉 Windows 驗證視窗)：導去登入頁，
            # 不要回 401，IIS 會把 401 攔下來再彈一次 Windows 帳密視窗。
            if not username:
                log_user_access('', action='Login Required', extra=f"Path: {request.path}")

                if is_api_request():
                    return jsonify({
                        "error": "unauthenticated",
                        "message": "尚未登入，請先登入。",
                        "login_url": url_for('login_page')
                    }), 403

                # next 要帶上 script_root，掛在 IIS 子應用程式底下時才不會導回網站根目錄
                original_url = f"{request.script_root}{request.full_path}".rstrip('?')
                return redirect(url_for('login_page', next=original_url))

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
    for folder in [upload_dir, backup_dir, utility_backup_dir, process_group_backup_dir, processed_dir]:
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


def load_current_data():
    if not os.path.exists(data_file_path):
        return []
    with open(data_file_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise BuildingDataError("data.json 根節點必須是陣列。")
    return data


def write_current_data(data):
    """以暫存檔原子替換目前資料，避免寫入中斷留下半份 JSON。"""
    ensure_runtime_dirs()
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
    temp_path = os.path.join(processed_dir, f"data_maintenance_pending_{timestamp}.json")
    with open(temp_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=4)
    os.replace(temp_path, data_file_path)

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


def create_default_process_groups():
    return {
        "schema_version": "1.0",
        "updated_at": None,
        "updated_by": None,
        "groups": []
    }


def validate_process_groups(payload):
    if not isinstance(payload, dict):
        raise ValueError("製程大群組設定必須是 JSON object。")
    groups = payload.get("groups", [])
    if not isinstance(groups, list):
        raise ValueError("groups 必須是陣列。")
    if len(groups) > 100:
        raise ValueError("製程大群組最多 100 組。")

    normalized = []
    group_names = set()
    group_ids = set()
    process_owners = {}
    reserved_processes = {"混合", "未分類", "未分群", "非製程"}
    reserved_group_names = {"混合", "未分類", "未分群"}
    for index, raw_group in enumerate(groups):
        if not isinstance(raw_group, dict):
            raise ValueError(f"第 {index + 1} 個大群組格式不正確。")
        name = str(raw_group.get("name") or "").strip()
        if not name:
            raise ValueError(f"第 {index + 1} 個大群組必須填寫名稱。")
        if len(name) > 80:
            raise ValueError(f"大群組「{name[:20]}」名稱不可超過 80 字。")
        if name in group_names:
            raise ValueError(f"大群組名稱「{name}」重複。")
        if name in reserved_group_names:
            raise ValueError(f"「{name}」是系統分類，不能作為大群組名稱。")
        group_names.add(name)

        processes = raw_group.get("processes", [])
        if not isinstance(processes, list):
            raise ValueError(f"大群組「{name}」的 processes 必須是陣列。")
        clean_processes = []
        for raw_process in processes:
            process = str(raw_process or "").strip()
            if not process or process in clean_processes:
                continue
            if len(process) > 200:
                raise ValueError(f"製程名稱「{process[:20]}」不可超過 200 字。")
            if process in reserved_processes:
                raise ValueError(f"「{process}」是系統分類，不能指定至大群組。")
            if process in process_owners:
                raise ValueError(f"製程「{process}」已屬於「{process_owners[process]}」，不可重複分群。")
            process_owners[process] = name
            clean_processes.append(process)

        group_id = str(raw_group.get("id") or f"group-{secrets.token_hex(6)}").strip()[:120]
        if group_id in group_ids:
            raise ValueError(f"大群組 ID「{group_id}」重複。")
        group_ids.add(group_id)
        normalized.append({"id": group_id, "name": name, "processes": clean_processes})

    return {
        "schema_version": "1.0",
        "updated_at": payload.get("updated_at"),
        "updated_by": payload.get("updated_by"),
        "groups": normalized
    }


def load_process_groups():
    if not os.path.exists(process_groups_file_path):
        return create_default_process_groups()
    with open(process_groups_file_path, 'r', encoding='utf-8') as handle:
        return validate_process_groups(json.load(handle))


def write_process_groups(data):
    ensure_runtime_dirs()
    temp_path = os.path.join(processed_dir, f"process_groups_pending_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}.json")
    with open(temp_path, 'w', encoding='utf-8') as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
    os.replace(temp_path, process_groups_file_path)

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

# --- 6. 登入相關路由 ---

@app.route('/login')
def login_page():
    """
    登入畫面。整個網站唯一允許匿名進入的頁面。

    使用者若在 Windows 驗證視窗按了「取消」，IIS 以前會直接吐出錯誤頁；
    現在站台改成匿名可進，任何沒有身分的請求都會被導到這裡，
    再由這頁去嘗試 SSO，或讓使用者手動輸入 AD 帳密。
    """
    username = get_current_user()
    next_target = safe_next_target(request.args.get('next'))

    # 已經有合法身分就不必停在登入頁 (除非明確要求切換帳號)。
    if username and get_user_role(username) and request.args.get('switch') != '1':
        return redirect(next_target)

    return render_template(
        'login.html',
        next_target=next_target,
        # 剛按過登出就不要自動 SSO，否則會立刻被同一個 Windows 帳號帶回去，切換不了帳號。
        auto_sso=SSO_PROBE_ENABLED and not session.get('logged_out'),
        sso_probe_enabled=SSO_PROBE_ENABLED,
        ad_login_available=ad_login_available()
    )

@app.route('/auth/sso')
def auth_sso():
    """
    Windows SSO 探測點：IIS 上只有這條路徑關閉匿名驗證。

    網域內電腦會自動帶入 Windows 身分 (不會有任何視窗)；
    非網域電腦會跳出帳密視窗，使用者按取消時這裡回 401，
    前端接住後就停在登入畫面，不會出現 IIS 的錯誤頁。

    無論成功失敗都回 200，不要回 401，否則 IIS 會再彈一次 Windows 帳密視窗。
    """
    username = get_sso_username(trust_forwarded_token=True)

    if not username:
        return jsonify({"ok": False, "reason": "no_identity"})

    role = get_user_role(username)
    sign_in(username, 'sso')
    log_user_access(username, action='SSO Login', extra=f"Role: {role or 'unauthorized'}")

    return jsonify({
        "ok": True,
        "username": username,
        "role": role,
        "authorized": role is not None
    })

@app.route('/api/auth/status')
def auth_status():
    """前端判斷登入狀態用。永遠回 200，用欄位表示狀態。"""
    username = get_current_user()
    role = get_user_role(username) if username else None
    return jsonify({
        "authenticated": bool(username),
        "authorized": role is not None,
        "username": username or None,
        "role": role,
        "auth_type": get_auth_type(),
        "sso_probe_enabled": SSO_PROBE_ENABLED,
        "ad_login_available": ad_login_available()
    })

@app.route('/api/auth/login', methods=['POST'])
def auth_login():
    """AD 帳密手動登入。失敗一律回 200 + ok:false，避免 IIS 攔截 401 彈出視窗。"""
    payload = request.get_json(silent=True) or {}
    username = clean_username(payload.get('username'))
    password = payload.get('password') or ''

    if not username or not password.strip():
        return jsonify({"ok": False, "message": "請輸入 AD 帳號與密碼。"})

    lock_key = f"{normalize_identity(username)}|{get_client_ip()}"
    locked_for = login_lock_remaining(lock_key)
    if locked_for:
        return jsonify({"ok": False, "message": f"登入失敗次數過多，請於 {locked_for} 秒後再試。"})

    passed, reason = verify_ad_password(username, password)

    if not passed:
        record_login_failure(lock_key)
        log_user_access(username, action='Login Failed', extra=f"Reason: {reason}")

        messages = {
            'not_configured': "系統尚未設定 AD 伺服器 (AD_SERVER)，請聯繫系統管理者。",
            'ldap3_missing': "伺服器缺少 ldap3 套件，無法進行 AD 驗證，請聯繫系統管理者。",
            'server_unreachable': "無法連線 AD 伺服器，請稍後再試或聯繫系統管理者。",
            'empty_credentials': "請輸入 AD 帳號與密碼。"
        }
        return jsonify({"ok": False, "message": messages.get(reason, "AD 帳號或密碼錯誤。")})

    login_failures.pop(lock_key, None)
    role = get_user_role(username)
    sign_in(username, 'manual')
    log_user_access(username, action='Manual Login', extra=f"Role: {role or 'unauthorized'}")

    return jsonify({
        "ok": True,
        "username": username,
        "role": role,
        "authorized": role is not None,
        "redirect_url": safe_next_target(payload.get('next'))
    })

@app.route('/api/auth/logout', methods=['POST'])
def auth_logout():
    username = get_current_user()
    sign_out()
    log_user_access(username, action='Logout')
    return jsonify({"ok": True, "login_url": url_for('login_page')})

@app.route('/logout')
def logout_page():
    username = get_current_user()
    sign_out()
    log_user_access(username, action='Logout')
    return redirect(url_for('login_page'))

# --- 7. 路由設定 ---

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
    return jsonify({
        "username": username,
        "role": role,
        "auth_type": get_auth_type(),
        "logout_url": url_for('logout_page')
    })

@app.route('/api/data')
@require_roles("admin", "user", "viewer")
def get_data():
    try:
        return jsonify(load_current_data())
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/process-groups')
@require_roles("admin", "user", "viewer")
def get_process_groups():
    try:
        return jsonify({"success": True, "data": load_process_groups()})
    except (ValueError, OSError, json.JSONDecodeError) as e:
        return jsonify({"error": "load_failed", "message": str(e)}), 500


@app.route('/api/admin/process-groups', methods=['POST'])
@require_roles("admin")
def save_process_groups():
    username = get_current_user()
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_json", "message": "請提供 JSON 格式資料。"}), 400

    try:
        data = validate_process_groups(payload)
        data["updated_at"] = datetime.now().isoformat(timespec='seconds')
        data["updated_by"] = username
        ensure_runtime_dirs()
        backup_path = None
        if os.path.exists(process_groups_file_path):
            backup_name = f"process_groups_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}_{safe_username(username)}.json"
            backup_path = os.path.join(process_group_backup_dir, backup_name)
            shutil.copy2(process_groups_file_path, backup_path)
        write_process_groups(data)
        log_user_access(username, action='Update Process Groups', extra=f"Groups: {len(data['groups'])} | Backup: {backup_path or 'none'}")
        return jsonify({
            "success": True,
            "message": "製程大群組設定已更新。",
            "backup_file": os.path.basename(backup_path) if backup_path else None,
            "data": data
        })
    except ValueError as e:
        return jsonify({"error": "validation_failed", "message": str(e)}), 400
    except Exception as e:
        logging.exception("Unexpected process group update error")
        return jsonify({"error": "save_failed", "message": str(e)}), 500


@app.route('/api/export-data/<export_mode>')
@require_roles("admin", "user", "viewer")
def export_building_data(export_mode):
    if export_mode not in ('readable', 'standard'):
        return jsonify({"error": "invalid_export_mode", "message": "匯出格式僅支援 readable 或 standard。"}), 400

    username = get_current_user()
    try:
        data = load_current_data()
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        if export_mode == 'readable':
            workbook = build_readable_workbook(data, load_audit_records(data_changes_file_path), username)
            filename = f"建物面積_人員閱讀版_{timestamp}.xlsx"
            action = 'Export Readable Building Data'
        else:
            workbook = build_standard_workbook(data, username, load_audit_records(data_changes_file_path))
            filename = f"建物面積_標準資料版_{timestamp}.xlsx"
            action = 'Export Standard Building Data'

        log_user_access(username, action=action, extra=f"Buildings: {len(data)}")
        return send_file(
            workbook,
            as_attachment=True,
            download_name=filename,
            mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
    except (BuildingDataError, ValueError) as e:
        return jsonify({"error": "export_validation_failed", "message": str(e)}), 400
    except Exception as e:
        logging.exception("Unexpected building data export error")
        return jsonify({"error": "export_failed", "message": str(e)}), 500


@app.route('/api/admin/building-data', methods=['GET'])
@require_roles("admin")
def get_building_data_for_maintenance():
    try:
        data = normalize_dataset(load_current_data())
        return jsonify({
            "success": True,
            "data": data,
            "revision": dataset_revision(data),
            "counts": dataset_counts(data),
            "audit_records": list(reversed(load_audit_records(data_changes_file_path)[-30:]))
        })
    except (BuildingDataError, ValueError) as e:
        return jsonify({"error": "data_validation_failed", "message": str(e)}), 400
    except Exception as e:
        logging.exception("Unexpected building maintenance load error")
        return jsonify({"error": "load_failed", "message": str(e)}), 500


@app.route('/api/admin/building-data', methods=['POST'])
@require_roles("admin")
def save_building_data_from_maintenance():
    username = get_current_user()
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_json", "message": "請提供 JSON 格式資料。"}), 400

    reason = str(payload.get('reason') or '').strip()
    if not reason:
        return jsonify({"error": "missing_reason", "message": "請填寫本次異動原因。"}), 400
    if len(reason) > 500:
        return jsonify({"error": "reason_too_long", "message": "異動原因不可超過 500 字。"}), 400

    effective_date = str(payload.get('effective_date') or '').strip()
    try:
        datetime.strptime(effective_date, '%Y-%m-%d')
    except ValueError:
        return jsonify({"error": "invalid_effective_date", "message": "請填寫有效的生效日期。"}), 400

    change_type = str(payload.get('change_type') or '').strip().upper()
    allowed_change_types = {'ADD', 'ADJUST', 'EXPAND', 'REDUCE', 'DEMOLISH'}
    if change_type not in allowed_change_types:
        return jsonify({"error": "invalid_change_type", "message": "請選擇有效的異動類型。"}), 400

    source_reference = str(payload.get('source_reference') or '').strip()
    if len(source_reference) > 500:
        return jsonify({"error": "source_reference_too_long", "message": "資料來源不可超過 500 字。"}), 400

    try:
        before = normalize_dataset(load_current_data())
        current_revision = dataset_revision(before)
        expected_revision = str(payload.get('revision') or '')
        if expected_revision and expected_revision != current_revision:
            return jsonify({
                "error": "revision_conflict",
                "message": "資料已被其他管理人員更新，請重新載入後再修改。",
                "current_revision": current_revision
            }), 409

        after = normalize_dataset(payload.get('data'))
        summary = summarize_changes(before, after)
        if before == after:
            return jsonify({"error": "no_changes", "message": "資料內容沒有變更。"}), 400

        backup_path = backup_current_data(username)
        write_current_data(after)
        new_revision = dataset_revision(after)
        audit_record = {
            "changed_at": datetime.now().isoformat(timespec='seconds'),
            "effective_date": effective_date,
            "change_type": change_type,
            "changed_by": username,
            "reason": reason,
            "source_reference": source_reference,
            "revision_before": current_revision,
            "revision_after": new_revision,
            "backup_file": os.path.basename(backup_path) if backup_path else None,
            "summary": summary,
            "counts": dataset_counts(after)
        }
        append_audit_record(data_changes_file_path, audit_record)
        log_user_access(username, action='Maintain Building Data', extra=f"Reason: {reason} | Summary: {summary}")

        return jsonify({
            "success": True,
            "message": "建物面積資料已更新。",
            "data": after,
            "revision": new_revision,
            "counts": dataset_counts(after),
            "backup_file": os.path.basename(backup_path) if backup_path else None,
            "summary": summary
        })
    except BuildingDataError as e:
        return jsonify({"error": "data_validation_failed", "message": str(e)}), 400
    except Exception as e:
        logging.exception("Unexpected building maintenance save error")
        return jsonify({"error": "save_failed", "message": str(e)}), 500

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
        before = normalize_dataset(load_current_data())
        backup_path = backup_current_data(username)

        result = process_excel_file(
            input_path=upload_path,
            cleaned_excel_path=cleaned_excel_path,
            json_output_path=temp_json_path
        )

        with open(temp_json_path, 'r', encoding='utf-8') as f:
            converted_data = json.load(f)
        after = normalize_dataset(converted_data)
        write_current_data(after)
        if os.path.exists(temp_json_path):
            os.remove(temp_json_path)

        audit_record = {
            "changed_at": datetime.now().isoformat(timespec='seconds'),
            "effective_date": datetime.now().strftime('%Y-%m-%d'),
            "change_type": "IMPORT",
            "changed_by": username,
            "reason": f"上傳 Excel：{uploaded_file.filename}",
            "source_reference": uploaded_file.filename,
            "revision_before": dataset_revision(before),
            "revision_after": dataset_revision(after),
            "backup_file": os.path.basename(backup_path) if backup_path else None,
            "summary": summarize_changes(before, after),
            "counts": dataset_counts(after)
        }
        append_audit_record(data_changes_file_path, audit_record)

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

# --- 8. 啟動伺服器 ---

if __name__ == '__main__':
    # 本機開發沒有 IIS，也就沒有 Windows 驗證身分；給一個預設帳號才能進到畫面。
    # 這段只有直接執行 app.py 時會生效，IIS (wfastcgi) 走的是 app.app，不會經過這裡。
    if not DEV_USER:
        DEV_USER = 'Local-Dev'
        print("本機模式：未設定 APP_DEV_USER，預設以 Local-Dev 身分登入。")

    print("本地伺服器已啟動，請開啟瀏覽器 (僅供開發測試用)...")
    # app.run(host='0.0.0.0', port=5020)
