import { describe, expect, test } from 'claude-code/testing'

import { Gate, capture } from '../hooks/gate'

describe('gate', () => {
  test('Gate lets one through at a time, in arrival order', async () => {
    const gate = new Gate()
    const seen: string[] = []
    const work = async (name: string, ticks: number) => {
      const release = await gate.enter()
      seen.push(`${name}+`)
      for (let i = 0; i < ticks; i++) await Promise.resolve()
      seen.push(`${name}-`)
      release()
    }
    await Promise.all([work('a', 3), work('b', 1), work('c', 0)])
    expect(seen).toEqual(['a+', 'a-', 'b+', 'b-', 'c+', 'c-'])
  })

  test('capture holds a result or a failure until it is awaited', async () => {
    const failing = capture(Promise.reject(new Error('boom')))
    await Promise.resolve()
    expect(await capture(Promise.resolve(1))).toEqual({ ok: true, value: 1 })
    const f = await failing
    expect(f.ok).toBe(false)
    expect(String(!f.ok && f.error)).toMatch(/boom/)
  })
})
