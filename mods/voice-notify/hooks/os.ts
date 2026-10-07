// OS の違いを閉じ込める純粋関数。実行は register.ts（$ を使えるのは hooks モジュールの中だけ）。

export type Os = 'windows' | 'macos' | 'linux'

export function osFrom(osEnv: string | undefined, uname: string): Os {
  if (osEnv === 'Windows_NT') return 'windows'
  return uname.trim() === 'Darwin' ? 'macos' : 'linux'
}

// $.fs は削除できないので、削除は OS のコマンドで行う。消すものが無ければ null
export function removeArgv(os: Os, paths: readonly string[]): string[] | null {
  if (paths.length === 0) return null
  return os === 'windows' ? ['cmd', '/d', '/c', 'del', '/f', '/q', ...paths.map(p => p.replace(/\//g, '\\'))] : ['rm', '-f', '--', ...paths]
}

// マイクを使っているアプリ（Windows）。出力は日本語の環境では CP932 で、$.process.run は UTF-8 として読む。
// 判定に使うのは値の数字なので影響しない（ログに出すアプリ名が化けることはある）
export const MIC_QUERY: readonly string[] = [
  'reg', 'query', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone', '/s',
]

const leaf = (k: string) => k.slice(k.lastIndexOf('\\') + 1)

// reg query /s の出力から、使用中（開始時刻があり終了時刻が 0）のアプリを探す。
// Windows はマイク使用中のアプリを LastUsedTimeStop = 0 で表す
export function micInUseFrom(regOutput: string): string | null {
  let current: string | null = null
  let start = BigInt(0)
  let stop: bigint | null = null
  // 末尾に区切りを1つ足して、最後のキーも同じ手順で判定する
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
