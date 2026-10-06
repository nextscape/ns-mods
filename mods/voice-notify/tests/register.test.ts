import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROOT = 'C:/cv'
const MAIN = `${ROOT}/state/summaries/sess-1.json`
const CONFIG = JSON.stringify({
  speech: {
    summarize: true,
    summarizeEvents: ['stop', 'agentstop'],
    summaryModel: 'haiku',
    summaryMinChars: 80,
    summaryMaxChars: 60,
    interimMaxChars: 30,
    interimPrompt: ['途中経過なので{maxChars}文字以内の1文で。'],
    summaryPrompt: ['報告を{maxChars}文字以内で。'],
    summaryTimeoutSec: 15,
    briefMaxSeconds: 30,
  },
})
const LONG = '要約の受け渡しをファイル経由に切り替えました。'.repeat(4)
const USAGE = { input_tokens: 0, output_tokens: 0 }

type Reply = { isAnswered: true; text: string } | { isAnswered: false; reason: 'api-error'; status: number; error: string }
type Agent = { name: string; text: string; mtimeMs: number }

// エンジンは fs のパスを Windows の区切り（\）にして渡してくるので、比べる前に / にそろえる
const key = (p: string) => p.replace(/\\/g, '/')

// engine の下層（$ の各呼び出しは { value } で答える）: fs は Map、モデルは固定の返答、session.id は sess-1、時計は 1,000,000ms で止めておく
function world(on: On, opts: { files?: Record<string, string>; agents?: Agent[]; reply?: Reply; config?: string | null; writeFails?: boolean } = {}) {
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { VOICE_NOTIFY_HOME: ROOT })
  const files = new Map<string, string>(Object.entries(opts.files ?? {}))
  if (opts.config !== null) files.set(`${ROOT}/config.json`, opts.config ?? CONFIG)
  const agents = opts.agents ?? []
  for (const a of agents) files.set(`${ROOT}/state/agents/${a.name}`, a.text)
  const seen = { writes: [] as Array<{ path: string; rec: Record<string, unknown> }>, asks: [] as Array<Record<string, unknown>> }
  on('session.id', async () => ({ value: 'sess-1' }))
  on('fs.read', async ($, e) => {
    const t = files.get(key(e.path))
    if (t === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: t }
  })
  on('fs.write', async ($, e) => {
    if (opts.writeFails) throw new Error('EACCES')
    files.set(key(e.path), e.text)
    seen.writes.push({ path: key(e.path), rec: JSON.parse(e.text) })
    return { value: undefined }
  })
  on('fs.exists', async ($, e) => ({ value: files.has(key(e.path)) }))
  on('fs.list', async ($, e) => {
    if (key(e.path) !== `${ROOT}/state/agents`) throw new Error(`ENOENT ${e.path}`)
    return { value: agents.map(a => ({ name: a.name, kind: 'file' as const, size: a.text.length, mtimeMs: a.mtimeMs, isLink: false })) }
  })
  on('model.complete', async ($, e) => {
    seen.asks.push(e as unknown as Record<string, unknown>)
    return { value: { ...(opts.reply ?? { isAnswered: true, text: '受け渡しを切り替えました。' }), usage: USAGE } } as never
  })
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  return { clock, seen }
}

async function finish($: Engine, o: { answer?: string; durationMs?: number; agentId?: string; aborted?: boolean } = {}) {
  return $.turn.complete({
    turnId: 't1',
    answer: o.answer ?? LONG,
    durationMs: o.durationMs ?? 60_000,
    isAborted: !!o.aborted,
    reason: o.aborted ? 'aborted' : 'answer',
    ...(o.agentId ? { agentId: o.agentId } : {}),
  })
}

describe('voice-notify summary mod', () => {
  test('a long main turn writes pending, then done with the Haiku summary', async ($, on) => {
    const { clock, seen } = world(on)
    const result = await finish($)
    await clock.settle()
    expect(result.text).toBe(LONG)
    expect(seen.writes.map(w => [w.path, w.rec.status])).toEqual([[MAIN, 'pending'], [MAIN, 'done']])
    const id = { len: LONG.length, head: LONG.slice(0, 16) }
    expect(seen.writes[0]?.rec).toEqual({ v: 1, status: 'pending', turnId: 't1', at: 1_000_000, kind: 'final', ...id })
    expect(seen.writes[1]?.rec).toEqual({ v: 1, status: 'done', turnId: 't1', at: 1_000_000, kind: 'final', ...id, text: '受け渡しを切り替えました。', ms: 0 })
    const ask = seen.asks[0] ?? {}
    expect([ask.model, ask.effort, ask.prompt, ask.system]).toEqual(['haiku', 'low', LONG, '報告を60文字以内で。'])
    // 待つ時間は notify だけが決める（mod は締め切りを持たない）
    expect('timeoutMs' in ask).toBe(false)
  })

  test('a subagent writes its own interim file', async ($, on) => {
    const { clock, seen } = world(on)
    await finish($, { agentId: 'a1', answer: 'い'.repeat(40) })
    await clock.settle()
    expect(seen.writes[1]?.path).toBe(`${ROOT}/state/summaries/sess-1__a1.json`)
    expect(seen.writes[1]?.rec.kind).toBe('interim')
    expect(String(seen.asks[0]?.system)).toContain('途中経過なので30文字以内')
  })

  test('a main turn with a running subagent of this session is interim; other sessions and stale records are not counted', async ($, on) => {
    const { clock, seen } = world(on, {
      agents: [
        { name: 'x1', text: 'sess-2\r\n', mtimeMs: 1_000_000 },
        { name: 'x2', text: 'sess-1\r\n', mtimeMs: 1_000_000 - 3_600_001 },
      ],
    })
    await finish($)
    await clock.settle()
    expect(seen.writes[1]?.rec.kind).toBe('final')
  })

  test('a running subagent of this session makes the main turn interim', async ($, on) => {
    const { clock, seen } = world(on, { agents: [{ name: 'x1', text: '\uFEFFsess-1\r\n', mtimeMs: 1_000_000 }] })
    await finish($)
    await clock.settle()
    expect(seen.writes[1]?.rec.kind).toBe('interim')
  })

  test('a brief main turn writes nothing and asks nothing', async ($, on) => {
    const { clock, seen } = world(on)
    await finish($, { durationMs: 10_000 })
    await clock.settle()
    expect(seen.writes).toEqual([])
    expect(seen.asks).toEqual([])
  })

  test('summarize false writes nothing', async ($, on) => {
    const { clock, seen } = world(on, { config: JSON.stringify({ speech: { summarize: false } }) })
    await finish($)
    await clock.settle()
    expect(seen.writes).toEqual([])
  })

  test('muted writes nothing', async ($, on) => {
    const { clock, seen } = world(on, { files: { [`${ROOT}/state/mute`]: '' } })
    await finish($)
    await clock.settle()
    expect(seen.writes).toEqual([])
  })

  test('a failing file write never breaks the turn and asks nothing', async ($, on) => {
    const { clock, seen } = world(on, { writeFails: true })
    const result = await finish($)
    await clock.settle()
    expect(result.text).toBe(LONG)
    expect(seen.asks).toEqual([])
  })

  test('an API error ends in error with its status', async ($, on) => {
    const { clock, seen } = world(on, { reply: { isAnswered: false, reason: 'api-error', status: 429, error: 'rate' } })
    await finish($)
    await clock.settle()
    expect([seen.writes[1]?.rec.status, seen.writes[1]?.rec.reason]).toEqual(['error', 'api-error 429'])
  })

  test('a multi-line reply keeps its first line', async ($, on) => {
    const { clock, seen } = world(on, { reply: { isAnswered: true, text: '要約文：一行目です。\n二行目' } })
    await finish($)
    await clock.settle()
    expect(seen.writes[1]?.rec.text).toBe('一行目です。')
  })

  test('without a readable config.json nothing is written or asked, and the turn still completes', async ($, on) => {
    const { clock, seen } = world(on, { config: null })
    const result = await finish($)
    await clock.settle()
    expect(result.text).toBe(LONG)
    expect(seen.writes).toEqual([])
    expect(seen.asks).toEqual([])
  })
})
