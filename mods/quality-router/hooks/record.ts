import type { Effort, Level } from '../types'
import type { AgentCall } from './gate-lexer'
import { valueOf } from './gate-rules'
import type { Violation } from './gate-rules'
import { kindOf } from './kinds'
import type { Bound } from './levels'
import type { Why } from './main-effort'
import type { Settings } from './settings'
import type { SubKind, Weight } from './sub-route'

// Records: one JSON line per record. No request, description,
// label or answer text: the transcript's row uuids lead back to them.

export const PART_LIMIT = 3_500_000

export type Common = { v: 1; at: string; session: string; turn: string | null; qr: string | null; tune: string | null }
export type Tokens = { input: number; output: number; cacheRead: number }
export type EndReason = 'answer' | 'aborted' | 'refusal' | 'error'

export type MainRecord = Common & {
  kind: 'main'
  promptUuid: string | null
  answerUuid: string | null
  promptAt: string | null
  promptChars: number
  prev: Level | null
  judged: Level | null
  level: Level | null
  why: Why
  bound: Bound | null
  skill: string | null
  guarded: boolean
  judgeMs: number | null
  steps: number
  tools: number
  toolErrors: number
  bump: boolean
  durationMs: number
  tokens: Tokens | null
  answeredBy: string | null
  reason: EndReason
}

export type SubWhy = 'auto' | 'retry' | 'unsure' | 'explicit' | 'off'
type ChildResult = { steps: number; toolErrors: number; tokens: Tokens | null; durationMs: number; reason: EndReason }

export type SubRecord = Common &
  ChildResult & {
    kind: 'sub'
    agentId: string
    type: string
    descChars: number
    kindJudged: SubKind | null
    weightJudged: Weight | null
    model: string | null
    effort: Effort | null
    why: SubWhy
    retries: number
  }

export type GateCounts = { kinds: Record<string, number>; rules: Record<string, number>; fixes: number }
export type WfGateRecord = Common &
  GateCounts & {
    kind: 'wf'
    phase: 'gate'
    verdict: 'pass' | 'deny' | 'warn' | 'unchecked'
    source: 'script' | 'scriptPath' | 'name'
    calls: number
  }
export type WfChildRecord = Common & ChildResult & { kind: 'wf'; phase: 'child'; agentId: string; model: string | null; effort: string | null }

export type Dir = 'up' | 'down' | 'same' | 'unknown'
export type OverrideSignal = { type: 'override'; what: 'effort' | 'model'; from: string | null; to: string | null; dir: Dir }
export type FeedbackSignal = { type: 'feedback'; dir: 'up' | 'down'; target: 'main' | 'sub'; targetTurn: string | null; targetAgent: string | null }
export type Retry3Signal = { type: 'retry3'; agentId: string | null }
// One intersection per signal, so RecordBody distributes over them.
export type SignalRecord =
  | (Common & { kind: 'signal' } & OverrideSignal)
  | (Common & { kind: 'signal' } & FeedbackSignal)
  | (Common & { kind: 'signal' } & Retry3Signal)

export type SessionRecord = Common & {
  kind: 'session'
  event: 'start' | 'settings'
  root: string | null
  cwd: string | null
  settings: Settings
  paused: boolean
}

export type QrRecord = MainRecord | SubRecord | WfGateRecord | WfChildRecord | SignalRecord | SessionRecord
// A record without the shared fields, which the writer adds.
export type RecordBody<R = QrRecord> = R extends QrRecord ? Omit<R, keyof Common> : never

type UsageLike = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number }

export function common(at: number, session: string, turn: string | null, qr: string | null): Common {
  return { v: 1, at: new Date(at).toISOString(), session, turn, qr, tune: null }
}

export function tokensOf(usage: UsageLike | undefined): Tokens | null {
  if (!usage) return null
  return { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens }
}

// The month is the UTC one of `at` (the session's first record), so a session
// stays in one folder; a part past the first carries its number.
export function recordPath(home: string, at: number, session: string, part: number): string {
  const month = new Date(at).toISOString().slice(0, 7)
  return `${home}/.claude/quality-router/log/${month}/${session}${part > 1 ? `.${part}` : ''}.jsonl`
}

// A label's kind from its literal head ('unknown' when it has none), the
// violations by rule, and the fix: calls (each one a quality failure redone).
export function gateCounts(calls: AgentCall[], violations: Violation[]): GateCounts {
  const kinds: Record<string, number> = {}
  for (const call of calls) {
    const label = call.options.kind === 'object' ? valueOf(call.options.entries['label']) : undefined
    const text = label?.kind === 'literal' ? label.value : label?.kind === 'template' ? label.head : ''
    const kind = kindOf(text) ?? 'unknown'
    kinds[kind] = (kinds[kind] ?? 0) + 1
  }
  const rules: Record<string, number> = {}
  for (const v of violations) rules[v.rule] = (rules[v.rule] ?? 0) + 1
  return { kinds, rules, fixes: kinds['fix'] ?? 0 }
}
