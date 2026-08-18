<#
.SYNOPSIS
    部署前檢查腳本 - 確認本機 (IIS Server) 是否具備執行「建物管理平台」所需的一切。

.DESCRIPTION
    在目標 Server 上，於專案根目錄執行本腳本 (或指定 -AppRoot)。
    腳本會讀取專案根目錄的 web.config，解析出實際設定的 Python / wfastcgi /
    PYTHONPATH / WSGI_LOG 路徑，並依序檢查：

      1. web.config 是否存在、路徑是否已從範例值改成本機實際路徑
      2. web.config 內指到的 python.exe / wfastcgi.py 是否存在
      3. Python 版本是否 >= 3.11
      4. requirements.txt 內的套件是否都已安裝
      5. IIS 角色/功能：Web Server、CGI、Windows Authentication
      6. IIS FastCGI 應用程式登錄是否與 web.config 的 scriptProcessor 一致
      7. 專案必要檔案 / 資料夾是否存在 (app.py、templates、static ...)
      8. permissions.json 是否存在、格式正確、admins 非空
      9. 執行期資料夾 (uploads/processed/data_backups/utility_trend_backups)
         與根目錄 (app.log/access_log.txt/data.json) 是否可寫入
     10. 本機是否已加入 AD 網域 (Windows Integrated Authentication 需要)
     11. 對外連線到前端 CDN (tailwindcss / unpkg / jsdelivr) 是否正常
     12. (可選) 指定 -SiteName 時，檢查 IIS 網站是否存在、實體路徑是否吻合、
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

# 2. 解析 web.config 內容
$pythonExe = $null
$wfastcgiPy = $null
$pythonPathValue = $null
$wsgiLogPath = $null

if (Test-Path $webConfigPath) {
    try {
        [xml]$webConfigXml = Get-Content $webConfigPath -Raw

        $scriptProcessor = $webConfigXml.configuration.'system.webServer'.handlers.add.scriptProcessor

        # scriptProcessor 格式為 {python.exe}|{wfastcgi.py 參數}，
        # 其中參數部分可能（也建議）被引號包住，解析時要一併去掉引號。
        $wfastcgiQuoted = $false
        if ($scriptProcessor -match '^(.*?python\.exe)\|(.*)$') {
            $pythonExe = $Matches[1].Trim()
            $rawArgs   = $Matches[2].Trim()
            if ($rawArgs -match '^"(.*)"$') {
                $wfastcgiQuoted = $true
                $wfastcgiPy = $Matches[1]
            } else {
                $wfastcgiPy = $rawArgs
            }
        }

        $appSettings = $webConfigXml.configuration.appSettings.add
        $pythonPathValue = ($appSettings | Where-Object { $_.key -eq 'PYTHONPATH' }).value
        $wsgiLogPath     = ($appSettings | Where-Object { $_.key -eq 'WSGI_LOG' }).value

        if ($scriptProcessor -match 'C:\\inetpub\\wwwroot\\BuildingPlatform' -or $scriptProcessor -match 'D:\\FAC_Web\\BuildingPlatform') {
            Add-Result -Status WARN -Check "web.config 路徑已改成本機實際路徑" `
                -Detail "目前仍是範例/舊路徑：$scriptProcessor，請確認是否已改成這台 Server 的實際安裝路徑"
        } else {
            Add-Result -Status PASS -Check "web.config 路徑已改成本機實際路徑" -Detail $scriptProcessor
        }

        # 路徑含空白時，wfastcgi.py 參數一定要用引號包住。
        # 否則 IIS 把未加引號的參數接到命令列，Windows 依空白拆解，Python 只收到第一段，
        # 造成 can't open file 'D:\Web' -> IIS 回報 0x00000002「FastCGI 處理序意外地結束」，
        # 而且因為 Python 在載入 wfastcgi.py 前就結束，app.log 完全不會有任何內容。
        if ($wfastcgiPy -and $wfastcgiPy.Contains(' ')) {
            if ($wfastcgiQuoted) {
                Add-Result -Status PASS -Check "路徑含空白時 wfastcgi.py 參數已加引號"
            } else {
                Add-Result -Status FAIL -Check "路徑含空白時 wfastcgi.py 參數已加引號" `
                    -Detail ("路徑含空白但未加引號，IIS 啟動時會被拆成兩段參數而失敗 (0x00000002)。`n" +
                             "       請把 web.config 的 scriptProcessor 改成 (引號在 XML 內寫作 &quot;)：`n" +
                             "       $pythonExe|`"$wfastcgiPy`"`n" +
                             "       並同步更新 IIS FastCGI 登錄的 arguments 欄位，兩邊要完全一致。")
            }
        }
    } catch {
        Add-Result -Status FAIL -Check "web.config 可正確解析" -Detail $_.Exception.Message
    }
}

# 3. python.exe / wfastcgi.py 是否存在
if ($pythonExe) {
    if (Test-Path $pythonExe) {
        Add-Result -Status PASS -Check "python.exe 存在" -Detail $pythonExe
    } else {
        Add-Result -Status FAIL -Check "python.exe 存在" -Detail "找不到 $pythonExe"
    }
} else {
    Add-Result -Status FAIL -Check "python.exe 存在" -Detail "無法從 web.config 解析出 scriptProcessor"
}

if ($wfastcgiPy) {
    if (Test-Path $wfastcgiPy) {
        Add-Result -Status PASS -Check "wfastcgi.py 存在" -Detail $wfastcgiPy
    } else {
        Add-Result -Status FAIL -Check "wfastcgi.py 存在" -Detail "找不到 $wfastcgiPy"
    }
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
            $packages = Get-Content $requirementsPath | Where-Object { $_.Trim() -and -not $_.StartsWith('#') } |
                ForEach-Object { ($_ -split '[><=!~]')[0].Trim() }

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

# 7. IIS FastCGI 應用程式登錄是否與 web.config 一致
if ($pythonExe -and $wfastcgiPy) {
    $appcmd = Join-Path $env:WINDIR 'System32\inetsrv\appcmd.exe'
    if (Test-Path $appcmd) {
        $fastCgiResult = Invoke-Native -FilePath $appcmd -ArgumentList @('list', 'config', '-section:system.webServer/fastCgi')

        # 若路徑含空白，登錄的 arguments 也必須帶引號，才會與 web.config 一致。
        $expectedArgs = if ($wfastcgiPy.Contains(' ')) { "`"$wfastcgiPy`"" } else { $wfastcgiPy }

        if ($fastCgiResult.Output -notmatch [regex]::Escape($pythonExe)) {
            $fixCmd = "& `"$appcmd`" set config -section:system.webServer/fastCgi `"/+[fullPath='$pythonExe',arguments='$expectedArgs']`" /commit:apphost"
            Add-Result -Status FAIL -Check "IIS FastCGI 已登錄對應的 python.exe" `
                -Detail "applicationHost.config 內找不到此路徑，可在 IIS Manager -> 伺服器層級 -> FastCGI 設定 新增，或用系統管理員權限執行：`n       $fixCmd"
        } else {
            Add-Result -Status PASS -Check "IIS FastCGI 已登錄對應的 python.exe" -Detail $pythonExe

            # python.exe 有登錄不代表 arguments 正確；路徑含空白卻沒加引號一樣會啟動失敗。
            if ($wfastcgiPy.Contains(' ')) {
                if ($fastCgiResult.Output -match [regex]::Escape("arguments=`"$wfastcgiPy`"") -or
                    $fastCgiResult.Output -match [regex]::Escape("&quot;$wfastcgiPy&quot;")) {
                    Add-Result -Status PASS -Check "IIS FastCGI 登錄的 arguments 已正確加引號"
                } else {
                    Add-Result -Status FAIL -Check "IIS FastCGI 登錄的 arguments 已正確加引號" `
                        -Detail ("登錄的 arguments 疑似未加引號，路徑含空白時會導致 0x00000002 啟動失敗。`n" +
                                 "       請重新登錄 (先移除舊的再新增)：`n" +
                                 "       & `"$appcmd`" set config -section:system.webServer/fastCgi `"/-[fullPath='$pythonExe',arguments='$wfastcgiPy']`" /commit:apphost`n" +
                                 "       & `"$appcmd`" set config -section:system.webServer/fastCgi `"/+[fullPath='$pythonExe',arguments='$expectedArgs']`" /commit:apphost")
                }
            }
        }
    } else {
        Add-Result -Status WARN -Check "IIS FastCGI 登錄檢查" -Detail "找不到 appcmd.exe，略過"
    }
}

# 8. 專案必要檔案 / 資料夾
$requiredPaths = @(
    'app.py', 'data_processor.py', 'requirements.txt',
    'templates\index.html', 'templates\403.html',
    'static\css\style.css', 'static\js\main.js'
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
