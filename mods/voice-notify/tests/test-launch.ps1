<#
launch.ps1 の Resolve-PluginRoot の検証。プラグインは更新のたびに置き場所（キャッシュの版フォルダ）が変わり、
古い版も残る。版の名前は数字とは限らない（git のハッシュや unknown のこともある）ので、
ホットキーやログオン時のタスクは次の順に「いま使われている版」を探す。
  1. ~/.claude/plugins/installed_plugins.json の voice-notify@* の installPath（lastUpdated が新しいもの）
  2. setup が書き残した bin\plugin-root.txt
  3. キャッシュの版フォルダ（版を数値として比べられるものの最新）

  .\test-launch.ps1
#>
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Get-Content (Join-Path (Split-Path -Parent $Here) "scripts\launch.ps1") -Raw -Encoding UTF8
foreach ($fn in "Test-PluginRoot", "Find-CachedPlugin", "Resolve-PluginRoot") {
  $m = [regex]::Match($src, "(?s)function $fn\b.*?\n\}")
  if (-not $m.Success) { "NG  $fn が見つからない"; exit 1 }
  . ([scriptblock]::Create($m.Value))
}

$Tmp = Join-Path $env:TEMP ("voice-notify-launch-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$Plugins = Join-Path $Tmp "plugins"
$Json = Join-Path $Plugins "installed_plugins.json"
$Hint = Join-Path $Tmp "home\bin\plugin-root.txt"
function New-Root([string]$rel) {
  $d = Join-Path $Tmp $rel
  New-Item -ItemType Directory (Join-Path $d "scripts") -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $d "scripts\notify.ps1") -Value "#" -Encoding UTF8
  $d
}
function Write-Installed($entries) {
  New-Item -ItemType Directory $Plugins -Force | Out-Null
  $o = @{ version = 2; plugins = @{ "voice-notify@nextscape-mods" = @($entries); "other@x" = @(@{ installPath = "C:\nowhere" }) } }
  [IO.File]::WriteAllText($Json, ($o | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding $false))
}

$total = 0; $ng = 0
function Check([string]$name, $got, $want) {
  $script:total++
  if ($got -eq $want) { "ok  $name" } else { "NG  {0}: got [{1}] want [{2}]" -f $name, $got, $want; $script:ng++ }
}

try {
  Check "何も無ければ null" (Resolve-PluginRoot $Plugins $Hint) $null

  # 3. キャッシュだけ（一覧も手がかりも無い）
  New-Root "plugins\cache\nextscape-mods\voice-notify\0.9.1" | Out-Null
  $c10 = New-Root "plugins\cache\nextscape-mods\voice-notify\0.10.0"
  New-Item -ItemType Directory (Join-Path $Plugins "cache\nextscape-mods\voice-notify\0.11.0") -Force | Out-Null
  Check "キャッシュ: 版を数値で比べ、scripts の無い版は選ばない" (Resolve-PluginRoot $Plugins $Hint) $c10

  # 2. setup の手がかりがキャッシュより優先
  $local = New-Root "src\ns-mods\mods\voice-notify"
  New-Item -ItemType Directory (Split-Path -Parent $Hint) -Force | Out-Null
  Set-Content -LiteralPath $Hint -Value $local -Encoding UTF8
  Check "手がかり（plugin-root.txt）があればそれを使う" (Resolve-PluginRoot $Plugins $Hint) $local

  # 1. 一覧が最優先。版の名前がハッシュでも lastUpdated で新しい方を選ぶ
  $old = New-Root "plugins\cache\nextscape-mods\voice-notify\b36fd4b75301"
  $new = New-Root "plugins\cache\nextscape-mods\voice-notify\unknown"
  Write-Installed @(
    @{ scope = "user"; installPath = $old; version = "b36fd4b75301"; lastUpdated = "2026-10-01T00:00:00.000Z" },
    @{ scope = "user"; installPath = $new; version = "unknown";      lastUpdated = "2026-10-07T00:00:00.000Z" })
  Check "一覧の installPath（lastUpdated が新しいもの）を使う" (Resolve-PluginRoot $Plugins $Hint) $new

  # 一覧の場所が消えていたら次の手がかりへ
  Remove-Item -LiteralPath $new, $old -Recurse -Force
  Check "一覧の場所が無ければ手がかりへ" (Resolve-PluginRoot $Plugins $Hint) $local
}
catch { $ng++; "NG  例外で中断: {0}" -f $_.Exception.Message }
finally {
  if ($Tmp -like "*voice-notify-launch-*") { Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

""
if ($ng -eq 0) { "全 {0} 件 合格" -f $total } else { "全 {0} 件中 {1} 件 不合格" -f $total, $ng; exit 1 }
