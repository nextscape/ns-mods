<#
再生の頭切れ対策（先頭に無音を足す）の検証。音は鳴らさない。

  .\test-lead.ps1

notify.ps1 の Get-LeadMs / Add-LeadSilence を読み込んで確かめる。
#>
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cfg  = Get-Content (Join-Path (Split-Path -Parent $Here) "config.default.json") -Raw -Encoding UTF8 | ConvertFrom-Json

$src = Get-Content (Join-Path (Split-Path -Parent $Here) "scripts\notify.ps1") -Raw -Encoding UTF8
foreach ($name in "Get-LeadMs", "Add-LeadSilence") {
  $m = [regex]::Match($src, "(?s)function $name\b.*?\n\}")
  if (-not $m.Success) { throw "$name が見つかりません" }
  Invoke-Expression $m.Value
}

$ng = 0
function Check([string]$name, [bool]$ok, [string]$detail) {
  $mark = "ok  "
  if (-not $ok) { $mark = "NG  "; $script:ng++ }
  "{0}{1}  {2}" -f $mark, $name, $detail
}

# wav を読んで fmt / data の位置を返す（検証側の独立した実装）
function Read-Wav([byte[]]$b) {
  $r = @{ Riff = [BitConverter]::ToInt32($b, 4); Chunks = @() }
  $i = 12
  while ($i + 8 -le $b.Length) {
    $id = [Text.Encoding]::ASCII.GetString($b, $i, 4); $sz = [BitConverter]::ToInt32($b, $i + 4)
    $r.Chunks += $id
    if ($id -eq 'fmt ') { $r.Rate = [BitConverter]::ToInt32($b, $i + 12); $r.Align = [BitConverter]::ToInt16($b, $i + 20) }
    if ($id -eq 'data') { $r.DataAt = $i + 8; $r.DataSize = $sz }
    $i += 8 + $sz + ($sz % 2)
  }
  $r
}

# ---- どれだけ足すか（休止明けに限らず毎回）
$ms = [int]$Cfg.playback.leadSilenceMs
Check "設定がある" ($ms -gt 0) ("leadSilenceMs={0}" -f $ms)
Check "毎回その長さを足す" ((Get-LeadMs) -eq $ms)
# ---- 足し方（組み立てた wav で）
# 実物のフレーズに頼らず、小さな wav（PCM 16bit mono 24kHz、0.1秒）をその場で組み立てる
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
$orig = New-TestWav
$o = Read-Wav $orig
$out = Add-LeadSilence $orig 300
if (-not $out) {
  Check "無音を足した wav を返す" $false "null が返った"
} else {
  $n = Read-Wav $out
  $pad = [int]($o.Rate * 300 / 1000) * $o.Align
  Check "data が無音ぶん伸びる" ($n.DataSize -eq $o.DataSize + $pad) ("{0} → {1}" -f $o.DataSize, $n.DataSize)
  Check "RIFF の大きさが全長と合う" ($n.Riff -eq $out.Length - 8) ("RIFF={0} 全長-8={1}" -f $n.Riff, ($out.Length - 8))
  Check "fmt は変えない" ($n.Rate -eq $o.Rate -and $n.Align -eq $o.Align)
  $zero = $true
  for ($k = 0; $k -lt $pad; $k++) { if ($out[$n.DataAt + $k] -ne 0) { $zero = $false; break } }
  Check "頭が無音" $zero
  $same = $true
  for ($k = 0; $k -lt $o.DataSize; $k += 97) { if ($out[$n.DataAt + $pad + $k] -ne $orig[$o.DataAt + $k]) { $same = $false; break } }
  Check "元の音はそのまま後ろに続く" $same
}

Check "0ms なら元のまま" ([Convert]::ToBase64String((Add-LeadSilence $orig 0)) -eq [Convert]::ToBase64String($orig))
Check "wav でなければ null" ($null -eq (Add-LeadSilence ([byte[]](1..64)) 300))

# ---- data の前に別のチャンク（LIST、奇数長）があっても data を見つける
$fmtAt = 12
$fmtLen = 8 + [BitConverter]::ToInt32($orig, $fmtAt + 4)
$list = [byte[]](@([byte][char]'L', [byte][char]'I', [byte][char]'S', [byte][char]'T') + [BitConverter]::GetBytes([int]3) + @(1, 2, 3, 0))
$data = $orig[$o.DataAt..($o.DataAt + $o.DataSize - 1)]
$body = [byte[]]($orig[$fmtAt..($fmtAt + $fmtLen - 1)] + $list + [Text.Encoding]::ASCII.GetBytes("data") + [BitConverter]::GetBytes([int]$data.Length) + $data)
$withList = [byte[]]([Text.Encoding]::ASCII.GetBytes("RIFF") + [BitConverter]::GetBytes([int]($body.Length + 4)) + [Text.Encoding]::ASCII.GetBytes("WAVE") + $body)
$out2 = Add-LeadSilence $withList 300
$ok2 = $false
if ($out2) { $n2 = Read-Wav $out2; $ok2 = ($n2.DataSize -eq $o.DataSize + $pad) -and ($n2.Riff -eq $out2.Length - 8) }
Check "LIST チャンク付きでも足せる" $ok2

""
if ($ng -eq 0) { "合格" } else { "{0} 件 不合格" -f $ng; exit 1 }
