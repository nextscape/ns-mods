// The shape of what the home (~/.claude/voice-notify) holds. The I/O modules
// read and write it.

export type Level = 'INFO' | 'WARN' | 'ERR'

const LOG_MAX = 200 * 1024
const LOG_KEEP = 500

const pad = (n: number) => String(n).padStart(2, '0')

// The time stamp that leads each notify.log line, and the gap after it.
const STAMP_WIDTH = 'YYYY-MM-DD HH:MM:SS  '.length

// One notify.log line (the format 0.2.0 wrote).
export function logLine(at: Date, level: Level, event: string, msg: string): string {
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  return `${stamp}  ${level.padEnd(4)} ${event.padEnd(11)} ${msg}`
}

// Whether a notify.log line is an error, and the line without its time stamp.
export const isErrorLine = (line: string) => line.slice(STAMP_WIDTH).startsWith('ERR ')
export const logBody = (line: string) => line.slice(STAMP_WIDTH)

// $.fs cannot append, so the lines join what was read and the whole is
// written back. Past about 200KB only the newest 500 lines stay.
export function appendLog(old: string, lines: readonly string[]): string {
  const text = `${old}${lines.join('\n')}\n`
  return text.length > LOG_MAX ? `${text.trimEnd().split('\n').slice(-LOG_KEEP).join('\n')}\n` : text
}

// The file that remembers the last wav picked in a phrase folder
// ('stop/brief/done' and so on), named as 0.2.0 named it.
export function phraseMemo(root: string, name: string): string {
  return `${root}/state/last_phrase_${name.replace(/[\\/]/g, '_')}`
}
