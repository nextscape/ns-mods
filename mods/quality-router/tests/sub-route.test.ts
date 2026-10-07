import { describe, expect, test } from 'claude-code/testing'

import {
  SUB_KINDS,
  WEIGHTS,
  assign,
  composeKind,
  composeWeight,
  escalate,
  retryKey,
  shouldRoute,
  strengthOfAssignment,
  subKindOf,
  weightOf,
} from '../hooks/sub-route'

const facts = (over: Partial<Parameters<typeof shouldRoute>[0]> = {}) => ({
  fork: false,
  subagentType: 'general-purpose',
  description: 'list hooks',
  prompt: 'hooks の一覧を作って',
  ...over,
})

describe('sub-route', () => {
  test('only built-in general agents without an explicit model are routed', () => {
    expect(shouldRoute(facts())).toBe(true)
    expect(shouldRoute(facts({ subagentType: 'claude' }))).toBe(true)
    expect(shouldRoute(facts({ fork: true }))).toBe(false)
    expect(shouldRoute(facts({ model: 'haiku' }))).toBe(false)
    expect(shouldRoute(facts({ subagentType: 'my-custom-agent' }))).toBe(false)
    expect(shouldRoute(facts({ isTeammate: true }))).toBe(false)
  })

  test('the kind classifier reads its rubric, the type, description and a clipped prompt', () => {
    const out = composeKind({ subagentType: 'general-purpose', description: 'review diff', prompt: `${'あ'.repeat(700)}${'い'.repeat(300)}` })
    expect(out).toContain('[rubric] Judge which kind of work the subagent task below is.')
    expect(out).toContain('chore = mechanical work whose result needs no judgment')
    expect(out).toContain('decide = choosing a direction or giving a pass/fail verdict.')
    expect(out).toContain('[type] general-purpose')
    expect(out).toContain('[description] review diff')
    expect(out.split('\n').pop()).toBe(`[prompt chars=1000] ${'あ'.repeat(600)} … ${'い'.repeat(200)}`)
    const short = composeKind({ subagentType: 'claude', description: 'd', prompt: 'hooks の一覧を作って' })
    expect(short.split('\n').pop()).toBe('[prompt chars=13] hooks の一覧を作って')
  })

  test('the weight classifier reads its rubric and the same three fields', () => {
    const out = composeWeight({ subagentType: 'claude', description: 'review diff', prompt: 'この差分をレビューして' })
    expect(out).toContain('[rubric] Judge how heavy the subagent task below is.')
    expect(out).toContain('light = small and clear')
    expect(out).toContain('heavy = large or uncertain')
    expect(out).not.toContain('chore = ')
    expect(out).toContain('[type] claude')
    expect(out).toContain('[description] review diff')
    expect(out.split('\n').pop()).toBe('[prompt chars=11] この差分をレビューして')
  })

  test('the labels: seven kinds without fix, and two weights', () => {
    expect(SUB_KINDS).toEqual(['chore', 'impl', 'investigate', 'verify', 'review', 'refute', 'decide'])
    expect(WEIGHTS).toEqual(['light', 'heavy'])
    expect(subKindOf('review')).toBe('review')
    expect(subKindOf(' chore ')).toBe('chore')
    expect(subKindOf('fix')).toBe(undefined)
    expect(subKindOf('light')).toBe(undefined)
    expect(subKindOf(undefined)).toBe(undefined)
    expect(weightOf('heavy')).toBe('heavy')
    expect(weightOf('light')).toBe('light')
    expect(weightOf('chore')).toBe(undefined)
    expect(weightOf(undefined)).toBe(undefined)
  })

  test('each kind and weight maps to its assignment', () => {
    const opus = (kind: Parameters<typeof assign>[0], weight: Parameters<typeof assign>[1]) => assign(kind, weight, 'xhigh', 'opus')
    expect(opus('chore', 'light')).toEqual({ tier: 1, model: 'sonnet', effort: 'medium' })
    expect(opus('chore', 'heavy')).toEqual({ tier: 1, model: 'sonnet', effort: 'medium' })
    expect(opus('impl', 'light')).toEqual({ tier: 1, model: 'sonnet', effort: 'high' })
    expect(opus('impl', 'heavy')).toEqual({ tier: 2, effort: 'high' })
    expect(opus('investigate', 'light')).toEqual({ tier: 1, model: 'sonnet', effort: 'high' })
    expect(opus('investigate', 'heavy')).toEqual({ tier: 3, effort: 'xhigh' })
    expect(opus('verify', 'light')).toEqual({ tier: 1, model: 'sonnet', effort: 'high' })
    expect(opus('verify', 'heavy')).toEqual({ tier: 2, model: 'opus', effort: 'high' })
    expect(opus('review', 'light')).toEqual({ tier: 2, model: 'opus', effort: 'high' })
    expect(opus('review', 'heavy')).toEqual({ tier: 3, model: 'opus', effort: 'xhigh' })
    expect(opus('refute', 'light')).toEqual({ tier: 3, model: 'opus', effort: 'xhigh' })
    expect(opus('refute', 'heavy')).toEqual({ tier: 3, model: 'opus', effort: 'xhigh' })
    expect(opus('decide', 'light')).toEqual({ tier: 2, model: 'opus', effort: 'high' })
    expect(opus('decide', 'heavy')).toEqual({ tier: 3, model: 'opus', effort: 'xhigh' })
  })

  test('the peak follows the top model and a max main level', () => {
    expect(assign('review', 'heavy', 'max', 'fable')).toEqual({ tier: 4, model: 'claude-fable-5-1', effort: 'max' })
    expect(assign('refute', 'light', 'max', 'opus')).toEqual({ tier: 3, model: 'opus', effort: 'xhigh' })
    expect(assign('refute', 'heavy', 'max', 'opus')).toEqual({ tier: 4, model: 'opus', effort: 'max' })
    expect(assign('refute', 'heavy', 'max', 'fable')).toEqual({ tier: 4, model: 'claude-fable-5-1', effort: 'max' })
    expect(assign('decide', 'heavy', 'max', 'opus')).toEqual({ tier: 4, model: 'opus', effort: 'max' })
    expect(assign('verify', 'heavy', null, 'fable')).toEqual({ tier: 2, model: 'claude-fable-5-1', effort: 'high' })
  })

  test('an unknown weight counts as heavy; an unknown kind is left alone', () => {
    expect(assign('impl', undefined, null, 'opus')).toEqual(assign('impl', 'heavy', null, 'opus'))
    expect(assign('investigate', undefined, null, 'opus')).toEqual({ tier: 3, effort: 'xhigh' })
    expect(assign(undefined, 'light', null, 'opus')).toBe(null)
    expect(assign(undefined, undefined, null, 'opus')).toBe(null)
  })

  test('an assignment reads as a strength; an inherited model counts as the top tier', () => {
    expect(strengthOfAssignment({ tier: 1, model: 'sonnet', effort: 'medium' })).toEqual({ cls: 2, effort: 'medium' })
    expect(strengthOfAssignment({ tier: 2, effort: 'high' })).toEqual({ cls: 3, effort: 'high' })
    expect(strengthOfAssignment({ tier: 4, model: 'claude-fable-5-1', effort: 'max' })).toEqual({ cls: 3, effort: 'max' })
    expect(strengthOfAssignment({ tier: 2 })).toEqual({ cls: 3, effort: 'high' })
  })

  test('a retry climbs one rung and stops at the top', () => {
    expect(escalate(1, 'opus')).toEqual({ tier: 2, model: 'opus', effort: 'high' })
    expect(escalate(3, 'fable')).toEqual({ tier: 4, model: 'claude-fable-5-1', effort: 'max' })
    expect(escalate(4, 'opus')).toEqual({ tier: 4, model: 'opus', effort: 'max' })
    // Rungs 2 and 3 are Opus whatever the top model, so a retry of a
    // Fable child at rung 2 (light review, light decide, heavy verify) runs on
    // Opus at xhigh, and only rung 4 returns to Fable.
    expect(escalate(2, 'fable')).toEqual({ tier: 3, model: 'opus', effort: 'xhigh' })
  })

  test('retries match on the trimmed description', () => {
    expect(retryKey('  list hooks ')).toBe('list hooks')
  })
})
