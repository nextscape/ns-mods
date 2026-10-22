<#
Puts a file in place (Windows). The mod (hooks/io.ts) calls it with two lines on stdin: the file to move, then where it goes.
Paths go through stdin, as for remove.ps1, so cmd never reads their & or %. Exit code 1 when the move fails.
#>
# The mod writes UTF-8: read it as such so Japanese paths survive
try { [Console]::InputEncoding = New-Object Text.UTF8Encoding $false } catch { }
$lines = @([Console]::In.ReadToEnd() -split "`r?`n" | Where-Object { $_ })
if ($lines.Count -ne 2) { exit 1 }
try { Move-Item -LiteralPath $lines[0] -Destination $lines[1] -Force -ErrorAction Stop } catch { exit 1 }
exit 0
