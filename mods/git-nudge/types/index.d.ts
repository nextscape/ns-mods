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

export type Status = { branch: Branch; changes: Changes }

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

export type Snapshot = {
  root: string
  status: Status
  stash: { count: number; oldest: number | null }
  operation: Operation | null
  // When index.lock was first seen, refresh after refresh; null when absent.
  lockSince: number | null
  // Local branches whose upstream branch is gone from the remote, as of the
  // last ls-remote; null when it has not run.
  goneNames: string[] | null
  // How many of those /git-nudge tidy would list; null when unknown.
  tidyCount: number | null
  fetch: FetchState
  at: number
}

// What the session found when it first looked at the repository.
export type Start = { ahead: number; dirty: number }

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
