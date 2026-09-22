<#
.SYNOPSIS
    資料庫部署腳本 - 套用 PostgreSQL schema，並（選用）把地端 JSON 資料匯入資料庫。

.DESCRIPTION
    這是 scripts\run_migrations.py 與 scripts\migrate_json_to_pg.py 的包裝，
    用部署目錄的 venv 執行，省得記 Python 路徑。

    連線資訊來自部署目錄的 .env（見 .env.example）或系統環境變數。
    密碼走 PGPASSWORD，不會出現在任何指令參數或 log 裡。

    典型流程：

        # 1. 先看會做什麼
        .\scripts\run-migrations.ps1 -DryRun

        # 2. 建立 schema（003 需要 CREATEROLE，若由 DBA 執行請加 -SkipRoles）
        .\scripts\run-migrations.ps1

        # 3. 匯入資料並驗收（會比對 dataset_revision 的 hash）
        .\scripts\run-migrations.ps1 -MigrateData

        # 4. 驗收通過後，把 .env 的 DATA_BACKEND 改成 postgres 並重啟網站

.PARAMETER AppRoot
    部署目錄。不指定時自動由腳本位置推導。

.PARAMETER DryRun
    只顯示會套用哪些 migration / 會搬哪些資料，不實際寫入。

.PARAMETER SkipRoles
    略過 003_roles_grants.sql。該檔需要 CREATEROLE 權限，
    公司規範若要求由 DBA 建立角色，就請 DBA 單獨執行那一份，這裡加上本參數。

.PARAMETER MigrateData
    套用 schema 之後，接著把地端 JSON 資料匯入資料庫並執行 hash 驗收。

.PARAMETER VerifyOnly
    不寫入任何東西，只驗證資料庫內容與地端 JSON 檔一致。

.PARAMETER PythonExe
    指定 Python 直譯器。不指定時優先用部署目錄的 venv。

.EXAMPLE
    .\scripts\run-migrations.ps1 -DryRun

.EXAMPLE
    .\scripts\run-migrations.ps1 -SkipRoles -MigrateData

.EXAMPLE
    .\scripts\run-migrations.ps1 -VerifyOnly
#>

[CmdletBinding()]
param(
    [string]$AppRoot,
    [switch]$DryRun,
    [switch]$SkipRoles,
    [switch]$MigrateData,
    [switch]$VerifyOnly,
    [string]$PythonExe
)

$ErrorActionPreference = 'Stop'

function Write-Ok   { param([string]$M) Write-Host "  [OK]   $M" -ForegroundColor Green }
function Write-Info { param([string]$M) Write-Host "  [--]   $M" -ForegroundColor Gray }
function Write-Warn { param([string]$M) Write-Host "  [WARN] $M" -ForegroundColor Yellow }
function Write-Fail { param([string]$M) Write-Host "  [FAIL] $M" -ForegroundColor Red }

# --- 解析部署目錄（與 deploy-iis.ps1 同一套 fallback）-----------------------
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

# --- 找 Python --------------------------------------------------------------
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
Write-Host '建物管理平台 - 資料庫部署' -ForegroundColor White
Write-Host "  部署目錄 : $AppRoot"
Write-Host "  Python   : $PythonExe"

if (-not (Test-Path (Join-Path $AppRoot '.env'))) {
    Write-Warn '找不到 .env，將只使用系統環境變數。連線資訊不齊全時下面會直接報錯。'
}

# --- 1. 套用 schema ---------------------------------------------------------
if (-not $VerifyOnly) {
    Write-Host ''
    Write-Host '--- 套用 schema migration ---' -ForegroundColor Cyan

    $migrationArgs = @((Join-Path $AppRoot 'scripts\run_migrations.py'))
    if ($DryRun)    { $migrationArgs += '--dry-run' }
    if ($SkipRoles) { $migrationArgs += '--skip-roles' }

    & $PythonExe @migrationArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Fail "migration 失敗（exit code $LASTEXITCODE），後續步驟中止。"
        exit $LASTEXITCODE
    }
}

# --- 2. 匯入資料並驗收 ------------------------------------------------------
if ($MigrateData -or $VerifyOnly) {
    Write-Host ''
    Write-Host '--- 資料匯入與驗收 ---' -ForegroundColor Cyan

    $dataArgs = @((Join-Path $AppRoot 'scripts\migrate_json_to_pg.py'),
                  '--app-root', $AppRoot,
                  '--username', $env:USERNAME)
    if ($VerifyOnly)  { $dataArgs += '--verify-only' }
    elseif ($DryRun)  { $dataArgs += '--dry-run' }

    & $PythonExe @dataArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Fail "資料匯入或驗收失敗（exit code $LASTEXITCODE）。"
        Write-Warn '在驗收通過之前，請不要把 DATA_BACKEND 切成 postgres。'
        exit $LASTEXITCODE
    }
}

Write-Host ''
Write-Ok '全部完成。'

if ($MigrateData -and -not $DryRun) {
    Write-Host ''
    Write-Host '  下一步：確認上方 hash 驗收全部 PASS 之後，' -ForegroundColor Yellow
    Write-Host '          把 .env 的 DATA_BACKEND 改成 postgres，再重啟 IIS 網站：' -ForegroundColor Yellow
    Write-Host '              Restart-WebAppPool -Name "Pool-BuildingPlatform"' -ForegroundColor White
}
Write-Host ''
