<#
voice-notify の再生（Windows）。mod（hooks/register.ts）が wav のパスを渡して呼ぶ。ホットキーの toggle.ps1 も使う。

別のセッションの再生と重なると聞き取れないので、名前付き Mutex で1つずつ鳴らす。
20秒待っても空かなければ、重ねて鳴らす（黙るよりよい）。
#>
param([Parameter(Mandatory = $true)][string]$Path)

$mx = $null
$held = $false
try { $mx = New-Object Threading.Mutex($false, "voice-notify-playback") } catch { }
if ($mx) {
  try { $held = $mx.WaitOne(20000) }
  catch [Threading.AbandonedMutexException] { $held = $true }   # 前の保持者が異常終了。所有権は得ている
  catch { $held = $false }
}
try {
  (New-Object System.Media.SoundPlayer $Path).PlaySync()
} finally {
  if ($held) { try { $mx.ReleaseMutex() } catch { } }
  if ($mx) { try { $mx.Dispose() } catch { } }
}
