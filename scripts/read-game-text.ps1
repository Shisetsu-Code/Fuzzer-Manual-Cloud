param([Parameter(Mandatory=$true)][string]$ImagePath)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$taskMethod=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
function Await-Result($Operation,$ResultType){
  $task=$taskMethod.MakeGenericMethod($ResultType).Invoke($null,@($Operation))
  $task.GetAwaiter().GetResult()
}
$file=Await-Result ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream=Await-Result ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder=Await-Result ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap=Await-Result ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$converted=[Windows.Graphics.Imaging.SoftwareBitmap]::Convert($bitmap,[Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,[Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)
$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (!$engine) { throw 'No local OCR language available' }
$result=Await-Result ($engine.RecognizeAsync($converted)) ([Windows.Media.Ocr.OcrResult])
$lines=@(foreach($line in $result.Lines){
  $left=1.0;$top=1.0;$right=0.0;$bottom=0.0
  foreach($word in $line.Words){
    $box=$word.BoundingRect
    $left=[Math]::Min($left,$box.X/$converted.PixelWidth);$top=[Math]::Min($top,$box.Y/$converted.PixelHeight)
    $right=[Math]::Max($right,($box.X+$box.Width)/$converted.PixelWidth);$bottom=[Math]::Max($bottom,($box.Y+$box.Height)/$converted.PixelHeight)
  }
  @{text=$line.Text;x=$left;y=$top;w=$right-$left;h=$bottom-$top}
})
@{lines=$lines} | ConvertTo-Json -Compress -Depth 5
$converted.Dispose();$bitmap.Dispose();$stream.Dispose()
