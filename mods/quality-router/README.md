# quality-router

Claude Code の作業に合わせて、**Effort（推論の深さ）とモデルを自動で選ぶ** mod です。
方針は「品質を外さない」ことです。難しい依頼や議論の最中に浅い設定で動くのを防ぎ、軽い作業には軽い設定を割り当てます。

| 機能 | 内容 | 既定 |
|---|---|---|
| 本体の Effort | 依頼ごとに、Effort を medium / high / xhigh / max から選びます | on |
| スキル連動の下限 | 壁打ち・計画・原因調査・レビューのスキルが呼ばれたら、Effort の下限を引き上げます | on |
| 途中の格上げ | ツールのエラーが2回続いたら、Effort を1段上げます | on |
| サブエージェントの振り分け | Agent ツールで起動するサブエージェントに、作業の種類と重さでモデルと Effort を割り当てます | on |
| Workflow の点検 | Workflow の各 `agent()` が、作業の種類ごとの下限・上限に収まっているかを確かめ、外れていれば差し戻します | on |
| 判定の記録 | 判定とその結果を手元に記録し、`/qr stats` で集計します（本文は記録しません） | on |
| 本体モデルの守り | 会話の相手のモデルが Sonnet などになったら、上位モデル（Opus など）に戻します | **off**（`/qr guard on` で有効） |

## 導入

ns-mods の README の手順で入れます。

```
/plugin install quality-router --marketplace nextscape/ns-mods
```

- Claude Code 2.1.287 以降が必要です。2.1.292 で動作を確かめています。
- 新しく開いたセッションから効きます。
- 入ったことは、画面下の状態表示（`v0.3.1 · main … · sub … · gate on`）か、`/qr version` で確かめられます。

## 使い方

入れるだけで動きます。設定を変えたいときは、次のコマンドを使います。`/qr` と `/quality-router` は同じ働きです（`/qr` がほかのコマンドと重なるときは `/quality-router` を使ってください）。

| コマンド | 動作 |
|---|---|
| `/qr` | 現在の設定と直近の判定を表示します |
| `/qr on` / `/qr off` | 本体の Effort、本体モデルの守り、サブエージェントの振り分けをまとめて有効・無効にします |
| `/qr gate on` / `/qr gate off` | Workflow の点検を有効・無効にします |
| `/qr guard on` / `/qr guard off` | 本体モデルの守りを有効・無効にします（既定は off） |
| `/qr floor <段階>` / `/qr ceiling <段階>` | 本体の Effort の下限・上限を変えます（medium / high / xhigh / max。既定は medium / max） |
| `/qr top opus` / `/qr top fable` | 上位モデルを変えます（既定は opus） |
| `/qr skill clear` | スキル連動の下限を解除します |
| `/qr up` / `/qr down`（`/qr up sub` で直前のサブエージェント） | 直前の判定が浅すぎた・重すぎたと記録します |
| `/qr stats` / `/qr stats today` / `/qr stats 30d` | 判定の記録を集計して表示します（既定は直近7日） |
| `/qr log` / `/qr log main` / `/qr log sub` / `/qr log gate` | 判定・振り分け・点検の直近の記録を表示します |
| `/qr eval` | 同梱の評価用の例文を実際に判定させ、判定の精度を採点します |
| `/qr version` | 動いている版と読み込み元のフォルダを表示します |

設定は手元に保存され、次のセッションにも引き継がれます。

### 状態表示

```
v0.3.1 · main xhigh (judged medium, skill: brainstorming) · sub 2 · gate on
```

| 表示 | 意味 |
|---|---|
| `v0.3.1` | 動いている版 |
| `main xhigh` | 会話の相手がいま使っている Effort の段階 |
| `judged medium` | 判定は medium だったが、下限などで引き上げたこと |
| `skill: brainstorming` | スキル連動の下限が効いていること |
| `+1` | ツールのエラーが続いたため、途中で1段上げたこと |
| `main sonnet! high` | 本体モデルの守りが on で、会話の相手を上位モデルに戻せなかったこと |
| `main paused (effort-router)` | effort-router に本体の Effort を任せていること |
| `sub 2` | このセッションで振り分けたサブエージェントの数 |
| `gate on` | Workflow の点検が有効なこと |

### effort-router と一緒に使うとき

effort-router（同じマーケットプレイスの mod）も、本体の Effort を選びます。両方を入れたときは、**本体の Effort は effort-router に任せ**、quality-router は次を続けます。

- サブエージェントの振り分け
- Workflow の点検
- 本体モデルの守り（on にしているとき）
- 判定の記録（本体のターンの判定は effort-router が行うので、本体ターンの記録は残しません）

effort-router が入っていることは、ユーザー設定と、読み込まれているコマンドの一覧から、どのスコープで入れても検知します。検知したときは、通知で一度だけ知らせ、状態表示に `main paused (effort-router)` と出します。本体の Effort も quality-router で選びたいときは、effort-router を外してください。

### 組み込みの `/effort` との関係

本体の Effort の振り分けが有効な間は、組み込みの `/effort` で選んだ段階も、次の依頼で上書きします。段階を固定したいときは `/qr off` にしてから `/effort` を使ってください。

## Workflow を書く人へ

Workflow の各 `agent()` には、ラベルの頭に作業の種類を書き、その種類の下限と上限の範囲で、モデルと Effort（重さ）を明示してください。規則に合わないスクリプトは、直し方を添えて差し戻します。規則はシステムプロンプトにも入っているので、Claude が自分で書き直します。

| ラベルの頭 | 対象の作業 | 下限 | 上限 | 例（軽い／重い） |
|---|---|---|---|---|
| `chore:` | 一覧・収集・抽出・整形・コミット | haiku・low | sonnet・medium | 件数を数える＝haiku・low／コミット＝sonnet・medium |
| `impl:` | 修正・機能追加 | sonnet・medium | なし | 名前の変更＝sonnet・high／設計を伴う実装＝上位・xhigh |
| `investigate:` | 調べもの・原因調査・報告 | sonnet・medium | なし | API の調べもの＝sonnet・high／原因調査＝上位・xhigh |
| `verify:` | テストの実行・事実の照合など、根拠が機械的に得られる確認 | sonnet・high | なし | テストを流す＝sonnet・high／報告を API で照合＝上位・high |
| `review:` | 差分や設計の良し悪しの評価 | 上位・high | なし | 小さな差分＝上位・high／設計レビュー＝上位・xhigh 以上 |
| `refute:` | 結論を崩しにいく | 上位・high | なし | — |
| `decide:` | 方針や合否を決める | 上位・high | なし | — |
| `fix:` | 指摘を受けたやり直し | 上位・high、または LADDER の展開 | なし | 段を1つ以上上げる（`...LADDER[tier + 1]`） |

- 「上位」は Opus 系・Fable 系・Mythos 系のモデルです。Fable は正式ID `claude-fable-5-1` で書きます。
- 力量は、モデルの格を先に比べ、同じなら Effort を比べます。model を省くと会話の相手のモデル（上位）を引き継ぎます。たとえば上位・low は sonnet・medium より強く、sonnet・xhigh は上位・high より弱い扱いです。
- `fix:` 以外は、`effort` を文字列で書くか、添字が数字の `...LADDER[n]` を展開してください（力量を読めないと差し戻します）。
- `chore:` で model を省くと上位とみなされ、上限（sonnet・medium）を超えて差し戻されます。`...LADDER[0]` か `...LADDER[1]` を使ってください。

```js
const LADDER = [
  { model: 'haiku', effort: 'low' },
  { model: 'sonnet', effort: 'medium' },
  { model: 'opus', effort: 'high' },
  { model: 'opus', effort: 'xhigh' },
  { model: 'opus', effort: 'max' },
]
await agent(prompt, { label: 'chore:scan', ...LADDER[1] })
await agent(prompt, { label: 'impl:impl', effort: 'high' })
await agent(prompt, { label: 'review:diff', model: 'opus', effort: 'xhigh' })
await agent(prompt, { label: `fix:${n}`, ...LADDER[tier + 1] })
```

- オプションは `agent()` の中に直接書いてください。変数で渡すと点検できないため、差し戻します。
- 展開（`...`）は `...LADDER[n]` だけが使えます。ほかの展開は点検できないため、差し戻します。
- 保存済みの Workflow（`.claude/workflows/` に置いたもの）は、規則に合わなくても通知だけして通します。

## 費用・待ち時間・送るデータ

| 項目 | 内容 |
|---|---|
| Haiku の呼び出し | 依頼ごと（20文字以上）に1回。振り分けの対象のサブエージェントを起動するたびに2回（種類と重さを同時に） |
| 待ち時間 | 1回あたり約1秒。本体の判定は最大5秒待ち、間に合わなければ前の段階を引き継いで進みます |
| 送るデータ | 本体：依頼の冒頭と末尾、前の回答の末尾。サブエージェント：説明と指示の冒頭と末尾。送り先は Claude Code 自身の接続（Anthropic）だけで、第三者には送りません |
| 使用量 | 判定の分も、利用者のプランまたは API キーの使用量に数えられます |
| 手元に残るデータ | 下の「判定の記録」と、`/qr log` 用の直近200件（依頼は冒頭40文字だけ） |

### 判定の記録

判定の改善に使うため、判定とその結果を手元に記録します。

- 場所：`~/.claude/quality-router/log/YYYY-MM/<セッションID>.jsonl`（1行が1件）
- 記録するもの：
  - 本体の1ターンごとの判定（段階・決まり方・効いた下限）と結果（ステップ数・ツールエラー数・所要時間・トークン量）
  - サブエージェントと Workflow の子の割り当てと結果
  - Workflow の点検の結果
  - 好みの手がかり：組み込みの `/effort`・`/model` を手で変えたこと、`/qr up`・`/qr down`、同じ作業のやり直しが3回目になったこと
- **依頼や応答の本文は書きません。** 文字数と、会話ログの行を指す ID だけを残します。
- 記録は手元にだけ残り、どこにも送りません。
- `/qr off` の間は、本体ターンの記録と手動の `/effort`・`/model` の記録は止まります。サブエージェントや Workflow の記録、`/qr up`・`/qr down` は続きます。
- 記録のフォルダは消してかまいません。動いているセッションは次の記録で自分のファイルを書き直すので、消すのはセッションを閉じてからにしてください。

## 仕組み

### 本体の Effort

- 判定は Claude Haiku が行い、前のやり取りの様子（前の段階、ステップ数、ツール数、エラー数、所要時間、前の依頼と回答の抜粋）も材料にします。
- 上げるのは即座、下げるのは1回の依頼につき1段までです。20文字未満の短い返事（「続けて」など）は、前の段階を引き継ぎます。
- 1回の依頼の中では段階を下げません。
- Effort を変えても、プロンプトのキャッシュは無効になりません（実測で確かめています）。

### スキル連動の下限

| スキル | 下限 |
|---|---|
| `superpowers:brainstorming`、`superpowers:writing-plans`、`superpowers:systematic-debugging` | xhigh |
| `code-review`、`superpowers:requesting-code-review`、`superpowers:receiving-code-review` | xhigh |
| `superpowers:executing-plans`、`superpowers:subagent-driven-development`、`superpowers:test-driven-development` | high |

表にないスキルを呼んでも、下限は変わりません。

### サブエージェントの振り分け

作業の種類と重さ（軽い・重い）を Claude Haiku が同時に判定し、次の表で割り当てます。

| 種類 | 軽い（light） | 重い（heavy） |
|---|---|---|
| `chore` 機械的な作業（一覧・収集・抽出・整形・コミット） | Sonnet・medium | Sonnet・medium |
| `impl` 実装 | Sonnet・high | 会話の相手と同じ・high |
| `investigate` 調査・報告 | Sonnet・high | 会話の相手と同じ・xhigh |
| `verify` 検証（テストの実行・事実の照合） | Sonnet・high | 上位モデル・high |
| `review` レビュー | 上位モデル・high | 上位モデル・xhigh（会話の相手が max なら max） |
| `refute` 反証 | 上位モデル・xhigh | 上位モデル・xhigh（会話の相手が max なら max） |
| `decide` 判断 | 上位モデル・high | 上位モデル・xhigh（会話の相手が max なら max） |
| 種類が判定できない・判定に失敗した | 触らない | 触らない |

- 種類は判定できたが重さが判定できなかったときは、重い（heavy）として扱います。
- 同じ説明のサブエージェントが起動されたらやり直しとみなし、前回より1段上げます。3回目は通知で知らせます。
- 独自に定義したサブエージェント（`.claude/agents/` などで作ったもの）や、モデルを明示して起動したものには触りません。

### 本体モデルの守り（既定 off）

`/qr guard on` にすると、会話の相手のモデルが Opus 系・Fable 系以外（Sonnet など）になったとき、上位モデルの正式IDに直して送ります。直せないとき（プランや設定で使えないなど）は、元のモデルのまま続け、通知で知らせます。上位モデルを使う分、使用量は増えます。

## 止める・外す

- 一時的に止める：`/qr off`（Workflow の点検も止めるなら `/qr gate off`）
- 外す：`claude plugin uninstall quality-router`。新しいセッションから外れます。手元の記録と設定は残るので、要らなければ `~/.claude/quality-router/` を消してください。

## 制約と既知の課題

- 試験版です。判定がおかしいと感じたら、`/qr log main` の表示を添えて [GitHub Issues](https://github.com/nextscape/ns-mods/issues) で知らせてください。
- 本体の Effort の判定は、Opus 系・Sonnet 系・Fable 系など、Effort を受け付けるモデルで効きます。
- mod の API は新しく、Claude Code の版によって動かなくなることがあります。

## 変更履歴

[CHANGELOG.md](CHANGELOG.md) を見てください。

## 出典

本体の Effort の判定の仕組みと、評価用の例文の一部は、このマーケットプレイスの effort-router（0.3.0）を元にしています。

## ライセンス

[MIT](../../LICENSE)
