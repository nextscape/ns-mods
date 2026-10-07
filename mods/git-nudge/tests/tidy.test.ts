import { describe, expect, test } from 'claude-code/testing'

import { lines, parseBranches, parseRemoteHeads } from '../hooks/parse'
import { deletedReport, describeTidy, planTidy, tidyCandidates, withGoneUpstream } from '../hooks/tidy'
import type { LocalBranch } from '../types'
import { FIXTURES } from './fixtures'

const branches = parseBranches(FIXTURES['branches'])
const heads = parseRemoteHeads(FIXTURES['ls-remote'])
const merged = new Set(lines(FIXTURES['merged']))
const names = (list: LocalBranch[]) => list.map(branch => branch.name)

describe('gone upstreams', () => {
  test('finds branches whose upstream branch the remote no longer has', () => {
    expect(names(withGoneUpstream(branches, heads, 'origin'))).toEqual(['feat-merged', 'feat-squash', 'feat-wt'])
  })

  test('tidy leaves out branches checked out in a worktree', () => {
    expect(names(tidyCandidates(branches, heads, 'origin'))).toEqual(['feat-merged', 'feat-squash'])
  })

  test('a branch tracking another remote is not judged by this one', () => {
    const other: LocalBranch = { name: 'fork-x', oid: 'abc', remote: 'upstream', remoteRef: 'refs/heads/fork-x', worktree: null }
    expect(names(withGoneUpstream([...branches, other], heads, 'origin'))).not.toContain('fork-x')
    expect(names(withGoneUpstream([other], new Set(), 'upstream'))).toEqual(['fork-x'])
  })

  test('names with slashes and Japanese match the remote as they are', () => {
    const local: LocalBranch = { name: 'feature/日本語', oid: 'abc', remote: 'origin', remoteRef: 'refs/heads/feature/日本語', worktree: null }
    const there = parseRemoteHeads('abc\trefs/heads/feature/日本語\n')
    expect(withGoneUpstream([local], there, 'origin')).toEqual([])
    expect(names(withGoneUpstream([local], new Set(), 'origin'))).toEqual(['feature/日本語'])
  })
})

describe('planTidy', () => {
  test('only branches HEAD contains are deletable', () => {
    const plan = planTidy(tidyCandidates(branches, heads, 'origin'), merged)
    expect(names(plan.deletable)).toEqual(['feat-merged'])
    expect(names(plan.unconfirmed)).toEqual(['feat-squash'])
  })
})

describe('describeTidy', () => {
  const plan = planTidy(tidyCandidates(branches, heads, 'origin'), merged)

  test('lists what it deletes, what it leaves and how to delete those by hand', () => {
    const text = describeTidy(plan, ['/fx/wt-gone'], true)
    expect(text).toContain('消せるブランチ（HEAD にマージ済み）: 1 本')
    expect(text).toContain('  feat-merged')
    expect(text).toContain('マージを確認できないブランチ（消しません）: 1 本')
    expect(text).toContain('git branch -D feat-squash')
    expect(text).toContain('ディレクトリが無い worktree: 1 件（消すなら: git worktree prune）')
    expect(text).toContain('  /fx/wt-gone')
    expect(text).not.toContain('既定ブランチに移ってから')
  })

  test('off the default branch it suggests moving there first', () => {
    expect(describeTidy(plan, [], false)).toContain('既定ブランチに移ってから実行すると、より多く片付けられます。')
    expect(describeTidy(plan, [], null)).not.toContain('既定ブランチに移ってから')
  })

  test('nothing to tidy says so', () => {
    expect(describeTidy({ deletable: [], unconfirmed: [] }, [], true)).toBe('upstream が消えたブランチはありません。')
  })
})

describe('deletedReport', () => {
  test('gives the command that restores each deleted branch, and the failures', () => {
    const done = branches.filter(branch => branch.name === 'feat-merged')
    const text = deletedReport(done, [{ name: 'feat-x', message: "error: the branch 'feat-x' is not fully merged" }])
    expect(text).toContain('消しました: 1 本（戻すときは、各行のコマンドを実行）')
    expect(text).toContain('git branch feat-merged feb4622258cea9cb375166f35dbd128e5144ec82')
    expect(text).toContain('消せませんでした: 1 本')
    expect(text).toContain("feat-x: error: the branch 'feat-x' is not fully merged")
  })
})
