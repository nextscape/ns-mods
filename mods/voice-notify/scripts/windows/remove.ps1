<#
Deletes files (Windows). The mod (hooks/io.ts) calls it with the paths on stdin, one per line.
Not cmd's del: past 8191 characters of command line it deletes nothing, and cmd reads & and % in paths.
A file that is not there is skipped. Exit code 1 when any could not be deleted.
#>
# The mod writes UTF-8: read it as such so Japanese paths survive
try { [Console]::InputEncoding = New-Object Text.UTF8Encoding $false } catch { }
$failed = 0
foreach ($p in ([Console]::In.ReadToEnd() -split "`r?`n")) {
  if (-not $p) { continue }
  if (-not (Test-Path -LiteralPath $p)) { continue }
  try { Remove-Item -LiteralPath $p -Force -ErrorAction Stop } catch { $failed++ }
}
exit ([int]($failed -gt 0))
