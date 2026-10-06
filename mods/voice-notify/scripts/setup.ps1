<#
claude-voice の導入・撤去・診断。何度実行しても同じ状態になる（冪等）。

  .\setup.ps1              導入（既に入っているものは飛ばす）
  .\setup.ps1 -Doctor      診断だけ。鳴らないときの切り分けに使う
  .\setup.ps1 -Remove      撤去（hook・タスク・ショートカット・スラッシュコマンド）
  .\setup.ps1 -Force       フレーズを作り直す（話速などを変えたとき）

やること:
  1. VOICEVOX の確認（無ければ winget で導入するか尋ねる）
  2. VOICEVOX ENGINE の起動
  3. 定型フレーズの生成
  4. Claude Code への登録（settings.json。hook と、要約 mod の env.CLAUDE_CODE_PLUGIN_DIRS。パスはこのスクリプトの位置から決まる）
  5. /voice スラッシュコマンドの生成
  6. ログオン時に ENGINE を起動するタスクの登録
  7. ミュート切替のホットキー

管理者権限は不要。すべてユーザー領域で完結する。
#>
param(
  [switch]$Remove,
  [switch]$Doctor,
  [switch]$Force,
  [switch]$InstallVoicevox,
  [string]$HotKey = "CTRL+ALT+M"
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$Here      = $PSScriptRoot
$Notify    = Join-Path $Here "notify.ps1"
$VoiceCli  = Join-Path $Here "voice.ps1"
$Cfg       = Get-Content (Join-Path $Here "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$Port      = $Cfg.enginePort
$TaskName  = "VOICEVOX ENGINE (claude-voice)"
$ClaudeDir = Join-Path $env:USERPROFILE ".claude"
$Settings  = Join-Path $ClaudeDir "settings.json"
$CmdFile   = Join-Path $ClaudeDir "commands\voice.md"
$LinkPath  = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Claude 音声通知 ミュート切替.lnk"
$ModDir    = Join-Path $Here "mod"           # 要約 mod（voice-summary）
$MinClaude = "2.1.291"                       # mod の API を確認した Claude Code の版

# Write-Output だと関数の戻り値に混ざる。
# 実際 Update-Hooks が @("OK ...", $false) を返し、配列は真なので失敗を握り潰していた。
# 画面向けの文字は Write-Host に流して戻り値と分離する。
function Step([string]$m) { Write-Host ""; Write-Host ("== " + $m) }
function Ok([string]$m)   { Write-Host ("   OK   " + $m) }
function Warn([string]$m) { Write-Host ("   注意 " + $m) }
function Ng([string]$m)   { Write-Host ("   NG   " + $m) }

# $obj.PSObject.Properties.Name はプロパティが0個だと $null になり、@() で包むと $null 1個の配列になる。
# 実際 hooks が無い settings.json で $hooks.$null への代入が走って落ちた。プロパティを列挙してから名前を取る。
function Get-PropNames($obj) {
  if ($null -eq $obj) { return @() }
  @($obj.PSObject.Properties | ForEach-Object { $_.Name })
}

function Test-Engine {
  try { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/version" -TimeoutSec 3 | Out-Null; return $true }
  catch { return $false }
}

function Find-EngineExe {
  if ($Cfg.enginePath -and (Test-Path $Cfg.enginePath)) { return $Cfg.enginePath }
  $cands = @(
    "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\HiroshibaKazuyuki.VOICEVOX*\VOICEVOX\vv-engine\run.exe",
    "$env:LOCALAPPDATA\Programs\VOICEVOX\vv-engine\run.exe",
    "$env:ProgramFiles\VOICEVOX\vv-engine\run.exe"
  )
  foreach ($c in $cands) {
    $hit = @(Get-ChildItem -Path $c -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($hit.Count) { return $hit[0].FullName }
  }
  return $null
}

# ---------------------------------------------------------------- hook 定義
# 絶対パスはこのスクリプトの位置から組み立てる。別PCでもそのまま通る。
function New-HookEntry([string]$Ev, [int]$Timeout, [string]$Matcher) {
  $h = [ordered]@{}
  if ($Matcher) { $h["matcher"] = $Matcher }
  $h["hooks"] = @([ordered]@{
    type    = "command"
    shell   = "powershell"
    command = "& '$Notify' -Event $Ev"
    async   = $true
    timeout = $Timeout
  })
  [pscustomobject]$h
}

function Get-DesiredHooks {
  [ordered]@{
    UserPromptSubmit = @(New-HookEntry "promptsubmit" 10 $null)
    Stop          = @(New-HookEntry "stop" 120 $null)
    StopFailure   = @(New-HookEntry "failure" 60 $null)
    Notification  = @(
      New-HookEntry "permission"   60 "permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input"
      New-HookEntry "idle"         60 "idle_prompt"
      New-HookEntry "notification" 60 "quota_auto_resume_fired|quota_auto_resume_stale|quota_auto_resume_disabled"
    )
    TaskCompleted = @(New-HookEntry "task" 60 $null)
    SubagentStart = @(New-HookEntry "agentstart" 30 $null)
    SubagentStop  = @(New-HookEntry "agentstop" 60 $null)
  }
}

# このツールが入れたエントリだけを見分ける（他の hook を巻き込まないため）
function Test-OurEntry($entry) {
  foreach ($h in $entry.hooks) {
    if ($h.command -and $h.command -like "*claude-voice*notify.ps1*") { return $true }
  }
  return $false
}

# env.CLAUDE_CODE_PLUGIN_DIRS（; 区切り）に要約 mod を足す／外す。他の mod（effort-router など）は残す。
# 比較はスラッシュの向き・末尾のスラッシュ・大文字小文字を無視する。戻り値が $null なら変数ごと消す。
function Get-PluginDirsValue([string]$Current, [string]$Dir, [switch]$Uninstall) {
  $mine = ($Dir -replace '\\', '/').TrimEnd('/').ToLowerInvariant()
  $kept = @(($Current -split ';') | ForEach-Object { $_.Trim() } | Where-Object {
      $_ -and ((($_ -replace '\\', '/').TrimEnd('/').ToLowerInvariant()) -ne $mine)
    })
  if (-not $Uninstall) { $kept += ($Dir -replace '\\', '/').TrimEnd('/') }
  if ($kept.Count -eq 0) { return $null }
  return ($kept -join ';')
}

# settings.json（$json）の env.CLAUDE_CODE_PLUGIN_DIRS を直す。env が空になったら env ごと消す
# （解除したあとに "env": {} を残さない。元から env が無ければ作らない）
function Update-PluginDirsEnv($json, [string]$Dir, [switch]$Uninstall) {
  if (@(Get-PropNames $json) -notcontains "env") {
    if ($Uninstall) { return }
    $json | Add-Member -NotePropertyName env -NotePropertyValue ([pscustomobject]@{})
  }
  $dirs = Get-PluginDirsValue ([string]$json.env.CLAUDE_CODE_PLUGIN_DIRS) $Dir -Uninstall:$Uninstall
  if ($null -eq $dirs) {
    $json.env.PSObject.Properties.Remove("CLAUDE_CODE_PLUGIN_DIRS")
  } elseif (@(Get-PropNames $json.env) -contains "CLAUDE_CODE_PLUGIN_DIRS") {
    $json.env.CLAUDE_CODE_PLUGIN_DIRS = $dirs
  } else {
    $json.env | Add-Member -NotePropertyName CLAUDE_CODE_PLUGIN_DIRS -NotePropertyValue $dirs
  }
  if (@(Get-PropNames $json.env).Count -eq 0) { $json.PSObject.Properties.Remove("env") }
}

function Test-ModRegistered($json) {
  if ($null -eq $json -or $null -eq $json.env) { return $false }
  $mine = ($ModDir -replace '\\', '/').TrimEnd('/').ToLowerInvariant()
  $hit = @(([string]$json.env.CLAUDE_CODE_PLUGIN_DIRS -split ';') | Where-Object {
      (($_.Trim() -replace '\\', '/').TrimEnd('/').ToLowerInvariant()) -eq $mine
    })
  return ($hit.Count -gt 0)
}

function Update-Hooks([switch]$Uninstall) {
  if (-not (Test-Path $Settings)) {
    Ng "settings.json が無い: $Settings"
    return $false
  }
  $backup = "$Settings.bak-{0}" -f (Get-Date -Format "yyyyMMdd-HHmmss")
  Copy-Item $Settings $backup

  $raw  = Get-Content $Settings -Raw -Encoding UTF8
  $json = $raw | ConvertFrom-Json
  $keysBefore = @(Get-PropNames $json)

  if ($keysBefore -notcontains "hooks") {
    $json | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{})
  }
  $hooks = $json.hooks

  # 既存の自前エントリを取り除く（再実行で二重登録しないため）
  foreach ($ev in @(Get-PropNames $hooks)) {
    $kept = @($hooks.$ev | Where-Object { -not (Test-OurEntry $_) })
    if ($kept.Count) { $hooks.$ev = $kept }
    else { $hooks.PSObject.Properties.Remove($ev) }
  }

  if (-not $Uninstall) {
    $desired = Get-DesiredHooks
    foreach ($ev in $desired.Keys) {
      if (@(Get-PropNames $hooks) -contains $ev) {
        $hooks.$ev = @($hooks.$ev) + $desired[$ev]
      } else {
        $hooks | Add-Member -NotePropertyName $ev -NotePropertyValue $desired[$ev]
      }
    }
  }

  # 要約 mod の登録（env.CLAUDE_CODE_PLUGIN_DIRS）。新しく開いたセッションから読み込まれる
  Update-PluginDirsEnv $json $ModDir -Uninstall:$Uninstall

  # Set-Content -Encoding UTF8 は PowerShell 5.1 だと BOM を付ける。
  # settings.json は Node が読むので BOM 付き JSON は解析に失敗しうる。BOM 無しで書く。
  [IO.File]::WriteAllText($Settings, ($json | ConvertTo-Json -Depth 100), (New-Object Text.UTF8Encoding $false))

  # 書き戻しで壊していないことを必ず確かめる。壊していたら元に戻す。
  try {
    $after = Get-Content $Settings -Raw -Encoding UTF8 | ConvertFrom-Json
    $keysAfter = @(Get-PropNames $after)
    $lost = @($keysBefore | Where-Object { $keysAfter -notcontains $_ })
    if ($lost.Count) { throw ("設定キーが消えた: " + ($lost -join ", ")) }
    if (-not $Uninstall) {
      $n = 0
      foreach ($ev in @(Get-PropNames $after.hooks)) {
        $n += @($after.hooks.$ev | Where-Object { Test-OurEntry $_ }).Count
      }
      if ($n -lt 6) { throw "hook の登録数が足りない ($n)" }
      if (-not (Test-ModRegistered $after)) { throw "要約 mod が CLAUDE_CODE_PLUGIN_DIRS に入っていない" }
    }
  } catch {
    Copy-Item $backup $Settings -Force
    Ng ("settings.json の更新に失敗したので元に戻した: {0}" -f $_.Exception.Message)
    return $false
  }
  Ok ("settings.json を更新（控え: {0}）" -f (Split-Path $backup -Leaf))
  return $true
}

# ================================================================ 撤去
if ($Remove) {
  Step "撤去"
  Update-Hooks -Uninstall | Out-Null
  Ok "要約 mod の登録（CLAUDE_CODE_PLUGIN_DIRS）を解除"
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Ok "スケジュールタスクを削除"
  Remove-Item -LiteralPath $LinkPath -Force -ErrorAction SilentlyContinue
  Ok "ホットキーのショートカットを削除"
  Remove-Item -LiteralPath $CmdFile -Force -ErrorAction SilentlyContinue
  Ok "/voice スラッシュコマンドを削除"
  Write-Output ""
  Write-Output "残したもの: $Here 配下（設定・フレーズ・mod）。不要なら手で削除する。"
  exit 0
}

# ================================================================ 診断
if ($Doctor) {
  Write-Output "claude-voice 診断"
  Write-Output ("場所: {0}" -f $Here)

  Step "VOICEVOX"
  $exe = Find-EngineExe
  if ($exe) { Ok $exe } else { Ng "run.exe が見つからない。winget install HiroshibaKazuyuki.VOICEVOX.CPU" }
  if (Test-Engine) {
    Ok "ENGINE 応答あり (port $Port)"
    # 0.24 未満は辞書に無い英単語を1文字ずつ読む（Task → ティイエエエスケエ）
    try {
      $v = [string](Invoke-RestMethod -Uri "http://127.0.0.1:$Port/version" -TimeoutSec 3)
      if ([version]($v -replace '[^0-9.].*$', '') -lt [version]"0.24") {
        Warn "ENGINE $v は英単語を1文字ずつ読む。0.24 以降を推奨（winget upgrade HiroshibaKazuyuki.VOICEVOX.CPU）"
      } else { Ok "ENGINE $v（英単語のカタカナ読みあり）" }
    } catch { Warn ("ENGINE のバージョンを判定できない: {0}" -f $_.Exception.Message) }
  } else { Ng "ENGINE が応答しない (port $Port)。start-engine.ps1 を実行" }

  Step "定型フレーズ"
  foreach ($spk in $Cfg.speakers.PSObject.Properties.Name) {
    $n = @(Get-ChildItem (Join-Path $Here "phrases\$spk") -Recurse -Filter *.wav -ErrorAction SilentlyContinue).Count
    if ($n -gt 0) { Ok ("{0}: {1} 件" -f $spk, $n) } else { Ng ("{0}: 未生成。gen-phrases.ps1 を実行" -f $spk) }
  }

  Step "要約 (mod: voice-summary)"
  if (-not $Cfg.speech.summarize) {
    Warn "config で無効化されている（抽出のみで動作）"
  } else {
    if (Test-Path (Join-Path $ModDir ".claude-plugin\plugin.json")) { Ok $ModDir } else { Ng "mod が無い: $ModDir" }
    $sj = $null
    if (Test-Path $Settings) { $sj = Get-Content $Settings -Raw -Encoding UTF8 | ConvertFrom-Json }
    if (Test-ModRegistered $sj) { Ok "CLAUDE_CODE_PLUGIN_DIRS に登録済み（新しく開いたセッションから有効）" }
    else { Ng "CLAUDE_CODE_PLUGIN_DIRS に未登録。setup.ps1 を実行" }
    try {
      $cv = [string](& claude --version 2>$null)
      $num = $cv -replace '^\s*([0-9]+(\.[0-9]+)+).*$', '$1'
      if ([version]$num -lt [version]$MinClaude) { Ng ("Claude Code {0} は mod の API が古い。{1} 以降に更新" -f $num, $MinClaude) }
      else { Ok ("Claude Code {0}（確認した版 {1}）" -f $num, $MinClaude) }
    } catch { Warn "claude --version で版を確認できない" }
    $log = Join-Path $Here "notify.log"
    if (Test-Path $log) {
      $tail = @(Get-Content $log -Encoding UTF8 -Tail 200)
      $got  = @($tail | Where-Object { $_ -match ' 要約 [0-9.]+秒 \(Haiku' }).Count
      $miss = @($tail | Where-Object { $_ -match '要約なし（mod 未読み込み' }).Count
      if ($miss -gt 0 -and $got -eq 0) {
        Warn ("直近200行: 要約 0 件 / mod 未読み込み {0} 件。設定後に新しいセッションを開いたか確認" -f $miss)
      } else { Ok ("直近200行: 要約 {0} 件 / mod 未読み込み {1} 件" -f $got, $miss) }
    }
  }

  Step "Claude Code への登録"
  if (Test-Path $Settings) {
    $h = (Get-Content $Settings -Raw -Encoding UTF8 | ConvertFrom-Json).hooks
    $n = 0
    foreach ($ev in @(Get-PropNames $h)) { $n += @($h.$ev | Where-Object { Test-OurEntry $_ }).Count }
    if ($n -ge 6) { Ok ("hook {0} 件" -f $n) } else { Ng ("hook が {0} 件しかない。setup.ps1 を実行" -f $n) }
  } else { Ng "settings.json が無い" }
  if (Test-Path $CmdFile) { Ok "/voice スラッシュコマンドあり" } else { Ng "/voice が無い" }

  Step "常駐まわり"
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Ok "ログオン時起動タスクあり" }
  else { Ng "ログオン時起動タスクが無い" }
  if (Test-Path $LinkPath) {
    $sc = (New-Object -ComObject WScript.Shell).CreateShortcut($LinkPath)
    Ok ("ホットキー {0}" -f $sc.HotKey)
  } else { Ng "ホットキーのショートカットが無い" }

  Step "スクリプトの文字コード"
  # BOM が無いと Windows PowerShell 5.1 が cp932 として読み、日本語コメントで構文エラーになる。
  # 別のエディタで編集したあとに壊れがちなので、ここで気づけるようにしておく。
  $noBom = @(Get-ChildItem (Join-Path $Here "*.ps1") | Where-Object {
    $b = [IO.File]::ReadAllBytes($_.FullName)
    -not ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
  })
  if ($noBom.Count) { Ng ("UTF-8 BOM が無い: " + (($noBom | ForEach-Object { $_.Name }) -join ", ")) }
  else { Ok "すべて UTF-8 BOM 付き" }

  Step "状態"
  if (Test-Path (Join-Path $Here "state\mute")) { Warn "手動ミュート中。/voice on で解除" } else { Ok "ミュートなし" }
  $log = Join-Path $Here "notify.log"
  if (Test-Path $log) {
    $errs = @(Get-Content $log -Encoding UTF8 -Tail 200 | Where-Object { $_ -match "ERR " })
    if ($errs.Count) {
      Warn ("直近200行のエラー {0} 件:" -f $errs.Count)
      $errs | Select-Object -Last 3 | ForEach-Object { Write-Host ("        " + $_) }
    } else { Ok "直近200行にエラーなし" }
  }
  exit 0
}

# ================================================================ 導入
Write-Output "claude-voice を導入します"
Write-Output ("場所: {0}" -f $Here)

Step "1. VOICEVOX"
$exe = Find-EngineExe
if (-not $exe) {
  Warn "VOICEVOX が見つかりません。"
  $doIt = $InstallVoicevox
  if (-not $doIt) {
    $ans = Read-Host "winget で導入しますか (y/N)"
    $doIt = ($ans -match '^[yY]')
  }
  if ($doIt) {
    Write-Output "   winget install HiroshibaKazuyuki.VOICEVOX.CPU ..."
    winget install --id HiroshibaKazuyuki.VOICEVOX.CPU -e --accept-package-agreements --accept-source-agreements
    $exe = Find-EngineExe
  }
  if (-not $exe) {
    Ng "VOICEVOX が無いと音声を作れません。導入後にもう一度実行してください。"
    exit 1
  }
}
Ok $exe

Step "2. ENGINE の起動"
if (Test-Engine) { Ok "すでに起動済み (port $Port)" }
else {
  & (Join-Path $Here "start-engine.ps1") | ForEach-Object { Write-Host ("   " + $_) }
  if (-not (Test-Engine)) { Ng "ENGINE が起動しませんでした"; exit 1 }
}

Step "3. 定型フレーズ"
$genArgs = @{ Quiet = $true }
if (-not $Force) { $genArgs["IfMissing"] = $true }
& (Join-Path $Here "gen-phrases.ps1") @genArgs | ForEach-Object { Ok $_ }

Step "4. Claude Code への登録（hook と要約 mod）"
if (-not (Update-Hooks)) { exit 1 }

Step "5. /voice スラッシュコマンド"
$cmdDir = Split-Path -Parent $CmdFile
if (-not (Test-Path $cmdDir)) { New-Item -ItemType Directory $cmdDir -Force | Out-Null }
$cmdBody = @"
---
description: Claude Code の音声通知をミュート/解除する
argument-hint: "[on|off|status]  省略時は切替"
allowed-tools: Bash(powershell:*)
---

実行結果:

!``powershell -NoProfile -ExecutionPolicy Bypass -File "$VoiceCli" `$ARGUMENTS``

上の実行結果を日本語1行でそのまま報告してください。補足や提案は不要です。
"@
[IO.File]::WriteAllText($CmdFile, $cmdBody, (New-Object Text.UTF8Encoding $false))
Ok $CmdFile

Step "6. ログオン時に ENGINE を起動"
# run.exe を直接起動するとコンソール窓が残るので、PowerShell を隠して噛ませる。
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument ("-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"{0}\start-engine.ps1`" -Quiet" -f $Here)
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force `
  -Description "Claude Code の音声通知が使う VOICEVOX ENGINE をログオン時に起動する" | Out-Null
Ok ("スケジュールタスク '{0}'" -f $TaskName)

Step "7. ミュート切替のホットキー"
# Windows のショートカットに割り当てたキーはグローバルに効くので、
# Claude が処理中でも、どのウィンドウからでも黙らせられる。
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($LinkPath)
$sc.TargetPath       = "powershell.exe"
$sc.Arguments        = ("-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"{0}`" -Event toggle" -f $Notify)
$sc.WorkingDirectory = $Here
$sc.IconLocation     = "$env:SystemRoot\System32\SndVol.exe,0"
$sc.WindowStyle      = 7
$sc.HotKey           = $HotKey
$sc.Description      = "Claude Code の音声通知をミュート/解除する"
$sc.Save()
Ok ("{0}（どのウィンドウからでも効く）" -f $HotKey)

Write-Output ""
Write-Output "導入しました。Claude Code を再起動するか /hooks を一度開くと hook が読み込まれます。"
Write-Output "要約 mod は新しく開いたセッションから有効になります（開いているセッションは本文の抜き出しで読み上げます）。"
Write-Output "  診断: .\setup.ps1 -Doctor"
Write-Output "  撤去: .\setup.ps1 -Remove"
