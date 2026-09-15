<#
.SYNOPSIS
    准备 Tauri 打包所需的 NSIS 运行时。

.DESCRIPTION
    Tauri 在生成 NSIS 安装包时，会从 GitHub Releases 下载它自带的 NSIS 3.11
    与专属插件 nsis_tauri_utils.dll 到 %LOCALAPPDATA%\tauri\NSIS。

    在部分网络环境下 github.com 的 Release 下载不可达（实测直接超时），
    导致打包在「Downloading nsis-3.11.zip」处失败。本脚本通过 GitHub 加速
    镜像预先下载并校验哈希，再按 Tauri 期望的目录布局放置，从而绕过该问题。

    两个文件的 SHA-1 均与 Tauri 源码中内置的期望值比对，不匹配则中止。

.PARAMETER GithubProxy
    GitHub 加速前缀，默认 https://gh-proxy.com/。若不可用会自动尝试备选。

.PARAMETER Force
    已存在时强制重新下载。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/fetch-nsis.ps1
#>
[CmdletBinding()]
param(
    [string]$GithubProxy = "https://gh-proxy.com/",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Tauri 内置的期望值与下载地址（取自 @tauri-apps/cli 二进制）
$NsisUrl = "https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip"
$NsisSha1 = "EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D"

$PluginUrl = "https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll"
$PluginSha1 = "75197FEE3C6A814FE035788D1C34EAD39348B860"

$NsisDir = Join-Path $env:LOCALAPPDATA "tauri\NSIS"
$PluginDir = Join-Path $NsisDir "Plugins\x86-unicode\additional"

$Proxies = @($GithubProxy, "https://ghfast.top/", "https://ghproxy.net/") | Select-Object -Unique

function Write-Step {
    param([string]$Number, [string]$Text)
    Write-Host ""
    Write-Host "==> [$Number] $Text" -ForegroundColor Cyan
}

<# 依次尝试各加速前缀，返回首个成功的临时文件路径。 #>
function Get-RemoteFile {
    param(
        [string]$Url,
        [string]$Sha1,
        [string]$Label
    )

    $tempFile = Join-Path $env:TEMP ([System.IO.Path]::GetFileName($Url))

    foreach ($prefix in $Proxies) {
        $target = if ($prefix) { "$prefix$Url" } else { $Url }
        Write-Host "    尝试: $($prefix -replace '/$','')" -ForegroundColor DarkGray

        try {
            Invoke-WebRequest -Uri $target -OutFile $tempFile -UseBasicParsing -TimeoutSec 180
        }
        catch {
            Write-Host "      失败: $($_.Exception.Message)" -ForegroundColor DarkGray
            continue
        }

        $actual = (Get-FileHash -Path $tempFile -Algorithm SHA1).Hash
        if ($actual -eq $Sha1) {
            Write-Host "      成功，SHA-1 校验通过" -ForegroundColor Green
            return $tempFile
        }

        Write-Host "      哈希不匹配（得到 $actual），放弃该镜像" -ForegroundColor Yellow
    }

    throw "无法获取 $Label —— 所有镜像均失败或哈希不匹配。"
}

Write-Host "Tauri NSIS 运行时准备" -ForegroundColor White
Write-Host "  目标目录: $NsisDir"

# --- 1. NSIS 本体 ---
Write-Step "1/2" "准备 NSIS 3.11"

$makensis = Join-Path $NsisDir "makensis.exe"

if ((Test-Path $makensis) -and (-not $Force)) {
    Write-Host "    已存在，跳过。使用 -Force 可强制重新下载。" -ForegroundColor DarkGray
}
else {
    $zip = Get-RemoteFile -Url $NsisUrl -Sha1 $NsisSha1 -Label "NSIS 3.11"

    if (Test-Path $NsisDir) { Remove-Item -Recurse -Force $NsisDir }
    New-Item -ItemType Directory -Force -Path $NsisDir | Out-Null

    $tempExtract = Join-Path $env:TEMP "websribe-nsis-extract"
    if (Test-Path $tempExtract) { Remove-Item -Recurse -Force $tempExtract }
    Expand-Archive -Path $zip -DestinationPath $tempExtract -Force

    # Tauri 期望 NSIS 目录下直接是 makensis.exe / Bin / Stubs / Plugins，
    # 因此要剥掉 zip 内的顶层目录 nsis-3.11\
    $inner = Get-ChildItem -Path $tempExtract -Directory | Select-Object -First 1
    $source = if ($inner) { $inner.FullName } else { $tempExtract }

    Get-ChildItem -Path $source | ForEach-Object {
        Move-Item -Path $_.FullName -Destination $NsisDir -Force
    }

    Remove-Item -Recurse -Force $tempExtract
    Remove-Item -Force $zip -ErrorAction SilentlyContinue

    Write-Host "    已解压 NSIS 3.11" -ForegroundColor Green
}

# --- 2. Tauri 专属插件 ---
Write-Step "2/2" "准备 nsis_tauri_utils 插件"

$pluginPath = Join-Path $PluginDir "nsis_tauri_utils.dll"

if ((Test-Path $pluginPath) -and (-not $Force)) {
    Write-Host "    已存在，跳过。" -ForegroundColor DarkGray
}
else {
    $dll = Get-RemoteFile -Url $PluginUrl -Sha1 $PluginSha1 -Label "nsis_tauri_utils.dll"

    New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null
    Copy-Item -Path $dll -Destination $pluginPath -Force
    Remove-Item -Force $dll -ErrorAction SilentlyContinue

    Write-Host "    已放置 nsis_tauri_utils.dll" -ForegroundColor Green
}

# --- 校验 ---
Write-Host ""
$required = @(
    (Join-Path $NsisDir "makensis.exe"),
    (Join-Path $NsisDir "Bin\makensis.exe"),
    (Join-Path $NsisDir "Stubs\lzma-x86-unicode"),
    (Join-Path $NsisDir "Stubs\lzma_solid-x86-unicode"),
    (Join-Path $NsisDir "Include\MUI2.nsh"),
    $pluginPath
)

$missing = $required | Where-Object { -not (Test-Path $_) }
if ($missing) {
    Write-Host "缺少必要文件:" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "  $_" }
    throw "NSIS 运行时准备不完整"
}

Write-Host "NSIS 运行时已就绪。" -ForegroundColor Green
Write-Host "下一步: powershell -ExecutionPolicy Bypass -File scripts/build-app.ps1"
