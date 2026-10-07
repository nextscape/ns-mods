import type { Level } from '../types'
import type { Bound } from './levels'
import type { Why } from './main-effort'
import type { Settings } from './settings'

export type MainView = { level?: Level; judged?: Level | null; skill?: string | null; bump?: boolean; offModel?: string | null }
// version: plugin.json's, or null when it could not be read (no prefix then).
export type StatusView = { settings: Settings; paused: boolean; main: MainView; sub: number; version?: string | null }

// The version and where the mod was loaded from, for /qr and /qr version.
export type Build = { version: string | null; root: string | null }

const shortSkill = (skill: string) => skill.split(':').pop() ?? skill
const shortModel = (model: string) => /claude-([a-z]+)/.exec(model)?.[1] ?? model

// English, one line.
export function statusLine(v: StatusView): string {
  const gate = `gate ${v.settings.gate}`
  const version = v.version ? [`v${v.version}`] : []
  if (v.settings.mode === 'off') return [...version, 'off', gate].join(' · ')
  // The guard keeps running while effort-router pauses A's effort, so a model
  // it could not raise shows in both forms.
  const model = v.main.offModel ? `${shortModel(v.main.offModel)}! ` : ''
  let main: string
  if (v.paused) main = `main ${model}paused (effort-router)`
  else if (v.main.level === undefined) main = 'main waiting'
  else {
    const notes: string[] = []
    if (v.main.judged && v.main.judged !== v.main.level) notes.push(`judged ${v.main.judged}`)
    if (v.main.skill) notes.push(`skill: ${shortSkill(v.main.skill)}`)
    const bump = v.main.bump ? ' +1' : ''
    main = `main ${model}${v.main.level}${bump}${notes.length ? ` (${notes.join(', ')})` : ''}`
  }
  return [...version, main, `sub ${v.sub}`, gate].join(' · ')
}

const USAGE =
  '使い方: /qr [on|off] | gate on|off | guard on|off | floor <段階> | ceiling <段階> | top opus|fable | skill clear | up|down [sub] | stats [today|7d|30d] | log [main|sub|gate] | eval [main|sub] | version'

// Japanese: sentences the user reads.
export const TEXT = {
  denied: (n: number) => `Workflow を差し戻しました（${n}件）`,
  warned: (n: number) => `保存済みの Workflow に規則違反が ${n} 件あります（そのまま通しました）`,
  gateFailed: 'Workflow を点検できなかったため、そのまま通しました',
  guardFallback: (model: string) => `上位モデルに戻せなかったため、${model} のまま続けます`,
  retryThird: (description: string) => `同じ作業のやり直しが3回目です: ${description}`,
  effortRouterDetected:
    'effort-router も入っているため、本体の Effort は effort-router に任せます。quality-router は本体モデルの守り・サブエージェントの振り分け・Workflow の点検・判定の記録を続けます（README「effort-router と一緒に使うとき」）',
  commandFailed: (name: string) => `コマンド /${name} を登録できませんでした`,
  recordFailed: '判定の記録を書けませんでした（このセッションでは、これ以上は知らせません）',
  feedbackSaved: (dir: 'up' | 'down', target: 'main' | 'sub') =>
    `記録しました：直前の${target === 'sub' ? '子' : '本体ターン'}の判定は「${dir === 'up' ? '浅すぎた' : '重すぎた'}」`,
  feedbackNoTarget: (target: 'main' | 'sub') => `直前の${target === 'sub' ? '子' : '本体ターン'}がまだないため、記録しませんでした`,
  unknown: (arg: string) => `「${arg}」は使えません。${USAGE}`,
}

// The first line of /qr and the answer of /qr version.
export function describeBuild(b: Build): string {
  return `quality-router v${b.version ?? '?'}（読み込み元: ${b.root ?? '不明'}）`
}

// The latest judgment, for /qr: the level sent, then what Haiku
// judged when the bounds or a skill floor moved it, and the mid-turn bump.
function describeMain(main: MainView): string {
  if (main.level === undefined) return 'まだありません'
  const notes: string[] = []
  if (main.judged && main.judged !== main.level) notes.push(`judged ${main.judged}`)
  if (main.bump) notes.push('+1')
  return `${main.level}${notes.length ? `（${notes.join('、')}）` : ''}`
}

// `main` adds the latest judgment: register.ts passes the MainView the status line draws.
export function describeSettings(s: Settings, paused: boolean, skill: string | null, main?: MainView, build?: Build): string {
  return [
    `quality-router${build ? ` v${build.version ?? '?'}` : ''} の設定`,
    `- 振り分け（本体の Effort・本体モデルの守り・子）: ${s.mode}${paused ? '（effort-router を検知したため、本体の Effort は止めています）' : ''}`,
    `- Workflow の点検: ${s.gate}`,
    `- 本体モデルの守り: ${s.guard}（上位モデル: ${s.top}${s.mode === 'off' ? '。振り分けが off の間は止まります' : ''}）`,
    `- 本体の段階: floor ${s.floor} / ceiling ${s.ceiling}`,
    `- スキル連動の下限: ${skill ?? 'なし'}`,
    ...(main ? [`- 直近の判定: ${describeMain(main)}`] : []),
    ...(build ? [`- 読み込み元: ${build.root ?? '不明'}`] : []),
  ].join('\n')
}

export type MainLog = {
  at: number
  head: string
  prev: Level | null
  judged: Level | null
  level: Level | null
  why: Why
  // Which bound set the level; null when the judged or inherited level went out as it was.
  bound: Bound | null
  skill: string | null
  bump: boolean
  model: string | null
  guarded: boolean
  durationMs: number
}
export type SubLog = {
  at: number
  description: string
  type: string
  role: string
  why: 'auto' | 'retry' | 'unsure'
  model: string | null
  effort: string | null
  agentId: string | null
}
export type GateLog = {
  at: number
  source: 'script' | 'scriptPath' | 'name'
  verdict: 'pass' | 'deny' | 'warn' | 'unchecked'
  count: number
  calls: number
}

const EMPTY = 'まだ記録がありません。'

export function formatMainLog(list: MainLog[]): string {
  if (list.length === 0) return `main: ${EMPTY}`
  const rows = list.slice(-10).map(o => {
    const judged = o.judged && o.judged !== o.level ? ` (judged ${o.judged})` : ''
    const bound = o.bound ? ` by ${o.bound}` : ''
    const skill = o.skill ? ` [skill ${shortSkill(o.skill)}]` : ''
    const bump = o.bump ? ' +1' : ''
    const model = `${o.model ?? '-'}${o.guarded ? ' (guarded)' : ''}`
    return `  ${o.prev ?? '-'} -> ${o.level ?? '-'}${judged}${bound}${skill}${bump}\t${o.why}\t${model}\t${o.head}`
  })
  return [`main: ${list.length} turns logged`, 'recent (prev -> level):', ...rows].join('\n')
}

export function formatSubLog(list: SubLog[]): string {
  if (list.length === 0) return `sub: ${EMPTY}`
  const rows = list.slice(-10).map(o => `  ${o.role}/${o.why} -> ${o.model ?? '-'} ${o.effort ?? '-'}\t${o.type}\t${o.description}`)
  return [`sub: ${list.length} spawns logged`, ...rows].join('\n')
}

export function formatGateLog(list: GateLog[]): string {
  if (list.length === 0) return `gate: ${EMPTY}`
  const rows = list.slice(-10).map(o => `  ${o.verdict} (${o.count}) ${o.source} calls=${o.calls}`)
  return [`gate: ${list.length} checks logged`, ...rows].join('\n')
}
