import type { LocalBranch } from '../types'

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
