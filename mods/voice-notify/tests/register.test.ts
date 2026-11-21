import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { USER_CONFIG, ROOT, delay, world } from './world'
import type { World, WorldOptions } from './world'

// Longer than summaryMinChars (80).
const LONG = '要約の受け渡しをやめて、同じ処理の中で待つようにしました。テストも通っています。'.repeat(3)

// A background build, and the notice its end wakes the session with.
const BUILD = { id: 'b1', type: 'shell', status: 'running', description: 'npm run build' }
const NOTICE = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>'

// One wav in every phrase folder.
function phrases(): Record<string, string> {
  const names = [
    'stop/done', 'stop/ask', 'stop/trouble', 'stop/solo', 'stop/interim', 'stop/brief/done', 'stop/brief/ask',
    'stop/brief/trouble', 'stop/brief/interim', 'failure', 'permission', 'idle', 'notification', 'task', 'agent/_default',
  ]
  const out: Record<string, string> = {}
  for (const sp of ['metan', 'zundamon']) for (const n of names) out[`${ROOT}/phrases/${sp}/${n}/01.wav`] = 'w'
  return out
}

function setup(on: On, opts: WorldOptions = {}): World {
  return world(on, { ...opts, files: { ...phrases(), ...(opts.files ?? {}) } })
}

// Runs the speech the hooks leave in the background (they return at once) to its end.
async function settle(w: World) {
  for (let i = 0; i < 10; i++) await w.clock.settle()
}

let turns = 0
type TurnOptions = {
  answer?: string
  durationMs?: number
  agentId?: string
  reason?: 'answer' | 'aborted' | 'error'
  text?: string
  // Where the turn's prompt came from (prompt.submit's origin.kind); the
  // person's own Enter by default.
  origin?: string
  // The tools the turn calls (1 by default), and what its Stop says is in
  // flight; stop: 'after' sends the Stop after the turn's end, 'none' none.
  tools?: string[]
  background?: Array<{ id: string; type: string; status: string; description: string }>
  crons?: Array<{ id: string; schedule: string; recurring: boolean; prompt: string }>
  stop?: 'before' | 'after' | 'none'
}

async function turn($: Engine, o: TurnOptions = {}) {
  const turnId = `t${++turns}`
  // A subagent's run raises no turn.start, and its stop is no classic Stop.
  const main = !o.agentId
  const text = o.text ?? 'お願いします'
  if (main) await $.prompt.submit({ text, wait: false, origin: { kind: o.origin ?? 'composer' } } as never)
  if (main) await $.turn.start({ text, turnId })
  if (main) for (const tool of o.tools ?? ['Read']) await $.tool.call({ tool, input: {} } as never)
  const stop = () => $.classic.Stop({ stop_hook_active: false, background_tasks: o.background ?? [], session_crons: o.crons ?? [] } as never)
  const when = main ? (o.stop ?? 'before') : 'none'
  if (when === 'before') await stop()
  await $.turn.complete({
    turnId,
    answer: o.answer ?? LONG,
    durationMs: o.durationMs ?? 60_000,
    isAborted: o.reason === 'aborted',
    reason: o.reason ?? 'answer',
    ...(o.agentId ? { agentId: o.agentId } : {}),
  } as never)
  if (when === 'after') await stop()
}

const log = (w: World) => w.files.get(`${ROOT}/notify.log`) ?? ''
const spoke = (w: World) => w.played.map(p => p.replace(`${ROOT}/`, '').replace(/\/01\.wav$/, ''))

describe('voice-notify', () => {
  test('a long main turn plays the case phrase, then the Haiku summary', async ($, on) => {
    const w = setup(on)
    await turn($)
    await settle(w)
    expect(spoke(w)[0]).toBe('phrases/metan/stop/done')
    expect(spoke(w)[1]).toMatch(/^cache\/[0-9a-f]{16}\.wav$/)
    expect(w.asks[0]).toMatchObject({ model: 'haiku', effort: 'low', prompt: LONG, maxTokens: 300, timeoutMs: 15_000 })
    expect(log(w)).toMatch(/INFO stop +読み上げ: 要約しました。/)
    // The synthesis query goes on stdin, with the lead silence added.
    const at = w.runs.findIndex(a => a[0] === 'curl.exe')
    expect(w.runs[at]).toContain('@-')
    expect(JSON.parse(w.inputs[at]!)).toMatchObject({ prePhonemeLength: 0.7, speedScale: 1.3 })
  })

  test('a short main turn plays only the brief phrase and asks nothing', async ($, on) => {
    const w = setup(on)
    await turn($, { durationMs: 10_000 })
    await settle(w)
    expect(spoke(w)).toEqual(['phrases/metan/stop/brief/done'])
    expect(w.asks).toEqual([])
  })

  test('muted and aborted turns stay silent', async ($, on) => {
    const w = setup(on, { files: { [`${ROOT}/state/mute`]: 'x' } })
    await turn($)
    await settle(w)
    w.files.delete(`${ROOT}/state/mute`)
    await turn($, { reason: 'aborted' })
    await settle(w)
    expect(w.played).toEqual([])
    expect(log(w)).toMatch(/無音化: 手動ミュート/)
  })

  test('a refused turn plays the failure phrase, not done', async ($, on) => {
    const w = setup(on)
    await turn($, { reason: 'refusal' as never, answer: '' })
    await settle(w)
    expect(spoke(w)).toEqual(['phrases/metan/failure'])
  })

  test('a summary call that throws falls back to the first sentences, with a warning', async ($, on) => {
    const w = setup(on, { modelThrows: true })
    await turn($)
    await settle(w)
    expect(spoke(w)[0]).toBe('phrases/metan/stop/done')
    expect(spoke(w)[1]).toMatch(/^cache\//)
    expect(log(w)).toMatch(/WARN stop +要約失敗、1文目を読む: /)
    expect(log(w)).toMatch(/INFO stop +読み上げ: 要約の受け渡しをやめて/)
  })

  test('a very long answer is sent to Haiku as its head and tail only', async ($, on) => {
    const w = setup(on)
    const answer = `冒頭の報告です。${'あ'.repeat(20_000)}末尾の結論です。`
    await turn($, { answer })
    await settle(w)
    const prompt = String(w.asks[0]!.prompt)
    expect(prompt.length).toBeLessThan(5_000)
    expect(prompt.startsWith('冒頭の報告です。')).toBe(true)
    expect(prompt.endsWith('末尾の結論です。')).toBe(true)
  })

  test('the same text synthesized twice at once is played twice, each from its own part file', async ($, on) => {
    const outs: string[] = []
    const w = setup(on, {
      run: argv => {
        if (/^curl/.test(argv[0]!) && argv[1] !== '--version') outs.push(argv[argv.indexOf('-o') + 1]!)
        return undefined
      },
    })
    await Promise.all([
      $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never),
      $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never),
    ])
    await settle(w)
    expect(outs).toHaveLength(2)
    expect(new Set(outs).size).toBe(2)
    expect(log(w)).not.toMatch(/合成失敗/)
    expect(spoke(w).filter(p => p.startsWith('cache/'))).toHaveLength(2)
  })

  test('a synthesis cut short leaves no wav behind, so the next one is made afresh', async ($, on) => {
    let cut = true
    const w = setup(on, {
      run: argv => {
        if (!/^curl/.test(argv[0]!) || argv[1] === '--version' || !cut) return undefined
        cut = false
        w.files.set(argv[argv.indexOf('-o') + 1]!.replace(/\\/g, '/'), 'RIFF-half')
        return { exitCode: 28, stderr: 'Operation timed out' }
      },
    })
    await turn($)
    await settle(w)
    expect([...w.files.keys()].filter(k => /.wav(.part)?$/.test(k) && k.includes('/cache/'))).toEqual([])
    await turn($)
    await settle(w)
    const cached = [...w.files.entries()].filter(([k]) => k.includes('/cache/') && k.endsWith('.wav'))
    expect(cached.map(([, v]) => v)).toEqual(['RIFF-fake-wav'])
  })

  test('a failure before anything plays is still logged', async ($, on) => {
    const w = setup(on, { existsFails: true })
    await $.classic.TaskCompleted({ task_id: '1', task_subject: 's' } as never)
    await settle(w)
    expect(log(w)).toMatch(/ERR  task +.*fs\.exists/)
  })

  test('with the engine down, a subagent report plays the fallback phrase and asks Haiku nothing', async ($, on) => {
    const w = setup(on, { engine: false, agents: [{ id: 'a1', description: '調査', type: 'Explore', status: 'completed' }] })
    await turn($, { agentId: 'a1' })
    await settle(w)
    expect(spoke(w)).toEqual(['phrases/zundamon/agent/_default'])
    expect(w.asks).toEqual([])
  })

  test('an API error plays the failure phrase', async ($, on) => {
    const w = setup(on)
    await turn($, { reason: 'error', answer: '' })
    await settle(w)
    expect(spoke(w)).toEqual(['phrases/metan/failure'])
  })

  test('a main turn with subagents running is an interim report in the interim voice', async ($, on) => {
    const w = setup(on, { agents: [{ id: 'a1', description: '調査', type: 'Explore', status: 'running' }] })
    await turn($)
    await settle(w)
    expect(spoke(w)[0]).toBe('phrases/zundamon/stop/interim')
    expect(log(w)).toMatch(/中間・実行中1件 \[zundamon\]/)
  })

  test('a subagent held on its own background work (waiting) still makes the turn interim', async ($, on) => {
    const w = setup(on, { agents: [{ id: 'a1', description: '調査', type: 'Explore', status: 'waiting' }] })
    await turn($)
    await settle(w)
    expect(spoke(w)[0]).toBe('phrases/zundamon/stop/interim')
  })

  test('a main turn that stops with a background shell still running is interim, never done', async ($, on) => {
    const w = setup(on)
    await turn($, { background: [{ id: 'b1', type: 'shell', status: 'running', description: 'npm test' }] })
    await settle(w)
    expect(spoke(w)[0]).toBe('phrases/zundamon/stop/interim')
    expect(log(w)).toMatch(/中間・実行中0件・裏の作業1件 \[zundamon\]/)
  })

  test('a one-shot wakeup counts as work in flight; a recurring one does not', async ($, on) => {
    const w = setup(on)
    await turn($, { crons: [{ id: 'c1', schedule: '5 4 * * *', recurring: false, prompt: '続き' }] })
    await settle(w)
    await turn($, { crons: [{ id: 'c2', schedule: '*/5 * * * *', recurring: true, prompt: '/loop' }] })
    await settle(w)
    expect(spoke(w).filter(p => p.startsWith('phrases/'))).toEqual(['phrases/zundamon/stop/interim', 'phrases/metan/stop/done'])
  })

  test('a Stop that comes after the turn end is still waited for', async ($, on) => {
    const w = setup(on)
    await turn($, { stop: 'after', background: [{ id: 'b1', type: 'monitor', status: 'running', description: 'watch' }] })
    await settle(w)
    expect(spoke(w)[0]).toBe('phrases/zundamon/stop/interim')
  })

  test('with no Stop at all, the turn end speaks after a short wait', async ($, on) => {
    const w = setup(on)
    await turn($, { stop: 'none' })
    await settle(w)
    await w.clock.advance(1_000)
    await settle(w)
    expect(spoke(w)[0]).toBe('phrases/metan/stop/done')
  })

  test('a short reply that called no tool is silent; a short question still asks', async ($, on) => {
    const w = setup(on)
    await turn($, { durationMs: 5_000, tools: [] })
    await settle(w)
    expect(w.played).toEqual([])
    expect(log(w)).toMatch(/道具 0回 .*\n.*道具を使わない短い返事のため無音/)
    await turn($, { durationMs: 5_000, tools: [], answer: 'どちらで進めますか？' })
    await settle(w)
    expect(spoke(w)).toEqual(['phrases/metan/stop/brief/ask'])
  })

  test('a dead engine plays the solo phrase', async ($, on) => {
    const w = setup(on, { engine: false })
    await turn($)
    await settle(w)
    expect(spoke(w)).toEqual(['phrases/metan/stop/solo'])
  })

  test('with the engine down, a short reply that called no tool is silent all the same', async ($, on) => {
    const w = setup(on, { engine: false })
    await turn($, { durationMs: 5_000, tools: [] })
    await settle(w)
    expect(w.played).toEqual([])
    expect(log(w)).toMatch(/道具を使わない短い返事のため無音/)
  })

  test('the end of background work is said even when the turn that reports it calls no tool', async ($, on) => {
    const w = setup(on)
    await turn($, { background: [BUILD] })
    await settle(w)
    // The build ends and wakes the session: a short answer, no tool.
    await turn($, { durationMs: 5_000, tools: [], answer: 'ビルドが完了しました。', text: NOTICE, origin: 'task-notification' })
    await settle(w)
    expect(spoke(w).filter(p => p.startsWith('phrases/'))).toEqual(['phrases/zundamon/stop/interim', 'phrases/metan/stop/brief/done'])
    expect(log(w)).toMatch(/最終・終わった裏の作業1件 \[metan\]/)
  })

  test('a reply typed while the background work still runs stays silent', async ($, on) => {
    const w = setup(on)
    await turn($, { background: [BUILD] })
    await settle(w)
    await turn($, { durationMs: 5_000, tools: [], answer: 'はい、終わったらお知らせします。', background: [BUILD] })
    await settle(w)
    expect(spoke(w).filter(p => p.startsWith('phrases/'))).toEqual(['phrases/zundamon/stop/interim'])
  })

  test('work left running since before the next request (a dev server) does not keep later turns interim', async ($, on) => {
    const w = setup(on)
    const dev = [{ id: 'd1', type: 'shell', status: 'running', description: 'npm run dev' }]
    await turn($, { background: dev })
    await settle(w)
    await turn($, { background: dev })
    await settle(w)
    // Work the later turn starts itself is still waited on.
    await turn($, { background: [...dev, BUILD] })
    await settle(w)
    expect(spoke(w).filter(p => p.startsWith('phrases/'))).toEqual([
      'phrases/zundamon/stop/interim', 'phrases/metan/stop/done', 'phrases/zundamon/stop/interim',
    ])
  })

  test('a turn a notice started still waits on what was running before it', async ($, on) => {
    const w = setup(on)
    const lint = { id: 'b2', type: 'shell', status: 'running', description: 'npm run lint' }
    await turn($, { background: [BUILD, lint] })
    await settle(w)
    // The build ended and woke the session; the lint still runs.
    await turn($, { background: [lint], text: NOTICE, origin: 'task-notification' })
    await settle(w)
    expect(spoke(w).filter(p => p.startsWith('phrases/'))).toEqual(['phrases/zundamon/stop/interim', 'phrases/zundamon/stop/interim'])
  })

  test('a notice the engine names no origin for is told by its frame', async ($, on) => {
    const w = setup(on)
    const lint = { id: 'b2', type: 'shell', status: 'running', description: 'npm run lint' }
    await turn($, { background: [BUILD, lint] })
    await settle(w)
    await turn($, { background: [lint], text: NOTICE, origin: 'unclassified' })
    await settle(w)
    expect(spoke(w).filter(p => p.startsWith('phrases/'))[1]).toBe('phrases/zundamon/stop/interim')
  })

  test("a subagent's turn starting inside the main turn does not lose the main turn's record", async ($, on) => {
    const w = setup(on)
    await $.turn.start({ text: 'お願いします', turnId: 'main-1' })
    await $.tool.call({ tool: 'Agent', input: {} } as never)
    await $.turn.start({ text: '調べてください', turnId: 'agent-1', agentId: 'a1' } as never)
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [BUILD], session_crons: [] } as never)
    await $.turn.complete({ turnId: 'main-1', answer: LONG, durationMs: 60_000, isAborted: false, reason: 'answer' } as never)
    await settle(w)
    expect(spoke(w)[0]).toBe('phrases/zundamon/stop/interim')
    expect(log(w)).toMatch(/道具 1回 .*裏の作業1件/)
  })

  test('muted while the phrase plays, the body is not read', async ($, on) => {
    // The summary and the phrase take seconds: the hotkey, or a call joined
    // meanwhile, must still stop what follows.
    const w: World = setup(on, {
      run: argv => {
        if (/stop[\\/]done[\\/]01\.wav$/.test(argv.at(-1) ?? '')) w.files.set(`${ROOT}/state/mute`, 'x')
        return undefined
      },
    })
    await turn($)
    await settle(w)
    expect(spoke(w)).toEqual(['phrases/metan/stop/done'])
    expect(log(w)).toMatch(/INFO stop +無音化: 手動ミュート/)
  })

  test('a summary that fails falls back to the first sentences', async ($, on) => {
    const w = setup(on, { reply: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded' } })
    await turn($)
    await settle(w)
    expect(log(w)).toMatch(/WARN stop +要約失敗、1文目を読む: api-error/)
    expect(log(w)).toMatch(/読み上げ: 要約の受け渡しをやめて、同じ処理の中で待つようにしました。/)
  })

  test('a subagent report reads its description and summary in the interim voice', async ($, on) => {
    const w = setup(on, { agents: [{ id: 'a1', description: '原因の調査', type: 'Explore', status: 'completed' }] })
    await turn($, { agentId: 'a1' })
    await settle(w)
    expect(log(w)).toMatch(/INFO agentstop +読み上げ \[zundamon\]: 原因の調査が完了しました。要約しました。/)
    expect(spoke(w)).toHaveLength(1)
  })

  test('a subagent the engine does not list is ignored; reports within the debounce are not read', async ($, on) => {
    const w = setup(on, { agents: [{ id: 'a1', description: '調査', type: 'Explore', status: 'completed' }] })
    await turn($, { agentId: 'zz' })
    await turn($, { agentId: 'a1' })
    await turn($, { agentId: 'a1' })
    await settle(w)
    expect(log(w)).toMatch(/開始を見ていない停止のため無視 \(id=zz\)/)
    expect(log(w)).toMatch(/連発抑制のため無音/)
    expect(w.played).toHaveLength(1)
    await w.clock.advance(9_000)
    await turn($, { agentId: 'a1' })
    await settle(w)
    expect(w.played).toHaveLength(2)
  })

  test('a permission request says which tool', async ($, on) => {
    const w = setup(on)
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } } as never)
    await settle(w)
    expect(spoke(w)[0]).toBe('phrases/metan/permission')
    expect(log(w)).toMatch(/コマンド実行の許可待ちです。/)
  })

  test('idle is silent while a subagent runs or the main loop works; other notices play their phrase', async ($, on) => {
    const w = setup(on, { agents: [{ id: 'a1', description: '調査', type: 'Explore', status: 'running' }] })
    await $.classic.Notification({ message: 'waiting', notification_type: 'idle_prompt' } as never)
    await settle(w)
    w.agents.length = 0
    await $.turn.start({ text: 'x', turnId: 'busy' })
    await $.classic.Notification({ message: 'waiting', notification_type: 'idle_prompt' } as never)
    await settle(w)
    await $.turn.complete({ turnId: 'busy', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' } as never)
    await $.classic.Notification({ message: 'waiting', notification_type: 'idle_prompt' } as never)
    await $.classic.Notification({ message: 'x', notification_type: 'agent_needs_input' } as never)
    await $.classic.Notification({ message: 'x', notification_type: 'permission_prompt' } as never)
    await $.classic.TaskCompleted({ task_id: '1', task_subject: 's' } as never)
    await settle(w)
    expect(spoke(w)).toEqual(['phrases/metan/idle', 'phrases/metan/permission', 'phrases/metan/task'])
    expect(log(w)).toMatch(/サブエージェント実行中 \(1件\) のため無音/)
    expect(log(w)).toMatch(/メインが作業中のため無音/)
  })

  test('a task completed while a turn is working is silent; one completed between turns plays', async ($, on) => {
    const w = setup(on)
    await $.turn.start({ text: 'x', turnId: 'busy-task' })
    await $.classic.TaskCompleted({ task_id: '1', task_subject: 's' } as never)
    await settle(w)
    expect(w.played).toEqual([])
    expect(log(w)).toMatch(/INFO task +メインが作業中のため無音/)
    await $.turn.complete({ turnId: 'busy-task', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' } as never)
    await $.classic.TaskCompleted({ task_id: '2', task_subject: 's' } as never)
    await settle(w)
    expect(spoke(w)).toEqual(['phrases/metan/task'])
  })

  test('a broken config.json says so once and plays nothing', async ($, on) => {
    const w = setup(on, { config: '{"speaker":' })
    await turn($)
    await settle(w)
    await turn($)
    await settle(w)
    expect(w.played).toEqual([])
    expect(log(w).match(/config\.json を読めない/g)).toHaveLength(1)
  })

  test('keys missing from config.json fall back to the shipped defaults', async ($, on) => {
    // A config.json from 0.2.0 has no notification.toolLabels, for one.
    const w = setup(on, { config: { speaker: 'metan', speakers: { metan: { id: 2 } } } })
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never)
    await settle(w)
    expect(log(w)).toMatch(/コマンド実行の許可待ちです。/)
  })

  test('a config.json that is not an object (null) says so once and plays nothing', async ($, on) => {
    const w = setup(on, { config: 'null' })
    await turn($)
    await settle(w)
    expect(w.played).toEqual([])
    expect(log(w)).toMatch(/config\.json を読めないので鳴らさない: .*オブジェクト/)
  })

  test('a missing config.json is copied from the default and used', async ($, on) => {
    const w = setup(on, { config: null })
    await turn($, { durationMs: 10_000 })
    await settle(w)
    expect(w.files.has(`${ROOT}/config.json`)).toBe(true)
    expect(spoke(w)).toEqual(['phrases/metan/stop/brief/done'])
  })

  test('VOICE_NOTIFY_SUPPRESS=1 silences everything', async ($, on) => {
    const w = setup(on, { env: { VOICE_NOTIFY_SUPPRESS: '1' } })
    await turn($)
    await settle(w)
    expect(w.played).toEqual([])
  })

  test('a cache hit plays without synthesizing again', async ($, on) => {
    const w = setup(on)
    await turn($)
    await settle(w)
    await turn($)
    await settle(w)
    expect(w.fetches.filter(f => f.url.includes('/audio_query'))).toHaveLength(1)
    expect(spoke(w).filter(p => p.startsWith('cache/'))).toHaveLength(2)
  })

  test('clips never overlap when a turn, a report and a permission request arrive together', async ($, on) => {
    const w = setup(on, { playMs: 30, agents: [{ id: 'a1', description: '調査', type: 'Explore', status: 'completed' }] })
    await Promise.all([
      turn($),
      turn($, { agentId: 'a1' }),
      $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} } as never),
    ])
    for (let i = 0; i < 20; i++) {
      await delay(20)
      await settle(w)
    }
    // The main turn's phrase and body, the report, the permission phrase and body.
    expect(w.played).toHaveLength(5)
    expect(w.maxPlaying).toBe(1)
  })

  test('an engine that answers but fails to synthesize is logged as a synthesis failure, not as unreachable', async ($, on) => {
    const w = setup(on, { run: a => (a[0] === 'curl.exe' ? { exitCode: 22, stderr: 'HTTP 500' } : undefined) })
    await turn($)
    await settle(w)
    expect(log(w)).toMatch(/ERR  stop +合成失敗: synthesis: curl 22 HTTP 500/)
    expect(log(w)).not.toMatch(/接続できない/)
  })

  test('lines that arrive together are written to notify.log in one go, in order', async ($, on) => {
    const w = setup(on)
    await turn($, { durationMs: 10_000 })
    await settle(w)
    const lines = log(w).trimEnd().split('\n').map(l => l.slice(21))
    expect(lines[0]).toMatch(/^INFO stop +発火$/)
    expect(lines[1]).toMatch(/^INFO stop +本文 \d+字 \/ 作業 10\.0秒 \/ 道具 1回 \/ ケース done \(brief\) \/ 最終 \[metan\]$/)
  })

  test('on Linux it plays through play.sh with the player it finds; with none, it logs once', async ($, on) => {
    const w = setup(on, { os: 'linux', linuxPlayers: ['paplay'] })
    await turn($, { durationMs: 10_000 })
    await settle(w)
    const sh = w.runs.find(a => a[0] === 'sh' && a[1]?.endsWith('/scripts/posix/play.sh'))!
    expect(sh.slice(2, 4)).toEqual([`${ROOT}/state/playback.lock`, 'paplay'])
  })

  test('a home with Japanese and spaces: the folder is made before curl writes, without --create-dirs', async ($, on) => {
    // Windows' own curl cannot make a non-ASCII folder with --create-dirs (exit 23, seen).
    const home = 'C:/ホーム/山田 太郎/voice-notify'
    const files: Record<string, string> = { [`${home}/config.json`]: JSON.stringify(USER_CONFIG) }
    for (const [k, v] of Object.entries(phrases())) files[k.replace(ROOT, home)] = v
    const w = world(on, { config: null, env: { VOICE_NOTIFY_HOME: home }, files })
    await turn($)
    await settle(w)
    const curl = w.runs.find(a => a[0] === 'curl.exe')!
    expect(curl).not.toContain('--create-dirs')
    expect(curl[curl.indexOf('-o') + 1]).toMatch(new RegExp(`^${home}/cache/[0-9a-f]{16}\.wav\.[0-9a-z]+\.part$`))
    expect(w.files.has(`${home}/cache/.keep`)).toBe(true)
    expect(w.played.some(p => p.startsWith(`${home}/cache/`))).toBe(true)
  })

  test('on Linux a player installed later is found without reopening the session', async ($, on) => {
    const players: string[] = []
    const w = setup(on, { os: 'linux', linuxPlayers: players })
    await turn($, { durationMs: 10_000 })
    await settle(w)
    expect(w.played).toEqual([])
    players.push('paplay')
    await turn($, { durationMs: 10_000 })
    await settle(w)
    expect(w.played).toHaveLength(1)
  })

  test('a curl that cannot start is logged as a synthesis failure, after the phrase', async ($, on) => {
    const w = setup(on, { missing: ['curl.exe'] })
    await turn($)
    await settle(w)
    expect(spoke(w)).toEqual(['phrases/metan/stop/done'])
    expect(log(w)).toMatch(/ERR  stop +合成失敗: synthesis: curl -1 /)
  })

  test('on Linux with no player it plays nothing and says so once', async ($, on) => {
    const w = setup(on, { os: 'linux', linuxPlayers: [] })
    await turn($, { durationMs: 10_000 })
    await settle(w)
    await turn($, { durationMs: 10_000 })
    await settle(w)
    expect(w.played).toEqual([])
    expect(log(w).match(/再生コマンドが見つからない/g)).toHaveLength(1)
  })
})
