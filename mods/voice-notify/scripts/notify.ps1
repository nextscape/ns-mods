<#
Claude Code hook から呼ばれる音声通知スクリプト (VOICEVOX 版)。

イベント（hook から）:
  stop         応答完了。定型フレーズ + 応答の要約（mod が Haiku で作ったもの）を読む
  failure      StopFailure。API エラーでターンが終わったとき
  permission   Notification/permission_prompt。許可待ち
  idle         Notification/idle_prompt。入力待ち（サブエージェント実行中・メイン作業中は黙る）
  notification 上記に当てはまらない通知（後方互換）
  task         TaskCompleted
  agentstart   サブエージェント開始。無音で実行中として記録する（session_id 付き）
  agentstop    サブエージェント完了。「<説明>が完了しました。<報告>」
  promptsubmit ターン開始。無音で開始時刻だけ残す（作業時間の判定に使う）

話者は2つ使い分ける:
  speakerInterim 中間報告。agentstop と、サブエージェントを待ったまま終えた stop
  speaker        それ以外（最終報告・許可待ち・入力待ち・エラーなど）

操作（/voice-notify:voice とホットキーから。stdin を読まない）:
  mute / unmute / toggle / status

VOICEVOX ENGINE が起動していなくても定型フレーズは鳴る（縮退動作）。
設定はすべて config.json。失敗は notify.log に理由付きで残る。
#>
param(
  [ValidateSet("stop","notification","permission","idle","task","agentstart","agentstop","failure",
               "promptsubmit","mute","unmute","toggle","status")]
  [string]$Event = "stop",
  [switch]$NoDynamic,
  # 検証用。音を鳴らさず「何を読むはずだったか」だけをログに残す。
  # 環境変数 VOICE_NOTIFY_DRYRUN=1 でも同じ（テスト中ずっと黙らせたいとき用）。
  [switch]$DryRun
)

# 通知を黙らせたいスクリプトから使う脱出口。
#   $env:VOICE_NOTIFY_SUPPRESS = "1"
if ($env:VOICE_NOTIFY_SUPPRESS -eq "1") { exit 0 }

$ErrorActionPreference = "Stop"
$Here      = Split-Path -Parent $MyInvocation.MyCommand.Path   # スクリプト（プラグイン側。更新で置き換わる）
. (Join-Path $Here "lib.ps1")    # Get-VoiceHome / Initialize-VoiceHome / Clear-SpeechText
$VHome     = Get-VoiceHome                                     # 設定と状態（ホーム。更新・撤去で消えない）
Initialize-VoiceHome $VHome (Split-Path -Parent $Here)
$Cfg       = Get-Content (Join-Path $VHome "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$Speaker   = $Cfg.speaker
$SpeakerId = $Cfg.speakers.$Speaker.id
$SummaryMax = [int]$Cfg.speech.summaryMaxChars   # 要約の上限。途中経過では Enter-Interim が縮める
$SummaryMin = [int]$Cfg.speech.summaryMinChars   # これより短い本文は要約せずそのまま読む
$Port      = $Cfg.enginePort
$CacheDir  = Join-Path $VHome "cache"
$StateDir  = Join-Path $VHome "state\agents"
$TurnDir   = Join-Path $VHome "state\turns"
$MuteFile  = Join-Path $VHome "state\mute"
$SummaryDir = Join-Path $VHome "state\summaries"    # 要約 mod（hooks/register.ts）が要約を置く
$LogPath   = Join-Path $VHome "notify.log"
foreach ($d in @($CacheDir, $StateDir, $TurnDir)) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory $d -Force | Out-Null }
}

# ---------------------------------------------------------------- ログ
# 何が起きたかを理由付きで残す。失敗しても無言のままにしない。
if ($env:VOICE_NOTIFY_DRYRUN -eq "1") { $DryRun = $true }

function Write-Log([string]$Level, [string]$Msg) {
  if ($DryRun) { $Msg = "[DRY] " + $Msg }
  $line = "{0}  {1,-4} {2,-11} {3}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Event, $Msg
  # hook は並行して走るので、同時に書くと片方が「使用中」で失敗し、その行が消える
  # （実測で発生）。間をずらして書き直す。
  for ($i = 0; $i -lt 5; $i++) {
    try { $line | Add-Content -LiteralPath $LogPath -Encoding UTF8 -ErrorAction Stop; break }
    catch { Start-Sleep -Milliseconds (20 + (Get-Random -Maximum 60)) }
  }
  try {
    if ((Get-Item $LogPath).Length -gt 200KB) {
      Get-Content $LogPath -Tail 500 | Set-Content -LiteralPath $LogPath -Encoding UTF8
    }
  } catch { }
}

# 中間報告として話す。声を変え、要約を短くする（途中経過は聞き流せる長さに）。
# Get-Phrase・合成・要約はこれらの変数を呼び出し時に読むので、鳴らす前に切り替えれば足りる。
# speakerInterim / interimMaxChars が未設定なら、それぞれ最終報告と同じまま。
function Enter-Interim {
  $name = $Cfg.speakerInterim
  if ($name -and $Cfg.speakers.$name) {
    $script:Speaker   = $name
    $script:SpeakerId = $Cfg.speakers.$name.id
  }
  if ($Cfg.speech.interimMaxChars) {
    # 上限より短い報告はそのまま読む。要約しても縮まらないため
    $script:SummaryMax = [int]$Cfg.speech.interimMaxChars
    $script:SummaryMin = $script:SummaryMax
    # 1文に絞る指示（speech.interimPrompt）の追記は mod 側で行う
  }
}

function Get-Phrase([string]$name) {
  $d = Join-Path $VHome "phrases\$Speaker\$name"
  $f = @(Get-ChildItem $d -Filter *.wav -ErrorAction SilentlyContinue)
  if (-not $f.Count) { return $null }
  # 直前と同じものを選ばない（「完了しました」の3連発を防ぐ）
  $lastFile = Join-Path $VHome ("state\last_phrase_" + $name.Replace('\', '_').Replace('/', '_'))
  $prev = ""
  if (Test-Path $lastFile) { $prev = (Get-Content -LiteralPath $lastFile -Raw).Trim() }
  $pool = @($f | Where-Object { $_.Name -ne $prev })
  if (-not $pool.Count) { $pool = $f }
  $pick = $pool | Get-Random
  try { Set-Content -LiteralPath $lastFile -Value $pick.Name -Encoding UTF8 } catch { }
  return $pick.FullName
}

# ---------------------------------------- 再生の頭切れ対策
# 既定の出力先がディスプレイの音声（HDMI/DisplayPort）だと、再生を始めるたびに
# 鳴らし始めが欠ける。VOICEVOX の wav は先頭の無音が約0.1秒しかない。
# 聞き比べ（2026-09-16）の結果:
#   静寂の後に鳴らす        そのままは欠ける / +0.3秒で欠けない
#   前の再生に続けて鳴らす  無音なしは欠ける / 0.9秒後は +0.3秒でも少し欠ける / +0.6秒で欠けない
# 休止明けに限らないので、毎回 playback.leadSilenceMs の無音を頭に足す。
function Get-LeadMs {
  if ($null -ne $Cfg.playback.leadSilenceMs) { return [int]$Cfg.playback.leadSilenceMs }
  return 600
}

# data の前に無音を足した wav をバイト列で返す。0ms なら元のまま、wav として読めなければ $null。
function Add-LeadSilence([byte[]]$wav, [int]$ms) {
  if ($ms -le 0) { return ,$wav }
  if (-not $wav -or $wav.Length -lt 44) { return $null }
  if ([Text.Encoding]::ASCII.GetString($wav, 0, 4) -ne "RIFF" -or
      [Text.Encoding]::ASCII.GetString($wav, 8, 4) -ne "WAVE") { return $null }
  $rate = 0; $align = 0; $dataAt = -1; $dataSize = 0
  $i = 12
  while ($i + 8 -le $wav.Length) {
    $id = [Text.Encoding]::ASCII.GetString($wav, $i, 4)
    $sz = [BitConverter]::ToInt32($wav, $i + 4)
    if ($id -eq "fmt ") { $rate = [BitConverter]::ToInt32($wav, $i + 12); $align = [BitConverter]::ToInt16($wav, $i + 20) }
    if ($id -eq "data") { $dataAt = $i + 8; $dataSize = [Math]::Min($sz, $wav.Length - $dataAt); break }
    $i += 8 + $sz + ($sz % 2)   # チャンクは偶数境界に揃う
  }
  if ($dataAt -lt 0 -or $rate -le 0 -or $align -le 0) { return $null }

  # data チャンクの手前（fmt など）はそのまま使い、data の大きさと RIFF の大きさだけ直す
  $pad = [int]($rate * $ms / 1000) * $align
  $out = New-Object byte[] ($dataAt + $pad + $dataSize)
  [Array]::Copy($wav, 0, $out, 0, $dataAt)
  [Array]::Copy($wav, $dataAt, $out, $dataAt + $pad, $dataSize)
  [BitConverter]::GetBytes([int]($pad + $dataSize)).CopyTo($out, $dataAt - 4)
  [BitConverter]::GetBytes([int]($out.Length - 8)).CopyTo($out, 4)
  return ,$out
}

function Play-Wav([string]$Path) {
  if (-not $Path) { return }
  if (-not (Test-Path $Path)) { Write-Log "WARN" "再生ファイルがない: $Path"; return }
  $lead = Get-LeadMs
  if ($DryRun) {
    # どの話者のフレーズかが分かるよう phrases\<speaker>\... の形で残す
    $rel = $Path
    if ($rel.StartsWith($VHome)) { $rel = $rel.Substring($VHome.Length + 1) }
    Write-Log "INFO" ("再生省略: {0} (頭に無音 +{1}ms)" -f $rel, $lead); return
  }

  # hook は async:true なので Stop と SubagentStop などが同時に走りうる。
  # そのまま鳴らすと音が重なって聞き取れないので、再生だけは1つずつ通す。
  $mx = $null
  $held = $false
  try { $mx = New-Object Threading.Mutex($false, "voice-notify-playback") } catch { }
  if ($mx) {
    try { $held = $mx.WaitOne(20000) }
    catch [Threading.AbandonedMutexException] { $held = $true }   # 前の保持者が異常終了。所有権は得ている
    catch { $held = $false }
    if (-not $held) { Write-Log "WARN" "先行する再生が20秒で終わらないので重ねて鳴らす" }
  }
  try {
    $player = $null
    if ($lead -gt 0) {
      $bytes = Add-LeadSilence ([IO.File]::ReadAllBytes($Path)) $lead
      if ($bytes) { $player = New-Object System.Media.SoundPlayer (New-Object IO.MemoryStream (, $bytes)) }
      else { Write-Log "WARN" ("wav を読めないので無音を足さずに鳴らす: {0}" -f (Split-Path $Path -Leaf)) }
    }
    if (-not $player) { $player = New-Object System.Media.SoundPlayer $Path }
    $player.PlaySync()
  }
  catch { Write-Log "ERR " ("再生失敗 {0}: {1}" -f (Split-Path $Path -Leaf), $_.Exception.Message) }
  finally {
    if ($held) { try { $mx.ReleaseMutex() } catch { } }
    if ($mx)   { try { $mx.Dispose() } catch { } }
  }
}

# ------------------------------------------------ ミュート操作（stdin を読まない）
if ($Event -in @("mute","unmute","toggle","status")) {
  # /voice から呼ばれたとき日本語が化けないように出力を UTF-8 で固定する
  try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
  $muted = Test-Path $MuteFile
  if ($Event -eq "status") {
    $mic = "無効"
    if ($Cfg.mute.whenMicInUse) { $mic = "有効" }
    $state = "OFF"
    if ($muted) { $state = "ON" }
    Write-Output ("手動ミュート: {0}" -f $state)
    Write-Output ("マイク使用中の自動ミュート: {0}" -f $mic)
    $final = $Cfg.speakers.$Speaker.label
    Enter-Interim
    Write-Output ("話者: 最終 {0} / 中間 {1} / 話速: {2}" -f $final, $Cfg.speakers.$Speaker.label, $Cfg.speedScale)
    exit 0
  }
  switch ($Event) {
    "mute"   { $muted = $true }
    "unmute" { $muted = $false }
    "toggle" { $muted = -not $muted }
  }
  if ($muted) {
    Play-Wav (Get-Phrase "mute")          # 止める前に知らせる
    Set-Content -LiteralPath $MuteFile -Value (Get-Date -Format o) -Encoding UTF8
    Write-Output "音声通知: 停止しました"
  } else {
    Remove-Item -LiteralPath $MuteFile -Force -ErrorAction SilentlyContinue
    Play-Wav (Get-Phrase "unmute")
    Write-Output "音声通知: 再開しました"
  }
  Write-Log "INFO" "手動ミュートを切り替え"
  exit 0
}

Write-Log "INFO" "発火"

# ---------------------------------------- stdin の hook ペイロード
# [Console]::In だと日本語が壊れるので UTF-8 で明示的に読む
$payload = $null
try {
  $reader = New-Object IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
  $raw = $reader.ReadToEnd()
  $reader.Dispose()
  if ($Cfg.debugPayload -and $raw) {
    $d = Join-Path $VHome "payloads"
    if (-not (Test-Path $d)) { New-Item -ItemType Directory $d | Out-Null }
    $pf = Join-Path $d ("{0}-{1}.json" -f $Event, (Get-Date -Format "yyyyMMdd-HHmmss-fff"))
    Set-Content -LiteralPath $pf -Value $raw -Encoding UTF8
    Get-ChildItem $d -Filter *.json | Sort-Object LastWriteTime -Descending |
      Select-Object -Skip 60 | Remove-Item -Force -ErrorAction SilentlyContinue
  }
  if ($raw) { $payload = $raw | ConvertFrom-Json }
} catch { Write-Log "ERR " ("ペイロード読み取り失敗: {0}" -f $_.Exception.Message) }

# ---------------------------------------- ターン開始の記録（無音）
# 作業時間が短いターンは「完了を告げるだけ」にするので、開始時刻を残しておく。
# session_id ごとに分けるため、並行して動いている別セッションと混ざらない。
# ファイルがあること自体が「メインが作業中」の印にもなる（idle の抑止に使う）。
function Get-TurnFile([string]$sid) {
  Join-Path $TurnDir ($sid -replace '[^0-9A-Za-z_-]', '_')
}

if ($Event -eq "promptsubmit") {
  $sid = $payload.session_id
  if ($sid) {
    $p = Get-TurnFile $sid
    try { Set-Content -LiteralPath $p -Value (Get-Date).ToString("o") -Encoding UTF8 }
    catch { Write-Log "WARN" ("開始時刻を残せない: {0}" -f $_.Exception.Message) }
    # 落ちたセッションのぶんが溜まり続けないよう、1日より古い記録を捨てる
    try {
      Get-ChildItem $TurnDir -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) } |
        Remove-Item -Force -ErrorAction SilentlyContinue
    } catch { }
    # 読まれなかった要約ファイル（短いターン・ミュート中など）を捨てる。mod は消せない
    try {
      Get-ChildItem $SummaryDir -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-1) } |
        Remove-Item -Force -ErrorAction SilentlyContinue
    } catch { }
  }
  exit 0
}

# ---------------------------------------- 作業時間
# promptsubmit が残した開始時刻を消費する。読んだら消すので、古い記録を
# 次のターンで使い回す事故が起きない。記録が無ければ $null（＝判定しない）。
function Get-TurnSeconds {
  $sid = $payload.session_id
  if (-not $sid) { return $null }
  $p = Get-TurnFile $sid
  if (-not (Test-Path $p)) { return $null }
  $sec = $null
  try {
    $t = [datetime]::Parse((Get-Content -LiteralPath $p -Raw).Trim(), $null,
                           [Globalization.DateTimeStyles]::RoundtripKind)
    $sec = ((Get-Date) - $t).TotalSeconds
  } catch { Write-Log "WARN" ("開始時刻を読めない: {0}" -f $_.Exception.Message) }
  try { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue } catch { }
  if ($null -eq $sec -or $sec -lt 0) { return $null }
  return $sec
}

# ターンの終わり（stop / failure）では、ミュート判定より前に消費する。
# 残ると「メインが作業中」と見なされ続け、idle が鳴らなくなる。
$TurnSec = $null
if ($Event -in @("stop","failure")) { $TurnSec = Get-TurnSeconds }

# ---------------------------------------- 実行中のサブエージェント
# agentstart が state/agents/<agent_id> に session_id を書き、agentstop が消す。
# 並行する別セッションのエージェントを数えないよう session_id で絞る。
# 取り残し（セッション異常終了・停止されたエージェントなど）は1時間で捨てる。
function Get-RunningAgents([string]$sid) {
  Get-ChildItem $StateDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-1) } |
    Remove-Item -Force -ErrorAction SilentlyContinue
  if (-not $sid) { return 0 }
  @(Get-ChildItem $StateDir -File -ErrorAction SilentlyContinue | Where-Object {
      "$(Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue)".Trim() -eq $sid
    }).Count
}

# ---------------------------------------- サブエージェント開始（無音・常に記録）
if ($Event -eq "agentstart") {
  $id = $payload.agent_id
  if ($id) {
    Set-Content -LiteralPath (Join-Path $StateDir $id) -Value "$($payload.session_id)" -Encoding UTF8
  }
  exit 0
}

# ---------------------------------------- 入力待ち（idle）の誤報を抑える
# idle_prompt は「メインの応答が終わってから60秒」で出るだけで、裏で動く
# サブエージェントを見ていない。サブエージェントを待っている間や、その報告を
# 受けてメインが再開した後は、ユーザーの入力を待っているわけではない。
if ($Event -eq "idle") {
  $sid = $payload.session_id
  $n = Get-RunningAgents $sid
  if ($n -gt 0) { Write-Log "INFO" ("サブエージェント実行中 ({0}件) のため無音" -f $n); exit 0 }
  if ($sid -and (Test-Path (Get-TurnFile $sid))) { Write-Log "INFO" "メインが作業中のため無音"; exit 0 }
}

# ---------------------------------------- ミュート判定
function Get-MuteReason {
  if (Test-Path $MuteFile) { return "手動ミュート" }
  if ($Cfg.mute.whenMicInUse) {
    # 会議・通話中は黙る。Windows はマイク使用中のアプリを
    # LastUsedTimeStop = 0 で表す（終了時刻が未設定 = まだ使っている）。
    try {
      $base = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone"
      foreach ($root in @($base, (Join-Path $base "NonPackaged"))) {
        if (-not (Test-Path $root)) { continue }
        foreach ($k in (Get-ChildItem $root -ErrorAction SilentlyContinue)) {
          $v = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
          if ($null -ne $v.LastUsedTimeStop -and $v.LastUsedTimeStop -eq 0 -and $v.LastUsedTimeStart -gt 0) {
            return ("マイク使用中 ({0})" -f $k.PSChildName)
          }
        }
      }
    } catch { Write-Log "WARN" ("マイク判定に失敗: {0}" -f $_.Exception.Message) }
  }
  return $null
}

$muteReason = Get-MuteReason
if ($muteReason) { Write-Log "INFO" "無音化: $muteReason"; exit 0 }

# ---------------------------------------- 文の抽出
# 読み上げに適さない要素を落として先頭の1〜2文を返す。
#   先頭1文が shortSentenceChars 以下なら2文目まで。
#   ただし合計が maxTwoSentenceChars を超えるなら1文だけ。
function Pick-Sentence([string]$txt) {
  if (-not $txt) { return $null }
  $txt = [regex]::Replace($txt, '(?s)```.*?```', '')             # コードブロック
  $txt = [regex]::Replace($txt, '(?m)^\s*\|.*$', '')             # 表
  $txt = [regex]::Replace($txt, '\[([^\]]+)\]\([^)]+\)', '$1')    # リンク
  $txt = [regex]::Replace($txt, 'https?://\S+', '')              # URL
  $txt = $txt -replace '[`*#>_\-]', ' '
  $txt = [regex]::Replace($txt, '\s+', ' ').Trim()
  if ($txt.Length -lt 4) { return $null }
  $sentences = @([regex]::Matches($txt, '[^。！？!?]{1,200}[。！？!?]') | ForEach-Object { $_.Value })
  if ($sentences.Count -eq 0) { return $txt.Substring(0, [Math]::Min(60, $txt.Length)) + "。" }
  $s1 = $sentences[0]
  $shortMax = 20
  $twoMax   = 60
  if ($Cfg.speech.shortSentenceChars)  { $shortMax = [int]$Cfg.speech.shortSentenceChars }
  if ($Cfg.speech.maxTwoSentenceChars) { $twoMax   = [int]$Cfg.speech.maxTwoSentenceChars }
  if ($s1.Length -le $shortMax -and $sentences.Count -ge 2) {
    $two = $s1 + $sentences[1]
    if ($two.Length -le $twoMax) { return $two }
  }
  return $s1
}

# ---------------------------------------- ケース判定
# 前置きの定型フレーズを選ぶために、応答の「末尾2文」だけを見て種類を決める。
# 末尾に限るのは「当初はエラーで停止していました。…修正して全件通っています。」を
# trouble と誤判定しないため。
#   ask     返事が要る。trouble でもあるときは ask を優先する（行動に直結するので）
#   trouble うまくいかないまま終わった
#   done    それ以外
function Get-StopCase([string]$txt) {
  if (-not $txt) { return "done" }
  $t = [regex]::Replace($txt, '(?s)```.*?```', '')             # コードブロック
  $t = [regex]::Replace($t, '(?m)^\s*\|.*$', '')               # 表
  $t = [regex]::Replace($t, '\[([^\]]+)\]\([^)]+\)', '$1')      # リンク
  $t = [regex]::Replace($t, 'https?://\S+', '')                # URL
  $t = $t -replace '[`*#>_]', ' '
  $t = [regex]::Replace($t, '\s+', ' ').Trim()
  if ($t.Length -lt 2) { return "done" }

  # 末尾2文。句点で終わらない末尾（箇条書きなど）も1文として拾う
  $sentences = @([regex]::Matches($t, '[^。！？!?]{1,200}[。！？!?]') | ForEach-Object { $_.Value })
  $rest = $t.Substring([Math]::Min(($sentences -join "").Length, $t.Length)).Trim()
  $parts = @($sentences)
  if ($rest.Length -ge 4) { $parts += $rest }
  $tail = ($parts | Select-Object -Last 2) -join ""
  if (-not $tail) { $tail = $t }

  if ($tail -match '[?？]\s*$') { return "ask" }
  if ($tail -match '(ますか|ましょうか|でしょうか|いかがですか|どうしますか|どうするか)[。．!！?？]?\s*$') { return "ask" }
  if ($tail -match '(ご判断|ご確認ください|お選びください|お決めください|ご指示|どちらに|どちらで|番号で|教えてください|よろしいですか|いかがでしょう)') { return "ask" }

  # 解決済みの言及は打ち消してから未解決語を探す（「エラーを修正しました」は done）
  $chk = [regex]::Replace($tail, '(失敗|エラー|不具合|例外|問題)[をがはも]?[^。]{0,8}?(修正|解決|直し|直り|対処|復旧|解消|通るように)', '')
  if ($chk -match '(失敗|エラー|不具合|例外|できませんでした|できていません|通りません|落ちて|未解決|解決していません|原因が分から|うまくいかな|うまくいっていません)') { return "trouble" }

  return "done"
}

# VOICEVOX が生きているか。落ちていると合成できず、前置きのあとが無音になる。
# 127.0.0.1 なので生存時は数ミリ秒、不通時は即座に接続拒否が返る。
function Test-EngineAlive {
  try { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/version" -TimeoutSec 2 | Out-Null; return $true }
  catch { return $false }
}

# ---------------------------------------- 要約（mod: hooks/register.ts）
# 1文目の抜き出しでは「何をしたか」が伝わらないことが多いので、応答全体の要約を読む。
# 要約は mod（mod/）が turn.complete で Haiku に作らせ、要約するときだけ state/summaries/ に置く。
#   <session_id>.json / <session_id>__<agent_id>.json
#   {"v":1,"status":"pending|done|error","len":<本文の文字数>,"head":<本文の先頭16文字>,"text":…,"reason":…,"ms":…}
# len / head で「どの応答の要約か」を確かめる（時刻では推測しない）。前のターンの残りや、
# 時間切れのあとに遅れて書かれた要約は本文が合わないので使わない。
# turn.complete は Stop hook より先に来て、mod は pending を書いてから次へ進むので、ファイルは1回読めば足りる。
# 無い・合わない・失敗・時間切れのときは Pick-Sentence に落ちる。待つ時間は notify だけが決める。

function Get-SummaryPath([string]$sid, [string]$aid) {
  if (-not $sid) { return $null }
  $n = $sid -replace '[^0-9A-Za-z_-]', '_'
  if ($aid) { $n += "__" + ($aid -replace '[^0-9A-Za-z_-]', '_') }
  Join-Path $SummaryDir "$n.json"
}

# 書きかけ（mod が上書き中）だと読めないことがあるので、失敗は「まだ無い」として扱う
function Read-SummaryFile([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try { return (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function Remove-SummaryFile([string]$path) {
  try { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue } catch { }
}

# この本文の要約か（mod の e.answer と hook の last_assistant_message は同じ文字列）
function Test-SummaryFor($s, [string]$src) {
  if (-not $s -or -not $src) { return $false }
  return ([int]$s.len -eq $src.Length) -and $src.StartsWith([string]$s.head, [StringComparison]::Ordinal)
}

# 使える要約があれば @{ Path; Src; Rec }（Rec.status は pending か done）、無ければ $null（すぐ抜き出しへ）
function Find-Summary([string]$src, [string]$aid = $null) {
  $sp = $Cfg.speech
  if (-not $sp.summarize) { return $null }
  if ($sp.summarizeEvents -and ($sp.summarizeEvents -notcontains $Event)) { return $null }
  if (-not $src -or $src.Length -lt $SummaryMin) { return $null }
  $path = Get-SummaryPath $payload.session_id $aid
  if (-not $path) { return $null }
  $s = Read-SummaryFile $path
  if (-not $s) {
    Write-Log "INFO" "要約なし（mod 未読み込み、または要約しない判断）。1文目を読む"
    return $null
  }
  if (-not (Test-SummaryFor $s $src)) {
    Write-Log "INFO" "別の応答の要約なので使わない。1文目を読む"
    Remove-SummaryFile $path
    return $null
  }
  if ($s.status -eq "error") {
    Write-Log "WARN" ("要約失敗、1文目を読む: {0}" -f $s.reason)
    Remove-SummaryFile $path
    return $null
  }
  return @{ Path = $path; Src = $src; Rec = $s }
}

# 要約の文を返す（無ければ $null）。pending なら done になるまで summaryTimeoutSec 待つ。読んだら消す
function Wait-Summary($sum) {
  if (-not $sum) { return $null }
  $sec = 15
  if ($Cfg.speech.summaryTimeoutSec) { $sec = [int]$Cfg.speech.summaryTimeoutSec }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $s = $sum.Rec
  while ($s.status -eq "pending" -and $sw.Elapsed.TotalSeconds -lt $sec) {
    Start-Sleep -Milliseconds 100
    $r = Read-SummaryFile $sum.Path
    if (Test-SummaryFor $r $sum.Src) { $s = $r }
  }
  Remove-SummaryFile $sum.Path
  if ($s.status -eq "pending") { Write-Log "WARN" ("要約が {0}秒でタイムアウト。1文目を読む" -f $sec); return $null }
  if ($s.status -ne "done" -or -not $s.text) {
    Write-Log "WARN" ("要約失敗、1文目を読む: {0}" -f $s.reason)
    return $null
  }
  if ($s.text.Length -gt $SummaryMax * 3) {
    Write-Log "WARN" ("要約が長すぎる（{0}文字）。1文目を読む" -f $s.text.Length)
    return $null
  }
  # 「記号は使わないでください」と指示しても、本文の Markdown をそのまま写してくることがある
  $t = Clear-SpeechText $s.text
  Write-Log "INFO" ("要約 {0:N1}秒 (Haiku {1}ms): {2}" -f $sw.Elapsed.TotalSeconds, $s.ms, $t)
  return $t
}

# ---------------------------------------- VOICEVOX 合成
# 本体は1つだけ書き、同期呼び出し（Invoke-Synth）と別プロセス（Start-Synth）の両方から使う。
# Start-Job は PowerShell 5.1 では別プロセスを起こすため往復 0.3〜0.8 秒かかる。
# 結果をすぐ待つ場面では丸損なので、そこは同期版を使う。
$SynthBody = {
    param($t, $port, $sid, $speed, $pitch, $into, $cache)
    try {
      $md5 = [Security.Cryptography.MD5]::Create()
      $key = ([BitConverter]::ToString($md5.ComputeHash(
                [Text.Encoding]::UTF8.GetBytes("$t|$sid|$speed|$pitch|$into"))) -replace '-','').Substring(0,16)
      $out = Join-Path $cache "$key.wav"
      if (Test-Path $out) {
        (Get-Item $out).LastWriteTime = Get-Date      # LRU のため参照時刻を更新
        return @{ Path = $out; Error = $null }
      }
      $enc = [uri]::EscapeDataString($t)
      $q = Invoke-RestMethod -Uri "http://127.0.0.1:$port/audio_query?text=$enc&speaker=$sid" -Method Post -TimeoutSec 30
      $q.speedScale = $speed; $q.pitchScale = $pitch; $q.intonationScale = $into
      $body = [Text.Encoding]::UTF8.GetBytes(($q | ConvertTo-Json -Depth 10 -Compress))
      Invoke-WebRequest -Uri "http://127.0.0.1:$port/synthesis?speaker=$sid" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 120 -OutFile $out
      return @{ Path = $out; Error = $null }
    } catch {
      return @{ Path = $null; Error = $_.Exception.Message }
    }
}

# VOICEVOX は辞書に無い英字を1文字ずつ読む（FIX → エフアイエックス）。
# 0.24 以降は英単語をカタカナで読むが、全部大文字の語は略語として1文字ずつのまま
# （TASK → ティイエエエスケエ）。合成の直前に2段で直す。
#   1. speech.readings（"語": "読み"）で置き換える。大文字小文字は区別しない
#   2. speech.lowercaseMinLength 文字以上の全部大文字の語は小文字にして、英単語として読ませる
#      （ADDRESSED → アドレスド）。略語は speech.keepUppercase に挙げて1文字読みのまま残す。
#      4文字以下は TASK / HTML のように単語と略語が混在して見分けられないので、辞書だけで直す
# 前後が英数字か _ なら触らない（FIXTURE や PASS_1 の一部に当たらないように）。
# \b は日本語も単語文字に数えるので「FIXを」の境目を取れず、使えない。
function Convert-Reading([string]$text) {
  if (-not $text) { return $text }
  $map = $Cfg.speech.readings
  if ($map) {
    foreach ($w in $map.PSObject.Properties) {
      $pat = '(?<![A-Za-z0-9_])' + [regex]::Escape($w.Name) + '(?![A-Za-z0-9_])'
      $text = [regex]::Replace($text, $pat, ([string]$w.Value).Replace('$', '$$'), 'IgnoreCase')
    }
  }
  $min = [int]$Cfg.speech.lowercaseMinLength
  if ($min -gt 0) {
    $keep = @($Cfg.speech.keepUppercase)
    $text = [regex]::Replace($text, "(?<![A-Za-z0-9_])[A-Z]{$min,}(?![A-Za-z0-9_])",
      [Text.RegularExpressions.MatchEvaluator] {
        param($m)
        if ($keep -contains $m.Value) { $m.Value } else { $m.Value.ToLowerInvariant() }
      })
  }
  return $text
}

function Invoke-Synth([string]$text) {
  if (-not $text) { return $null }
  & $SynthBody (Convert-Reading $text) $Port $SpeakerId $Cfg.speedScale $Cfg.pitchScale $Cfg.intonationScale $CacheDir
}

function Start-Synth([string]$text) {
  if (-not $text) { return $null }
  Start-Job -ScriptBlock $SynthBody `
    -ArgumentList (Convert-Reading $text), $Port, $SpeakerId, $Cfg.speedScale, $Cfg.pitchScale, $Cfg.intonationScale, $CacheDir
}

function Prune-Cache {
  try {
    $max = 200
    if ($Cfg.cacheMaxFiles) { $max = [int]$Cfg.cacheMaxFiles }
    $files = @(Get-ChildItem $CacheDir -Filter *.wav -ErrorAction SilentlyContinue |
               Sort-Object LastWriteTime -Descending)
    if ($files.Count -le $max) { return }
    $files | Select-Object -Skip $max | Remove-Item -Force -ErrorAction SilentlyContinue
    Write-Log "INFO" ("キャッシュを {0} 件削除（上限 {1}）" -f ($files.Count - $max), $max)
  } catch { Write-Log "WARN" ("キャッシュ整理に失敗: {0}" -f $_.Exception.Message) }
}

# 合成結果を鳴らす。失敗時は ENGINE 不通かそれ以外かを切り分けて残す。
function Play-Result($res) {
  if (-not $res -or -not $res.Path) {
    $why = "結果なし"
    if ($res) { $why = $res.Error }
    $alive = Test-EngineAlive
    if ($alive) { Write-Log "ERR " "合成失敗: $why" }
    else        { Write-Log "ERR " "VOICEVOX ENGINE に接続できない (port $Port)。定型フレーズのみ再生: $why" }
    return
  }
  Play-Wav $res.Path
  Prune-Cache
}

# 合成してすぐ鳴らす（別プロセスを起こさない）
function Synth-AndPlay([string]$text) {
  if (-not $text) { return }
  Play-Result (Invoke-Synth $text)
}

# 定型フレーズと並行して走らせた合成を回収して鳴らす
function Wait-AndPlay($job) {
  if (-not $job) { return }
  $done = Wait-Job $job -Timeout 60
  $res = $null
  if ($done) { $res = Receive-Job $job }
  Stop-Job $job -ErrorAction SilentlyContinue
  Remove-Job $job -Force -ErrorAction SilentlyContinue
  if (-not $done) { Write-Log "ERR " "合成が60秒でタイムアウト"; return }
  Play-Result $res
}

# ================= サブエージェント完了 =================
if ($Event -eq "agentstop") {
  $id = $payload.agent_id
  $known = $false
  if ($id) {
    $f = Join-Path $StateDir $id
    $known = Test-Path $f
    Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
  }

  # /compact は SubagentStart なしで SubagentStop だけを発火させ、
  # last_assistant_message に圧縮後の要約を載せてくる（謎の発話の正体）。
  # 対応する開始を見ていない停止は本物のサブエージェントではないので黙る。
  if (-not $known) {
    Write-Log "INFO" ("開始を見ていない停止のため無視 (id={0}, type={1})" -f $id, $payload.agent_type)
    exit 0
  }

  $remain = Get-RunningAgents $payload.session_id
  Enter-Interim

  # 連発抑制: 直前の発話から debounceSeconds 以内なら黙る
  $stamp = Join-Path $VHome "state\last_spoken"
  $deb = [double]($Cfg.subagent.debounceSeconds)
  if (Test-Path $stamp) {
    $since = ((Get-Date) - (Get-Item $stamp).LastWriteTime).TotalSeconds
    if ($since -lt $deb) { Write-Log "INFO" ("連発抑制のため無音 ({0:N1}秒 < {1}秒)" -f $since, $deb); exit 0 }
  }
  Set-Content -LiteralPath $stamp -Value (Get-Date -Format o) -Encoding UTF8

  # 「<何をしていたか>が完了しました。<報告>」を1回の合成で読む。
  #   説明は subagents/agent-<id>.meta.json の description（Agent 起動時に付けた短い説明）。
  #   agent_type（explorer 等）は実装の詳細でしかないので読まない。
  $desc = $null
  try {
    $meta = $payload.agent_transcript_path -replace '\.jsonl$', '.meta.json'
    if ($meta -and (Test-Path $meta)) {
      $desc = (Get-Content -LiteralPath $meta -Raw -Encoding UTF8 | ConvertFrom-Json).description
    }
  } catch { Write-Log "WARN" ("description を取得できない: {0}" -f $_.Exception.Message) }

  # 報告は要約して短く読む（Enter-Interim で上限を縮めてある）。
  $src = $payload.last_assistant_message
  $report = Wait-Summary (Find-Summary $src $id)
  if (-not $report) {
    # 要約が無いときは抜き出した1文を読むが、上限を超えるなら読まずに説明だけにする。
    # 報告はコミットID・ファイル一覧・テスト件数が続きやすく、抜き出すと20秒を超えた実例がある。
    # +1 は Pick-Sentence が句点を補うぶん
    $pick = Pick-Sentence $src
    if ($pick -and $pick.Length -gt [Math]::Max($SummaryMax, $SummaryMin) + 1) {
      Write-Log "INFO" ("要約が無く報告が長い（{0}字）ので説明だけ読む" -f $pick.Length)
    } else { $report = $pick }
  }

  # 報告側が既に「完了」と言っているなら繰り返さない
  $dupe = $report -and ($report.Substring(0, [Math]::Min(30, $report.Length)) -match '完了|終わ|できました')
  $text = if ($desc -and $report -and $dupe) { "${desc}。${report}" }
          elseif ($desc -and $report)        { "${desc}が完了しました。${report}" }
          elseif ($desc)                     { "${desc}が完了しました。" }
          elseif ($report)                   { $report }
          else                               { $null }

  if ($text) {
    Write-Log "INFO" ("読み上げ [{0}]: {1}" -f $Speaker, $text)
    Synth-AndPlay $text
  } else {
    Write-Log "WARN" "説明も報告も取れないので定型フレーズにフォールバック"
    Play-Wav (Join-Path $VHome "phrases\$Speaker\agent\_default.wav")
    $mx = [int]$Cfg.subagent.maxRemainSpoken
    $key = "$remain"
    if ($remain -gt $mx) { $key = "many" }
    Play-Wav (Join-Path $VHome "phrases\$Speaker\remain\$key.wav")
  }
  exit 0
}

# ================= 通常イベント =================
# 許可待ちは「何の許可か」まで言う（Notification の matcher で permission と分けてある）
$extra = $null
if ($Event -eq "permission" -and $payload.tool_name) {
  $label = $Cfg.notification.toolLabels.($payload.tool_name)
  if (-not $label) { $label = $payload.tool_name }
  $extra = "${label}の許可待ちです。"
}
if ($Event -eq "failure") {
  $et = $payload.error_type
  if (-not $et) { $et = $payload.reason }
  if ($et) { Write-Log "INFO" "エラー種別: $et" }
}

# 応答完了のみ、本文を読む
$src = $null
$srcFrom = "なし"
if ($Event -eq "stop" -and -not $NoDynamic) {
  $src = $payload.last_assistant_message
  if ($src) { $srcFrom = "payload" }
  if (-not $src -and $payload.transcript_path -and (Test-Path $payload.transcript_path)) {
    try {
      # attachment / file-history-snapshot / system などの非会話エントリが末尾を
      # 埋めると本文が 60 行の外へ押し出される（実測で発生）。後方走査は最初の
      # ヒットで抜けるので、上限を上げても通常ケースのコストは変わらない。
      $lines = Get-Content -LiteralPath $payload.transcript_path -Tail 200 -Encoding UTF8
      for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        $o = $null
        try { $o = $lines[$i] | ConvertFrom-Json } catch { continue }
        if ($o.type -ne "assistant") { continue }
        $t = ($o.message.content | Where-Object { $_.type -eq "text" } | Select-Object -First 1).text
        if ($t) { $src = $t; $srcFrom = "transcript"; break }
      }
    } catch { Write-Log "WARN" ("トランスクリプト読み取り失敗: {0}" -f $_.Exception.Message) }
  }
}

# 定型フレーズを選ぶ。stop だけは「このあと本文を読むか」でサブケースを変える。
# 読まない（読めない）ときに「要点をお伝えします」と言って黙るのを避けるため、
# 本文・抽出結果・ENGINE の生存を確認してから done/ask/trouble を選ぶ。
$phraseName = $Event
$case  = $null
$brief = $false
if ($Event -eq "stop") {
  # サブエージェントを待ったまま終えた応答（「〜を進めています」）は中間報告
  $running = Get-RunningAgents $payload.session_id
  $role = "最終"
  if ($running -gt 0) { Enter-Interim; $role = "中間・実行中{0}件" -f $running }

  $case = "solo"
  if ($src -and (Pick-Sentence $src) -and (Test-EngineAlive)) { $case = Get-StopCase $src }

  # 中間報告で「完了しました」と言わないよう、done / solo の前置きは interim に差し替える。
  # ask / trouble は途中でも対応が要るので、そのまま伝える。
  $pcase = $case
  if ($running -gt 0 -and $case -in @("done","solo")) { $pcase = "interim" }

  # 作業が短いターンは、何をしたか本人にも想像がつく。完了を告げるだけにして
  # 本文は読まない（要約も合成も走らないので、そもそも遅延が生じない）。
  # ただし ask / trouble の別は残す。短くても「返事が要る」「失敗した」は伝わる必要がある。
  $sec = $TurnSec
  $lim = 30
  if ($Cfg.speech.briefMaxSeconds) { $lim = [double]$Cfg.speech.briefMaxSeconds }
  if ($case -ne "solo" -and $null -ne $sec -and $sec -le $lim) {
    $brief = $true
    $phraseName = "stop\brief\$pcase"
  } elseif ($case -eq "solo" -and $pcase -eq "interim") {
    $phraseName = "stop\brief\interim"    # 本文が続かないので「状況をお伝えします」で終わらない短いほう
  } else {
    $phraseName = "stop\$pcase"
  }

  $len = 0
  if ($src) { $len = $src.Length }
  $st = "不明"
  if ($null -ne $sec) { $st = "{0:N1}秒" -f $sec }
  $bm = ""
  if ($brief) { $bm = " (brief)" }
  $cm = $case
  if ($pcase -ne $case) { $cm = "$case→$pcase" }
  Write-Log "INFO" ("本文 {0}字 ({1}) / 作業 {2} / ケース {3}{4} / {5} [{6}]" -f $len, $srcFrom, $st, $cm, $bm, $role, $Speaker)
}
$cannedPath = Get-Phrase $phraseName
if (-not $cannedPath -and $brief) { $cannedPath = Get-Phrase "stop\$pcase" }
# interim が未生成（gen-phrases.ps1 未実行）なら従来のケースに戻す
if (-not $cannedPath -and $Event -eq "stop") { $cannedPath = Get-Phrase "stop\$case" }
if (-not $cannedPath -and $Event -eq "stop") { $cannedPath = Get-Phrase "stop" }
if (-not $cannedPath) {
  Write-Log "WARN" "定型フレーズが未生成。/voice-notify:setup を実行のこと"
  $cannedPath = Get-Phrase "notification"
}

# 短いターンはここで終わり。本文は読まない。
if ($brief) { Play-Wav $cannedPath; exit 0 }

if ($extra) {
  # 短いので要約は不要。定型フレーズと並行して合成する
  $job = Start-Synth $extra
  Play-Wav $cannedPath
  Wait-AndPlay $job
  exit 0
}

if (-not $src) { Play-Wav $cannedPath; exit 0 }

$sum = Find-Summary $src
$text = $null
# 出来上がっている要約（done）はすぐ使い、抜き出しと同じく定型フレーズと並行して合成する
if ($sum -and $sum.Rec.status -eq "done") { $text = Wait-Summary $sum }
if ($sum -and $sum.Rec.status -eq "pending") {
  # 要約は mod が裏で作っている（Haiku で1〜2秒）。先に定型フレーズで気づかせる。
  Play-Wav $cannedPath
  $text = Wait-Summary $sum
  if (-not $text) { $text = Pick-Sentence $src }
  if ($text) { Write-Log "INFO" "読み上げ: $text"; Synth-AndPlay $text }
} else {
  if (-not $text) { $text = Pick-Sentence $src }
  $job = Start-Synth $text          # 定型フレーズと並行して合成
  Play-Wav $cannedPath
  if ($text) { Write-Log "INFO" "読み上げ: $text" }
  Wait-AndPlay $job
}
