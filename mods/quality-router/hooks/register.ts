import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register, ToolCallResult, TurnCompleteInput, TurnStepChunk, TurnStepResult } from 'claude-code'

import type { ChildRecord, Effort, Level, TurnSignals } from '../types'
import { MAIN_CASES, SUB_CASES } from './eval-cases'
import { scanAgentCalls } from './gate-lexer'
import type { AgentCall } from './gate-lexer'
import { checkCalls, formatDeny, isSessionScriptPath } from './gate-rules'
import { guidanceText } from './guidance'
import { TOP_IDS, applyBounds, asLevel, boundOf, compareStrength, isLevel, isTop, isTopFamily, minLevel, rank, up } from './levels'
import type { Bound, Bounds } from './levels'
import { LABELS, MID_TURN_BUMP, MIN_CHARS, compose, decide, head, levelOf, shortDecision, tail } from './main-effort'
import type { Decision } from './main-effort'
import { PART_LIMIT, common, gateCounts, recordPath, tokensOf } from './record'
import type { QrRecord, RecordBody, SubWhy } from './record'
import { effortOverride, modelOverride, parseFeedback } from './signals'
import { parseRecords, periodOf, sinceOf, summarize } from './stats'
import { DEFAULTS, SETTING_KEYS, mentionsEffortRouter, parseSettings } from './settings'
import type { Settings } from './settings'
import { skillFloorFor } from './skills'
import {
  SUB_KINDS,
  UNSURE_TIER,
  WEIGHTS,
  assign,
  composeKind,
  composeWeight,
  escalate,
  retryKey,
  shouldRoute,
  strengthOfAssignment,
  subKindOf,
  weightOf,
} from './sub-route'
import type { Assignment, SpawnFacts, SubKind, Weight } from './sub-route'
import { TEXT, describeBuild, describeSettings, formatGateLog, formatMainLog, formatSubLog, statusLine } from './ui'
import type { Build, GateLog, MainLog, MainView, SubLog } from './ui'

// Quality-first routing of model and effort (see README.md).
// A: the main loop's effort, skill floors, the mid-turn bump and the model guard.
// B: the Workflow gate. C: the Workflow guidance. D: Agent-tool subagents.
// E: status, toasts, commands, logs and eval. Decisions live in the pure modules.
//
// The loader follows `$` only into functions declared at the top of this file,
// so every function that takes `$` lives here, not inside `register`. The
// module's own state for one load is the `Ctx` that `register` creates.

const COMMANDS = ['quality-router', 'qr'] as const
const GUIDANCE_ID = 'quality-router:guidance'
const LOG_LIMIT = 200
const RECENT = 3
// How long a request waits for its turn's judgment. The wait is the step
// hook's own time (its budget is 10 s), so it stays well inside it.
const JUDGE_WAIT_MS = 5_000
const OPEN_TURNS = 8

const prevTurn = atom({ plugin: 'quality-router', key: 'prev' } as const, null)
const recentLevels = atom({ plugin: 'quality-router', key: 'recent' } as const, [])
const skillFloorAtom = atom({ plugin: 'quality-router', key: 'skillFloor' } as const, null)
const childrenAtom = atom({ plugin: 'quality-router', key: 'children' } as const, {})
const retriesAtom = atom({ plugin: 'quality-router', key: 'retries' } as const, {})

type Turn = Decision & {
  request: string
  // The judgment in flight, set by turn.start; `decided` once it settled.
  judging: Promise<void> | null
  decided: boolean
  steps: number
  tools: number
  toolErrors: number
  streak: number
  bump: number
  // The highest level this turn reached before the bump, and the bound that
  // set it: the turn never drops below it, and the bump adds to it.
  held: { level: Level; bound: Bound | null } | null
  // The level last written into a request, and the bound that set it.
  applied: Level | null
  bound: Bound | null
  answeredBy: string | null
  guarded: boolean
  // The transcript rows this turn's prompt and last answer were stored as
  // (the transcript rows); null for a turn with no typed prompt.
  promptRow: PromptRow | null
  answerUuid: string | null
  judgeMs: number | null
}

// A main prompt row as stored: its uuid at once, its time once the clock answers.
type PromptRow = { uuid: string; at: number | null }

// The session's record file, written whole on each record (fs.write has no
// append). `resolved` once the path and any lines already there were read.
type Sink = {
  lines: string[]
  size: number
  path: string | null
  home: string | null
  session: string | null
  startedAt: number | null
  part: number
  resolved: boolean
  warned: boolean
  // Set after /clear: no session.start follows, so the first record of the
  // new file is preceded by a session record.
  announce: boolean
  chain: Promise<void>
}

const newSink = (): Sink => ({
  lines: [],
  size: 0,
  path: null,
  home: null,
  session: null,
  startedAt: null,
  part: 1,
  resolved: false,
  warned: false,
  announce: false,
  chain: Promise.resolve(),
})

// What agent.spawn knew of an Agent-tool child, for its record when it ends.
type SubInfo = {
  turn: string | null
  type: string
  descChars: number
  kindJudged: SubKind | null
  weightJudged: Weight | null
  model: string | null
  effort: Effort | null
  why: SubWhy
  retries: number
}

// A child's requests so far: the main turn it started under, steps, tool errors, and what it ran on.
type KidStats = { turn: string | null; steps: number; toolErrors: number; model: string | null; effort: string | null }

// What one load of the module keeps between events.
type Ctx = {
  settings: Settings
  paused: boolean
  // plugin.json's version and the folder it was loaded from, read with the settings.
  build: Build
  // The settings and the effort-router check, read once; every hook awaits it.
  loading: Promise<void> | null
  current: string | undefined
  subCount: number
  mainView: MainView
  turns: Map<string, Turn>
  // Children's assignments, ahead of childrenAtom: a child's first request
  // can come before the agent.spawn hook has written the atom.
  children: Map<string, ChildRecord>
  // Whether the command list was looked at for effort-router (once, at the first turn).
  routerChecked: boolean
  // The turn whose request the top model failed: its later steps skip the guard.
  guardFailed: string | undefined
  // Log writes, one after another (parallel spawns append at once).
  logChain: Promise<void>
  // Records.
  sink: Sink
  // The main prompt row last stored, taken by the next turn.start that has text.
  pendingPrompt: PromptRow | null
  // The last main turn and child that ended, for /qr up and down.
  lastMain: string | null
  lastSub: string | null
  // The model that answered the main loop last, for a manual /model.
  lastModel: string | null
  subs: Map<string, SubInfo>
  kids: Map<string, KidStats>
}

type WorkflowInput = { script?: string; scriptPath?: string; name?: string }
type Source = { text: string; source: GateLog['source']; fromSession: boolean }

async function loadSettings($: EngineInterface): Promise<Settings> {
  const values: Partial<Record<keyof Settings, unknown>> = {}
  for (const key of SETTING_KEYS) {
    try {
      values[key] = await $.store.get(key)
    } catch {
      values[key] = undefined
    }
  }
  return parseSettings(values)
}

async function saveSetting<K extends keyof Settings>($: EngineInterface, key: K, value: Settings[K]): Promise<void> {
  await $.store.set(key, value)
}

// effort-router loaded as a plugin from ~/.claude/settings.json pauses A.
// effort-router loaded from any scope (user, project, local or a plugin
// folder): its own /effort-router command is listed.
async function effortRouterLoaded($: EngineInterface): Promise<boolean> {
  try {
    return (await $.command.list()).some(c => c.plugin === 'effort-router' || c.name === 'effort-router')
  } catch {
    return false
  }
}

// effort-router may register its command after this mod loads: look again
// once, as the first turn is judged, and say so if it is there.
async function checkEffortRouter($: EngineInterface, ctx: Ctx): Promise<void> {
  if (ctx.paused || ctx.routerChecked) return
  ctx.routerChecked = true
  if (!(await effortRouterLoaded($))) return
  ctx.paused = true
  $.ui.toast(TEXT.effortRouterDetected)
  refresh($, ctx)
}

async function effortRouterInstalled($: EngineInterface): Promise<boolean> {
  try {
    return mentionsEffortRouter(await $.settings.read({ source: 'user' }))
  } catch {
    return false
  }
}

async function classify($: EngineInterface, text: string, labels: readonly string[]): Promise<string | undefined | Error> {
  try {
    return await $.model.classify(text, labels, { model: 'haiku' })
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

// A subagent's kind and weight, judged at once. A failed judgment
// reads as unknown.
async function classifySub(
  $: EngineInterface,
  e: Pick<SpawnFacts, 'subagentType' | 'description' | 'prompt'>,
): Promise<{ kind: SubKind | undefined; weight: Weight | undefined }> {
  const [kind, weight] = await Promise.all([classify($, composeKind(e), SUB_KINDS), classify($, composeWeight(e), WEIGHTS)])
  return {
    kind: kind instanceof Error ? undefined : subKindOf(kind),
    weight: weight instanceof Error ? undefined : weightOf(weight),
  }
}

// Never throws: a log that cannot be written must not undo the work it records.
async function appendLog($: EngineInterface, ctx: Ctx, key: string, entry: unknown): Promise<void> {
  const write = ctx.logChain.then(async () => {
    const list = ((await $.store.get(key)) as unknown[] | undefined) ?? []
    await $.store.set(key, [...list, entry].slice(-LOG_LIMIT))
  })
  const done = write.catch(() => undefined)
  ctx.logChain = done
  await done
}

// The file's place, found once: the home folder, the session and its first
// time, the last part already written, and that part's lines (a hot reload
// or a resume keeps writing the same file without losing them).
// A lookup that throws leaves the sink unresolved, so the next record tries again.
async function resolveSink($: EngineInterface, sink: Sink): Promise<void> {
  if (sink.resolved) return
  const home = await homeDir($)
  if (home === null) {
    sink.resolved = true
    return
  }
  const session = await $.session.id()
  const at = await $.clock.now()
  let part = 1
  while (await $.fs.exists(recordPath(home, at, session, part + 1)).catch(() => false)) part += 1
  let path = recordPath(home, at, session, part)
  let kept: string[] = []
  if (await $.fs.exists(path).catch(() => false)) {
    try {
      const text = await $.fs.read(path)
      if (typeof text !== 'string') throw new Error('not text')
      kept = text.split('\n').filter(line => line !== '')
    } catch {
      // There but unreadable (busy, or past 4 MiB): never overwrite it, go on in the next part.
      part += 1
      path = recordPath(home, at, session, part)
    }
  }
  Object.assign(sink, { home, session, startedAt: at, part, path, lines: [...kept, ...sink.lines], resolved: true })
  sink.size = sink.lines.reduce((n, line) => n + line.length + 1, 0)
}

// Appends one record and writes the session's file. Never throws: a record
// that cannot be written must not undo the work it records. The first
// failure is toasted, later ones are not.
async function record($: EngineInterface, ctx: Ctx, turn: string | null, body: RecordBody): Promise<void> {
  const sink = ctx.sink
  const write = sink.chain.then(async () => {
    await resolveSink($, sink)
    if (sink.path === null || sink.home === null || sink.session === null || sink.startedAt === null) return
    const at = await $.clock.now()
    const bodies: RecordBody[] = []
    if (sink.announce && sink.lines.length === 0 && body.kind !== 'session') bodies.push(await sessionBody($, ctx, 'start'))
    bodies.push(body)
    sink.announce = false
    for (const b of bodies) {
      const line = JSON.stringify({ ...common(at, sink.session, b.kind === 'session' ? null : turn, ctx.build.version), ...b } as QrRecord)
      // One read or write is at most 4 MiB: a long session goes on in a new part.
      if (sink.lines.length > 0 && sink.size + line.length + 1 > PART_LIMIT) {
        sink.part += 1
        sink.path = recordPath(sink.home, sink.startedAt, sink.session, sink.part)
        sink.lines = []
        sink.size = 0
      }
      sink.lines.push(line)
      sink.size += line.length + 1
    }
    await $.fs.write(sink.path!, `${sink.lines.join('\n')}\n`)
  })
  const done = write.catch(() => {
    if (sink.warned) return
    sink.warned = true
    $.ui.toast(TEXT.recordFailed)
  })
  sink.chain = done
  await done
}

async function sessionBody($: EngineInterface, ctx: Ctx, event: 'start' | 'settings'): Promise<RecordBody> {
  const cwd = await $.session.cwd().catch(() => null)
  return { kind: 'session', event, root: ctx.build.root, cwd, settings: ctx.settings, paused: ctx.paused }
}

async function recordSession($: EngineInterface, ctx: Ctx, event: 'start' | 'settings'): Promise<void> {
  await record($, ctx, null, await sessionBody($, ctx, event))
}

// A child's run ended: an Agent-tool child (agent.spawn saw it) is a sub
// record, any other (a Workflow agent) a wf child record. Its counts start
// over for its next run.
async function recordChild($: EngineInterface, ctx: Ctx, e: TurnCompleteInput, agentId: string): Promise<void> {
  const stats = ctx.kids.get(agentId)
  ctx.kids.delete(agentId)
  const info = ctx.subs.get(agentId)
  const result = { steps: stats?.steps ?? 0, toolErrors: stats?.toolErrors ?? 0, tokens: tokensOf(e.usage), durationMs: e.durationMs, reason: e.reason }
  if (info) {
    ctx.lastSub = agentId
    const { turn, ...rest } = info
    await record($, ctx, turn, { kind: 'sub', agentId, ...rest, ...result })
  } else {
    await record($, ctx, stats?.turn ?? null, { kind: 'wf', phase: 'child', agentId, model: stats?.model ?? null, effort: stats?.effort ?? null, ...result })
  }
}

// The records since `since`, from every session's file: month folders from
// the one `since` falls in, files changed since then, lines at or after it.
async function readRecords($: EngineInterface, since: number): Promise<QrRecord[]> {
  const home = await homeDir($)
  if (home === null) return []
  const base = `${home}/.claude/quality-router/log`
  // A session's file stays in the month it began: look one month further back.
  const d = new Date(since)
  const fromMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)
  let months: readonly FsEntry[]
  try {
    months = await $.fs.list(base)
  } catch {
    return []
  }
  const out: QrRecord[] = []
  for (const month of months) {
    if (month.kind !== 'dir' || month.name < fromMonth) continue
    let files: readonly FsEntry[]
    try {
      files = await $.fs.list(`${base}/${month.name}`)
    } catch {
      continue
    }
    for (const file of files) {
      if (file.kind !== 'file' || !file.name.endsWith('.jsonl') || file.mtimeMs < since) continue
      try {
        const text = await $.fs.read(`${base}/${month.name}/${file.name}`)
        if (typeof text === 'string') out.push(...parseRecords(text).filter(r => Date.parse(r.at) >= since))
      } catch {
        // A file being written or removed: skip it.
      }
    }
  }
  return out
}

// The user's home with forward slashes, or null when neither variable answers.
async function homeDir($: EngineInterface): Promise<string | null> {
  const home = (await $.env.get('USERPROFILE').catch(() => undefined)) || (await $.env.get('HOME').catch(() => undefined))
  return home ? home.replace(/\\/g, '/') : null
}

// A saved workflow `name` as a file in `dir`, or null when there is none.
async function savedWorkflow($: EngineInterface, dir: string, name: string): Promise<string | null> {
  for (const ext of ['js', 'mjs']) {
    const path = `${dir}/.claude/workflows/${name}.${ext}`
    if (!(await $.fs.exists(path))) continue
    const text = await $.fs.read(path)
    if (typeof text === 'string') return text
  }
  return null
}

// scriptPath takes precedence over script and name, as the Workflow tool reads them.
// A name is looked up in the project, then in the home folder, read only as far as needed.
async function workflowSource($: EngineInterface, e: WorkflowInput): Promise<Source | null> {
  if (e.scriptPath) {
    const text = await $.fs.read(e.scriptPath)
    if (typeof text !== 'string') return null
    return { text, source: 'scriptPath', fromSession: isSessionScriptPath(e.scriptPath, await $.session.id()) }
  }
  if (e.script) return { text: e.script, source: 'script', fromSession: true }
  if (e.name) {
    const cwd = (await $.session.cwd()).replace(/\\/g, '/')
    let text = await savedWorkflow($, cwd, e.name)
    if (text === null) {
      const home = await homeDir($)
      if (home !== null) text = await savedWorkflow($, home, e.name)
    }
    if (text !== null) return { text, source: 'name', fromSession: false }
  }
  return null
}

// The manifest sits in .claude-plugin/ of the plugin's folder; a folder that
// holds plugin.json itself is read too. Null when neither can be read.
async function readVersion($: EngineInterface, root: string): Promise<string | null> {
  for (const path of [`${root}/.claude-plugin/plugin.json`, `${root}/plugin.json`]) {
    try {
      const text = await $.fs.read(path)
      if (typeof text !== 'string') continue
      const version: unknown = JSON.parse(text).version
      if (typeof version === 'string' && version !== '') return version
    } catch {
      // Not there or not JSON: try the next one.
    }
  }
  return null
}

async function loadBuild($: EngineInterface): Promise<Build> {
  let root: string | null = null
  try {
    root = $.plugin.root || null
  } catch {
    root = null
  }
  return { version: root ? await readVersion($, root) : null, root }
}

async function load($: EngineInterface, ctx: Ctx): Promise<void> {
  ctx.build = await loadBuild($)
  ctx.settings = await loadSettings($)
  ctx.paused = (await effortRouterInstalled($)) || (await effortRouterLoaded($))
  if (ctx.paused) $.ui.toast(TEXT.effortRouterDetected)
}

// Every hook reads the settings through here. The first call loads them; the
// calls that come while it loads wait for the same load, not the defaults.
async function cfg($: EngineInterface, ctx: Ctx): Promise<Settings> {
  ctx.loading ??= load($, ctx)
  await ctx.loading
  return ctx.settings
}

function refresh($: EngineInterface, ctx: Ctx): void {
  $.ui.status(statusLine({ settings: ctx.settings, paused: ctx.paused, main: ctx.mainView, sub: ctx.subCount, version: ctx.build.version }))
}

// A main-loop turn, opened by turn.start or, when the engine sends the turn's
// first request before turn.start's hook has run, by that request's step.
// turn.complete closes it; the few kept beyond that bound the ones it never closed.
function openTurn(ctx: Ctx, turnId: string): Turn {
  for (const id of ctx.turns.keys()) {
    if (ctx.turns.size < OPEN_TURNS) break
    ctx.turns.delete(id)
  }
  const turn: Turn = {
    base: null,
    judged: null,
    why: 'late',
    request: '',
    judging: null,
    decided: false,
    steps: 0,
    tools: 0,
    toolErrors: 0,
    streak: 0,
    bump: 0,
    held: null,
    applied: null,
    bound: null,
    answeredBy: null,
    guarded: false,
    promptRow: null,
    answerUuid: null,
    judgeMs: null,
  }
  ctx.turns.set(turnId, turn)
  ctx.current = turnId
  return turn
}

// A: judge the turn's request. A request shorter than
// MIN_CHARS ("", a continuation) inherits; a failed or unmatched judgment
// keeps the previous level. While A is off the turn stays undecided ('late').
async function judgeTurn($: EngineInterface, ctx: Ctx, turn: Turn): Promise<void> {
  try {
    const s = await cfg($, ctx)
    if (s.mode === 'off') return
    await checkEffortRouter($, ctx)
    if (ctx.paused) return
    const prev = await read($, prevTurn)
    let decision: Decision
    if (turn.request.length < MIN_CHARS) {
      decision = shortDecision(prev)
    } else {
      const started = await $.clock.now()
      decision = decide(await classify($, compose(turn.request, prev, await read($, recentLevels)), LABELS), prev)
      turn.judgeMs = (await $.clock.now()) - started
    }
    turn.base = decision.base
    turn.judged = decision.judged
    turn.why = decision.why
  } catch {
    // The steps inherit the previous level, as for a late judgment.
  } finally {
    turn.decided = true
  }
}

// Waits for `promise` at most `ms`, or until `signal` aborts; never throws.
async function within($: EngineInterface, promise: Promise<void>, ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  const stop = new AbortController()
  const quit = () => stop.abort()
  signal.addEventListener('abort', quit)
  // Aborted (the wait ended first, or the dispatch did): go on.
  const timer = $.clock.sleep(ms, { signal: stop.signal }).catch(() => undefined)
  try {
    await Promise.race([promise, timer])
  } finally {
    signal.removeEventListener('abort', quit)
    stop.abort()
  }
}

// A level written into a main request this turn: the log, the status and /qr read it.
function markApplied(ctx: Ctx, turn: Turn, level: Level, skill: string | null, bound: Bound | null): void {
  turn.applied = level
  turn.bound = bound
  ctx.mainView = { ...ctx.mainView, level, judged: turn.judged, skill, bump: turn.bump > 0 }
}

// A: the main loop's calls and failures for the mid-turn bump.
// A deny is neither an error nor a success: the tool never ran.
function countTool(turn: Turn, ran: ToolCallResult): void {
  turn.tools += 1
  if (ran.deny !== undefined) return
  if (ran.isError === true) {
    turn.toolErrors += 1
    turn.streak += 1
    if (MID_TURN_BUMP && turn.streak >= 2 && turn.bump === 0) turn.bump = 1
  } else {
    turn.streak = 0
  }
}

// The response's own content: once one of these has gone up the chain, it is
// shown and recorded, so the request can no longer be sent again unseen.
function isContent(c: TurnStepChunk): boolean {
  return c.kind === 'text' || c.kind === 'thinking' || c.kind === 'tool' || c.kind === 'input'
}

// B: the deny text for a session script that breaks a rule, or null to let
// the call run (a script that cannot be read runs).
async function gate($: EngineInterface, ctx: Ctx, input: WorkflowInput): Promise<string | null> {
  const s = await cfg($, ctx)
  if (s.gate === 'off') return null
  const at = await $.clock.now()
  const fallbackSource: GateLog['source'] = input.scriptPath ? 'scriptPath' : input.script ? 'script' : 'name'
  let src: Source | null = null
  let calls = 0
  let found: AgentCall[] = []
  let violations: ReturnType<typeof checkCalls> | null = null
  try {
    src = await workflowSource($, input)
    if (src) {
      found = scanAgentCalls(src.text)
      calls = found.length
      violations = checkCalls(found)
    }
  } catch {
    violations = null
  }
  if (src === null || violations === null) {
    // A name not found under .claude/workflows is a built-in one
    // (review-changes): logged, not toasted.
    const unresolvedName = input.scriptPath === undefined && input.script === undefined && input.name !== undefined
    if (!unresolvedName || (violations === null && src !== null)) $.ui.toast(TEXT.gateFailed)
    await appendLog($, ctx, 'log.gate', { at, source: src?.source ?? fallbackSource, verdict: 'unchecked', count: 0, calls } satisfies GateLog)
    await record($, ctx, ctx.current ?? null, { kind: 'wf', phase: 'gate', verdict: 'unchecked', source: src?.source ?? fallbackSource, calls, kinds: {}, rules: {}, fixes: 0 })
    return null
  }
  const verdict: GateLog['verdict'] = violations.length === 0 ? 'pass' : src.fromSession ? 'deny' : 'warn'
  await appendLog($, ctx, 'log.gate', { at, source: src.source, verdict, count: violations.length, calls } satisfies GateLog)
  await record($, ctx, ctx.current ?? null, { kind: 'wf', phase: 'gate', verdict, source: src.source, calls, ...gateCounts(found, violations) })
  if (verdict === 'pass') return null
  if (verdict === 'warn') {
    $.ui.toast(TEXT.warned(violations.length))
    return null
  }
  $.ui.toast(TEXT.denied(violations.length))
  return formatDeny(violations)
}

async function set<K extends keyof Settings>($: EngineInterface, ctx: Ctx, key: K, value: Settings[K]): Promise<void> {
  ctx.settings = { ...ctx.settings, [key]: value }
  await saveSetting($, key, value)
}

// /clear and an in-process /resume end the conversation but not the process,
// and no session.start follows: what this session kept would leak into the
// next one.
async function resetSession($: EngineInterface, ctx: Ctx): Promise<void> {
  // A /clear starts a new session id: its records go to a new file.
  ctx.sink = { ...newSink(), announce: true }
  ctx.pendingPrompt = null
  ctx.lastMain = null
  ctx.lastSub = null
  ctx.lastModel = null
  ctx.subs.clear()
  ctx.kids.clear()
  ctx.turns.clear()
  ctx.children.clear()
  ctx.current = undefined
  ctx.guardFailed = undefined
  ctx.mainView = {}
  ctx.subCount = 0
  try {
    await update($, prevTurn, () => null)
    await update($, recentLevels, () => [])
    await update($, skillFloorAtom, () => null)
    await update($, childrenAtom, () => ({}))
    await update($, retriesAtom, () => ({}))
  } catch {
    // The host may already have dropped the session's state.
  }
  refresh($, ctx)
}

async function formatLogs($: EngineInterface, which: string): Promise<string> {
  const parts: string[] = []
  if (which === '' || which === 'main') parts.push(formatMainLog(((await $.store.get('log.main')) as MainLog[] | undefined) ?? []))
  if (which === '' || which === 'sub') parts.push(formatSubLog(((await $.store.get('log.sub')) as SubLog[] | undefined) ?? []))
  if (which === '' || which === 'gate') parts.push(formatGateLog(((await $.store.get('log.gate')) as GateLog[] | undefined) ?? []))
  return parts.length > 0 ? parts.join('\n\n') : TEXT.unknown(`log ${which}`)
}

async function evalMain($: EngineInterface): Promise<string> {
  let hits = 0
  let low = 0
  const lines: string[] = []
  for (const one of MAIN_CASES) {
    const answer = await classify($, compose(one.request, one.prev, one.recent), LABELS)
    const judged = answer instanceof Error ? undefined : levelOf(answer)
    const isLow = judged !== undefined && rank(judged) < rank(one.expect)
    if (judged === one.expect) hits += 1
    if (isLow) low += 1
    const mark = judged === one.expect ? 'ok ' : isLow ? 'LOW' : 'off'
    lines.push(`  ${mark} ${one.name}: expect ${one.expect}, judged ${judged ?? '-'}`)
  }
  const passed = low === 0 && MAIN_CASES.length > 0 && hits / MAIN_CASES.length >= 0.8
  return [
    `eval main: ${hits}/${MAIN_CASES.length} match, ${low} judged too low`,
    passed ? '判定: 合格' : '判定: 不合格（低すぎる判定が0件、かつ一致が80%以上が条件）',
    ...lines,
  ].join('\n')
}

async function evalSub($: EngineInterface): Promise<string> {
  let hits = 0
  let low = 0
  const lines: string[] = []
  for (const one of SUB_CASES) {
    const { kind, weight } = await classifySub($, { subagentType: one.type, description: one.description, prompt: one.prompt })
    const judged = assign(kind, weight, null, 'opus')
    const expected = assign(one.expect, one.weight, null, 'opus')
    const isLow = judged !== null && expected !== null && compareStrength(strengthOfAssignment(judged), strengthOfAssignment(expected)) < 0
    const hit = kind === one.expect
    if (hit) hits += 1
    if (isLow) low += 1
    const mark = isLow ? 'LOW' : hit ? 'ok ' : 'off'
    lines.push(`  ${mark} ${one.name}: expect ${one.expect}/${one.weight}, judged ${kind ?? '-'}/${weight ?? '-'}`)
  }
  const passed = low === 0 && SUB_CASES.length > 0 && hits / SUB_CASES.length >= 0.8
  return [
    `eval sub: ${hits}/${SUB_CASES.length} match, ${low} judged too low`,
    passed ? '判定: 合格' : '判定: 不合格（割り当てが正解より弱くなる判定が0件、かつ種類の一致が80%以上が条件）',
    ...lines,
  ].join('\n')
}

async function runCommand($: EngineInterface, ctx: Ctx, raw: string): Promise<string> {
  await cfg($, ctx)
  const trimmed = raw.trim()
  const [verb = '', arg = ''] = trimmed.toLowerCase().split(/\s+/)
  switch (verb) {
    case '':
      break
    case 'on':
    case 'off':
      await set($, ctx, 'mode', verb)
      break
    case 'gate':
    case 'guard':
      if (arg !== 'on' && arg !== 'off') return TEXT.unknown(trimmed)
      await set($, ctx, verb, arg)
      break
    case 'floor':
    case 'ceiling':
      if (!isLevel(arg)) return TEXT.unknown(trimmed)
      await set($, ctx, verb, arg)
      break
    case 'top':
      if (!isTop(arg)) return TEXT.unknown(trimmed)
      await set($, ctx, 'top', arg)
      break
    case 'skill':
      if (arg !== 'clear') return TEXT.unknown(trimmed)
      await update($, skillFloorAtom, () => null)
      ctx.mainView = { ...ctx.mainView, skill: null }
      break
    case 'up':
    case 'down':
    case '↑':
    case '↓': {
      const fb = parseFeedback(verb, arg)
      if (fb === null) return TEXT.unknown(trimmed)
      const targetTurn = fb.target === 'main' ? ctx.lastMain : null
      const targetAgent = fb.target === 'sub' ? ctx.lastSub : null
      if (targetTurn === null && targetAgent === null) return TEXT.feedbackNoTarget(fb.target)
      await record($, ctx, ctx.current ?? null, { kind: 'signal', type: 'feedback', dir: fb.dir, target: fb.target, targetTurn, targetAgent })
      return TEXT.feedbackSaved(fb.dir, fb.target)
    }
    case 'stats': {
      const period = periodOf(arg)
      if (period === null) return TEXT.unknown(trimmed)
      return summarize(await readRecords($, sinceOf(period, await $.clock.now())), period)
    }
    case 'log':
      return formatLogs($, arg)
    case 'version':
      return describeBuild(ctx.build)
    case 'eval': {
      const parts: string[] = []
      if (arg === '' || arg === 'main') parts.push(await evalMain($))
      if (arg === '' || arg === 'sub') parts.push(await evalSub($))
      return parts.length > 0 ? parts.join('\n\n') : TEXT.unknown(trimmed)
    }
    default:
      return TEXT.unknown(trimmed)
  }
  if (['on', 'off', 'gate', 'guard', 'floor', 'ceiling', 'top'].includes(verb)) await recordSession($, ctx, 'settings')
  refresh($, ctx)
  const floor = await read($, skillFloorAtom)
  return describeSettings(ctx.settings, ctx.paused, floor?.skill ?? null, ctx.mainView, ctx.build)
}

export const register: Register = on => {
  const ctx: Ctx = {
    settings: DEFAULTS,
    paused: false,
    build: { version: null, root: null },
    loading: null,
    current: undefined,
    subCount: 0,
    mainView: {},
    turns: new Map<string, Turn>(),
    children: new Map<string, ChildRecord>(),
    guardFailed: undefined,
    routerChecked: false,
    logChain: Promise.resolve(),
    sink: newSink(),
    pendingPrompt: null,
    lastMain: null,
    lastSub: null,
    lastModel: null,
    subs: new Map<string, SubInfo>(),
    kids: new Map<string, KidStats>(),
  }

  on('session.start', async ($, e, next) => {
    await cfg($, ctx)
    // One name failing to register leaves the other and the status line.
    for (const name of COMMANDS) {
      try {
        await $.command.register({
          name,
          description: 'Quality-first model and effort routing: on|off, gate, guard, floor, ceiling, top, skill, up|down, stats, log, eval, version',
          argumentHint: '[on|off|gate|guard|floor|ceiling|top|skill|up|down|stats|log|eval|version]',
          immediate: true,
        })
      } catch {
        $.ui.toast(TEXT.commandFailed(name))
      }
    }
    await recordSession($, ctx, 'start')
    refresh($, ctx)
    return next(e)
  })

  // The other reasons end the process: nothing is left to leak into.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') await resetSession($, ctx)
    return next(e)
  })

  // Literal matchers, one per name in COMMANDS, so the host can read them statically.
  on('command.run', { command: 'quality-router' }, async ($, e) => ({ text: await runCommand($, ctx, e.args) }))
  on('command.run', { command: 'qr' }, async ($, e) => ({ text: await runCommand($, ctx, e.args) }))

  // Records: a manual /effort or /model, read against what A sent and what answered.
  // While A is off or paused, a manual choice is the person's way to pin a
  // level, not a verdict on a judgment: it is not recorded.
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const s = await cfg($, ctx)
    if (s.mode === 'on' && !ctx.paused) await record($, ctx, ctx.current ?? null, { kind: 'signal', ...effortOverride(e.args, ctx.mainView.level ?? null) })
    return next(e)
  })
  on('command.run', { command: 'model' }, async ($, e, next) => {
    const s = await cfg($, ctx)
    if (s.mode === 'on' && !ctx.paused) await record($, ctx, ctx.current ?? null, { kind: 'signal', ...modelOverride(e.args, ctx.lastModel) })
    return next(e)
  })

  // A: judge once when the request arrives. The engine sends the turn's first
  // request after waiting at most 3 s for this hook (and while the previous
  // turn's events are still queued, before it runs), so the turn is opened
  // before any await, and turn.step waits for the judgment, bounded.
  on('turn.start', async ($, e, next) => {
    const turn = ctx.turns.get(e.turnId) ?? openTurn(ctx, e.turnId)
    ctx.current = e.turnId
    turn.request = e.text
    // The prompt row comes just before; a turn with no typed text (a
    // continuation) takes none, and a row left over is dropped either way.
    if (e.text !== '' && ctx.pendingPrompt !== null) turn.promptRow = ctx.pendingPrompt
    ctx.pendingPrompt = null
    turn.judging = judgeTurn($, ctx, turn)
    await turn.judging
    return next(e)
  })

  // Records: the transcript row ids that lead back to the prompt and the answer.
  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    if (e.agentId === undefined) {
      // Taken before any await: turn.start can run while this hook waits on the clock.
      const row: PromptRow = { uuid: e.uuid, at: null }
      ctx.pendingPrompt = row
      row.at = await $.clock.now()
    }
    return next(e)
  })
  on('session.append', { door: 'response' }, async ($, e, next) => {
    const turn = e.agentId === undefined && ctx.current !== undefined ? ctx.turns.get(ctx.current) : undefined
    if (turn) turn.answerUuid = e.uuid
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const s = await cfg($, ctx)

    // D: a subagent the Agent tool started runs at its assigned effort.
    if (e.agentId !== undefined) {
      const kid = s.mode === 'on' ? (ctx.children.get(e.agentId) ?? (await read($, childrenAtom))[e.agentId]) : undefined
      const sent = kid?.effort !== undefined && e.effort !== undefined ? { ...e, effort: kid.effort } : e
      // Records: the child's first request names the main turn it started under.
      const stats = ctx.kids.get(e.agentId) ?? { turn: ctx.current ?? null, steps: 0, toolErrors: 0, model: null, effort: null }
      stats.steps += 1
      stats.model = sent.model
      stats.effort = typeof sent.effort === 'string' ? sent.effort : null
      ctx.kids.set(e.agentId, stats)
      return yield* next(sent)
    }

    // A: the main loop's effort for this request.
    const active = s.mode === 'on' && !ctx.paused
    const turn = ctx.turns.get(e.turnId) ?? (active ? openTurn(ctx, e.turnId) : undefined)
    let sent = e
    let level: Level | null = null
    let skill: string | null = null
    let bound: Bound | null = null
    if (turn && active) {
      if (!turn.decided && turn.judging) await within($, turn.judging, JUDGE_WAIT_MS, next.signal)
      turn.steps += 1
      // No judgment in time: inherit the previous level, as a short prompt does.
      // The judgment, when it comes, takes over from the next request; the
      // never-lower rule below keeps the turn from dropping meanwhile.
      const decision = turn.why === 'late' ? shortDecision(await read($, prevTurn)) : turn
      const base = decision.base ?? asLevel(e.effort)
      if (base !== null) {
        const floor = await read($, skillFloorAtom)
        skill = floor?.skill ?? null
        const bounds: Bounds = { floor: s.floor, ceiling: s.ceiling, skillFloor: floor?.level ?? null }
        level = applyBounds(base, bounds)
        bound = boundOf(base, bounds)
        // Never lower within a turn: a lower skill floor, `/qr
        // skill clear` or a late lower judgment takes effect at the next turn.
        // The ceiling still bounds it.
        const held = turn.held
        if (held !== null && rank(held.level) > rank(level)) {
          const kept = minLevel(held.level, s.ceiling)
          if (rank(kept) > rank(level)) {
            level = kept
            bound = kept === held.level ? held.bound : 'ceiling'
          }
        }
        if (held === null || rank(level) > rank(held.level)) turn.held = { level, bound }
        if (turn.bump > 0) level = minLevel(up(level, turn.bump), s.ceiling)
        if (e.effort !== undefined) {
          sent = { ...sent, effort: level }
          markApplied(ctx, turn, level, skill, bound)
        }
      }
    }

    // A: the main model guard, part of A, so `/qr off` stops it too.
    // effort-router only sets effort, so its pause leaves the guard on.
    if (s.mode === 'on' && s.guard === 'on' && !isTopFamily(e.model)) {
      if (ctx.guardFailed !== e.turnId) {
        const target = TOP_IDS[s.top]
        // A model without effort sends none; the top model takes this turn's level.
        const added = sent.effort === undefined ? level : null
        const attempt = next(added !== null ? { ...sent, model: target, effort: added } : { ...sent, model: target })
        // The engine's items ahead of the first content are held back: a failed
        // attempt's (its API error item among them) are dropped for the resend.
        const held: TurnStepChunk[] = []
        let shown = false
        let r: TurnStepResult | undefined
        let failure: { error: unknown } | undefined
        try {
          for await (const c of attempt) {
            if (!shown && !isContent(c)) {
              held.push(c)
              continue
            }
            if (!shown) {
              shown = true
              yield* held.splice(0)
            }
            yield c
          }
          r = await attempt.result
        } catch (error) {
          failure = { error }
        }
        const answered = r !== undefined && (r.stopReason !== null || r.usage !== null)
        const by = r?.usage?.model
        if (r !== undefined && answered && (by === undefined || isTopFamily(by))) {
          yield* held
          if (turn) {
            turn.guarded = true
            turn.answeredBy = by ?? target
            if (added !== null) markApplied(ctx, turn, added, skill, bound)
          }
          ctx.mainView = { ...ctx.mainView, offModel: null }
          refresh($, ctx)
          return r
        }
        if (r !== undefined && answered && by !== undefined) {
          // The engine kept another model (a policy that does not allow the
          // rewrite): its answer stands, and the rest of the turn stops trying.
          yield* held
          ctx.guardFailed = e.turnId
          $.ui.toast(TEXT.guardFallback(by))
          if (turn) turn.answeredBy = by
          ctx.mainView = { ...ctx.mainView, offModel: by }
          refresh($, ctx)
          return r
        }
        // No response because the person interrupted (Esc): the top model did
        // not fail, so no toast, no off-model mark and no resend. The test
        // kit cannot abort a dispatch, so this branch has no test.
        if (next.signal.aborted) {
          if (failure) throw failure.error
          yield* held
          return r!
        }
        // Told once a turn: its later steps go straight to the original model.
        ctx.guardFailed = e.turnId
        $.ui.toast(TEXT.guardFallback(e.model))
        ctx.mainView = { ...ctx.mainView, offModel: e.model }
        if (shown) {
          // Part of the failed answer is already shown and recorded: a resend
          // would follow it. The engine's own error handling takes the step,
          // and the turn's next request goes out on the original model.
          refresh($, ctx)
          if (failure) throw failure.error
          return r!
        }
        // Nothing shown: resend on the original model.
      }
      ctx.mainView = { ...ctx.mainView, offModel: e.model }
      const r = yield* next(sent)
      if (turn) turn.answeredBy = r.usage?.model ?? e.model
      refresh($, ctx)
      return r
    }

    const r = yield* next(sent)
    if (turn) turn.answeredBy = r.usage?.model ?? e.model
    ctx.mainView = { ...ctx.mainView, offModel: null }
    refresh($, ctx)
    return r
  })

  on('tool.call', async ($, e, next) => {
    // The main loop's turn, read before the call: a long tool can outlast it.
    const turn = e.agentId === undefined && ctx.current !== undefined ? ctx.turns.get(ctx.current) : undefined

    // B: the Workflow gate.
    const deny = e.tool === 'Workflow' ? await gate($, ctx, { script: e.script, scriptPath: e.scriptPath, name: e.name }) : null
    const ran: ToolCallResult = deny !== null ? { deny } : await next(e)

    // A: every main-loop call counts toward the mid-turn bump, Workflow included.
    if (turn) countTool(turn, ran)

    // Records: a child's failed calls.
    if (e.agentId !== undefined && ran.isError === true) {
      const stats = ctx.kids.get(e.agentId)
      if (stats) stats.toolErrors += 1
    }

    // A: a skill the main loop called sets the skill floor from its next
    // request; a denied or failed call sets nothing.
    if (e.tool === 'Skill' && e.agentId === undefined && ran.deny === undefined && ran.isError !== true) {
      const level = skillFloorFor(e.skill)
      if (level) {
        const skill = e.skill.trim().replace(/^\//, '')
        await update($, skillFloorAtom, () => ({ level, skill }))
        ctx.mainView = { ...ctx.mainView, skill }
      }
    }
    return ran
  })

  // C: teach the staffing rules while the gate is on, to a model that is
  // offered the Workflow tool (not a subagent's or a Workflow agent's render
  // without it). `--bare` asked for a one-line prompt, so it gets none.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const s = await cfg($, ctx)
    if (s.gate === 'off' || e.traits.includes('bare') || !e.tools.includes('Workflow')) return result
    return { ...result, sections: [...result.sections, { id: GUIDANCE_ID, text: guidanceText(s.top), scope: 'session' as const }] }
  })

  // D: route a subagent the Agent tool starts.
  on('agent.spawn', async ($, e, next) => {
    const s = await cfg($, ctx)
    if (s.mode === 'off' || !shouldRoute(e)) {
      const result = await next(e)
      if (result.deny === undefined && result.agentId !== undefined) {
        ctx.subs.set(result.agentId, {
          turn: ctx.current ?? null,
          type: e.subagentType,
          descChars: e.description.length,
          kindJudged: null,
          weightJudged: null,
          model: result.model ?? null,
          effort: null,
          why: s.mode === 'off' ? 'off' : 'explicit',
          retries: 0,
        })
      }
      return result
    }
    const key = retryKey(e.description)
    const prior = (await read($, retriesAtom))[key]
    let a: Assignment | null
    let why: SubLog['why']
    let role: string
    let kindJudged: SubKind | null = null
    let weightJudged: Weight | null = null
    if (prior) {
      a = escalate(prior.tier, s.top)
      why = 'retry'
      role = 'retry'
    } else {
      const { kind, weight } = await classifySub($, e)
      kindJudged = kind ?? null
      weightJudged = weight ?? null
      a = assign(kind, weight, ctx.mainView.level ?? null, s.top)
      why = a ? 'auto' : 'unsure'
      role = kind !== undefined ? `${kind}/${weight ?? 'heavy'}` : 'unsure'
    }
    const result = await next(a?.model !== undefined ? { ...e, model: a.model } : e)
    const agentId = result.deny === undefined ? result.agentId : undefined
    if (agentId !== undefined && a?.effort !== undefined) {
      const child: ChildRecord = { tier: a.tier, effort: a.effort }
      // In memory before any await: the child's first request can come before
      // this hook ends. The atom keeps it across a hot reload.
      ctx.children.set(agentId, child)
      try {
        await update($, childrenAtom, map => ({ ...map, [agentId]: child }))
      } catch {
        // The in-memory record serves this load.
      }
    }
    // A denied spawn started nothing: no retry to count, no child routed.
    if (result.deny === undefined) {
      const count = (prior?.count ?? 0) + 1
      const tier = a?.tier ?? UNSURE_TIER
      try {
        await update($, retriesAtom, map => ({ ...map, [key]: { count, tier } }))
      } catch {
        // A lost retry record only means the next start is judged afresh.
      }
      if (count === 3) {
        $.ui.toast(TEXT.retryThird(e.description))
        await record($, ctx, ctx.current ?? null, { kind: 'signal', type: 'retry3', agentId: agentId ?? null })
      }
      ctx.subCount += 1
      if (agentId !== undefined) {
        ctx.subs.set(agentId, {
          turn: ctx.current ?? null,
          type: e.subagentType,
          descChars: e.description.length,
          kindJudged,
          weightJudged,
          model: result.model ?? null,
          effort: a?.effort ?? null,
          why,
          retries: prior?.count ?? 0,
        })
      }
    }
    await appendLog($, ctx, 'log.sub', {
      at: await $.clock.now(),
      description: head(e.description, 40),
      type: e.subagentType,
      role,
      why,
      model: result.deny === undefined ? result.model : null,
      effort: a?.effort ?? null,
      agentId: agentId ?? null,
    } satisfies SubLog)
    refresh($, ctx)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      await recordChild($, ctx, e, e.agentId)
      return next(e)
    }
    const turn = e.agentId === undefined ? ctx.turns.get(e.turnId) : undefined
    if (turn) {
      ctx.turns.delete(e.turnId)
      if (ctx.current === e.turnId) ctx.current = undefined
    }
    // A turn A never stepped (off, paused, or aborted before a request) leaves no record.
    if (turn && turn.steps > 0) {
      const prev = await read($, prevTurn)
      const floor = await read($, skillFloorAtom)
      const signals: TurnSignals = {
        level: turn.applied,
        judged: turn.judged,
        steps: turn.steps,
        tools: turn.tools,
        toolErrors: turn.toolErrors,
        durationMs: e.durationMs,
        // A continuation ("") keeps the request it continues for the next judgment.
        request: turn.request !== '' ? head(turn.request) : (prev?.request ?? ''),
        answerTail: tail(e.answer),
      }
      await update($, prevTurn, () => signals)
      await update($, recentLevels, list => [...list, turn.applied].slice(-RECENT))
      await appendLog($, ctx, 'log.main', {
        at: await $.clock.now(),
        head: head(turn.request, 40),
        prev: prev?.level ?? null,
        judged: turn.judged,
        level: turn.applied,
        why: turn.why,
        bound: turn.bound,
        skill: floor?.skill ?? null,
        bump: turn.bump > 0,
        model: turn.answeredBy,
        guarded: turn.guarded,
        durationMs: e.durationMs,
      } satisfies MainLog)
      ctx.lastMain = e.turnId
      ctx.lastModel = turn.answeredBy
      await record($, ctx, e.turnId, {
        kind: 'main',
        promptUuid: turn.promptRow?.uuid ?? null,
        answerUuid: turn.answerUuid,
        promptAt: turn.promptRow?.at != null ? new Date(turn.promptRow.at).toISOString() : null,
        promptChars: turn.request.length,
        prev: prev?.level ?? null,
        judged: turn.judged,
        level: turn.applied,
        why: turn.why,
        bound: turn.bound,
        skill: floor?.skill ?? null,
        guarded: turn.guarded,
        judgeMs: turn.judgeMs,
        steps: turn.steps,
        tools: turn.tools,
        toolErrors: turn.toolErrors,
        bump: turn.bump > 0,
        durationMs: e.durationMs,
        tokens: tokensOf(e.usage),
        answeredBy: turn.answeredBy,
        reason: e.reason,
      })
    }
    return next(e)
  })
}
