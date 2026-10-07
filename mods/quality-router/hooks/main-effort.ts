import type { Level, TurnSignals } from '../types'
import { LEVELS, down, maxLevel, rank } from './levels'

// Pure judgment of the main loop's level. Adapted from effort-router v0.3.0
// (hooks/route.ts, in this marketplace): compose, compact, the one-word labels and the
// one-level-a-turn drop; max, the second-judgment confirm and the judged
// value are new here.

// The classifier must answer a label verbatim, so labels are single words
// and their definitions lead the text it reads.
export const LABELS: readonly string[] = LEVELS

// Set from docs/decisions/effort-cache.md (Task 1).
export const DOWN_CONFIRM_TURNS: 1 | 2 = 1
export const MID_TURN_BUMP = true

const RUBRIC = [
  '[rubric] Judge how much reasoning the [request] needs, reading it in the context of [prev]:',
  'medium = no code change or a one-spot text fix: a quick answer, a confirmation, a typo, a commit, thanks or closing;',
  'high = an ordinary code change or explanation: a rename, adding a test, explaining or reviewing code;',
  'xhigh = anything that must find a cause (a failing test, an error, a stack trace, "it does not work"), design or planning, a multi-file change, deep analysis, or a follow-up that continues such work (implementing an option just chosen from a design, a fix that still fails);',
  'max = a cause still not found after a fix already failed ([prev] tool_errors above 0 and the same problem goes on), an irreversible design, migration or data decision, or an explicit request for the deepest possible analysis.',
].join(' ')

// Prompts this short ("続けて", "OK") skip the classifier and inherit.
export const MIN_CHARS = 20

const PREV_REQUEST_CHARS = 100
const ANSWER_TAIL_CHARS = 300
const REQUEST_HEAD_CHARS = 600
const REQUEST_TAIL_CHARS = 200

export function levelOf(label: string | undefined): Level | undefined {
  const first = label?.split(':')[0]?.trim()
  return LEVELS.find(level => level === first)
}

// Code and stack traces become markers: the signal stays, the tokens go.
export function compact(text: string): string {
  return text
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang: string, body: string) => {
      const lines = body.split('\n').filter(Boolean).length
      return `[code${lang ? `: ${lang}` : ''} ${lines} lines]`
    })
    // A frame: a JavaScript `at …` line, or a Python `File "…", line N` line
    // with the source line(s) Python prints under it, indented deeper.
    .replace(/(?:^[ \t]*(?:at .+|File ".+", line \d+.*(?:\n[ \t]{4,}\S.*){0,2})\n?){3,}/gm, run => {
      const lines = run.split('\n').filter(Boolean).length
      return `[stack trace: ${lines} lines]\n`
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function clip(text: string): string {
  if (text.length <= REQUEST_HEAD_CHARS + REQUEST_TAIL_CHARS) return text
  return `${text.slice(0, REQUEST_HEAD_CHARS)} … ${text.slice(-REQUEST_TAIL_CHARS)}`
}

export function tail(text: string, chars = ANSWER_TAIL_CHARS): string {
  const line = oneLine(compact(text))
  return line.length <= chars ? line : `…${line.slice(-chars)}`
}

export function head(text: string, chars = PREV_REQUEST_CHARS): string {
  const line = oneLine(compact(text))
  return line.length <= chars ? line : `${line.slice(0, chars)}…`
}

// What the classifier reads: the previous turn as signals and two short
// excerpts, then this request, compacted and clipped.
export function compose(
  request: string,
  prev: TurnSignals | null,
  recent: ReadonlyArray<Level | null>,
): string {
  const lines: string[] = [RUBRIC]
  if (prev) {
    const max3 = maxLevel(...recent) ?? 'default'
    lines.push(
      `[prev] effort=${prev.level ?? 'default'} steps=${prev.steps} tools=${prev.tools} tool_errors=${prev.toolErrors} dur=${Math.round(prev.durationMs / 1000)}s max3=${max3}`,
      `[prev_request] ${prev.request}`,
      `[prev_answer_tail] ${prev.answerTail}`,
    )
  }
  lines.push(`[request chars=${request.length}] ${clip(compact(request))}`)
  return lines.join('\n')
}

// Up at once; down one level a turn at most. With confirm 2, down only when
// the previous turn was also judged lower than the level it ran at.
export function limitDown(
  judged: Level,
  prev: TurnSignals | null,
  confirm: 1 | 2 = DOWN_CONFIRM_TURNS,
): Level {
  const prevLevel = prev?.level ?? null
  if (prevLevel === null || rank(judged) >= rank(prevLevel)) return judged
  if (confirm === 2 && !(prev?.judged && rank(prev.judged) < rank(prevLevel))) return prevLevel
  return maxLevel(judged, down(prevLevel)) ?? judged
}

// 'late': no judgment had arrived (turn.step stopped waiting at its bound, or
// A was off when the turn began); the steps inherited the previous level.
export type Why = 'auto' | 'short' | 'unsure' | 'error' | 'late'

// base null: the session's own effort, resolved at the step.
export type Decision = { base: Level | null; judged: Level | null; why: Why }

export function decide(
  answer: string | undefined | Error,
  prev: TurnSignals | null,
  confirm: 1 | 2 = DOWN_CONFIRM_TURNS,
): Decision {
  const kept = prev?.level ?? null
  if (answer instanceof Error) return { base: kept, judged: null, why: 'error' }
  const judged = levelOf(answer)
  if (judged === undefined) return { base: kept, judged: null, why: 'unsure' }
  return { base: limitDown(judged, prev, confirm), judged, why: 'auto' }
}

export function shortDecision(prev: TurnSignals | null): Decision {
  return { base: prev?.level ?? null, judged: null, why: 'short' }
}
