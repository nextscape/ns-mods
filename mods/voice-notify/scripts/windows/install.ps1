<#
Registers, removes and reports the task (starts the ENGINE at logon) and the hotkey (toggles mute). The mod (hooks/commands.ts) calls it.
  install.ps1 -Action install -VHome <home> -HotKey <CTRL+ALT+M> [-EnginePath <run.exe>]   no EnginePath: no task (the ENGINE runs elsewhere)
  install.ps1 -Action remove
  install.ps1 -Action status -VHome <home>
Prints one line each: "OK <text>", "WARN <text>", "NG <text>" (the text is shown to the person, in Japanese).
#>
param(
  [ValidateSet("install", "remove", "status")][string]$Action = "status",
  [string]$VHome = "",
  [string]$HotKey = "CTRL+ALT+M",
  [string]$EnginePath = ""
)
# The mod reads the output as UTF-8: write it so, or the Japanese comes out garbled
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
# The names 0.2.0's setup.ps1 used, so what 0.2.0 registered is replaced or removed too
$TaskName = "VOICEVOX ENGINE (voice-notify)"
$LinkPath = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\voice-notify ミュート切替.lnk"
if (-not $VHome) { $VHome = Join-Path $env:USERPROFILE ".claude\voice-notify" }
$BinDir = Join-Path $VHome "bin"
# What the task and the shortcut run. They live in the home, so they keep working when a plugin update moves the plugin
$Copies = @("start-engine.ps1", "toggle.ps1", "play.ps1")

function Test-Stale {
  foreach ($f in $Copies) {
    $dst = Join-Path $BinDir $f
    if (-not (Test-Path -LiteralPath $dst)) { return $true }
    if ((Get-FileHash -LiteralPath $dst).Hash -ne (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $f)).Hash) { return $true }
  }
  return $false
}

if ($Action -eq "status") {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { "OK ログオン時起動タスクあり" }
  else { "WARN ログオン時起動タスクなし（外部の ENGINE を使っていないなら /voice-notify setup で登録）" }
  if (Test-Path -LiteralPath $LinkPath) { "OK ホットキー {0}" -f (New-Object -ComObject WScript.Shell).CreateShortcut($LinkPath).HotKey }
  else { "WARN ホットキーなし（/voice-notify setup で登録）" }
  if (Test-Stale) { "WARN bin のスクリプトがこの版と違う。/voice-notify setup をもう一度実行する" }
  exit 0
}

if ($Action -eq "remove") {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; "OK タスクを外しました" }
  else { "OK タスクはありません" }
  if (Test-Path -LiteralPath $LinkPath) { Remove-Item -LiteralPath $LinkPath -Force; "OK ホットキーを外しました" }
  else { "OK ホットキーはありません" }
  exit 0
}

New-Item -ItemType Directory $BinDir -Force | Out-Null
foreach ($f in $Copies) { Copy-Item (Join-Path $PSScriptRoot $f) (Join-Path $BinDir $f) -Force }

if ($EnginePath) {
  [IO.File]::WriteAllText((Join-Path $BinDir "engine-path.txt"), $EnginePath, (New-Object Text.UTF8Encoding $false))
  # run.exe started directly leaves a console window open: a hidden PowerShell starts it instead
  $action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument ("-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"{0}`" -Quiet" -f (Join-Path $BinDir "start-engine.ps1"))
  $trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force `
    -Description "voice-notify（Claude Code の音声通知）が使う VOICEVOX ENGINE をログオン時に起動する" | Out-Null
  "OK スケジュールタスク '{0}'" -f $TaskName
} else {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
  "OK 外部の ENGINE を使うので、ログオン時の起動は登録しません"
}

# A key given to a Windows shortcut works globally, so it mutes from any window
$sc = (New-Object -ComObject WScript.Shell).CreateShortcut($LinkPath)
$sc.TargetPath       = "powershell.exe"
$sc.Arguments        = ("-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"{0}`"" -f (Join-Path $BinDir "toggle.ps1"))
$sc.WorkingDirectory = $VHome
$sc.IconLocation     = "$env:SystemRoot\System32\SndVol.exe,0"
$sc.WindowStyle      = 7
$sc.HotKey           = $HotKey
$sc.Description      = "voice-notify（Claude Code の音声通知）をミュート/解除する"
$sc.Save()
"OK ホットキー {0}（どのウィンドウからでも効く）" -f $HotKey
