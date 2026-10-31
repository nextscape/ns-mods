# superpowers-progress — Superpowers の作業の全体と現在地を見る

> **English summary**: superpowers-progress is a Claude Code mod that shows a [Superpowers](https://github.com/obra/superpowers)
> run in a pane beside the chat: the plan's title, where the workflow is (design › plan › build › finish), the current
> task and its step (implement → review → fix round R/5 → re-review), a progress bar with done and remaining counts, and
> the controller's rulings, parked findings and deferred minors from the ledger. It reads the plan file and the
> subagent-driven-development ledger, and the Task / TodoWrite tools when those are used. It calls no model and sends
> nothing anywhere. Install: `/plugin install superpowers-progress --marketplace nextscape/ns-mods`.

Claude Code の mod（関数フックで書くプラグイン）です。Superpowers で分割したタスクを進めているあいだ、会話の横のペインに、作業の全体と今どこにいるかを出します。

「Agent が Task8 を実行中です」と出ていても、全部でいくつあるのか、もうすぐ終わるのか、まだ半分なのかは分かりません。この mod は、それを Agent に聞かずに一目で分かるようにします。

**モデルは呼びません。** 読むのはセッションのフォルダの中の計画ファイルと台帳だけで、どこにも送りません。

## 導入

```
/plugin install superpowers-progress --marketplace nextscape/ns-mods
```

新しいセッションを開くと読み込まれます。

| 項目 | 内容 |
|---|---|
| Claude Code | 2.1.314 で検査とテストが通ることを確認 |
| Superpowers | subagent-driven-development の台帳（`.superpowers/sdd/<計画>/progress.md`）を使う版 |
| OS | 問いません |

## 使い方

入れるだけで動きます。SDD が台帳を書き始めるか、Agent がタスクを作ると、ペインが開きます。閉じたあとは `/superpowers-progress` で開き直せます。

```
検索画面の絞り込み
設計 ✔ › 計画 ✔ › [実装] › 仕上げ
───────────────────────────────
実行中
▼ Task4: 絞り込みの画面
  実装 ✔ → レビュー ✔ → 修正 2/5 …

██████████░░░░░░░░░░ 3/6
完了 3　/　残り 3

▼ 判断 3・保留 1・後回し 2
```

| 行 | 内容 |
|---|---|
| 1行目 | 計画ファイルの見出し（末尾の「Implementation Plan」は外す） |
| 工程 | 呼ばれた Superpowers のスキルから、設計（brainstorming）・計画（writing-plans）・実装（subagent-driven-development / executing-plans）・仕上げ（finishing-a-development-branch）のどこにいるか |
| 今のタスク | 完了していない最初のタスク。brief（`task-N-brief.md`）があれば「実行中」 |
| 段階 | 今のタスクで、SDD が最後に呼んだ役割。全タスクのあとは最終レビュー・最終修正 |
| 進捗 | 完了数と残り数。残りには実行中のタスクも含む |
| 判断 | 台帳の Ruling・parked・deferred の行の数 |

▼ の行はクリックで開きます（ペインにフォーカスがあれば Tab で選んで Enter でも）。開くと ▲ になり、もう一度押すと閉じます。タスクの行はタスク一覧を、判断の行は台帳の行そのものを開きます。開けるのはどちらか一方です。

ペインは、ターミナルの幅が足りないと表示を待ちます（Claude Code の決まり）。出ないときは `/superpowers-progress` で開いてください。

## 仕組み

- メインの Agent がツールを使い終わるたびに、`.superpowers/sdd/` の中で台帳が一番新しい計画を読み直します。サブエージェントの呼び出しは数えません。
- 計画ファイルの `### Task N: 名前` をタスクとして数え、台帳の `Task N: complete` を完了とします。
- 段階は、SDD のプロンプトの型（`Implement Task N`、`Review Task N`、`Re-review Task N fix round R`、`fix round N` を含む修正の依頼、最終レビュー）から見分けます。Superpowers が型を変えると、段階の表示がずれることがあります。
- TaskCreate・TaskUpdate・TodoWrite で作ったタスクも表示します。台帳と両方あるときは、新しく更新されたほうを出します。

## 開発

```bash
claude plugin validate mods/superpowers-progress
claude plugin test mods/superpowers-progress
```

型検査は、mod を一度読み込んで `.claude-plugin/types/` ができてから `tsc -p mods/superpowers-progress` で行います。
