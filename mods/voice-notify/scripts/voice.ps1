<#
音声通知のミュート操作の入り口。/voice-notify:voice から呼ばれる。

  voice.ps1            切替
  voice.ps1 on         再開
  voice.ps1 off        停止
  voice.ps1 status     現在の状態
#>
param([string]$Action = "toggle")

$map = @{
  ""       = "toggle"
  "toggle" = "toggle"
  "on"     = "unmute"
  "unmute" = "unmute"
  "off"    = "mute"
  "mute"   = "mute"
  "status" = "status"
}
$key = $Action.ToLower().Trim()
if (-not $map.ContainsKey($key)) {
  Write-Output ("知らない引数です: {0}。使い方: /voice-notify:voice [on|off|status]（省略時は切替）" -f $Action)
  exit 1
}
& (Join-Path $PSScriptRoot "notify.ps1") -Event $map[$key]
