# 把项目里的 plugin/ 部署到本机 DSH 插件目录，并检查 profile 注册。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy.ps1
# 注意：宿主半部只在 DSH 启动时加载；部署完成后必须重启 DeepSeek Harness。
$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 的 Get-Content 默认按 ANSI 读；我们的 JSON 是 UTF-8 无 BOM，
# 必须显式用 UTF-8 读，否则含中文的 description 会把 ConvertFrom-Json 弄坏。
function Read-JsonFile([string]$Path) {
  $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
  return $text | ConvertFrom-Json
}

$Project = Split-Path -Parent $PSScriptRoot
$PluginSource = Join-Path $Project 'plugin'
$DshHome = if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne '') { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$Target = Join-Path $DshHome 'plugins\dsh-plugin-corpus'
$ProfileDir = Join-Path $DshHome 'profiles\desktop'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupRoot = Join-Path $DshHome "backups\corpus-plugin-$Stamp"

Write-Host "DSH_HOME : $DshHome"
Write-Host "源       : $PluginSource"
Write-Host "目标     : $Target"

foreach ($item in @('lib', 'vendor', 'cordis.patch.yml', 'package.json', 'README.md')) {
  $src = Join-Path $PluginSource $item
  if (-not (Test-Path $src)) { throw "部署包缺少 $src" }
}

$hasOfficecli = Test-Path (Join-Path $PluginSource 'vendor\officecli\officecli.exe')
$hasPdftotext = Test-Path (Join-Path $PluginSource 'vendor\pdftotext\pdftotext.exe')
if (-not $hasOfficecli -or -not $hasPdftotext) {
  Write-Warning 'plugin/vendor 缺少第三方二进制（OfficeCLI / pdftotext）：Office 会回退纯 JS，PDF 文字层不可提取（只能整本 OCR；非 Windows 将无法导入 PDF）。'
  Write-Warning 'GitHub 源码仓库不含这些二进制；完整安装请使用 Release 里的完整 zip，或先把 vendor 文件放回本机。'
}

if (Test-Path $Target) {
  New-Item -ItemType Directory -Path (Split-Path $BackupRoot -Parent) -Force | Out-Null
  Copy-Item $Target $BackupRoot -Recurse -Force
  Write-Host "已备份旧版本: $BackupRoot"
} else {
  New-Item -ItemType Directory -Path $Target -Force | Out-Null
}

foreach ($item in @('lib', 'vendor', 'cordis.patch.yml', 'package.json', 'README.md')) {
  $src = Join-Path $PluginSource $item
  $dst = Join-Path $Target $item
  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
  Copy-Item $src $dst -Recurse -Force
  Write-Host "  copied $item"
}

# 校验 profile 的两处注册（缺一插件不会激活）
$profileJsonPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path $profileJsonPath)) { throw "找不到 profile：$profileJsonPath" }
$profileJson = Read-JsonFile $profileJsonPath
$hasDep = $null -ne $profileJson.dependencies.'dsh-plugin-corpus'
$hasBundle = @($profileJson.dsh.profile.bundles) -contains 'dsh-plugin-corpus'
if (-not $hasDep) { Write-Warning 'profile dependencies 里没有 dsh-plugin-corpus（link 依赖缺失）' }
if (-not $hasBundle) { Write-Warning 'profile dsh.profile.bundles 里没有 dsh-plugin-corpus（插件不会激活）' }
$linkPath = Join-Path $ProfileDir 'node_modules\dsh-plugin-corpus'
Write-Host ("profile 依赖: {0}；bundles: {1}；link: {2}" -f $hasDep, $hasBundle, (Test-Path $linkPath))

$package = Read-JsonFile (Join-Path $Target 'package.json')
Write-Host ("已部署 dsh-plugin-corpus@{0}" -f $package.version)
Write-Host ''
Write-Host '下一步：重启 DeepSeek Harness（宿主半部只在进程启动时加载），然后在左侧栏点「语料库」。'
