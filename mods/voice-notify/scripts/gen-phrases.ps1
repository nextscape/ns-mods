<#
config.json に従って定型フレーズを VOICEVOX で生成する。

全話者ぶん作るので、config の speaker を書き換えるだけで即座に切り替わる。
Python 依存をなくすため gen_phrases.py から移植した（前提は VOICEVOX と PowerShell だけ）。

  .\gen-phrases.ps1              すべて作り直す（話速などを変えたとき）
  .\gen-phrases.ps1 -IfMissing   足りないものだけ作る（セットアップ用・速い）

生成物:
  phrases/<speaker>/<event>/NN.wav     イベント別の定型フレーズ
  phrases/<speaker>/agent/_default.wav 「エージェントが完了しました。」
  phrases/<speaker>/remain/<n>.wav     「実行中はN件です。」
#>
param(
  [switch]$IfMissing,
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

. (Join-Path $PSScriptRoot "lib.ps1")
$VHome = Get-VoiceHome    # フレーズはホームの phrases\ に作る（プラグイン側には置かない）
Initialize-VoiceHome $VHome (Split-Path -Parent $PSScriptRoot)
$Cfg  = Get-Content (Join-Path $VHome "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$VV   = "http://127.0.0.1:$($Cfg.enginePort)"
$made = 0
$kept = 0

function Write-Phrase([string]$Path, [string]$Text, [int]$Sid) {
  if ($IfMissing -and (Test-Path $Path)) { $script:kept++; return }
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory $dir -Force | Out-Null }

  $q = Invoke-RestMethod -Method Post -TimeoutSec 60 `
         -Uri ("{0}/audio_query?text={1}&speaker={2}" -f $VV, [uri]::EscapeDataString($Text), $Sid)
  $q.speedScale      = $Cfg.speedScale
  $q.pitchScale      = $Cfg.pitchScale
  $q.intonationScale = $Cfg.intonationScale
  $body = [Text.Encoding]::UTF8.GetBytes(($q | ConvertTo-Json -Depth 10 -Compress))
  Invoke-WebRequest -Method Post -TimeoutSec 180 -Uri ("{0}/synthesis?speaker={1}" -f $VV, $Sid) `
    -Body $body -ContentType "application/json" -OutFile $Path | Out-Null

  $script:made++
  if (-not $Quiet) {
    Write-Output ("  {0,-42} {1}" -f $Path.Substring($VHome.Length + 1), $Text)
  }
}

# フレーズ定義は配列（<dir>/NN.wav）か、サブディレクトリに分けるオブジェクト。
# stop は done/ask/trouble/solo に分かれ、さらに brief/<case> と2段になる。
function Write-PhraseTree($Node, [string]$Dir, [int]$Sid) {
  if ($Node -is [array]) {
    $i = 0
    foreach ($t in $Node) { $i++; Write-Phrase (Join-Path $Dir ("{0:D2}.wav" -f $i)) $t $Sid }
    return
  }
  # 配列からオブジェクトに変えた階層は、直下に残った旧 wav が Get-Phrase の
  # フォールバック先として生き続ける。作り直しのときに掃除する（再帰はしない）。
  if (-not $IfMissing) {
    Get-ChildItem $Dir -Filter *.wav -ErrorAction SilentlyContinue |
      Remove-Item -Force -ErrorAction SilentlyContinue
  }
  foreach ($k in $Node.PSObject.Properties.Name) {
    Write-PhraseTree $Node.$k (Join-Path $Dir $k) $Sid
  }
}

# ENGINE が動いていないと何も作れない
try { Invoke-RestMethod -Uri "$VV/version" -TimeoutSec 5 | Out-Null }
catch {
  Write-Output "VOICEVOX ENGINE に接続できません ($VV)。/voice-notify:setup を実行して ENGINE を起動してください。"
  exit 1
}

$SA = $Cfg.subagent
foreach ($spk in $Cfg.speakers.PSObject.Properties.Name) {
  $sid = $Cfg.speakers.$spk.id

  # イベント別の定型フレーズ（入れ子は Write-PhraseTree が再帰でたどる）
  foreach ($event in $Cfg.phrases.PSObject.Properties.Name) {
    Write-PhraseTree $Cfg.phrases.$event (Join-Path $VHome ("phrases\{0}\{1}" -f $spk, $event)) $sid
  }
  if (-not $SA) { continue }

  # 説明も報告も取れなかったときのフォールバック
  $labels = @{ "_default" = $SA.defaultLabel }
  if ($SA.labels) {
    foreach ($k in $SA.labels.PSObject.Properties.Name) { $labels[$k] = $SA.labels.$k }
  }
  foreach ($k in $labels.Keys) {
    Write-Phrase (Join-Path $VHome ("phrases\{0}\agent\{1}.wav" -f $spk, $k)) ("{0}が完了しました。" -f $labels[$k]) $sid
  }

  # 同時に走っている他エージェントの数。
  # hook は「これから何件起動するか」を知らないので「残り」とは言えない。
  $mx = [int]$SA.maxRemainSpoken
  Write-Phrase (Join-Path $VHome ("phrases\{0}\remain\0.wav" -f $spk)) "実行中はありません。" $sid
  for ($n = 1; $n -le $mx; $n++) {
    Write-Phrase (Join-Path $VHome ("phrases\{0}\remain\{1}.wav" -f $spk, $n)) ("実行中は{0}件です。" -f $n) $sid
  }
  Write-Phrase (Join-Path $VHome ("phrases\{0}\remain\many.wav" -f $spk)) "実行中は多数あります。" $sid
}

Write-Output ("完了: 生成 {0} 件 / 既存流用 {1} 件" -f $made, $kept)
