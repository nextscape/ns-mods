<#
setup.ps1 の Get-LegacyFiles（旧 claude-voice の名残のうち、~/.claude 配下のファイルにあるもの）の検証。
名残が残っていると公開版と二重に鳴る（または壊れた旧コマンドが残る）。利用者の ~/.claude には触れない。

  .\test-setup.ps1
#>
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Get-Content (Join-Path (Split-Path -Parent $Here) "scripts\setup.ps1") -Raw -Encoding UTF8
$m    = [regex]::Match($src, '(?s)function Get-LegacyFiles\b.*?\n\}')
if (-not $m.Success) { "NG  Get-LegacyFiles が見つからない"; exit 1 }
. ([scriptblock]::Create($m.Value))

$Tmp = Join-Path $env:TEMP ("voice-notify-setup-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$total = 0; $ng = 0
function Check([string]$name, [bool]$cond, [string]$detail) {
  $script:total++
  if ($cond) { "ok  $name" } else { "NG  $name  $detail"; $script:ng++ }
}

try {
  New-Item -ItemType Directory (Join-Path $Tmp "commands") -Force | Out-Null
  Check "何も無ければ空" (@(Get-LegacyFiles $Tmp).Count -eq 0)

  $settings = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"& ''C:\\x\\tools\\claude-voice\\notify.ps1'' -Event stop"}]}]},' +
              '"env":{"CLAUDE_CODE_PLUGIN_DIRS":"C:/a/effort-router;C:/x/tools/claude-voice/mod"}}'
  [IO.File]::WriteAllText((Join-Path $Tmp "settings.json"), $settings, (New-Object Text.UTF8Encoding $false))
  [IO.File]::WriteAllText((Join-Path $Tmp "commands\voice.md"), "!``powershell -File ""C:\x\tools\claude-voice\voice.ps1"" `$ARGUMENTS``", (New-Object Text.UTF8Encoding $false))
  $got = @(Get-LegacyFiles $Tmp)
  Check "settings.json の旧 hook を見つける" (@($got -match 'hook').Count -eq 1) ($got -join ' / ')
  Check "settings.json の旧 CLAUDE_CODE_PLUGIN_DIRS を見つける" (@($got -match 'CLAUDE_CODE_PLUGIN_DIRS').Count -eq 1) ($got -join ' / ')
  Check "旧 /voice コマンド（commands\voice.md）を見つける" (@($got -match 'voice\.md').Count -eq 1) ($got -join ' / ')

  # 公開版だけなら何も出ない（effort-router など他の登録には反応しない）
  [IO.File]::WriteAllText((Join-Path $Tmp "settings.json"), '{"env":{"CLAUDE_CODE_PLUGIN_DIRS":"C:/a/effort-router"}}', (New-Object Text.UTF8Encoding $false))
  [IO.File]::WriteAllText((Join-Path $Tmp "commands\voice.md"), "利用者が自作した別の /voice", (New-Object Text.UTF8Encoding $false))
  Check "他の登録や自作の /voice には反応しない" (@(Get-LegacyFiles $Tmp).Count -eq 0) ((@(Get-LegacyFiles $Tmp)) -join ' / ')
}
catch { $ng++; "NG  例外で中断: {0}" -f $_.Exception.Message }
finally {
  if ($Tmp -like "*voice-notify-setup-*") { Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

""
if ($ng -eq 0) { "全 {0} 件 合格" -f $total } else { "全 {0} 件中 {1} 件 不合格" -f $total, $ng; exit 1 }
