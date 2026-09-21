<#
.SYNOPSIS
    部署腳本 - 把「建物管理平台」架到 IIS（HttpPlatformHandler + Waitress）。

.DESCRIPTION
    在目標 Server 上以「系統管理員」身分執行。腳本會依序處理：

      1. 檢查系統管理員權限與 Windows Server 環境
      2. 安裝 IIS 角色/功能（Web-Server、Web-Windows-Auth、Web-CGI）
      3. 確認 HttpPlatformHandler 模組已安裝（未安裝時給下載連結並中止）
      4. 找出可用的 Python（3.11 以上，且必須是全機器安裝而非 AppData）
      5. 在部署目錄建立 venv 並安裝 requirements.txt
         （-Offline 時改從 wheels\ 離線安裝）
      6. 建立 logs\ 與各執行期資料夾
      7. 把 web.config 內的範例路徑替換成這台機器的實際路徑
      8. 建立／更新 IIS 應用程式集區與網站
      9. 設定目錄權限（主目錄唯讀、需要寫入的資料夾給 Modify）
     10. 呼叫 setup-ad-login.ps1 設定 Windows 驗證
     11. 冒煙測試：直接用 venv 的 waitress 起一次，確認 import 沒問題

    腳本本身是可重複執行的：已存在的 venv / AppPool / 網站會沿用並更新設定，
    不會重建。要強制重建 venv 請加 -RecreateVenv。

    === 這個腳本不會做的事 ===
      * 不會建立或修改 .env（資料庫帳密請部署人員手動填，見 .env.example）
      * 不會跑資料庫 migration（請另外執行 scripts\run-migrations.ps1）
      * 不會把 DATA_BACKEND 切成 postgres（確認資料匯入驗收通過後再自行切換）

.PARAMETER AppRoot
    部署目錄。不指定時自動由腳本位置推導（scripts\ 的上一層）。

.PARAMETER SiteName
    IIS 網站名稱，預設 BuildingPlatform。

.PARAMETER AppPoolName
    應用程式集區名稱，預設為 "Pool-<SiteName>"。

.PARAMETER Port
    IIS 網站繫結的連接埠，預設 8001。

.PARAMETER PythonExe
    指定要用哪一個 python.exe 建立 venv。不指定時自動尋找。

.PARAMETER Offline
    從 wheels\ 離線安裝套件（內網無法連 PyPI 時使用）。

.PARAMETER RecreateVenv
    先刪除既有 venv 再重建。venv 內寫死絕對路徑，部署目錄搬動過就必須重建。

.PARAMETER SkipFeatures
    略過 IIS 角色/功能安裝（功能已裝好、或沒有 Install-WindowsFeature 時）。

.PARAMETER SkipSite
    只更新程式與 venv，不動 IIS 站台設定（日常更新版本時用）。

.PARAMETER SeedFrom
    從既有部署目錄複製一份資料檔（data.json、permissions.json、process_groups.json、
    trend_reference.json、utility_trends.json、data_changes.json）到新的部署目錄，
    讓平行部署的站台有真實資料可以驗證。

    是「複製」不是「共用」：來源目錄完全不會被修改，新站台之後怎麼改也動不到它。
    部署目錄已經有同名檔案時會保留現有的，不覆蓋。

.PARAMETER ReplaceExistingSite
    允許把「已存在且指向其他目錄」的 IIS 網站改指到這次的部署目錄。
    不加這個參數時，遇到這種情況腳本會直接中止，避免誤蓋掉線上服務。

.PARAMETER FullIisReset
    結束時執行 iisreset（整台機器的所有站台都會短暫中斷）。
    預設只重啟本次部署的應用程式集區，不影響其他站台。
    剛安裝完 HttpPlatformHandler 時才需要加這個參數。

.EXAMPLE
    .\scripts\deploy-iis.ps1

.EXAMPLE
    .\scripts\deploy-iis.ps1 -AppRoot "D:\WebServices\BuildingPlatform" -Port 8001 -Offline

.EXAMPLE
    # 平行部署：新站台與既有站台並存，用既有站台的資料做驗證
    .\scripts\deploy-iis.ps1 ``
        -AppRoot  "D:\WebServices\BuildingPlatform-v2" ``
        -SiteName "BuildingPlatform-v2" ``
        -Port     8002 ``
        -SeedFrom "D:\WebServices\BuildingPlatform"

.EXAMPLE
    # 只更新程式碼與套件，不動 IIS 設定
    .\scripts\deploy-iis.ps1 -SkipSite -SkipFeatures
#>

[CmdletBinding()]
param(
    [string]$AppRoot,
    [string]$SiteName = 'BuildingPlatform',
    [string]$AppPoolName,
    [int]$Port = 8001,
    [string]$PythonExe,
    [string]$SeedFrom,
    [switch]$Offline,
    [switch]$RecreateVenv,
    [switch]$SkipFeatures,
    [switch]$SkipSite,
    [switch]$ReplaceExistingSite,
    [switch]$FullIisReset
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

function Stop-Deploy {
    param([string]$Message)
    Write-Host ''
    Write-Fail $Message
    Write-Host ''
    exit 1
}

# --- 解析部署目錄 -----------------------------------------------------------
# $PSScriptRoot 在某些執行方式下會是空字串（ISE 選取片段執行、Invoke-Expression
# 貼上執行等），所以準備多層 fallback，行為與 check-deployment.ps1 一致。
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
        Stop-Deploy "無法自動判斷部署目錄，請用 -AppRoot 指定（該目錄內要有 app.py）。"
    }
}
$AppRoot = (Resolve-Path $AppRoot).Path
if (-not (Test-Path (Join-Path $AppRoot 'app.py'))) {
    Stop-Deploy "「$AppRoot」底下找不到 app.py，請確認 -AppRoot 是否正確。"
}
if ([string]::IsNullOrWhiteSpace($AppPoolName)) { $AppPoolName = "Pool-$SiteName" }

$venvDir    = Join-Path $AppRoot 'venv'
$venvPython = Join-Path $venvDir 'Scripts\python.exe'
$venvPip    = Join-Path $venvDir 'Scripts\pip.exe'
$waitressExe= Join-Path $venvDir 'Scripts\waitress-serve.exe'
$logsDir    = Join-Path $AppRoot 'logs'
$webConfig  = Join-Path $AppRoot 'web.config'

Write-Host ''
Write-Host '建物管理平台 - IIS 部署' -ForegroundColor White
Write-Host "  部署目錄  : $AppRoot"
Write-Host "  網站名稱  : $SiteName"
Write-Host "  應用程式池: $AppPoolName"
Write-Host "  連接埠    : $Port"
Write-Host "  套件來源  : $(if ($Offline) { 'wheels\（離線）' } else { 'PyPI（連網）' })"
if ($SeedFrom) { Write-Host "  資料來源  : $SeedFrom（複製，不修改來源）" }

# ---------------------------------------------------------------------------
Write-Step '檢查執行環境'

$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Stop-Deploy "請以「系統管理員」身分開啟 PowerShell 再執行本腳本。"
}
Write-Ok "系統管理員權限：$($identity.Name)"

# 路徑含空白雖然 HttpPlatformHandler 處理得了（不像 wfastcgi 會被拆參數），
# 但 IIS 設定與排錯都比較麻煩，還是提醒一下。
if ($AppRoot.Contains(' ')) {
    Write-Warn "部署路徑含有空白字元，建議改用不含空白的路徑以減少排錯成本。"
}

# ---------------------------------------------------------------------------
Write-Step 'IIS 角色與功能'

if ($SkipSite -or $SkipFeatures) {
    Write-Info '已指定略過，跳過 IIS 功能安裝。'
} elseif (Get-Command Install-WindowsFeature -ErrorAction SilentlyContinue) {
    # Web-CGI 是 HttpPlatformHandler 的前置需求，不能省略
    $features = @('Web-Server', 'Web-Windows-Auth', 'Web-CGI')
    foreach ($feature in $features) {
        $state = Get-WindowsFeature -Name $feature -ErrorAction SilentlyContinue
        if ($null -eq $state) {
            Write-Warn "找不到功能 $feature，請自行確認。"
        } elseif ($state.Installed) {
            Write-Ok "$feature 已安裝"
        } else {
            Write-Info "安裝 $feature …"
            Install-WindowsFeature -Name $feature -IncludeManagementTools | Out-Null
            Write-Ok "$feature 安裝完成"
        }
    }
} else {
    Write-Warn '此系統沒有 Install-WindowsFeature（可能不是 Windows Server），請自行確認已啟用 CGI 與 Windows 驗證。'
}

# ---------------------------------------------------------------------------
Write-Step 'HttpPlatformHandler 模組'

$hasModule = $false
if (Get-Command Get-WebGlobalModule -ErrorAction SilentlyContinue) {
    $hasModule = [bool](Get-WebGlobalModule -ErrorAction SilentlyContinue |
                        Where-Object { $_.Name -like 'httpPlatformHandler*' })
} else {
    # 沒有 WebAdministration 模組時退而檢查 DLL 是否存在
    $hasModule = Test-Path "$env:SystemRoot\System32\inetsrv\httpplatformhandler.dll"
}

if ($hasModule) {
    Write-Ok 'HttpPlatformHandler 已安裝'
} else {
    Stop-Deploy @"
找不到 HttpPlatformHandler 模組。IIS 不內建這個模組，必須另外安裝 MSI：

    https://www.iis.net/downloads/microsoft/httpplatformhandler

安裝完成後重新執行本腳本。
"@
}

# ---------------------------------------------------------------------------
Write-Step 'Python 環境'

function Find-Python {
    param([string]$Explicit)

    if ($Explicit) {
        if (-not (Test-Path $Explicit)) { Stop-Deploy "指定的 Python 不存在：$Explicit" }
        return $Explicit
    }

    $candidates = @()
    $fromPath = (Get-Command python.exe -ErrorAction SilentlyContinue |
                 Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue)
    if ($fromPath) { $candidates += $fromPath }
    # Windows Server 上的 PowerShell 5.1，-Depth 必須搭配 -Recurse 才有作用
    $candidates += Get-ChildItem -Path 'C:\Program Files' -Filter 'python.exe' -Recurse -Depth 2 `
                        -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName

    foreach ($candidate in $candidates) {
        # 裝在使用者 AppData 底下的 Python，IIS AppPool 帳號讀不到，程序永遠起不來
        if ($candidate -like '*\AppData\*') {
            Write-Warn "略過 $candidate（安裝在 AppData，IIS 應用程式集區帳號無法存取）"
            continue
        }
        $version = & $candidate -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
        if ($LASTEXITCODE -eq 0 -and $version) {
            $parts = $version.Split('.')
            if ([int]$parts[0] -gt 3 -or ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 11)) {
                Write-Ok "採用 Python $version：$candidate"
                return $candidate
            }
            Write-Warn "略過 $candidate（版本 $version，需要 3.11 以上）"
        }
    }
    Stop-Deploy @"
找不到可用的 Python（需要 3.11 以上，且必須是「Install for all users」安裝）。

安裝時務必勾選：
    [v] Install for all users   -> 會裝到 C:\Program Files\PythonXX
    [v] Add Python to PATH

裝在 C:\Users\...\AppData\ 底下的 Python，IIS 應用程式集區帳號無法存取，
Python 程序會永遠起不來（IIS 回 502）。
"@
}

$PythonExe = Find-Python -Explicit $PythonExe

if ($RecreateVenv -and (Test-Path $venvDir)) {
    Write-Info '移除既有 venv …'
    Remove-Item -Recurse -Force $venvDir
}

if (Test-Path $venvPython) {
    Write-Ok "沿用既有 venv：$venvDir"
} else {
    Write-Info "建立 venv：$venvDir"
    & $PythonExe -m venv $venvDir
    if ($LASTEXITCODE -ne 0) { Stop-Deploy 'venv 建立失敗。' }
    Write-Ok 'venv 建立完成'
}

Write-Info '安裝套件 …'
$requirements = Join-Path $AppRoot 'requirements.txt'
if (-not (Test-Path $requirements)) { Stop-Deploy "找不到 $requirements" }

if ($Offline) {
    $wheelsDir = Join-Path $AppRoot 'wheels'
    if (-not (Test-Path $wheelsDir)) {
        Stop-Deploy @"
指定了 -Offline 但找不到 wheels\ 目錄。

請先在可連網的開發機用相同的 Python 版本打包：

    pip download -r requirements.txt -d wheels ``
        --platform win_amd64 --python-version 3.11 --only-binary=:all:

再把 wheels\ 整個資料夾複製到部署機。
"@
    }
    & $venvPip install --no-index --find-links=$wheelsDir -r $requirements
} else {
    & $venvPip install -r $requirements
}
if ($LASTEXITCODE -ne 0) { Stop-Deploy '套件安裝失敗，請看上方 pip 的輸出。' }
Write-Ok '套件安裝完成'

if (-not (Test-Path $waitressExe)) {
    Stop-Deploy "套件裝完了但找不到 $waitressExe，請確認 requirements.txt 內有 waitress。"
}
Write-Ok "waitress-serve.exe 就緒：$waitressExe"

# ---------------------------------------------------------------------------
Write-Step '執行期資料夾'

# logs 是 HttpPlatformHandler 寫 stdout 用；其餘是程式執行期需要寫入的資料夾。
$runtimeDirs = @('logs', 'uploads', 'processed', 'data_backups',
                 'utility_trend_backups', 'process_group_backups', 'trend_reference_backups')
foreach ($dir in $runtimeDirs) {
    $full = Join-Path $AppRoot $dir
    if (-not (Test-Path $full)) {
        New-Item -ItemType Directory -Force -Path $full | Out-Null
        Write-Ok "建立 $dir\"
    } else {
        Write-Info "$dir\ 已存在"
    }
}

if ($SeedFrom) {
    # 平行部署時，新站台預設是空的。從既有部署複製一份資料過來才有東西可以驗，
    # 而且是「複製」不是「共用」——新站台之後怎麼改都動不到既有站台的檔案。
    $seedRoot = (Resolve-Path $SeedFrom -ErrorAction SilentlyContinue)
    if (-not $seedRoot) { Stop-Deploy "-SeedFrom 指定的目錄不存在：$SeedFrom" }
    $seedRoot = $seedRoot.Path
    if ($seedRoot.TrimEnd('\') -eq $AppRoot.TrimEnd('\')) {
        Stop-Deploy "-SeedFrom 不能與部署目錄相同。"
    }

    $seedFiles = @('data.json', 'permissions.json', 'process_groups.json',
                   'trend_reference.json', 'utility_trends.json', 'data_changes.json')
    foreach ($name in $seedFiles) {
        $source = Join-Path $seedRoot $name
        $target = Join-Path $AppRoot $name
        if (-not (Test-Path $source)) {
            Write-Info "$name 在來源不存在，略過"
            continue
        }
        if (Test-Path $target) {
            # 不覆蓋新站台已經有的資料，避免重跑部署把驗測中的內容清掉
            Write-Warn "$name 已存在於部署目錄，保留現有檔案（未從來源覆蓋）"
            continue
        }
        Copy-Item $source $target
        Write-Ok "已從來源複製 $name"
    }
    Write-Info "來源目錄的檔案完全沒有被修改：$seedRoot"
}

if (-not (Test-Path (Join-Path $AppRoot '.env'))) {
    Write-Warn @"
找不到 .env。資料庫連線設定（含密碼）放在這個檔案，不進版控。
若這次只跑 DATA_BACKEND=json 可以先不管；要接 PostgreSQL 時請執行：

    Copy-Item "$AppRoot\.env.example" "$AppRoot\.env"

再填入實際的連線資訊。
"@
}

# ---------------------------------------------------------------------------
Write-Step 'web.config 路徑替換'

if (-not (Test-Path $webConfig)) { Stop-Deploy "找不到 $webConfig" }

$content  = Get-Content $webConfig -Raw -Encoding UTF8
$original = $content

# 把檔案裡出現過的所有「其他部署路徑」統一換成這台機器的實際路徑。
# 比對條件是「以 \venv\ 或 \logs\ 或 " 結尾的 processPath/PYTHONPATH 值」，
# 直接用正規表示式抓出目前寫著的根目錄，才不會因為範例路徑改過就漏掉。
$pattern = '(?<root>[A-Za-z]:\\[^"]*?)(?=\\venv\\Scripts\\waitress-serve\.exe")'
$found = [regex]::Match($content, $pattern)
if ($found.Success) {
    $currentRoot = $found.Groups['root'].Value
    if ($currentRoot -ne $AppRoot) {
        Write-Info "將 web.config 內的 $currentRoot 換成 $AppRoot"
        $content = $content.Replace($currentRoot, $AppRoot)
    } else {
        Write-Ok 'web.config 路徑已正確'
    }
} else {
    Write-Warn 'web.config 內找不到預期的 processPath 格式，請手動確認路徑設定。'
}

if ($content -ne $original) {
    # 保留一份原檔，改壞了可以退回
    Copy-Item $webConfig "$webConfig.bak" -Force
    # IIS 讀 web.config 不接受 BOM 以外的編碼問題，這裡固定寫成 UTF8
    [System.IO.File]::WriteAllText($webConfig, $content, (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok "web.config 已更新（原檔備份為 web.config.bak）"
}

# ---------------------------------------------------------------------------
Write-Step 'IIS 應用程式集區與網站'

if ($SkipSite) {
    Write-Info '已指定 -SkipSite，略過 IIS 站台設定。'
} else {
    Import-Module WebAdministration -ErrorAction Stop

    # 先檢查連接埠有沒有被別的站台佔走。平行部署時最常見的錯誤就是沿用了
    # 既有站台的 port，兩個站台同時繫結會讓其中一個起不來。
    $portOwner = Get-Website | Where-Object {
        $_.Name -ne $SiteName -and
        ($_.bindings.Collection | Where-Object { $_.bindingInformation -match ":$Port`:" })
    } | Select-Object -First 1
    if ($portOwner) {
        Stop-Deploy @"
連接埠 $Port 已經被網站「$($portOwner.Name)」使用（目錄：$($portOwner.physicalPath)）。

平行部署請換一個沒有被佔用的連接埠，例如：

    .\scripts\deploy-iis.ps1 -AppRoot "$AppRoot" -SiteName "$SiteName" -Port 8002
"@
    }

    # 應用程式集區若正被別的站台使用，共用會讓兩邊共享同一個 Python 程序與回收設定
    $poolOwner = Get-Website | Where-Object {
        $_.Name -ne $SiteName -and $_.applicationPool -eq $AppPoolName
    } | Select-Object -First 1
    if ($poolOwner -and -not $ReplaceExistingSite) {
        Stop-Deploy @"
應用程式集區「$AppPoolName」正被網站「$($poolOwner.Name)」使用。

兩個站台共用同一個集區會共享 Python 程序與回收設定，平行部署請分開，例如：

    .\scripts\deploy-iis.ps1 -AppRoot "$AppRoot" ``
        -SiteName "$SiteName" -AppPoolName "Pool-$SiteName" -Port $Port
"@
    }

    if (Test-Path "IIS:\AppPools\$AppPoolName") {
        Write-Info "應用程式集區 $AppPoolName 已存在，更新設定"
    } else {
        New-WebAppPool -Name $AppPoolName | Out-Null
        Write-Ok "建立應用程式集區 $AppPoolName"
    }
    # Python 不是 .NET，必須設成「沒有 Managed 程式碼」
    Set-ItemProperty "IIS:\AppPools\$AppPoolName" managedRuntimeVersion ''
    # AlwaysRunning：避免閒置回收後第一位使用者要等 Python 冷啟動
    Set-ItemProperty "IIS:\AppPools\$AppPoolName" startMode 'AlwaysRunning'
    Write-Ok '應用程式集區設定完成（No Managed Code / AlwaysRunning）'

    $site = Get-Website -Name $SiteName -ErrorAction SilentlyContinue
    if ($site) {
        $existingPath = $site.physicalPath
        if ($existingPath -and $existingPath.TrimEnd('\') -ne $AppRoot.TrimEnd('\') -and -not $ReplaceExistingSite) {
            # 這是平行部署最容易出事的地方：站台名稱撞到既有站台時，
            # 若直接改 physicalPath，原本在線上的站台就被接管了。
            Stop-Deploy @"
網站「$SiteName」已經存在，而且指向不同的目錄：

    既有站台目錄 : $existingPath
    這次要部署到 : $AppRoot

繼續下去會把既有站台接管到新目錄，原本的服務等於被蓋掉。

要平行部署（不影響既有站台），請改用不同的網站名稱與連接埠，例如：

    .\scripts\deploy-iis.ps1 -AppRoot "$AppRoot" ``
        -SiteName "$SiteName-v2" -Port 8002

確實要讓既有站台改指到新目錄，才加上 -ReplaceExistingSite。
"@
        }
        Write-Info "網站 $SiteName 已存在，更新實體路徑與應用程式集區"
        Set-ItemProperty "IIS:\Sites\$SiteName" physicalPath $AppRoot
        Set-ItemProperty "IIS:\Sites\$SiteName" applicationPool $AppPoolName
    } else {
        New-Website -Name $SiteName -PhysicalPath $AppRoot `
                    -ApplicationPool $AppPoolName -Port $Port -Force | Out-Null
        Write-Ok "建立網站 $SiteName（Port $Port）"
    }
}

# ---------------------------------------------------------------------------
Write-Step '目錄權限'

function Grant-Access {
    param([string]$Path, [string]$Pool, [string]$Right)
    $acl  = Get-Acl $Path
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        "IIS AppPool\$Pool", $Right, 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.SetAccessRule($rule)
    Set-Acl $Path $acl
}

if ($SkipSite) {
    Write-Info '已指定 -SkipSite，略過權限設定。'
} else {
    try {
        # 主目錄只給讀取執行 —— 程式碼不該被執行中的網站改寫
        Grant-Access -Path $AppRoot -Pool $AppPoolName -Right 'ReadAndExecute'
        Write-Ok "主目錄：ReadAndExecute"

        # 這些資料夾程式執行期要寫入
        foreach ($dir in $runtimeDirs) {
            Grant-Access -Path (Join-Path $AppRoot $dir) -Pool $AppPoolName -Right 'Modify'
        }
        Write-Ok "執行期資料夾：Modify（$($runtimeDirs -join '、')）"

        # 這幾個檔案在根目錄，程式會直接寫入，需要個別開權限
        foreach ($file in @('app.log', 'access_log.txt', 'data.json', 'secret_key.txt',
                            'data_changes.json', 'process_groups.json',
                            'trend_reference.json', 'utility_trends.json')) {
            $full = Join-Path $AppRoot $file
            if (-not (Test-Path $full)) { New-Item -ItemType File -Path $full -Force | Out-Null }
            $acl  = Get-Acl $full
            $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
                "IIS AppPool\$AppPoolName", 'Modify', 'Allow')
            $acl.SetAccessRule($rule)
            Set-Acl $full $acl
        }
        Write-Ok '根目錄可寫入檔案：Modify'
    } catch {
        Write-Warn "設定權限時發生錯誤：$($_.Exception.Message)"
        Write-Warn "請手動在資料夾內容 -> 安全性中，為 `"IIS AppPool\$AppPoolName`" 加上對應權限。"
    }
}

# ---------------------------------------------------------------------------
Write-Step 'Windows 驗證設定'

if ($SkipSite) {
    Write-Info '已指定 -SkipSite，略過驗證設定。'
} else {
    $setupScript = Join-Path $AppRoot 'scripts\setup-ad-login.ps1'
    if (Test-Path $setupScript) {
        Write-Info '呼叫 setup-ad-login.ps1 設定匿名/Windows 驗證 …'
        & $setupScript -SiteName $SiteName
        Write-Ok '驗證設定完成'
    } else {
        Write-Warn @"
找不到 scripts\setup-ad-login.ps1，請手動設定：
    網站根目錄  -> 匿名驗證「啟用」 + Windows 驗證「啟用」
    /auth/sso   -> 匿名驗證「停用」 + Windows 驗證「啟用」
"@
    }
}

# ---------------------------------------------------------------------------
Write-Step '冒煙測試'

# 先在命令列直接起一次 Waitress。這一步失敗的話，通常是 import 錯誤或套件缺失，
# 比起等 IIS 回 502 再去翻 log，在這裡就會直接把 traceback 印出來。
# 取一個當下沒被使用的 port，避免與既有站台或另一個同時進行的部署撞在一起
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$smokePort = $listener.LocalEndpoint.Port
$listener.Stop()

Write-Info "以 venv 的 Waitress 啟動測試（port $smokePort，5 秒後自動結束）…"
$smokeOut = Join-Path $env:TEMP "building-smoke-$PID.log"
$process = Start-Process -FilePath $venvPython `
    -ArgumentList '-m', 'waitress', "--port=$smokePort", 'wsgi:application' `
    -WorkingDirectory $AppRoot -PassThru -NoNewWindow `
    -RedirectStandardError $smokeOut -RedirectStandardOutput "$smokeOut.out"

Start-Sleep -Seconds 5
if ($process.HasExited) {
    Write-Fail "Waitress 啟動失敗（exit code $($process.ExitCode)）："
    if (Test-Path $smokeOut)      { Get-Content $smokeOut      -Tail 30 | ForEach-Object { Write-Host "         $_" } }
    if (Test-Path "$smokeOut.out"){ Get-Content "$smokeOut.out" -Tail 30 | ForEach-Object { Write-Host "         $_" } }
    Stop-Deploy '請先排除上方錯誤再重新部署。'
}
Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
Remove-Item $smokeOut, "$smokeOut.out" -ErrorAction SilentlyContinue
Write-Ok 'Waitress 可正常啟動'

# ---------------------------------------------------------------------------
Write-Step '完成'

if (-not $SkipSite) {
    if ($FullIisReset) {
        # iisreset 會重啟整台機器上的所有站台。平行部署時這代表既有服務也會斷線，
        # 所以預設不做，只在剛裝完 HttpPlatformHandler 之類非做不可的情況才加這個參數。
        Write-Warn '執行 iisreset：這台機器上的所有 IIS 站台都會短暫中斷。'
        iisreset /restart | Out-Null
        Write-Ok 'IIS 已重新啟動'
    } else {
        Write-Info "重新啟動應用程式集區 $AppPoolName（不影響其他站台）…"
        Restart-WebAppPool -Name $AppPoolName -ErrorAction SilentlyContinue
        Write-Ok "$AppPoolName 已重新啟動"
        Write-Info '若這台機器是第一次安裝 HttpPlatformHandler，請另外執行一次 iisreset。'
    }
}

Write-Host ''
Write-Host '部署完成。' -ForegroundColor Green
Write-Host ''
Write-Host '  網址        : ' -NoNewline; Write-Host "http://localhost:$Port/" -ForegroundColor White
Write-Host '  即時看 log  : ' -NoNewline; Write-Host "Get-Content `"$logsDir\python.log`" -Tail 20 -Wait" -ForegroundColor White
Write-Host '  部署後檢查  : ' -NoNewline; Write-Host ".\scripts\check-deployment.ps1 -SiteName $SiteName" -ForegroundColor White
Write-Host ''
Write-Host '  接 PostgreSQL 的後續步驟：' -ForegroundColor Yellow
Write-Host '    1. Copy-Item .env.example .env   並填入連線資訊'
Write-Host '    2. .\scripts\run-migrations.ps1                建立 schema'
Write-Host '    3. .\scripts\run-migrations.ps1 -MigrateData   匯入資料並驗收 hash'
Write-Host "    4. 驗收通過後，把 .env 的 DATA_BACKEND 改成 postgres，再執行："
Write-Host "       Restart-WebAppPool -Name `"$AppPoolName`"" -ForegroundColor White
Write-Host ''

if ($SeedFrom) {
    Write-Host '  平行部署提醒：' -ForegroundColor Yellow
    Write-Host "    * 這個站台的資料是 $SeedFrom 在部署當下的複本，"
    Write-Host '      之後兩邊各走各的，來源那邊的新異動不會同步過來。'
    Write-Host '    * 兩個站台的登入 session 互相獨立（各自的 secret_key.txt）。'
    Write-Host ''
}
