# 跑 dsh-plugin-corpus v1.2.0 的全部本地验收（不需要重启 DSH）。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\test-all.ps1
$ErrorActionPreference = 'Stop'

$Project = Split-Path -Parent $PSScriptRoot
$Node = $env:DSH_NODE
if (-not $Node) {
  $candidates = @()
  if ($env:LOCALAPPDATA) {
    $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe')
  }
  if ($env:ProgramFiles) {
    $candidates += (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe')
  }
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command) { $Node = $command.Source }
  foreach ($candidate in $candidates) {
    if ((-not $Node -or -not (Test-Path $Node)) -and (Test-Path $candidate)) { $Node = $candidate }
  }
}
if (-not $Node -or -not (Test-Path $Node)) {
  throw '找不到 Node 24。请设置 DSH_NODE 指向 node.exe，或把 node 加入 PATH。'
}
Set-Location $Project

Write-Host '== 语法检查 =='
Get-ChildItem (Join-Path $Project 'plugin\lib\*.js') | ForEach-Object {
  & $Node --check $_.FullName
  if ($LASTEXITCODE -ne 0) { throw "语法错误：$($_.FullName)" }
  Write-Host "  OK $($_.Name)"
}
& $Node -e "JSON.parse(require('fs').readFileSync('plugin/package.json','utf8'))"
if ($LASTEXITCODE -ne 0) { throw 'package.json 解析失败' }
Write-Host '  OK package.json'

Write-Host ''
Write-Host '== v1.0 基线（真实语料） =='
& $Node tests\test-corpus.mjs
if ($LASTEXITCODE -ne 0) { throw 'test-corpus.mjs 失败' }

Write-Host ''
Write-Host '== v1.1/v1.2/v1.3 验收（临时语料） =='
& $Node tests\test-corpus-v2.mjs
if ($LASTEXITCODE -ne 0) { throw 'test-corpus-v2.mjs 失败' }

Write-Host ''
Write-Host '== 策略/权限/18 路由 =='
& $Node tests\test-policy.mjs
if ($LASTEXITCODE -ne 0) { throw 'test-policy.mjs 失败' }

Write-Host ''
Write-Host '== v1.3 文档提取（HTML/Office/PDF/图片） =='
& $Node tests\test-extract.mjs
if ($LASTEXITCODE -ne 0) { throw 'test-extract.mjs 失败' }

Write-Host ''
Write-Host '== 公式识别与 LaTeX 规范化 =='
& $Node tests\test-formulas.mjs
if ($LASTEXITCODE -ne 0) { throw 'test-formulas.mjs 失败' }

Write-Host ''
Write-Host '== v1.3 导入任务与小代理回退（不再保存原件） =='
& $Node tests\test-ingest.mjs
if ($LASTEXITCODE -ne 0) { throw 'test-ingest.mjs 失败' }

Write-Host ''
Write-Host '== v1.4 仓库/内容结构化（corpus_structure） =='
& $Node tests\test-structure.mjs
if ($LASTEXITCODE -ne 0) { throw 'test-structure.mjs 失败' }

Write-Host ''
Write-Host '== v1.4 会话总结（corpus_summarize_session） =='
& $Node tests\test-session-transcript.mjs
if ($LASTEXITCODE -ne 0) { throw 'test-session-transcript.mjs 失败' }

Write-Host ''
Write-Host '== v1.5 根目录设置与迁移 =='
& $Node tests\test-settings.mjs
if ($LASTEXITCODE -ne 0) { throw 'test-settings.mjs 失败' }

Write-Host ''
Write-Host '== 语料文件列表 / 项目验收 =='
& $Node tests\test-gallery.mjs
if ($LASTEXITCODE -ne 0) { throw 'test-gallery.mjs 失败' }

Write-Host ''
Write-Host '== v1.7 删除语料（软删除/trash） =='
& $Node tests\test-trash.mjs
if ($LASTEXITCODE -ne 0) { throw 'test-trash.mjs 失败' }

Write-Host ''
Write-Host '== 文档目录索引（outline / 行号） =='
& $Node tests\test-outline.mjs
if ($LASTEXITCODE -ne 0) { throw 'test-outline.mjs 失败' }

Write-Host ''
Write-Host '== 插件入口集成（Cordis 桩，13 工具/18 路由） =='
& $Node tests\test-plugin-mount.mjs
if ($LASTEXITCODE -ne 0) { throw 'test-plugin-mount.mjs 失败' }

Write-Host ''
Write-Host '== 客户端 bundle 静态验证 =='
& $Node tests\test-client-bundle.mjs
if ($LASTEXITCODE -ne 0) { throw 'test-client-bundle.mjs 失败' }

Write-Host ''
Write-Host '全部本地验收通过。部署并重启 DSH 后：左侧栏「语料库」（含导入区/语料文件列表/删除回收站）、右栏「语料权限」，主会话可调用 corpus_catalog / corpus_outline / corpus_search / corpus_read / corpus_structure 等工具。'
