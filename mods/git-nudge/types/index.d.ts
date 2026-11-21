// What `git status --porcelain=v2 --branch` says about the branch.
export type Branch = {
  // Branch name; null when HEAD is detached.
  head: string | null
  // Upstream such as "origin/main"; null when none is set.
  upstream: string | null
  // Commits ahead of / behind the upstream; null when no upstream is set or
  // its remote-tracking ref is gone (pruned).
  ahead: number | null
  behind: number | null
}

// Entries in the working tree not yet committed. `tracked` counts changed
// tracked files once each, staged or not.
export type Changes = { tracked: number; untracked: number; conflicted: number }

export type Status = {
  // The commit HEAD is at; null before the first commit.
  oid: string | null
  branch: Branch
  changes: Changes
  // Stands for the uncommitted entries as git lists them: it changes when one
  // is added, removed, staged or unstaged. '' when there are none.
  dirtyKey: string
}

export type Operation = 'rebase' | 'merge' | 'cherry-pick' | 'revert' | 'bisect'

export type Settings = {
  enabled: boolean
  fetchOnStart: boolean
  // Minutes between fetches; 0 turns the timer off.
  fetchInterval: number
  tellClaude: boolean
  band: boolean
  stashAgeDays: number
}

// A local branch as `git for-each-ref` lists it (see BRANCH_FORMAT).
export type LocalBranch = {
  name: string
  oid: string
  // The remote and the branch on it this one tracks; null when none is set.
  remote: string | null
  remoteRef: string | null
  // The worktree it is checked out in; null when none.
  worktree: string | null
}

export type FetchState = {
  // The last fetch that worked, by any session (ms since epoch); null when unknown.
  lastOk: number | null
  // Set while this session's last fetch failed.
  failed: { at: number; auth: boolean } | null
}

// A local branch whose upstream branch the remote no longer had at the last
// ls-remote. `tracking` is the commit its remote-tracking ref pointed at then
// ('' when it had none, null when that could not be read): a push or a fetch
// that moves the ref means the branch is on the remote again.
export type GoneBranch = { name: string; tracking: string | null }

export type Snapshot = {
  root: string
  status: Status
  stash: { count: number; oldest: number | null }
  operation: Operation | null
  // When index.lock was first seen, refresh after refresh; null when absent.
  lockSince: number | null
  // The branches with a gone upstream, as of the last ls-remote and less those
  // deleted or pushed again since; null when ls-remote has not run.
  gone: GoneBranch[] | null
  // How many of those /git-nudge tidy would list; null when unknown.
  tidyCount: number | null
  fetch: FetchState
  at: number
}

// What the session found when it first looked at the repository: the branch,
// the commit HEAD was at, how many commits were unpushed and which entries
// were uncommitted (their count, and what stands for them).
export type Start = { head: string | null; oid: string | null; ahead: number; dirty: number; dirtyKey: string }

export type NoticeId =
  | 'operation'
  | 'diverged'
  | 'behind'
  | 'behind-dirty'
  | 'gone'
  | 'lock'
  | 'auth'
  | 'unpushed'
  | 'uncommitted'
  | 'stash'
  | 'tidy'

export type Notice = {
  id: NoticeId
  text: string
  // The band offers the pull button beside it.
  pull?: true
  // Claude is told about it.
  tell: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'git-nudge': {
      snapshot: Snapshot | null
      start: Start | null
      dismissed: string[]
      busy: boolean
    }
  }
}
