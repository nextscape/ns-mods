import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Level, TurnSignals } from '../types'
import { CASES } from './eval-cases'
import type { EvalCase } from './eval-cases'
import {
  LABELS,
  LEVELS,
  asLevel,
  asksOf,
  compose,
  decide,
  effortArg,
  escalate,
  fromAsked,
  head,
  isNotice,
  isRouted,
  levelOf,
  optionsOf,
  plan,
  rank,
  tail,
} from './route'
import type { Asked, Decision, Route } from './route'

// Picks the main thread's effort per prompt: low / medium / high / xhigh,
// judged from the request and the previous turn's signals. A reply that
// picks an offered option ("2") is judged by that option's text; a short
// reply to a question is judged against the question; an AskUserQuestion
// answer is judged mid-turn the same way. A turn that runs long or hits
// errors goes up one level, so a judgment that was too low corrects itself.
// A background task's notice keeps the level before it. Only the routed
// models (isRouted: Opus, Sonnet and Haiku 5.5+, Fable and Mythos 5.1+) are touched;
// on them Claude Code keeps the prompt cache across effort changes. The model
// is never changed. A typed /effort runs as set for one turn; to pin a level,
// turn routing off and use /effort.

const LOG_KEY = 'log'
const MODE_KEY = 'mode'
const LOG_LIMIT = 200
const RECENT = 3

const prevTurn = atom({ plugin: 'effort-router', key: 'prev' } as const, null)
const recentLevels = atom({ plugin: 'effort-router', key: 'recent' } as const, [])

type Turn = Decision & {
  request: string
  picked: string | null
  steps: number
  tools: number
  toolErrors: number
  // `steps` and `toolErrors` when the level was last judged; escalation
  // counts from here.
  since: number
  sinceErrors: number
  // Levels escalation now adds over the judged level, and in all this turn.
  bumps: number
  raised: number
  applied: Level | null
  // Set by /effort: the session's effort goes as is, unjudged, unraised;
  // `shown` is the effort the status line last showed for it.
  manual: boolean
  shown?: string
  // The last step text that offered options: a closing line after a tool
  // call ends the turn's answer without them.
  offer?: string
}

const fresh = {
  steps: 0,
  tools: 0,
  toolErrors: 0,
  since: 0,
  sinceErrors: 0,
  bumps: 0,
  raised: 0,
  applied: null,
  manual: false,
}

type LogEntry = {
  at: number
  head: string
  chars: number
  prev: Level | null
  judged: Level | null
  level: Level | null
  why: Decision['why']
  picked?: string | null
  raised?: number
  steps: number
  toolErrors: number
  durationMs: number
  outputTokens: number | null
}

// The step's response as is; its text kept on the turn when it offers options.
async function* answered<C, R extends { answer: string }>(turn: Turn, stream: AsyncGenerator<C, R>): AsyncGenerator<C, R> {
  const result = yield* stream
  if (optionsOf(result.answer).length > 0) turn.offer = result.answer
  return result
}

export const register: Register = on => {
  let isOn = true
  let current: string | undefined
  // The main thread's model as its last request named it.
  let mainModel: string | undefined
  // A /effort typed between turns: the next turn runs as set.
  let manualNext = false
  const turns = new Map<string, Turn>()

  on('session.start', async ($, e, next) => {
    isOn = (await $.store.get(MODE_KEY)) !== 'off'
    await $.command.register({
      name: 'effort-router',
      description: 'Per-prompt effort routing (a typed /effort runs as set for one turn): on | off | log | log clear | eval',
      argumentHint: '[on|off|log|log clear|eval]',
      immediate: true,
    })
    show($, isOn)
    return next(e)
  })

  on('command.run', { command: 'effort-router' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'log') return { text: await summarize($) }
    if (arg === 'log clear') {
      await $.store.delete(LOG_KEY)
      return { text: 'log cleared.' }
    }
    if (arg === 'eval') return { text: await evaluate($) }
    if (arg === 'on' || arg === 'off') {
      isOn = arg === 'on'
      await $.store.set(MODE_KEY, arg)
      show($, isOn)
    } else if (arg !== '') {
      return { text: `unknown "${arg}" (on | off | log | log clear | eval)` }
    }
    return {
      text: isOn
        ? 'on (picks low/medium/high/xhigh each prompt for Opus/Sonnet 5.5+ and Fable/Mythos 5.1+; a typed /effort runs as set for that turn)'
        : 'off (/effort applies)',
    }
  })

  // A typed /effort applies at once and shows at once, without pinning: the
  // rest of a running turn, or else the next turn, keeps the session's effort
  // as set; the turn after that is judged again.
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const ran = await next(e)
    if (!isOn) return ran
    const turn = current ? turns.get(current) : undefined
    if (turn) turn.manual = true
    else manualNext = true
    const set = effortArg(e.args) ?? (await savedEffort($, mainModel))
    if (turn && set) turn.shown = set
    show($, isOn, { level: undefined, judged: null, why: 'manual', isSession: false, setTo: set })
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (!isOn || e.text === '') return next(e)
    // Before the first request names the model, ask the session for it.
    if (mainModel === undefined) mainModel = await sessionModel($)
    // Another model is in use: no judgment, and no classifier call, for it.
    if (mainModel !== undefined && !isRouted(mainModel)) {
      $.ui.status(`not routed (${mainModel})`)
      return next(e)
    }

    const prev = await read($, prevTurn)
    const prevLevel = prev?.level ?? null
    if (manualNext) {
      manualNext = false
      current = e.turnId
      turns.set(e.turnId, { level: undefined, judged: null, why: 'manual', ...fresh, manual: true, request: e.text, picked: null })
      return next(e)
    }
    const route = isNotice(e.text) ? null : plan(e.text, prev)
    let decision: Decision
    let picked: string | null = null
    if (route === null) {
      decision = { level: prevLevel ?? undefined, judged: null, why: 'notice' }
    } else if (route.kind === 'keep') {
      decision = { level: prevLevel ?? undefined, judged: null, why: 'short' }
    } else {
      const input = compose(e.text, prev, await read($, recentLevels), route)
      decision = decide(await judge($, input), prevLevel, route.why)
      if (route.selected.length > 0) picked = route.selected.map(one => one.key).join(',')
    }
    current = e.turnId
    turns.set(e.turnId, { ...decision, ...fresh, request: e.text, picked })
    if (decision.level !== undefined) show($, isOn, { ...decision, picked, isSession: false })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const turn = e.agentId === undefined && current ? turns.get(current) : undefined
    const ran = await next(e)
    if (turn) {
      turn.tools += 1
      if (ran.deny === undefined && ran.isError === true) turn.toolErrors += 1
    }
    return ran
    // Counting only watches: if it throws, the call's own answer stands.
  }).catch(($, e, next) => next(e))

  // An AskUserQuestion answer arrives mid-turn: judge what was picked and
  // run the rest of the turn at that level, from the next request on.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const ran = await next(e)
    const turn = isOn && e.agentId === undefined && current ? turns.get(current) : undefined
    // A turn the person set with /effort stays as set.
    if (turn === undefined || turn.manual || ran.deny !== undefined || ran.isError === true) return ran
    const asked = fromAsked(ran.result as Asked)
    if (asked === null) return ran

    const from = turn.applied ?? turn.level ?? null
    const context: TurnSignals = {
      level: from,
      steps: turn.steps,
      tools: turn.tools,
      toolErrors: turn.toolErrors,
      durationMs: 0,
      request: head(turn.request),
      answerTail: tail(asked.questions),
    }
    const input = compose(asked.request, context, await read($, recentLevels), asked)
    const decision = decide(await judge($, input), from, asked.why)
    if (decision.why !== 'choice' && decision.why !== 'reply') return ran
    Object.assign(turn, {
      level: decision.level,
      judged: decision.judged,
      why: 'asked',
      picked: asked.picked,
      since: turn.steps,
      sinceErrors: turn.toolErrors,
      bumps: 0,
    })
    show($, isOn, { ...decision, why: 'asked', picked: asked.picked, from, isSession: false })
    return ran
    // Re-judging only watches: if it throws, the answer still reaches the model.
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) mainModel = e.model
    const turn = e.agentId === undefined ? turns.get(e.turnId) : undefined
    if (turn === undefined) return yield* next(e)
    turn.steps += 1
    // Set by /effort: the session's effort goes as is; the status line shows
    // it once it is known, as the request carries it.
    if (turn.manual) {
      turn.applied = asLevel(e.effort)
      const set = e.effort === undefined ? undefined : String(e.effort)
      if (set !== undefined && set !== turn.shown) {
        turn.shown = set
        show($, isOn, { level: undefined, judged: null, why: 'manual', isSession: false, setTo: set })
      }
      return yield* answered(turn, next(e))
    }
    // A model without effort leaves `effort` absent; it stays absent. A model
    // not routed (isRouted) keeps its own effort.
    const base = e.effort === undefined || !isRouted(e.model) ? null : (turn.level ?? asLevel(e.effort))
    if (base === null) {
      turn.applied = asLevel(e.effort)
      return yield* answered(turn, next(e))
    }
    const level = escalate(base, turn.steps - turn.since, turn.toolErrors - turn.sinceErrors)
    const bumps = rank(level) - rank(base)
    if (bumps > turn.bumps) {
      turn.raised += bumps - turn.bumps
      const errors = turn.toolErrors - turn.sinceErrors
      show($, isOn, { ...turn, level, from: turn.applied ?? base, isSession: false, raisedBy: errors > 1 ? `${errors} tool errors` : `${turn.steps - turn.since - 1} requests` })
    }
    turn.bumps = bumps
    turn.applied = level
    // No judgment and nothing raised: the session's own effort goes as is.
    if (turn.level === undefined && level === base) {
      if (turn.steps === 1) show($, isOn, { ...turn, level, isSession: true })
      return yield* answered(turn, next(e))
    }
    return yield* answered(turn, next({ ...e, effort: level }))
  })

  on('turn.complete', async ($, e, next) => {
    const turn = e.agentId === undefined ? turns.get(e.turnId) : undefined
    if (turn) {
      turns.delete(e.turnId)
      if (current === e.turnId) current = undefined
      const prev = await read($, prevTurn)
      const final = optionsOf(e.answer)
      const options = final.length > 0 || turn.offer === undefined ? final : optionsOf(turn.offer)
      const signals: TurnSignals = {
        level: turn.applied,
        steps: turn.steps,
        tools: turn.tools,
        toolErrors: turn.toolErrors,
        durationMs: e.durationMs,
        request: head(turn.request),
        answerTail: tail(e.answer),
        options,
        asks: asksOf(e.answer, options),
      }
      await update($, prevTurn, () => signals)
      await update($, recentLevels, list => [...list, turn.applied].slice(-RECENT))
      const entry: LogEntry = {
        at: await $.clock.now(),
        head: head(turn.request, 40),
        chars: turn.request.length,
        prev: prev?.level ?? null,
        judged: turn.judged,
        level: turn.applied,
        why: turn.why,
        picked: turn.picked,
        raised: turn.raised,
        steps: turn.steps,
        toolErrors: turn.toolErrors,
        durationMs: e.durationMs,
        outputTokens: e.usage?.output_tokens ?? null,
      }
      const log = ((await $.store.get(LOG_KEY)) as LogEntry[] | undefined) ?? []
      await $.store.set(LOG_KEY, [...log, entry].slice(-LOG_LIMIT))
    }
    return next(e)
  })
}

// The classifier's answer, or the Error it rejected with.
async function judge($: EngineInterface, input: string): Promise<string | undefined | Error> {
  try {
    return await $.model.classify(input, LABELS, { model: 'haiku' })
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

// The main loop's model id, or undefined when the session does not name it
// as an id (an alias such as "opus" is left to the first request to settle).
async function sessionModel($: EngineInterface): Promise<string | undefined> {
  try {
    const model = await $.session.model()
    return /^claude-/.test(model) ? model : undefined
  } catch {
    return undefined
  }
}

// The effort /effort saved for the model, as the settings hold it, or null
// when they do not name one (a change for this session only).
async function savedEffort($: EngineInterface, model: string | undefined): Promise<string | null> {
  if (model === undefined) return null
  try {
    const settings = await $.settings.read({})
    const perModel = settings['modelSettings'] as Record<string, { effortLevel?: unknown }> | undefined
    const set = perModel?.[model]?.effortLevel
    return typeof set === 'string' ? set : null
  } catch {
    return null
  }
}

type View = Pick<Decision, 'level' | 'judged' | 'why'> & {
  picked?: string | null
  isSession: boolean
  from?: Level | null
  // Set when the turn was raised: what ran long ("10 requests").
  raisedBy?: string
  // Set by /effort: the effort it set, null until the next request shows it.
  setTo?: string | null
}

// The status line, after the engine's "effort-router:" prefix.
function show($: EngineInterface, isOn: boolean, view?: View) {
  if (!isOn) return $.ui.status('off (/effort applies)')
  if (view === undefined) return $.ui.status('on, waiting for the first prompt')
  if (view.why === 'manual') return $.ui.status(`${view.setTo ?? 'changed'} (set by /effort)`)
  const notes: string[] = []
  if (view.raisedBy !== undefined) notes.push(`raised after ${view.raisedBy}`)
  else {
    if (view.isSession) notes.push('session effort')
    if (view.why === 'choice') notes.push(`choice ${view.picked ?? ''}`.trim())
    if (view.why === 'reply') notes.push('reply to question')
    if (view.why === 'asked') notes.push(`asked: ${view.picked ?? ''}`.trim())
    if (view.why === 'short') notes.push('short prompt, kept')
    if (view.why === 'notice') notes.push('task notice, kept')
    if (view.why === 'unsure' || view.why === 'error') notes.push(`${view.why}, kept`)
  }
  const from = view.from && view.from !== view.level ? `${view.from} → ` : ''
  $.ui.status(`${from}${view.level ?? 'n/a'}${notes.length ? ` (${notes.join(', ')})` : ''}`)
}

async function summarize($: EngineInterface): Promise<string> {
  const log = ((await $.store.get(LOG_KEY)) as LogEntry[] | undefined) ?? []
  if (log.length === 0) return 'no turns logged yet.'

  const rows = new Map<string, { n: number; ms: number }>()
  for (const one of log) {
    const key = one.level ?? `default (${one.why})`
    const row = rows.get(key) ?? { n: 0, ms: 0 }
    rows.set(key, { n: row.n + 1, ms: row.ms + one.durationMs })
  }
  const table = [...rows].map(
    ([key, row]) => `  ${key}: ${row.n} turns, avg ${Math.round(row.ms / row.n / 1000)}s`,
  )
  const recent = log.slice(-10).map(one => {
    const judged = one.judged && one.judged !== one.level ? ` (judged ${one.judged})` : ''
    const why = `${one.picked ? `${one.why} ${one.picked}` : one.why}${one.raised ? ` raised ${one.raised}` : ''}`
    return `  ${one.prev ?? '-'} -> ${one.level ?? '-'}${judged}\t${why}\t${one.steps} steps\t${Math.round(one.durationMs / 1000)}s\t${one.head}`
  })
  return [`${log.length} turns logged`, ...table, 'recent (prev -> level):', ...recent].join('\n')
}

// Runs every eval case through the live classifier and scores the raw
// judgment (before decide() falls back to the previous level) against the
// expected level.
async function evaluate($: EngineInterface): Promise<string> {
  const lines: string[] = []
  let hits = 0
  let low = 0
  let slowest = 0
  for (const one of CASES) {
    const started = await $.clock.now()
    const { input, why } = caseInput(one)
    const answer = await judge($, input)
    const ms = (await $.clock.now()) - started
    slowest = Math.max(slowest, ms)
    const judged = answer instanceof Error ? undefined : levelOf(answer)
    const final = decide(answer, one.prev?.level ?? null, why).level
    const isLow = judged !== undefined && LEVELS.indexOf(judged) < LEVELS.indexOf(one.expect)
    if (judged === one.expect) hits += 1
    if (isLow) low += 1
    const mark = judged === one.expect ? 'ok ' : isLow ? 'LOW' : 'off'
    const error = answer instanceof Error ? ` error: ${answer.message}` : ''
    lines.push(
      `  ${mark} ${one.name}: expect ${one.expect}, judged ${judged ?? '-'}, final ${final ?? '-'} (${ms}ms)${error}`,
    )
  }
  return [
    `eval: ${hits}/${CASES.length} match, ${low} judged too low, slowest ${slowest}ms`,
    ...lines,
  ].join('\n')
}

// A case's classifier input, built the way the live hooks build it: an
// AskUserQuestion answer mid-turn (`prev` standing for the turn so far), or
// a prompt.
function caseInput(one: EvalCase): { input: string; why: Route['why'] } {
  const asked = one.asked ? fromAsked(one.asked) : null
  if (asked) {
    const prev = one.prev ? { ...one.prev, answerTail: tail(asked.questions) } : null
    return { input: compose(asked.request, prev, one.recent, asked), why: asked.why }
  }
  const planned = plan(one.request, one.prev)
  const route: Route = planned.kind === 'judge' ? planned : { why: 'auto', selected: [] }
  return { input: compose(one.request, one.prev, one.recent, route), why: route.why }
}
