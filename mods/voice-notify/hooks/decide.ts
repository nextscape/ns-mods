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
// or background work still run) take the other voice, when it is defined.
export function voiceFor(cfg: Pick<Config, 'speaker' | 'speakerInterim' | 'speakers'>, role: Role): Voice {
  const interim = role === 'interim' && cfg.speakerInterim && cfg.speakers[cfg.speakerInterim] ? cfg.speakerInterim : null
  const name = interim ?? cfg.speaker
  return { name, id: cfg.speakers[name]!.id }
}

// One or two sentences from the answer to read.
export function pickFor(cfg: Config, text: string): string | null {
  return pickSentence(text, { shortMax: cfg.speech.shortSentenceChars, twoMax: cfg.speech.maxTwoSentenceChars })
}

// `running`: subagents at work. `pending`: the background work the turn's
// classic Stop said it leaves in flight and still waits on; `ended`: the
// background work from before the turn that had ended by that Stop
// (trackFlight); both 0 when no Stop came. `tools`: the tools the turn
// called, null when its start was not seen.
export type StopInput = {
  cfg: Config
  answer: string
  durationMs: number
  running: number
  pending: number
  ended: number
  tools: number | null
  engineAlive: boolean
}
export type StopPlan = {
  role: Role
  case: StopCase | 'solo'
  pcase: StopCase | 'solo' | 'interim'
  brief: boolean
  phrases: string[]
  read: boolean
  // Nothing to say: a short reply that called no tool, read on the screen.
  silent: boolean
}

// What a classic Stop says is still in flight, by id: background tasks, and
// wakeups that fire once. A recurring one (/loop) would make every turn
// interim.
export function inFlight(
  tasks: ReadonlyArray<{ id: string }> | undefined,
  crons: ReadonlyArray<{ id: string; recurring: boolean }> | undefined,
): string[] {
  return [...(tasks ?? []).map(t => t.id), ...(crons ?? []).filter(c => !c.recurring).map(c => `cron:${c.id}`)]
}

// The background work the main conversation's last Stop left in flight
// (`ids`), and which of it no turn waits on any more (`settled`).
export type Flight = { ids: readonly string[]; settled: readonly string[] }

export const NO_FLIGHT: Flight = { ids: [], settled: [] }

// What a Stop's in-flight work means for its turn. `before`: the flight when
// the turn began. `own`: the person asked for the turn (isOwnTurn).
// - `pending`: what the turn leaves in flight and still waits on. Work that
//   was already running when the person asked for something else is settled,
//   from then on: a dev server left running would make every turn interim. A
//   turn a notice started (one of two builds ended) still waits on the rest.
// - `ended`: what was in flight before the turn and no longer is.
export function trackFlight(before: Flight, now: readonly string[], own: boolean): { flight: Flight; pending: number; ended: number } {
  const carried = now.filter(id => before.ids.includes(id))
  const settled = own ? carried : carried.filter(id => before.settled.includes(id))
  return {
    flight: { ids: [...now], settled },
    pending: now.length - settled.length,
    ended: before.ids.filter(id => !now.includes(id)).length,
  }
}

// Where a prompt came from, as `prompt.submit` names it (PromptOrigin); a
// plugin's says `asUser` when it sent the person's words.
export type Origin = { readonly kind: string; readonly asUser?: boolean }

// Origins that are not the person asking: a background task's end, a wakeup,
// another agent's message, a follow-up the engine makes itself.
const NOTICE_ORIGINS: ReadonlySet<string> = new Set([
  'task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'observer', 'observer-activity',
  'auto-continuation',
])

const NOTICE_FRAME = /^\s*(?:<task-notification>|(?:Another Claude session sent a message[^\n]*\n\s*)?<agent-message\b|The \S+ plugin sent a message:)/

// Whether the person asked for the turn, rather than a notice starting it.
// The engine's origin settles it; a prompt of no known origin is told by the
// frame it starts with, and a turn with no prompt ("") is a continuation.
export function isOwnTurn(text: string, origin: Origin | undefined): boolean {
  if (origin !== undefined && origin.kind !== 'unclassified') {
    return origin.kind === 'plugin' ? origin.asUser === true : !NOTICE_ORIGINS.has(origin.kind)
  }
  return text.trim() !== '' && !NOTICE_FRAME.test(text)
}

// The origin of the prompt a turn starts with, among those submitted since
// the last turn began (the latest first): the one whose text is the turn's,
// or its last lines under a frame ("The <name> plugin sent a message:\n…").
// One delivered into a running turn matches no later turn.
export function originOf<O>(text: string, submitted: ReadonlyArray<{ text: string; origin: O }>): O | undefined {
  const turn = text.trim()
  for (let i = submitted.length - 1; i >= 0; i--) {
    const one = submitted[i]!.text.trim()
    if (one !== '' && (turn === one || turn.endsWith(`\n${one}`))) return submitted[i]!.origin
  }
  return undefined
}

export function planStop(i: StopInput): StopPlan {
  const role: Role = i.running > 0 || i.pending > 0 ? 'interim' : 'final'
  const readable = !!pickFor(i.cfg, i.answer)
  const kase: StopCase | 'solo' = readable && i.engineAlive ? stopCase(i.answer) : 'solo'
  // An interim report must not say it is done: done and solo become interim.
  // ask and trouble still say what they are.
  const pcase = role === 'interim' && (kase === 'done' || kase === 'solo') ? 'interim' : kase
  // A short turn only says it finished (no body), keeping ask and trouble apart.
  const short = i.durationMs <= i.cfg.speech.briefMaxSeconds * 1000
  const brief = kase !== 'solo' && short
  let first: string
  if (brief) first = `stop/brief/${pcase}`
  else if (kase === 'solo' && pcase === 'interim') first = 'stop/brief/interim'
  else first = `stop/${pcase}`
  // Where a folder has no phrase, the next stands in (the order 0.2.0's
  // notify.ps1 used).
  const chain = [first, ...(first.startsWith('stop/brief/') ? [`stop/${pcase}`] : []), `stop/${kase}`, 'stop']
  // A short reply with no tool called was not work to report, whether or not
  // its body can be read (so not by `brief` or `kase`, which a dead engine
  // changes). Still said: ask and trouble, and the end of background work,
  // which the person last heard was going on.
  const silent = short && i.tools === 0 && i.ended === 0 && stopCase(i.answer) === 'done'
  return { role, case: kase, pcase, brief, phrases: [...new Set(chain)], read: !brief && kase !== 'solo', silent }
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
