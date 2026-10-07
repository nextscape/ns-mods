# git-nudge の変更履歴

## 0.1.0 — 2026-10-07

最初の版です。

- 追加: upstream との差（↓↑）、upstream なし・消滅、未コミットの変更、stash、途中の rebase / merge / cherry-pick / revert / bisect、残った `index.lock`、detached HEAD をステータス行に出す。
- 追加: 手を打てることを帯に出す。遅れていて安全なときは `p` で fast-forward（`git merge --ff-only @{u}`）。数字のホットキーは使わない。
- 追加: 状態が変わったときだけ Claude に伝える。指示なしに pull・rebase・push・ブランチの削除をしないよう添える。
- 追加: `/git-nudge tidy` で、upstream が消えた HEAD にマージ済みのブランチを、確認してから `git branch -d` で消す。
- 追加: 設定は `git config` の `git-nudge.*`（enabled / fetchOnStart / fetchInterval / tellClaude / band / stashAgeDays）。
