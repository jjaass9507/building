<#
.SYNOPSIS
    建立／更新本服務的兩個資料庫帳號。

.DESCRIPTION
    這是 scripts\create_db_users.py 的包裝，用部署目錄的 venv 執行。

        svc_building_mgmt_migrator  跑 migration 用，擁有 schema 與物件（DDL）
        svc_building_mgmt_rw        應用程式日常使用，只有 DML

    密碼以互動方式輸入，**不落檔案、不進 PowerShell 指令歷史、不寫 log**。
    需要用有 CREATEROLE 權限的帳號連線（通常是 DBA 給的管理帳號）。

    主機與資料庫名稱沿用部署目錄的 .env（PGHOST / PGPORT / PGDATABASE），
    只有帳號密碼在執行當下另外輸入。

    帳號已存在時只更新密碼與 LOGIN 屬性，不會動既有授權 ——
    授權由 migrations\003_roles_grants.sql 負責。

.PARAMETER AdminUser
    有 CREATEROLE 權限的帳號，例如 postgres 或 DBA 給的管理帳號。

.PARAMETER AppRoot
    部署目錄。不指定時自動由腳本位置推導。

.PARAMETER Status
    只顯示目前狀態，不做任何變更。

.PARAMETER PythonExe
    指定 Python 直譯器。不指定時優先用部署目錄的 venv。

.EXAMPLE
    .\scripts\create-db-users.ps1 -AdminUser postgres

.EXAMPLE
    # 先看兩個帳號現在的狀態
    .\scripts\create-db-users.ps1 -AdminUser postgres -Status

.NOTES
    不需要系統管理員權限（這是資料庫端的操作，不碰 IIS）。
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$AdminUser,
    [string]$AppRoot,
    [switch]$Status,
    [string]$PythonExe
)

$ErrorActionPreference = 'Stop'

function Write-Ok   { param([string]$M) Write-Host "  [OK]   $M" -ForegroundColor Green }
function Write-Info { param([string]$M) Write-Host "  [--]   $M" -ForegroundColor Gray }
function Write-Warn { param([string]$M) Write-Host "  [WARN] $M" -ForegroundColor Yellow }
function Write-Fail { param([string]$M) Write-Host "  [FAIL] $M" -ForegroundColor Red }

# --- 解析部署目錄（與其他腳本同一套 fallback）-----------------------------
if ([string]::IsNullOrWhiteSpace($AppRoot)) {
    $scriptDir = $PSScriptRoot
    if ([string]::IsNullOrWhiteSpace($scriptDir) -and $MyInvocation.MyCommand.Path) {
        $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    }
    if ([string]::IsNullOrWhiteSpace($scriptDir)) { $scriptDir = (Get-Location).Path }

    if (Test-Path (Join-Path $scriptDir 'app.py')) {
        $AppRoot = $scriptDir
    } elseif (Test-Path (Join-Path (Split-Path -Parent $scriptDir) 'app.py')) {
        $AppRoot = Split-Path -Parent $scriptDir
    } else {
        Write-Fail '無法自動判斷部署目錄，請用 -AppRoot 指定。'
        exit 1
    }
}
$AppRoot = (Resolve-Path $AppRoot).Path

if ([string]::IsNullOrWhiteSpace($PythonExe)) {
    $venvPython = Join-Path $AppRoot 'venv\Scripts\python.exe'
    if (Test-Path $venvPython) {
        $PythonExe = $venvPython
    } else {
        $PythonExe = (Get-Command python.exe -ErrorAction SilentlyContinue |
                      Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue)
    }
}
if (-not $PythonExe -or -not (Test-Path $PythonExe)) {
    Write-Fail '找不到 Python。請先執行 scripts\deploy-iis.ps1 建立 venv，或用 -PythonExe 指定。'
    exit 1
}

Write-Host ''
Write-Host '建物管理平台 - 資料庫服務帳號' -ForegroundColor White
Write-Host "  部署目錄 : $AppRoot"
Write-Host "  Python   : $PythonExe"

if (-not (Test-Path (Join-Path $AppRoot '.env'))) {
    Write-Warn '找不到 .env，將只使用系統環境變數。主機與資料庫名稱不齊全時下面會報錯。'
}

$scriptArgs = @((Join-Path $AppRoot 'scripts\create_db_users.py'), '--admin-user', $AdminUser)
if ($Status) { $scriptArgs += '--status' }

& $PythonExe @scriptArgs
$code = $LASTEXITCODE

if ($code -ne 0) {
    Write-Host ''
    Write-Fail "執行失敗（exit code $code）。"
    exit $code
}

Write-Host ''
Write-Ok '完成。'
Write-Host ''
