import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { MAIN_CASES, SUB_CASES } from '../hooks/eval-cases'
import { SUB_KINDS } from '../hooks/sub-route'

// classify answers `answer`, or what it returns for the text it reads and the
// labels it was given: a sub case asks its kind (labels with `chore`) and its
// weight (labels with `heavy`) at once, so the answer goes by the labels.
function world(on: On, answer: string | ((text: string, labels: readonly string[]) => string)) {
  mock.store(on)
  mock.clock(on)
  on('fs.write', async () => ({ value: undefined }))
  on('model.classify', async ($, e) => ({ value: typeof answer === 'string' ? answer : answer(e.text, e.labels) }))
  on('ui.status', async () => ({ value: undefined }))
}

// The case a classifier input is about: its request (main) or description (sub).
const mainCase = (text: string) => {
  const request = text.slice(text.indexOf('[request chars='))
  const found = MAIN_CASES.find(c => request.includes(c.request.slice(0, 10)))
  if (!found) throw new Error(`no case for ${request.slice(0, 40)}`)
  return found
}
const subCase = (text: string) => SUB_CASES.find(c => text.includes(`[description] ${c.description}\n`))!
const run = ($: Engine, args: string) =>
  $.command.run({ command: 'qr', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

describe('eval', () => {
  test('the sets are large enough and cover every level, kind and weight', () => {
    expect(MAIN_CASES.length).toBeGreaterThanOrEqual(24)
    expect(new Set(MAIN_CASES.map(c => c.expect))).toEqual(new Set(['medium', 'high', 'xhigh', 'max']))
    expect(SUB_CASES.length).toBe(21)
    for (const kind of SUB_KINDS) {
      expect(SUB_CASES.filter(c => c.expect === kind).length).toBeGreaterThanOrEqual(3)
    }
    expect(new Set(SUB_CASES.map(c => c.weight))).toEqual(new Set(['light', 'heavy']))
    expect(new Set(SUB_CASES.map(c => c.description)).size).toBe(SUB_CASES.length)
  })

  test('eval main scores every case and fails when anything is judged too low', async ($, on) => {
    world(on, 'medium')
    const { text } = await run($, 'eval main')
    expect(text).toMatch(/^eval main: \d+\/24 match, \d+ judged too low/)
    expect(text).toContain('判定: 不合格')
    expect(text).toContain('LOW max-fix-failed-again')
  })

  test('eval main passes when every case matches', async ($, on) => {
    world(on, text => mainCase(text).expect)
    const { text } = await run($, 'eval main')
    expect(text).toContain('eval main: 24/24 match, 0 judged too low')
    expect(text).toContain('判定: 合格')
  })

  test('one case judged too low fails eval main, even above 80% match', async ($, on) => {
    world(on, text => {
      const one = mainCase(text)
      return one.name === 'max-prod-incident' ? 'xhigh' : one.expect
    })
    const { text } = await run($, 'eval main')
    expect(text).toContain('eval main: 23/24 match, 1 judged too low')
    expect(text).toContain('判定: 不合格')
    expect(text).toContain('LOW max-prod-incident: expect max, judged xhigh')
  })

  test('below 80% match fails eval main with nothing too low', async ($, on) => {
    // Every case judged one level up where it can be: none too low, few matches.
    world(on, text => ({ medium: 'high', high: 'xhigh', xhigh: 'max', max: 'max' })[mainCase(text).expect])
    const { text } = await run($, 'eval main')
    expect(text).toMatch(/^eval main: \d+\/24 match, 0 judged too low/)
    expect(text).toContain('判定: 不合格')
  })

  // One level up is never too low, so these move only the match rate.
  test('eval main passes from 80% match: 20 of 24 passes, 19 of 24 does not', async ($, on) => {
    const up = { medium: 'high', high: 'xhigh', xhigh: 'max', max: 'max' } as const
    const missable = MAIN_CASES.filter(c => c.expect !== 'max').map(c => c.name)
    let misses = 4
    world(on, text => {
      const one = mainCase(text)
      return missable.slice(0, misses).includes(one.name) ? up[one.expect] : one.expect
    })
    expect((await run($, 'eval main')).text).toContain('eval main: 20/24 match, 0 judged too low\n判定: 合格')
    misses = 5
    expect((await run($, 'eval main')).text).toContain('eval main: 19/24 match, 0 judged too low\n判定: 不合格')
  })

  // Judging a case as refute, at its own weight, is never weaker than its
  // answer, so these move only the match rate: 17 of 21 passes, 16 does not.
  test('eval sub passes from 80% kind match: 17 of 21 passes, 16 of 21 does not', async ($, on) => {
    const missable = SUB_CASES.filter(c => c.expect !== 'refute').map(c => c.name)
    let misses = 4
    world(on, (text, labels) => {
      const one = subCase(text)
      if (labels.includes('heavy')) return one.weight
      return missable.slice(0, misses).includes(one.name) ? 'refute' : one.expect
    })
    expect((await run($, 'eval sub')).text).toContain('eval sub: 17/21 match, 0 judged too low\n判定: 合格')
    misses = 5
    expect((await run($, 'eval sub')).text).toContain('eval sub: 16/21 match, 0 judged too low\n判定: 不合格')
  })

  test('eval sub counts every case whose assignment comes out weaker', async ($, on) => {
    world(on, (text, labels) => (labels.includes('heavy') ? 'light' : 'chore'))
    const { text } = await run($, 'eval sub')
    // Only the chore cases get what they should: sonnet at medium.
    expect(text).toMatch(/^eval sub: 3\/21 match, 18 judged too low/)
    expect(text).toContain('判定: 不合格')
    expect(text).toContain('LOW review-diff: expect review/heavy, judged chore/light')
    expect(text).toContain('ok  chore-commit: expect chore/light, judged chore/light')
  })

  test('the right kind at too light a weight is too low, and fails eval sub', async ($, on) => {
    world(on, (text, labels) => {
      const one = subCase(text)
      if (labels.includes('heavy')) return one.name === 'decide-audit' ? 'light' : one.weight
      return one.expect
    })
    const { text } = await run($, 'eval sub')
    expect(text).toContain('eval sub: 21/21 match, 1 judged too low')
    expect(text).toContain('判定: 不合格')
    expect(text).toContain('LOW decide-audit: expect decide/heavy, judged decide/light')
  })

  test('one kind judged lighter fails eval sub, even above 80% match', async ($, on) => {
    world(on, (text, labels) => {
      const one = subCase(text)
      if (labels.includes('heavy')) return one.weight
      return one.name === 'impl-auth' ? 'chore' : one.expect
    })
    const { text } = await run($, 'eval sub')
    expect(text).toContain('eval sub: 20/21 match, 1 judged too low')
    expect(text).toContain('判定: 不合格')
    expect(text).toContain('LOW impl-auth: expect impl/heavy, judged chore/heavy')
  })

  test('a weight the judge cannot name counts as heavy, which is never too low', async ($, on) => {
    world(on, (text, labels) => (labels.includes('heavy') ? 'nonsense' : subCase(text).expect))
    const { text } = await run($, 'eval sub')
    expect(text).toContain('eval sub: 21/21 match, 0 judged too low\n判定: 合格')
    expect(text).toContain('ok  chore-list: expect chore/light, judged chore/-')
  })

  test('a kind the judge cannot name is neither a match nor too low, and fails eval sub', async ($, on) => {
    world(on, (text, labels) => (labels.includes('heavy') ? subCase(text).weight : 'nonsense'))
    const { text } = await run($, 'eval sub')
    expect(text).toContain('eval sub: 0/21 match, 0 judged too low')
    expect(text).toContain('判定: 不合格')
    expect(text).toContain('off chore-list: expect chore/light, judged -/light')
  })

  test('eval sub passes when every case matches', async ($, on) => {
    world(on, (text, labels) => (labels.includes('heavy') ? subCase(text).weight : subCase(text).expect))
    const { text } = await run($, 'eval sub')
    expect(text).toContain('eval sub: 21/21 match, 0 judged too low')
    expect(text).toContain('判定: 合格')
  })

  test('a bare eval runs both sets', async ($, on) => {
    world(on, 'medium')
    const { text } = await run($, 'eval')
    expect(text).toMatch(/^eval main: /)
    expect(text).toContain('\n\neval sub: ')
  })
})
