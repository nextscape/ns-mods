<#
launch.ps1 の Find-LatestPlugin の検証。プラグインは更新のたびにキャッシュへ版ごとのフォルダが増え、
古い版も残るので、ホットキーやログオン時のタスクは常に最新の版を呼ぶ必要がある。

  .\test-launch.ps1
#>
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Get-Content (Join-Path (Split-Path -Parent $Here) "scripts\launch.ps1") -Raw -Encoding UTF8
$m    = [regex]::Match($src, '(?s)function Find-LatestPlugin\b.*?\n\}')
if (-not $m.Success) { "NG  Find-LatestPlugin が見つからない"; exit 1 }
. ([scriptblock]::Create($m.Value))

$Tmp = Join-Path $env:TEMP ("voice-notify-launch-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
function New-Version([string]$mkt, [string]$ver) {
  $d = Join-Path $Tmp "cache\$mkt\voice-notify\$ver\scripts"
  New-Item -ItemType Directory $d -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $d "notify.ps1") -Value "#" -Encoding UTF8
}

$total = 0; $ng = 0
function Check([string]$name, $got, $want) {
  $script:total++
  if ($got -eq $want) { "ok  $name" } else { "NG  {0}: got [{1}] want [{2}]" -f $name, $got, $want; $script:ng++ }
}

try {
  Check "何も無ければ null" (Find-LatestPlugin $Tmp) $null

  New-Version "nextscape-mods" "0.1.0"
  New-Version "nextscape-mods" "0.10.0"
  New-Version "nextscape-mods" "0.9.1"
  Check "版は数値で比べて最新を選ぶ（0.10.0 > 0.9.1）" (Find-LatestPlugin $Tmp) (Join-Path $Tmp "cache\nextscape-mods\voice-notify\0.10.0")

  New-Item -ItemType Directory (Join-Path $Tmp "cache\nextscape-mods\voice-notify\0.11.0") -Force | Out-Null
  Check "scripts\notify.ps1 が無い版（展開途中など）は選ばない" (Find-LatestPlugin $Tmp) (Join-Path $Tmp "cache\nextscape-mods\voice-notify\0.10.0")

  New-Version "other-mkt" "1.0.0"
  Check "別のマーケットプレイスからの導入も探す" (Find-LatestPlugin $Tmp) (Join-Path $Tmp "cache\other-mkt\voice-notify\1.0.0")
}
catch { $ng++; "NG  例外で中断: {0}" -f $_.Exception.Message }
finally {
  if ($Tmp -like "*voice-notify-launch-*") { Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

""
if ($ng -eq 0) { "全 {0} 件 合格" -f $total } else { "全 {0} 件中 {1} 件 不合格" -f $total, $ng; exit 1 }
