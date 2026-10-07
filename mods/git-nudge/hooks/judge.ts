import type { Notice, Operation, Settings, Snapshot, Start } from '../types'
import { files } from './parse'

export const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
// index.lock is reported once it has been there this long.
export const LOCK_AFTER = 10 * MINUTE
// The band suggests /git-nudge tidy from this many branches.
export const TIDY_HINT_MIN = 5
// Notices the band shows at once.
export const BAND_ROWS = 2

const OPERATION_TEXT: Readonly<Record<Operation, string>> = {
  rebase: 'rebase の途中です（git rebase --continue か --abort）',
  merge: 'merge の途中です（git merge --continue か --abort）',
  'cherry-pick': 'cherry-pick の途中です（git cherry-pick --continue か --abort）',
  revert: 'revert の途中です（git revert --continue か --abort）',
  bisect: 'bisect の途中です（終えるときは git bisect reset）',
}

// What Claude hears once what it was told has cleared up.
export const RESOLVED = '[git-nudge] 先に伝えたリポジトリの状態は解消しました。'

export function ago(ms: number): string {
  if (ms < MINUTE) return 'たった今'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}分前`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}時間前`
  return `${Math.floor(ms / DAY)}日前`
}

// The current branch's upstream is gone: pruned (status gives no
// ahead/behind for it) or missing from the last ls-remote.
export function isGone(snap: Snapshot): boolean {
  const { head, upstream, ahead } = snap.status.branch
  if (head === null || upstream === null) return false
  return ahead === null || (snap.goneNames?.includes(head) ?? false)
}

// Why a fast-forward should not run now, or null when it may: the branch is
// behind, has nothing of its own, no tracked file is changed and nothing is
// half done. Untracked files do not stop it: git refuses on its own when one
// would be overwritten.
export function pullBlocker(snap: Snapshot): string | null {
  const { branch, changes } = snap.status
  if (snap.operation !== null) return OPERATION_TEXT[snap.operation]
  if (branch.head === null) return 'HEAD が切り離されています'
  if (branch.upstream === null) return 'upstream がありません'
  if (isGone(snap)) return `${branch.upstream} は削除済みです`
  if (!branch.behind) return '取り込むものがありません'
  if (branch.ahead) return `${branch.upstream} と分岐しています（↓${branch.behind} ↑${branch.ahead}）`
  if (changes.tracked + changes.conflicted > 0) return '未コミットの変更があります'
  return null
}

// Everything worth a word, most urgent first. `tidyHint` lets the tidy
// suggestion in (once a day; the caller decides).
export function notices(snap: Snapshot, start: Start | null, settings: Settings, now: number, tidyHint: boolean): Notice[] {
  const out: Notice[] = []
  const { branch, changes } = snap.status
  const upstream = branch.upstream ?? 'upstream'
  const gone = isGone(snap)
  if (snap.operation !== null) out.push({ id: 'operation', text: OPERATION_TEXT[snap.operation], tell: true })
  if (!gone && branch.ahead && branch.behind) {
    out.push({ id: 'diverged', text: `${upstream} と分岐（↓${branch.behind} ↑${branch.ahead}）。rebase か merge が必要`, tell: true })
  } else if (!gone && branch.behind && snap.operation === null) {
    if (changes.tracked + changes.conflicted > 0) {
      out.push({
        id: 'behind-dirty',
        text: `${upstream} より ${branch.behind} 遅れ。未コミットの変更があるので、取り込みは手動で`,
        tell: true,
      })
    } else {
      out.push({ id: 'behind', text: `${upstream} より ${branch.behind} 遅れ`, pull: true, tell: true })
    }
  }
  if (gone) out.push({ id: 'gone', text: `${upstream} は削除済み。マージ済みなら既定ブランチに戻ってください`, tell: true })
  if (snap.lockSince !== null && now - snap.lockSince >= LOCK_AFTER) {
    out.push({ id: 'lock', text: 'index.lock が残っています。git が動いていなければ削除してください', tell: true })
  }
  if (snap.fetch.failed?.auth) {
    out.push({ id: 'auth', text: 'fetch が認証で失敗しました。このセッションでは定期 fetch を止めます', tell: false })
  }
  if (start !== null && start.ahead > 0 && branch.ahead === start.ahead) {
    out.push({ id: 'unpushed', text: `前回からの未 push ${start.ahead} 件`, tell: true })
  }
  if (start !== null && start.dirty > 0 && files(changes) === start.dirty) {
    out.push({ id: 'uncommitted', text: `前回の未コミット変更 ${start.dirty} ファイル`, tell: true })
  }
  const oldest = snap.stash.oldest
  if (oldest !== null && now - oldest >= settings.stashAgeDays * DAY) {
    out.push({ id: 'stash', text: `stash ${snap.stash.count} 件（最古 ${ago(now - oldest)}）`, tell: false })
  }
  if (tidyHint && snap.tidyCount !== null && snap.tidyCount >= TIDY_HINT_MIN) {
    out.push({ id: 'tidy', text: `upstream が消えたブランチ ${snap.tidyCount} 本 → /git-nudge tidy`, tell: false })
  }
  return out
}

// The one line under the prompt; undefined when there is nothing to say.
export function statusLine(snap: Snapshot, settings: Settings, now: number): string | undefined {
  const { branch, changes } = snap.status
  let sync = ''
  if (branch.head !== null && branch.upstream === null) sync = 'upstream なし'
  else if (isGone(snap)) sync = 'upstream 消滅'
  else {
    sync = [branch.behind ? `↓${branch.behind}` : '', branch.ahead ? `↑${branch.ahead}` : ''].filter(Boolean).join(' ')
  }
  const notes: string[] = []
  if (snap.operation !== null) notes.push(`${snap.operation} 中`)
  const dirty = files(changes)
  if (dirty > 0) notes.push(`未コミット ${dirty}`)
  if (snap.stash.count > 0) notes.push(`stash ${snap.stash.count}`)
  if (snap.lockSince !== null && now - snap.lockSince >= LOCK_AFTER) notes.push('lock')
  const fetchOff = !settings.fetchOnStart && settings.fetchInterval === 0
  const notable = branch.head === null || sync !== '' || notes.length > 0 || snap.fetch.failed !== null
  if (!notable && !(fetchOff && snap.fetch.lastOk !== null)) return undefined
  if (snap.fetch.failed !== null) {
    notes.push(snap.fetch.lastOk === null ? 'fetch 失敗' : `fetch 失敗（最終成功 ${ago(now - snap.fetch.lastOk)}）`)
  } else if (snap.fetch.lastOk !== null) {
    notes.push(`fetch ${ago(now - snap.fetch.lastOk)}`)
  }
  const head = [branch.head ?? 'HEAD 切り離し', sync].filter(Boolean).join(' ')
  return [head, ...notes].join(' · ')
}

// What Claude is told about the notices it should know of, or null.
export function tellText(list: Notice[]): string | null {
  const told = list.filter(notice => notice.tell)
  if (told.length === 0) return null
  return [
    `[git-nudge] このリポジトリの状態: ${told.map(notice => notice.text).join(' / ')}`,
    'これは情報です。ユーザーの指示なしに pull・rebase・push・ブランチの削除をしないでください。',
  ].join('\n')
}

// A dismissed notice stays hidden until its text changes.
export function noticeKey(notice: Notice): string {
  return `${notice.id}:${notice.text}`
}
