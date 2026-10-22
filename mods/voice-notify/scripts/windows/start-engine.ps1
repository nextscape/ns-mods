<#
Starts the VOICEVOX ENGINE when it is not running.
  At logon: the task runs <home>\bin\start-engine.ps1 -Quiet; where the ENGINE is comes from engine-path.txt beside it (setup writes it)
  In setup: the mod runs it with -EnginePath <run.exe>
It does nothing when the ENGINE already answers, so it may run any number of times. It starts vv-engine\run.exe, not the GUI (less memory held).
#>
param([string]$EnginePath = "", [switch]$Quiet)

# At logon it runs from the home's bin\, so bin's parent is the home (surer than the environment). In setup it runs from the plugin, and the environment decides
$VHome = Split-Path -Parent $PSScriptRoot
if ((Split-Path -Leaf $PSScriptRoot) -ne "bin" -or -not (Test-Path -LiteralPath (Join-Path $VHome "config.json"))) {
  $VHome = "$env:VOICE_NOTIFY_HOME".Trim().TrimEnd('\', '/')
  if (-not $VHome) { $VHome = Join-Path $env:USERPROFILE ".claude\voice-notify" }
}
$Port = 50021
try {
  $c = Get-Content (Join-Path $VHome "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($c.enginePort) { $Port = $c.enginePort }
} catch { }
$Log = Join-Path $VHome "notify.log"

function Say([string]$Level, [string]$Msg) {
  try { ("{0}  {1,-4} engine      {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Msg) | Add-Content -LiteralPath $Log -Encoding UTF8 } catch { }
  if (-not $Quiet) { Write-Output $Msg }
}

function Test-Engine {
  try { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/version" -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}

if (Test-Engine) { exit 0 }
if (-not $EnginePath) {
  $hint = Join-Path $PSScriptRoot "engine-path.txt"
  if (Test-Path -LiteralPath $hint) { $EnginePath = "$(Get-Content -LiteralPath $hint -Raw -Encoding UTF8)".Trim() }
}
if (-not $EnginePath -or -not (Test-Path -LiteralPath $EnginePath)) {
  Say "ERR" "ENGINE の場所が分からない。/voice-notify setup をもう一度実行する"
  exit 1
}

Say "INFO" "ENGINE を起動する: $EnginePath"
Start-Process -FilePath $EnginePath -WorkingDirectory (Split-Path -Parent $EnginePath) -WindowStyle Hidden
# The first start loads the models, which takes some ten seconds
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Engine) { Say "INFO" ("ENGINE 起動完了 ({0}秒)" -f ($i + 1)); exit 0 }
}
Say "ERR" "60秒待っても ENGINE が応答しない"
exit 1
