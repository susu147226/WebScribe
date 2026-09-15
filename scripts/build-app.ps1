<#
.SYNOPSIS
    构建 WebScribe 的 Windows 发行版安装包。

.DESCRIPTION
    依次构建 crawler、前端与 Tauri 主程序，产出 NSIS 安装包并重命名为
    文档要求的 WebScribe-Setup-x64.exe，最终放入 artifacts\ 目录。

    运行前请确认已执行过 scripts/fetch-runtime.ps1 —— 安装包会内嵌
    runtime\ 与 crawler\，缺一不可。

.PARAMETER SkipChecks
    跳过运行时完整性检查（一般不建议使用）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/build-app.ps1
#>
[CmdletBinding()]
param(
    [switch]$SkipChecks
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$CrawlerDir = Join-Path $ProjectRoot "crawler"
$TauriDir = Join-Path $ProjectRoot "src-tauri"
$RuntimeDir = Join-Path $ProjectRoot "runtime"
$ArtifactsDir = Join-Path $ProjectRoot "artifacts"
$BundleDir = Join-Path $TauriDir "target\release\bundle\nsis"

function Write-Step {
    param([string]$Number, [string]$Text)
    Write-Host ""
    Write-Host "==> [$Number] $Text" -ForegroundColor Cyan
}

Write-Host "WebScribe 安装包构建" -ForegroundColor White
Write-Host "  项目根目录: $ProjectRoot"

# --- 1. 检查运行时与 NSIS ---
Write-Step "1/5" "检查随包运行时与 NSIS"

$tauriNsis = Join-Path $env:LOCALAPPDATA "tauri\NSIS\makensis.exe"
if (-not (Test-Path $tauriNsis)) {
    Write-Host "    Tauri 的 NSIS 运行时尚未准备，正在获取…" -ForegroundColor Yellow
    & (Join-Path $PSScriptRoot "fetch-nsis.ps1")
    if (-not (Test-Path $tauriNsis)) { throw "NSIS 运行时准备失败" }
}
else {
    Write-Host "    NSIS 运行时已就绪"
}

if (-not $SkipChecks) {
    $nodeExe = Join-Path $RuntimeDir "node\node.exe"
    if (-not (Test-Path $nodeExe)) {
        throw "缺少 runtime\node\node.exe。请先运行 scripts\fetch-runtime.ps1"
    }

    $chromiumDirs = Get-ChildItem -Path (Join-Path $RuntimeDir "browsers") -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "chromium*" }
    if (-not $chromiumDirs) {
        throw "缺少 Chromium 运行时。请先运行 scripts\fetch-runtime.ps1"
    }

    $runtimeMb = [math]::Round(
        ((Get-ChildItem -Path $RuntimeDir -Recurse -File | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)
    Write-Host "    runtime\ 已就绪 ($runtimeMb MB)"
    foreach ($dir in $chromiumDirs) { Write-Host "      浏览器: $($dir.Name)" }
}
else {
    Write-Host "    已跳过检查" -ForegroundColor DarkGray
}

# --- 2. 构建 crawler ---
Write-Step "2/5" "构建 crawler"

Push-Location $CrawlerDir
try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "crawler 构建失败" }
}
finally { Pop-Location }
Write-Host "    已生成 crawler\dist\index.js" -ForegroundColor Green

# --- 3. 构建 Tauri 发行版 ---
Write-Step "3/5" "构建 Tauri 发行版（含前端与安装包）"
Write-Host "    该步骤会编译 Rust 依赖树并打包约 890 MB 资源，耗时较长。"

Push-Location $ProjectRoot
try {
    & npm run tauri build
    if ($LASTEXITCODE -ne 0) { throw "Tauri 构建失败，退出码 $LASTEXITCODE" }
}
finally { Pop-Location }

# --- 4. 重命名安装包 ---
Write-Step "4/5" "整理安装包产物"

New-Item -ItemType Directory -Force -Path $ArtifactsDir | Out-Null

$installer = Get-ChildItem -Path $BundleDir -Filter "*-setup.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $installer) {
    throw "未在 $BundleDir 找到安装包。请检查 Tauri 构建日志。"
}

# 文档第 51 条要求产物名为 WebScribe-Setup-x64.exe
$targetName = "WebScribe-Setup-x64.exe"
$targetPath = Join-Path $ArtifactsDir $targetName

Copy-Item -Path $installer.FullName -Destination $targetPath -Force

$installerMb = [math]::Round((Get-Item $targetPath).Length / 1MB, 1)
Write-Host "    已产出 $targetName ($installerMb MB)" -ForegroundColor Green

# --- 5. 汇总 ---
Write-Step "5/5" "构建完成"

Write-Host ""
Write-Host "产物清单:" -ForegroundColor White
Get-ChildItem -Path $ArtifactsDir -File | ForEach-Object {
    $mb = [math]::Round($_.Length / 1MB, 1)
    Write-Host ("  {0,-34} {1,8} MB" -f $_.Name, $mb)
}

Write-Host ""
Write-Host "下一步: powershell -ExecutionPolicy Bypass -File scripts/build-portable.ps1"
