<#
notify.ps1 が使う共有部品。
ドットソースで読み込む:  . (Join-Path $PSScriptRoot "lib.ps1")

要約は mod（mod/、voice-summary）が作る。ここには読み上げ前の整形だけを置く。
#>

# 読み上げ前の掃除。「記号は使わない」と指示しても本文の Markdown を写してくることがある。
function Clear-SpeechText([string]$t) {
  if (-not $t) { return $null }
  [regex]::Replace(($t -replace '[`*_#>|\[\]]', ' '), '\s+', ' ').Trim()
}