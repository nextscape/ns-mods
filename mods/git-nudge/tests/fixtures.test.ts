import { describe, expect, test } from 'claude-code/testing'

import { FIXTURES } from './fixtures'

describe('fixtures', () => {
  test('hold real git output for each case', () => {
    expect(FIXTURES['status-behind']).toContain('# branch.ab +0 -2')
    expect(FIXTURES['status-diverged']).toContain('# branch.ab +1 -2')
    expect(FIXTURES['status-gone-noprune']).toContain('# branch.ab +0 -0')
    expect(FIXTURES['status-gone-pruned']).not.toContain('# branch.ab')
    expect(FIXTURES['status-detached']).toContain('# branch.head (detached)')
    expect(FIXTURES['status-initial']).toContain('# branch.oid (initial)')
    expect(FIXTURES['ls-remote']).not.toContain('refs/heads/feat-merged')
    expect(FIXTURES['worktrees']).toContain('prunable')
    expect(FIXTURES['config']).toContain('git-nudge.fetchinterval 0')
  })
})
