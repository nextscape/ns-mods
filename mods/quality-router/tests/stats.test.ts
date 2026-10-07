import { describe, expect, test } from 'claude-code/testing'
import { parseRecords, periodOf, sinceOf, summarize } from '../hooks/stats'

const base = { v: 1, at: '2026-10-07T01:00:00.000Z', session: 's', turn: 't', qr: '0.3.0', tune: null }
const main = (level: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...base, kind: 'main', level, why: 'auto', bump: false, toolErrors: 0, tokens: { input: 1, output: 200_000, cacheRead: 0 }, ...extra })

describe('stats', () => {
  test('periods: empty is 7d; today starts at local midnight', () => {
    expect(periodOf('')).toBe('7d')
    expect(periodOf('30d')).toBe('30d')
    expect(periodOf('1y')).toBeNull()
    const now = new Date(2026, 9, 7, 15, 30).getTime()
    expect(sinceOf('today', now)).toBe(new Date(2026, 9, 7).getTime())
    expect(sinceOf('7d', now)).toBe(now - 7 * 86_400_000)
  })

  test('broken lines and other versions are skipped', () => {
    const text = [main('high'), '{not json', JSON.stringify({ ...base, v: 2, kind: 'main' }), ''].join('\n')
    expect(parseRecords(text)).toHaveLength(1)
  })

  test('no records says so in Japanese', () => {
    expect(summarize([], '7d')).toBe('stats 7d: まだ記録がありません。')
  })

  test('levels, ways, signals, tokens, children and Workflow', () => {
    const lines = [
      main('high'),
      main('xhigh', { bump: true }),
      main('xhigh', { why: 'short', toolErrors: 3 }),
      main('medium'),
      JSON.stringify({ ...base, kind: 'signal', type: 'override', what: 'effort', from: 'high', to: 'max', dir: 'up' }),
      JSON.stringify({ ...base, kind: 'signal', type: 'feedback', dir: 'down', target: 'main', targetTurn: 't', targetAgent: null }),
      JSON.stringify({ ...base, kind: 'sub', kindJudged: 'chore', why: 'auto' }),
      JSON.stringify({ ...base, kind: 'sub', kindJudged: 'review', why: 'retry' }),
      JSON.stringify({ ...base, kind: 'sub', kindJudged: null, why: 'explicit' }),
      JSON.stringify({ ...base, kind: 'wf', phase: 'gate', verdict: 'deny', fixes: 2, kinds: {}, rules: {}, calls: 3, source: 'script' }),
    ].join('\n')
    expect(summarize(parseRecords(lines), '7d').split('\n')).toEqual([
      'stats 7d: main 4 turns, sub 3, workflow 1',
      'main: medium 25% · high 25% · xhigh 50% · max 0%  (auto 75%, short 25%)',
      'shallow signals 3 (override up 1, /qr up 0, bump 1, tool errors 1) · heavy signals 1 (override down 0, /qr down 1)',
      'tokens by level (output): medium 200k · high 200k · xhigh 400k',
      'sub: chore 1 · review 1 · explicit 1 (retry 1, unsure 0)',
      'workflow: deny 1 · fix 2',
    ])
  })
})
