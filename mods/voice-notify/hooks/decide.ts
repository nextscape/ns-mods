// 何を読むかの判定。$ に触れない純粋関数だけを置く（単体テストの対象）。
// 0.2.0 の notify.ps1 の判断（ケース・brief・中間報告・フレーズ・サブエージェントの文）と、要約 mod の判定を1つにした。

import { pickSentence, stopCase } from './text'
import type { StopCase } from './text'

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
  shortSentenceChars?: number
  maxTwoSentenceChars?: number
  readings?: Record<string, string>
  lowercaseMinLength?: number
  keepUppercase?: string[]
}

export type VoiceConfig = {
  speaker?: string
  speakerInterim?: string
  speedScale?: number
  pitchScale?: number
  intonationScale?: number
  enginePort?: number
  enginePath?: string
  hotKey?: string
  speakers?: Record<string, { id: number; label?: string; credit?: string }>
  phrases?: Record<string, unknown>
  subagent?: { debounceSeconds?: number; defaultLabel?: string }
  speech?: SpeechConfig
  mute?: { whenMicInUse?: boolean }
  cacheMaxFiles?: number
  playback?: { leadSilenceMs?: number }
  notification?: { toolLabels?: Record<string, string> }
}

export type Role = 'final' | 'interim'
export type Voice = { name: string; id: number }

export const DEFAULT_PROMPT =
  '次に示すのは Claude Code の応答本文です。音声読み上げ用の日本語1文に要約してください。要約文だけを出力してください。'

// 中間報告（サブエージェントの報告と、サブエージェントを待ったまま終えた応答）は声を変える
export function voiceFor(cfg: VoiceConfig, role: Role): Voice {
  const speakers = cfg.speakers ?? {}
  const final = cfg.speaker ?? 'metan'
  const want = role === 'interim' && cfg.speakerInterim && speakers[cfg.speakerInterim] ? cfg.speakerInterim : final
  return { name: want, id: speakers[want]?.id ?? 2 }
}

export function enginePort(cfg: VoiceConfig): number {
  return cfg.enginePort ?? 50021
}

// 本文から読む1〜2文
export function pickFor(cfg: VoiceConfig, text: string): string | null {
  const sp = cfg.speech ?? {}
  return pickSentence(text, { shortMax: sp.shortSentenceChars, twoMax: sp.maxTwoSentenceChars })
}

export type StopInput = { cfg: VoiceConfig; answer: string; durationMs: number; running: number; engineAlive: boolean }
export type StopPlan = {
  role: Role
  case: StopCase | 'solo'
  pcase: StopCase | 'solo' | 'interim'
  brief: boolean
  phrases: string[]
  read: boolean
}

export function planStop(i: StopInput): StopPlan {
  const sp = i.cfg.speech ?? {}
  const role: Role = i.running > 0 ? 'interim' : 'final'
  const readable = !!pickFor(i.cfg, i.answer)
  const kase: StopCase | 'solo' = readable && i.engineAlive ? stopCase(i.answer) : 'solo'
  // 中間報告で「完了しました」と言わないよう、done / solo は interim に差し替える。ask / trouble はそのまま伝える
  const pcase = role === 'interim' && (kase === 'done' || kase === 'solo') ? 'interim' : kase
  // 作業が短いターンは完了を告げるだけにする（本文は読まない）。ask / trouble の別は残す
  const brief = kase !== 'solo' && i.durationMs <= (sp.briefMaxSeconds ?? 30) * 1000
  let first: string
  if (brief) first = `stop/brief/${pcase}`
  else if (kase === 'solo' && pcase === 'interim') first = 'stop/brief/interim'
  else first = `stop/${pcase}`
  // フレーズが無いときの代わり（0.2.0 の notify.ps1 と同じ順）
  const chain = [first, ...(first.startsWith('stop/brief/') ? [`stop/${pcase}`] : []), `stop/${kase}`, 'stop']
  return { role, case: kase, pcase, brief, phrases: [...new Set(chain)], read: !brief && kase !== 'solo' }
}

export type SummaryPlan = { skip: 'disabled' | 'event' | 'short' } | { skip: null; maxChars: number; system: string }

export function planSummary(speech: SpeechConfig, event: 'stop' | 'agentstop', role: Role, answer: string): SummaryPlan {
  if (!speech.summarize) return { skip: 'disabled' }
  if (speech.summarizeEvents && !speech.summarizeEvents.includes(event)) return { skip: 'event' }
  // 途中経過は上限＝下限（上限より短い報告は要約しても縮まらない）
  const interim = role === 'interim' && !!speech.interimMaxChars
  const maxChars = interim ? (speech.interimMaxChars as number) : (speech.summaryMaxChars ?? 60)
  const minChars = interim ? (speech.interimMaxChars as number) : (speech.summaryMinChars ?? 0)
  if (answer.length < minChars) return { skip: 'short' }
  const lines = speech.summaryPrompt && speech.summaryPrompt.length ? [...speech.summaryPrompt] : [DEFAULT_PROMPT]
  if (role === 'interim' && speech.interimPrompt && speech.interimPrompt.length) lines.push(...speech.interimPrompt)
  return { skip: null, maxChars, system: lines.join('\n').split('{maxChars}').join(String(maxChars)) }
}

// 「<説明>が完了しました。<報告>」。報告の頭30文字が既に「完了」を言っていれば繰り返さない
export function agentText(desc: string | null, report: string | null): string | null {
  const dupe = !!report && /完了|終わ|できました/.test(report.slice(0, 30))
  if (desc && report && dupe) return `${desc}。${report}`
  if (desc && report) return `${desc}が完了しました。${report}`
  if (desc) return `${desc}が完了しました。`
  return report || null
}

// 要約が無いときの抜き出し。報告はコミットID・ファイル一覧が続きやすく、長いものは読まずに説明だけにする
export function agentReportFallback(pick: string | null, speech: SpeechConfig): string | null {
  if (!pick) return null
  const max = speech.interimMaxChars ?? speech.summaryMaxChars ?? 60
  const min = speech.interimMaxChars ?? speech.summaryMinChars ?? 0
  return pick.length > Math.max(max, min) + 1 ? null : pick
}

export function permissionText(cfg: VoiceConfig, toolName: string): string {
  return `${cfg.notification?.toolLabels?.[toolName] ?? toolName}の許可待ちです。`
}

export type NoticeKind = 'idle' | 'permission' | 'notification'

// permission_prompt は classic.PermissionRequest（ツール名付き）で読むので、ここでは扱わない
export function noticeKind(notificationType: string): NoticeKind | null {
  if (notificationType === 'idle_prompt') return 'idle'
  if (/^(elicitation_dialog|elicitation_url_dialog|agent_needs_input)$/.test(notificationType)) return 'permission'
  if (/^quota_auto_resume_(fired|stale|disabled)$/.test(notificationType)) return 'notification'
  return null
}

// 直前と同じものを選ばない（「完了しました」の3連発を防ぐ）。random は [0, 1)
export function choosePhrase(files: string[], prev: string | null, random: number): string | null {
  if (files.length === 0) return null
  const pool = files.filter(f => f !== prev)
  const from = pool.length ? pool : files
  return from[Math.min(from.length - 1, Math.floor(random * from.length))]!
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

// 設定と状態の置き場所（ホーム）。VOICE_NOTIFY_HOME、無ければ ~/.claude/voice-notify
export function voiceHome(envHome: string | undefined, userProfile: string | undefined, home: string | undefined): string | null {
  if (envHome && envHome.trim()) return norm(envHome.trim())
  const base = (userProfile && userProfile.trim()) || (home && home.trim())
  return base ? `${norm(base)}/.claude/voice-notify` : null
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export function parseConfig(text: string): VoiceConfig {
  return JSON.parse(stripBom(text)) as VoiceConfig
}
