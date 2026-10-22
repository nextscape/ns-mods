// /voice-notify's arguments and what it prints, as pure functions; commands.ts
// runs them. A mod's command name takes only letters, digits, _ and -, so
// 0.2.0's /voice-notify:setup and /voice-notify:voice became subcommands.
// The output keeps 0.2.0's setup.ps1 format (== headings, OK / 注意 / NG lines).

import type { Config } from './config'
import { voiceFor } from './decide'
import type { Os } from './os'
import type { PhraseState } from './phrases'
import { logBody } from './store'
import type { FoundEngine } from './voicevox'

export const COMMAND = 'voice-notify'
const CMD = `/${COMMAND}`

export const ok = (m: string) => `   OK   ${m}`
export const warn = (m: string) => `   注意 ${m}`
export const ng = (m: string) => `   NG   ${m}`
export const step = (m: string) => `\n== ${m}`

export const OS_NAME: Record<Os, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' }
export const INSTALL_HINT: Record<Os, string> = {
  windows: 'winget install --id HiroshibaKazuyuki.VOICEVOX.CPU -e',
  macos: '公式サイト（https://voicevox.hiroshiba.jp/）から dmg を入れる',
  linux: '公式サイトの tar.gz を展開し、config.json の enginePath に vv-engine/run の絶対パスを書く',
}

// What 0.2.0 left: state files (the mod keeps no such state) and the old
// entry points of the hotkey and the task.
export const LEGACY_STATE_DIRS: readonly string[] = ['turns', 'agents', 'summaries']
export const LEGACY_BIN: readonly string[] = ['launch.ps1', 'plugin-root.txt']

export type SetupAction = 'install' | 'doctor' | 'force' | 'remove'
export type VoiceAction = 'toggle' | 'mute' | 'unmute' | 'status'
export type Command = { kind: 'voice'; action: VoiceAction } | { kind: 'setup'; action: SetupAction }

export const USAGE = `使い方: ${CMD} [on|off|status]（省略時は切替） / ${CMD} setup [force] / ${CMD} doctor / ${CMD} remove`

const COMMANDS: Record<string, Command> = {
  '': { kind: 'voice', action: 'toggle' },
  toggle: { kind: 'voice', action: 'toggle' },
  on: { kind: 'voice', action: 'unmute' },
  unmute: { kind: 'voice', action: 'unmute' },
  off: { kind: 'voice', action: 'mute' },
  mute: { kind: 'voice', action: 'mute' },
  status: { kind: 'voice', action: 'status' },
  setup: { kind: 'setup', action: 'install' },
  'setup force': { kind: 'setup', action: 'force' },
  doctor: { kind: 'setup', action: 'doctor' },
  remove: { kind: 'setup', action: 'remove' },
}

export function parseCommand(args: string): Command | null {
  return COMMANDS[args.trim().toLowerCase().split(/\s+/).join(' ')] ?? null
}

export function unknownArg(args: string): string {
  return `知らない引数です: ${args.trim()}。${USAGE}`
}

// Every message names the next step in the same words.
export const HINT = {
  setup: `${CMD} setup`,
  force: `${CMD} setup force`,
  doctor: `${CMD} doctor`,
  remove: `${CMD} remove`,
  unmute: `${CMD} on`,
  voice: `${CMD} [on|off|status]`,
}

export function voiceStatus(cfg: Config, os: Os, muted: boolean): string {
  const label = (n: string) => cfg.speakers[n]?.label ?? n
  return [
    `手動ミュート: ${muted ? 'ON' : 'OFF'}`,
    `マイク使用中の自動ミュート: ${os === 'windows' && cfg.mute.whenMicInUse ? '有効' : '無効'}`,
    `話者: 最終 ${label(voiceFor(cfg, 'final').name)} / 中間 ${label(voiceFor(cfg, 'interim').name)} / 話速: ${cfg.speedScale}`,
    `クレジット: ${creditLine(cfg)}`,
  ].join('\n')
}

// The voice library's terms ask an app to credit it where it can be found
// with a little looking. The credits of the speakers in use (speakers.*.credit);
// a speaker without one is plain VOICEVOX.
export function creditLine(cfg: Pick<Config, 'speaker' | 'speakerInterim' | 'speakers'>): string {
  const names = [voiceFor(cfg, 'final').name, voiceFor(cfg, 'interim').name]
  return [...new Set(names.map(n => cfg.speakers[n]?.credit ?? 'VOICEVOX'))].join('、')
}

// ENGINE 0.24 and later read English words in katakana.
export function hasKanaReading(version: string): boolean {
  const [maj = 0, min = 0] = version.split('.').map(Number)
  return maj > 0 || min >= 24
}

export type DoctorFacts = {
  pluginRoot: string
  root: string
  os: Os
  player: string | null // the player found on Linux
  curl: string | null // the first line of curl --version
  engine: FoundEngine | null
  port: number
  version: string | null
  phrases: PhraseState
  autostart: string[] // the per-OS section on what starts at logon
  muted: boolean
  legacy: number // how many of 0.2.0's leftovers remain
  errors: string[] // the ERR lines among the last 200
  credit: string // creditLine
}

export function doctorReport(f: DoctorFacts): string[] {
  const out = ['voice-notify 診断', `プラグイン: ${f.pluginRoot}`, `ホーム:     ${f.root}`, step('設定（config.json）'), ok(`${f.root}/config.json`)]
  out.push(step('OS と再生'))
  if (f.os === 'linux') out.push(f.player ? ok(`Linux / 再生: ${f.player}`) : ng('Linux / 再生コマンドが見つからない（pw-play / paplay / aplay のどれかを入れる）'))
  else out.push(ok(`${OS_NAME[f.os]} / 再生: ${f.os === 'windows' ? 'SoundPlayer' : 'afplay'}`))
  out.push(f.curl ? ok(`curl: ${f.curl}`) : ng('curl が見つからない（合成に使う）'))
  out.push(step('VOICEVOX'))
  out.push(f.engine?.path ? ok(f.engine.path) : f.engine ? warn('場所は不明（応答はある）') : ng(`見つからない。${INSTALL_HINT[f.os]}`))
  if (f.version) {
    out.push(ok(`ENGINE 応答あり (port ${f.port})`))
    out.push(hasKanaReading(f.version) ? ok(`ENGINE ${f.version}（英単語のカタカナ読みあり）`) : warn(`ENGINE ${f.version} は英単語を1文字ずつ読む。0.24 以降を推奨`))
  } else out.push(ng(`ENGINE が応答しない (port ${f.port})。${HINT.setup} で起動する`))
  out.push(step('定型フレーズ'))
  const p = f.phrases
  if (p.missing) out.push(warn(`定型フレーズが足りない: ${p.missing}/${p.total} 件${p.progress ? `（生成中 ${p.progress.done}/${p.progress.total}）` : ''}。${HINT.setup} を実行する`))
  else if (!p.current) out.push(warn(`定型フレーズが今の設定（文言・話者・話速・読み替え・先頭の無音）と合わない。${HINT.force} で作り直す`))
  else out.push(ok(`${p.total} 件`))
  out.push(...f.autostart)
  out.push(step('状態'))
  out.push(ok(f.muted ? `手動ミュート中（${HINT.unmute} で解除）` : 'ミュートなし'))
  if (f.legacy) out.push(warn(`0.2.0 の残りがある（${f.legacy} 件）。${HINT.setup} で消える`))
  out.push(f.errors.length ? warn(`直近200行にエラー ${f.errors.length} 件。最後: ${logBody(f.errors.at(-1)!)}`) : ok('直近200行にエラーなし'))
  out.push(step('クレジット'), ok(f.credit))
  return out
}
