<#
.SYNOPSIS
    設定 IIS 驗證，讓建物管理平台可以「Windows 單一登入 + AD 帳密登入畫面」並存。

.DESCRIPTION
    使用者若在瀏覽器的 Windows 帳密視窗按「取消」，IIS 預設會直接回 401 錯誤頁。
    本腳本把驗證改成：

        應用程式根目錄  → 匿名驗證 啟用 ＋ Windows 驗證 啟用
        <app>/auth/sso  → 匿名驗證 停用 ＋ Windows 驗證 啟用

    * 根目錄允許匿名：任何請求都進得到 Flask，沒有身分時由程式導向 /login 登入畫面。
    * /auth/sso 關閉匿名：網域內電腦仍會自動帶入 Windows 身分，登入頁背景呼叫它即可完成 SSO；
      非網域電腦跳出帳密視窗、使用者按取消時，前端接住錯誤後就停在登入畫面。

    這兩個區段預設鎖定在 applicationHost.config，只能用 PowerShell / IIS 管理員設定，
    寫進 web.config 會出現 HTTP 500.19。

.PARAMETER SiteName
    IIS 網站名稱，例如 "Default Web Site"。

.PARAMETER AppPath
    子應用程式路徑；直接掛在網站根目錄時留空。例如 "building_platform"。

.EXAMPLE
    # 掛在網站根目錄
    .\setup-ad-login.ps1 -SiteName "Default Web Site"

.EXAMPLE
    # 掛在 http://server/building_platform
    .\setup-ad-login.ps1 -SiteName "Default Web Site" -AppPath "building_platform"

.NOTES
    需以「系統管理員」身分執行 PowerShell。
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SiteName,

    [string]$AppPath = ""
)

$ErrorActionPreference = "Stop"

function Write-Step($text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "  [OK] $text" -ForegroundColor Green }
function Write-Warn2($text){ Write-Host "  [!]  $text" -ForegroundColor Yellow }

# --- 0. 前置檢查 ---------------------------------------------------------

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    throw "請以系統管理員身分開啟 PowerShell 再執行本腳本。"
}

Import-Module WebAdministration -ErrorAction Stop

# 組出 IIS 設定路徑：Site 或 Site/App
$appLocation = $SiteName
if ($AppPath) {
    $appLocation = "$SiteName/$($AppPath.Trim('/'))"
}
$ssoLocation = "$appLocation/auth/sso"

Write-Host "設定目標應用程式：$appLocation" -ForegroundColor White
Write-Host "SSO 探測路徑     ：$ssoLocation" -ForegroundColor White

# --- 1. 確認 Windows 驗證功能已安裝 --------------------------------------

Write-Step "檢查 IIS Windows 驗證功能"

$feature = Get-WindowsFeature -Name Web-Windows-Auth -ErrorAction SilentlyContinue
if ($feature -and -not $feature.Installed) {
    Write-Warn2 "尚未安裝 Windows 驗證功能，正在安裝…"
    Install-WindowsFeature -Name Web-Windows-Auth | Out-Null
    Write-Ok "已安裝 Web-Windows-Auth"
} else {
    Write-Ok "Windows 驗證功能已安裝"
}

# --- 2. 解除 applicationHost.config 的區段鎖定 ---------------------------

Write-Step "解除驗證區段鎖定 (才能針對個別路徑設定)"

foreach ($section in @(
    "system.webServer/security/authentication/anonymousAuthentication",
    "system.webServer/security/authentication/windowsAuthentication")) {

    Set-WebConfiguration -Filter $section -PSPath "MACHINE/WEBROOT/APPHOST" `
        -Metadata "overrideMode" -Value "Allow"
    Write-Ok $section
}

# --- 3. 應用程式根目錄：匿名 + Windows 都開 ------------------------------

Write-Step "應用程式根目錄：匿名驗證 啟用 / Windows 驗證 啟用"

Set-WebConfigurationProperty `
    -Filter "system.webServer/security/authentication/anonymousAuthentication" `
    -PSPath "MACHINE/WEBROOT/APPHOST" -Location $appLocation -Name enabled -Value $true
Write-Ok "匿名驗證：啟用 (按掉 Windows 帳密視窗時才進得到自家登入畫面)"

Set-WebConfigurationProperty `
    -Filter "system.webServer/security/authentication/windowsAuthentication" `
    -PSPath "MACHINE/WEBROOT/APPHOST" -Location $appLocation -Name enabled -Value $true
Write-Ok "Windows 驗證：啟用"

# --- 4. /auth/sso：只留 Windows 驗證 -------------------------------------

Write-Step "SSO 探測路徑：匿名驗證 停用 / Windows 驗證 啟用"

Set-WebConfigurationProperty `
    -Filter "system.webServer/security/authentication/anonymousAuthentication" `
    -PSPath "MACHINE/WEBROOT/APPHOST" -Location $ssoLocation -Name enabled -Value $false
Write-Ok "匿名驗證：停用"

Set-WebConfigurationProperty `
    -Filter "system.webServer/security/authentication/windowsAuthentication" `
    -PSPath "MACHINE/WEBROOT/APPHOST" -Location $ssoLocation -Name enabled -Value $true
Write-Ok "Windows 驗證：啟用"

# 把驗證後的 Windows token 傳給 Python，REMOTE_USER 取不到時還有備援
try {
    Set-WebConfigurationProperty `
        -Filter "system.webServer/security/authentication/windowsAuthentication" `
        -PSPath "MACHINE/WEBROOT/APPHOST" -Location $ssoLocation `
        -Name authPersistNonNTLM -Value $true
    Write-Ok "authPersistNonNTLM：啟用 (減少重複驗證握手)"
} catch {
    Write-Warn2 "設定 authPersistNonNTLM 失敗 (可忽略)：$($_.Exception.Message)"
}

# --- 5. 驗證結果 ---------------------------------------------------------

Write-Step "確認設定結果"

function Show-AuthState($location, $label) {
    $anon = (Get-WebConfigurationProperty `
        -Filter "system.webServer/security/authentication/anonymousAuthentication" `
        -PSPath "MACHINE/WEBROOT/APPHOST" -Location $location -Name enabled).Value
    $win = (Get-WebConfigurationProperty `
        -Filter "system.webServer/security/authentication/windowsAuthentication" `
        -PSPath "MACHINE/WEBROOT/APPHOST" -Location $location -Name enabled).Value

    Write-Host ("  {0,-22} 匿名={1,-5} Windows={2}" -f $label, $anon, $win) -ForegroundColor White
    return @{ Anonymous = $anon; Windows = $win }
}

$rootState = Show-AuthState $appLocation "應用程式根目錄"
$ssoState  = Show-AuthState $ssoLocation "/auth/sso"

$ok = $rootState.Anonymous -eq $true -and $rootState.Windows -eq $true `
      -and $ssoState.Anonymous -eq $false -and $ssoState.Windows -eq $true

if ($ok) {
    Write-Host "`n設定完成。" -ForegroundColor Green
    Write-Host "接著請確認：" -ForegroundColor White
    Write-Host "  1. web.config 的 appSettings 已填好 AD_SERVER (例：ldap://ASE)" -ForegroundColor Gray
    Write-Host "  2. 已安裝 ldap3 套件：pip install ldap3" -ForegroundColor Gray
    Write-Host "  3. 執行 iisreset /restart 後，用瀏覽器開啟平台網址測試" -ForegroundColor Gray
} else {
    Write-Warn2 "設定結果與預期不符，請用 IIS 管理員 → 驗證 手動確認。"
}
