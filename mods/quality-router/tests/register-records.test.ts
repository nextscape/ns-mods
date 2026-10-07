import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = 'C:/Users/u'
const LOG = `${HOME}/.claude/quality-router/log/`
const LONG = 'この関数の命名だけ確認したいのですが問題ないでしょうか'

type Opts = { env?: boolean; failWrites?: boolean; sessionId?: () => string; failRead?: boolean }

// files: the fake disk, by forward-slash path. fs.list answers the direct
// children of a folder, mtime far in the future so /qr stats reads them.
function world(on: On, opts: Opts = {}) {
  mock.store(on)
  const clock = mock.clock(on)
  // env: false answers no home folder at all (not the machine's own variables).
  mock.env(on, opts.env === false ? {} : { USERPROFILE: 'C:\\Users\\u' })
  const files = new Map<string, string>()
  const norm = (p: string) => p.replace(/\\/g, '/')
  const seen = { clock, files, toasts: [] as string[], writes: 0 }
  on('fs.write', async ($, e) => {
    if (opts.failWrites) throw new Error('EACCES')
    seen.writes += 1
    files.set(norm(e.path), e.text)
    return { value: undefined }
  })
  on('fs.read', async ($, e) => {
    if (opts.failRead) throw new Error('EBUSY')
    const text = files.get(norm(e.path))
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.exists', async ($, e) => ({ value: files.has(norm(e.path)) }))
  on('fs.list', async ($, e) => {
    const dir = norm(e.path).replace(/\/$/, '') + '/'
    const names = new Map<string, 'file' | 'dir'>()
    for (const p of files.keys()) {
      if (!p.startsWith(dir)) continue
      const rest = p.slice(dir.length)
      const cut = rest.indexOf('/')
      names.set(cut < 0 ? rest : rest.slice(0, cut), cut < 0 ? 'file' : 'dir')
    }
    if (names.size === 0) throw new Error(`ENOENT ${e.path}`)
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 8.64e15, isLink: false })) }
  })
  on('session.id', async () => ({ value: opts.sessionId?.() ?? 'sess-r' }))
  on('session.cwd', async () => ({ value: 'C:/work/app' }))
  on('model.classify', async ($, e) => ({ value: e.labels.includes('heavy') ? 'light' : e.labels.includes('chore') ? 'chore' : 'high' }))
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.end', async ($, e) => ({ sessionId: e.sessionId }))
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  on('command.run', async () => ({ text: 'engine' }))
  let spawned = 0
  on('agent.spawn', async ($, e) => ({ model: e.model ?? e.parentModel, agentId: `agent-${++spawned}` }))
  on('tool.call', async ($, e) => (e.tool === 'Bash' && e.command === 'false' ? { result: {}, isError: true, text: 'exit 1' } : { result: {} }) as never)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return seen
}

const records = (seen: { files: Map<string, string> }) =>
  [...seen.files.entries()]
    .filter(([p]) => p.startsWith(LOG))
    .flatMap(([, t]) => t.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>))

const USAGE = { input_tokens: 4, output_tokens: 211, cache_read_input_tokens: 32130, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }

let ids = 0
// The test kit has nothing beneath session.append and a hook may not answer
// it without next, so the call rejects after the plugin's hook has seen the row.
async function prompt($: Engine, text: string, uuid: string) {
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] }, door: 'prompt', origin: { kind: 'unclassified' }, uuid } as never).catch(() => undefined)
}
async function answer($: Engine, uuid: string, agentId?: string) {
  await $.session.append({ message: { type: 'assistant', content: [] }, door: 'response', origin: { kind: 'model', model: 'claude-opus-5-5' }, uuid, agentId } as never).catch(() => undefined)
}
async function step($: Engine, turnId: string, index: number, agentId?: string) {
  const stream = $.turn.step({ turnId, index, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 1, agentId } as never)
  for await (const _ of stream) void _
  await stream.result
}
async function mainTurn($: Engine, text: string, opts: { promptUuid?: string; answerUuid?: string; reason?: 'answer' | 'aborted' } = {}) {
  const turnId = `t${++ids}`
  if (opts.promptUuid) await prompt($, text, opts.promptUuid)
  await $.turn.start({ text, turnId })
  await step($, turnId, 0)
  if (opts.answerUuid) await answer($, opts.answerUuid)
  await $.turn.complete({ turnId, answer: 'ok', durationMs: 1200, isAborted: opts.reason === 'aborted', reason: opts.reason ?? 'answer', usage: USAGE } as never)
  return turnId
}
const start = ($: Engine) => $.session.start({ cwd: 'C:/work/app', surface: 'terminal', isInteractive: true })
const run = ($: Engine, args: string) =>
  $.command.run({ command: 'qr', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

describe('records: main turns and the file', () => {
  test('a session start writes a session record to the month file', async ($, on) => {
    const seen = world(on)
    await start($)
    const [rec] = records(seen)
    expect([...seen.files.keys()].some(p => /\/log\/\d{4}-\d{2}\/sess-r\.jsonl$/.test(p))).toBe(true)
    expect(rec).toMatchObject({ v: 1, kind: 'session', event: 'start', session: 'sess-r', cwd: 'C:/work/app', paused: false, tune: null })
    expect(rec?.settings).toMatchObject({ mode: 'on', gate: 'on', floor: 'medium' })
  })

  test('a main turn records the prompt and answer uuids, the judgment and the result, no text', async ($, on) => {
    const seen = world(on)
    await start($)
    const turnId = await mainTurn($, LONG, { promptUuid: 'u-prompt', answerUuid: 'u-answer' })
    const main = records(seen).find(r => r.kind === 'main')
    expect(main).toMatchObject({
      turn: turnId,
      promptUuid: 'u-prompt',
      answerUuid: 'u-answer',
      promptChars: LONG.length,
      judged: 'high',
      level: 'high',
      why: 'auto',
      steps: 1,
      tools: 0,
      toolErrors: 0,
      bump: false,
      durationMs: 1200,
      tokens: { input: 4, output: 211, cacheRead: 32130 },
      reason: 'answer',
    })
    expect(typeof main?.judgeMs).toBe('number')
    expect(JSON.stringify(records(seen))).not.toContain(LONG)
  })

  test('continuation: a turn with no typed prompt keeps no prompt uuid', async ($, on) => {
    const seen = world(on)
    await start($)
    await prompt($, LONG, 'u-stale')
    await mainTurn($, '', {})
    const main = records(seen).find(r => r.kind === 'main')
    expect(main?.promptUuid).toBeNull()
    await mainTurn($, LONG, {})
    expect(records(seen).filter(r => r.kind === 'main').at(-1)?.promptUuid).toBeNull()
  })

  test('an aborted turn is recorded with its reason', async ($, on) => {
    const seen = world(on)
    await start($)
    await mainTurn($, LONG, { reason: 'aborted' })
    expect(records(seen).find(r => r.kind === 'main')?.reason).toBe('aborted')
  })

  test('existing file: a reload or resume appends to what the session already wrote', async ($, on) => {
    const seen = world(on)
    // The file's month is the test clock's, not the wall clock's.
    const month = new Date(seen.clock.now()).toISOString().slice(0, 7)
    const path = `${LOG}${month}/sess-r.jsonl`
    const before = JSON.stringify({ v: 1, kind: 'session', event: 'start', at: '2026-10-07T00:00:00.000Z', session: 'sess-r' })
    seen.files.set(path, `${before}\n`)
    await start($)
    const lines = seen.files.get(path)!.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(before)
  })

  test('write failure: the turn completes and the toast comes once', async ($, on) => {
    const seen = world(on, { failWrites: true })
    await start($)
    await mainTurn($, LONG, {})
    await mainTurn($, LONG, {})
    expect(seen.toasts.filter(t => t.startsWith('判定の記録を書けませんでした'))).toHaveLength(1)
  })

  test('no home folder: nothing is written and nothing is toasted', async ($, on) => {
    const seen = world(on, { env: false })
    await start($)
    await mainTurn($, LONG, {})
    expect(seen.writes).toBe(0)
    expect(seen.toasts).toEqual([])
  })
})

const spawnArgs = (description: string, opts: { model?: string; subagentType?: string } = {}) =>
  ({
    tool_use_id: `tu-${++ids}`,
    prompt: 'hooks フォルダのファイル一覧を作って',
    description,
    subagentType: opts.subagentType ?? 'general-purpose',
    model: opts.model,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  }) as never

async function childEnds($: Engine, agentId: string, turnId: string) {
  await $.turn.complete({ turnId, answer: 'report', durationMs: 4800, isAborted: false, reason: 'answer', agentId, usage: { ...USAGE, model: 'claude-sonnet-5-5' } } as never)
}

describe('records: children and Workflow', () => {
  test('an Agent-tool child records its judgment and its result when it ends', async ($, on) => {
    const seen = world(on)
    await start($)
    const turnId = `t${++ids}`
    await $.turn.start({ text: LONG, turnId })
    const spawned = await $.agent.spawn(spawnArgs('count probe files'))
    const agentId = (spawned as { agentId: string }).agentId
    await step($, `c${ids}`, 0, agentId)
    await $.tool.call({ tool: 'Bash', command: 'false', agentId } as never)
    await childEnds($, agentId, `c${ids}`)
    const sub = records(seen).find(r => r.kind === 'sub')
    expect(sub).toMatchObject({
      turn: turnId,
      agentId,
      type: 'general-purpose',
      descChars: 'count probe files'.length,
      kindJudged: 'chore',
      weightJudged: 'light',
      why: 'auto',
      retries: 0,
      steps: 1,
      toolErrors: 1,
      durationMs: 4800,
      reason: 'answer',
    })
    expect(JSON.stringify(sub)).not.toContain('count probe files')
  })

  test('a child with an explicit model is recorded as explicit', async ($, on) => {
    const seen = world(on)
    await start($)
    const spawned = await $.agent.spawn(spawnArgs('look up docs', { model: 'haiku' }))
    await childEnds($, (spawned as { agentId: string }).agentId, `c${++ids}`)
    expect(records(seen).find(r => r.kind === 'sub')).toMatchObject({ why: 'explicit', kindJudged: null, retries: 0 })
  })

  test('a Workflow child (no agent.spawn) records the model and effort it ran on', async ($, on) => {
    const seen = world(on)
    await start($)
    const turnId = `t${++ids}`
    await $.turn.start({ text: LONG, turnId })
    await step($, 'wf-c1', 0, 'agent-wf')
    await childEnds($, 'agent-wf', 'wf-c1')
    expect(records(seen).find(r => r.kind === 'wf' && r.phase === 'child')).toMatchObject({ turn: turnId, agentId: 'agent-wf', model: 'claude-opus-5-5', effort: 'xhigh', steps: 1 })
  })

  test('the gate records its verdict, kinds and rule counts', async ($, on) => {
    const seen = world(on)
    await start($)
    const script = "export const meta = { name: 'b', description: 'x' }\nawait agent('a', { label: 'chore: list', model: 'haiku', effort: 'low' })\nawait agent('b', { label: 'review: diff', effort: 'medium' })"
    await $.tool.call({ tool: 'Workflow', script } as never)
    expect(records(seen).find(r => r.kind === 'wf' && r.phase === 'gate')).toMatchObject({ verdict: 'deny', source: 'script', calls: 2, kinds: { chore: 1, review: 1 }, rules: { R2: 1 }, fixes: 0 })
  })
})

const command = ($: Engine, name: string, args: string) =>
  $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

describe('records: signals', () => {
  test('a manual /effort and /model are recorded against what was sent and what answered', async ($, on) => {
    const seen = world(on)
    await start($)
    await mainTurn($, LONG, {})
    await command($, 'effort', 'max')
    await command($, 'model', 'sonnet')
    const sig = records(seen).filter(r => r.kind === 'signal')
    expect(sig[0]).toMatchObject({ type: 'override', what: 'effort', from: 'high', to: 'max', dir: 'up' })
    expect(sig[1]).toMatchObject({ type: 'override', what: 'model', from: 'claude-opus-5-5', to: 'sonnet', dir: 'down' })
  })

  test('/qr up names the last main turn; /qr down sub the last child', async ($, on) => {
    const seen = world(on)
    await start($)
    const turnId = await mainTurn($, LONG, {})
    expect((await run($, 'up')).text).toBe('記録しました：直前の本体ターンの判定は「浅すぎた」')
    const spawned = await $.agent.spawn(spawnArgs('count probe files'))
    const agentId = (spawned as { agentId: string }).agentId
    await childEnds($, agentId, `c${++ids}`)
    expect((await run($, '↓ sub')).text).toBe('記録しました：直前の子の判定は「重すぎた」')
    const fb = records(seen).filter(r => r.kind === 'signal' && r.type === 'feedback')
    expect(fb[0]).toMatchObject({ dir: 'up', target: 'main', targetTurn: turnId, targetAgent: null })
    expect(fb[1]).toMatchObject({ dir: 'down', target: 'sub', targetTurn: null, targetAgent: agentId })
  })

  test('/qr up with no turn yet records nothing', async ($, on) => {
    const seen = world(on)
    await start($)
    expect((await run($, 'up')).text).toBe('直前の本体ターンがまだないため、記録しませんでした')
    expect(records(seen).filter(r => r.kind === 'signal')).toHaveLength(0)
  })

  test('the third start of the same task is recorded', async ($, on) => {
    const seen = world(on)
    await start($)
    for (let i = 0; i < 3; i++) await $.agent.spawn(spawnArgs('fix the failing test'))
    expect(records(seen).filter(r => r.kind === 'signal' && r.type === 'retry3')).toHaveLength(1)
  })

  test('a settings change is recorded; a bare /qr is not', async ($, on) => {
    const seen = world(on)
    await start($)
    await run($, 'floor high')
    await run($, '')
    const sessions = records(seen).filter(r => r.kind === 'session')
    expect(sessions).toHaveLength(2)
    expect(sessions[1]).toMatchObject({ event: 'settings', settings: { floor: 'high' } })
  })

  test('clear: a new session id gets its own file and /qr up has no target', async ($, on) => {
    let sid = 'sess-r'
    const seen = world(on, { sessionId: () => sid })
    await start($)
    await mainTurn($, LONG, {})
    await $.session.end({ reason: 'clear', sessionId: 'sess-r', resume: { id: 'sess-r' } } as never)
    sid = 'sess-s'
    expect((await run($, 'up')).text).toBe('直前の本体ターンがまだないため、記録しませんでした')
    await mainTurn($, LONG, {})
    expect([...seen.files.keys()].some(p => p.endsWith('/sess-s.jsonl'))).toBe(true)
  })
})

describe('records: /qr stats', () => {
  test('/qr stats reads the record files of the period', async ($, on) => {
    world(on)
    await start($)
    await mainTurn($, LONG, {})
    const text = (await run($, 'stats today')).text ?? ''
    expect(text.split('\n')[0]).toBe('stats today: main 1 turns, sub 0, workflow 0')
    expect((await run($, 'stats 1y')).text).toContain('「stats 1y」は使えません。')
  })
})

describe('records: review fixes', () => {
  test('an existing file that cannot be read is not overwritten: the next part takes the records', async ($, on) => {
    const seen = world(on, { failRead: true })
    const month = new Date(seen.clock.now()).toISOString().slice(0, 7)
    const path = `${LOG}${month}/sess-r.jsonl`
    const before = JSON.stringify({ v: 1, kind: 'session', event: 'start', at: '2026-10-07T00:00:00.000Z', session: 'sess-r' })
    seen.files.set(path, `${before}\n${before}\n`)
    await start($)
    expect(seen.files.get(path)).toBe(`${before}\n${before}\n`)
    expect(seen.files.has(`${LOG}${month}/sess-r.2.jsonl`)).toBe(true)
  })

  test('a failed first lookup is retried by the next record', async ($, on) => {
    let calls = 0
    const seen = world(on, {
      sessionId: () => {
        calls += 1
        if (calls === 1) throw new Error('not yet')
        return 'sess-r'
      },
    })
    await start($)
    await mainTurn($, LONG, {})
    expect(records(seen).some(r => r.kind === 'main')).toBe(true)
  })

  test('the prompt row is taken even when turn.start runs while its hook is still busy', async ($, on) => {
    const seen = world(on)
    await start($)
    const turnId = `t${++ids}`
    const pending = prompt($, LONG, 'u-race')
    await $.turn.start({ text: LONG, turnId })
    await pending
    await step($, turnId, 0)
    await $.turn.complete({ turnId, answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' } as never)
    expect(records(seen).find(r => r.kind === 'main')?.promptUuid).toBe('u-race')
  })

  test('after /clear the new file starts with a session record', async ($, on) => {
    let sid = 'sess-r'
    const seen = world(on, { sessionId: () => sid })
    await start($)
    await mainTurn($, LONG, {})
    await $.session.end({ reason: 'clear', sessionId: 'sess-r', resume: { id: 'sess-r' } } as never)
    sid = 'sess-s'
    await mainTurn($, LONG, {})
    const file = [...seen.files.entries()].find(([p]) => p.endsWith('/sess-s.jsonl'))![1]
    const kinds = file.trim().split('\n').map(l => (JSON.parse(l) as { kind: string }).kind)
    expect(kinds).toEqual(['session', 'main'])
  })

  test('a manual /effort while the router is off is not a signal', async ($, on) => {
    const seen = world(on)
    await start($)
    await run($, 'off')
    await command($, 'effort', 'max')
    expect(records(seen).filter(r => r.kind === 'signal')).toHaveLength(0)
  })

  test('/qr stats finds a session file kept in the previous month folder', async ($, on) => {
    const seen = world(on)
    // Mid-month, so local midnight stays in this month's folder.
    await seen.clock.set(Date.UTC(2026, 9, 15, 3, 0, 0))
    const now = seen.clock.now()
    const d = new Date(now)
    const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)
    const rec = { v: 1, kind: 'main', at: new Date(now).toISOString(), session: 'old', turn: 't', qr: '0.3.0', tune: null, level: 'high', why: 'auto', bump: false, toolErrors: 0, tokens: null }
    seen.files.set(`${LOG}${prev}/old.jsonl`, `${JSON.stringify(rec)}\n`)
    await start($)
    expect(((await run($, 'stats today')).text ?? '').split('\n')[0]).toBe('stats today: main 1 turns, sub 0, workflow 0')
  })
})
