import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEFAULT_CONFIG, ROOT, world } from './world'
import type { World, WorldOptions } from './world'

// summaryMinChars（80）を超える長さにする
const LONG = '要約の受け渡しをやめて、同じ処理の中で待つようにしました。テストも通っています。'.repeat(3)

// どのフレーズにも wav を1つずつ置く
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

// 裏で流れる読み上げ（hook は待たずに返す）を最後まで進める
async function settle(w: World) {
  for (let i = 0; i < 10; i++) await w.clock.settle()
}

let turns = 0
async function turn($: Engine, o: { answer?: string; durationMs?: number; agentId?: string; reason?: 'answer' | 'aborted' | 'error'; text?: string } = {}) {
  const turnId = `t${++turns}`
  await $.turn.start({ text: o.text ?? 'お願いします', turnId })
  await $.turn.complete({
    turnId,
    answer: o.answer ?? LONG,
    durationMs: o.durationMs ?? 60_000,
    isAborted: o.reason === 'aborted',
    reason: o.reason ?? 'answer',
    ...(o.agentId ? { agentId: o.agentId } : {}),
  } as never)
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
    // 合成のクエリは stdin で渡し、先頭の無音を足してある
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

  test('a summary call that throws while the phrase plays is logged, not left unhandled', async ($, on) => {
    const w = setup(on, { modelThrows: true })
    await turn($)
    await settle(w)
    expect(spoke(w)).toEqual(['phrases/metan/stop/done'])
    expect(log(w)).toMatch(/ERR  stop +.*model\.complete/)
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

  test('a dead engine plays the solo phrase', async ($, on) => {
    const w = setup(on, { engine: false })
    await turn($)
    await settle(w)
    expect(spoke(w)).toEqual(['phrases/metan/stop/solo'])
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
    // 0.2.0 からの config.json に、notification.toolLabels が無い場合など
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
      await new Promise(resolve => setTimeout(resolve, 20))
      await settle(w)
    }
    // メインの前置きと本文、報告、許可待ちの前置きと本文
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
    expect(lines[1]).toMatch(/^INFO stop +本文 \d+字 \/ 作業 10\.0秒 \/ ケース done \(brief\) \/ 最終 \[metan\]$/)
  })

  test('on Linux it plays through play.sh with the player it finds; with none, it logs once', async ($, on) => {
    const w = setup(on, { os: 'linux', linuxPlayers: ['paplay'] })
    await turn($, { durationMs: 10_000 })
    await settle(w)
    const sh = w.runs.find(a => a[0] === 'sh' && a[1]?.endsWith('/scripts/posix/play.sh'))!
    expect(sh.slice(2, 4)).toEqual([`${ROOT}/state/playback.lock`, 'paplay'])
  })

  test('a home with Japanese and spaces: the folder is made before curl writes, without --create-dirs', async ($, on) => {
    // Windows 標準の curl は --create-dirs で非 ASCII のフォルダを作れない（exit 23。実測）
    const home = 'C:/ホーム/山田 太郎/voice-notify'
    const files: Record<string, string> = { [`${home}/config.json`]: JSON.stringify(DEFAULT_CONFIG) }
    for (const [k, v] of Object.entries(phrases())) files[k.replace(ROOT, home)] = v
    const w = world(on, { config: null, env: { VOICE_NOTIFY_HOME: home }, files })
    await turn($)
    await settle(w)
    const curl = w.runs.find(a => a[0] === 'curl.exe')!
    expect(curl).not.toContain('--create-dirs')
    expect(curl[curl.indexOf('-o') + 1]).toMatch(new RegExp(`^${home}/cache/[0-9a-f]{16}\.wav$`))
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
