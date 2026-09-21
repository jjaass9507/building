<#
.SYNOPSIS
    離線部署打包腳本 - 在可連網的機器上產生 wheels\，供內網部署機離線安裝。

.DESCRIPTION
    **在開發機（可連網）執行，不是在部署機執行。**

    部署機連不到 PyPI 時，deploy-iis.ps1 要加 -Offline 從 wheels\ 安裝。
    這支腳本負責產生那個 wheels\，並且**實際驗證它真的裝得起來**——
    打包完卻在部署機才發現少一個相依套件，是離線部署最常見的坑。

    流程：
      1. 確認本機 pip 可用、可連網
      2. pip download 目標平台（win_amd64）與指定 Python 版本的 wheel
      3. 驗證：建立一個暫時 venv，用 --no-index 從 wheels\ 安裝一次，
         再跑 pip check 確認相依關係完整（本機 Python 版本相符時才做）
      4. 列出還必須手動帶進內網的東西（Python 安裝程式、HttpPlatformHandler MSI）
      5. -Zip：把原始碼與 wheels\ 打包成一個可搬運的 zip

    === Python 版本必須一致 ===
    wheel 分 Python 版本（cp311、cp312…）。-PythonVersion 必須與**部署機實際安裝的
    Python** 相同，否則 psycopg、pandas、numpy 這些含 C extension 的套件會裝不起來。
    部署機上用 `python --version` 先確認。

.PARAMETER AppRoot
    專案根目錄。不指定時自動由腳本位置推導。

.PARAMETER PythonVersion
    部署機的 Python 版本（只需主次版號，例如 3.11）。預設 3.11。

.PARAMETER OutDir
    wheel 輸出目錄。預設 <AppRoot>\wheels。

.PARAMETER SkipVerify
    略過安裝驗證。本機 Python 版本與 -PythonVersion 不同時會自動略過。

.PARAMETER Zip
    另外把原始碼與 wheels\ 打包成 building-platform-offline-<日期>.zip，
    方便用 USB 或檔案傳輸帶進內網。

.EXAMPLE
    # 部署機是 Python 3.11
    .\scripts\build-offline-bundle.ps1 -PythonVersion 3.11

.EXAMPLE
    # 連可搬運的 zip 一起產生
    .\scripts\build-offline-bundle.ps1 -PythonVersion 3.11 -Zip

.NOTES
    不需要系統管理員權限。這支腳本不會修改 IIS，也不會動到部署機。
#>

[CmdletBinding()]
param(
    [string]$AppRoot,
    [string]$PythonVersion = '3.11',
    [string]$OutDir,
    [switch]$SkipVerify,
    [switch]$Zip
)

$ErrorActionPreference = 'Stop'

$script:StepNo = 0
function Write-Step {
    param([string]$Title)
    $script:StepNo++
    Write-Host ''
    Write-Host ("=" * 70) -ForegroundColor DarkGray
    Write-Host (" Step {0}. {1}" -f $script:StepNo, $Title) -ForegroundColor Cyan
    Write-Host ("=" * 70) -ForegroundColor DarkGray
}
function Write-Ok   { param([string]$M) Write-Host "  [OK]   $M" -ForegroundColor Green }
function Write-Info { param([string]$M) Write-Host "  [--]   $M" -ForegroundColor Gray }
function Write-Warn { param([string]$M) Write-Host "  [WARN] $M" -ForegroundColor Yellow }
function Write-Fail { param([string]$M) Write-Host "  [FAIL] $M" -ForegroundColor Red }

function Stop-Build {
    param([string]$Message)
    Write-Host ''
    Write-Fail $Message
    Write-Host ''
    exit 1
}

# --- 解析專案目錄（與其他腳本同一套 fallback）------------------------------
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
        Stop-Build "無法自動判斷專案目錄，請用 -AppRoot 指定。"
    }
}
$AppRoot = (Resolve-Path $AppRoot).Path

if ([string]::IsNullOrWhiteSpace($OutDir)) { $OutDir = Join-Path $AppRoot 'wheels' }
$requirements = Join-Path $AppRoot 'requirements.txt'
if (-not (Test-Path $requirements)) { Stop-Build "找不到 $requirements" }

if ($PythonVersion -notmatch '^\d+\.\d+$') {
    Stop-Build "-PythonVersion 請用主次版號，例如 3.11（目前收到 '$PythonVersion'）。"
}

Write-Host ''
Write-Host '建物管理平台 - 離線部署打包' -ForegroundColor White
Write-Host "  專案目錄      : $AppRoot"
Write-Host "  輸出目錄      : $OutDir"
Write-Host "  目標 Python   : $PythonVersion (win_amd64)"

# ---------------------------------------------------------------------------
Write-Step '檢查本機環境'

$localPython = (Get-Command python.exe -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue)
if (-not $localPython) { Stop-Build "找不到 python.exe，請先安裝 Python 或把它加進 PATH。" }

$localVersion = & $localPython -c "import sys; print('%d.%d' % sys.version_info[:2])"
Write-Ok "本機 Python $localVersion：$localPython"

$versionMatches = ($localVersion -eq $PythonVersion)
if (-not $versionMatches) {
    Write-Warn "本機是 $localVersion，要打包的是 $PythonVersion —— 打包本身沒問題（pip 會抓對應版本的 wheel），"
    Write-Warn "但安裝驗證需要相同版本才做得了，這次會略過驗證。"
}

# 能不能連到 PyPI
try {
    $null = Invoke-WebRequest -Uri 'https://pypi.org/simple/' -UseBasicParsing -TimeoutSec 15 -Method Head
    Write-Ok '可以連到 PyPI'
} catch {
    Write-Warn "連 PyPI 測試失敗：$($_.Exception.Message)"
    Write-Warn '若貴公司有內部 PyPI 鏡像，請先設定好 pip 的 index-url 再執行。'
}

# ---------------------------------------------------------------------------
Write-Step '下載 wheel'

if (Test-Path $OutDir) {
    # 舊的 wheel 留著會讓部署機裝到過期版本，重新打包時先清掉
    Write-Info "清空既有的 $OutDir"
    Remove-Item "$OutDir\*" -Recurse -Force -ErrorAction SilentlyContinue
} else {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
}

# --only-binary=:all: 只抓預編譯的 .whl，不抓需要在目標機器編譯的 sdist。
# 內網部署機通常沒有編譯器，抓到 sdist 等於裝不起來。
& $localPython -m pip download `
    -r $requirements `
    -d $OutDir `
    --platform win_amd64 `
    --python-version $PythonVersion `
    --only-binary=:all:

if ($LASTEXITCODE -ne 0) {
    Stop-Build @"
下載失敗。常見原因：

  * 某個套件沒有 win_amd64 / cp$($PythonVersion -replace '\.','') 的預編譯版本
  * -PythonVersion 填錯
  * 連不到 PyPI

上方 pip 的輸出會指出是哪一個套件。
"@
}

$wheels = @(Get-ChildItem $OutDir -Filter '*.whl')
Write-Ok "共 $($wheels.Count) 個 wheel，合計 $([math]::Round((($wheels | Measure-Object Length -Sum).Sum / 1MB), 1)) MB"

# 抓到 sdist 代表該套件沒有預編譯版本，部署機會需要編譯器
$sdists = @(Get-ChildItem $OutDir -Include '*.tar.gz', '*.zip' -Recurse -ErrorAction SilentlyContinue)
if ($sdists) {
    Write-Warn "下列是原始碼套件（非 .whl），部署機安裝時可能需要編譯器："
    $sdists | ForEach-Object { Write-Warn "    $($_.Name)" }
}

# ---------------------------------------------------------------------------
Write-Step '驗證離線安裝'

if ($SkipVerify) {
    Write-Warn '已指定 -SkipVerify，略過驗證。'
} elseif (-not $versionMatches) {
    Write-Warn "本機 Python 版本與目標不同，略過驗證。"
    Write-Warn "要驗證的話，請在裝有 Python $PythonVersion 的機器上重跑這支腳本。"
} else {
    # 真正的驗證：完全斷開 PyPI，只從 wheels\ 裝一次
    $verifyVenv = Join-Path $env:TEMP "building-offline-verify-$PID"
    try {
        Write-Info '建立暫時 venv …'
        & $localPython -m venv $verifyVenv
        if ($LASTEXITCODE -ne 0) { throw '暫時 venv 建立失敗' }

        Write-Info '以 --no-index 從 wheels\ 安裝 …'
        & "$verifyVenv\Scripts\pip.exe" install --no-index --find-links=$OutDir -r $requirements --quiet
        if ($LASTEXITCODE -ne 0) { throw '離線安裝失敗，wheels\ 內容不完整' }

        Write-Info '檢查相依關係 …'
        & "$verifyVenv\Scripts\pip.exe" check
        if ($LASTEXITCODE -ne 0) { throw 'pip check 失敗，套件之間的相依關係有問題' }

        # 實際 import 一次，確認 C extension 真的能載入
        & "$verifyVenv\Scripts\python.exe" -c "import flask, pandas, openpyxl, ldap3, waitress, psycopg, psycopg_pool, dotenv; print('imports ok')"
        if ($LASTEXITCODE -ne 0) { throw '套件裝起來了但 import 失敗' }

        Write-Ok '驗證通過：wheels\ 可以在完全離線的情況下完成安裝'
    } catch {
        Stop-Build "驗證失敗：$($_.Exception.Message)"
    } finally {
        Remove-Item $verifyVenv -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------
Write-Step '打包'

if ($Zip) {
    $stamp   = Get-Date -Format 'yyyyMMdd'
    $zipPath = Join-Path (Split-Path -Parent $AppRoot) "building-platform-offline-$stamp.zip"
    $staging = Join-Path $env:TEMP "building-offline-stage-$PID"

    # venv 不能搬（內含寫死的絕對路徑），.env 含密碼，其餘是執行期產物
    $exclude = @('venv', '.venv', '.git', '.env', 'logs', 'uploads', 'processed',
                 'data_backups', 'utility_trend_backups', 'process_group_backups',
                 'trend_reference_backups', '__pycache__', 'node_modules')

    Write-Info '整理要打包的檔案 …'
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    Get-ChildItem $AppRoot -Force | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object {
        Copy-Item $_.FullName -Destination $staging -Recurse -Force
    }
    Get-ChildItem $staging -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    Compress-Archive -Path "$staging\*" -DestinationPath $zipPath
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue

    Write-Ok "已產生 $zipPath（$([math]::Round(((Get-Item $zipPath).Length / 1MB), 1)) MB）"
} else {
    Write-Info '未指定 -Zip，只產生 wheels\。'
}

# ---------------------------------------------------------------------------
Write-Step '完成'

Write-Host ''
Write-Host '打包完成。' -ForegroundColor Green
Write-Host ''
Write-Host '  還必須手動帶進內網的東西（這支腳本無法代勞）：' -ForegroundColor Yellow
Write-Host "    1. Python $PythonVersion 的 Windows 安裝程式"
Write-Host '       https://www.python.org/downloads/windows/'
Write-Host '       安裝時務必勾選 [v] Install for all users'
Write-Host '    2. HttpPlatformHandler v2.0 的 MSI'
Write-Host '       https://www.iis.net/downloads/microsoft/httpplatformhandler'
Write-Host ''
Write-Host '  部署機上的安裝指令：' -ForegroundColor Yellow
Write-Host '    .\scripts\deploy-iis.ps1 -Offline ...（其餘參數照舊）' -ForegroundColor White
Write-Host ''
Write-Host '  日後只更新套件（venv 不用重建）：' -ForegroundColor Yellow
Write-Host '    .\venv\Scripts\pip install --no-index --find-links=wheels -r requirements.txt' -ForegroundColor White
Write-Host ''
