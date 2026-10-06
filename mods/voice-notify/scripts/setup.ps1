<#
voice-notify の初期設定・診断・撤去。/voice-notify:setup から呼ばれる。何度実行しても同じ状態になる（冪等）。

  setup.ps1              導入（既に入っているものは飛ばす）
  setup.ps1 -Doctor      診断だけ。鳴らないときの切り分けに使う
  setup.ps1 -Remove      撤去（タスク・ホットキー）。ホーム（設定・フレーズ）は残す
  setup.ps1 -Force       フレーズを作り直す（話速などを変えたとき）

hook と要約 mod はプラグインの hooks/hooks.json が登録する。settings.json には書き込まない。

やること:
  1. ホームの用意（~/.claude/voice-notify。config.json が無ければ既定をコピー）
  2. VOICEVOX の確認（無ければ導入コマンドを案内して終える）
  3. VOICEVOX ENGINE の起動
  4. 定型フレーズの生成
  5. ログオン時に ENGINE を起動するタスクの登録
  6. ミュート切替のホットキー

5・6 はプラグインの版に依存しない ~/.claude/voice-notify/bin/launch.ps1 を呼ぶ
（プラグインは更新のたびにキャッシュの版フォルダが変わるため）。
管理者権限は不要。すべてユーザー領域で完結する。
#>
param(
  [switch]$Remove,
  [switch]$Doctor,
  [switch]$Force,
  [string]$HotKey = "CTRL+ALT+M"
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$Here       = $PSScriptRoot                    # スクリプト（プラグイン側）
$PluginRoot = Split-Path -Parent $Here
. (Join-Path $Here "lib.ps1")
$VHome      = Get-VoiceHome                    # 設定と状態（ホーム）
Initialize-VoiceHome $VHome $PluginRoot
$Cfg        = Get-Content (Join-Path $VHome "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$Port       = $Cfg.enginePort
$BinDir     = Join-Path $VHome "bin"
$Launch     = Join-Path $BinDir "launch.ps1"
$TaskName   = "VOICEVOX ENGINE (voice-notify)"
$LinkPath   = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\voice-notify ミュート切替.lnk"
$Settings   = Join-Path $env:USERPROFILE ".claude\settings.json"
$MinClaude  = "2.1.291"                        # mod の API を確認した Claude Code の版

# 画面向けの文字は Write-Host に流して、関数の戻り値と混ざらないようにする
function Step([string]$m) { Write-Host ""; Write-Host ("== " + $m) }
function Ok([string]$m)   { Write-Host ("   OK   " + $m) }
function Warn([string]$m) { Write-Host ("   注意 " + $m) }
function Ng([string]$m)   { Write-Host ("   NG   " + $m) }

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

# 旧方式（claude-voice。settings.json に hook と CLAUDE_CODE_PLUGIN_DIRS を直接書いていた）の名残。
# 残っていると公開版と二重に鳴る
# ~/.claude 配下のファイルに残る名残（$ClaudeDir を差し替えてテストできるように分けてある）
function Get-LegacyFiles([string]$ClaudeDir) {
  $found = @()
  $settingsFile = Join-Path $ClaudeDir "settings.json"
  if (Test-Path $settingsFile) {
    $raw = Get-Content $settingsFile -Raw -Encoding UTF8
    if ($raw -match 'claude-voice[\\/]+notify\.ps1') { $found += "settings.json の hook（claude-voice\notify.ps1）" }
    if ($raw -match '"CLAUDE_CODE_PLUGIN_DIRS"\s*:\s*"[^"]*claude-voice') { $found += "settings.json の CLAUDE_CODE_PLUGIN_DIRS（claude-voice\mod）" }
  }
  $oldCmd = Join-Path $ClaudeDir "commands\voice.md"
  if ((Test-Path $oldCmd) -and ((Get-Content $oldCmd -Raw -Encoding UTF8) -match 'claude-voice')) {
    $found += "旧 /voice コマンド（commands\voice.md）"
  }
  return $found
}

function Get-LegacyRegistrations {
  $found = @(Get-LegacyFiles (Split-Path -Parent $Settings))
  if (Get-ScheduledTask -TaskName "VOICEVOX ENGINE (claude-voice)" -ErrorAction SilentlyContinue) { $found += "タスク 'VOICEVOX ENGINE (claude-voice)'" }
  $oldLink = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Claude 音声通知 ミュート切替.lnk"
  if (Test-Path $oldLink) { $found += "ホットキーのショートカット（Claude 音声通知 ミュート切替）" }
  return $found
}

# ================================================================ 撤去
if ($Remove) {
  Step "撤去"
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Ok "スケジュールタスクを削除"
  Remove-Item -LiteralPath $LinkPath -Force -ErrorAction SilentlyContinue
  Ok "ホットキーのショートカットを削除"
  Write-Output ""
  Write-Output "残したもの: $VHome（設定・フレーズ・ログ）。不要なら手で削除する。"
  Write-Output "プラグイン本体は /plugin uninstall voice-notify で外す。"
  exit 0
}

# ================================================================ 診断
if ($Doctor) {
  Write-Output "voice-notify 診断"
  Write-Output ("プラグイン: {0}" -f $PluginRoot)
  Write-Output ("ホーム:     {0}" -f $VHome)

  Step "旧方式（claude-voice）の名残"
  $legacy = @(Get-LegacyRegistrations)
  if ($legacy.Count) {
    foreach ($l in $legacy) { Warn ("残っている（二重に鳴る）: {0}" -f $l) }
    Warn "旧 claude-voice の setup.ps1 -Remove で外してください"
  } else { Ok "なし" }

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
  } else { Ng "ENGINE が応答しない (port $Port)。/voice-notify:setup を実行" }

  Step "定型フレーズ"
  foreach ($spk in $Cfg.speakers.PSObject.Properties.Name) {
    $n = @(Get-ChildItem (Join-Path $VHome "phrases\$spk") -Recurse -Filter *.wav -ErrorAction SilentlyContinue).Count
    if ($n -gt 0) { Ok ("{0}: {1} 件" -f $spk, $n) } else { Ng ("{0}: 未生成。/voice-notify:setup を実行" -f $spk) }
  }

  Step "要約（Haiku）"
  if (-not $Cfg.speech.summarize) {
    Warn "config で無効化されている（抽出のみで動作）"
  } else {
    try {
      $cv = [string](& claude --version 2>$null)
      $num = $cv -replace '^\s*([0-9]+(\.[0-9]+)+).*$', '$1'
      if ([version]$num -lt [version]$MinClaude) { Ng ("Claude Code {0} は mod の API が古い。{1} 以降に更新" -f $num, $MinClaude) }
      else { Ok ("Claude Code {0}（確認した版 {1}）" -f $num, $MinClaude) }
    } catch { Warn "claude --version で版を確認できない" }
    $log = Join-Path $VHome "notify.log"
    if (Test-Path $log) {
      $tail = @(Get-Content $log -Encoding UTF8 -Tail 200)
      $got  = @($tail | Where-Object { $_ -match ' 要約 [0-9.]+秒 \(Haiku' }).Count
      $miss = @($tail | Where-Object { $_ -match '要約なし（mod 未読み込み' }).Count
      if ($miss -gt 0 -and $got -eq 0) {
        Warn ("直近200行: 要約 0 件 / mod 未読み込み {0} 件。導入後に新しいセッションを開いたか確認" -f $miss)
      } else { Ok ("直近200行: 要約 {0} 件 / mod 未読み込み {1} 件" -f $got, $miss) }
    }
  }

  Step "常駐まわり"
  if (Test-Path $Launch) { Ok $Launch } else { Ng "launch.ps1 が無い。/voice-notify:setup を実行" }
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Ok "ログオン時起動タスクあり" }
  else { Ng "ログオン時起動タスクが無い" }
  if (Test-Path $LinkPath) {
    $sc = (New-Object -ComObject WScript.Shell).CreateShortcut($LinkPath)
    Ok ("ホットキー {0}" -f $sc.HotKey)
  } else { Ng "ホットキーのショートカットが無い" }

  Step "スクリプトの文字コード"
  # BOM が無いと Windows PowerShell 5.1 が cp932 として読み、日本語コメントで構文エラーになる
  $noBom = @(Get-ChildItem (Join-Path $Here "*.ps1") | Where-Object {
    $b = [IO.File]::ReadAllBytes($_.FullName)
    -not ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
  })
  if ($noBom.Count) { Ng ("UTF-8 BOM が無い: " + (($noBom | ForEach-Object { $_.Name }) -join ", ")) }
  else { Ok "すべて UTF-8 BOM 付き" }

  Step "状態"
  if (Test-Path (Join-Path $VHome "state\mute")) { Warn "手動ミュート中。/voice-notify:voice on で解除" } else { Ok "ミュートなし" }
  $log = Join-Path $VHome "notify.log"
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
Write-Output "voice-notify を導入します"
Write-Output ("ホーム: {0}" -f $VHome)

Step "1. ホーム"
Ok ("config.json: {0}" -f (Join-Path $VHome "config.json"))
$legacy = @(Get-LegacyRegistrations)
foreach ($l in $legacy) { Warn ("旧方式が残っている（二重に鳴る）: {0}。旧 claude-voice の setup.ps1 -Remove で外す" -f $l) }

Step "2. VOICEVOX"
$exe = Find-EngineExe
if (-not $exe) {
  # Claude Code のコマンドからは対話的に尋ねられないので、導入方法を案内して終える
  Ng "VOICEVOX が見つかりません。次のコマンドで導入してから、もう一度 /voice-notify:setup を実行してください。"
  Write-Output "   winget install --id HiroshibaKazuyuki.VOICEVOX.CPU -e"
  exit 1
}
Ok $exe

Step "3. ENGINE の起動"
if (Test-Engine) { Ok "すでに起動済み (port $Port)" }
else {
  & (Join-Path $Here "start-engine.ps1") | ForEach-Object { Write-Host ("   " + $_) }
  if (-not (Test-Engine)) { Ng "ENGINE が起動しませんでした"; exit 1 }
}

Step "4. 定型フレーズ"
# 初回は2話者ぶん約150回の合成で数分かかり、コマンドの実行時間の上限を超えうる。
# 裏で生成させて先に進む（足りないものだけ作るので、何度実行してもよい）
$genArgs = "-Quiet"
if (-not $Force) { $genArgs += " -IfMissing" }
$missing = @($Cfg.speakers.PSObject.Properties.Name | Where-Object {
  -not @(Get-ChildItem (Join-Path $VHome "phrases\$_") -Recurse -Filter *.wav -ErrorAction SilentlyContinue).Count })
if ($Force -or $missing.Count) {
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList `
    ("-NoProfile -ExecutionPolicy Bypass -File `"{0}`" {1}" -f (Join-Path $Here "gen-phrases.ps1"), $genArgs) | Out-Null
  Ok "裏で生成を始めました（初回は数分）。進み具合は /voice-notify:setup doctor の「定型フレーズ」で確認できます"
} else { Ok "生成済み（作り直すときは setup.ps1 -Force）" }

Step "5. ログオン時に ENGINE を起動"
if (-not (Test-Path $BinDir)) { New-Item -ItemType Directory $BinDir -Force | Out-Null }
Copy-Item (Join-Path $Here "launch.ps1") $Launch -Force
# launch.ps1 が installed_plugins.json で見つけられないとき（手元のフォルダから入れた場合など）の手がかり
[IO.File]::WriteAllText((Join-Path $BinDir "plugin-root.txt"), $PluginRoot, (New-Object Text.UTF8Encoding $false))
# run.exe を直接起動するとコンソール窓が残るので、PowerShell を隠して噛ませる
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument ("-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"{0}`" -Action engine" -f $Launch)
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force `
  -Description "voice-notify（Claude Code の音声通知）が使う VOICEVOX ENGINE をログオン時に起動する" | Out-Null
Ok ("スケジュールタスク '{0}'" -f $TaskName)

Step "6. ミュート切替のホットキー"
# Windows のショートカットに割り当てたキーはグローバルに効くので、どのウィンドウからでも黙らせられる
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($LinkPath)
$sc.TargetPath       = "powershell.exe"
$sc.Arguments        = ("-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"{0}`" -Action toggle" -f $Launch)
$sc.WorkingDirectory = $VHome
$sc.IconLocation     = "$env:SystemRoot\System32\SndVol.exe,0"
$sc.WindowStyle      = 7
$sc.HotKey           = $HotKey
$sc.Description      = "voice-notify（Claude Code の音声通知）をミュート/解除する"
$sc.Save()
Ok ("{0}（どのウィンドウからでも効く）" -f $HotKey)

Write-Output ""
Write-Output "導入しました。音声通知と要約は、新しく開いたセッションから有効になります。"
Write-Output "  診断: /voice-notify:setup doctor"
Write-Output "  撤去: /voice-notify:setup remove"
