import { describe, expect, test } from 'claude-code/testing'

import { KINDS, KIND_RULES, kindOf } from '../hooks/kinds'
import { RUNG_STRENGTH, compareStrength, formatStrength, modelClass } from '../hooks/levels'

describe('strength and kinds', () => {
  test('model classes: haiku < sonnet < top, and an omitted model inherits the top tier', () => {
    expect(modelClass('haiku')).toBe(1)
    expect(modelClass('claude-haiku-4-5')).toBe(1)
    expect(modelClass('sonnet')).toBe(2)
    expect(modelClass('claude-sonnet-5-5')).toBe(2)
    expect(modelClass('opus')).toBe(3)
    expect(modelClass('claude-fable-5-1')).toBe(3)
    expect(modelClass(undefined)).toBe(3)
    expect(modelClass('gpt-5')).toBe(null)
  })

  test('the model tier is compared first, then effort', () => {
    expect(compareStrength({ cls: 3, effort: 'low' }, { cls: 2, effort: 'max' })).toBeGreaterThan(0)
    expect(compareStrength({ cls: 2, effort: 'xhigh' }, { cls: 3, effort: 'high' })).toBeLessThan(0)
    expect(compareStrength({ cls: 2, effort: 'high' }, { cls: 2, effort: 'medium' })).toBeGreaterThan(0)
    expect(compareStrength({ cls: 3, effort: 'high' }, { cls: 3, effort: 'high' })).toBe(0)
  })

  test('ladder rungs have fixed strengths and print in Japanese', () => {
    expect(RUNG_STRENGTH).toEqual([
      { cls: 1, effort: 'low' },
      { cls: 2, effort: 'medium' },
      { cls: 3, effort: 'high' },
      { cls: 3, effort: 'xhigh' },
      { cls: 3, effort: 'max' },
    ])
    expect(formatStrength({ cls: 3, effort: 'high' })).toBe('上位・high')
    expect(formatStrength({ cls: 2, effort: 'medium' })).toBe('sonnet・medium')
  })

  test('kinds and their bounds follow the gate table', () => {
    expect(kindOf('review:diff')).toBe('review')
    expect(kindOf('fix:2')).toBe('fix')
    expect(kindOf('light:scan')).toBe(null)
    expect(KIND_RULES.chore).toEqual({ floor: { cls: 1, effort: 'low' }, ceiling: { cls: 2, effort: 'medium' } })
    expect(KIND_RULES.verify.floor).toEqual({ cls: 2, effort: 'high' })
    expect(KIND_RULES.review.floor).toEqual({ cls: 3, effort: 'high' })
    expect(KIND_RULES.impl.ceiling).toBe(undefined)
  })

  test('every kind has its floor, only chore has a ceiling, and every prefix is read', () => {
    expect(KIND_RULES).toEqual({
      chore: { floor: { cls: 1, effort: 'low' }, ceiling: { cls: 2, effort: 'medium' } },
      impl: { floor: { cls: 2, effort: 'medium' } },
      investigate: { floor: { cls: 2, effort: 'medium' } },
      verify: { floor: { cls: 2, effort: 'high' } },
      review: { floor: { cls: 3, effort: 'high' } },
      refute: { floor: { cls: 3, effort: 'high' } },
      decide: { floor: { cls: 3, effort: 'high' } },
      fix: { floor: { cls: 3, effort: 'high' } },
    })
    expect(KINDS).toEqual(['chore', 'impl', 'investigate', 'verify', 'review', 'refute', 'decide', 'fix'])
    for (const k of KINDS) expect(kindOf(`${k}:x`)).toBe(k)
    expect(kindOf('review')).toBe(null)
  })
})
