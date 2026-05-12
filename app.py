import sys
import os
from flask import Flask, render_template, jsonify, request
import json
import logging
from datetime import datetime

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
log_file_path = os.path.join(base_dir, 'access_log.txt')

# 印出路徑資訊供偵錯
print("--------------------------------------------------")
print(f"目前執行模式: {'打包 EXE' if getattr(sys, 'frozen', False) else 'Python 腳本'}")
print(f"程式所在位置: {base_dir}")
print(f"尋找 HTML 位置: {template_path}")
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

def log_user_access(username):
    """ 紀錄使用者資訊與 IP """
    # 取得客戶端 IP
    if request.headers.getlist("X-Forwarded-For"):
        ip = request.headers.getlist("X-Forwarded-For")[0]
    else:
        ip = request.remote_addr
    
    logging.info(f"User: {username} | IP: {ip} | Action: View Dashboard")

# --- 4. 路由設定 ---

@app.route('/')
def index():
    # 從 IIS 抓取 Windows 整合驗證的帳號 (DOMAIN\UserName)
    # 如果在本地執行，會拿到 None，則預設顯示 'Local-Dev'
    user = request.environ.get('REMOTE_USER') or 'Local-Dev'
    
    # 紀錄到 access_log.txt
    log_user_access(user)
    
    # 渲染 templates/index.html
    return render_template('index.html')

@app.route('/api/data')
def get_data():
    try:
        if not os.path.exists(data_file_path):
            return jsonify([]) 
            
        with open(data_file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# --- 5. 啟動伺服器 ---

if __name__ == '__main__':
    # 注意：在 IIS 環境下，IIS 會透過 web.config 呼叫 app 物件，不會執行這段 __main__
    print("本地伺服器已啟動，請開啟瀏覽器 (僅供開發測試用)...")
    # app.run(host='0.0.0.0', port=5020)