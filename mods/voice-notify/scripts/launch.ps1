<#
ホットキー・ログオン時のタスクから呼ばれる、版に依存しない入口。
/voice-notify:setup が ~/.claude/voice-notify/bin/ にコピーする（ホームは更新・撤去で消えない）。

  launch.ps1 -Action engine   VOICEVOX ENGINE を起動（ログオン時）
  launch.ps1 -Action toggle   ミュート切替（ホットキー）

プラグインは更新のたびに置き場所（キャッシュの版フォルダ）が変わり、古い版も残る。
版の名前は数字とは限らない（git のハッシュや unknown のこともある）ので、次の順に「いま使われている版」を探す。
  1. ~/.claude/plugins/installed_plugins.json の voice-notify@* の installPath（lastUpdated が新しいもの）
  2. setup が書き残した bin\plugin-root.txt（手元のフォルダから入れた場合など）
  3. キャッシュの版フォルダ（版を数値として比べられるものの最新）
#>
param([ValidateSet("engine", "toggle")][string]$Action = "toggle")

function Test-PluginRoot([string]$Root) {
  return [bool]($Root -and (Test-Path -LiteralPath (Join-Path $Root "scripts\notify.ps1")))
}

function Find-CachedPlugin([string]$PluginsDir) {
  $hits = @(Get-ChildItem (Join-Path $PluginsDir "cache") -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ChildItem (Join-Path $_.FullName "voice-notify") -Directory -ErrorAction SilentlyContinue } |
    Where-Object { Test-PluginRoot $_.FullName } |
    Sort-Object { try { [version]$_.Name } catch { [version]"0.0" } } -Descending)
  if ($hits.Count) { return $hits[0].FullName }
  return $null
}

function Resolve-PluginRoot([string]$PluginsDir, [string]$HintFile) {
  $json = Join-Path $PluginsDir "installed_plugins.json"
  if (Test-Path -LiteralPath $json) {
    try {
      $installed = Get-Content -LiteralPath $json -Raw -Encoding UTF8 | ConvertFrom-Json
      $entries = @($installed.plugins.PSObject.Properties | Where-Object { $_.Name -like "voice-notify@*" } |
        ForEach-Object { @($_.Value) } | Where-Object { Test-PluginRoot $_.installPath } |
        Sort-Object { [string]$_.lastUpdated } -Descending)
      if ($entries.Count) { return $entries[0].installPath }
    } catch { }
  }
  if ($HintFile -and (Test-Path -LiteralPath $HintFile)) {
    $hint = "$(Get-Content -LiteralPath $HintFile -Raw -Encoding UTF8)".Trim()
    if (Test-PluginRoot $hint) { return $hint }
  }
  return (Find-CachedPlugin $PluginsDir)
}

$VHome = "$env:VOICE_NOTIFY_HOME".Trim()
if (-not $VHome) { $VHome = Join-Path $env:USERPROFILE ".claude\voice-notify" }
$root = Resolve-PluginRoot (Join-Path $env:USERPROFILE ".claude\plugins") (Join-Path $VHome "bin\plugin-root.txt")
if (-not $root) {
  try {
    ("{0}  ERR  launch      voice-notify のプラグインが見つからない（/plugin install のあと /voice-notify:setup を実行）" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss")) |
      Add-Content -LiteralPath (Join-Path $VHome "notify.log") -Encoding UTF8
  } catch { }
  exit 0
}
if ($Action -eq "engine") { & (Join-Path $root "scripts\start-engine.ps1") -Quiet }
else { & (Join-Path $root "scripts\notify.ps1") -Event toggle }
