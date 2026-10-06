<#
ホーム（設定と状態の置き場所）の検証。初期設定の前（ホームが空）に hook が動いても止まらず、
同梱の config.default.json をコピーすること。利用者が書き換えた config.json は上書きしないこと。

  .\test-home.ps1

ホームは一時フォルダ（VOICE_NOTIFY_HOME）。利用者の ~/.claude/voice-notify には触れない。
#>
$Here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$Notify   = Join-Path (Split-Path -Parent $Here) "scripts\notify.ps1"
$TestHome = Join-Path $env:TEMP ("voice-notify-test-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$env:VOICE_NOTIFY_HOME = $TestHome
$RealHome = Join-Path $env:USERPROFILE ".claude\voice-notify"
$RealBefore = Test-Path $RealHome
$OutputEncoding = New-Object Text.UTF8Encoding $false

$total = 0; $ng = 0
function CheckTrue([string]$name, [bool]$cond) {
  $script:total++
  if ($cond) { "ok  $name" } else { "NG  $name"; $script:ng++ }
}

try {
  # 空のホームで stop（初期設定の前に hook が動いた状態）
  '{"session_id":"selftest-home","last_assistant_message":"確認です。"}' |
    powershell -NoProfile -ExecutionPolicy Bypass -File $Notify -Event stop -DryRun | Out-Null
  CheckTrue "空のホームでも notify.ps1 が正常終了する" ($LASTEXITCODE -eq 0)
  CheckTrue "config.json を既定からコピーする" (Test-Path (Join-Path $TestHome "config.json"))
  CheckTrue "ログはホームに書く" (Test-Path (Join-Path $TestHome "notify.log"))

  # 利用者が書き換えた config.json は上書きしない
  $cfg = Join-Path $TestHome "config.json"
  $j = Get-Content $cfg -Raw -Encoding UTF8 | ConvertFrom-Json
  $j.speedScale = 1.77
  [IO.File]::WriteAllText($cfg, ($j | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding $false))
  '{"session_id":"selftest-home"}' |
    powershell -NoProfile -ExecutionPolicy Bypass -File $Notify -Event status | Out-Null
  CheckTrue "書き換えた config.json を上書きしない" ((Get-Content $cfg -Raw -Encoding UTF8 | ConvertFrom-Json).speedScale -eq 1.77)

  # 末尾の区切りは落とす（mod の voiceHome と同じ。ログの相対表示がずれない）
  $lib = Get-Content (Join-Path (Split-Path -Parent $Here) "scripts\lib.ps1") -Raw -Encoding UTF8
  . ([scriptblock]::Create([regex]::Match($lib, '(?s)function Get-VoiceHome\b.*?\n\}').Value))
  $env:VOICE_NOTIFY_HOME = "  $TestHome\ "
  CheckTrue "VOICE_NOTIFY_HOME の前後の空白と末尾の \ を落とす" ((Get-VoiceHome) -eq $TestHome)
  $env:VOICE_NOTIFY_HOME = $TestHome

  # 初回（config.json が無い）に hook が同時に動いても、書きかけの config.json を読んで落ちない
  Remove-Item -LiteralPath $TestHome -Recurse -Force
  $procs = @(1..5 | ForEach-Object {
    Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList `
      ("-NoProfile -ExecutionPolicy Bypass -File `"{0}`" -Event status" -f $Notify)
  })
  $procs | ForEach-Object { $_.WaitForExit(60000) | Out-Null }
  CheckTrue "同時に5つ起動しても全部が正常終了する" (@($procs | Where-Object { $_.ExitCode -ne 0 }).Count -eq 0)
  $ok = $true; try { Get-Content (Join-Path $TestHome "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json | Out-Null } catch { $ok = $false }
  CheckTrue "コピーされた config.json は壊れていない" $ok
  CheckTrue "コピーの途中のファイルを残さない" (@(Get-ChildItem $TestHome -Filter "config.json*" -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne "config.json" }).Count -eq 0)

  CheckTrue "利用者のホームに触れない" ((Test-Path $RealHome) -eq $RealBefore)
}
catch { $ng++; "NG  例外で中断: {0}" -f $_.Exception.Message }
finally {
  if ($TestHome -like "*voice-notify-test-*") { Remove-Item -LiteralPath $TestHome -Recurse -Force -ErrorAction SilentlyContinue }
}

""
if ($ng -eq 0) { "全 {0} 件 合格" -f $total } else { "全 {0} 件中 {1} 件 不合格" -f $total, $ng; exit 1 }
