<#
要約ファイル（mod: voice-summary が書く）を notify.ps1 が正しく受け取るかの検証。
notify.ps1 を -DryRun で実際に呼ぶ。音は鳴らさない。架空の session_id を使う。

  .\test-summary-handoff.ps1

mod の代わりにこのスクリプトが state/summaries/*.json を書く。
要約ファイルは len / head（本文の文字数と先頭16文字）で「どの応答の要約か」を示し、
notify は自分の本文と一致したときだけ使う。
ケース H（時間切れ）は summaryTimeoutSec（既定15秒）待つ。
#>
$Here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginRoot = Split-Path -Parent $Here
# ホームは一時フォルダ（利用者の ~/.claude/voice-notify には触れない）。終わったら消す
$TestHome = Join-Path $env:TEMP ("voice-notify-test-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$env:VOICE_NOTIFY_HOME = $TestHome
. (Join-Path $Here "_testlib.ps1")
New-TestPhrases $TestHome (Join-Path $PluginRoot "config.default.json")
$Notify  = Join-Path $PluginRoot "scripts\notify.ps1"
$Log     = Join-Path $TestHome "notify.log"
$Sid     = "selftest-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
$Agent   = "selftest-agent-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
$Turn    = Join-Path $TestHome "state\turns\$Sid"
$SumDir  = Join-Path $TestHome "state\summaries"
$Main    = Join-Path $SumDir "$Sid.json"
$Sub     = Join-Path $SumDir ("{0}__{1}.json" -f $Sid, $Agent)
$First   = "要約ファイルの受け渡しを読み上げ側で検証しているところです。"
$Long    = $First + "二文目は要約の下限を超えるための埋め草で、読み上げには使われない想定の文章です。三文目も同じく長さを稼ぐための文で、内容に意味はありません。"
$Other   = "前の応答の本文です。" + $Long
$Report  = "サブエージェントの報告です。下限の三十文字を超えるように、少し長めに書いてあります。"
$OutputEncoding = New-Object Text.UTF8Encoding $false

function Invoke-Notify([string]$ev, [hashtable]$body) {
  $before = 0
  if (Test-Path $Log) { $before = @(Get-Content $Log -Encoding UTF8).Count }
  $body.session_id = $Sid
  ($body | ConvertTo-Json -Compress) |
    powershell -NoProfile -ExecutionPolicy Bypass -File $Notify -Event $ev -DryRun | Out-Null
  $lines = @(Get-Content $Log -Encoding UTF8)
  if ($lines.Count -lt $before) { $before = 0 }
  (@($lines | Select-Object -Skip $before) -match '\[DRY\]') -join "`n"
}

function NowMs { [DateTimeOffset]::Now.ToUnixTimeMilliseconds() }

# mod と同じ形の要約ファイル（BOM 無し UTF-8 の JSON）。$for は「どの応答の要約か」（len / head の元）
function Write-Summary([string]$path, [string]$for, [hashtable]$rec) {
  if (-not (Test-Path $SumDir)) { New-Item -ItemType Directory $SumDir -Force | Out-Null }
  $rec.v = 1; $rec.turnId = "t"; $rec.at = (NowMs)
  $rec.len = $for.Length
  $rec.head = $for.Substring(0, [Math]::Min(16, $for.Length))
  [IO.File]::WriteAllText($path, ($rec | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
}

# 長いターン（開始を60秒前に）にして、短いターン扱い（本文を読まない）を避ける
function Start-LongTurn {
  Set-Content -LiteralPath $Turn -Value (Get-Date).AddSeconds(-60).ToString("o") -Encoding UTF8
}

function Reset-Debounce {
  $f = Join-Path $TestHome "state\last_spoken"
  if (Test-Path $f) { (Get-Item $f).LastWriteTime = (Get-Date).AddMinutes(-1) }
}

$total = 0; $ng = 0; $muted = $false
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
function CheckTrue([string]$name, [bool]$cond) {
  $script:total++
  if ($cond) { "ok  $name" } else { "NG  $name"; $script:ng++ }
}

try {
  # A: 出来上がっている要約（done）を読む。読んだら消す
  Start-LongTurn
  Write-Summary $Main $Long @{ status = "done"; kind = "final"; text = "要約の受け渡しを確認しました。"; ms = 900 }
  Check "A: done の要約を読む" (Invoke-Notify "stop" @{ last_assistant_message = $Long }) `
    @('要約 [0-9.]+秒 \(Haiku 900ms\): 要約の受け渡しを確認しました。', '読み上げ: 要約の受け渡しを確認しました。')
  CheckTrue "A: 読んだ要約ファイルは消える" (-not (Test-Path $Main))

  # B: ファイルが無い（mod 未読み込み・要約しない判断）→ 待たずに抜き出し
  Start-LongTurn
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $b = Invoke-Notify "stop" @{ last_assistant_message = $Long }
  $sw.Stop()
  Check "B: ファイルが無ければ抜き出しを読む" $b `
    @('要約なし（mod 未読み込み、または要約しない判断）', "読み上げ: $First") 'タイムアウト'
  CheckTrue ("B: 要約の時間切れ（15秒）を待たない（{0:N1}秒）" -f $sw.Elapsed.TotalSeconds) ($sw.Elapsed.TotalSeconds -lt 15)

  # C: pending のあと done になる（mod が書き終えるのを待つ）
  Start-LongTurn
  Write-Summary $Main $Long @{ status = "pending"; kind = "final" }
  $late = Get-Content -LiteralPath $Main -Raw -Encoding UTF8 | ConvertFrom-Json
  $late.status = "done"
  $late | Add-Member -NotePropertyName text -NotePropertyValue "遅れて届いた要約です。"
  $late | Add-Member -NotePropertyName ms -NotePropertyValue 2000
  $lateJson = $late | ConvertTo-Json -Compress
  $job = Start-Job -ScriptBlock {
    param($p, $json)
    Start-Sleep -Seconds 2
    [IO.File]::WriteAllText($p, $json, (New-Object Text.UTF8Encoding $false))
  } -ArgumentList $Main, $lateJson
  Check "C: pending から done を待って読む" (Invoke-Notify "stop" @{ last_assistant_message = $Long }) `
    @('要約 [0-9.]+秒 \(Haiku 2000ms\): 遅れて届いた要約です。')
  Wait-Job $job -Timeout 10 | Out-Null; Remove-Job $job -Force

  # D: 別の応答の要約（len / head が合わない）は使わない。前のターンの残り、遅れて書かれた要約など
  Start-LongTurn
  Write-Summary $Main $Other @{ status = "done"; kind = "final"; text = "前の応答の要約です。"; ms = 900 }
  Check "D: 別の応答の要約は使わない" (Invoke-Notify "stop" @{ last_assistant_message = $Long }) `
    @('別の応答の要約なので使わない', "読み上げ: $First") '前の応答の要約です。'
  CheckTrue "D: 使わなかった要約ファイルは消える" (-not (Test-Path $Main))

  # E: ターンの開始記録が無くても、本文が一致する要約は読む（時刻に頼らない）
  Remove-Item -LiteralPath $Turn -Force -ErrorAction SilentlyContinue
  Write-Summary $Main $Long @{ status = "done"; kind = "final"; text = "開始記録が無くても読めます。"; ms = 700 }
  Check "E: 開始記録が無くても一致すれば読む" (Invoke-Notify "stop" @{ last_assistant_message = $Long }) `
    @('要約 [0-9.]+秒 \(Haiku 700ms\): 開始記録が無くても読めます。')

  # F: error → 理由を残して抜き出し
  Start-LongTurn
  Write-Summary $Main $Long @{ status = "error"; kind = "final"; reason = "api-error 429"; ms = 300 }
  Check "F: error なら理由を残して抜き出しを読む" (Invoke-Notify "stop" @{ last_assistant_message = $Long }) `
    @('要約失敗、1文目を読む: api-error 429', "読み上げ: $First")

  # G: サブエージェントは自分のファイルを読む
  Invoke-Notify "agentstart" @{ agent_id = $Agent } | Out-Null
  Reset-Debounce
  Write-Summary $Sub $Report @{ status = "done"; kind = "interim"; text = "途中経過の要約です。"; ms = 800 }
  Check "G: サブエージェントは自分の要約を読む（ずんだもん）" (Invoke-Notify "agentstop" @{ agent_id = $Agent; last_assistant_message = $Report }) `
    @('読み上げ \[zundamon\]: 途中経過の要約です。')
  CheckTrue "G: サブエージェントの要約ファイルは消える" (-not (Test-Path $Sub))

  # H: pending のまま → 時間切れで抜き出し（summaryTimeoutSec 待つ）
  Start-LongTurn
  Write-Summary $Main $Long @{ status = "pending"; kind = "final" }
  Check "H: pending のまま時間切れなら抜き出しを読む" (Invoke-Notify "stop" @{ last_assistant_message = $Long }) `
    @('秒でタイムアウト。1文目を読む', "読み上げ: $First")
}
catch {
  $ng++
  "NG  例外で中断: {0}" -f $_.Exception.Message
}
finally {
  if ($TestHome -like "*voice-notify-test-*") { Remove-Item -LiteralPath $TestHome -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath (Join-Path $TestHome "state\agents\$Agent") -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Turn, $Main, $Sub -Force -ErrorAction SilentlyContinue
}

""
if ($muted) { "ミュート中（手動またはマイク使用中）のため再生まで進まない項目がある。解除して再実行のこと"; exit 1 }
if ($ng -eq 0) { "全 {0} 件 合格" -f $total }
else { "全 {0} 件中 {1} 件 不合格" -f $total, $ng; exit 1 }
