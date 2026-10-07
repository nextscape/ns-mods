import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type Answer = string | undefined | Error

// The two classifications of a spawn run at once, so classify answers by the
// labels it was given, not by the order of its calls: the weight question
// (labels with `heavy`), the kind question (with `chore`) and the main
// level (with `medium`) each take the next answer from their own list.
// `together`: hold every answer until that many questions are pending at
// once, so a spawn whose questions are asked one after the other never ends.
type Answers = { kinds?: Answer[]; weights?: Answer[]; main?: Answer[]; together?: number }

// A spawn whose description starts with `deny` is refused beneath the plugin.
function world(on: On, answers: Answers) {
  mock.store(on)
  mock.clock(on)
  on('fs.write', async () => ({ value: undefined }))
  const queues = { kinds: [...(answers.kinds ?? [])], weights: [...(answers.weights ?? [])], main: [...(answers.main ?? [])] }
  const seen = {
    spawned: [] as Array<string | undefined>,
    efforts: [] as Array<string | number | undefined>,
    inputs: [] as string[],
    asked: [] as Array<{ text: string; labels: readonly string[]; model: string | undefined }>,
    toasts: [] as string[],
    status: [] as Array<string | undefined>,
  }
  const pending: Array<() => void> = []
  on('model.classify', async ($, e) => {
    seen.inputs.push(e.text)
    seen.asked.push({ text: e.text, labels: e.labels, model: e.options?.model })
    const together = answers.together
    if (together !== undefined) {
      await new Promise<void>(resolve => {
        pending.push(resolve)
        if (pending.length >= together) for (const release of pending.splice(0)) release()
      })
    }
    const queue = e.labels.includes('heavy') ? queues.weights : e.labels.includes('chore') ? queues.kinds : e.labels.includes('medium') ? queues.main : []
    const answer = queue.shift()
    if (answer instanceof Error) throw answer
    return { value: answer }
  })
  on('agent.spawn', async ($, e) => {
    if (e.description.startsWith('deny')) return { deny: 'refused' }
    seen.spawned.push(e.model)
    return { model: e.model ?? e.parentModel, agentId: `agent-${seen.spawned.length}` }
  })
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    seen.efforts.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
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
const spawn = ($: Engine, over: Record<string, unknown> = {}) =>
  $.agent.spawn({
    tool_use_id: `tu-${++ids}`,
    prompt: 'hooks フォルダのファイル一覧を作って',
    description: 'list hooks',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
    ...over,
  } as never)

// A child's request arrives at the session effort unless D sets its own.
async function childStep($: Engine, agentId: string, effort: 'medium' | 'xhigh' = 'xhigh') {
  const stream = $.turn.step({ turnId: `c${++ids}`, index: 0, model: 'claude-opus-5-5', effort, messageCount: 1, agentId })
  for await (const _ of stream) void _
  await stream.result
}

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'qr', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

describe('D: Agent-tool subagents', () => {
  test('chore runs on sonnet at medium, light or heavy', async ($, on) => {
    const seen = world(on, { kinds: ['chore', 'chore'], weights: ['light', 'heavy'] })
    await spawn($)
    await childStep($, 'agent-1')
    await spawn($, { description: 'commit' })
    await childStep($, 'agent-2')
    expect(seen.spawned).toEqual(['sonnet', 'sonnet'])
    expect(seen.efforts).toEqual(['medium', 'medium'])
    expect((await run($, 'log sub')).text).toContain('chore/light/auto -> sonnet medium')
  })

  test('the kind and the weight are both asked on haiku, each rubric with its own labels', async ($, on) => {
    const seen = world(on, { kinds: ['chore'], weights: ['light'] })
    await spawn($)
    expect(seen.asked.length).toBe(2)
    const kind = seen.asked.find(a => a.labels.includes('chore'))
    const weight = seen.asked.find(a => a.labels.includes('heavy'))
    expect(kind?.text.startsWith('[rubric] Judge which kind of work')).toBe(true)
    expect(weight?.text.startsWith('[rubric] Judge how heavy')).toBe(true)
    expect(kind?.labels).toEqual(['chore', 'impl', 'investigate', 'verify', 'review', 'refute', 'decide'])
    expect(weight?.labels).toEqual(['light', 'heavy'])
    expect(seen.asked.map(a => a.model)).toEqual(['haiku', 'haiku'])
  })

  test('the kind and the weight are asked at the same time', async ($, on) => {
    const seen = world(on, { kinds: ['chore'], weights: ['light'], together: 2 })
    await spawn($)
    expect(seen.asked.length).toBe(2)
    expect(seen.spawned).toEqual(['sonnet'])
  })

  test('light impl runs on sonnet at high; heavy impl inherits the model at high', async ($, on) => {
    const seen = world(on, { kinds: ['impl', 'impl'], weights: ['light', 'heavy'] })
    await spawn($, { description: 'rename function' })
    await childStep($, 'agent-1')
    await spawn($, { description: 'implement parser' })
    await childStep($, 'agent-2')
    expect(seen.spawned).toEqual(['sonnet', undefined])
    expect(seen.efforts).toEqual(['high', 'high'])
  })

  test('heavy review runs on the top model at xhigh, following the top setting', async ($, on) => {
    const seen = world(on, { kinds: ['review', 'review'], weights: ['heavy', 'heavy'] })
    await spawn($, { description: 'review diff' })
    await childStep($, 'agent-1')
    await run($, 'top fable')
    await spawn($, { description: 'review design' })
    expect(seen.spawned).toEqual(['opus', 'claude-fable-5-1'])
    expect(seen.efforts).toEqual(['xhigh'])
  })

  test('light verify runs on sonnet at high; light review on the top model at high', async ($, on) => {
    const seen = world(on, { kinds: ['verify', 'review'], weights: ['light', 'light'] })
    await spawn($, { description: 'run tests' })
    await childStep($, 'agent-1')
    await spawn($, { description: 'review small diff' })
    await childStep($, 'agent-2')
    expect(seen.spawned).toEqual(['sonnet', 'opus'])
    expect(seen.efforts).toEqual(['high', 'high'])
  })

  test('a kind judged with no weight counts as heavy', async ($, on) => {
    const seen = world(on, { kinds: ['investigate'], weights: ['nonsense'] })
    await spawn($, { description: 'investigate failing test' })
    await childStep($, 'agent-1', 'medium')
    expect(seen.spawned).toEqual([undefined])
    expect(seen.efforts).toEqual(['xhigh'])
    expect((await run($, 'log sub')).text).toContain('investigate/heavy/auto -> claude-opus-5-5 xhigh')
  })

  test('a failed weight judgment also counts as heavy', async ($, on) => {
    const seen = world(on, { kinds: ['decide'], weights: [new Error('classifier down')] })
    await spawn($, { description: 'merge decision' })
    await childStep($, 'agent-1')
    expect(seen.spawned).toEqual(['opus'])
    expect(seen.efforts).toEqual(['xhigh'])
  })

  test('an unsure kind leaves the child alone, whatever the weight', async ($, on) => {
    const seen = world(on, { kinds: ['nonsense'], weights: ['light'] })
    await spawn($)
    await childStep($, 'agent-1')
    expect(seen.spawned).toEqual([undefined])
    expect(seen.efforts).toEqual(['xhigh'])
    expect((await run($, 'log sub')).text).toContain('unsure/unsure -> claude-opus-5-5 -')
  })

  test('explicit models, forks and custom agents are not classified', async ($, on) => {
    const seen = world(on, {})
    await spawn($, { model: 'haiku' })
    await spawn($, { fork: true })
    await spawn($, { subagentType: 'my-custom-agent' })
    expect(seen.inputs.length).toBe(0)
    expect(seen.spawned).toEqual(['haiku', undefined, undefined])
  })

  test('a retry of the same task climbs one rung; the third start is flagged', async ($, on) => {
    const seen = world(on, { kinds: ['chore'], weights: ['light'] })
    await spawn($)
    await spawn($, { description: '  list hooks ' })
    expect(seen.toasts).toEqual([])
    await childStep($, 'agent-2')
    await spawn($)
    expect(seen.inputs.length).toBe(2)
    expect(seen.spawned).toEqual(['sonnet', 'opus', 'opus'])
    expect(seen.efforts).toEqual(['high'])
    expect(seen.toasts).toContain('同じ作業のやり直しが3回目です: list hooks')
    expect((await run($, 'log sub')).text).toContain('retry/retry -> opus high')
  })

  test('a heavy review child runs at max while the main level is max', async ($, on) => {
    const seen = world(on, { main: ['max'], kinds: ['review'], weights: ['heavy'] })
    await $.turn.start({ text: 'この設計判断は後戻りできません。最も深いレベルで分析してください', turnId: 'm1' })
    const main = $.turn.step({ turnId: 'm1', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 1 })
    for await (const _ of main) void _
    await main.result
    await spawn($, { description: 'review diff' })
    await childStep($, 'agent-1')
    expect(seen.spawned).toEqual(['opus'])
    expect(seen.efforts).toEqual(['max', 'max'])
  })

  test('a retry of a child judged unsure climbs from rung 2 to rung 3', async ($, on) => {
    const seen = world(on, { kinds: ['nonsense'], weights: ['light'] })
    await spawn($)
    await spawn($)
    await childStep($, 'agent-2', 'medium')
    expect(seen.inputs.length).toBe(2)
    expect(seen.spawned).toEqual([undefined, 'opus'])
    expect(seen.efforts).toEqual(['xhigh'])
  })

  test('a failed kind judgment leaves the child alone', async ($, on) => {
    const seen = world(on, { kinds: [new Error('classifier down')], weights: ['light'] })
    await spawn($)
    await childStep($, 'agent-1', 'medium')
    expect(seen.spawned).toEqual([undefined])
    expect(seen.efforts).toEqual(['medium'])
  })

  test('a refused spawn started nothing: it is neither counted nor a retry', async ($, on) => {
    const seen = world(on, { kinds: ['chore', 'chore'], weights: ['light', 'light'] })
    await spawn($, { description: 'deny list' })
    expect(seen.status.at(-1)).toContain('sub 0')
    await spawn($, { description: 'deny list' })
    // Judged afresh: the refused start left no retry record.
    expect(seen.inputs.length).toBe(4)
  })

  test('a child on a model that takes no effort is sent none', async ($, on) => {
    const seen = world(on, { kinds: ['chore'], weights: ['light'] })
    await spawn($)
    const stream = $.turn.step({ turnId: `c${++ids}`, index: 0, model: 'claude-haiku-4-5', messageCount: 1, agentId: 'agent-1' })
    for await (const _ of stream) void _
    await stream.result
    expect(seen.efforts).toEqual([undefined])
  })

  test('spawns started at once are each logged', async ($, on) => {
    world(on, { kinds: ['chore', 'impl', 'review'], weights: ['light', 'heavy', 'heavy'] })
    await Promise.all([spawn($), spawn($, { description: 'investigate failing test' }), spawn($, { description: 'review diff' })])
    const { text } = await run($, 'log sub')
    expect(text).toContain('sub: 3 spawns logged')
  })

  test('the status line counts the children routed this session', async ($, on) => {
    const seen = world(on, { kinds: ['chore', 'impl'], weights: ['light', 'heavy'] })
    await spawn($)
    await spawn($, { description: 'investigate failing test' })
    expect(seen.status.at(-1)).toContain('sub 2')
  })

  test('off leaves every child alone', async ($, on) => {
    const seen = world(on, { kinds: ['chore'], weights: ['light'] })
    await run($, 'off')
    await spawn($)
    expect(seen.spawned).toEqual([undefined])
  })
})
