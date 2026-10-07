# git-nudge — git のうっかりに気づかせる

> **English summary**: git-nudge is a Claude Code mod that watches the session's git repository and tells you,
> under the prompt and in a band above it, when it falls behind its upstream (a forgotten pull), keeps commits
> you have not pushed, has uncommitted changes or old stashes from before, is in the middle of a rebase or merge,
> has a stale `index.lock`, or keeps branches whose upstream is gone. It tells Claude when that changes.
> It changes the repository only three ways: `git fetch` (never pruning), a fast-forward you ask for, and
> `git branch -d` of merged branches after you confirm. It calls no model and sends nothing anywhere but your own
> git remotes. Install: `/plugin install git-nudge --marketplace nextscape/ns-mods`. Needs git 2.29 or later.

Claude Code の mod（関数フックで書くプラグイン）です。セッションの git リポジトリを見張り、次のことをプロンプトの下と上に知らせます。

- upstream より遅れている（pull 忘れ）。未コミットの変更が無ければ、`p` で取り込める
- 前回から push していないコミットや、前回の未コミット変更が残っている
- 古い stash、途中で止まった rebase / merge、残った `index.lock`
- upstream が消えたブランチ（マージ済みの PR のブランチなど）。`/git-nudge tidy` でまとめて片付けられる

状態が変わったときは、Claude にも伝えます。Claude には「ユーザーの指示なしに pull・rebase・push・ブランチの削除をしない」と添えます。

**モデルは呼びません。** ネットワークに出るのは、利用者の remote への `git fetch` と `git ls-remote` だけです。

## 導入

```
/plugin install git-nudge --marketplace nextscape/ns-mods
```

新しいセッションを開くと読み込まれます。

| 項目 | 内容 |
|---|---|
| Claude Code | 2.1.287 以降（mod が既定で有効になる版）。2.1.292 で動作を確認 |
| git | 2.29 以降。古い版では何もしません（`/git-nudge` で理由を表示） |
| OS | 問いません |

## 使い方

入れるだけで動きます。git リポジトリの中でセッションを開くと、裏で fetch して状態を調べます。

### ステータス行（プロンプトの下）

知らせることがあるときだけ、1行で出します。

```
main ↓3 ↑1 · 未コミット 5 · stash 2 · fetch 3分前
```

`↓` は upstream にあって手元に無いコミット、`↑` は手元にあって upstream に無いコミットの数です。ほかに `upstream なし`、`upstream 消滅`、`rebase 中`、`lock`、`HEAD 切り離し`、`fetch 失敗` を出します。

### 帯（プロンプトの上）

手を打てることがあるときだけ、最大2行で出します。

```
origin/main より 3 遅れ  p: 取り込む  x: 閉じる
```

- ボタンは、帯にフォーカスを移してから押します（**Ctrl+X → Tab**、またはクリック）。プロンプトに文字を打っても押されません。
- `p: 取り込む` は、遅れていて、追跡中のファイルに変更が無く、手元に独自のコミットも無いときだけ出ます。`git merge --ff-only @{u}` を実行し、戻すためのコマンドを表示します。Claude の作業中は出ません。
- `x: 閉じる` で隠した項目は、状態が変わるまで出ません。

### コマンド

| コマンド | 動作 |
|---|---|
| `/git-nudge` | 状態を取り直して表示（fetch もする） |
| `/git-nudge pull` | 取り込み（帯の `p` と同じ） |
| `/git-nudge tidy` | upstream が消えたブランチの片付け |
| `/git-nudge off` / `on` | このセッションだけ止める／再開する |

### 片付け（`/git-nudge tidy`）

1. remote にもう無いブランチを追跡しているローカルブランチを集めます（今いるブランチと、別の worktree で使っているブランチは除きます）。
2. 今の HEAD にマージ済みのものだけを「消せる」とし、確認してから `git branch -d` で消します。消したブランチは、戻すためのコマンド（`git branch <名前> <SHA>`）を表示します。
3. squash マージなどでマージを確認できないブランチは消しません。一覧と、自分で消すためのコマンドを示すだけです。
4. ディレクトリが無くなった worktree も一覧にします（消すコマンド `git worktree prune` は自分で実行してください）。

## 設定

`git config` で設定します。`--global` で全体、付けなければそのリポジトリだけに効きます。

```
git config --global git-nudge.fetchInterval 0     # 定期 fetch をやめる
git config git-nudge.enabled false                # このリポジトリでは使わない
```

| キー | 既定 | 内容 |
|---|---|---|
| `git-nudge.enabled` | `true` | `false` で、そのリポジトリでは何もしない |
| `git-nudge.fetchOnStart` | `true` | セッション開始時に fetch する |
| `git-nudge.fetchInterval` | `5` | 定期 fetch の間隔（分）。`0` でオフ |
| `git-nudge.tellClaude` | `true` | 状態が変わったときに Claude へ伝える |
| `git-nudge.band` | `true` | 帯を出す。`false` ならステータス行だけ |
| `git-nudge.stashAgeDays` | `7` | 何日より古い stash を帯で知らせるか |

読めない値は無視し、`/git-nudge` の「設定の問題」に表示します。

## 費用とデータ

| 項目 | 内容 |
|---|---|
| モデル | 呼びません |
| ネットワーク | 利用者の remote への `git fetch` と `git ls-remote`（開始時と、既定で5分ごと。同じリポジトリを複数のセッションで開いていても重ねません） |
| 認証 | ログインの入力や画面は出しません（`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`）。認証に失敗したら、そのセッションでは定期 fetch を止めて知らせます |
| 手元に残るもの | Claude Code の mod 用の保存領域（`~/.claude/plugins/store/`）に、リポジトリごとの最後の fetch の時刻と、片付けの案内を出した日 |

## 仕組み

| 場面 | すること |
|---|---|
| セッション開始 | 開始を待たせずに、裏で fetch と状態の取得 |
| 定期（既定5分） | fetch と状態の取得 |
| Claude のターンの終わり | 状態の取得だけ（fetch しない）。Claude のコミットや push をすぐ反映する |
| プロンプトの送信 | 伝える内容が前回と変わっていれば、Claude への文脈に足す |

- 状態は `git status --porcelain=v2 --branch`（`--no-optional-locks` 付き。`index.lock` を取らない）、`git stash list`、`git rev-parse --git-path` で見つけた rebase / merge などの印、`git ls-remote --heads` で調べます。
- fetch は `--prune` を付けず、git の自動メンテナンスも走らせません。
- mod が状態を変えるのは、fetch、頼まれたときの fast-forward、確認した後の `git branch -d` の3つだけです。push、ブランチの切り替え、`index.lock` の削除、`git branch -D`、worktree の削除はしません（知らせるだけ）。

## 制約と既知の課題

- 見張るのは、セッションの作業ディレクトリを含むリポジトリ1つです。
- 帯は、ターミナルと Desktop アプリにだけ出ます（VS Code 拡張と `claude -p` では出ません。Claude への伝達とステータス行は動きます）。
- 片付けは対話できるセッションでだけ動きます。
- mod の API は新しく、Claude Code の版によって仕様が変わり、動かなくなることがあります。

## 開発

```
claude plugin validate mods/git-nudge
claude plugin test mods/git-nudge
bash mods/git-nudge/tests/make-fixtures.sh   # 本物の git で tests/fixtures.ts を作り直す（git と node が必要）
```

## 変更履歴

[CHANGELOG.md](CHANGELOG.md)

## ライセンス

MIT（リポジトリの [LICENSE](../../LICENSE)）
