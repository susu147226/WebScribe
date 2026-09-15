<#
.SYNOPSIS
    组装 WebScribe 的 Portable 绿色版。

.DESCRIPTION
    把编译好的 WebScribe.exe 与随包运行时（Node、Chromium、crawler）组装成
    一个免安装目录，并压缩为文档要求的 WebScribe-Portable-x64.zip。

    运行时直接从项目的 runtime\ 与 crawler\ 读取，而非依赖 Tauri 的资源复制
    结果，以保证产物结构确定、可复现。

    运行前需先执行 scripts/build-app.ps1 完成编译。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/build-portable.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $ProjectRoot "runtime"
$CrawlerDir = Join-Path $ProjectRoot "crawler"
$ArtifactsDir = Join-Path $ProjectRoot "artifacts"
$ReleaseExe = Join-Path $ProjectRoot "src-tauri\target\release\WebScribe.exe"
$StagingRoot = Join-Path $ArtifactsDir "portable-stage"
$StagingDir = Join-Path $StagingRoot "WebScribe"
$ZipPath = Join-Path $ArtifactsDir "WebScribe-Portable-x64.zip"

function Write-Step {
    param([string]$Number, [string]$Text)
    Write-Host ""
    Write-Host "==> [$Number] $Text" -ForegroundColor Cyan
}

Write-Host "WebScribe Portable 打包" -ForegroundColor White
Write-Host "  项目根目录: $ProjectRoot"

# --- 1. 检查输入 ---
Write-Step "1/4" "检查输入文件"

if (-not (Test-Path $ReleaseExe)) {
    throw "未找到 $ReleaseExe。请先运行 scripts\build-app.ps1"
}
Write-Host "    主程序: WebScribe.exe"

foreach ($required in @(
    (Join-Path $RuntimeDir "node\node.exe"),
    (Join-Path $CrawlerDir "dist\index.js"),
    (Join-Path $CrawlerDir "node_modules")
)) {
    if (-not (Test-Path $required)) {
        throw "缺少 $required。请先运行 scripts\fetch-runtime.ps1"
    }
}
Write-Host "    运行时: Node / Chromium / crawler 均已就绪"

# --- 2. 组装目录 ---
Write-Step "2/4" "组装 Portable 目录"

if (Test-Path $StagingRoot) { Remove-Item -Recurse -Force $StagingRoot }
New-Item -ItemType Directory -Force -Path $StagingDir | Out-Null

Copy-Item -Path $ReleaseExe -Destination $StagingDir -Force
Write-Host "    已复制 WebScribe.exe"

# runtime\：Node 与 Chromium
Copy-Item -Path $RuntimeDir -Destination (Join-Path $StagingDir "runtime") -Recurse -Force
Write-Host "    已复制 runtime\"

# crawler\：构建产物与生产依赖
$stagingCrawler = Join-Path $StagingDir "crawler"
New-Item -ItemType Directory -Force -Path $stagingCrawler | Out-Null
Copy-Item -Path (Join-Path $CrawlerDir "dist") -Destination $stagingCrawler -Recurse -Force
Copy-Item -Path (Join-Path $CrawlerDir "package.json") -Destination $stagingCrawler -Force
if (Test-Path (Join-Path $CrawlerDir "package-lock.json")) {
    Copy-Item -Path (Join-Path $CrawlerDir "package-lock.json") -Destination $stagingCrawler -Force
}
Write-Host "    已复制 crawler\dist"

# 先整体复制，再在**暂存副本**中剔除开发依赖。
# 注意：绝不可在源目录执行 npm prune —— 那会永久删除开发依赖，
# 导致后续无法运行 crawler 测试。
Copy-Item -Path (Join-Path $CrawlerDir "node_modules") -Destination (Join-Path $stagingCrawler "node_modules") -Recurse -Force

Push-Location $stagingCrawler
try {
    cmd /c "npm prune --omit=dev > `"$env:TEMP\websribe-prune.log`" 2>&1"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "    剔除开发依赖失败，将保留完整 node_modules" -ForegroundColor Yellow
    }
    else {
        Write-Host "    已剔除开发依赖（日志: $env:TEMP\websribe-prune.log）"
    }
}
finally { Pop-Location }

# 附一份纯文本说明，方便用户直接阅读
$readme = @"
WebScribe — 便携版
==================

使用方式
--------
双击 WebScribe.exe 即可启动，无需安装任何开发环境。

目录说明
--------
  WebScribe.exe    主程序
  runtime\node\    Node 运行时
  runtime\browsers\ Chromium（用于动态页面渲染与 PDF 生成）
  crawler\         抓取模块

运行要求
--------
Windows 10/11 x64，已安装 WebView2 运行时（Windows 11 已内置）。

用户数据位置
------------
登录态与临时文件保存在：
  %LOCALAPPDATA%\com.webscribe.app\

删除该目录即可清除全部用户数据。绿色版本体不写注册表。

许可证
------
本项目不适用 MIT License。作者尚未指定正式许可证。
"@
Set-Content -Path (Join-Path $StagingDir "README.txt") -Value $readme -Encoding UTF8
Write-Host "    已写入 README.txt"

$stagingMb = [math]::Round(
    ((Get-ChildItem -Path $StagingDir -Recurse -File | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)
Write-Host "    组装完成，未压缩体积 $stagingMb MB"

# --- 3. 压缩 ---
Write-Step "3/4" "压缩为 ZIP"

if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }

Compress-Archive -Path $StagingDir -DestinationPath $ZipPath -CompressionLevel Optimal
Write-Host "    已生成 WebScribe-Portable-x64.zip" -ForegroundColor Green

# --- 4. 收尾 ---
Write-Step "4/4" "清理与汇总"

Remove-Item -Recurse -Force $StagingRoot

Write-Host ""
Write-Host "产物清单:" -ForegroundColor White
Get-ChildItem -Path $ArtifactsDir -File | ForEach-Object {
    $mb = [math]::Round($_.Length / 1MB, 1)
    Write-Host ("  {0,-34} {1,8} MB" -f $_.Name, $mb)
}

Write-Host ""
Write-Host "验证方式: 解压 ZIP → 双击 WebScribe.exe → 应正常启动"
