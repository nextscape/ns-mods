import { expect, test } from 'claude-code/testing'

import { agentStage, skillPhase } from '../hooks/parse'

// Descriptions and opening lines the SDD controller actually sent.
test('SDD の役割を、実際の呼び出しから見分ける', () => {
  const implement = agentStage(
    'Implement A3 Task 1: filter definitions',
    'You are implementing Task 1: 条件の定義',
    null,
  )
  expect(implement).toEqual({ task: 1, step: 'implement', round: 0 })

  const review = agentStage(
    'Review A3 Task 1 (spec + quality)',
    "You are reviewing one task's implementation: first",
    implement ?? null,
  )
  expect(review).toEqual({ task: 1, step: 'review', round: 0 })

  expect(
    agentStage(
      'Re-review Task 3 fix round 1',
      "You are re-reviewing one task's fix round.",
      review ?? null,
    ),
  ).toEqual({ task: 3, step: 'rereview', round: 1 })
  expect(
    agentStage(
      'Final whole-branch review',
      'You are a Senior Code Reviewer with expertise',
      null,
    ),
  ).toEqual({ task: null, step: 'final-review', round: 0 })
  expect(
    agentStage(
      'Fix final review findings',
      'You are fixing the findings of a whole-branch code review',
      null,
    ),
  ).toEqual({ task: null, step: 'final-fix', round: 0 })
  expect(
    agentStage('Re-review final fix wave', 'You are re-reviewing a fix round.', null),
  ).toEqual({ task: null, step: 'final-review', round: 0 })
  expect(
    agentStage('Fix a tracking regression', 'Single-file bug fix in repo', null),
  ).toBeUndefined()
})

test('Superpowers のスキルだけを工程に数える', () => {
  expect(skillPhase('superpowers:brainstorming')).toBe('design')
  expect(skillPhase('superpowers:finishing-a-development-branch')).toBe('finish')
  expect(skillPhase('deploy')).toBeUndefined()
})
