<#
ファイルを消す（Windows）。mod（hooks/register.ts）が、消すパスを stdin で1行ずつ渡して呼ぶ。
cmd の del を使わないのは、コマンドラインが 8191 文字を超えると何も消えず、パスの & や % を cmd が解釈するため。
無いファイルは飛ばす。消せないものが1つでもあれば終了コード 1。
#>
# mod は UTF-8 で渡すので、日本語のパスが化けないよう読み方を固定する
try { [Console]::InputEncoding = New-Object Text.UTF8Encoding $false } catch { }
$failed = 0
foreach ($p in ([Console]::In.ReadToEnd() -split "`r?`n")) {
  if (-not $p) { continue }
  if (-not (Test-Path -LiteralPath $p)) { continue }
  try { Remove-Item -LiteralPath $p -Force -ErrorAction Stop } catch { $failed++ }
}
exit ([int]($failed -gt 0))
