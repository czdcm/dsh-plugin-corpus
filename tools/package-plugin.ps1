# 打包可直接安装的 DSH 插件。
# 只产出完整包：包含 OfficeCLI（Apache-2.0）与 pdftotext（GPL-2.0-or-later）及其许可证/源码说明。
# v1.5.0 起移除了纯 JS PDF 解析兜底，PDF 文字层依赖随包 pdftotext，因此不再提供 -WithoutPdftotext 构建。
# 产物结构：dsh-plugin-corpus/{package.json,cordis.patch.yml,LICENSE,THIRD_PARTY_NOTICES.md,lib/,vendor/,README.md}
# 默认输出到项目根目录的 releases/v<版本>/（项目根 = repo/ 的上一级）。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\package-plugin.ps1 [-Out <zip>]
param(
  [string]$Out = ''
)
$ErrorActionPreference = 'Stop'

$Project = Split-Path -Parent $PSScriptRoot
$PluginDir = Join-Path $Project 'plugin'
if (-not (Test-Path $PluginDir)) { throw "找不到 plugin 目录：$PluginDir" }
$packageJson = Get-Content (Join-Path $PluginDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$packageJson.version
$suffix = '-plugin.zip'
if ($Out -eq '') {
  $ReleaseDir = Join-Path (Split-Path -Parent $Project) ("releases\v{0}" -f $version)
  New-Item -ItemType Directory -Path $ReleaseDir -Force | Out-Null
  $Out = Join-Path $ReleaseDir ("dsh-plugin-corpus-v{0}{1}" -f $version, $suffix)
}
if (Test-Path $Out) { Remove-Item $Out -Force }

$Staging = Join-Path $env:TEMP ('corpus-plugin-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$Root = Join-Path $Staging 'dsh-plugin-corpus'
New-Item -ItemType Directory -Path $Root -Force | Out-Null
try {
  Copy-Item (Join-Path $PluginDir 'package.json') $Root
  Copy-Item (Join-Path $PluginDir 'cordis.patch.yml') $Root
  Copy-Item (Join-Path $PluginDir 'README.md') $Root
  Copy-Item (Join-Path $PluginDir 'lib') (Join-Path $Root 'lib') -Recurse
  Copy-Item (Join-Path $PluginDir 'vendor') (Join-Path $Root 'vendor') -Recurse
  foreach ($doc in @('LICENSE', 'THIRD_PARTY_NOTICES.md', 'INSTALL.md')) {
    $source = Join-Path $Project $doc
    if (Test-Path $source) { Copy-Item $source $Root }
  }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory($Staging, $Out, [System.IO.Compression.CompressionLevel]::Optimal, $false)
  $zip = [System.IO.Compression.ZipFile]::OpenRead($Out)
  try {
    $count = $zip.Entries.Count
    $hasPackage = $false
    $hasOffice = $false
    $hasPdfText = $false
    $hasLicense = $false
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName -replace '\\', '/'
      if ($name -eq 'dsh-plugin-corpus/package.json') { $hasPackage = $true }
      if ($name -eq 'dsh-plugin-corpus/vendor/officecli/officecli.exe') { $hasOffice = $true }
      if ($name -match '^dsh-plugin-corpus/vendor/pdftotext/.*\.(exe|dll)$') { $hasPdfText = $true }
      if ($name -eq 'dsh-plugin-corpus/LICENSE') { $hasLicense = $true }
    }
    if (-not $hasPackage) { throw 'zip 缺少 dsh-plugin-corpus/package.json' }
    if (-not $hasLicense) { throw 'zip 缺少 LICENSE' }
    if (-not $hasOffice) { throw 'zip 缺少 OfficeCLI（Apache-2.0）' }
    if (-not $hasPdfText) { throw 'zip 缺少 pdftotext 二进制（v1.5.0 起 PDF 文字层依赖它）' }
  } finally {
    $zip.Dispose()
  }
  $size = (Get-Item $Out).Length
  $mode = 'full（含 GPL pdftotext，附许可证/源码说明）'
  Write-Host ("已生成 {0}（{1:N1} MB，{2} 个条目，版本 {3}，{4}）" -f $Out, ($size / 1MB), $count, $version, $mode)
  Write-Host '结构：dsh-plugin-corpus/package.json + cordis.patch.yml + LICENSE + THIRD_PARTY_NOTICES.md + INSTALL.md + lib/ + vendor/ + README.md'
} finally {
  if (Test-Path $Staging) { Remove-Item $Staging -Recurse -Force }
}
