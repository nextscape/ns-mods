import { describe, expect, test } from 'claude-code/testing'

import {
  LOCK_AFTER,
  MINUTE,
  ago,
  isGone,
  noticeKey,
  notices,
  pullBlocker,
  statusLine,
  tellText,
} from '../hooks/judge'
import { DEFAULTS, parseStatus } from '../hooks/parse'
import type { Snapshot } from '../types'
import { FIXTURES } from './fixtures'

const NOW = Date.UTC(2026, 9, 7, 12)
const DAY = 24 * 60 * MINUTE

type StatusKey = Extract<keyof typeof FIXTURES, `status-${string}`>

function snap(status: StatusKey | string, extra: Partial<Snapshot> = {}): Snapshot {
  const out = status in FIXTURES ? FIXTURES[status as StatusKey] : status
  return {
    root: 'D:/r',
    status: parseStatus(out),
    stash: { count: 0, oldest: null },
    operation: null,
    lockSince: null,
    goneNames: [],
    tidyCount: 0,
    fetch: { lastOk: NOW - 3 * MINUTE, failed: null },
    at: NOW,
    ...extra,
  }
}

// Behind by 2 with a changed tracked file, and behind by 2 with only an untracked one.
const BEHIND_DIRTY = `${FIXTURES['status-behind']}1 .M N... 100644 100644 100644 aaa aaa f.txt\n`
const BEHIND_UNTRACKED = `${FIXTURES['status-behind']}? new.txt\n`
const ids = (list: { id: string }[]) => list.map(notice => notice.id)

describe('ago', () => {
  test('says how long ago in Japanese', () => {
    expect(ago(30_000)).toBe('たった今')
    expect(ago(3 * MINUTE)).toBe('3分前')
    expect(ago(2 * 60 * MINUTE)).toBe('2時間前')
    expect(ago(14 * DAY)).toBe('14日前')
  })
})

describe('isGone', () => {
  test('a pruned upstream, or one ls-remote no longer lists', () => {
    expect(isGone(snap('status-gone-pruned'))).toBe(true)
    expect(isGone(snap('status-gone-noprune'))).toBe(false)
    expect(isGone(snap('status-gone-noprune', { goneNames: ['feat-merged'] }))).toBe(true)
    expect(isGone(snap('status-noupstream'))).toBe(false)
    expect(isGone(snap('status-detached'))).toBe(false)
  })
})

describe('pullBlocker', () => {
  test('a clean branch that is only behind may fast-forward; untracked files do not stop it', () => {
    expect(pullBlocker(snap('status-behind'))).toBeNull()
    expect(pullBlocker(snap(BEHIND_UNTRACKED))).toBeNull()
  })

  test('says why not otherwise', () => {
    expect(pullBlocker(snap('status-insync'))).toBe('取り込むものがありません')
    expect(pullBlocker(snap('status-diverged'))).toBe('origin/main と分岐しています（↓2 ↑1）')
    expect(pullBlocker(snap(BEHIND_DIRTY))).toBe('未コミットの変更があります')
    expect(pullBlocker(snap('status-detached'))).toBe('HEAD が切り離されています')
    expect(pullBlocker(snap('status-noupstream'))).toBe('upstream がありません')
    expect(pullBlocker(snap('status-gone-pruned'))).toBe('origin/feat-merged は削除済みです')
    expect(pullBlocker(snap('status-behind', { operation: 'rebase' }))).toBe(
      'rebase の途中です（git rebase --continue か --abort）',
    )
  })
})

describe('notices', () => {
  const at = (s: Snapshot, start: Parameters<typeof notices>[1] = null, tidyHint = false) =>
    notices(s, start, DEFAULTS, NOW, tidyHint)

  test('nothing in sync', () => {
    expect(at(snap('status-insync'))).toEqual([])
  })

  test('behind and clean offers the pull button and is told', () => {
    expect(at(snap('status-behind'))).toEqual([{ id: 'behind', text: 'origin/main より 2 遅れ', pull: true, tell: true }])
  })

  test('behind with tracked changes says to pull by hand', () => {
    expect(at(snap(BEHIND_DIRTY))).toEqual([
      { id: 'behind-dirty', text: 'origin/main より 2 遅れ。未コミットの変更があるので、取り込みは手動で', tell: true },
    ])
  })

  test('diverged, gone and a half-done operation', () => {
    expect(ids(at(snap('status-diverged')))).toEqual(['diverged'])
    expect(at(snap('status-diverged'))[0]!.text).toBe('origin/main と分岐（↓2 ↑1）。rebase か merge が必要')
    expect(ids(at(snap('status-gone-pruned')))).toEqual(['gone'])
    expect(at(snap('status-gone-pruned'))[0]!.text).toBe('origin/feat-merged は削除済み。マージ済みなら既定ブランチに戻ってください')
    expect(ids(at(snap('status-behind', { operation: 'merge' })))).toEqual(['operation'])
  })

  test('index.lock only after ten minutes', () => {
    expect(ids(at(snap('status-insync', { lockSince: NOW - LOCK_AFTER + 1 })))).toEqual([])
    expect(ids(at(snap('status-insync', { lockSince: NOW - LOCK_AFTER })))).toEqual(['lock'])
  })

  test('leftovers from before the session show until their count changes', () => {
    const start = { ahead: 1, dirty: 3 }
    expect(ids(at(snap('status-ahead'), start))).toEqual(['unpushed'])
    expect(at(snap('status-ahead'), start)[0]!.text).toBe('前回からの未 push 1 件')
    expect(ids(at(snap('status-insync'), start))).toEqual([])
    expect(ids(at(snap('status-dirty'), { ahead: 0, dirty: 3 }))).toEqual(['uncommitted'])
    expect(at(snap('status-dirty'), { ahead: 0, dirty: 3 })[0]!.text).toBe('前回の未コミット変更 3 ファイル')
    expect(ids(at(snap('status-dirty'), { ahead: 0, dirty: 2 }))).toEqual([])
  })

  test('old stashes, by stashAgeDays', () => {
    const old = snap('status-insync', { stash: { count: 2, oldest: NOW - 14 * DAY } })
    expect(at(old)).toEqual([{ id: 'stash', text: 'stash 2 件（最古 14日前）', tell: false }])
    expect(ids(at(snap('status-insync', { stash: { count: 1, oldest: NOW - 6 * DAY } })))).toEqual([])
    expect(ids(notices(old, null, { ...DEFAULTS, stashAgeDays: 30 }, NOW, false))).toEqual([])
  })

  test('the tidy hint only when allowed and from five branches', () => {
    expect(ids(at(snap('status-insync', { tidyCount: 5 }), null, true))).toEqual(['tidy'])
    expect(ids(at(snap('status-insync', { tidyCount: 5 }), null, false))).toEqual([])
    expect(ids(at(snap('status-insync', { tidyCount: 4 }), null, true))).toEqual([])
  })

  test('an auth failure is shown, not told', () => {
    const failed = snap('status-insync', { fetch: { lastOk: null, failed: { at: NOW, auth: true } } })
    expect(at(failed)).toEqual([{ id: 'auth', text: 'fetch が認証で失敗しました。このセッションでは定期 fetch を止めます', tell: false }])
  })

  test('most urgent first', () => {
    const all = snap(BEHIND_DIRTY, {
      operation: 'rebase',
      lockSince: NOW - LOCK_AFTER,
      stash: { count: 1, oldest: NOW - 30 * DAY },
      tidyCount: 9,
      fetch: { lastOk: null, failed: { at: NOW, auth: true } },
    })
    expect(ids(at(all, { ahead: 0, dirty: 1 }, true))).toEqual(['operation', 'lock', 'auth', 'uncommitted', 'stash', 'tidy'])
  })
})

describe('statusLine', () => {
  const line = (s: Snapshot, settings = DEFAULTS) => statusLine(s, settings, NOW)

  test('says nothing when all is well', () => {
    expect(line(snap('status-insync'))).toBeUndefined()
  })

  test('branch, distance, leftovers and how fresh the fetch is', () => {
    expect(line(snap('status-behind'))).toBe('main ↓2 · fetch 3分前')
    expect(line(snap('status-diverged'))).toBe('main ↓2 ↑1 · fetch 3分前')
    expect(line(snap('status-dirty'))).toBe('main · 未コミット 3 · fetch 3分前')
    expect(line(snap('status-detached'))).toBe('HEAD 切り離し · fetch 3分前')
    expect(line(snap('status-noupstream'))).toBe('local-only upstream なし · fetch 3分前')
    expect(line(snap('status-gone-pruned'))).toBe('feat-merged upstream 消滅 · fetch 3分前')
    expect(line(snap('status-conflict', { operation: 'merge', stash: { count: 2, oldest: NOW } }))).toBe(
      'main ↑1 · merge 中 · 未コミット 1 · stash 2 · fetch 3分前',
    )
    expect(line(snap('status-insync', { lockSince: NOW - LOCK_AFTER }))).toBe('main · lock · fetch 3分前')
  })

  test('a failed fetch, and a fetch turned off', () => {
    const failed = snap('status-behind', { fetch: { lastOk: NOW - 12 * MINUTE, failed: { at: NOW, auth: false } } })
    expect(line(failed)).toBe('main ↓2 · fetch 失敗（最終成功 12分前）')
    const never = snap('status-insync', { fetch: { lastOk: null, failed: { at: NOW, auth: false } } })
    expect(line(never)).toBe('main · fetch 失敗')
    const off = { ...DEFAULTS, fetchOnStart: false, fetchInterval: 0 }
    expect(line(snap('status-insync'), off)).toBe('main · fetch 3分前')
    expect(line(snap('status-insync', { fetch: { lastOk: null, failed: null } }), off)).toBeUndefined()
  })
})

describe('tellText and noticeKey', () => {
  test('tells what is told, with the rule not to act on it unasked', () => {
    const list = notices(snap('status-behind', { stash: { count: 1, oldest: NOW - 30 * DAY } }), { ahead: 0, dirty: 0 }, DEFAULTS, NOW, false)
    expect(tellText(list)).toBe(
      '[git-nudge] このリポジトリの状態: origin/main より 2 遅れ\n' +
        'これは情報です。ユーザーの指示なしに pull・rebase・push・ブランチの削除をしないでください。',
    )
    expect(tellText(notices(snap('status-insync', { tidyCount: 9 }), null, DEFAULTS, NOW, true))).toBeNull()
  })

  test('a notice key changes with its text', () => {
    const two = notices(snap('status-behind'), null, DEFAULTS, NOW, false)[0]!
    const three = { ...two, text: 'origin/main より 3 遅れ' }
    expect(noticeKey(two)).not.toBe(noticeKey(three))
  })
})
