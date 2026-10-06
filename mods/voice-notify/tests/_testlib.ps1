<#
テストの共通部品。ドットソースで読み込む:  . (Join-Path $PSScriptRoot "_testlib.ps1")
#>

# 小さな wav（PCM 16bit mono 24kHz、0.1秒）を組み立てる
function New-TestWav {
  $rate = 24000; $data = New-Object byte[] 4800
  for ($k = 0; $k -lt $data.Length; $k++) { $data[$k] = [byte](($k * 7) % 251) }
  $ms = New-Object IO.MemoryStream; $w = New-Object IO.BinaryWriter($ms)
  $w.Write([Text.Encoding]::ASCII.GetBytes("RIFF")); $w.Write([int](36 + $data.Length)); $w.Write([Text.Encoding]::ASCII.GetBytes("WAVE"))
  $w.Write([Text.Encoding]::ASCII.GetBytes("fmt ")); $w.Write([int]16); $w.Write([int16]1); $w.Write([int16]1)
  $w.Write([int]$rate); $w.Write([int]($rate * 2)); $w.Write([int16]2); $w.Write([int16]16)
  $w.Write([Text.Encoding]::ASCII.GetBytes("data")); $w.Write([int]$data.Length); $w.Write($data)
  $w.Flush(); $ms.ToArray()
}

# 一時ホームに定型フレーズの代わり（ダミー wav）を置く。実物（gen-phrases.ps1 が作る）が無くても
# notify.ps1 のフレーズ選択（phrases\<話者>\<種類>\*.wav）を検証できるようにする
function New-TestPhrases([string]$VHome, [string]$ConfigPath) {
  $cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $wav = New-TestWav
  $kinds = @("stop\done", "stop\ask", "stop\trouble", "stop\solo", "stop\interim",
             "stop\brief\done", "stop\brief\ask", "stop\brief\trouble", "stop\brief\solo", "stop\brief\interim",
             "idle", "notification", "permission", "failure", "task", "mute", "unmute", "agent", "remain")
  foreach ($spk in $cfg.speakers.PSObject.Properties.Name) {
    foreach ($k in $kinds) {
      $d = Join-Path $VHome "phrases\$spk\$k"
      New-Item -ItemType Directory $d -Force | Out-Null
      [IO.File]::WriteAllBytes((Join-Path $d "01.wav"), $wav)
    }
    [IO.File]::WriteAllBytes((Join-Path $VHome "phrases\$spk\agent\_default.wav"), $wav)
  }
}
