import { describe, expect, test } from 'claude-code/testing'

describe('smoke', () => {
  test('the test kit runs', () => {
    expect(1 + 1).toBe(2)
  })
})
