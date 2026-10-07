import { describe, expect, test } from 'claude-code/testing'

import type { TurnSignals } from '../types'
import {
  LABELS,
  compact,
  compose,
  decide,
  head,
  levelOf,
  limitDown,
  shortDecision,
  tail,
} from '../hooks/main-effort'

const signals = (level: TurnSignals['level'], judged: TurnSignals['judged'], toolErrors = 0): TurnSignals => ({
  level,
  judged,
  steps: 3,
  tools: 4,
  toolErrors,
  durationMs: 30_000,
  request: '前の依頼',
  answerTail: '前の回答',
})

describe('main-effort', () => {
  test('labels map back to the four levels', () => {
    expect(LABELS.map(levelOf)).toEqual(['medium', 'high', 'xhigh', 'max'])
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

  test('a fence without a language and a Python traceback become markers too', () => {
    const text = [
      '動きません',
      '```',
      'x = 1',
      '```',
      'Traceback (most recent call last):',
      '  File "app.py", line 10, in <module>',
      '    main()',
      '  File "app.py", line 6, in main',
      '    run()',
      '  File "lib.py", line 3, in run',
      '    raise ValueError("bad")',
      'ValueError: bad',
    ].join('\n')
    const out = compact(text)
    expect(out).toContain('[code 1 lines]')
    expect(out).toContain('[stack trace: 6 lines]')
    expect(out).not.toContain('app.py')
    expect(out).not.toContain('main()')
    expect(out).toContain('ValueError: bad')
  })

  test('the rubric defines max and a long request keeps its head and tail', () => {
    const out = compose(`${'あ'.repeat(700)}${'い'.repeat(300)}`, null, [])
    expect(out).toContain('max = ')
    expect(out.split('\n').pop()).toBe(`[request chars=1000] ${'あ'.repeat(600)} … ${'い'.repeat(200)}`)
  })

  test('a request that fits is sent whole', () => {
    const text = `${'あ'.repeat(500)}${'い'.repeat(300)}`
    expect(compose(text, null, []).split('\n').pop()).toBe(`[request chars=800] ${text}`)
  })

  test('the previous turn appears as signals', () => {
    const out = compose('次の依頼です、よろしくお願いします', signals('xhigh', 'high', 2), ['high', 'xhigh'])
    expect(out).toContain('[prev] effort=xhigh steps=3 tools=4 tool_errors=2 dur=30s max3=xhigh')
    expect(out).toContain('[prev_request] 前の依頼')
    expect(out).toContain('[prev_answer_tail] 前の回答')
    const unset = compose('次の依頼です、よろしくお願いします', signals(null, null), [])
    expect(unset).toContain('[prev] effort=default steps=3 tools=4 tool_errors=0 dur=30s max3=default')
  })

  test('the answer tail keeps the end of the answer on one line', () => {
    expect(tail(`${'a'.repeat(700)}${'b'.repeat(300)}`)).toBe(`…${'b'.repeat(300)}`)
    expect(tail('短い\n回答')).toBe('短い 回答')
  })

  test('the request head keeps the start, 100 characters unless told', () => {
    const text = `${'a'.repeat(40)}${'b'.repeat(60)}${'c'.repeat(10)}`
    expect(head(text)).toBe(`${'a'.repeat(40)}${'b'.repeat(60)}…`)
    expect(head(text, 40)).toBe(`${'a'.repeat(40)}…`)
    expect(head('あ'.repeat(40), 40)).toBe('あ'.repeat(40))
  })

  test('going down is one level a turn at most', () => {
    expect(limitDown('medium', signals('xhigh', 'xhigh'), 1)).toBe('high')
    expect(limitDown('medium', signals('high', 'high'), 1)).toBe('medium')
    expect(limitDown('max', signals('medium', 'medium'), 1)).toBe('max')
    expect(limitDown('medium', null, 1)).toBe('medium')
  })

  test('with confirm 2, going down waits for a second lower judgment', () => {
    expect(limitDown('medium', signals('xhigh', 'xhigh'), 2)).toBe('xhigh')
    expect(limitDown('medium', signals('xhigh', 'medium'), 2)).toBe('high')
  })

  test('a failed or unmatched judgment keeps the previous level', () => {
    expect(decide(new Error('x'), signals('high', 'high'), 1)).toEqual({ base: 'high', judged: null, why: 'error' })
    expect(decide(undefined, null, 1)).toEqual({ base: null, judged: null, why: 'unsure' })
    expect(decide('nonsense', signals('xhigh', 'xhigh'), 1)).toEqual({ base: 'xhigh', judged: null, why: 'unsure' })
    expect(decide(new Error('x'), null, 1)).toEqual({ base: null, judged: null, why: 'error' })
    expect(decide('medium', signals('xhigh', 'xhigh'), 1)).toEqual({ base: 'high', judged: 'medium', why: 'auto' })
    expect(shortDecision(null)).toEqual({ base: null, judged: null, why: 'short' })
    expect(shortDecision(signals('max', 'medium'))).toEqual({ base: 'max', judged: null, why: 'short' })
  })
})
