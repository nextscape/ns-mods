import { describe, expect, test } from 'claude-code/testing'

import { scanAgentCalls } from '../hooks/gate-lexer'

const optionKeys = (src: string) =>
  scanAgentCalls(src).map(call => (call.options.kind === 'object' ? Object.keys(call.options.entries).sort() : call.options.kind))

describe('gate-lexer', () => {
  test('a plain call yields its option keys', () => {
    expect(optionKeys(`await agent('x', { label: 'work:a', effort: 'high', model: 'opus' })`)).toEqual([
      ['effort', 'label', 'model'],
    ])
  })

  test('agent() inside strings, comments and regexes is not a call', () => {
    const src = [
      "export const meta = { name: 'p', description: 'whose agent() lacks effort' }",
      '// agent("a")',
      '/* agent( */',
      'const re = /x agent(y)/g',
      "const s = \"agent('z')\"",
      "return await agent('real', { label: 'light:x', effort: 'low' })",
    ].join('\n')
    expect(scanAgentCalls(src).length).toBe(1)
  })

  test('a regex literal is skipped and a division is not read as one', () => {
    const call = "agent('a', { label: 'light:a', effort: 'low' })"
    // Regex literals holding agent( ... ): after a keyword, after if (...), and with '/' inside a class.
    expect(scanAgentCalls(`return /x agent(y)/.test(s) || ${call}`).length).toBe(1)
    expect(scanAgentCalls(`if (c) /x agent(y)/.test(s); ${call}`).length).toBe(1)
    expect(scanAgentCalls(`const ok = s.match(/[/]agent(x)/) && ${call}`).length).toBe(1)
    // Divisions: a regex read here would swallow the call that follows on the line.
    expect(scanAgentCalls(`const half = total / 2; ${call}`).length).toBe(1)
    expect(scanAgentCalls(`const mid = (a + b) / 2; ${call}`).length).toBe(1)
    expect(scanAgentCalls(`const up = i++ / 2; ${call}`).length).toBe(1)
    expect(scanAgentCalls(`const down = j-- / 2; ${call}`).length).toBe(1)
  })

  test('method calls and function declarations named agent are skipped', () => {
    expect(scanAgentCalls(`x.agent('a'); y?.agent('b'); function agent(p) {}`).length).toBe(0)
  })

  test('methods named agent are definitions, not calls', () => {
    expect(scanAgentCalls('const h = { agent(p) { return p } }').length).toBe(0)
    expect(scanAgentCalls('class H { async agent(p, q = {}) { return p } }').length).toBe(0)
    expect(scanAgentCalls('function* agent(p) {}').length).toBe(0)
    // A real call inside the method body still counts, numbered from 1.
    const src = "const h = { agent(p) { return agent(p, { label: 'light:a', effort: 'low' }) } }"
    expect(scanAgentCalls(src).map(call => call.ordinal)).toEqual([1])
    expect(optionKeys(src)).toEqual([['effort', 'label']])
  })

  test('a template label and a ladder spread with nested brackets are read', () => {
    const src = 'const out = await agent(`fix ${n}`, { label: `fix:${n}`, ...LADDER[Math.min(tier + 1, 4)] })'
    const [call] = scanAgentCalls(src)
    expect(call?.options.kind).toBe('object')
    if (call?.options.kind !== 'object') return
    expect(call.options.spreads).toEqual(['LADDER[Math.min(tier + 1, 4)]'])
    expect(call.options.entries.label?.[0]?.kind).toBe('template')
  })

  test('a template prompt holding braces does not end the call early', () => {
    const src = "agent(`a ${JSON.stringify({ x: 1 })} b`, { label: 'work:y', effort: 'high' })"
    expect(optionKeys(src)).toEqual([['effort', 'label']])
  })

  test('nested calls in the prompt argument are fine', () => {
    expect(optionKeys("agent(build(a, b), { label: 'light:x', effort: 'low' })")).toEqual([['effort', 'label']])
  })

  test('missing options and options held in a variable are told apart', () => {
    expect(optionKeys("agent('only a prompt')")).toEqual(['none'])
    expect(optionKeys("agent('p', opts)")).toEqual(['dynamic'])
  })

  test('calls are numbered from 1 in source order', () => {
    const calls = scanAgentCalls("agent('a', { label: 'light:a', effort: 'low' }); agent('b', { label: 'work:b', effort: 'high' })")
    expect(calls.map(call => call.ordinal)).toEqual([1, 2])
  })
})
