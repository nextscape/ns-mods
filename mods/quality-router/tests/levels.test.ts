import { describe, expect, test } from 'claude-code/testing'

import {
  LEVELS,
  TOP_IDS,
  applyBounds,
  asLevel,
  boundOf,
  down,
  isEffort,
  isLevel,
  isTop,
  isTopFamily,
  ladder,
  maxLevel,
  minLevel,
  rank,
  up,
} from '../hooks/levels'

describe('levels', () => {
  test('the session effort reads as one of our levels', () => {
    expect(asLevel('low')).toBe('medium')
    expect(asLevel('xhigh')).toBe('xhigh')
    expect(asLevel('max')).toBe('max')
    expect(asLevel(3)).toBe(null)
    expect(asLevel(undefined)).toBe(null)
  })

  test('levels move one step and stop at the ends', () => {
    expect(up('xhigh')).toBe('max')
    expect(up('max')).toBe('max')
    expect(up('medium', 2)).toBe('xhigh')
    expect(down('medium')).toBe('medium')
    expect(down('max')).toBe('xhigh')
    expect(maxLevel(null, 'high', undefined, 'medium')).toBe('high')
    expect(maxLevel()).toBe(null)
    expect(minLevel('max', 'high')).toBe('high')
  })

  test('bounds follow min(ceiling, max(floor, skillFloor, base))', () => {
    expect(applyBounds('medium', { floor: 'medium', ceiling: 'max', skillFloor: 'xhigh' })).toBe('xhigh')
    expect(applyBounds('max', { floor: 'medium', ceiling: 'xhigh', skillFloor: null })).toBe('xhigh')
    expect(applyBounds('medium', { floor: 'high', ceiling: 'max', skillFloor: null })).toBe('high')
    expect(applyBounds('high', { floor: 'medium', ceiling: 'max', skillFloor: null })).toBe('high')
  })

  test('the guards tell levels, efforts and top models apart', () => {
    expect(LEVELS.map(rank)).toEqual([0, 1, 2, 3])
    expect(isLevel('medium')).toBe(true)
    expect(isLevel('low')).toBe(false)
    expect(isLevel(2)).toBe(false)
    expect(isEffort('low')).toBe(true)
    expect(isEffort('max')).toBe(true)
    expect(isEffort('extreme')).toBe(false)
    expect(isTop('opus')).toBe(true)
    expect(isTop('fable')).toBe(true)
    expect(isTop('sonnet')).toBe(false)
  })

  test('the bound that set the level is named', () => {
    const b = (floor: 'medium' | 'high', ceiling: 'xhigh' | 'max', skillFloor: 'high' | 'xhigh' | null) => ({ floor, ceiling, skillFloor })
    expect(boundOf('high', b('medium', 'max', null))).toBe(null)
    expect(boundOf('high', b('high', 'max', null))).toBe(null)
    expect(boundOf('medium', b('high', 'max', null))).toBe('floor')
    expect(boundOf('medium', b('medium', 'max', 'xhigh'))).toBe('skill')
    expect(boundOf('medium', b('high', 'max', 'high'))).toBe('skill')
    expect(boundOf('medium', b('high', 'max', 'xhigh'))).toBe('skill')
    expect(boundOf('max', b('medium', 'xhigh', null))).toBe('ceiling')
    expect(boundOf('medium', b('medium', 'xhigh', null))).toBe(null)
  })

  test('Opus and Fable families, older versions included, count as top', () => {
    expect(isTopFamily('claude-opus-5-5')).toBe(true)
    expect(isTopFamily('claude-opus-5')).toBe(true)
    expect(isTopFamily('claude-fable-5-1')).toBe(true)
    expect(isTopFamily('claude-mythos-5-1')).toBe(true)
    expect(isTopFamily('opus')).toBe(true)
    expect(isTopFamily('claude-sonnet-5-5')).toBe(false)
    expect(isTopFamily('claude-haiku-4-5')).toBe(false)
  })

  test('the ladder ends on the top model at max', () => {
    expect(ladder('opus')).toEqual([
      { model: 'haiku', effort: 'low' },
      { model: 'sonnet', effort: 'medium' },
      { model: 'opus', effort: 'high' },
      { model: 'opus', effort: 'xhigh' },
      { model: 'opus', effort: 'max' },
    ])
    expect(ladder('fable')[4]).toEqual({ model: 'claude-fable-5-1', effort: 'max' })
    // Only the last rung follows the top model: Fable costs 2.5 times Opus.
    expect(ladder('fable').slice(0, 4)).toEqual(ladder('opus').slice(0, 4))
    expect(TOP_IDS.fable).toBe('claude-fable-5-1')
  })
})
