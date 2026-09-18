<#
.SYNOPSIS
    部署前檢查腳本 - 確認本機 (IIS Server) 是否具備執行「建物管理平台」所需的一切。

.DESCRIPTION
    在目標 Server 上，於專案根目錄執行本腳本 (或指定 -AppRoot)。
    腳本會讀取專案根目錄的 web.config，解析出 httpPlatform 區段設定的
    waitress-serve.exe / PYTHONPATH / stdout log 路徑，並依序檢查：

      1. web.config 是否存在、是否已改用 HttpPlatformHandler、
         路徑是否已從範例值改成本機實際路徑
      2. forwardWindowsAuthToken 是否啟用 (沒有它單一登入會完全失效)、
         arguments 是否使用 %HTTP_PLATFORM_PORT% 並指向 wsgi:application、
         PYTHONUNBUFFERED 是否設定 (沒設的話 log 會是空的)
      3. venv 的 python.exe / waitress-serve.exe / wsgi.py 是否存在
      4. Python 版本是否 >= 3.11
      5. requirements.txt 內的套件是否都已安裝
      6. IIS 角色/功能：Web Server、CGI、Windows Authentication
      7. HttpPlatformHandler 模組是否已安裝、stdout log 目錄是否存在
      8. 專案必要檔案 / 資料夾是否存在 (app.py、wsgi.py、templates、static ...)
      9. permissions.json 是否存在、格式正確、admins 非空
     10. 執行期資料夾與根目錄是否可寫入；.env 是否存在且權限已收斂；
         DATA_BACKEND 設定為何；資料庫機密有沒有誤寫進進版控的 web.config；
         DATA_BACKEND=postgres 時實際連線測試並確認 migration 已套用
     11. 本機是否已加入 AD 網域 (Windows Integrated Authentication 需要)
     12. 對外連線到前端 CDN (tailwindcss / unpkg / jsdelivr) 是否正常
     13. (可選) 指定 -SiteName 時，檢查 IIS 網站是否存在、實體路徑是否吻合、
         該路徑下 Windows Authentication 是否已啟用

    每一項會標記 [PASS] / [WARN] / [FAIL]，結束時印出總結。
    有任何 [FAIL] 時，Exit Code 會是 1，方便串接自動化部署流程判斷成功與否。

.PARAMETER AppRoot
    專案根目錄路徑。不指定時會自動偵測：無論本腳本是放在專案根目錄底下，
    還是放在專案根目錄的 scripts\ 子資料夾底下，都會抓到正確的專案根目錄
    (以資料夾內是否有 app.py 判斷)。若自動偵測失敗，請自行帶入此參數。

.PARAMETER SiteName
    (可選) IIS 網站名稱，指定後會額外檢查該網站的實體路徑與 Windows Authentication 設定。

.EXAMPLE
    .\scripts\check-deployment.ps1

.EXAMPLE
    .\scripts\check-deployment.ps1 -AppRoot "C:\inetpub\wwwroot\BuildingPlatform" -SiteName "BuildingPlatform"
#>

[CmdletBinding()]
param(
    [string]$AppRoot,
    [string]$SiteName
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($AppRoot)) {
    # $PSScriptRoot 在某些執行方式下 (例如在 ISE/主控台選取片段執行、
    # 用舊版 PowerShell、或用 Invoke-Expression 貼上執行) 會是空字串，
    # 因此這裡準備多層 fallback，確保腳本無論怎麼跑都能找到自己的位置。
    $scriptDir = $PSScriptRoot
    if ([string]::IsNullOrWhiteSpace($scriptDir) -and $MyInvocation.MyCommand.Path) {
        $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    }
    if ([string]::IsNullOrWhiteSpace($scriptDir)) {
        $scriptDir = (Get-Location).Path
        Write-Warning "無法自動偵測腳本所在路徑，改用目前工作目錄：$scriptDir。若判斷錯誤，請改用 -AppRoot 參數指定專案根目錄。"
    }

    if (Test-Path (Join-Path $scriptDir 'app.py')) {
        # 腳本被放在專案根目錄底下
        $AppRoot = $scriptDir
    } else {
        $parentDir = Split-Path -Parent $scriptDir
        if ($parentDir -and (Test-Path (Join-Path $parentDir 'app.py'))) {
            # 腳本被放在專案根目錄的 scripts\ 子資料夾底下
            $AppRoot = $parentDir
        } else {
            $AppRoot = $scriptDir
        }
    }
}

$script:results = New-Object System.Collections.Generic.List[object]

function Add-Result {
    param(
        [ValidateSet('PASS', 'WARN', 'FAIL')][string]$Status,
        [string]$Check,
        [string]$Detail = ''
    )
    $script:results.Add([pscustomobject]@{ Status = $Status; Check = $Check; Detail = $Detail })

    $color = switch ($Status) {
        'PASS' { 'Green' }
        'WARN' { 'Yellow' }
        'FAIL' { 'Red' }
    }
    Write-Host ("[{0,-4}] {1}" -f $Status, $Check) -ForegroundColor $color
    if ($Detail) {
        Write-Host ("       -> {0}" -f $Detail) -ForegroundColor DarkGray
    }
}

function Invoke-Native {
    <#
        執行原生 exe 並完整取回 stdout+stderr 與 ExitCode。

        重要：這裡刻意把 $ErrorActionPreference 暫時切成 'Continue' 再呼叫。
        原因是在 $ErrorActionPreference = 'Stop' 之下，把原生程式的 stderr
        用 2>&1 併進來時，PowerShell 會把每一行 stderr 包成 ErrorRecord，
        且 'Stop' 會讓它們變成 terminating error 直接中斷、只留下第一行
        訊息（例如只看到 "Python path configuration:" 就斷了，看不到完整
        的 Fatal Python error 內容），導致抓不到真正的錯誤原因。
    #>
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$ArgumentList
    )

    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $FilePath @ArgumentList 2>&1 | Out-String
        $exitCode = $LASTEXITCODE
    } catch {
        $output = $_.Exception.Message
        $exitCode = -1
    } finally {
        $ErrorActionPreference = $prevEAP
    }

    [pscustomobject]@{
        ExitCode = $exitCode
        Output   = $output.Trim()
    }
}

function Test-WritablePath {
    param([string]$Path)
    try {
        if (-not (Test-Path $Path)) {
            New-Item -ItemType Directory -Path $Path -Force | Out-Null
        }
        $probe = Join-Path $Path (".write_test_{0}.tmp" -f ([guid]::NewGuid().ToString('N')))
        [IO.File]::WriteAllText($probe, 'ok')
        Remove-Item $probe -Force
        return $true
    } catch {
        return $false
    }
}

Write-Host "===================================================="
Write-Host " 建物管理平台 - 部署環境檢查"
Write-Host " AppRoot: $AppRoot"
Write-Host "===================================================="
Write-Host ""

# 1. AppRoot 與 web.config 是否存在
$webConfigPath = Join-Path $AppRoot 'web.config'
if (-not (Test-Path $AppRoot)) {
    Add-Result -Status FAIL -Check "專案根目錄存在" -Detail "找不到 $AppRoot"
    Write-Host "`n專案根目錄都找不到，後續檢查中止。" -ForegroundColor Red
    exit 1
}
Add-Result -Status PASS -Check "專案根目錄存在" -Detail $AppRoot

if (-not (Test-Path $webConfigPath)) {
    Add-Result -Status FAIL -Check "web.config 存在" -Detail "找不到 $webConfigPath"
} else {
    Add-Result -Status PASS -Check "web.config 存在"
}

# 2. 解析 web.config 內容（HttpPlatformHandler + Waitress）
$pythonExe = $null
$waitressExe = $null
$pythonPathValue = $null
$stdoutLogPath = $null
$envVars = @()

if (Test-Path $webConfigPath) {
    try {
        [xml]$webConfigXml = Get-Content $webConfigPath -Raw

        $httpPlatform = $webConfigXml.configuration.'system.webServer'.httpPlatform
        if (-not $httpPlatform) {
            Add-Result -Status FAIL -Check "web.config 使用 HttpPlatformHandler" `
                -Detail ("web.config 內找不到 <httpPlatform> 區段。`n" +
                         "       本專案已從 wfastcgi 改為 HttpPlatformHandler + Waitress，`n" +
                         "       請用最新版的 web.config，或執行 scripts\deploy-iis.ps1 重新部署。")
        } else {
            Add-Result -Status PASS -Check "web.config 使用 HttpPlatformHandler"

            $waitressExe   = $httpPlatform.processPath
            $platformArgs  = $httpPlatform.arguments
            $stdoutLogPath = $httpPlatform.stdoutLogFile

            # processPath 指向 venv\Scripts\waitress-serve.exe，
            # 同一個 Scripts 目錄下的 python.exe 就是這個 venv 的直譯器。
            if ($waitressExe -match '^(?<venv>.*)\\Scripts\\waitress-serve\.exe$') {
                $pythonExe = Join-Path $Matches['venv'] 'Scripts\python.exe'
            }

            $envVars = @($httpPlatform.environmentVariables.environmentVariable)
            $pythonPathValue = ($envVars | Where-Object { $_.name -eq 'PYTHONPATH' }).value

            if ($waitressExe -match 'C:\\inetpub\\wwwroot\\BuildingPlatform' -or $waitressExe -match 'D:\\FAC_Web\\BuildingPlatform') {
                Add-Result -Status WARN -Check "web.config 路徑已改成本機實際路徑" `
                    -Detail "目前仍是範例/舊路徑：$waitressExe，請執行 scripts\deploy-iis.ps1 或手動改成這台 Server 的實際安裝路徑"
            } else {
                Add-Result -Status PASS -Check "web.config 路徑已改成本機實際路徑" -Detail $waitressExe
            }

            # 沒有 forwardWindowsAuthToken，IIS 的 Windows 驗證結果不會傳給 Python，
            # app.py 的 username_from_windows_token() 永遠收不到 X-IIS-WindowsAuthToken，
            # 單一登入會整個失效（畫面上看起來就是一直停在登入頁）。
            if ($httpPlatform.forwardWindowsAuthToken -eq 'true') {
                Add-Result -Status PASS -Check "forwardWindowsAuthToken 已啟用"
            } else {
                Add-Result -Status FAIL -Check "forwardWindowsAuthToken 已啟用" `
                    -Detail "httpPlatform 未設定 forwardWindowsAuthToken=`"true`"，Windows 單一登入會完全失效"
            }

            # arguments 必須用 %HTTP_PLATFORM_PORT%（IIS 動態指派的 port）
            # 並指向 wsgi:application。寫死 port 會導致 IIS 代理不到。
            if ($platformArgs -match '%HTTP_PLATFORM_PORT%') {
                Add-Result -Status PASS -Check "arguments 使用 %HTTP_PLATFORM_PORT%"
            } else {
                Add-Result -Status FAIL -Check "arguments 使用 %HTTP_PLATFORM_PORT%" `
                    -Detail "目前 arguments 為 '$platformArgs'，未使用 IIS 動態指派的 port，IIS 會代理不到 Waitress"
            }
            if ($platformArgs -match 'wsgi:application') {
                Add-Result -Status PASS -Check "arguments 指向 wsgi:application"
            } else {
                Add-Result -Status FAIL -Check "arguments 指向 wsgi:application" -Detail "目前 arguments 為 '$platformArgs'"
            }

            # 沒設 PYTHONUNBUFFERED，stdout 會被緩衝，logs\python.log 會一直是空的，
            # 出問題時完全沒有線索可看。
            $unbuffered = ($envVars | Where-Object { $_.name -eq 'PYTHONUNBUFFERED' }).value
            if ($unbuffered -eq '1') {
                Add-Result -Status PASS -Check "PYTHONUNBUFFERED 已設為 1"
            } else {
                Add-Result -Status WARN -Check "PYTHONUNBUFFERED 已設為 1" `
                    -Detail "未設定時 Python 的 stdout 會被緩衝，logs\python.log 會是空的，排錯時沒有任何線索"
            }
        }

        # PYTHONPATH 必須包含專案根目錄 (才 import 得到 wsgi.py / app.py)，
        # 若這份 Python 把標準函式庫放在獨立的 stdlib 資料夾 (常見於 portable 版)，
        # 也必須一併列入，否則連 shutil 這種標準模組都會 ModuleNotFoundError。
        if ($pythonPathValue) {
            $pythonPathEntries = $pythonPathValue -split ';' | Where-Object { $_.Trim() }

            if ($pythonPathEntries -contains $AppRoot.TrimEnd('\')) {
                Add-Result -Status PASS -Check "PYTHONPATH 包含專案根目錄"
            } else {
                Add-Result -Status FAIL -Check "PYTHONPATH 包含專案根目錄" `
                    -Detail "PYTHONPATH 為 '$pythonPathValue'，未包含 $AppRoot，Waitress 會 import 不到 wsgi:application"
            }

            if ($pythonExe) {
                $stdlibDir = Join-Path (Split-Path -Parent $pythonExe) 'stdlib'
                if (Test-Path $stdlibDir) {
                    if ($pythonPathEntries -contains $stdlibDir.TrimEnd('\')) {
                        Add-Result -Status PASS -Check "PYTHONPATH 包含 stdlib 目錄"
                    } else {
                        Add-Result -Status FAIL -Check "PYTHONPATH 包含 stdlib 目錄" `
                            -Detail ("偵測到標準函式庫目錄 $stdlibDir，但 PYTHONPATH 沒有列入。`n" +
                                     "       這會導致 import shutil 之類的標準模組失敗 (ModuleNotFoundError)。`n" +
                                     "       請把 PYTHONPATH 設成：$($AppRoot.TrimEnd('\'));$($stdlibDir.TrimEnd('\'))")
                    }
                }
            }
        } else {
            Add-Result -Status WARN -Check "web.config 有設定 PYTHONPATH" -Detail "environmentVariables 內找不到 PYTHONPATH"
        }

        # AD 帳密登入 (使用者按掉 Windows 驗證視窗時的備援登入方式) 需要 AD_SERVER。
        # 可以放在 web.config 的 environmentVariables，也可以放在部署機的 .env。
        $adServerValue = ($envVars | Where-Object { $_.name -eq 'AD_SERVER' }).value
        if (-not $adServerValue) {
            $envFile = Join-Path $AppRoot '.env'
            if (Test-Path $envFile) {
                $adLine = Get-Content $envFile | Where-Object { $_ -match '^\s*AD_SERVER\s*=\s*\S' }
                if ($adLine) { $adServerValue = '(由 .env 提供)' }
            }
        }
        if ($adServerValue) {
            Add-Result -Status PASS -Check "有設定 AD_SERVER" -Detail $adServerValue
        } else {
            Add-Result -Status WARN -Check "有設定 AD_SERVER" `
                -Detail "未設定 AD_SERVER，Windows 單一登入仍可用，但登入畫面的『AD 帳號密碼登入』會無法使用"
        }
    } catch {
        Add-Result -Status FAIL -Check "web.config 可正確解析" -Detail $_.Exception.Message
    }
}

# 3. venv 的 python.exe / waitress-serve.exe 是否存在
if ($waitressExe) {
    if (Test-Path $waitressExe) {
        Add-Result -Status PASS -Check "waitress-serve.exe 存在" -Detail $waitressExe
    } else {
        Add-Result -Status FAIL -Check "waitress-serve.exe 存在" `
            -Detail ("找不到 $waitressExe`n" +
                     "       venv 內寫死絕對路徑，部署目錄搬動過就必須重建：`n" +
                     "       .\scripts\deploy-iis.ps1 -RecreateVenv")
    }
} else {
    Add-Result -Status FAIL -Check "waitress-serve.exe 存在" -Detail "無法從 web.config 解析出 processPath"
}

if ($pythonExe) {
    if (Test-Path $pythonExe) {
        Add-Result -Status PASS -Check "venv 的 python.exe 存在" -Detail $pythonExe
    } else {
        Add-Result -Status FAIL -Check "venv 的 python.exe 存在" -Detail "找不到 $pythonExe"
    }
}

# wsgi.py 是 Waitress 的進入點，少了它 IIS 只會回 502
$wsgiPath = Join-Path $AppRoot 'wsgi.py'
if (Test-Path $wsgiPath) {
    Add-Result -Status PASS -Check "wsgi.py 存在"
} else {
    Add-Result -Status FAIL -Check "wsgi.py 存在" `
        -Detail "找不到 $wsgiPath，HttpPlatformHandler 啟動的 waitress-serve 會找不到 wsgi:application"
}

# 4. Python 是否能正常啟動 / 版本
$pythonUsable = $false
if ($pythonExe -and (Test-Path $pythonExe)) {
    $verResult = Invoke-Native -FilePath $pythonExe -ArgumentList @('--version')

    if ($verResult.ExitCode -eq 0 -and $verResult.Output -match '(\d+)\.(\d+)\.(\d+)') {
        $pythonUsable = $true
        $major = [int]$Matches[1]; $minor = [int]$Matches[2]
        if ($major -gt 3 -or ($major -eq 3 -and $minor -ge 11)) {
            Add-Result -Status PASS -Check "Python 版本 >= 3.11" -Detail $verResult.Output
        } else {
            Add-Result -Status WARN -Check "Python 版本 >= 3.11" -Detail "偵測到 $($verResult.Output)，建議 3.11 以上"
        }
    } else {
        # python.exe 本身就啟動失敗（例如 embeddable/portable 版本的
        # stdlib 路徑跑掉，或 PYTHONHOME/PYTHONPATH 環境變數衝突）。
        # 這裡把完整診斷資訊印出來，而不是只給第一行錯誤。
        $diagLines = New-Object System.Collections.Generic.List[string]
        $diagLines.Add("完整錯誤輸出：")
        $diagLines.Add($verResult.Output)

        $pythonDir = Split-Path -Parent $pythonExe
        $pthFiles = Get-ChildItem -Path $pythonDir -Filter '*._pth' -ErrorAction SilentlyContinue
        if ($pthFiles) {
            foreach ($pth in $pthFiles) {
                $diagLines.Add("")
                $diagLines.Add("找到 $($pth.Name)，內容：")
                $diagLines.Add((Get-Content $pth.FullName -Raw))
            }
            $diagLines.Add("")
            $diagLines.Add("若這是 embeddable/portable Python，_pth 檔內若沒有 'import site' 或路徑寫死成舊機器的路徑，都會導致啟動失敗。")
        }

        if ($env:PYTHONHOME -or $env:PYTHONPATH) {
            $diagLines.Add("")
            $diagLines.Add("偵測到系統環境變數 PYTHONHOME='$($env:PYTHONHOME)' / PYTHONPATH='$($env:PYTHONPATH)'，可能與這個 portable Python 衝突，建議移除或確認指向正確路徑。")
        }

        Add-Result -Status FAIL -Check "Python 可正常啟動" -Detail ($diagLines -join "`n       ")
    }

    # 5. requirements.txt 套件檢查
    if (-not $pythonUsable) {
        Add-Result -Status FAIL -Check "套件安裝檢查 (requirements.txt)" `
            -Detail "python.exe 本身無法啟動，略過逐一套件檢查，請先解決上面『Python 可正常啟動』的問題"
    } else {
        $requirementsPath = Join-Path $AppRoot 'requirements.txt'
        if (Test-Path $requirementsPath) {
            # 版本條件與 extras 都要去掉：psycopg[binary]>=3.2.0 的套件名是 psycopg
            $packages = Get-Content $requirementsPath | Where-Object { $_.Trim() -and -not $_.StartsWith('#') } |
                ForEach-Object { ($_ -split '[><=!~\[]')[0].Trim() }

            foreach ($pkg in $packages) {
                $showResult = Invoke-Native -FilePath $pythonExe -ArgumentList @('-m', 'pip', 'show', $pkg)
                if ($showResult.ExitCode -eq 0) {
                    Add-Result -Status PASS -Check "套件已安裝: $pkg"
                } else {
                    Add-Result -Status FAIL -Check "套件已安裝: $pkg" -Detail $showResult.Output
                }
            }
        } else {
            Add-Result -Status WARN -Check "requirements.txt 存在" -Detail "找不到 $requirementsPath，略過套件檢查"
        }
    }
} else {
    Add-Result -Status WARN -Check "Python 套件檢查" -Detail "找不到可用的 python.exe，略過"
}

# 6. IIS 角色/功能
try {
    $features = Get-WindowsFeature -ErrorAction Stop
    $needed = @{
        'Web-Server'       = 'IIS (Web Server)'
        'Web-CGI'          = 'CGI / FastCGI'
        'Web-Windows-Auth' = 'Windows Authentication'
    }
    foreach ($name in $needed.Keys) {
        $f = $features | Where-Object { $_.Name -eq $name }
        if ($f -and $f.Installed) {
            Add-Result -Status PASS -Check "IIS 功能已安裝: $($needed[$name])"
        } else {
            Add-Result -Status FAIL -Check "IIS 功能已安裝: $($needed[$name])" -Detail "未安裝 (Install-WindowsFeature $name)"
        }
    }
} catch {
    Add-Result -Status WARN -Check "IIS 角色/功能檢查" -Detail "此系統無 Get-WindowsFeature (可能非 Windows Server)，請自行確認已啟用 CGI/FastCGI 與 Windows Authentication"
}

# 7. HttpPlatformHandler 模組是否已安裝
# IIS 不內建這個模組，要另外裝 MSI；沒裝的話所有請求都會回 500。
$moduleFound = $false
if (Get-Command Get-WebGlobalModule -ErrorAction SilentlyContinue) {
    $moduleFound = [bool](Get-WebGlobalModule -ErrorAction SilentlyContinue |
                          Where-Object { $_.Name -like 'httpPlatformHandler*' })
}
if (-not $moduleFound) {
    # 沒有 WebAdministration 模組時退而檢查 DLL
    $moduleFound = Test-Path "$env:SystemRoot\System32\inetsrv\httpplatformhandler.dll"
}
if ($moduleFound) {
    Add-Result -Status PASS -Check "HttpPlatformHandler 模組已安裝"
} else {
    Add-Result -Status FAIL -Check "HttpPlatformHandler 模組已安裝" `
        -Detail ("IIS 不內建這個模組，必須另外安裝 MSI：`n" +
                 "       https://www.iis.net/downloads/microsoft/httpplatformhandler`n" +
                 "       未安裝時所有請求都會回 HTTP 500。")
}

# HttpPlatformHandler 的 stdout log 目錄必須存在且可寫，否則排錯時完全沒有線索
if ($stdoutLogPath) {
    $stdoutDir = Split-Path -Parent $stdoutLogPath
    if (Test-Path $stdoutDir) {
        Add-Result -Status PASS -Check "stdout log 目錄存在" -Detail $stdoutDir
    } else {
        Add-Result -Status FAIL -Check "stdout log 目錄存在" `
            -Detail "找不到 $stdoutDir，HttpPlatformHandler 會寫不出 log（請建立該資料夾並給 AppPool 帳號 Modify 權限）"
    }
}

# 8. 專案必要檔案 / 資料夾
$requiredPaths = @(
    'app.py', 'data_processor.py', 'building_data_manager.py', 'requirements.txt',
    'templates\index.html', 'templates\403.html',
    'static\css\style.css', 'static\js\main.js', 'static\js\building-data-admin.js'
)
foreach ($rel in $requiredPaths) {
    $full = Join-Path $AppRoot $rel
    if (Test-Path $full) {
        Add-Result -Status PASS -Check "檔案存在: $rel"
    } else {
        Add-Result -Status FAIL -Check "檔案存在: $rel" -Detail "找不到 $full"
    }
}

# 9. permissions.json
$permissionsPath = Join-Path $AppRoot 'permissions.json'
if (Test-Path $permissionsPath) {
    try {
        $permissions = Get-Content $permissionsPath -Raw | ConvertFrom-Json
        if ($permissions.admins -and $permissions.admins.Count -gt 0) {
            Add-Result -Status PASS -Check "permissions.json 格式正確且 admins 非空" `
                -Detail "admins: $($permissions.admins -join ', ')"
        } else {
            Add-Result -Status WARN -Check "permissions.json 格式正確且 admins 非空" `
                -Detail "admins 是空的，正式環境沒有人能用 admin 功能"
        }
        if ($permissions.admins -contains 'Local-Dev') {
            Add-Result -Status WARN -Check "permissions.json 已改成正式 AD 帳號" `
                -Detail "目前仍包含測試用的 Local-Dev，正式部署請換成真實 DOMAIN\\username"
        }
    } catch {
        Add-Result -Status FAIL -Check "permissions.json 為合法 JSON" -Detail $_.Exception.Message
    }
} else {
    Add-Result -Status FAIL -Check "permissions.json 存在" -Detail "找不到 $permissionsPath"
}

# 10. 執行期資料夾/檔案可寫入
$writableTargets = @('uploads', 'processed', 'data_backups', 'utility_trend_backups')
foreach ($dir in $writableTargets) {
    $full = Join-Path $AppRoot $dir
    if (Test-WritablePath -Path $full) {
        Add-Result -Status PASS -Check "資料夾可寫入: $dir"
    } else {
        Add-Result -Status FAIL -Check "資料夾可寫入: $dir" -Detail "$full 無法寫入，請確認 IIS App Pool 身分的權限"
    }
}
if (Test-WritablePath -Path $AppRoot) {
    Add-Result -Status PASS -Check "根目錄可寫入 (data.json / access_log.txt / app.log)"
} else {
    Add-Result -Status FAIL -Check "根目錄可寫入 (data.json / access_log.txt / app.log)" -Detail "$AppRoot 無法寫入"
}

# 10-1. 資料來源與 PostgreSQL 連線
#
# DATA_BACKEND=json 時（預設）整段只做提示，不會因為沒有資料庫而判定失敗；
# 切成 postgres 之後才會真的去連線並檢查 schema。
$envFilePath = Join-Path $AppRoot '.env'
$dataBackend = 'json'
$backendSource = '預設值'

$webConfigBackend = ($envVars | Where-Object { $_.name -eq 'DATA_BACKEND' }).value
if ($webConfigBackend) { $dataBackend = $webConfigBackend; $backendSource = 'web.config' }

if (Test-Path $envFilePath) {
    Add-Result -Status PASS -Check ".env 存在" -Detail $envFilePath
    # .env 會覆蓋 web.config 的設定（db.py 在讀取環境變數前先 load_dotenv）
    $envBackendLine = Get-Content $envFilePath |
        Where-Object { $_ -match '^\s*DATA_BACKEND\s*=\s*(\S+)' } | Select-Object -Last 1
    if ($envBackendLine -and $envBackendLine -match '^\s*DATA_BACKEND\s*=\s*(\S+)') {
        $dataBackend = $Matches[1]; $backendSource = '.env'
    }

    # .env 是機密檔，不該被一般使用者讀到
    try {
        $envAcl = Get-Acl $envFilePath
        $looseAccess = $envAcl.Access | Where-Object {
            $_.IdentityReference -match 'Everyone|Users|Authenticated Users' -and
            $_.FileSystemRights -match 'Read|FullControl|Modify'
        }
        if ($looseAccess) {
            Add-Result -Status WARN -Check ".env 權限已收斂" `
                -Detail ("$envFilePath 目前對 $(($looseAccess.IdentityReference | Select-Object -Unique) -join '、') 開放讀取。`n" +
                         "       這個檔案含資料庫密碼，建議只保留 SYSTEM、Administrators 與 IIS AppPool 帳號。")
        } else {
            Add-Result -Status PASS -Check ".env 權限已收斂"
        }
    } catch {
        Add-Result -Status WARN -Check ".env 權限檢查" -Detail $_.Exception.Message
    }
} else {
    Add-Result -Status WARN -Check ".env 存在" `
        -Detail "找不到 $envFilePath。只跑 DATA_BACKEND=json 時可以不用；要接 PostgreSQL 請從 .env.example 複製一份。"
}

Add-Result -Status PASS -Check "資料來源設定 (DATA_BACKEND)" -Detail "$dataBackend（來自 $backendSource）"

# 密碼不該出現在進版控的 web.config 裡
if ($envVars | Where-Object { $_.name -match 'PGPASSWORD|BUILDING_DB_DSN' }) {
    Add-Result -Status FAIL -Check "資料庫機密未寫進 web.config" `
        -Detail ("web.config 內出現 PGPASSWORD 或 BUILDING_DB_DSN。`n" +
                 "       web.config 是進版控的檔案，密碼寫在這裡等於 commit 進 git，`n" +
                 "       請改放部署機的 .env。")
} else {
    Add-Result -Status PASS -Check "資料庫機密未寫進 web.config"
}

if ($dataBackend -eq 'postgres') {
    if (-not $pythonUsable) {
        Add-Result -Status FAIL -Check "PostgreSQL 連線" -Detail "python.exe 無法啟動，略過資料庫檢查"
    } else {
        # 直接用專案的 db.py 連線，確保檢查走的是程式實際會用的那條路徑
        $probe = @'
import sys
sys.path.insert(0, sys.argv[1])
import db
ok, message = db.ping()
print(("OK|" if ok else "FAIL|") + message)
if ok:
    try:
        applied = db.applied_migrations()
        print("MIGRATIONS|" + (",".join(applied) if applied else "(none)"))
    except Exception as exc:
        print("MIGRATIONS|ERROR: %s" % exc)
db.close_pool()
'@
        $probeFile = Join-Path $env:TEMP "building-db-probe-$PID.py"
        # 探測腳本全是 ASCII，用 ASCII 寫出可避免 PowerShell 5.1 加上 BOM
        Set-Content -Path $probeFile -Value $probe -Encoding ASCII
        $probeResult = Invoke-Native -FilePath $pythonExe -ArgumentList @($probeFile, $AppRoot)
        Remove-Item $probeFile -ErrorAction SilentlyContinue

        if ($probeResult.Output -match 'OK\|(.*)') {
            Add-Result -Status PASS -Check "PostgreSQL 連線" -Detail $Matches[1].Trim()

            if ($probeResult.Output -match '(?m)^MIGRATIONS\|(.*)$') {
                $applied = $Matches[1].Trim()
                if ($applied -eq '(none)' -or $applied -like 'ERROR:*') {
                    Add-Result -Status FAIL -Check "schema migration 已套用" `
                        -Detail ("資料庫內找不到已套用的 migration（$applied）。`n" +
                                 "       請先執行：.\scripts\run-migrations.ps1")
                } else {
                    Add-Result -Status PASS -Check "schema migration 已套用" -Detail $applied
                }
            }
        } else {
            Add-Result -Status FAIL -Check "PostgreSQL 連線" `
                -Detail ("連線失敗：`n       " + ($probeResult.Output -replace "`n", "`n       ") + "`n" +
                         "       請確認 .env 的 PGHOST / PGDATABASE / PGUSER / PGPASSWORD，" +
                         "以及防火牆與 sslmode 設定。")
        }
    }
} else {
    Add-Result -Status PASS -Check "PostgreSQL 檢查" `
        -Detail "DATA_BACKEND 為 $dataBackend，資料仍走地端 JSON 檔案，略過資料庫檢查"
}

# 11. AD 網域加入狀態
try {
    $cs = Get-CimInstance Win32_ComputerSystem
    if ($cs.PartOfDomain) {
        Add-Result -Status PASS -Check "已加入 AD 網域" -Detail $cs.Domain
    } else {
        Add-Result -Status FAIL -Check "已加入 AD 網域" -Detail "此機器未加入網域，Windows Integrated Authentication 無法正確取得 REMOTE_USER"
    }
} catch {
    Add-Result -Status WARN -Check "AD 網域加入檢查" -Detail $_.Exception.Message
}

# 12. 對外 CDN 連線 (前端依賴)
$cdnHosts = @('cdn.tailwindcss.com', 'unpkg.com', 'cdn.jsdelivr.net')
foreach ($h in $cdnHosts) {
    try {
        $test = Test-NetConnection -ComputerName $h -Port 443 -WarningAction SilentlyContinue
        if ($test.TcpTestSucceeded) {
            Add-Result -Status PASS -Check "可連線 CDN: $h"
        } else {
            Add-Result -Status WARN -Check "可連線 CDN: $h" -Detail "連線失敗，若此環境無法連外網，前端畫面會壞掉，需改成本地化資源"
        }
    } catch {
        Add-Result -Status WARN -Check "可連線 CDN: $h" -Detail $_.Exception.Message
    }
}

# 13. (可選) 指定 IIS 網站時的額外檢查
if ($SiteName) {
    try {
        Import-Module WebAdministration -ErrorAction Stop
        $site = Get-Website -Name $SiteName -ErrorAction Stop
        Add-Result -Status PASS -Check "IIS 網站存在: $SiteName" -Detail "PhysicalPath: $($site.physicalPath)"

        if ($site.physicalPath.TrimEnd('\') -eq $AppRoot.TrimEnd('\')) {
            Add-Result -Status PASS -Check "IIS 網站實體路徑與 AppRoot 一致"
        } else {
            Add-Result -Status WARN -Check "IIS 網站實體路徑與 AppRoot 一致" `
                -Detail "網站路徑為 $($site.physicalPath)，與檢查用的 AppRoot ($AppRoot) 不同"
        }

        $winAuth = Get-WebConfigurationProperty -Filter '/system.webServer/security/authentication/windowsAuthentication' `
            -Name enabled -PSPath "IIS:\Sites\$SiteName"
        if ($winAuth.Value) {
            Add-Result -Status PASS -Check "IIS 網站已啟用 Windows Authentication"
        } else {
            Add-Result -Status FAIL -Check "IIS 網站已啟用 Windows Authentication" -Detail "目前是停用狀態"
        }

        # 登入流程需要「根目錄允許匿名」＋「/auth/sso 關閉匿名」，
        # 否則使用者按掉 Windows 帳密視窗時會看到 IIS 的 401 錯誤頁，而不是本系統的登入畫面。
        $rootAnon = Get-WebConfigurationProperty -Filter '/system.webServer/security/authentication/anonymousAuthentication' `
            -Name enabled -PSPath "IIS:\Sites\$SiteName"
        if ($rootAnon.Value) {
            Add-Result -Status PASS -Check "IIS 網站已啟用匿名驗證 (登入畫面備援用)"
        } else {
            Add-Result -Status FAIL -Check "IIS 網站已啟用匿名驗證 (登入畫面備援用)" `
                -Detail "目前是停用狀態，使用者按掉 Windows 帳密視窗會看到 IIS 錯誤頁。請執行 scripts\setup-ad-login.ps1"
        }

        try {
            $ssoAnon = Get-WebConfigurationProperty -Filter '/system.webServer/security/authentication/anonymousAuthentication' `
                -Name enabled -PSPath "MACHINE/WEBROOT/APPHOST" -Location "$SiteName/auth/sso"
            if (-not $ssoAnon.Value) {
                Add-Result -Status PASS -Check "/auth/sso 已關閉匿名驗證 (單一登入用)"
            } else {
                Add-Result -Status WARN -Check "/auth/sso 已關閉匿名驗證 (單一登入用)" `
                    -Detail ("匿名仍為啟用，Windows 單一登入不會生效，使用者每次都要手動輸入 AD 帳密。" +
                             "請執行 scripts\setup-ad-login.ps1；若本平台是掛在子應用程式底下，" +
                             "請確認的是『<網站>/<應用程式>/auth/sso』這個路徑")
            }
        } catch {
            Add-Result -Status WARN -Check "/auth/sso 驗證設定檢查" -Detail $_.Exception.Message
        }
    } catch {
        Add-Result -Status WARN -Check "IIS 網站設定檢查 ($SiteName)" -Detail $_.Exception.Message
    }
}

# 總結
Write-Host ""
Write-Host "===================================================="
Write-Host " 檢查結果總結"
Write-Host "===================================================="

$passCount = ($results | Where-Object Status -eq 'PASS').Count
$warnCount = ($results | Where-Object Status -eq 'WARN').Count
$failCount = ($results | Where-Object Status -eq 'FAIL').Count

Write-Host ("PASS: {0}  WARN: {1}  FAIL: {2}" -f $passCount, $warnCount, $failCount)

if ($failCount -gt 0) {
    Write-Host ""
    Write-Host "以下項目必須修正才能正常部署：" -ForegroundColor Red
    $results | Where-Object Status -eq 'FAIL' | ForEach-Object {
        Write-Host (" - {0}" -f $_.Check) -ForegroundColor Red
        if ($_.Detail) { Write-Host ("     {0}" -f $_.Detail) -ForegroundColor DarkGray }
    }
    exit 1
} else {
    Write-Host ""
    Write-Host "沒有 FAIL 項目，若有 WARN 請自行評估是否需要處理。" -ForegroundColor Green
    exit 0
}
