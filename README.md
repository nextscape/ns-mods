# ns-mods

> **English summary**: A collection of Claude Code mods published by Nextscape Inc., served as a plugin
> marketplace (`nextscape-mods`) so you can install only the mods you want.
> Install one with `/plugin install <mod> --marketplace nextscape/ns-mods`. Requires Claude Code 2.1.287 or later.
> The documentation is in Japanese.

Nextscape が公開する Claude Code の mod 集です。

mod は、Claude Code の中で動く関数フック（JavaScript / TypeScript）を持つプラグインです。プロンプトやツール呼び出し、ターンの開始・終了などのたびに呼ばれ、Claude Code の動きを変えたり、画面に表示を足したりできます（[公式ドキュメント: Mods overview](https://code.claude.com/docs/en/plugins/mods/overview)）。

このリポジトリはマーケットプレイス（`nextscape-mods`）になっていて、使いたい mod だけを選んで入れられます。

## mod 一覧

| mod | 概要 | 対応 | Haiku の呼び出し |
|---|---|---|---|
| [effort-router](mods/effort-router/) | プロンプトごとに effort（low / medium / high / xhigh）を自動で選ぶ。モデルは変えない | Opus / Sonnet 5.5 以降、Fable / Mythos 5.1 以降。OS は問わない | 判定のたびに1回 |
| [voice-notify](mods/voice-notify/) | VOICEVOX による音声通知。長い応答は Haiku で要約して読み上げる | Windows 10 / 11（macOS・Linux は試験的）と VOICEVOX。CLI のみ | 30秒を超えたターンの終わりなどに1回 |
| [git-nudge](mods/git-nudge/) | git の遅れ（pull 忘れ）・置き忘れ・upstream が消えたブランチを知らせ、安全な取り込みと片付けを手伝う | git 2.29 以降。OS は問わない | 呼ばない |

effort-router は Claude Code 2.1.291、voice-notify と git-nudge は 2.1.292 で動作を確認しています。

## 導入

ターミナルの Claude Code で、入れたい mod ごとに次を実行します。

```
/plugin install <mod> --marketplace nextscape/ns-mods
```

1. 初めてこのマーケットプレイスを使うときは、追加してよいか聞かれるので、承認して追加します。
2. 導入先のスコープを選びます（通常はユーザースコープ）。
3. `Installed <mod>. Plugin is now active.` と表示されれば完了です。
4. 新しいセッションを開くと、mod が読み込まれます。続けて設定が要る mod もあるので、各 mod の README を見てください。

マーケットプレイスを先に追加してから入れる手順でもかまいません。

```
/plugin marketplace add nextscape/ns-mods
/plugin install <mod>@nextscape-mods
```

更新と削除はシェルから実行します（Claude Code の中では `/plugin` の画面からも操作できます）。

```
claude plugin update <mod>
claude plugin uninstall <mod>
```

更新は、新しいセッションを開くと反映されます。mod によっては、削除の前に後片付けのコマンドがあります（voice-notify の `/voice-notify remove` など）。

## 導入する前に

| 項目 | 内容 |
|---|---|
| Claude Code の版 | mod は Claude Code 2.1.287 以降で既定で有効です。古い版では読み込まれません。mod の API は新しく、Claude Code の版によって仕様が変わり、動かなくなることがあります。動作を確認した版は上に書いています |
| 使用量 | effort-router と voice-notify は Claude Haiku を呼びます（git-nudge は呼びません）。mod のモデル呼び出しは、利用者のプランまたは API キーを使います（[公式ドキュメント](https://code.claude.com/docs/en/plugins/mods/api.md#call-a-model)）。呼ぶ頻度と送る内容は、各 mod の README の「費用」「データ」の節に書いています |
| 権限 | mod は利用者の権限で動き、ファイルやネットワークにアクセスできます。導入前に何をするかを確かめたいときは、クローンして `claude plugin validate mods/<mod>` を実行すると、使うイベントと API の一覧が出ます |
| 使う場所 | 導入コマンドはターミナルの Claude Code で実行してください。ターミナルからユーザースコープで入れた mod は、デスクトップアプリの Code タブのローカルセッションでも読み込まれます |

## 不具合の報告・質問

[GitHub Issues](https://github.com/nextscape/ns-mods/issues) で受け付けます。対応は可能な範囲で行います（無保証です。[LICENSE](LICENSE) を見てください）。報告には、mod の名前と版、Claude Code の版（`claude --version`）、OS を書いてください。

## 開発

```
ns-mods/
├─ .claude-plugin/marketplace.json   mod の一覧
├─ .github/workflows/ci.yml          検査とテスト（push / pull request ごと）
└─ mods/<mod>/                       mod ごとに1つのプラグイン
   ├─ .claude-plugin/plugin.json      マニフェスト（名前、版）
   ├─ hooks/                          hooks.json とフックのモジュール
   ├─ types/index.d.ts                $.state の型（使う mod のみ）
   ├─ tests/                          *.test.ts（mod によっては PowerShell のテストも）
   ├─ CHANGELOG.md
   └─ README.md
```

mod によっては、ほかに `commands/`（スラッシュコマンド）や `scripts/` を持ちます。

手元のクローンをマーケットプレイスとして追加すると、プラグインはクローンしたフォルダから直接読み込まれます。編集したら `/reload-plugins` で反映できます。

```bash
claude plugin marketplace add <このリポジトリのパス>
claude plugin install <mod>@nextscape-mods
```

確認に使うコマンド（CI でも同じものを実行します）:

```bash
claude plugin validate .                    # マーケットプレイスの検査
claude plugin validate mods/<mod>           # マニフェストとフックの検査
claude plugin test mods/<mod>               # tests/*.test.ts の実行
```

`mods/<mod>/tsconfig.json` と `mods/<mod>/.claude-plugin/types/` は、エンジンが mod を読み込んだときに生成します。リポジトリには含めません。

### mod を追加するとき

1. `mods/<mod>/` を作り、`plugin.json` の `name` をフォルダ名と同じにする。
2. `.claude-plugin/marketplace.json` の `plugins` に1件追加する。
3. このファイルの mod 一覧に1行追加する。
4. README には、導入、使い方、費用とデータ（モデルを呼ぶ場合）、仕組みを書く。

### 版とリリース

1. 版は mod ごとに `plugin.json` の `version` で管理し、`CHANGELOG.md` に変更点を書く。
2. コミットしたら `claude plugin tag mods/<mod>` でタグを作る。タグは `<mod>--v<版>`（例 `effort-router--v0.8.0`）になる。このコマンドは、`plugin.json` とマーケットプレイスの記載が食い違っていないかも確かめる。
3. タグを push する。

## ライセンス

[MIT](LICENSE)
