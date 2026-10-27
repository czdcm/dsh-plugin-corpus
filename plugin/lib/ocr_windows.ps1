param(
  [Parameter(Mandatory = $true)][string]$Path,
  [ValidateSet('image', 'pdf')][string]$Mode = 'image'
)

# dsh-plugin-corpus 内置 OCR（Windows 自带能力，无外部安装）：
#   image -> Windows.Media.Ocr 直接识别图片
#   pdf   -> Windows.Data.Pdf 逐页渲染，再用 Windows.Media.Ocr 识别
# 输出纯文本到 stdout；失败写 stderr 并以非 0 退出。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]

$asTaskMethods = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asTaskGeneric = ($asTaskMethods | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
$asTaskAction = ($asTaskMethods | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
  })[0]
if ($asTaskGeneric -eq $null -or $asTaskAction -eq $null) { throw 'Windows Runtime async helpers unavailable' }

function Await($operation, [Type]$resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

function AwaitAction($action) {
  $task = $asTaskAction.Invoke($null, @($action))
  $task.Wait(-1) | Out-Null
}

function Get-OcrEngine() {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($engine -eq $null) { throw 'Windows OCR engine unavailable (check installed language packs)' }
  return $engine
}

function Ocr-Bitmap($bitmap, $engine) {
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  return [string]$result.Text
}

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "file not found: $Path" }
$storageFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$engine = Get-OcrEngine

if ($Mode -eq 'image') {
  $stream = Await ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  Write-Output (Ocr-Bitmap $bitmap $engine)
  exit 0
}

$document = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($storageFile)) ([Windows.Data.Pdf.PdfDocument])
for ($index = 0; $index -lt $document.PageCount; $index++) {
  $page = $document.GetPage([uint32]$index)
  $memory = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  AwaitAction ($page.RenderToStreamAsync($memory))
  $memory.Seek(0)
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($memory)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $text = Ocr-Bitmap $bitmap $engine
  Write-Output ''
  Write-Output ("--- Page {0} ---" -f ($index + 1))
  Write-Output $text
  $page.Dispose()
}
exit 0
