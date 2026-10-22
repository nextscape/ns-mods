<#
Plays a wav for voice-notify (Windows). The mod (hooks/speak.ts) calls it with the wav's path; the hotkey's toggle.ps1 uses it too.

Clips of two sessions at once cannot be made out, so a named Mutex plays them one at a time.
When it is not free after 20 seconds, the clip plays over the other (better than silence).
#>
param([Parameter(Mandatory = $true)][string]$Path)

$mx = $null
$held = $false
try { $mx = New-Object Threading.Mutex($false, "voice-notify-playback") } catch { }
if ($mx) {
  try { $held = $mx.WaitOne(20000) }
  catch [Threading.AbandonedMutexException] { $held = $true }   # The last holder died; the Mutex is ours now
  catch { $held = $false }
}
try {
  (New-Object System.Media.SoundPlayer $Path).PlaySync()
} finally {
  if ($held) { try { $mx.ReleaseMutex() } catch { } }
  if ($mx) { try { $mx.Dispose() } catch { } }
}
