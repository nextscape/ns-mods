<#
VOICEVOX ENGINE を必要なときだけ起動する。
  ログオン時: タスクが <ホーム>\bin\start-engine.ps1 -Quiet を呼ぶ。ENGINE の場所は同じフォルダの engine-path.txt（setup が書く）
  setup の中: mod が -EnginePath <run.exe> を付けて呼ぶ
すでに応答していれば何もしないので、何度実行してもよい。GUI ではなく vv-engine\run.exe を直接起動する（常駐メモリが小さい）。
#>
param([string]$EnginePath = "", [switch]$Quiet)

$VHome = "$env:VOICE_NOTIFY_HOME".Trim().TrimEnd('\', '/')
if (-not $VHome) { $VHome = Join-Path $env:USERPROFILE ".claude\voice-notify" }
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
# 初回はモデル読み込みで十数秒かかる
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Engine) { Say "INFO" ("ENGINE 起動完了 ({0}秒)" -f ($i + 1)); exit 0 }
}
Say "ERR" "60秒待っても ENGINE が応答しない"
exit 1
