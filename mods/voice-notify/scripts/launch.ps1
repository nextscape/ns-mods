<#
ホットキー・ログオン時のタスクから呼ばれる、版に依存しない入口。
/voice-notify:setup が ~/.claude/voice-notify/bin/ にコピーする（ホームは更新・撤去で消えない）。

  launch.ps1 -Action engine   VOICEVOX ENGINE を起動（ログオン時）
  launch.ps1 -Action toggle   ミュート切替（ホットキー）

プラグインは更新のたびに ~/.claude/plugins/cache/<marketplace>/voice-notify/<版>/ が増え、
古い版も残る。ここから最新の版を探して呼ぶので、更新してもホットキーやタスクが切れない。
#>
param([ValidateSet("engine", "toggle")][string]$Action = "toggle")

function Find-LatestPlugin([string]$PluginsDir) {
  $hits = @(Get-ChildItem (Join-Path $PluginsDir "cache") -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ChildItem (Join-Path $_.FullName "voice-notify") -Directory -ErrorAction SilentlyContinue } |
    Where-Object { Test-Path (Join-Path $_.FullName "scripts\notify.ps1") } |
    Sort-Object { try { [version]$_.Name } catch { [version]"0.0" } } -Descending)
  if ($hits.Count) { return $hits[0].FullName }
  return $null
}

$root = Find-LatestPlugin (Join-Path $env:USERPROFILE ".claude\plugins")
if (-not $root) { exit 0 }
if ($Action -eq "engine") { & (Join-Path $root "scripts\start-engine.ps1") -Quiet }
else { & (Join-Path $root "scripts\notify.ps1") -Event toggle }
