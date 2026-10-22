// What differs by OS, as pure functions: paths, the PowerShell command line,
// and reading the registry's microphone record. The I/O modules run what
// these build.

export type Os = 'windows' | 'macos' | 'linux'

export function osFrom(osEnv: string | undefined, uname: string): Os {
  if (osEnv === 'Windows_NT') return 'windows'
  return uname.trim() === 'Darwin' ? 'macos' : 'linux'
}

// A path with Windows separators, and one with forward slashes and no
// trailing slash (the form the mod keeps paths in).
export const winPath = (p: string) => p.replace(/\//g, '\\')
export const slashPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

// One of the plugin's PowerShell scripts (scripts/windows/<script>) with its
// arguments.
export function psArgv(pluginRoot: string, script: string, args: readonly string[] = []): string[] {
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', winPath(`${pluginRoot}/scripts/windows/${script}`), ...args]
}

export type Argv = { argv: string[]; stdin: string }

// Deleting files: $.fs cannot delete, so the OS does. Null when there is
// nothing to delete. Windows does not use cmd's del: past 8191 characters of
// command line it deletes nothing, and cmd reads & and % in paths. The paths
// go one per line on stdin to remove.ps1, which uses Remove-Item -LiteralPath.
export function removeArgv(os: Os, pluginRoot: string, paths: readonly string[]): Argv | null {
  if (paths.length === 0) return null
  if (os === 'windows') return { argv: psArgv(pluginRoot, 'remove.ps1'), stdin: paths.map(winPath).join('\n') }
  return { argv: ['rm', '-f', '--', ...paths], stdin: '' }
}

// Putting a file in place (a synthesized wav takes its real name only once it
// is whole). Windows passes the two paths on stdin, as remove.ps1 does.
export function moveArgv(os: Os, pluginRoot: string, from: string, to: string): Argv {
  if (os === 'windows') return { argv: psArgv(pluginRoot, 'move.ps1'), stdin: [from, to].map(winPath).join('\n') }
  return { argv: ['mv', '-f', '--', from, to], stdin: '' }
}

// The apps using the microphone (Windows). On a Japanese system reg prints
// CP932 and $.process.run reads UTF-8; only the numbers decide, so that is
// harmless (an app name in the log may come out garbled).
export const MIC_QUERY: readonly string[] = [
  'reg', 'query', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone', '/s',
]

const leaf = (k: string) => k.slice(k.lastIndexOf('\\') + 1)

// The app using the microphone now, from `reg query /s`: Windows records one
// in use with a start time and LastUsedTimeStop = 0.
export function micInUseFrom(regOutput: string): string | null {
  let current: string | null = null
  let start = BigInt(0)
  let stop: bigint | null = null
  // One more key at the end, so the last key is judged the same way.
  for (const line of [...regOutput.split(/\r?\n/), 'HKEY_END']) {
    if (line.startsWith('HKEY_')) {
      if (current !== null && start > BigInt(0) && stop === BigInt(0)) return leaf(current)
      current = line.trim()
      start = BigInt(0)
      stop = null
      continue
    }
    const m = /^\s+(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+0x([0-9a-fA-F]+)/.exec(line)
    if (!m) continue
    if (m[1] === 'LastUsedTimeStart') start = BigInt(`0x${m[2]}`)
    else stop = BigInt(`0x${m[2]}`)
  }
  return null
}
