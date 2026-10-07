<#
ホットキー（Ctrl+Alt+M など）から呼ばれる、ミュートの切り替え。setup が <ホーム>\bin\ にコピーする。
mod（/voice-notify on・off）と同じく、state\mute があればミュート。止める前と再開した後に知らせる。
#>
$VHome = "$env:VOICE_NOTIFY_HOME".Trim().TrimEnd('\', '/')
if (-not $VHome) { $VHome = Join-Path $env:USERPROFILE ".claude\voice-notify" }
$MuteFile = Join-Path $VHome "state\mute"
$speaker = "metan"
try {
  $c = Get-Content (Join-Path $VHome "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($c.speaker) { $speaker = $c.speaker }
} catch { }

function Play([string]$Name) {
  $f = @(Get-ChildItem (Join-Path $VHome "phrases\$speaker\$Name") -Filter *.wav -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($f.Count) { & (Join-Path $PSScriptRoot "play.ps1") -Path $f[0].FullName }
}

if (Test-Path -LiteralPath $MuteFile) {
  Remove-Item -LiteralPath $MuteFile -Force -ErrorAction SilentlyContinue
  Play "unmute"
  $msg = "手動ミュートを解除（ホットキー）"
} else {
  Play "mute"
  New-Item -ItemType Directory (Split-Path $MuteFile) -Force | Out-Null
  Set-Content -LiteralPath $MuteFile -Value (Get-Date -Format o) -Encoding UTF8
  $msg = "手動ミュート（ホットキー）"
}
try {
  ("{0}  INFO voice       {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg) | Add-Content -LiteralPath (Join-Path $VHome "notify.log") -Encoding UTF8
} catch { }
