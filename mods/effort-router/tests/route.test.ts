import { describe, expect, test } from 'claude-code/testing'

import {
  LABELS,
  asLevel,
  asksOf,
  compact,
  compose,
  decide,
  effortArg,
  escalate,
  fromAsked,
  isNotice,
  isRouted,
  levelOf,
  optionsOf,
  picked,
  plan,
  tail,
} from '../hooks/route'
import type { TurnSignals } from '../types'

const ANSWER = [
  '変更点は次のとおりです。',
  '1. split.ts の修正',
  '2. テストの追加',
  '',
  '次のステップを選んでください。',
  '1. **案2で実装を進める**（3ファイル変更）',
  '2. 設計を見直す',
  '3. `git commit` して終了',
].join('\n')

const signals = (options = optionsOf(ANSWER), asks = true): TurnSignals => ({
  level: 'xhigh',
  steps: 5,
  tools: 8,
  toolErrors: 0,
  durationMs: 60_000,
  request: '設計して',
  answerTail: '…選んでください。',
  options,
  asks,
})

describe('route', () => {
  test('labels map back to levels', () => {
    expect(LABELS.map(levelOf)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(levelOf('nonsense')).toBe(undefined)
    expect(levelOf(undefined)).toBe(undefined)
  })

  test('code blocks and stack traces become markers', () => {
    const text = [
      '起動しない',
      '```ts',
      'const a = 1',
      'const b = 2',
      '```',
      'TypeError: boom',
      '    at f (a.ts:1:1)',
      '    at g (b.ts:2:2)',
      '    at h (c.ts:3:3)',
      'どうすれば？',
    ].join('\n')
    const out = compact(text)
    expect(out).toContain('[code: ts 2 lines]')
    expect(out).toContain('[stack trace: 3 lines]')
    expect(out).not.toContain('a.ts')
  })

  test('a long request keeps its head and tail and states its length', () => {
    const request = `${'あ'.repeat(700)}${'い'.repeat(300)}`
    const out = compose(request, null, [])
    expect(out).toContain('[request chars=1000]')
    expect(out).not.toContain('[choice] ')
    expect(out).not.toContain('[reply] ')
    expect(out).toContain(' … ')
    expect(out.split('\n').pop()!.length).toBeLessThan(900)
  })

  test('the answer tail is bounded', () => {
    expect(tail('x'.repeat(1000)).length).toBe(301)
  })

  test('a turn goes up one level once it runs long or hits errors, never above xhigh', () => {
    expect(escalate('low', 10, 0)).toBe('low')
    expect(escalate('low', 11, 0)).toBe('medium')
    expect(escalate('low', 30, 5)).toBe('medium')
    expect(escalate('medium', 2, 1)).toBe('medium')
    expect(escalate('medium', 2, 2)).toBe('high')
    expect(escalate('xhigh', 30, 5)).toBe('xhigh')
  })

  test('the judgment stands as is; a failed one keeps the previous level', () => {
    expect(decide(new Error('x'), 'high')).toEqual({ level: 'high', judged: null, why: 'error' })
    expect(decide(undefined, null)).toEqual({ level: undefined, judged: null, why: 'unsure' })
    expect(decide(LABELS[0], 'xhigh')).toEqual({ level: 'low', judged: 'low', why: 'auto' })
  })

  test('the session effort reads as one of ours; max reads as xhigh', () => {
    expect(['low', 'medium', 'high', 'xhigh', 'max', undefined].map(asLevel)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'xhigh',
      null,
    ])
  })

  test('routed: Opus and Sonnet from 5.5, Fable and Mythos from 5.1; a task notice is not a request', () => {
    const routed = [
      'claude-opus-5-5',
      'claude-opus-5-5[1m]',
      'anthropic.claude-opus-5-5',
      'claude-opus-6',
      'claude-opus-6-1',
      'claude-sonnet-5-5',
      'claude-fable-5-1',
      'claude-mythos-5-1',
      'claude-fable-6',
    ]
    const notRouted = [
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-sonnet-4-5-20250929',
      'claude-fable-5',
      'claude-haiku-4-5',
      'gpt-6',
    ]
    expect(routed.filter(model => !isRouted(model))).toEqual([])
    expect(notRouted.filter(isRouted)).toEqual([])
    expect(['high', ' XHIGH ', 'max', '', 'auto', 'hgih'].map(effortArg)).toEqual(['high', 'xhigh', 'max', null, null, null])
    expect(isNotice('<task-notification> <task-id>a1</task-id>')).toBe(true)
    expect(isNotice('この通知は何？')).toBe(false)
  })

  test('options come from the last numbered run, cleaned of markdown', () => {
    expect(optionsOf(ANSWER)).toEqual([
      { key: '1', text: '案2で実装を進める（3ファイル変更）' },
      { key: '2', text: '設計を見直す' },
      { key: '3', text: 'git commit して終了' },
    ])
  })

  test('options are read from lettered, circled, full-width and table forms', () => {
    expect(optionsOf('A) 残す\nB) 消す').map(one => one.key)).toEqual(['a', 'b'])
    expect(optionsOf('① 残す\n② 消す').map(one => one.key)).toEqual(['1', '2'])
    expect(optionsOf('１．残す\n２．消す').map(one => one.text)).toEqual(['残す', '消す'])
    expect(optionsOf('| # | 案 |\n|---|---|\n| 1 | 残す |\n| 2 | 消す |')).toEqual([
      { key: '1', text: '残す' },
      { key: '2', text: '消す' },
    ])
    expect(optionsOf('1.5倍に増えました')).toEqual([])
  })

  test('a reply picks offered options however it is phrased', () => {
    const options = optionsOf(ANSWER)
    expect(picked('2', options)?.map(one => one.key)).toEqual(['2'])
    expect(picked('３で', options)?.map(one => one.key)).toEqual(['3'])
    expect(picked('2番でお願いします。', options)?.map(one => one.key)).toEqual(['2'])
    expect(picked('1と3', options)?.map(one => one.key)).toEqual(['1', '3'])
    expect(picked('案1で進めて', options)?.map(one => one.key)).toEqual(['1'])
    expect(picked('②', options)?.map(one => one.key)).toEqual(['2'])
  })

  test('anything else, or a key not offered, is not a pick', () => {
    const options = optionsOf(ANSWER)
    expect(picked('4', options)).toBe(null)
    expect(picked('OK', options)).toBe(null)
    expect(picked('2で、テストも追加して', options)).toBe(null)
    expect(picked('2', [])).toBe(null)
  })

  test('an answer asks when it offers options or ends with a question', () => {
    expect(asksOf('…どちらで進めますか', [])).toBe(true)
    expect(asksOf('…コミットしますか？', [])).toBe(true)
    expect(asksOf('…修正しました。', [])).toBe(false)
    expect(asksOf('…修正しました。', optionsOf(ANSWER))).toBe(true)
  })

  test('plan: a pick, a reply to a question, a bare short prompt, a request', () => {
    expect(plan('3', signals())).toMatchObject({ kind: 'judge', why: 'choice' })
    expect(plan('はい', signals([], true))).toEqual({ kind: 'judge', why: 'reply', selected: [] })
    expect(plan('続けて', signals([], false))).toEqual({ kind: 'keep' })
    expect(plan('続けて', null)).toEqual({ kind: 'keep' })
    expect(plan('この関数の命名だけ確認したいのですが問題ないでしょうか', signals())).toEqual({
      kind: 'judge',
      why: 'auto',
      selected: [],
    })
  })

  test('the classifier reads the picked options', () => {
    const out = compose('3', signals(), ['xhigh'], { why: 'choice', selected: picked('3', optionsOf(ANSWER))! })
    expect(out).toContain('[choice] ')
    expect(out).not.toContain('[reply] ')
    expect(out).toContain('[request chars=1] 3')
    expect(out.split('\n').pop()).toBe('[selected] 3: git commit して終了')
  })

  test('a pick and a reply drop as far as their judgment', () => {
    expect(decide(LABELS[0], 'xhigh', 'choice')).toEqual({ level: 'low', judged: 'low', why: 'choice' })
    expect(decide(LABELS[0], 'xhigh', 'reply')).toEqual({ level: 'low', judged: 'low', why: 'reply' })
  })

  const QUESTIONS = [
    {
      question: '次にどう進めますか？',
      header: '進め方',
      options: [
        { label: '実装する', description: '3ファイルにキャッシュ層を追加する' },
        { label: 'コミットして終了' },
      ],
      multiSelect: false,
    },
    {
      question: '追加する作業は？',
      header: '追加',
      options: [
        { label: 'テスト', description: 'うるう年のケースを1件' },
        { label: 'README', description: '誤字を直す' },
      ],
      multiSelect: true,
    },
  ]

  test('AskUserQuestion picks carry their descriptions', () => {
    const asked = fromAsked({ questions: QUESTIONS, answers: { '次にどう進めますか？': '実装する' } })
    expect(asked).toEqual({
      why: 'choice',
      selected: [{ key: '進め方', text: '実装する — 3ファイルにキャッシュ層を追加する' }],
      request: '進め方: 実装する',
      questions: '次にどう進めますか？ / 追加する作業は？',
      picked: '進め方',
    })
  })

  test('AskUserQuestion multi-select answers split into each option', () => {
    const asked = fromAsked({ questions: QUESTIONS, answers: { '追加する作業は？': 'テスト, README' } })
    expect(asked?.selected.map(one => one.text)).toEqual(['テスト — うるう年のケースを1件', 'README — 誤字を直す'])
    expect(asked?.why).toBe('choice')
  })

  test('AskUserQuestion typed answers make it a reply', () => {
    const other = fromAsked({ questions: QUESTIONS, answers: { '次にどう進めますか？': '原因を先に調べて' } })
    expect(other).toMatchObject({ why: 'reply', selected: [], request: '進め方: 原因を先に調べて' })
    const response = fromAsked({ questions: QUESTIONS, answers: {}, response: 'どちらでもない' })
    expect(response).toMatchObject({ why: 'reply', request: 'どちらでもない', picked: 'text' })
  })

  test('AskUserQuestion with nothing answered is ignored', () => {
    expect(fromAsked({ questions: QUESTIONS, answers: {} })).toBe(null)
    expect(fromAsked({})).toBe(null)
  })
})
