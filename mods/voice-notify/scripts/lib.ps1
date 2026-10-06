<#
notify.ps1 が使う共有部品。
ドットソースで読み込む:  . (Join-Path $PSScriptRoot "lib.ps1")

要約は mod（hooks/register.ts）が作る。ここにはホームの解決と読み上げ前の整形を置く。
#>

# 設定と状態の置き場所（ホーム）。プラグイン本体は更新で置き換わるので、その外に置く。
# mod の voiceHome と同じ規則: VOICE_NOTIFY_HOME、無ければ ~/.claude/voice-notify
# VOICE_NOTIFY_HOME は絶対パスで指定する（相対だと mod と hook で基準のフォルダが違う）。末尾の区切りは落とす
function Get-VoiceHome {
  $h = "$env:VOICE_NOTIFY_HOME".Trim().TrimEnd('\', '/')
  if ($h) { return $h }
  Join-Path $env:USERPROFILE ".claude\voice-notify"
}

# 初回: ホームを作り、同梱の既定設定をコピーする（利用者が書き換えた config.json は上書きしない）。
# state/summaries は要約 mod の書き込み先。mod の $.fs にはフォルダを作る手段が無いので、ここで作っておく。
# 初回のターンでは複数の hook が同時に動くので、一時ファイルに書いてから名前を変える
# （書きかけの config.json を別の hook が読んで落ちないように）。先に置かれていればそれを使う
function Initialize-VoiceHome([string]$VHome, [string]$PluginRoot) {
  foreach ($d in @($VHome, (Join-Path $VHome "state"), (Join-Path $VHome "state\summaries"))) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory $d -Force | Out-Null }
  }
  $cfg = Join-Path $VHome "config.json"
  if (Test-Path $cfg) { return }
  $tmp = "$cfg.$PID.tmp"
  try {
    Copy-Item (Join-Path $PluginRoot "config.default.json") $tmp -Force
    Move-Item -LiteralPath $tmp $cfg -ErrorAction Stop
  } catch {
    # 別の hook が先に置いた
  } finally {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
  }
}

# 読み上げ前の掃除。「記号は使わない」と指示しても本文の Markdown を写してくることがある。
function Clear-SpeechText([string]$t) {
  if (-not $t) { return $null }
  [regex]::Replace(($t -replace '[`*_#>|\[\]]', ' '), '\s+', ' ').Trim()
}