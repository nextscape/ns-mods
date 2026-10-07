import { describe, expect, test } from 'claude-code/testing'

import { skillFloorFor } from '../hooks/skills'

describe('skills', () => {
  test('discussion, planning, debugging and review skills raise the floor to xhigh', () => {
    expect(skillFloorFor('superpowers:brainstorming')).toBe('xhigh')
    expect(skillFloorFor('superpowers:writing-plans')).toBe('xhigh')
    expect(skillFloorFor('superpowers:systematic-debugging')).toBe('xhigh')
    expect(skillFloorFor('code-review')).toBe('xhigh')
    expect(skillFloorFor('superpowers:requesting-code-review')).toBe('xhigh')
    expect(skillFloorFor('superpowers:receiving-code-review')).toBe('xhigh')
  })

  test('execution skills raise the floor to high', () => {
    expect(skillFloorFor('superpowers:executing-plans')).toBe('high')
    expect(skillFloorFor('superpowers:subagent-driven-development')).toBe('high')
    expect(skillFloorFor('superpowers:test-driven-development')).toBe('high')
  })

  test('a leading slash and surrounding spaces are ignored', () => {
    expect(skillFloorFor('/superpowers:brainstorming')).toBe('xhigh')
    expect(skillFloorFor('  code-review ')).toBe('xhigh')
  })

  test('other skills leave the floor alone', () => {
    expect(skillFloorFor('frontend-design:frontend-design')).toBe(undefined)
    expect(skillFloorFor('brainstorming')).toBe(undefined)
  })
})
