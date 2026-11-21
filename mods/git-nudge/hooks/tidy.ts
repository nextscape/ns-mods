import type { GoneBranch, LocalBranch } from '../types'

const HEADS = 'refs/heads/'

// Local branches tracking a branch on `remote` that the remote no longer has
// (`heads` is what `git ls-remote --heads <remote>` listed).
export function withGoneUpstream(branches: LocalBranch[], heads: ReadonlySet<string>, remote: string): LocalBranch[] {
  return branches.filter(
    branch =>
      branch.remote === remote &&
      branch.remoteRef !== null &&
      branch.remoteRef.startsWith(HEADS) &&
      !heads.has(branch.remoteRef.slice(HEADS.length)),
  )
}

// What tidy may offer: those not checked out anywhere (the current branch is
// checked out here, and git refuses to delete one checked out elsewhere).
export function tidyCandidates(branches: LocalBranch[], heads: ReadonlySet<string>, remote: string): LocalBranch[] {
  return withGoneUpstream(branches, heads, remote).filter(branch => branch.worktree === null)
}

// The remote-tracking ref a branch's upstream is fetched into, under the
// default refspec; null when the branch tracks no branch on a remote.
export function trackingRef(branch: LocalBranch): string | null {
  if (branch.remote === null || branch.remoteRef === null || !branch.remoteRef.startsWith(HEADS)) return null
  return `refs/remotes/${branch.remote}/${branch.remoteRef.slice(HEADS.length)}`
}

// What to remember of the branches ls-remote just found gone. `refs` is what
// their remote-tracking refs point at now; null when that could not be read.
export function goneBranches(lost: LocalBranch[], refs: ReadonlyMap<string, string> | null): GoneBranch[] {
  return lost.map(branch => ({
    name: branch.name,
    tracking: refs === null ? null : (refs.get(trackingRef(branch) ?? '') ?? ''),
  }))
}

// The remembered branches that are still gone, judged without asking the
// remote. A branch deleted here since is dropped, and so is one whose
// remote-tracking ref moved: only a push or a fetch of that branch moves it,
// so the remote has it again. A ref missing now was pruned, and one that
// cannot be compared says nothing: those branches stay gone.
export function stillGone(gone: GoneBranch[], branches: LocalBranch[], refs: ReadonlyMap<string, string> | null): GoneBranch[] {
  return gone.filter(one => {
    const branch = branches.find(local => local.name === one.name)
    if (branch === undefined) return false
    const ref = trackingRef(branch)
    if (ref === null) return false
    if (refs === null || one.tracking === null) return true
    const now = refs.get(ref)
    return now === undefined || now === one.tracking
  })
}

// How many of the gone branches tidy would list (see tidyCandidates).
export function countTidy(gone: GoneBranch[], branches: LocalBranch[]): number {
  const names = new Set(gone.map(one => one.name))
  return branches.filter(branch => names.has(branch.name) && branch.worktree === null).length
}

export type TidyPlan = { deletable: LocalBranch[]; unconfirmed: LocalBranch[] }

// `merged` holds the branches HEAD contains (`git for-each-ref --merged
// HEAD`). Only those are deleted, so no commit is lost; `git branch -d` alone
// would also accept a squashed branch whose stale remote-tracking ref holds it.
export function planTidy(candidates: LocalBranch[], merged: ReadonlySet<string>): TidyPlan {
  return {
    deletable: candidates.filter(branch => merged.has(branch.name)),
    unconfirmed: candidates.filter(branch => !merged.has(branch.name)),
  }
}

// The listing tidy shows before it asks. `onDefault` is whether HEAD is the
// remote's default branch; null when that is unknown.
export function describeTidy(plan: TidyPlan, prunable: string[], onDefault: boolean | null): string {
  const out: string[] = []
  if (plan.deletable.length + plan.unconfirmed.length === 0) out.push('upstream が消えたブランチはありません。')
  if (plan.deletable.length > 0) {
    out.push(`消せるブランチ（HEAD にマージ済み）: ${plan.deletable.length} 本`)
    for (const branch of plan.deletable) out.push(`  ${branch.name}`)
  }
  if (plan.unconfirmed.length > 0) {
    out.push(`マージを確認できないブランチ（消しません）: ${plan.unconfirmed.length} 本`)
    for (const branch of plan.unconfirmed) {
      out.push(`  ${branch.name}（自分で確かめて消すなら: git branch -D ${branch.name}）`)
    }
    if (onDefault === false) out.push('既定ブランチに移ってから実行すると、より多く片付けられます。')
  }
  if (prunable.length > 0) {
    out.push(`ディレクトリが無い worktree: ${prunable.length} 件（消すなら: git worktree prune）`)
    for (const path of prunable) out.push(`  ${path}`)
  }
  return out.join('\n')
}

export function deletedReport(done: LocalBranch[], failed: Array<{ name: string; message: string }>): string {
  const out: string[] = []
  if (done.length > 0) {
    out.push(`消しました: ${done.length} 本（戻すときは、各行のコマンドを実行）`)
    for (const branch of done) out.push(`  git branch ${branch.name} ${branch.oid}`)
  }
  if (failed.length > 0) {
    out.push(`消せませんでした: ${failed.length} 本`)
    for (const one of failed) out.push(`  ${one.name}: ${one.message}`)
  }
  return out.join('\n')
}
