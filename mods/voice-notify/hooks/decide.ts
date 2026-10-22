// What to say, as pure functions (unit-tested directly): the stop case, the
// brief and interim reports, the phrase folders, the subagent sentence (from
// 0.2.0's notify.ps1), and when to summarize (from the summary mod).

import type { Config, SpeechConfig } from './config'
import { pickSentence, stopCase } from './text'
import type { StopCase } from './text'

export type Role = 'final' | 'interim'
export type Voice = { name: string; id: number }

export const DEFAULT_PROMPT =
  '次に示すのは Claude Code の応答本文です。音声読み上げ用の日本語1文に要約してください。要約文だけを出力してください。'

// Interim reports (a subagent's report, an answer that ends while subagents
// still run) take the other voice, when it is defined.
export function voiceFor(cfg: Pick<Config, 'speaker' | 'speakerInterim' | 'speakers'>, role: Role): Voice {
  const interim = role === 'interim' && cfg.speakerInterim && cfg.speakers[cfg.speakerInterim] ? cfg.speakerInterim : null
  const name = interim ?? cfg.speaker
  return { name, id: cfg.speakers[name]!.id }
}

// One or two sentences from the answer to read.
export function pickFor(cfg: Config, text: string): string | null {
  return pickSentence(text, { shortMax: cfg.speech.shortSentenceChars, twoMax: cfg.speech.maxTwoSentenceChars })
}

export type StopInput = { cfg: Config; answer: string; durationMs: number; running: number; engineAlive: boolean }
export type StopPlan = {
  role: Role
  case: StopCase | 'solo'
  pcase: StopCase | 'solo' | 'interim'
  brief: boolean
  phrases: string[]
  read: boolean
}

export function planStop(i: StopInput): StopPlan {
  const role: Role = i.running > 0 ? 'interim' : 'final'
  const readable = !!pickFor(i.cfg, i.answer)
  const kase: StopCase | 'solo' = readable && i.engineAlive ? stopCase(i.answer) : 'solo'
  // An interim report must not say it is done: done and solo become interim.
  // ask and trouble still say what they are.
  const pcase = role === 'interim' && (kase === 'done' || kase === 'solo') ? 'interim' : kase
  // A short turn only says it finished (no body), keeping ask and trouble apart.
  const brief = kase !== 'solo' && i.durationMs <= i.cfg.speech.briefMaxSeconds * 1000
  let first: string
  if (brief) first = `stop/brief/${pcase}`
  else if (kase === 'solo' && pcase === 'interim') first = 'stop/brief/interim'
  else first = `stop/${pcase}`
  // Where a folder has no phrase, the next stands in (the order 0.2.0's
  // notify.ps1 used).
  const chain = [first, ...(first.startsWith('stop/brief/') ? [`stop/${pcase}`] : []), `stop/${kase}`, 'stop']
  return { role, case: kase, pcase, brief, phrases: [...new Set(chain)], read: !brief && kase !== 'solo' }
}

// What Haiku is sent of an answer: a long one only by its head and tail
// (where the point and the conclusion sit), to bound the cost and the wait.
const SUMMARY_HEAD_CHARS = 3000
const SUMMARY_TAIL_CHARS = 1000

export function summaryInput(answer: string): string {
  if (answer.length <= SUMMARY_HEAD_CHARS + SUMMARY_TAIL_CHARS) return answer
  return `${answer.slice(0, SUMMARY_HEAD_CHARS)}\n…（中略）…\n${answer.slice(-SUMMARY_TAIL_CHARS)}`
}

export type SummaryPlan = { skip: 'disabled' | 'event' | 'short' } | { skip: null; maxChars: number; system: string }

export function planSummary(speech: SpeechConfig, event: 'stop' | 'agentstop', role: Role, answer: string): SummaryPlan {
  if (!speech.summarize) return { skip: 'disabled' }
  if (!speech.summarizeEvents.includes(event)) return { skip: 'event' }
  // An interim report's cap is also its floor: a report already shorter
  // would not get shorter by summarizing. 0 turns the interim cap off.
  const interim = role === 'interim' && speech.interimMaxChars > 0
  const maxChars = interim ? speech.interimMaxChars : speech.summaryMaxChars
  const minChars = interim ? speech.interimMaxChars : speech.summaryMinChars
  if (answer.length < minChars) return { skip: 'short' }
  const lines = speech.summaryPrompt.length > 0 ? [...speech.summaryPrompt] : [DEFAULT_PROMPT]
  if (role === 'interim') lines.push(...speech.interimPrompt)
  return { skip: null, maxChars, system: lines.join('\n').split('{maxChars}').join(String(maxChars)) }
}

// "<description>が完了しました。<report>", without saying done twice when the
// report's first 30 characters already do.
export function agentText(desc: string | null, report: string | null): string | null {
  const dupe = !!report && /完了|終わ|できました/.test(report.slice(0, 30))
  if (desc && report && dupe) return `${desc}。${report}`
  if (desc && report) return `${desc}が完了しました。${report}`
  if (desc) return `${desc}が完了しました。`
  return report || null
}

// The report read when there is no summary. Reports tend to run on into
// commit ids and file lists, so a long one is dropped and the description
// stands alone.
export function agentReportFallback(pick: string | null, speech: SpeechConfig): string | null {
  if (!pick) return null
  const cap = speech.interimMaxChars > 0 ? speech.interimMaxChars : Math.max(speech.summaryMaxChars, speech.summaryMinChars)
  return pick.length > cap + 1 ? null : pick
}

export function permissionText(cfg: Config, toolName: string): string {
  return `${cfg.notification.toolLabels[toolName] ?? toolName}の許可待ちです。`
}

export type NoticeKind = 'idle' | 'permission' | 'notification'

// permission_prompt is read from classic.PermissionRequest, which names the
// tool, so it is not handled here.
export function noticeKind(notificationType: string): NoticeKind | null {
  if (notificationType === 'idle_prompt') return 'idle'
  if (/^(elicitation_dialog|elicitation_url_dialog|agent_needs_input)$/.test(notificationType)) return 'permission'
  if (/^quota_auto_resume_(fired|stale|disabled)$/.test(notificationType)) return 'notification'
  return null
}

// Never the previous pick unless it is the only one (no "完了しました" three
// times running). `random` is in [0, 1).
export function choosePhrase(files: string[], prev: string | null, random: number): string | null {
  if (files.length === 0) return null
  const pool = files.filter(f => f !== prev)
  const from = pool.length ? pool : files
  return from[Math.min(from.length - 1, Math.floor(random * from.length))]!
}
