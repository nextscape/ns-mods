// ホーム（~/.claude/voice-notify）の中身の形。読み書きは register.ts（$ を使えるのは hooks モジュールの中だけ）。

export type Level = 'INFO' | 'WARN' | 'ERR'

const LOG_MAX = 200 * 1024
const LOG_KEEP = 500

const pad = (n: number) => String(n).padStart(2, '0')

// notify.log の1行（0.2.0 と同じ書式）
export function logLine(at: Date, level: Level, event: string, msg: string): string {
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  return `${stamp}  ${level.padEnd(4)} ${event.padEnd(11)} ${msg}`
}

// $.fs に追記は無いので、読んだ中身に足して書き直す。約200KB を超えたら新しい 500 行だけ残す
export function appendLog(old: string, lines: readonly string[]): string {
  const text = `${old}${lines.join('\n')}\n`
  return text.length > LOG_MAX ? `${text.trimEnd().split('\n').slice(-LOG_KEEP).join('\n')}\n` : text
}

// フレーズのフォルダ（'stop/brief/done' など）ごとに、直前に選んだ wav を覚えるファイル（0.2.0 と同じ名前）
export function phraseMemo(root: string, name: string): string {
  return `${root}/state/last_phrase_${name.replace(/[\\/]/g, '_')}`
}
