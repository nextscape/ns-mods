import type { Changes, LocalBranch, Operation, Settings, Status } from '../types'

// fetch --no-auto-maintenance arrived in 2.29.
export const MIN_GIT: readonly [number, number] = [2, 29]

export const DEFAULTS: Settings = {
  enabled: true,
  fetchOnStart: true,
  fetchInterval: 5,
  tellClaude: true,
  band: true,
  stashAgeDays: 7,
}

// The fields `git for-each-ref` prints per local branch, tab-separated (git
// refuses control characters in ref names).
export const BRANCH_FORMAT =
  '%(refname:short)%09%(objectname)%09%(upstream:remotename)%09%(upstream:remoteref)%09%(worktreepath)'

// Files in the git dir that mark an operation left half done, in the order
// they are asked for with `git rev-parse --git-path`.
export const MARKERS: ReadonlyArray<readonly [string, Operation]> = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
]

export function lines(out: string): string[] {
  return out.split(/\r?\n/).filter(line => line !== '')
}

export function files(changes: Changes): number {
  return changes.tracked + changes.untracked + changes.conflicted
}

// `git status --porcelain=v2 --branch`
export function parseStatus(out: string): Status {
  const branch: Status['branch'] = { head: null, upstream: null, ahead: null, behind: null }
  const changes: Changes = { tracked: 0, untracked: 0, conflicted: 0 }
  for (const line of lines(out)) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length)
      branch.head = head === '(detached)' ? null : head
    } else if (line.startsWith('# branch.upstream ')) {
      branch.upstream = line.slice('# branch.upstream '.length)
    } else if (line.startsWith('# branch.ab ')) {
      const counts = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line)
      if (counts) {
        branch.ahead = Number(counts[1])
        branch.behind = Number(counts[2])
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      changes.tracked += 1
    } else if (line.startsWith('u ')) {
      changes.conflicted += 1
    } else if (line.startsWith('? ')) {
      changes.untracked += 1
    }
  }
  return { branch, changes }
}

// `git stash list --format=%ct`: one commit time (seconds) per stash.
export function parseStash(out: string): { count: number; oldest: number | null } {
  const times = lines(out)
    .map(Number)
    .filter(Number.isFinite)
  return { count: times.length, oldest: times.length > 0 ? Math.min(...times) * 1000 : null }
}

// `git version`
export function parseVersion(out: string): [number, number] | null {
  const found = /git version (\d+)\.(\d+)/.exec(out)
  return found ? [Number(found[1]), Number(found[2])] : null
}

export function isSupported(version: readonly [number, number] | null): boolean {
  if (version === null) return false
  return version[0] > MIN_GIT[0] || (version[0] === MIN_GIT[0] && version[1] >= MIN_GIT[1])
}

const SETTING_KEYS: Readonly<Record<string, keyof Settings>> = {
  'git-nudge.enabled': 'enabled',
  'git-nudge.fetchonstart': 'fetchOnStart',
  'git-nudge.fetchinterval': 'fetchInterval',
  'git-nudge.tellclaude': 'tellClaude',
  'git-nudge.band': 'band',
  'git-nudge.stashagedays': 'stashAgeDays',
}

// git's spellings of a boolean; a key with no value is true.
function asBool(value: string): boolean | null {
  const word = value.toLowerCase()
  if (['', 'true', 'yes', 'on', '1'].includes(word)) return true
  if (['false', 'no', 'off', '0'].includes(word)) return false
  return null
}

// `git config --get-regexp ^git-nudge\.`: "key value" lines, later lines
// winning (git lists system, global, then local). `problems` names what was
// ignored, for /git-nudge to show.
export function parseConfig(out: string): { settings: Settings; problems: string[] } {
  const settings: Settings = { ...DEFAULTS }
  const set = settings as Record<keyof Settings, boolean | number>
  const problems: string[] = []
  for (const line of lines(out)) {
    const space = line.indexOf(' ')
    const key = (space < 0 ? line : line.slice(0, space)).toLowerCase()
    const value = space < 0 ? '' : line.slice(space + 1).trim()
    const name = SETTING_KEYS[key]
    if (name === undefined) {
      problems.push(`${key} は知らない設定です`)
      continue
    }
    if (typeof DEFAULTS[name] === 'boolean') {
      const flag = asBool(value)
      if (flag === null) problems.push(`${key}=${value} は true / false ではないので無視しました`)
      else set[name] = flag
    } else if (/^\d+$/.test(value)) {
      set[name] = Number(value)
    } else {
      problems.push(`${key}=${value} は 0 以上の整数ではないので無視しました`)
    }
  }
  return { settings, problems }
}

// `git ls-remote --heads <remote>`: the branch names on the remote.
export function parseRemoteHeads(out: string): Set<string> {
  const names = new Set<string>()
  for (const line of lines(out)) {
    const ref = line.split('\t')[1]
    if (ref !== undefined && ref.startsWith('refs/heads/')) names.add(ref.slice('refs/heads/'.length))
  }
  return names
}

// `git for-each-ref --format=<BRANCH_FORMAT> refs/heads`
export function parseBranches(out: string): LocalBranch[] {
  return lines(out)
    .map(line => {
      const [name = '', oid = '', remote = '', remoteRef = '', ...rest] = line.split('\t')
      const worktree = rest.join('\t')
      return {
        name,
        oid,
        remote: remote === '' ? null : remote,
        remoteRef: remoteRef === '' ? null : remoteRef,
        worktree: worktree === '' ? null : worktree,
      }
    })
    .filter(branch => branch.name !== '')
}

// `git worktree list --porcelain`: worktrees git marks prunable (their
// directory is gone).
export function prunableWorktrees(out: string): string[] {
  const found: string[] = []
  let path: string | null = null
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    else if (line.startsWith('prunable') && path !== null) found.push(path)
    else if (line === '') path = null
  }
  return found
}

// `git rev-parse --git-path` prints a path relative to where it ran (the
// repository root here) unless it lies elsewhere, as a linked worktree's does.
export function absolutePath(root: string, path: string): string {
  return /^(?:[A-Za-z]:)?[\\/]/.test(path) ? path : `${root.replace(/[\\/]+$/, '')}/${path}`
}

const AUTH =
  /authentication failed|could not read (?:username|password)|terminal prompts disabled|permission denied \(publickey|access denied|invalid username or password|\b40[13]\b/i

// Whether a fetch failed for want of a login, as opposed to the network.
export function isAuthError(stderr: string): boolean {
  return AUTH.test(stderr)
}

export function firstLine(text: string): string {
  return lines(text)[0]?.trim() ?? ''
}
