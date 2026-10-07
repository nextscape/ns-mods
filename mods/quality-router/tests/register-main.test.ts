import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnStepChunk } from 'claude-code'

type Sent = { effort?: string | number; model: string; agentId?: string }

type Opts = {
  // What $.command.list() answers (a plugin's commands show which plugins are loaded).
  commands?: Array<{ name: string; description: string; source: string; plugin?: string }>
  // A request on this model throws, after its chunks.
  failModel?: string
  // A request on this model gets no response (stopReason and usage null), after its chunks.
  emptyModel?: string
  // What each model streams before it answers.
  chunks?: Record<string, TurnStepChunk[]>
  // The model every response reports in its usage (the engine kept it).
  answeredBy?: string
  // How long each classify call takes, in turn, on the mocked clock (0: at once).
  delays?: number[]
  // What ~/.claude/settings.json holds.
  settings?: unknown
  // What $.store holds at the start.
  store?: Record<string, unknown>
  // Answers $.store from this object instead, so the test reads what was written.
  kept?: Record<string, unknown>
  // What a subagent's kind and weight are judged, in turn (D asks both at once).
  kinds?: Array<string | undefined | Error>
  weights?: Array<string | undefined | Error>
}

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// The engine beneath the plugin. classify answers the main level from
// `answers` in turn (an Error throws), each after its delay; it answers a
// subagent's kind (labels with `chore`) and weight (labels with `heavy`) from
// `opts.kinds` and `opts.weights`, since D asks both at once. A model request records what it was
// sent with and answers as `opts` says. A Bash call of `false`, a Workflow
// named `fails` and a Skill called with args `fail` end in an error, a Skill
// called with args `deny` is denied, and every other tool call succeeds. A
// test registers every hook before its first `$` call, so what changes
// between calls is set here.
function world(on: On, answers: Array<string | undefined | Error>, opts: Opts = {}) {
  const kept = opts.kept
  if (kept) {
    on('store.get', async ($, e) => ({ value: kept[e.key] }))
    on('store.set', async ($, e) => {
      kept[e.key] = e.value
      return { value: undefined }
    })
  } else mock.store(on, opts.store)
  const clock = mock.clock(on)
  on('fs.write', async () => ({ value: undefined }))
  const delays = [...(opts.delays ?? [])]
  const kinds = [...(opts.kinds ?? [])]
  const weights = [...(opts.weights ?? [])]
  const seen = {
    clock,
    sent: [] as Sent[],
    inputs: [] as string[],
    status: [] as Array<string | undefined>,
    toasts: [] as string[],
    spawned: [] as Array<string | undefined>,
  }
  on('model.classify', async ($, e) => {
    seen.inputs.push(e.text)
    const ms = delays.shift() ?? 0
    if (ms > 0) await clock.sleep(ms)
    const answer = e.labels.includes('heavy') ? weights.shift() : e.labels.includes('chore') ? kinds.shift() : answers.shift()
    if (answer instanceof Error) throw answer
    return { value: answer }
  })
  if (opts.settings !== undefined) on('settings.read', async () => ({ value: opts.settings as never }))
  if (opts.commands !== undefined) on('command.list', async () => ({ value: opts.commands as never }))
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    seen.sent.push({ effort: e.effort, model: e.model, agentId: e.agentId })
    for (const c of opts.chunks?.[e.model] ?? []) yield c
    if (opts.failModel !== undefined && e.model === opts.failModel) throw new Error('model unavailable')
    if (opts.emptyModel !== undefined && e.model === opts.emptyModel) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
    }
    const usage = opts.answeredBy !== undefined ? { ...USAGE, model: opts.answeredBy } : null
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('session.end', async ($, e) => ({ sessionId: e.sessionId }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('tool.call', async ($, e) => {
    if (e.tool === 'Skill' && e.args === 'deny') return { deny: 'refused' }
    const fails =
      (e.tool === 'Bash' && e.command === 'false') ||
      (e.tool === 'Workflow' && e.name === 'fails') ||
      (e.tool === 'Skill' && e.args === 'fail')
    return (fails ? { result: {}, isError: true, text: 'exit 1' } : { result: {} }) as never
  })
  on('agent.spawn', async ($, e) => {
    seen.spawned.push(e.model)
    return { model: e.model ?? e.parentModel, agentId: `agent-${seen.spawned.length}` }
  })
  on('ui.status', async ($, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', async ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return seen
}

let ids = 0
async function step($: Engine, turnId: string, index: number, model = 'claude-opus-5-5', effort: 'xhigh' | undefined = 'xhigh') {
  const chunks: TurnStepChunk[] = []
  const stream = $.turn.step({ turnId, index, model, effort, messageCount: 1 })
  for await (const c of stream) chunks.push(c)
  await stream.result
  return chunks
}
async function turn($: Engine, text: string, opts: { model?: string; answer?: string } = {}) {
  const turnId = `t${++ids}`
  await $.turn.start({ text, turnId })
  await step($, turnId, 0, opts.model)
  await complete($, turnId, opts.answer)
  return turnId
}
const complete = ($: Engine, turnId: string, answer = '') =>
  $.turn.complete({ turnId, answer, durationMs: 1000, isAborted: false, reason: 'answer' })
const run = ($: Engine, args: string, command = 'qr') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
const bash = ($: Engine, ok: boolean) => $.tool.call({ tool: 'Bash', command: ok ? 'true' : 'false' })
const spawnArgs = (description: string) =>
  ({
    tool_use_id: `tu-${++ids}`,
    prompt: 'hooks フォルダのファイル一覧を作って',
    description,
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  }) as never

const LONG = 'この関数の命名だけ確認したいのですが問題ないでしょうか'
const BAD = "export const meta = { name: 'b', description: 'whose agent() is below its floor' }\nreturn await agent('p', { label: 'review:diff', effort: 'medium' })"
// The guard is off by default; the tests that exercise it turn it on.
const GUARD_ON = { guard: 'on' }
const EFFORT_ROUTER = { env: { CLAUDE_CODE_PLUGIN_DIRS: 'C:/mods/effort-router' } }

describe('A: main-loop effort', () => {
  test('a judged level is applied, floor medium by default', async ($, on) => {
    const { sent } = world(on, ['medium', 'max'])
    await turn($, LONG)
    await turn($, LONG)
    expect(sent.map(s => s.effort)).toEqual(['medium', 'max'])
  })

  test('down is one level a turn, up is immediate', async ($, on) => {
    const { sent } = world(on, ['xhigh', 'medium', 'medium', 'max'])
    for (let i = 0; i < 4; i += 1) await turn($, LONG)
    expect(sent.map(s => s.effort)).toEqual(['xhigh', 'high', 'medium', 'max'])
  })

  test('short prompts inherit; a short first prompt keeps the session effort', async ($, on) => {
    const seen = world(on, ['high'])
    await turn($, '続けて')
    await turn($, LONG)
    await turn($, '続けて')
    expect(seen.inputs.length).toBe(1)
    expect(seen.sent.map(s => s.effort)).toEqual(['xhigh', 'high', 'high'])
  })

  test('a request of 19 characters inherits; one of 20 is judged', async ($, on) => {
    const seen = world(on, ['high', 'max'])
    await turn($, LONG)
    await turn($, 'あ'.repeat(19))
    await turn($, 'あ'.repeat(20))
    expect(seen.inputs.length).toBe(2)
    expect(seen.sent.map(s => s.effort)).toEqual(['high', 'high', 'max'])
  })

  test('a failed or unmatched judgment keeps the previous level, not the session effort', async ($, on) => {
    const seen = world(on, ['high', new Error('x'), 'nonsense'])
    for (let i = 0; i < 3; i += 1) await turn($, LONG)
    expect(seen.inputs.length).toBe(3)
    expect(seen.sent.map(s => s.effort)).toEqual(['high', 'high', 'high'])
    const { text } = await run($, 'log main')
    expect(text).toContain('high -> high\terror\t')
    expect(text).toContain('high -> high\tunsure\t')
  })

  test('the judgment reads the previous turn and the highest of the last three levels', async ($, on) => {
    const seen = world(on, ['xhigh', 'medium', 'high'])
    await turn($, LONG)
    await turn($, LONG, { answer: '前の回答の末尾です' })
    await turn($, LONG)
    expect(seen.inputs.at(-1)).toContain('[prev] effort=high steps=1 tools=0 tool_errors=0 dur=1s max3=xhigh')
    expect(seen.inputs.at(-1)).toContain('[prev_answer_tail] 前の回答の末尾です')
  })

  test('a brainstorming skill keeps short replies at xhigh until cleared', async ($, on) => {
    const seen = world(on, ['medium', 'medium'])
    await turn($, LONG)
    await $.tool.call({ tool: 'Skill', skill: '/superpowers:brainstorming' })
    await turn($, '(a)ですね')
    expect(seen.sent.map(s => s.effort)).toEqual(['medium', 'xhigh'])
    expect(seen.status.at(-1)).toContain('skill: brainstorming')
    await run($, 'skill clear')
    // Without the skill floor, a medium judgment after xhigh drops one level.
    await turn($, LONG)
    expect(seen.sent.at(-1)?.effort).toBe('high')
  })

  test('a skill not in the table leaves the skill floor as it was', async ($, on) => {
    const seen = world(on, ['medium'])
    await turn($, LONG)
    await $.tool.call({ tool: 'Skill', skill: 'superpowers:brainstorming' })
    await $.tool.call({ tool: 'Skill', skill: 'frontend-design:frontend-design' })
    // The short reply inherits medium, below the brainstorming floor: only
    // that floor, still standing, lifts it (the session effort plays no part).
    await turn($, '続けて')
    expect(seen.sent.map(s => s.effort)).toEqual(['medium', 'xhigh'])
    expect(seen.status.at(-1)).toContain('skill: brainstorming')
    expect((await run($, '')).text).toContain('- スキル連動の下限: superpowers:brainstorming')
  })

  test('a lower listed skill replaces a higher one', async ($, on) => {
    const seen = world(on, ['xhigh', 'medium'])
    await turn($, LONG)
    await $.tool.call({ tool: 'Skill', skill: 'superpowers:brainstorming' })
    await $.tool.call({ tool: 'Skill', skill: 'superpowers:executing-plans' })
    // medium after xhigh drops to high; the executing-plans floor is high, not xhigh.
    await turn($, LONG)
    expect(seen.sent.map(s => s.effort)).toEqual(['xhigh', 'high'])
  })

  test("a subagent's skill call and a failed or denied skill call leave the main floor alone", async ($, on) => {
    const seen = world(on, ['medium', 'medium', 'medium'])
    await $.tool.call({ tool: 'Skill', skill: 'superpowers:brainstorming', agentId: 'a1' } as never)
    await turn($, LONG)
    await $.tool.call({ tool: 'Skill', skill: 'superpowers:brainstorming', args: 'fail' })
    await turn($, LONG)
    await $.tool.call({ tool: 'Skill', skill: 'superpowers:brainstorming', args: 'deny' })
    await turn($, LONG)
    expect(seen.sent.map(s => s.effort)).toEqual(['medium', 'medium', 'medium'])
    expect(seen.status.at(-1)).not.toContain('skill:')
  })

  test('a skill call sets the floor from the next request of the same turn', async ($, on) => {
    const { sent } = world(on, ['medium'])
    const turnId = `t${++ids}`
    await $.turn.start({ text: LONG, turnId })
    await step($, turnId, 0)
    await $.tool.call({ tool: 'Skill', skill: 'superpowers:systematic-debugging' })
    await step($, turnId, 1)
    expect(sent.map(s => s.effort)).toEqual(['medium', 'xhigh'])
  })

  test('floor and ceiling bound the level', async ($, on) => {
    const { sent } = world(on, ['medium', 'max'])
    await run($, 'floor high')
    await run($, 'ceiling xhigh')
    await turn($, LONG)
    await turn($, LONG)
    expect(sent.map(s => s.effort)).toEqual(['high', 'xhigh'])
  })

  test('stored settings apply from the first turn', async ($, on) => {
    const { sent } = world(on, ['medium'], { store: { floor: 'high' } })
    await turn($, LONG)
    expect(sent.map(s => s.effort)).toEqual(['high'])
  })

  test('subagent steps are not changed by A', async ($, on) => {
    const { sent } = world(on, ['medium'])
    const turnId = `t${++ids}`
    await $.turn.start({ text: LONG, turnId })
    const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 1, agentId: 'agent-x' })
    for await (const _ of stream) void _
    await stream.result
    expect(sent.map(s => s.effort)).toEqual(['xhigh'])
  })

  test('off leaves effort alone; on resumes', async ($, on) => {
    const { sent } = world(on, ['medium'])
    await run($, 'off')
    await turn($, LONG)
    await run($, 'on')
    await turn($, LONG)
    expect(sent.map(s => s.effort)).toEqual(['xhigh', 'medium'])
  })

  test('a continuation turn ("") inherits the level within the ceiling and the skill floor', async ($, on) => {
    const seen = world(on, ['medium', 'high'])
    await run($, 'ceiling high')
    await turn($, LONG)
    // The session effort is xhigh: without A it would go out above the ceiling.
    await turn($, '')
    await $.tool.call({ tool: 'Skill', skill: 'superpowers:brainstorming' })
    // The skill floor xhigh, held at the ceiling high.
    await turn($, '')
    expect(seen.sent.map(s => s.effort)).toEqual(['medium', 'medium', 'high'])
    expect(seen.inputs.length).toBe(1)
    // The next judgment still reads the request the continuations continued.
    await turn($, LONG)
    expect(seen.inputs.at(-1)).toContain(`[prev_request] ${LONG}`)
  })

  test('a continuation turn rises to the skill floor over the session effort', async ($, on) => {
    const seen = world(on, [])
    await $.tool.call({ tool: 'Skill', skill: 'superpowers:brainstorming' })
    const turnId = `t${++ids}`
    await $.turn.start({ text: '', turnId })
    const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1 })
    for await (const _ of stream) void _
    await stream.result
    expect(seen.sent.map(s => s.effort)).toEqual(['xhigh'])
  })

  test('the level does not drop within a turn; the ceiling still bounds it', async ($, on) => {
    const { sent } = world(on, ['medium'])
    const turnId = `t${++ids}`
    await $.turn.start({ text: LONG, turnId })
    await $.tool.call({ tool: 'Skill', skill: 'superpowers:brainstorming' })
    await step($, turnId, 0)
    await $.tool.call({ tool: 'Skill', skill: 'superpowers:executing-plans' })
    await step($, turnId, 1)
    await run($, 'skill clear')
    await step($, turnId, 2)
    await run($, 'ceiling high')
    await step($, turnId, 3)
    expect(sent.map(s => s.effort)).toEqual(['xhigh', 'xhigh', 'xhigh', 'high'])
  })

  test('/clear ends the skill floor and the previous turn', async ($, on) => {
    const seen = world(on, ['max', 'medium'])
    await turn($, LONG)
    await $.tool.call({ tool: 'Skill', skill: 'superpowers:brainstorming' })
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    // No floor, and no max turn before it to limit the drop.
    await turn($, LONG)
    expect(seen.sent.map(s => s.effort)).toEqual(['max', 'medium'])
    expect(seen.inputs.at(-1)).not.toContain('[prev] effort=')
    expect(seen.status.at(-1)).not.toContain('skill:')
  })

  test('/clear also forgets the recent levels, the retries, the sub count and the shown level', async ($, on) => {
    const seen = world(on, ['max', 'medium', 'medium'], { kinds: ['chore', 'chore'], weights: ['light', 'light'] })
    await turn($, LONG)
    await $.agent.spawn(spawnArgs('list hooks'))
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    expect(seen.status.at(-1)).toBe('main waiting · sub 0 · gate on')
    await turn($, LONG)
    await turn($, LONG)
    // The max turn before /clear is not among the last three levels.
    expect(seen.inputs.at(-1)).toContain('max3=medium')
    // The same description is judged afresh, not escalated as a retry.
    await $.agent.spawn(spawnArgs('list hooks'))
    expect(seen.inputs.length).toBe(7)
    expect(seen.spawned).toEqual(['sonnet', 'sonnet'])
  })

  test('an in-process /resume, which also keeps the process, starts afresh too', async ($, on) => {
    const seen = world(on, ['medium'])
    await $.tool.call({ tool: 'Skill', skill: 'superpowers:brainstorming' })
    await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
    await turn($, LONG)
    expect(seen.sent.map(s => s.effort)).toEqual(['medium'])
  })
})

describe('A: a judgment that comes late', () => {
  test('a request sent before the judgment arrives waits for it', async ($, on) => {
    const seen = world(on, ['medium'], { delays: [1000] })
    const turnId = `t${++ids}`
    const started = $.turn.start({ text: LONG, turnId })
    const stepped = step($, turnId, 0)
    await seen.clock.advance(1000)
    await stepped
    await started
    expect(seen.sent.map(s => s.effort)).toEqual(['medium'])
  })

  // The judgment of the second turn takes 20 s: its first request goes out
  // after the 5 s wait, at the level inherited from the first turn.
  async function lateTurn($: Engine, seen: ReturnType<typeof world>) {
    await turn($, LONG)
    const turnId = `t${++ids}`
    const started = $.turn.start({ text: LONG, turnId })
    const first = step($, turnId, 0)
    await seen.clock.advance(5_000)
    await first
    return { turnId, started }
  }

  test('past the wait, the request inherits the previous level; the judgment applies from the next one', async ($, on) => {
    const seen = world(on, ['xhigh', 'max'], { delays: [0, 20_000] })
    const { turnId, started } = await lateTurn($, seen)
    expect(seen.sent.map(s => s.effort)).toEqual(['xhigh', 'xhigh'])
    await seen.clock.advance(15_000)
    await started
    await step($, turnId, 1)
    await complete($, turnId)
    expect(seen.sent.map(s => s.effort)).toEqual(['xhigh', 'xhigh', 'max'])
    const { text } = await run($, 'log main')
    expect(text).toContain('xhigh -> max\tauto')
  })

  test('a late judgment lower than the level already sent does not lower the turn', async ($, on) => {
    const seen = world(on, ['xhigh', 'medium'], { delays: [0, 20_000] })
    const { turnId, started } = await lateTurn($, seen)
    await seen.clock.advance(15_000)
    await started
    await step($, turnId, 1)
    expect(seen.sent.map(s => s.effort)).toEqual(['xhigh', 'xhigh', 'xhigh'])
  })

  test('a one-request turn whose judgment never came in time records the level it ran at', async ($, on) => {
    const seen = world(on, ['xhigh', 'max', 'medium'], { delays: [0, 20_000] })
    const { turnId, started } = await lateTurn($, seen)
    await complete($, turnId)
    expect((await run($, 'log main')).text).toContain('xhigh -> xhigh\tlate')
    await seen.clock.advance(15_000)
    await started
    // The next turn reads xhigh as the previous level: medium drops one level, to high.
    await turn($, LONG)
    expect(seen.inputs.at(-1)).toContain('[prev] effort=xhigh')
    expect(seen.sent.map(s => s.effort)).toEqual(['xhigh', 'xhigh', 'high'])
  })

  test('a request sent before turn.start runs inherits; its tool calls count, and the judgment follows', async ($, on) => {
    const seen = world(on, ['high', 'medium'])
    await turn($, LONG)
    const turnId = `t${++ids}`
    await step($, turnId, 0)
    await bash($, false)
    await $.turn.start({ text: LONG, turnId })
    await bash($, false)
    await step($, turnId, 1)
    // high inherited, then the medium judgment held at high and bumped once.
    expect(seen.sent.map(s => s.effort)).toEqual(['high', 'high', 'xhigh'])
  })
})

describe('A: the mid-turn bump', () => {
  async function failures($: Engine, calls: Array<() => Promise<unknown>>) {
    const turnId = `t${++ids}`
    await $.turn.start({ text: LONG, turnId })
    await step($, turnId, 0)
    for (const call of calls) await call()
    await step($, turnId, 1)
    return turnId
  }

  test('two failed tool calls in a row raise the next request one level', async ($, on) => {
    const seen = world(on, ['high'])
    await failures($, [() => bash($, false), () => bash($, false)])
    expect(seen.sent.map(s => s.effort)).toEqual(['high', 'xhigh'])
    expect(seen.status.at(-1)).toContain('main xhigh +1')
  })

  test('one failure does not', async ($, on) => {
    const seen = world(on, ['high'])
    await failures($, [() => bash($, false)])
    expect(seen.sent.map(s => s.effort)).toEqual(['high', 'high'])
  })

  test('a success between failures resets the count', async ($, on) => {
    const seen = world(on, ['high'])
    await failures($, [() => bash($, false), () => bash($, true), () => bash($, false)])
    expect(seen.sent.map(s => s.effort)).toEqual(['high', 'high'])
  })

  test('four failures still raise one level, once a turn', async ($, on) => {
    const seen = world(on, ['high'])
    const turnId = await failures($, [() => bash($, false), () => bash($, false)])
    await bash($, false)
    await bash($, false)
    await step($, turnId, 2)
    expect(seen.sent.map(s => s.effort)).toEqual(['high', 'xhigh', 'xhigh'])
  })

  test('the raise stops at the ceiling', async ($, on) => {
    const seen = world(on, ['xhigh'])
    await run($, 'ceiling xhigh')
    await failures($, [() => bash($, false), () => bash($, false)])
    expect(seen.sent.map(s => s.effort)).toEqual(['xhigh', 'xhigh'])
  })

  test("a subagent's failures do not raise the main loop", async ($, on) => {
    const seen = world(on, ['high'])
    const sub = () => $.tool.call({ tool: 'Bash', command: 'false', agentId: 'agent-x' } as never)
    await failures($, [sub, sub])
    expect(seen.sent.map(s => s.effort)).toEqual(['high', 'high'])
  })

  test('a denied call is neither a failure nor a success', async ($, on) => {
    const seen = world(on, ['high', 'high'])
    const denied = () => $.tool.call({ tool: 'Workflow', script: BAD })
    await failures($, [denied, () => bash($, false)])
    await failures($, [() => bash($, false), denied, () => bash($, false)])
    expect(seen.sent.map(s => s.effort)).toEqual(['high', 'high', 'high', 'xhigh'])
  })

  test('Workflow calls count like any other tool', async ($, on) => {
    const seen = world(on, ['high', 'high'])
    const failing = () => $.tool.call({ tool: 'Workflow', name: 'fails' })
    await failures($, [failing, failing])
    await failures($, [() => bash($, false), () => $.tool.call({ tool: 'Workflow', name: 'review-changes' }), () => bash($, false)])
    expect(seen.sent.map(s => s.effort)).toEqual(['high', 'xhigh', 'high', 'high'])
  })
})

describe('A: paused while effort-router is registered', () => {
  test('A leaves effort alone and says so; B, C, D and the guard keep running', async ($, on) => {
    const seen = world(on, [], { settings: EFFORT_ROUTER, kinds: ['chore'], weights: ['light'], store: { guard: 'on' } })
    await turn($, LONG)
    expect(seen.sent.map(s => s.effort)).toEqual(['xhigh'])
    expect(seen.inputs.length).toBe(0)
    expect(seen.toasts).toContain('effort-router も入っているため、本体の Effort は effort-router に任せます。quality-router は本体モデルの守り・サブエージェントの振り分け・Workflow の点検・判定の記録を続けます（README「effort-router と一緒に使うとき」）')
    expect(seen.status.at(-1)).toContain('main paused (effort-router)')
    expect((await run($, '')).text).toContain('（effort-router を検知したため')
    // Neither the bounds nor a skill floor touch the effort, and no turn is logged.
    await run($, 'ceiling high')
    await $.tool.call({ tool: 'Skill', skill: 'superpowers:brainstorming' })
    await turn($, '続けて')
    expect(seen.sent.map(s => s.effort)).toEqual(['xhigh', 'xhigh'])
    expect((await run($, 'log main')).text).toBe('main: まだ記録がありません。')
    // B: a bad session script is still sent back.
    const r = (await $.tool.call({ tool: 'Workflow', script: BAD })) as { deny?: string; text?: string }
    expect(r.deny ?? r.text ?? '').toContain('差し戻しました')
    // D: a chore child still goes to sonnet.
    await $.agent.spawn(spawnArgs('list hooks'))
    expect(seen.spawned).toEqual(['sonnet'])
    // The guard is not effort routing: a Sonnet main still goes out on the top model.
    await turn($, LONG, { model: 'claude-sonnet-5-5' })
    expect(seen.sent.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh', agentId: undefined })
  })
})

describe('A: main model guard', () => {
  test('a Sonnet main request goes out on the top model', async ($, on) => {
    const { sent } = world(on, ['high', 'high', 'high'], { store: GUARD_ON })
    await turn($, LONG, { model: 'claude-sonnet-5-5' })
    expect(sent.map(s => s.model)).toEqual(['claude-opus-5-5'])
    await run($, 'top fable')
    await turn($, LONG, { model: 'claude-sonnet-5-5' })
    expect(sent.at(-1)?.model).toBe('claude-fable-5-1')
    await run($, 'top opus')
    await turn($, LONG, { model: 'claude-sonnet-5-5' })
    expect(sent.at(-1)?.model).toBe('claude-opus-5-5')
  })

  test('an older Opus fallback is left alone', async ($, on) => {
    const { sent } = world(on, ['high'], { store: GUARD_ON })
    await turn($, LONG, { model: 'claude-opus-5' })
    expect(sent.map(s => s.model)).toEqual(['claude-opus-5'])
  })

  test('when the top model fails, the original model is resent and the user is told', async ($, on) => {
    const seen = world(on, ['high'], { store: GUARD_ON, failModel: 'claude-opus-5-5' })
    await turn($, LONG, { model: 'claude-sonnet-5-5' })
    expect(seen.sent.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(seen.toasts).toContain('上位モデルに戻せなかったため、claude-sonnet-5-5 のまま続けます')
    expect(seen.status.at(-1)).toContain('main sonnet! high')
  })

  test('guard off leaves Sonnet alone', async ($, on) => {
    const { sent } = world(on, ['high'], { store: GUARD_ON })
    await run($, 'guard off')
    await turn($, LONG, { model: 'claude-sonnet-5-5' })
    expect(sent.map(s => s.model)).toEqual(['claude-sonnet-5-5'])
  })

  test('/qr off stops the guard with the rest of A', async ($, on) => {
    const { sent } = world(on, [], { store: GUARD_ON })
    await run($, 'off')
    await turn($, LONG, { model: 'claude-sonnet-5-5' })
    expect(sent.map(s => s.model)).toEqual(['claude-sonnet-5-5'])
    expect((await run($, '')).text).toContain('振り分けが off の間は止まります')
  })

  test('a top-model request that gets no response is resent on the original model', async ($, on) => {
    const seen = world(on, ['high'], { store: GUARD_ON, emptyModel: 'claude-opus-5-5' })
    await turn($, LONG, { model: 'claude-sonnet-5-5' })
    expect(seen.sent.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(seen.toasts).toContain('上位モデルに戻せなかったため、claude-sonnet-5-5 のまま続けます')
  })

  // The kit's bottom cannot make `engine` chunks (only the engine has refs),
  // so a `stop` chunk, which is not content either, stands in for the items
  // the engine streams ahead of a response's content (its API error item).
  test("the failed attempt's items ahead of any content are dropped; only the resent answer goes up", async ($, on) => {
    const seen = world(on, ['high'], { store: GUARD_ON,
      emptyModel: 'claude-opus-5-5',
      chunks: {
        'claude-opus-5-5': [{ kind: 'stop', stopReason: null, usage: null }],
        'claude-sonnet-5-5': [{ kind: 'text', index: 0, text: 'ok' }],
      },
    })
    const turnId = `t${++ids}`
    await $.turn.start({ text: LONG, turnId })
    const chunks = await step($, turnId, 0, 'claude-sonnet-5-5')
    expect(seen.sent.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(chunks).toEqual([{ kind: 'text', index: 0, text: 'ok' }])
  })

  test('a successful attempt passes every chunk on, in order', async ($, on) => {
    const stop = { kind: 'stop', stopReason: 'end_turn', usage: null } as const
    world(on, ['high'], { store: GUARD_ON,
      chunks: { 'claude-opus-5-5': [stop, { kind: 'thinking', index: 0, text: 'hm' }, { kind: 'text', index: 1, text: 'ok' }, stop] },
    })
    const turnId = `t${++ids}`
    await $.turn.start({ text: LONG, turnId })
    const chunks = await step($, turnId, 0, 'claude-sonnet-5-5')
    expect(chunks.map(c => c.kind)).toEqual(['stop', 'thinking', 'text', 'stop'])
  })

  test('a successful attempt with no content still passes its items on', async ($, on) => {
    world(on, ['high'], { store: GUARD_ON, chunks: { 'claude-opus-5-5': [{ kind: 'stop', stopReason: 'end_turn', usage: null }] } })
    const turnId = `t${++ids}`
    await $.turn.start({ text: LONG, turnId })
    const chunks = await step($, turnId, 0, 'claude-sonnet-5-5')
    expect(chunks.map(c => c.kind)).toEqual(['stop'])
  })

  test('an attempt that fails after showing part of its answer is not resent', async ($, on) => {
    const seen = world(on, ['high'], { store: GUARD_ON,
      failModel: 'claude-opus-5-5',
      chunks: { 'claude-opus-5-5': [{ kind: 'text', index: 0, text: 'part' }] },
    })
    const turnId = `t${++ids}`
    await $.turn.start({ text: LONG, turnId })
    let error: unknown
    const shown: TurnStepChunk[] = []
    try {
      const stream = $.turn.step({ turnId, index: 0, model: 'claude-sonnet-5-5', effort: 'xhigh', messageCount: 1 })
      for await (const c of stream) shown.push(c)
      await stream.result
    } catch (e) {
      error = e
    }
    // The step fails as the attempt did: the engine's own error handling takes it.
    expect(error).toBeDefined()
    expect(shown).toEqual([{ kind: 'text', index: 0, text: 'part' }])
    expect(seen.sent.map(s => s.model)).toEqual(['claude-opus-5-5'])
    expect(seen.toasts).toContain('上位モデルに戻せなかったため、claude-sonnet-5-5 のまま続けます')
    // The turn's next request goes out on the original model.
    await step($, turnId, 1, 'claude-sonnet-5-5')
    expect(seen.sent.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
  })

  test('the engine keeping the original model counts as a fallback, told once a turn', async ($, on) => {
    const seen = world(on, ['high'], { store: GUARD_ON, answeredBy: 'claude-sonnet-5-5' })
    const turnId = `t${++ids}`
    await $.turn.start({ text: LONG, turnId })
    await step($, turnId, 0, 'claude-sonnet-5-5')
    await step($, turnId, 1, 'claude-sonnet-5-5')
    await complete($, turnId)
    expect(seen.sent.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(seen.toasts.filter(t => t === '上位モデルに戻せなかったため、claude-sonnet-5-5 のまま続けます').length).toBe(1)
    expect(seen.status.at(-1)).toContain('main sonnet! high')
    const { text } = await run($, 'log main')
    expect(text).toContain('\tclaude-sonnet-5-5\t')
    expect(text).not.toContain('(guarded)')
  })

  test('after the top model fails, the rest of the turn stays on the original model, told once', async ($, on) => {
    const seen = world(on, ['high', 'high'], { store: GUARD_ON, failModel: 'claude-opus-5-5' })
    const turnId = `t${++ids}`
    await $.turn.start({ text: LONG, turnId })
    for (let i = 0; i < 3; i += 1) await step($, turnId, i, 'claude-sonnet-5-5')
    await complete($, turnId)
    const fallbacks = () => seen.toasts.filter(t => t.startsWith('上位モデルに戻せなかった')).length
    expect(seen.sent.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5'])
    expect(fallbacks()).toBe(1)
    expect(seen.status.at(-1)).toContain('main sonnet! high')
    // The next turn tries the top model again.
    await turn($, LONG, { model: 'claude-sonnet-5-5' })
    expect(seen.sent.slice(-2).map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(fallbacks()).toBe(2)
  })

  test('a main model without effort raised by the guard gets the turn level', async ($, on) => {
    const { sent } = world(on, ['high', 'high'], { store: GUARD_ON })
    for (const guard of ['on', 'off']) {
      await run($, `guard ${guard}`)
      const turnId = `t${++ids}`
      await $.turn.start({ text: LONG, turnId })
      const stream = $.turn.step({ turnId, index: 0, model: 'claude-haiku-4-5', messageCount: 1 })
      for await (const _ of stream) void _
      await stream.result
      await complete($, turnId)
    }
    expect(sent).toEqual([
      { model: 'claude-opus-5-5', effort: 'high', agentId: undefined },
      { model: 'claude-haiku-4-5', effort: undefined, agentId: undefined },
    ])
  })
})

describe('E: commands', () => {
  test('a command name that cannot be registered leaves the other and the status line', async ($, on) => {
    const seen = world(on, [])
    const registered: string[] = []
    on('command.register', async ($, e) => {
      if (e.name === 'quality-router') throw new Error('taken')
      registered.push(e.name)
      return { value: { command: e.name } }
    })
    await $.session.start({ cwd: 'C:/work/app', surface: 'terminal', isInteractive: true })
    expect(registered).toEqual(['qr'])
    expect(seen.toasts).toEqual(['コマンド /quality-router を登録できませんでした'])
    expect(seen.status.at(-1)).toBe('main waiting · sub 0 · gate on')
  })

  test('/qr and /quality-router describe the settings in Japanese', async ($, on) => {
    world(on, [])
    expect((await run($, '')).text).toContain('- 本体の段階: floor medium / ceiling max')
    expect((await run($, '', 'quality-router')).text).toMatch(/^quality-router v\S+ の設定/)
  })

  test('the version from plugin.json leads the status line and answers /qr version', async ($, on) => {
    const seen = world(on, [])
    const read: string[] = []
    on('fs.read', async ($, e) => {
      const path = e.path.replace(/\\/g, '/')
      read.push(path)
      if (path.endsWith('/.claude-plugin/plugin.json')) return { value: '{"name":"quality-router","version":"9.9.9"}' }
      throw new Error(`ENOENT ${e.path}`)
    })
    on('command.register', async ($, e) => ({ value: { command: e.name } }))
    await $.session.start({ cwd: 'C:/work/app', surface: 'terminal', isInteractive: true })
    expect(seen.status.at(-1)).toBe('v9.9.9 · main waiting · sub 0 · gate on')
    const root = read[0]?.replace('/.claude-plugin/plugin.json', '') ?? ''
    expect(root).not.toBe('')
    const answer = (await run($, 'version')).text ?? ''
    expect(answer).toMatch(/^quality-router v9\.9\.9（読み込み元: .+）$/)
    expect(answer.replace(/\\/g, '/')).toContain(root)
    expect((await run($, '')).text).toMatch(/^quality-router v9\.9\.9 の設定[\s\S]*\n- 読み込み元: /)
  })

  test('an unreadable plugin.json leaves the status line without a version', async ($, on) => {
    const seen = world(on, [])
    on('fs.read', async () => {
      throw new Error('ENOENT')
    })
    on('command.register', async ($, e) => ({ value: { command: e.name } }))
    await $.session.start({ cwd: 'C:/work/app', surface: 'terminal', isInteractive: true })
    expect(seen.status.at(-1)).toBe('main waiting · sub 0 · gate on')
    expect((await run($, 'version')).text).toMatch(/^quality-router v\?（読み込み元: /)
  })

  // With 'stored settings apply from the first turn', this covers a reload:
  // what a command sets is written to $.store, and a load reads $.store.
  test('a setting a command changes is written to $.store', async ($, on) => {
    const kept: Record<string, unknown> = {}
    world(on, [], { kept })
    for (const args of ['floor high', 'ceiling xhigh', 'top fable', 'gate off', 'guard off', 'off']) await run($, args)
    expect(kept).toEqual({ mode: 'off', gate: 'off', guard: 'off', floor: 'high', ceiling: 'xhigh', top: 'fable' })
  })

  test('an unknown argument is refused with the usage', async ($, on) => {
    world(on, [])
    for (const args of ['floor huge', 'floor low', 'ceiling none', 'gate maybe', 'guard 1', 'top sonnet', 'skill set', 'log all', 'eval both', 'bogus']) {
      expect((await run($, args)).text).toContain(`「${args}」は使えません。`)
    }
  })

  test('log main shows prev -> level with the raw judgment', async ($, on) => {
    world(on, ['xhigh', 'medium'])
    await turn($, LONG)
    await turn($, LONG)
    const { text } = await run($, 'log main')
    expect(text).toContain('main: 2 turns logged')
    expect(text).toContain('xhigh -> high (judged medium)')
  })

  test('log main keeps the first 40 characters of a request and no more', async ($, on) => {
    world(on, ['high'])
    await turn($, `${'あ'.repeat(40)}${'い'.repeat(40)}`)
    const { text } = await run($, 'log main')
    expect(text).toContain(`\t${'あ'.repeat(40)}…`)
    expect(text).not.toContain('い')
  })

  test('log main names the bound, the skill floor, the bump and the responding model', async ($, on) => {
    world(on, ['medium', 'medium'], { store: GUARD_ON })
    await $.tool.call({ tool: 'Skill', skill: 'superpowers:brainstorming' })
    await turn($, LONG, { model: 'claude-sonnet-5-5' })
    await run($, 'ceiling high')
    await turn($, LONG)
    const { text } = await run($, 'log main')
    expect(text).toContain('- -> xhigh (judged medium) by skill [skill brainstorming]\tauto\tclaude-opus-5-5 (guarded)\t')
    expect(text).toContain('xhigh -> high (judged medium) by ceiling [skill brainstorming]\tauto\tclaude-opus-5-5\t')
  })

  test('log sub, log gate and a bare log', async ($, on) => {
    world(on, ['high'], { kinds: ['chore'], weights: ['light'] })
    await $.agent.spawn(spawnArgs(`list hooks ${'x'.repeat(60)}`))
    await $.tool.call({ tool: 'Workflow', script: BAD })
    await turn($, LONG)
    const sub = (await run($, 'log sub')).text
    expect(sub).toContain('sub: 1 spawns logged')
    expect(sub).toContain(`chore/light/auto -> sonnet medium\tgeneral-purpose\tlist hooks ${'x'.repeat(29)}…`)
    expect((await run($, 'log gate')).text).toContain('deny (1) script calls=1')
    const all = (await run($, 'log')).text
    expect(all).toContain('main: 1 turns logged')
    expect(all).toContain('sub: 1 spawns logged')
    expect(all).toContain('gate: 1 checks logged')
  })
})

describe('effort-router in any scope', () => {
  test('its command in the command list pauses A from the first turn and says what keeps running', async ($, on) => {
    const seen = world(on, ['high'], { commands: [{ name: 'effort-router', description: 'x', source: 'plugin', plugin: 'effort-router' }] })
    await turn($, LONG)
    expect(seen.inputs.length).toBe(0)
    expect(seen.sent.map(s => s.effort)).toEqual(['xhigh'])
    expect(seen.toasts.filter(t => t.startsWith('effort-router も入っているため'))).toHaveLength(1)
    expect(seen.status.at(-1)).toContain('main paused (effort-router)')
    await turn($, LONG)
    expect(seen.toasts.filter(t => t.startsWith('effort-router も入っているため'))).toHaveLength(1)
  })

  test('a command list that cannot be read leaves A running', async ($, on) => {
    const seen = world(on, ['high'])
    await turn($, LONG)
    expect(seen.sent.map(s => s.effort)).toEqual(['high'])
  })
})

describe('public defaults', () => {
  test('the guard is off by default: a Sonnet main is left alone until /qr guard on', async ($, on) => {
    const seen = world(on, ['high', 'high'])
    await turn($, LONG, { model: 'claude-sonnet-5-5' })
    expect(seen.sent.at(-1)?.model).toBe('claude-sonnet-5-5')
    await run($, 'guard on')
    await turn($, LONG, { model: 'claude-sonnet-5-5' })
    expect(seen.sent.at(-1)?.model).toBe('claude-opus-5-5')
  })
})
