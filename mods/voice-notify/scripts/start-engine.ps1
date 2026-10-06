<#
VOICEVOX ENGINE を必要なときだけ起動する。

ログオン時のタスクスケジューラから呼ばれる（setup.ps1 で登録）。
すでに応答していれば何もしないので、手で何度実行しても安全。
GUI (VOICEVOX.exe) ではなく vv-engine\run.exe を直接起動する。
読み上げに GUI は要らず、常駐メモリも小さい。
#>
param([switch]$Quiet)

$Scripts = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $Scripts "lib.ps1")
$VHome = Get-VoiceHome    # 設定とログはホーム
Initialize-VoiceHome $VHome (Split-Path -Parent $Scripts)
$Cfg  = Get-Content (Join-Path $VHome "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$Port = $Cfg.enginePort
$Log  = Join-Path $VHome "notify.log"

function Say([string]$msg) {
  try {
    ("{0}  INFO engine      {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg) |
      Add-Content -LiteralPath $Log -Encoding UTF8
  } catch { }
  if (-not $Quiet) { Write-Output $msg }
}

function Test-Engine {
  try { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/version" -TimeoutSec 2 | Out-Null; return $true }
  catch { return $false }
}

if (Test-Engine) { Say "ENGINE は起動済み (port $Port)"; exit 0 }

# 実行ファイルの場所。config.json の enginePath が最優先、なければ winget の導入先を探す。
$exe = $Cfg.enginePath
if (-not $exe -or -not (Test-Path $exe)) {
  $cands = @(
    "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\HiroshibaKazuyuki.VOICEVOX*\VOICEVOX\vv-engine\run.exe",
    "$env:LOCALAPPDATA\Programs\VOICEVOX\vv-engine\run.exe",
    "$env:ProgramFiles\VOICEVOX\vv-engine\run.exe"
  )
  $exe = $null
  foreach ($c in $cands) {
    $hit = @(Get-ChildItem -Path $c -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($hit.Count) { $exe = $hit[0].FullName; break }
  }
}
if (-not $exe) {
  Say "ERR  run.exe が見つからない。config.json の enginePath に絶対パスを書くこと"
  exit 1
}

Say "ENGINE を起動する: $exe"
Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) -WindowStyle Hidden

# 初回はモデル読み込みで十数秒かかる
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Engine) { Say ("ENGINE 起動完了 ({0}秒)" -f ($i + 1)); exit 0 }
}
Say "ERR  60秒待っても ENGINE が応答しない"
exit 1
