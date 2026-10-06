<#
notify.ps1 が使う共有部品。
ドットソースで読み込む:  . (Join-Path $PSScriptRoot "lib.ps1")

要約は mod（hooks/register.ts）が作る。ここにはホームの解決と読み上げ前の整形を置く。
#>

# 設定と状態の置き場所（ホーム）。プラグイン本体は更新で置き換わるので、その外に置く。
# mod の voiceHome と同じ規則: VOICE_NOTIFY_HOME、無ければ ~/.claude/voice-notify
function Get-VoiceHome {
  $h = "$env:VOICE_NOTIFY_HOME".Trim()
  if ($h) { return $h }
  Join-Path $env:USERPROFILE ".claude\voice-notify"
}

# 初回: ホームを作り、同梱の既定設定をコピーする（利用者が書き換えた config.json は上書きしない）
function Initialize-VoiceHome([string]$VHome, [string]$PluginRoot) {
  foreach ($d in @($VHome, (Join-Path $VHome "state"))) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory $d -Force | Out-Null }
  }
  $cfg = Join-Path $VHome "config.json"
  if (-not (Test-Path $cfg)) { Copy-Item (Join-Path $PluginRoot "config.default.json") $cfg }
}

# 読み上げ前の掃除。「記号は使わない」と指示しても本文の Markdown を写してくることがある。
function Clear-SpeechText([string]$t) {
  if (-not $t) { return $null }
  [regex]::Replace(($t -replace '[`*_#>|\[\]]', ' '), '\s+', ' ').Trim()
}