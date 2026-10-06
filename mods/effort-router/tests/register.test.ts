import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { LABELS } from '../hooks/route'

const label = (level: string) => LABELS.find(one => one === level)

// The engine beneath the plugin: classify answers from `answers` in turn
// (an Error throws), the model request records the effort it was sent with,
// and the turn's own events and the status line simply complete.
function world(on: On, answers: Array<string | undefined | Error>) {
  mock.store(on)
  mock.clock(on)
  const seen = {
    sent: [] as Array<string | number | undefined>,
    inputs: [] as string[],
    status: [] as Array<string | undefined>,
  }
  on('model.classify', async ($, e) => {
    seen.inputs.push(e.text)
    const answer = answers.shift()
    if (answer instanceof Error) throw answer
    return { value: answer }
  })
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    seen.sent.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('ui.status', async ($, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  return seen
}

let ids = 0
// One turn of `steps` model requests; `between` runs after the request at
// each index (tool calls arriving mid-turn).
async function turn(
  $: Engine,
  text: string,
  opts: {
    agentId?: string
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | undefined
    answer?: string
    model?: string
    steps?: number
    between?: (index: number) => Promise<unknown>
  } = {},
) {
  const turnId = `t${++ids}`
  await $.turn.start({ text, turnId })
  for (let index = 0; index < (opts.steps ?? 1); index++) {
    const stream = $.turn.step({
      turnId,
      index,
      model: opts.model ?? 'claude-opus-5-5',
      effort: 'effort' in opts ? opts.effort : 'xhigh',
      messageCount: 1,
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
    })
    for await (const _ of stream) void _
    await stream.result
    await opts.between?.(index)
  }
  await $.turn.complete({
    turnId,
    answer: opts.answer ?? '',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })
}

const run = ($: Engine, args: string) =>
  $.command.run({
    command: 'effort-router',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

// The person typing /effort <args>.
const effort = ($: Engine, args: string) =>
  $.command.run({
    command: 'effort',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

const LONG = 'この関数の命名だけ確認したいのですが問題ないでしょうか'

describe('effort-router', () => {
  test('a fresh simple prompt runs at medium', async ($, on) => {
    const { sent } = world(on, [label('medium')])
    await turn($, LONG)
    expect(sent).toEqual(['medium'])
  })

  test('a fresh complex prompt runs at xhigh', async ($, on) => {
    const { sent } = world(on, [label('xhigh')])
    await turn($, LONG)
    expect(sent).toEqual(['xhigh'])
  })

  test('the next judgment reads the previous turn as signals and excerpts', async ($, on) => {
    const seen = world(on, [label('xhigh'), label('xhigh')])
    await turn($, LONG, { answer: '原因は CSS でした。どちらの案で進めますか？' })
    await turn($, '案2の方向で、さっきの設計どおりに実装を進めてください')
    expect(seen.inputs[0]).not.toContain('[prev] effort=')
    expect(seen.inputs[1]).toContain('[prev] effort=xhigh steps=1')
    expect(seen.inputs[1]).toContain('[prev_answer_tail] 原因は CSS でした。どちらの案で進めますか？')
    expect(seen.inputs[1]).toContain('[request chars=')
  })

  test('a lower judgment drops at once; a higher one rises at once', async ($, on) => {
    const { sent } = world(on, [label('xhigh'), label('low'), label('xhigh')])
    await turn($, LONG)
    await turn($, LONG)
    await turn($, LONG)
    expect(sent).toEqual(['xhigh', 'low', 'xhigh'])
  })

  test('a turn past 10 requests goes up one level, once', async ($, on) => {
    const seen = world(on, [label('low')])
    await turn($, LONG, { steps: 25 })
    expect(seen.sent).toEqual([...Array(10).fill('low'), ...Array(15).fill('medium')])
    expect(seen.status).toEqual(['low', 'low → medium (raised after 10 requests)'])
    const { text } = await run($, 'log')
    expect(text).toContain('-> medium (judged low)\tauto raised 1\t25 steps')
  })

  test('a turn with two tool errors goes up one level', async ($, on) => {
    const seen = world(on, [label('medium')])
    on('tool.call', async () => ({ result: { stdout: '', stderr: 'boom', interrupted: false }, isError: true }))
    await turn($, LONG, {
      steps: 4,
      between: async index => {
        if (index < 2) await $.tool.call({ tool: 'Bash', command: 'false' })
      },
    })
    expect(seen.sent).toEqual(['medium', 'medium', 'high', 'high'])
    expect(seen.status.at(-1)).toBe('medium → high (raised after 2 tool errors)')
  })

  test('xhigh has nowhere to go', async ($, on) => {
    const seen = world(on, [label('xhigh')])
    await turn($, LONG, { steps: 15 })
    expect(seen.sent).toEqual(Array(15).fill('xhigh'))
    expect(seen.status).toEqual(['xhigh'])
  })

  test('a task notice keeps the previous level without classifying', async ($, on) => {
    const seen = world(on, [label('high')])
    await turn($, LONG)
    await turn($, '<task-notification> <task-id>a1</task-id> <status>completed</status> </task-notification>')
    expect(seen.inputs.length).toBe(1)
    expect(seen.sent).toEqual(['high', 'high'])
    expect(seen.status.at(-1)).toBe('high (task notice, kept)')
  })

  test('another model keeps its own effort, and is not judged once seen', async ($, on) => {
    const seen = world(on, [label('low')])
    await turn($, LONG, { model: 'claude-opus-5' })
    await turn($, LONG, { model: 'claude-opus-5' })
    expect(seen.sent).toEqual(['xhigh', 'xhigh'])
    expect(seen.inputs.length).toBe(1)
  })

  test('/effort between turns shows at once and runs the next turn as set, then routing resumes', async ($, on) => {
    const seen = world(on, [label('medium'), label('low')])
    on('command.run', { command: 'effort' }, async () => ({ text: '' }))
    await turn($, LONG)
    await effort($, 'high')
    expect(seen.status.at(-1)).toBe('high (set by /effort)')
    await turn($, LONG, { effort: 'high' })
    await turn($, LONG, { effort: 'high' })
    expect(seen.sent).toEqual(['medium', 'high', 'low'])
    expect(seen.inputs.length).toBe(2)
    expect(seen.status.at(-1)).toBe('low')
    const { text } = await run($, 'log')
    expect(text).toContain('medium -> high\tmanual')
  })

  test('/effort from the slider shows the effort once a request carries it', async ($, on) => {
    const seen = world(on, [label('high')])
    on('command.run', { command: 'effort' }, async () => ({ text: '' }))
    await turn($, LONG)
    await effort($, '')
    expect(seen.status.at(-1)).toBe('changed (set by /effort)')
    await turn($, LONG, { effort: 'medium' })
    expect(seen.sent).toEqual(['high', 'medium'])
    expect(seen.status.at(-1)).toBe('medium (set by /effort)')
  })

  test('/effort mid-turn runs the rest of the turn as set, unraised', async ($, on) => {
    const seen = world(on, [label('medium')])
    on('command.run', { command: 'effort' }, async () => ({ text: '' }))
    await turn($, LONG, {
      steps: 14,
      between: async index => {
        if (index === 0) await effort($, 'xhigh')
      },
    })
    expect(seen.sent).toEqual(['medium', ...Array(13).fill('xhigh')])
    expect(seen.status).toEqual(['medium', 'xhigh (set by /effort)'])
  })

  test('a short prompt inherits the previous level without classifying', async ($, on) => {
    const seen = world(on, [label('high')])
    await turn($, LONG)
    await turn($, '続けて')
    expect(seen.inputs.length).toBe(1)
    expect(seen.sent).toEqual(['high', 'high'])
  })

  test('a picked option is judged by its text', async ($, on) => {
    const seen = world(on, [label('xhigh'), label('medium')])
    await turn($, LONG, { answer: '設計しました。\n1. 案2で実装を進める\n2. 設計を見直す\n3. コミットして終了' })
    await turn($, '3で')
    expect(seen.inputs[1]).toContain('[selected] 3: コミットして終了')
    expect(seen.sent).toEqual(['xhigh', 'medium'])
    expect(seen.status.at(-1)).toBe('medium (choice 3)')
  })

  test('a short reply to a question is judged against it', async ($, on) => {
    const seen = world(on, [label('xhigh'), label('low')])
    await turn($, LONG, { answer: 'テストが通りました。コミットしますか？' })
    await turn($, 'はい')
    expect(seen.inputs.length).toBe(2)
    expect(seen.inputs[1]).toContain('[prev_answer_tail] テストが通りました。コミットしますか？')
    expect(seen.sent).toEqual(['xhigh', 'low'])
    expect(seen.status.at(-1)).toBe('low (reply to question)')
  })

  test('a number that was not offered is a plain short prompt', async ($, on) => {
    const seen = world(on, [label('high')])
    await turn($, LONG, { answer: '1. 直す\n2. 残す\n以上で完了です。' })
    await turn($, '5')
    expect(seen.inputs.length).toBe(2)
    expect(seen.inputs[1]!.split('\n').pop()).toBe('[request chars=1] 5')
  })

  test('an AskUserQuestion answer re-judges the rest of the turn', async ($, on) => {
    const seen = world(on, [label('xhigh'), label('medium')])
    on('tool.call', async () => ({
      result: {
        questions: [
          {
            question: '次にどう進めますか？',
            header: '進め方',
            options: [{ label: '実装する' }, { label: 'コミットして終了', description: '差分をコミットするだけ' }],
            multiSelect: false,
          },
        ],
        answers: { '次にどう進めますか？': 'コミットして終了' },
      },
    }))
    const turnId = 'ask-1'
    await $.turn.start({ text: LONG, turnId })
    const step = async (index: number) => {
      const stream = $.turn.step({ turnId, index, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 1 })
      for await (const _ of stream) void _
      await stream.result
    }
    await step(0)
    await $.tool.call({ tool: 'AskUserQuestion', questions: [] })
    await step(1)
    await $.turn.complete({ turnId, answer: '', durationMs: 1000, isAborted: false, reason: 'answer' })
    expect(seen.inputs[1]).toContain('[selected] 進め方: コミットして終了 — 差分をコミットするだけ')
    expect(seen.inputs[1]).toContain('[prev_answer_tail] 次にどう進めますか？')
    expect(seen.sent).toEqual(['xhigh', 'medium'])
    expect(seen.status.at(-1)).toBe('xhigh → medium (asked: 進め方)')
    const { text } = await run($, 'log')
    expect(text).toContain('-> medium')
    expect(text).toContain('asked 進め方')
  })

  test('a short first prompt keeps the session effort', async ($, on) => {
    const { sent } = world(on, [])
    await turn($, '続けて')
    expect(sent).toEqual(['xhigh'])
  })

  test('a first prompt on a model not routed asks nothing and says so', async ($, on) => {
    const seen = world(on, [label('high')])
    on('session.model', async () => ({ value: 'claude-haiku-4-5-20251001' }))
    await turn($, LONG, { model: 'claude-haiku-4-5-20251001' })
    expect(seen.inputs).toEqual([])
    expect(seen.status).toEqual(['not routed (claude-haiku-4-5-20251001)'])
  })

  test('a first prompt on a routed model is judged when the session names it', async ($, on) => {
    const { sent } = world(on, [label('high')])
    on('session.model', async () => ({ value: 'claude-opus-5-5' }))
    await turn($, LONG)
    expect(sent).toEqual(['high'])
  })

  test('a failed or unmatched judgment inherits the previous level', async ($, on) => {
    const { sent } = world(on, [label('medium'), new Error('api down'), 'nonsense'])
    await turn($, LONG)
    await turn($, LONG)
    await turn($, LONG)
    expect(sent).toEqual(['medium', 'medium', 'medium'])
  })

  test('subagent steps are left alone', async ($, on) => {
    const { sent } = world(on, [label('medium')])
    await turn($, LONG, { agentId: 'agent-1' })
    expect(sent).toEqual(['xhigh'])
  })

  test('a model without effort stays without it', async ($, on) => {
    const { sent } = world(on, [label('medium')])
    await turn($, LONG, { effort: undefined })
    expect(sent).toEqual([undefined])
  })

  test('off leaves effort to /effort; on resumes routing', async ($, on) => {
    const { sent } = world(on, [label('medium')])
    const { text } = await run($, 'off')
    expect(text).toContain('off (/effort applies)')
    await turn($, LONG)
    await run($, 'on')
    await turn($, LONG)
    expect(sent).toEqual(['xhigh', 'medium'])
  })

  test('the status line names the level and why it was kept', async ($, on) => {
    const seen = world(on, [label('xhigh'), new Error('api down')])
    await turn($, '続けて')
    await turn($, LONG)
    await turn($, LONG)
    expect(seen.status).toEqual(['xhigh (session effort, short prompt, kept)', 'xhigh', 'xhigh (error, kept)'])
  })

  test('an unknown argument is refused', async ($, on) => {
    world(on, [])
    const { text } = await run($, 'medium')
    expect(text).toContain('unknown "medium"')
  })

  test('log clear empties the log', async ($, on) => {
    world(on, [label('medium')])
    await turn($, LONG)
    expect((await run($, 'log')).text).toContain('1 turns logged')
    expect((await run($, 'log clear')).text).toBe('log cleared.')
    expect((await run($, 'log')).text).toBe('no turns logged yet.')
  })

  test('log shows each turn as prev -> level with its steps', async ($, on) => {
    world(on, [label('xhigh'), label('medium')])
    await turn($, LONG)
    await turn($, LONG)
    const { text } = await run($, 'log')
    expect(text).toContain('2 turns logged')
    expect(text).toContain('xhigh -> medium\tauto\t1 steps')
  })

  test('eval scores every case and counts judgments that are too low', async ($, on) => {
    world(on, Array.from({ length: 50 }, () => label('medium')))
    const { text } = await run($, 'eval')
    expect(text).toMatch(/^eval: \d+\/31 match, \d+ judged too low/)
    expect(text).toContain('LOW ctx-still-broken')
  })
})
