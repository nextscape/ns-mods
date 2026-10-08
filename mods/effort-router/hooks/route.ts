import type { Level, Option, TurnSignals } from '../types'

// Pure routing logic: what the classifier reads, and how its answer becomes
// the turn's effort. No `$` here, so tests and the eval share it as is.

// Tuned for Claude Opus 5.5 (and used for every routed model), whose default is medium and whose medium
// already does ordinary multistep coding well; max is never picked.
export const LEVELS: readonly Level[] = ['low', 'medium', 'high', 'xhigh']

// The classifier must answer a label verbatim, so labels are single words
// and their definitions lead the text it reads.
export const LABELS: readonly string[] = LEVELS

const RUBRIC = [
  '[rubric] Judge how much reasoning the [request] needs, reading it in the context of [prev]. Judge by how uncertain the right answer is and how costly a miss would be, not by the amount of work:',
  'low = nothing could be overlooked: chat, a confirmation, thanks or closing, a translation, a commit, a fully specified mechanical edit (a typo, a rename, a move);',
  'medium = ordinary work with a clear approach: implementing a settled approach or design, adding a test, explaining code, looking something up;',
  'high = the right answer is uncertain: finding the cause of a bug, comparing design options, reviewing a diff, sorting out vague requirements;',
  'xhigh = a miss is costly and the work is hard: a review or audit of a whole codebase, finding every occurrence of something across a project, a project-wide migration, a fundamental redesign or root-cause fix, a fix that still fails, concurrency, security or data-loss risks, or long autonomous work.',
].join(' ')

// Added only when they apply, so an ordinary request reads the rubric alone.
const CHOICE_RULE =
  '[choice] The [request] picks the [selected] options the previous answer offered: judge the work those options name on the same scale (a commit or closing is low, implementing a settled approach is medium), however heavy the previous turn was.'
const REPLY_RULE =
  '[reply] The [request] is a short reply agreeing to what [prev_answer_tail] proposed or asked. Read it as a request for that proposed work, stated in full, and judge that work on the same scale; the agreement itself weighs nothing (agreeing to a commit is low, to drafting a spec or design is high, to investigating a cause is high).'

// A turn still running after this many model requests since it was judged,
// or after this many tool errors, goes up one level (once per judgment).
export const ESCALATE_STEPS = 10
export const ESCALATE_ERRORS = 2

// Prompts this short made only of agreement ("続けて", "OK") skip the
// classifier and inherit, unless they pick an offered option or answer a
// question. Any other short prompt ("全体を監査して", "やめて") is judged.
export const MIN_CHARS = 20

const MAX_OPTIONS = 10
const OPTION_CHARS = 150
const ASK_TAIL_CHARS = 200

const PREV_REQUEST_CHARS = 100
const ANSWER_TAIL_CHARS = 300
const REQUEST_HEAD_CHARS = 600
const REQUEST_TAIL_CHARS = 200

export function levelOf(label: string | undefined): Level | undefined {
  const head = label?.split(':')[0]?.trim()
  return LEVELS.find(level => level === head)
}

// The session's own effort as a step names it, read as one of ours.
export function asLevel(effort: string | number | undefined): Level | null {
  if (effort === 'max' || effort === 'xhigh') return 'xhigh'
  if (effort === 'high' || effort === 'medium' || effort === 'low') return effort
  return null
}

// Routed: Opus and Sonnet from 5.5 on, Fable and Mythos from 5.1 on, the
// models that keep the prompt cache across effort changes. A later version
// (Opus 6, Sonnet 5.6) is routed too. The rubric is tuned for Opus 5.5.
const ROUTED_FROM: Readonly<Record<string, number>> = { opus: 5.5, sonnet: 5.5, fable: 5.1, mythos: 5.1 }

export function isRouted(model: string): boolean {
  const found = /claude-(opus|sonnet|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(model)
  if (!found) return false
  const version = Number(found[2]) + Number(found[3] ?? 0) / 10
  return version >= ROUTED_FROM[found[1]!]!
}

// What `/effort <args>` sets, when the args name a level.
export function effortArg(args: string): string | null {
  const word = args.trim().toLowerCase()
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(word) ? word : null
}

// A background task's completion notice is not the person's request.
export function isNotice(text: string): boolean {
  return /^\s*<task-notification>/.test(text)
}

export function rank(level: Level): number {
  return LEVELS.indexOf(level)
}

export function maxLevel(levels: ReadonlyArray<Level | null>): Level | null {
  let best: Level | null = null
  for (const level of levels) {
    if (level && (best === null || rank(level) > rank(best))) best = level
  }
  return best
}

// The level for the next request: one up once the turn has run long or hit
// errors since it was judged, never above xhigh.
export function escalate(level: Level, steps: number, errors: number): Level {
  const bump = steps > ESCALATE_STEPS || errors >= ESCALATE_ERRORS ? 1 : 0
  return LEVELS[Math.min(rank(level) + bump, LEVELS.length - 1)]!
}

// Code and stack traces become markers: the signal stays, the tokens go.
export function compact(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang: string, body: string) => {
      const lines = body.split('\n').filter(Boolean).length
      return `[code${lang ? `: ${lang}` : ''} ${lines} lines]`
    })
    .replace(/(?:^[ \t]*(?:at .+|File ".+", line \d+.*)\n?){3,}/gm, run => {
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
// excerpts, then this request, compacted and clipped, and the options it picked.
export function compose(
  request: string,
  prev: TurnSignals | null,
  recent: ReadonlyArray<Level | null>,
  route: Route = { why: 'auto', selected: [] },
): string {
  const { why, selected } = route
  const lines: string[] = [RUBRIC]
  if (why === 'choice') lines.push(CHOICE_RULE)
  if (why === 'reply') lines.push(REPLY_RULE)
  if (prev) {
    const max3 = maxLevel(recent) ?? 'default'
    lines.push(
      `[prev] effort=${prev.level ?? 'default'} steps=${prev.steps} tools=${prev.tools} tool_errors=${prev.toolErrors} dur=${Math.round(prev.durationMs / 1000)}s max3=${max3}`,
      `[prev_request] ${prev.request}`,
      `[prev_answer_tail] ${prev.answerTail}`,
    )
  }
  // A bare "OK" pulls the judgment to low whatever it agrees to, so a reply
  // to a question (only ever agreement, see plan) is stated as the request
  // for the proposed work it is, offered options or not. Not so a typed
  // AskUserQuestion answer: that says what to do itself.
  const agrees = why === 'reply' && !('questions' in route)
  lines.push(
    agrees
      ? `[request] go ahead with what [prev_answer_tail] proposed (the reply was: ${clip(compact(request))})`
      : `[request chars=${request.length}] ${clip(compact(request))}`,
  )
  if (selected.length > 0) {
    lines.push(`[selected] ${selected.map(one => `${one.key}: ${one.text}`).join(' | ')}`)
  }
  return lines.join('\n')
}

// `asked`: re-judged mid-turn from an AskUserQuestion answer. `notice`: a
// background task's notice, which keeps the level before it. `manual`: the
// person set the effort with /effort, which runs as set.
export type Why = 'auto' | 'choice' | 'reply' | 'asked' | 'short' | 'notice' | 'manual' | 'unsure' | 'error'
export type Decision = { level: Level | undefined; judged: Level | null; why: Why }

// The turn's effort from the classifier's answer (undefined: none matched;
// an Error: the call failed): the judgment as is, or the previous turn's
// level when there is none. A judgment that was too low is raised mid-turn.
export function decide(
  answer: string | undefined | Error,
  prev: Level | null,
  why: 'auto' | 'choice' | 'reply' = 'auto',
): Decision {
  if (answer instanceof Error) return { level: prev ?? undefined, judged: null, why: 'error' }
  const judged = levelOf(answer)
  if (judged === undefined) return { level: prev ?? undefined, judged: null, why: 'unsure' }
  return { level: judged, judged, why }
}

// CRLF reads as LF; full-width digits and letters as ASCII; a circled
// number as "1.".
function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[①-⑳]/g, c => `${c.charCodeAt(0) - 0x2460 + 1}.`)
}

function cleanOption(text: string): string {
  const line = oneLine(text.replace(/\*\*|`/g, '').replace(/\|\s*$/, '').replace(/\s*\|\s*/g, ' / '))
  return line.length <= OPTION_CHARS ? line : `${line.slice(0, OPTION_CHARS)}…`
}

const OPTION_LINE = /^\s*(?:[-*+]\s+)?(?:\*\*)?(?:案|option\s*)?[(（]?(\d{1,2}|[A-Za-z])(?:[.．)）:：、])(?:\*\*)?\s*(?!\d)(.+)$/i
const OPTION_ROW = /^\s*\|\s*(?:\*\*)?(\d{1,2}|[A-Za-z])(?:\*\*)?\s*\|(.+)$/

// The last run of numbered or lettered lines in the answer (a list, or the
// rows of a table): a new run starts at 1 or a. Lines inside a code block
// are code, not options.
export function optionsOf(answer: string): Option[] {
  let run: Option[] = []
  let last: Option[] = []
  let inCode = false
  for (const raw of normalize(answer).split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inCode = !inCode
      continue
    }
    if (inCode) continue
    const found = OPTION_LINE.exec(raw) ?? OPTION_ROW.exec(raw)
    if (!found) continue
    const key = found[1]!.toLowerCase()
    const text = cleanOption(found[2]!)
    if (text === '') continue
    if (key === '1' || key === 'a' || run.length === 0) {
      run = []
      last = run
    }
    if (run.length < MAX_OPTIONS && !run.some(one => one.key === key)) run.push({ key, text })
  }
  return last
}

// Whether the answer ends by offering choices or asking something.
export function asksOf(answer: string, options: readonly Option[]): boolean {
  if (options.length > 0) return true
  const end = tail(answer, ASK_TAIL_CHARS)
  return /[?？]/.test(end) || /(ますか|でしょうか|しましょうか|いかがですか|ませんか)/.test(end)
}

const KEY = /\b(\d{1,2}|[A-Za-z])\b/g
const FILLER =
  /選択肢|オプション|option|and|please|お願い|おねがい|いたします|致します|します|ください|下さい|進めて|すすめて|して|やって|実行|でいい|いい|です|案|番|目|で|を|に|は|と|も|の|よ|ね|[\s、,。.．!！&+・/／~〜]/gi

// The offered options a reply picks ("2", "2で", "1と3でお願いします"), or
// null when it is anything else or names a key that was not offered.
export function picked(text: string, options: readonly Option[]): Option[] | null {
  if (options.length === 0) return null
  const line = normalize(text).trim()
  const keys = [...line.matchAll(KEY)].map(found => found[1]!.toLowerCase())
  if (keys.length === 0) return null
  if (line.replace(KEY, '').replace(FILLER, '') !== '') return null
  const chosen = keys.map(key => options.find(one => one.key === key))
  if (chosen.some(one => one === undefined)) return null
  return chosen.filter((one, i): one is Option => one !== undefined && chosen.indexOf(one) === i)
}

const AGREE =
  /^(?:ok|okay|おk|おけ|おっけー|オッケー|はい|うん|ええ|了解|りょうかい|承知|yes|yep|sure|please|go|ahead|lgtm|お願い|おねがい|よろしく|頼む|頼みます|どうぞ|ぜひ|それで|これで|そう|いい|良い|進めて|すすめて|やって|続けて|つづけて|続き|続行|して|します|いたします|致します|ください|下さい|です|じゃあ|では|で|よ|ね|も|お)+$/

// Whether the prompt only agrees or says go on ("OK", "はい、進めてください",
// "続けて"), naming no work of its own. "いいえ", "やめて", "もういい" do not.
export function isAgreement(text: string): boolean {
  return AGREE.test(normalize(text).toLowerCase().replace(/[\s、,。.．!！~〜…・]/g, ''))
}

export type Route = { why: 'auto' | 'choice' | 'reply'; selected: readonly Option[] }
export type Plan = { kind: 'keep' } | ({ kind: 'judge' } & Route)

// How to read this prompt: a pick of offered options, a short agreement to a
// question, a short agreement with nothing to read it against, or a request
// (a short one naming its own work, or declining, included).
export function plan(text: string, prev: TurnSignals | null): Plan {
  const selected = picked(text, prev?.options ?? [])
  if (selected) return { kind: 'judge', why: 'choice', selected }
  if (text.length >= MIN_CHARS || !isAgreement(text)) return { kind: 'judge', why: 'auto', selected: [] }
  if (prev?.asks === true) return { kind: 'judge', why: 'reply', selected: [] }
  return { kind: 'keep' }
}

// What AskUserQuestion hands back: the questions with their options, the
// answers keyed by question text (multi-select comma-separated), and the
// text typed instead of picking.
export type Asked = {
  questions?: ReadonlyArray<{
    question: string
    header: string
    options?: ReadonlyArray<{ label: string; description?: string }>
    multiSelect?: boolean
  }>
  answers?: Readonly<Record<string, string>>
  response?: string
}

export type AskedRoute = Route & {
  why: 'choice' | 'reply'
  request: string
  questions: string
  picked: string
}

// The answers as a request to judge: picked options carry their
// descriptions; anything typed makes it a reply to the questions.
export function fromAsked(asked: Asked): AskedRoute | null {
  const selected: Option[] = []
  const lines: string[] = []
  const headers: string[] = []
  let typed = false
  for (const one of asked.questions ?? []) {
    const answer = asked.answers?.[one.question]?.trim()
    if (!answer) continue
    lines.push(`${one.header}: ${answer}`)
    headers.push(one.header)
    const find = (label: string) => one.options?.find(option => option.label === label.trim())
    const whole = find(answer)
    const parts = whole ? [whole] : one.multiSelect ? answer.split(/,\s*/).map(find) : [undefined]
    if (parts.some(part => part === undefined)) {
      typed = true
      continue
    }
    for (const part of parts) {
      const text = part!.description ? `${part!.label} — ${part!.description}` : part!.label
      selected.push({ key: one.header, text: cleanOption(text) })
    }
  }
  const response = asked.response?.trim()
  if (response) {
    lines.push(response)
    typed = true
  }
  if (lines.length === 0) return null
  return {
    why: typed ? 'reply' : 'choice',
    selected,
    request: lines.join('\n'),
    questions: (asked.questions ?? []).map(one => one.question).join(' / '),
    picked: [...new Set(headers)].join(',') || 'text',
  }
}
