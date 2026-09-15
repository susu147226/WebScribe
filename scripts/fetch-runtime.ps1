<#
.SYNOPSIS
    获取 WebScribe 随包分发的运行时（Node 与 Playwright Chromium）。

.DESCRIPTION
    把 Node.js 运行时与 Playwright 的 Chromium 下载到 runtime/ 目录下。
    这些文件体积较大（合计约 320 MB），因此不纳入 Git，由本脚本按需生成。

    开发环境与 Portable 包共用同一份运行时，保证行为一致。

    浏览器部分优先调用 Playwright 官方安装器；若其失败则回退到手动下载解压。
    回退路径是必要的：实测在部分网络环境下 Playwright 内置下载器（基于 Node
    的 https 模块）会连接超时，而系统级 HTTP 客户端可以正常下载同一地址。

.PARAMETER NodeVersion
    Node.js 版本号，默认 24.21.0（LTS Krypton）。

.PARAMETER SkipBrowsers
    仅获取 Node 运行时，跳过 Chromium 下载。

.PARAMETER Force
    已存在时强制重新下载。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\fetch-runtime.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\fetch-runtime.ps1 -SkipBrowsers
#>
[CmdletBinding()]
param(
    [string]$NodeVersion = "24.21.0",
    [switch]$SkipBrowsers,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $ProjectRoot "runtime"
$NodeDir = Join-Path $RuntimeDir "node"
$BrowserDir = Join-Path $RuntimeDir "browsers"
$CrawlerDir = Join-Path $ProjectRoot "crawler"
$BrowserManifest = Join-Path $CrawlerDir "node_modules\playwright-core\browsers.json"

# 与 Playwright 保持一致的下载源
$CdnBase = "https://cdn.playwright.dev/builds/cft"

function Write-Step {
    param([string]$Number, [string]$Text)
    Write-Host ""
    Write-Host "==> [$Number] $Text" -ForegroundColor Cyan
}

function Get-BrowserManifestEntry {
    param([string]$Name)

    $manifest = Get-Content -Raw -Path $BrowserManifest | ConvertFrom-Json
    return $manifest.browsers | Where-Object { $_.name -eq $Name } | Select-Object -First 1
}

<#
    手动下载并解压一个浏览器包。

    Playwright 期望的布局为：
        <browsers>/<name 中连字符换下划线>-<revision>/
            INSTALLATION_COMPLETE          <- 标记文件，缺失会被判定为未安装
            <zip 内顶层目录>/...

    zip 内的顶层目录会被保留，例如 chromium 解压后为 chrome-win64\chrome.exe。
#>
function Install-BrowserManually {
    param(
        [string]$Name,
        [string]$Url,
        [string]$TargetDir
    )

    $tempZip = Join-Path $env:TEMP "$Name.zip"
    $tempExtract = Join-Path $env:TEMP "$Name-extract"

    Write-Host "    手动下载: $Url"

    try {
        Invoke-WebRequest -Uri $Url -OutFile $tempZip -UseBasicParsing -TimeoutSec 600
    }
    catch {
        Write-Host "    下载失败: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }

    $sizeMb = [math]::Round((Get-Item $tempZip).Length / 1MB, 1)
    Write-Host "    已下载 $sizeMb MB"

    if (Test-Path $tempExtract) { Remove-Item -Recurse -Force $tempExtract }
    New-Item -ItemType Directory -Force -Path $tempExtract | Out-Null

    try {
        Expand-Archive -Path $tempZip -DestinationPath $tempExtract -Force
    }
    catch {
        Write-Host "    解压失败: $($_.Exception.Message)" -ForegroundColor Red
        Remove-Item -Force $tempZip -ErrorAction SilentlyContinue
        return $false
    }

    if (Test-Path $TargetDir) { Remove-Item -Recurse -Force $TargetDir }
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null

    Get-ChildItem -Path $tempExtract | ForEach-Object {
        Move-Item -Path $_.FullName -Destination $TargetDir -Force
    }

    New-Item -ItemType File -Path (Join-Path $TargetDir "INSTALLATION_COMPLETE") -Force | Out-Null

    Remove-Item -Recurse -Force $tempExtract -ErrorAction SilentlyContinue
    Remove-Item -Force $tempZip -ErrorAction SilentlyContinue

    Write-Host "    已安装到 $TargetDir" -ForegroundColor Green
    return $true
}

Write-Host "WebScribe 运行时获取" -ForegroundColor White
Write-Host "  项目根目录: $ProjectRoot"
Write-Host "  运行时目录: $RuntimeDir"
Write-Host "  Node 版本:  $NodeVersion"

# --- 1. 准备目录 ---
Write-Step "1/4" "准备目录"
New-Item -ItemType Directory -Force -Path $NodeDir | Out-Null
New-Item -ItemType Directory -Force -Path $BrowserDir | Out-Null
Write-Host "    已就绪: runtime\node, runtime\browsers"

# --- 2. 下载 Node 运行时 ---
Write-Step "2/4" "下载 Node.js 运行时"

$NodeExe = Join-Path $NodeDir "node.exe"
$NodeUrl = "https://nodejs.org/dist/v$NodeVersion/win-x64/node.exe"

if ((Test-Path $NodeExe) -and (-not $Force)) {
    $existing = & $NodeExe --version 2>$null
    Write-Host "    已存在，跳过（当前 $existing）。使用 -Force 可强制重新下载。" -ForegroundColor DarkGray
}
else {
    Write-Host "    来源: $NodeUrl"
    Invoke-WebRequest -Uri $NodeUrl -OutFile $NodeExe -UseBasicParsing -TimeoutSec 600

    $nodeMb = [math]::Round((Get-Item $NodeExe).Length / 1MB, 1)
    Write-Host "    已下载 node.exe ($nodeMb MB)" -ForegroundColor Green
}

$nodeVersionOutput = & $NodeExe --version
Write-Host "    验证: node $nodeVersionOutput"

# --- 3. 确认 crawler 依赖与构建产物 ---
Write-Step "3/4" "检查 crawler 依赖与构建产物"

$CrawlerEntry = Join-Path $CrawlerDir "dist\index.js"
$CrawlerModules = Join-Path $CrawlerDir "node_modules"

if (-not (Test-Path $CrawlerModules)) {
    Write-Host "    缺少 crawler\node_modules，正在安装…" -ForegroundColor Yellow
    Push-Location $CrawlerDir
    try {
        & npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
    }
    finally { Pop-Location }
}
else {
    Write-Host "    已存在: crawler\node_modules"
}

if (-not (Test-Path $CrawlerEntry)) {
    Write-Host "    缺少构建产物，正在构建…" -ForegroundColor Yellow
    Push-Location $CrawlerDir
    try {
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "crawler 构建失败" }
    }
    finally { Pop-Location }
}
else {
    Write-Host "    已存在: crawler\dist\index.js"
}

# --- 4. 下载 Playwright Chromium ---
Write-Step "4/4" "下载 Playwright Chromium"

if ($SkipBrowsers) {
    Write-Host "    已指定 -SkipBrowsers，跳过。" -ForegroundColor DarkGray
}
else {
    if (-not (Test-Path $BrowserManifest)) {
        throw "未找到 $BrowserManifest，请先在 crawler 目录运行 npm install"
    }

    # 与 Rust 侧下发的 PLAYWRIGHT_BROWSERS_PATH 保持一致
    $env:PLAYWRIGHT_BROWSERS_PATH = $BrowserDir
    # Playwright 内置下载器的连接超时默认仅 30 秒，对约 200 MB 的包过短
    $env:PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT = "300000"

    # 用 cmd /c 调用：PowerShell 5.1 在 $ErrorActionPreference = "Stop" 下会把
    # 原生命令输出到 stderr 的内容当作终止性错误，而 npm 的告警恰好走 stderr。
    $installerLog = Join-Path $env:TEMP "websribe-playwright-install.log"

    Push-Location $CrawlerDir
    try {
        cmd /c "npx playwright install chromium > `"$installerLog`" 2>&1"
        $installerExit = $LASTEXITCODE
    }
    finally { Pop-Location }

    if ($installerExit -eq 0) {
        Write-Host "    Playwright 官方安装器成功。" -ForegroundColor Green
    }
    else {
        Write-Host "    Playwright 官方安装器失败，改用手动下载。" -ForegroundColor Yellow
        Write-Host "    （安装器日志: $installerLog）" -ForegroundColor DarkGray
    }

    # 无论走哪条路径，都以「目录 + 标记文件」是否齐备为准
    $targets = @(
        @{ Name = "chromium";                Folder = "chromium-{0}";                Zip = "win64/chrome-win64.zip" },
        @{ Name = "chromium-headless-shell"; Folder = "chromium_headless_shell-{0}"; Zip = "win64/chrome-headless-shell-win64.zip" }
    )

    foreach ($target in $targets) {
        $entry = Get-BrowserManifestEntry -Name $target.Name
        if (-not $entry) {
            Write-Host "    跳过未知浏览器 $($target.Name)" -ForegroundColor DarkGray
            continue
        }

        $folderName = $target.Folder -f $entry.revision
        $targetDir = Join-Path $BrowserDir $folderName
        $marker = Join-Path $targetDir "INSTALLATION_COMPLETE"

        if ((Test-Path $marker) -and (-not $Force)) {
            Write-Host "    已安装: $folderName" -ForegroundColor DarkGray
            continue
        }

        $url = "$CdnBase/$($entry.browserVersion)/$($target.Zip)"
        $ok = Install-BrowserManually -Name $target.Name -Url $url -TargetDir $targetDir

        if (-not $ok) {
            throw "无法获取 $($target.Name)。请检查网络后重试，或使用 -SkipBrowsers 仅安装 Node 运行时。"
        }
    }
}

# --- 汇总 ---
Write-Host ""
Write-Host "运行时获取完成。" -ForegroundColor Green

$runtimeFiles = Get-ChildItem -Path $RuntimeDir -Recurse -File -ErrorAction SilentlyContinue
$totalMb = [math]::Round((($runtimeFiles | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)
Write-Host "runtime\ 总大小: $totalMb MB"

$chromiumDirs = Get-ChildItem -Path $BrowserDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "chromium*" }
if ($chromiumDirs) {
    Write-Host "已安装浏览器:"
    foreach ($dir in $chromiumDirs) { Write-Host "  $($dir.Name)" }
}

Write-Host ""
Write-Host "下一步: npm run tauri dev"
