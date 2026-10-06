<#
中間報告の声分けと idle 抑止の検証（notify.ps1 を -DryRun で実際に呼ぶ）。

  .\test-interim.ps1

音は鳴らさない。架空の session_id を使うので、動いている本物のセッションとは混ざらない。
合成は走るので VOICEVOX ENGINE が止まっていても判定は通る（読み上げ内容が変わるだけ）。
要約ファイル（mod が書く）は置かないので、要約は読まれず抜き出しの経路を通る。
#>
$Here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$Notify  = Join-Path $Here "notify.ps1"
$Log     = Join-Path $Here "notify.log"
$Sid     = "selftest-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
$Agent   = "selftest-agent-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
$Agent2  = "$Agent-long"
$Turn    = Join-Path $Here "state\turns\$Sid"
$MetaDir = Join-Path $env:TEMP "claude-voice-$Sid"   # 説明（description）を置く偽のトランスクリプト置き場
$OutputEncoding = New-Object Text.UTF8Encoding $false

# 1回呼んで、その呼び出しが残したログ（[DRY] 付き）だけを返す。
# 並行して動く本物の hook は [DRY] を付けないので混ざらない。
function Invoke-Notify([string]$ev, [hashtable]$body) {
  $before = 0
  if (Test-Path $Log) { $before = @(Get-Content $Log -Encoding UTF8).Count }
  $body.session_id = $Sid
  ($body | ConvertTo-Json -Compress) |
    powershell -NoProfile -ExecutionPolicy Bypass -File $Notify -Event $ev -DryRun | Out-Null
  $lines = @(Get-Content $Log -Encoding UTF8)
  if ($lines.Count -lt $before) { $before = 0 }   # ローテーションした
  (@($lines | Select-Object -Skip $before) -match '\[DRY\]') -join "`n"
}

# agentstop は直前の発話から debounceSeconds 以内だと黙る。検証の agentstop が続く・本物の
# 報告が直前に鳴った、のどちらでも落ちるので、呼ぶ前に記録を古くしておく。
function Reset-Debounce {
  $f = Join-Path $Here "state\last_spoken"
  if (Test-Path $f) { (Get-Item $f).LastWriteTime = (Get-Date).AddMinutes(-1) }
}

$total = 0
$ng = 0
$muted = $false
function Check([string]$name, [string]$log, [string[]]$expect, [string]$reject) {
  $script:total++
  if ($log -match '無音化:') { $script:muted = $true }
  $ok = -not ($reject -and $log -match $reject)
  foreach ($e in $expect) { if ($log -notmatch $e) { $ok = $false } }
  $mark = "ok  "
  if (-not $ok) { $mark = "NG  "; $script:ng++ }
  "{0}{1}" -f $mark, $name
  if (-not $ok) { ($log -split "`n") | ForEach-Object { "      $_" } }
}

try {
  New-Item -ItemType Directory $MetaDir -Force | Out-Null

  # メインが作業中（promptsubmit のあと、stop の前）
  Invoke-Notify "promptsubmit" @{} | Out-Null
  Check "作業中の idle は黙る" (Invoke-Notify "idle" @{}) 'メインが作業中のため無音'

  # サブエージェントを起動したまま応答を終える → 中間
  Invoke-Notify "agentstart" @{ agent_id = $Agent } | Out-Null
  Check "実行中ありの短いターンは中間の短い前置き（ずんだもん）" `
    (Invoke-Notify "stop" @{ last_assistant_message = "実装担当が作業を進めています。" }) `
    @('ケース done→interim \(brief\) / 中間・実行中1件 \[zundamon\]', 'phrases\\zundamon\\stop\\brief\\interim\\')
  Check "サブエージェント待ちの idle は黙る" (Invoke-Notify "idle" @{}) 'サブエージェント実行中 \(1件\) のため無音'

  # 長いターン（開始を60秒前にずらす）→ 中間の前置き＋本文
  Set-Content -LiteralPath $Turn -Value (Get-Date).AddSeconds(-60).ToString("o") -Encoding UTF8
  Check "実行中ありの長いターンは中間の前置きのあと本文を読む" `
    (Invoke-Notify "stop" @{ last_assistant_message = "レビュー担当が確認しています。" }) `
    @('ケース done→interim / 中間', 'phrases\\zundamon\\stop\\interim\\', '読み上げ: レビュー担当が確認しています。')

  # 本文が取れない → 続きを読まないので短い前置き
  Check "実行中ありで本文なしは短い中間の前置き" (Invoke-Notify "stop" @{}) `
    @('ケース solo→interim / 中間', 'phrases\\zundamon\\stop\\brief\\interim\\')

  # 途中でも返事が要るものは ask のまま
  Invoke-Notify "promptsubmit" @{} | Out-Null
  Check "実行中でも ask は ask の前置き（ずんだもん）" `
    (Invoke-Notify "stop" @{ last_assistant_message = "どちらの案で進めますか。" }) `
    @('ケース ask \(brief\) / 中間', 'phrases\\zundamon\\stop\\brief\\ask\\')

  # 要約できない長い報告は読まず、説明だけにする（途中経過を短く保つ）
  $tp = Join-Path $MetaDir "agent-$Agent2.jsonl"
  Set-Content -LiteralPath (Join-Path $MetaDir "agent-$Agent2.meta.json") `
    -Value '{"description":"長い報告の検証"}' -Encoding UTF8
  Invoke-Notify "agentstart" @{ agent_id = $Agent2 } | Out-Null
  Reset-Debounce
  # $log は使わない（PowerShell は変数名の大文字小文字を区別せず、$Log を潰す）
  $longLog = Invoke-Notify "agentstop" @{ agent_id = $Agent2; agent_transcript_path = $tp
    last_assistant_message = "コミット d1c1b711 で src/pipeline/slide_content.ts と ui/server/deck_read.ts を直し、npm test 406 files / 5364 tests がすべて通りました。" }
  Check "要約できない長い報告は説明だけ読む" $longLog `
    @('要約が無く報告が長い', '読み上げ \[zundamon\]: 長い報告の検証が完了しました。(\n|$)')

  # 短い報告はそのまま読む（中間）
  Reset-Debounce
  Check "サブエージェントの短い報告はそのまま読む（ずんだもん）" `
    (Invoke-Notify "agentstop" @{ agent_id = $Agent; last_assistant_message = "テストは全件通りました。" }) `
    '読み上げ \[zundamon\]: テストは全件通りました。'

  # 待つものが無くなった → idle は鳴る（既定の話者）
  Check "待つものが無い idle はめたんで鳴る" (Invoke-Notify "idle" @{}) 'phrases\\metan\\idle\\' 'のため無音'

  # 最終報告
  Invoke-Notify "promptsubmit" @{} | Out-Null
  Check "実行中なしの stop は最終・めたん・完了の前置き" `
    (Invoke-Notify "stop" @{ last_assistant_message = "修正が完了しました。" }) `
    @('ケース done \(brief\) / 最終 \[metan\]', 'phrases\\metan\\stop\\brief\\done\\')

  # API エラーで終わったターンも作業中の印を消す
  Invoke-Notify "promptsubmit" @{} | Out-Null
  Invoke-Notify "failure" @{ error_type = "overloaded" } | Out-Null
  Check "failure のあとの idle は鳴る" (Invoke-Notify "idle" @{}) 'phrases\\metan\\idle\\' 'のため無音'
}
catch {
  # 途中で落ちたら、残りを数えずに合格と出してしまわないようにする
  $ng++
  "NG  例外で中断: {0}" -f $_.Exception.Message
}
finally {
  foreach ($a in $Agent, $Agent2) {
    Remove-Item -LiteralPath (Join-Path $Here "state\agents\$a") -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $Turn -Force -ErrorAction SilentlyContinue
  if ($MetaDir -like "*claude-voice-selftest-*") {
    Remove-Item -LiteralPath $MetaDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

""
if ($muted) { "ミュート中（手動またはマイク使用中）のため再生まで進まない項目がある。解除して再実行のこと"; exit 1 }
if ($ng -eq 0) { "全 {0} 件 合格" -f $total }
else { "全 {0} 件中 {1} 件 不合格" -f $total, $ng; exit 1 }
