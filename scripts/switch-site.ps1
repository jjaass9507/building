<#
.SYNOPSIS
    正式切換腳本 - 把線上的 IIS 子應用程式路徑改指到新版部署目錄。

.DESCRIPTION
    用於「平行部署驗證完成，要把原本的網址切到新版」的情境。
    適用於本專案掛成 IIS 子應用程式（例如 http://主機/building_platform）的部署方式。

    切換流程（每一步失敗都會自動回退）：

      1. 記錄目前狀態（實體路徑、應用程式集區）到 logs\cutover-state.json
      2. 停止舊版的應用程式集區 —— 從這裡開始凍結寫入，切換窗口開始計時
      3. 把舊目錄的資料檔複製到新目錄
         （平行驗證期間舊版的資料已經往前走，不重新同步會吃掉這段異動）
      4. 新版若已接 PostgreSQL，重跑匯入並驗收 dataset_revision 的 hash
      5. 複製 secret_key.txt，讓已登入的使用者不會被踢出來
      6. 把新目錄 web.config 的 APP_URL_PREFIX 設成正式路徑
      7. 應用程式改指到新目錄與新的應用程式集區
      8. 重新設定 Windows 驗證（驗證設定是綁在路徑上的）
      9. 冒煙測試：打 /api/auth/status（這支永遠回 200，不需要登入）
     10. 失敗就自動回退到步驟 1 記錄的狀態

    舊目錄不會被刪除也不會被修改，回退隨時可做。

.PARAMETER ParentSite
    父網站名稱，例如 "Default Web Site"。

.PARAMETER AppPath
    線上的應用程式路徑，例如 "building_platform"。切換後網址不變。

.PARAMETER NewRoot
    新版的部署目錄，例如 "D:\WebServices\BuildingPlatform-v2"。

.PARAMETER NewAppPool
    新版要使用的應用程式集區。不指定時沿用新目錄部署時建立的那一個
    （由 -NewRoot 底下 web.config 的 processPath 推導不出來，所以請明確指定）。

.PARAMETER SkipDataSync
    略過資料同步。只有在你確定平行驗證期間舊版完全沒有異動時才用。

.PARAMETER Rollback
    回退到上一次切換前的狀態（讀 logs\cutover-state.json）。

.PARAMETER WhatIfOnly
    只顯示會做什麼，不實際執行。

.EXAMPLE
    # 正式切換
    .\scripts\switch-site.ps1 ``
        -ParentSite "Default Web Site" ``
        -AppPath    "building_platform" ``
        -NewRoot    "D:\WebServices\BuildingPlatform-v2" ``
        -NewAppPool "Pool-BuildingPlatform-v2"

.EXAMPLE
    # 先看會做什麼
    .\scripts\switch-site.ps1 -ParentSite "Default Web Site" -AppPath "building_platform" ``
        -NewRoot "D:\WebServices\BuildingPlatform-v2" -NewAppPool "Pool-BuildingPlatform-v2" -WhatIfOnly

.EXAMPLE
    # 回退
    .\scripts\switch-site.ps1 -ParentSite "Default Web Site" -AppPath "building_platform" ``
        -NewRoot "D:\WebServices\BuildingPlatform-v2" -Rollback

.NOTES
    需以「系統管理員」身分執行 PowerShell。
    切換窗口建議挑沒人使用的時段：回退期間若有人在新版改過資料，
    那些異動不會自動回到舊目錄。
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ParentSite,
    [Parameter(Mandatory = $true)][string]$AppPath,
    [Parameter(Mandatory = $true)][string]$NewRoot,
    [string]$NewAppPool,
    [switch]$SkipDataSync,
    [switch]$Rollback,
    [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'

# --- 共用輸出 ---------------------------------------------------------------

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

# --- 參數整理 ---------------------------------------------------------------

$AppPath = '/' + $AppPath.Trim('/')
if ($AppPath -eq '/') { Write-Fail "-AppPath 不能是根路徑。"; exit 1 }

$NewRoot = (Resolve-Path $NewRoot -ErrorAction SilentlyContinue)
if (-not $NewRoot) { Write-Fail "-NewRoot 指定的目錄不存在。"; exit 1 }
$NewRoot = $NewRoot.Path

$iisPath   = "IIS:\Sites\$ParentSite$AppPath"
$stateFile = Join-Path $NewRoot 'logs\cutover-state.json'
$dataFiles = @('data.json', 'permissions.json', 'process_groups.json',
               'trend_reference.json', 'utility_trends.json', 'data_changes.json')

$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Fail "請以「系統管理員」身分開啟 PowerShell 再執行本腳本。"
    exit 1
}

Import-Module WebAdministration -ErrorAction Stop

if (-not (Get-Website -Name $ParentSite -ErrorAction SilentlyContinue)) {
    Write-Fail "找不到父網站「$ParentSite」。用 Get-Website 確認名稱。"
    exit 1
}
if (-not (Test-Path $iisPath)) {
    Write-Fail "找不到應用程式「$ParentSite$AppPath」。用 Get-WebApplication 確認路徑。"
    exit 1
}

# =============================================================================
# 回退模式
# =============================================================================

if ($Rollback) {
    Write-Host ''
    Write-Host '建物管理平台 - 回退' -ForegroundColor White

    if (-not (Test-Path $stateFile)) {
        Write-Fail "找不到狀態檔 $stateFile，無法自動回退。"
        Write-Warn "請手動把應用程式的實體路徑與集區改回切換前的值。"
        exit 1
    }

    $state = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Info "切換時間  : $($state.switchedAt)"
    Write-Info "原實體路徑: $($state.previousPhysicalPath)"
    Write-Info "原應用程式集區: $($state.previousAppPool)"

    if ($WhatIfOnly) { Write-Host ''; Write-Info '（-WhatIfOnly，沒有實際執行）'; exit 0 }

    Set-ItemProperty $iisPath physicalPath    $state.previousPhysicalPath
    Set-ItemProperty $iisPath applicationPool $state.previousAppPool
    Start-WebAppPool -Name $state.previousAppPool -ErrorAction SilentlyContinue
    Restart-WebAppPool -Name $state.previousAppPool -ErrorAction SilentlyContinue

    Write-Host ''
    Write-Ok "已回退到 $($state.previousPhysicalPath)"
    Write-Warn "回退期間若有人在新版改過資料，那些異動仍在 $NewRoot，需要時請手動搬回。"
    Write-Host ''
    exit 0
}

# =============================================================================
# 切換模式
# =============================================================================

Write-Host ''
Write-Host '建物管理平台 - 正式切換' -ForegroundColor White
Write-Host "  父網站    : $ParentSite"
Write-Host "  應用程式  : $AppPath"
Write-Host "  切到      : $NewRoot"

$app = Get-WebApplication -Site $ParentSite -Name $AppPath.TrimStart('/')
$oldRoot = $app.physicalPath
$oldPool = $app.applicationPool
if ([string]::IsNullOrWhiteSpace($NewAppPool)) { $NewAppPool = $oldPool }

Write-Host "  目前指向  : $oldRoot"
Write-Host "  目前集區  : $oldPool"
Write-Host "  切換後集區: $NewAppPool"

if ($oldRoot.TrimEnd('\') -eq $NewRoot.TrimEnd('\')) {
    Write-Host ''
    Write-Ok "已經指向 $NewRoot，不需要切換。"
    exit 0
}

if ($WhatIfOnly) {
    Write-Host ''
    Write-Info '（-WhatIfOnly）以下步驟不會實際執行：'
    Write-Info "  1. 停止集區 $oldPool"
    Write-Info "  2. 從 $oldRoot 複製資料檔到 $NewRoot"
    Write-Info "  3. 新版若接 PostgreSQL 則重跑匯入與 hash 驗收"
    Write-Info "  4. 複製 secret_key.txt"
    Write-Info "  5. web.config 的 APP_URL_PREFIX 設為 $AppPath"
    Write-Info "  6. 應用程式改指到 $NewRoot（集區 $NewAppPool）"
    Write-Info "  7. 重設 Windows 驗證並冒煙測試"
    Write-Host ''
    exit 0
}

# --- 回退用的狀態 -----------------------------------------------------------
Write-Step '記錄目前狀態'

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $stateFile) | Out-Null
@{
    switchedAt           = (Get-Date).ToString('s')
    parentSite           = $ParentSite
    appPath              = $AppPath
    previousPhysicalPath = $oldRoot
    previousAppPool      = $oldPool
    newPhysicalPath      = $NewRoot
    newAppPool           = $NewAppPool
} | ConvertTo-Json | Set-Content -Path $stateFile -Encoding UTF8
Write-Ok "已寫入 $stateFile（回退時會讀這一份）"

# 任何一步失敗都回到這裡
function Invoke-Rollback {
    param([string]$Reason)
    Write-Host ''
    Write-Fail "切換失敗：$Reason"
    Write-Info '正在自動回退 …'
    try {
        Set-ItemProperty $iisPath physicalPath    $oldRoot
        Set-ItemProperty $iisPath applicationPool $oldPool
        Start-WebAppPool -Name $oldPool -ErrorAction SilentlyContinue
        Restart-WebAppPool -Name $oldPool -ErrorAction SilentlyContinue
        Write-Ok "已回退到 $oldRoot，服務應該已經恢復。"
    } catch {
        Write-Fail "自動回退也失敗了：$($_.Exception.Message)"
        Write-Warn "請手動執行："
        Write-Warn "  Set-ItemProperty `"$iisPath`" physicalPath `"$oldRoot`""
        Write-Warn "  Set-ItemProperty `"$iisPath`" applicationPool `"$oldPool`""
        Write-Warn "  Start-WebAppPool -Name `"$oldPool`""
    }
    Write-Host ''
    exit 1
}

# --- 凍結寫入 ---------------------------------------------------------------
Write-Step '停止舊版（切換窗口開始）'

# 舊集區若還有別的應用程式在用，停掉會一併影響，先確認
$poolSharers = @(Get-WebApplication | Where-Object {
    $_.applicationPool -eq $oldPool -and $_.path -ne $AppPath
})
if ($poolSharers) {
    Write-Warn "應用程式集區 $oldPool 還有其他應用程式在用，停止會一併影響："
    $poolSharers | ForEach-Object { Write-Warn "    $($_.path) -> $($_.physicalPath)" }
}

Stop-WebAppPool -Name $oldPool -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Write-Ok "$oldPool 已停止，舊版不再接受寫入"

# --- 資料同步 ---------------------------------------------------------------
Write-Step '同步資料到新版'

if ($SkipDataSync) {
    Write-Warn '已指定 -SkipDataSync，略過資料同步。'
} else {
    try {
        foreach ($name in $dataFiles) {
            $source = Join-Path $oldRoot $name
            if (-not (Test-Path $source)) { Write-Info "$name 在舊目錄不存在，略過"; continue }
            Copy-Item $source (Join-Path $NewRoot $name) -Force
            Write-Ok "已同步 $name"
        }
    } catch {
        Invoke-Rollback "資料同步失敗：$($_.Exception.Message)"
    }
}

# --- 資料庫匯入與驗收 -------------------------------------------------------
Write-Step '資料庫匯入與 hash 驗收'

$envFile = Join-Path $NewRoot '.env'
$usesPostgres = $false
if (Test-Path $envFile) {
    $backendLine = Get-Content $envFile |
        Where-Object { $_ -match '^\s*DATA_BACKEND\s*=\s*(\S+)' } | Select-Object -Last 1
    if ($backendLine -and $backendLine -match '^\s*DATA_BACKEND\s*=\s*(\S+)') {
        $usesPostgres = ($Matches[1].Trim().ToLower() -eq 'postgres')
    }
}

if (-not $usesPostgres) {
    Write-Info '新版目前走地端 JSON 檔案，不需要資料庫匯入。'
} else {
    $runMigrations = Join-Path $NewRoot 'scripts\run-migrations.ps1'
    if (-not (Test-Path $runMigrations)) {
        Invoke-Rollback "新版設定為 postgres，但找不到 $runMigrations"
    }
    Write-Info '重新匯入資料並驗收 hash …'
    & $runMigrations -AppRoot $NewRoot -MigrateData
    if ($LASTEXITCODE -ne 0) {
        # hash 對不上代表資料搬運有問題，這時候切過去等於把問題帶上線
        Invoke-Rollback "資料匯入或 hash 驗收失敗（exit code $LASTEXITCODE）"
    }
    Write-Ok 'hash 驗收通過'
}

# --- session 金鑰 -----------------------------------------------------------
Write-Step '沿用登入狀態'

$oldKey = Join-Path $oldRoot 'secret_key.txt'
$newKey = Join-Path $NewRoot 'secret_key.txt'
if (Test-Path $oldKey) {
    Copy-Item $oldKey $newKey -Force
    Write-Ok '已沿用舊版的 secret_key.txt，已登入的使用者不會被登出'
} else {
    Write-Warn "舊目錄沒有 secret_key.txt。若舊版是用 web.config 的 APP_SECRET_KEY，請確認新版填的是同一組。"
}

# --- 掛載路徑前綴 -----------------------------------------------------------
Write-Step '設定 APP_URL_PREFIX'

$webConfig = Join-Path $NewRoot 'web.config'
if (-not (Test-Path $webConfig)) { Invoke-Rollback "找不到 $webConfig" }

$content = Get-Content $webConfig -Raw -Encoding UTF8
$prefixPattern = '(<environmentVariable\s+name="APP_URL_PREFIX"\s+value=")[^"]*(")'
if ($content -match $prefixPattern) {
    $updated = [regex]::Replace($content, $prefixPattern, "`${1}$AppPath`${2}")
    if ($updated -ne $content) {
        Copy-Item $webConfig "$webConfig.bak" -Force
        [System.IO.File]::WriteAllText($webConfig, $updated, (New-Object System.Text.UTF8Encoding($false)))
    }
    Write-Ok "APP_URL_PREFIX = $AppPath"
} else {
    Invoke-Rollback "web.config 內找不到 APP_URL_PREFIX 設定項，掛成子應用程式會每頁 404"
}

# --- 改指路徑 ---------------------------------------------------------------
Write-Step '切換應用程式指向'

try {
    Set-ItemProperty $iisPath physicalPath    $NewRoot
    Set-ItemProperty $iisPath applicationPool $NewAppPool
    Write-Ok "$ParentSite$AppPath -> $NewRoot（集區 $NewAppPool）"
} catch {
    Invoke-Rollback "改指路徑失敗：$($_.Exception.Message)"
}

# 舊集區若還有別人在用，要放它回去
if ($poolSharers -and $oldPool -ne $NewAppPool) {
    Start-WebAppPool -Name $oldPool -ErrorAction SilentlyContinue
    Write-Info "$oldPool 已重新啟動（還有其他應用程式在用）"
}

# --- 驗證設定 ---------------------------------------------------------------
Write-Step '重設 Windows 驗證'

$setupScript = Join-Path $NewRoot 'scripts\setup-ad-login.ps1'
if (Test-Path $setupScript) {
    try {
        & $setupScript -SiteName $ParentSite -AppPath $AppPath.TrimStart('/')
        Write-Ok '驗證設定完成'
    } catch {
        Invoke-Rollback "設定 Windows 驗證失敗：$($_.Exception.Message)"
    }
} else {
    Write-Warn "找不到 $setupScript，請手動確認 $AppPath 與 $AppPath/auth/sso 的驗證設定。"
}

Restart-WebAppPool -Name $NewAppPool -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

# --- 冒煙測試 ---------------------------------------------------------------
Write-Step '冒煙測試'

# /api/auth/status 不需要登入、永遠回 200，最適合拿來確認服務真的起來了
$probeUrl = "http://localhost$AppPath/api/auth/status"
Write-Info "GET $probeUrl"

$ok = $false
foreach ($attempt in 1..5) {
    try {
        $response = Invoke-WebRequest -Uri $probeUrl -UseBasicParsing -TimeoutSec 20
        if ($response.StatusCode -eq 200) { $ok = $true; break }
        Write-Info "第 $attempt 次：HTTP $($response.StatusCode)，等待後重試"
    } catch {
        Write-Info "第 $attempt 次：$($_.Exception.Message)，等待後重試"
    }
    Start-Sleep -Seconds 3
}

if (-not $ok) {
    Write-Warn "log 位置：$NewRoot\logs\python.log"
    if (Test-Path "$NewRoot\logs\python.log") {
        Get-Content "$NewRoot\logs\python.log" -Tail 30 | ForEach-Object { Write-Host "         $_" }
    }
    Invoke-Rollback "新版沒有正常回應"
}
Write-Ok '新版回應正常'

# --- 完成 -------------------------------------------------------------------
Write-Step '完成'

Write-Host ''
Write-Host '切換完成。' -ForegroundColor Green
Write-Host ''
Write-Host '  網址      : ' -NoNewline; Write-Host "http://<主機>$AppPath/" -ForegroundColor White
Write-Host '  即時看 log: ' -NoNewline; Write-Host "Get-Content `"$NewRoot\logs\python.log`" -Tail 20 -Wait" -ForegroundColor White
Write-Host '  部署檢查  : ' -NoNewline; Write-Host ".\scripts\check-deployment.ps1 -SiteName `"$ParentSite`"" -ForegroundColor White
Write-Host ''
Write-Host '  要回退的話：' -ForegroundColor Yellow
Write-Host "    .\scripts\switch-site.ps1 -ParentSite `"$ParentSite`" -AppPath `"$($AppPath.TrimStart('/'))`" ``" -ForegroundColor White
Write-Host "        -NewRoot `"$NewRoot`" -Rollback" -ForegroundColor White
Write-Host ''
Write-Host "  舊目錄 $oldRoot 沒有被修改，先留著跑一兩週再清。" -ForegroundColor Yellow
Write-Host ''
