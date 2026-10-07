import type { Level } from '../types'

// A skill the main loop calls raises its floor until another
// listed skill is called or the session ends.
export const SKILL_FLOORS: Readonly<Record<string, Level>> = {
  'superpowers:brainstorming': 'xhigh',
  'superpowers:writing-plans': 'xhigh',
  'superpowers:systematic-debugging': 'xhigh',
  'code-review': 'xhigh',
  'superpowers:requesting-code-review': 'xhigh',
  'superpowers:receiving-code-review': 'xhigh',
  'superpowers:executing-plans': 'high',
  'superpowers:subagent-driven-development': 'high',
  'superpowers:test-driven-development': 'high',
}

export function skillFloorFor(skill: string): Level | undefined {
  return SKILL_FLOORS[skill.trim().replace(/^\//, '')]
}
