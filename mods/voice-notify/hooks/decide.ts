// voice-notify の要約 mod の判定・組み立て・整形。$ に触れない純粋関数だけを置く（単体テストの対象）。
// 判定は notify.ps1 の読み上げ判断と揃える: 読まれない要約を作らない（Haiku の呼び出しが無駄になる）。

export type SpeechConfig = {
  summarize?: boolean
  summarizeEvents?: string[]
  summaryModel?: string
  summaryMinChars?: number
  summaryMaxChars?: number
  interimMaxChars?: number
  interimPrompt?: string[]
  summaryPrompt?: string[]
  summaryTimeoutSec?: number
  briefMaxSeconds?: number
}
export type VoiceConfig = { speech?: SpeechConfig }

export type Kind = 'final' | 'interim'
export type SkipWhy = 'disabled' | 'event' | 'muted' | 'aborted' | 'brief' | 'short'

export type DecideInput = {
  speech: SpeechConfig
  muted: boolean
  agentId: string | undefined
  answer: string
  durationMs: number
  isAborted: boolean
  reason: string
  runningAgents: number
}

export type Summarize = { skip: null; kind: Kind; maxChars: number; system: string }
export type Decision = { skip: SkipWhy } | Summarize

// mod と notify.ps1 の間の取り決め（state/summaries/*.json の中身）。要約するときだけ書く。
// len と head は「どの応答の要約か」。notify は自分の本文と一致したときだけ使う（時刻で推測しない）
export type SummaryRecord = {
  v: 1
  status: 'pending' | 'done' | 'error'
  turnId: string
  at: number
  kind: Kind
  len: number
  head: string
  text?: string
  ms?: number
  reason?: string
}

export const HEAD_CHARS = 16

export const DEFAULT_PROMPT =
  '次に示すのは Claude Code の応答本文です。音声読み上げ用の日本語1文に要約してください。要約文だけを出力してください。'

// notify.ps1 の Get-RunningAgents と同じ（取り残しは1時間で数えない）
export const AGENT_STALE_MS = 60 * 60 * 1000

export function decide(i: DecideInput): Decision {
  const sp = i.speech
  if (!sp.summarize) return { skip: 'disabled' }
  const event = i.agentId ? 'agentstop' : 'stop'
  if (sp.summarizeEvents && !sp.summarizeEvents.includes(event)) return { skip: 'event' }
  if (i.muted) return { skip: 'muted' }
  if (i.isAborted || i.reason !== 'answer') return { skip: 'aborted' }
  // 短いターンは notify が本文を読まない（完了を告げるだけ）
  if (!i.agentId && i.durationMs <= (sp.briefMaxSeconds ?? 30) * 1000) return { skip: 'brief' }
  const kind: Kind = i.agentId || i.runningAgents > 0 ? 'interim' : 'final'
  // 途中経過は上限＝下限（上限より短い報告は要約しても縮まらない。notify.ps1 の Enter-Interim と同じ）
  const interim = kind === 'interim' && !!sp.interimMaxChars
  const maxChars = interim ? (sp.interimMaxChars as number) : (sp.summaryMaxChars ?? 60)
  const minChars = interim ? (sp.interimMaxChars as number) : (sp.summaryMinChars ?? 0)
  if (i.answer.length < minChars) return { skip: 'short' }
  return { skip: null, kind, maxChars, system: buildPrompt(sp, kind, maxChars) }
}

export function buildPrompt(sp: SpeechConfig, kind: Kind, maxChars: number): string {
  const lines = sp.summaryPrompt && sp.summaryPrompt.length ? [...sp.summaryPrompt] : [DEFAULT_PROMPT]
  if (kind === 'interim' && sp.interimPrompt && sp.interimPrompt.length) lines.push(...sp.interimPrompt)
  return lines.join('\n').split('{maxChars}').join(String(maxChars))
}

// Haiku は「要約文：」のような前置きや2行目を付けることがある（2026-10-06 実測）
export function cleanSummary(raw: string, maxChars: number): { text: string } | { error: string } {
  // 前置きを外してから行を選ぶ（「要約：」だけの行が先に来ることがある）
  const lines = raw.split(/\r?\n/).map(s => s.replace(/^\s*(要約|報告)文?\s*[:：]/, '').replace(/\s+/g, ' ').trim())
  const text = lines.find(s => s.length > 0) ?? ''
  if (!text) return { error: 'empty-reply' }
  if (text.length > maxChars * 3) return { error: `too-long (${text.length})` }
  return { text }
}

const safe = (s: string) => s.replace(/[^0-9A-Za-z_-]/g, '_')

export function summaryFileName(sessionId: string, agentId?: string): string {
  return agentId ? `${safe(sessionId)}__${safe(agentId)}.json` : `${safe(sessionId)}.json`
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

// 設定と状態の置き場所（ホーム）。プラグイン本体はキャッシュで版ごとに置き換わるので、その外に置く。
// notify.ps1 の Get-VoiceHome と同じ規則（VOICE_NOTIFY_HOME、無ければ ~/.claude/voice-notify）
export function voiceHome(envHome: string | undefined, userProfile: string | undefined, home: string | undefined): string | null {
  if (envHome && envHome.trim()) return norm(envHome.trim())
  const base = (userProfile && userProfile.trim()) || (home && home.trim())
  return base ? `${norm(base)}/.claude/voice-notify` : null
}

// 先頭の BOM（U+FEFF）を落とす。Windows PowerShell 5.1 は BOM 付きで書く
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export function parseConfig(text: string): VoiceConfig {
  return JSON.parse(stripBom(text)) as VoiceConfig
}

export function isRunningAgent(content: string, mtimeMs: number, now: number, sessionId: string): boolean {
  if (now - mtimeMs > AGENT_STALE_MS) return false
  return stripBom(content).trim() === sessionId
}
