import { describe, expect, test } from 'claude-code/testing'

import {
  DEFAULTS,
  absolutePath,
  files,
  firstLine,
  isAuthError,
  isSupported,
  parseBranches,
  parseConfig,
  parseRemoteHeads,
  parseStash,
  parseStatus,
  parseVersion,
  prunableWorktrees,
} from '../hooks/parse'
import { FIXTURES } from './fixtures'

describe('parseStatus', () => {
  test('reads the branch, its upstream and how far apart they are', () => {
    expect(parseStatus(FIXTURES['status-insync']).branch).toEqual({ head: 'main', upstream: 'origin/main', ahead: 0, behind: 0 })
    expect(parseStatus(FIXTURES['status-behind']).branch).toEqual({ head: 'main', upstream: 'origin/main', ahead: 0, behind: 2 })
    expect(parseStatus(FIXTURES['status-ahead']).branch).toEqual({ head: 'main', upstream: 'origin/main', ahead: 1, behind: 0 })
    expect(parseStatus(FIXTURES['status-diverged']).branch).toEqual({ head: 'main', upstream: 'origin/main', ahead: 1, behind: 2 })
  })

  test('a detached HEAD has no branch and no upstream', () => {
    expect(parseStatus(FIXTURES['status-detached']).branch).toEqual({ head: null, upstream: null, ahead: null, behind: null })
  })

  test('a branch without upstream, and an unborn one', () => {
    expect(parseStatus(FIXTURES['status-noupstream']).branch).toEqual({ head: 'local-only', upstream: null, ahead: null, behind: null })
    expect(parseStatus(FIXTURES['status-initial']).branch).toEqual({ head: 'main', upstream: null, ahead: null, behind: null })
  })

  test('a pruned upstream keeps its name and loses ahead/behind', () => {
    expect(parseStatus(FIXTURES['status-gone-pruned']).branch).toEqual({
      head: 'feat-merged',
      upstream: 'origin/feat-merged',
      ahead: null,
      behind: null,
    })
    expect(parseStatus(FIXTURES['status-gone-noprune']).branch.ahead).toBe(0)
  })

  test('counts tracked changes once each, untracked files and conflicts', () => {
    const dirty = parseStatus(FIXTURES['status-dirty']).changes
    expect(dirty).toEqual({ tracked: 2, untracked: 1, conflicted: 0 })
    expect(files(dirty)).toBe(3)
    expect(parseStatus(FIXTURES['status-conflict']).changes).toEqual({ tracked: 0, untracked: 0, conflicted: 1 })
  })

  test('CRLF output reads the same as LF', () => {
    for (const key of ['status-behind', 'status-dirty', 'status-gone-pruned'] as const) {
      expect(parseStatus(FIXTURES[key].replace(/\n/g, '\r\n'))).toEqual(parseStatus(FIXTURES[key]))
    }
  })
})

describe('parseStash', () => {
  test('counts stashes and finds the oldest', () => {
    expect(parseStash(FIXTURES['stash'])).toEqual({ count: 2, oldest: Date.UTC(2026, 0, 1) })
    expect(parseStash('')).toEqual({ count: 0, oldest: null })
  })
})

describe('git version', () => {
  test('reads major and minor, and needs 2.29 or later', () => {
    expect(parseVersion('git version 2.49.0.windows.1\n')).toEqual([2, 49])
    expect(parseVersion(FIXTURES['version'])).not.toBeNull()
    expect(parseVersion('')).toBeNull()
    expect(isSupported([2, 49])).toBe(true)
    expect(isSupported([2, 29])).toBe(true)
    expect(isSupported([2, 28])).toBe(false)
    expect(isSupported([3, 0])).toBe(true)
    expect(isSupported(null)).toBe(false)
  })
})

describe('parseConfig', () => {
  test('defaults with nothing set', () => {
    expect(parseConfig('')).toEqual({ settings: DEFAULTS, problems: [] })
  })

  test('reads what git printed and names what it ignored', () => {
    const { settings, problems } = parseConfig(FIXTURES['config'])
    expect(settings).toEqual({ ...DEFAULTS, fetchInterval: 0, tellClaude: false })
    expect(problems).toEqual([
      'git-nudge.band=maybe は true / false ではないので無視しました',
      'git-nudge.stashagedays=x7 は 0 以上の整数ではないので無視しました',
      'git-nudge.fetchintervall は知らない設定です',
    ])
  })

  test('a key with no value is true; later lines win; a bad later line keeps the earlier value', () => {
    expect(parseConfig('git-nudge.enabled\n').settings.enabled).toBe(true)
    expect(parseConfig('git-nudge.band false\ngit-nudge.band true\n').settings.band).toBe(true)
    expect(parseConfig('git-nudge.band false\ngit-nudge.band maybe\n').settings.band).toBe(false)
    expect(parseConfig('git-nudge.fetchinterval 0\r\n').settings.fetchInterval).toBe(0)
  })
})

describe('branches and the remote', () => {
  test('ls-remote gives the branch names on the remote', () => {
    expect([...parseRemoteHeads(FIXTURES['ls-remote'])].sort()).toEqual(['feat-open', 'main'])
    const odd = parseRemoteHeads('abc\trefs/heads/feature/日本語\r\nabc\trefs/tags/v1\n')
    expect([...odd]).toEqual(['feature/日本語'])
  })

  test('for-each-ref gives each branch, its upstream and worktree', () => {
    const branches = parseBranches(FIXTURES['branches'])
    expect(branches.map(branch => branch.name)).toEqual(['feat-merged', 'feat-open', 'feat-squash', 'feat-wt', 'main', 'wt-gone-branch'])
    expect(branches[0]).toEqual({
      name: 'feat-merged',
      oid: 'feb4622258cea9cb375166f35dbd128e5144ec82',
      remote: 'origin',
      remoteRef: 'refs/heads/feat-merged',
      worktree: null,
    })
    expect(branches[3]!.worktree).toBe('/fx/wt')
    expect(branches[5]).toMatchObject({ remote: null, remoteRef: null, worktree: '/fx/wt-gone' })
  })

  test('worktrees git can prune', () => {
    expect(prunableWorktrees(FIXTURES['worktrees'])).toEqual(['/fx/wt-gone'])
    expect(prunableWorktrees(FIXTURES['worktrees'].replace(/\n/g, '\r\n'))).toEqual(['/fx/wt-gone'])
  })
})

describe('helpers', () => {
  test('absolutePath keeps absolute paths and joins relative ones to the root', () => {
    expect(absolutePath('D:/r', '.git/MERGE_HEAD')).toBe('D:/r/.git/MERGE_HEAD')
    expect(absolutePath('D:/r/', '.git/MERGE_HEAD')).toBe('D:/r/.git/MERGE_HEAD')
    expect(absolutePath('D:/r', 'C:/x/.git/worktrees/wt/MERGE_HEAD')).toBe('C:/x/.git/worktrees/wt/MERGE_HEAD')
    expect(absolutePath('D:/r', 'C:\\x\\.git\\MERGE_HEAD')).toBe('C:\\x\\.git\\MERGE_HEAD')
    expect(absolutePath('/r', '/abs/.git/index.lock')).toBe('/abs/.git/index.lock')
  })

  test('isAuthError tells a login failure from a network one', () => {
    expect(isAuthError("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe(true)
    expect(isAuthError('git@github.com: Permission denied (publickey).')).toBe(true)
    expect(isAuthError('remote: HTTP Basic: Access denied')).toBe(true)
    expect(isAuthError("fatal: Authentication failed for 'https://example.com/r.git/'")).toBe(true)
    expect(isAuthError('Host key verification failed.\r\nfatal: Could not read from remote repository.')).toBe(true)
    expect(isAuthError("fatal: unable to access 'https://github.com/x/': Could not resolve host: github.com")).toBe(false)
  })

  test('firstLine', () => {
    expect(firstLine('\nfatal: one\r\nhint: two\n')).toBe('fatal: one')
    expect(firstLine('')).toBe('')
  })
})
