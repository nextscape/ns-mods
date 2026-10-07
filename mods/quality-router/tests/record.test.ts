import { describe, expect, test } from 'claude-code/testing'
import { scanAgentCalls } from '../hooks/gate-lexer'
import { checkCalls } from '../hooks/gate-rules'
import { common, gateCounts, recordPath, tokensOf } from '../hooks/record'

describe('record', () => {
  test('common fields: version 1, UTC ISO time, no tune yet', () => {
    expect(common(Date.UTC(2026, 9, 7, 3, 4, 5), 's1', 't1', '0.3.0')).toEqual({
      v: 1,
      at: '2026-10-07T03:04:05.000Z',
      session: 's1',
      turn: 't1',
      qr: '0.3.0',
      tune: null,
    })
  })

  test('tokens keep input, output and cache reads; no usage is null', () => {
    expect(tokensOf({ input_tokens: 4, output_tokens: 179, cache_read_input_tokens: 22612 })).toEqual({ input: 4, output: 179, cacheRead: 22612 })
    expect(tokensOf(undefined)).toBeNull()
  })

  test('the path is per UTC month and session; later parts carry their number', () => {
    const at = Date.UTC(2026, 9, 31, 20, 0, 0)
    expect(recordPath('C:/Users/u', at, 's1', 1)).toBe('C:/Users/u/.claude/quality-router/log/2026-10/s1.jsonl')
    expect(recordPath('C:/Users/u', at, 's1', 2)).toBe('C:/Users/u/.claude/quality-router/log/2026-10/s1.2.jsonl')
  })

  test('gate counts agents by kind, violations by rule, and fix calls', () => {
    const src = [
      "await agent('a', { label: 'chore: list', model: 'haiku', effort: 'low' })",
      "await agent('b', { label: `fix: ${name}`, ...LADDER[tier + 1] })",
      "await agent('c', { label: 'review: diff', effort: 'medium' })",
      "await agent('d', { label: 'scan' })",
    ].join('\n')
    const calls = scanAgentCalls(src)
    const counts = gateCounts(calls, checkCalls(calls))
    expect(counts.kinds).toEqual({ chore: 1, fix: 1, review: 1, unknown: 1 })
    expect(counts.fixes).toBe(1)
    expect(counts.rules.R0).toBe(1)
    expect(counts.rules.R2).toBe(1)
  })
})
