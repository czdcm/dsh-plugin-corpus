param(
  [Parameter(Mandatory = $true)][string]$Path,
  [int]$Size = 256,
  [Parameter(Mandatory = $true)][string]$OutFile
)

# dsh-plugin-corpus 内置缩略图：调用 Windows Shell/Storage 缩略图提供程序，
# 对图片、PDF、Office 等所有文件类型尽量给出资源管理器式缩略图。
# 输出一行 JSON: {"ok":true,"file":"...","contentType":"...","width":...,"height":...}
# 没有缩略图时退出码 2，调用方回退到类型图标。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileProperties.ThumbnailMode, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileProperties.ThumbnailOptions, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileProperties.StorageItemThumbnail, Windows.Storage, ContentType = WindowsRuntime]

$asTaskMethods = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asTaskGeneric = ($asTaskMethods | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
if ($asTaskGeneric -eq $null) { throw 'Windows Runtime async helper unavailable' }

function Await($operation, [Type]$resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "file not found: $Path" }
$sizeValue = [Math]::Max(32, [Math]::Min(1024, $Size))
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$thumb = Await ($file.GetThumbnailAsync(
    [Windows.Storage.FileProperties.ThumbnailMode]::SingleItem,
    [uint32]$sizeValue,
    [Windows.Storage.FileProperties.ThumbnailOptions]::UseCurrentScale
  )) ([Windows.Storage.FileProperties.StorageItemThumbnail])
if ($thumb -eq $null) { exit 2 }
try {
  $inStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($thumb)
  $outStream = [System.IO.File]::Create($OutFile)
  try { $inStream.CopyTo($outStream) } finally { $outStream.Dispose() }
  $inStream.Dispose()
  $result = [ordered]@{
    ok = $true
    file = $OutFile
    contentType = [string]$thumb.ContentType
    width = [int]$thumb.OriginalWidth
    height = [int]$thumb.OriginalHeight
  }
  Write-Output ($result | ConvertTo-Json -Compress)
} finally {
  $thumb.Dispose()
}
exit 0
