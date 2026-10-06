# ns-mods

Nextscape が公開する Claude Code の mod 集です。mod は、関数フックで書く Claude Code のプラグインです。このリポジトリはマーケットプレイス（`nextscape-mods`）になっていて、使いたい mod だけを選んで入れられます。

## mod 一覧

準備中です。次の mod を追加する予定です。

| mod | 概要 |
|---|---|
| effort-router | プロンプトごとに effort（medium / high / xhigh）を自動で選ぶ。モデルは変えない |
| claude-voice | VOICEVOX による音声通知。長い応答は Haiku で要約して読み上げる（Windows） |

## 導入

ターミナルの Claude Code で、入れたい mod ごとに次を実行します。

```
/plugin install <mod> --marketplace nextscape/ns-mods
```

1. 初めてこのマーケットプレイスを使うときは `Add marketplace?` と聞かれるので、`y` で追加します。
2. 導入先のスコープを選びます（通常はユーザースコープ）。
3. `Installed <mod>. Plugin is now active.` と表示されれば完了です。

更新と削除:

```
claude plugin update <mod>
claude plugin uninstall <mod>
```

各 mod の使い方は、それぞれの README を見てください。

## 注意

- mod の API は早期アクセス版です。Claude Code の版によって仕様が変わり、動かなくなることがあります。表に書いた版で動作を確認しています。
- 導入コマンドはターミナルの Claude Code で実行してください。デスクトップアプリの Code タブでは使えません。ただし、ターミナルからユーザースコープで入れた mod は、デスクトップアプリのローカルセッションでも読み込まれます。

## 開発

```
ns-mods/
├─ .claude-plugin/marketplace.json   mod の一覧
└─ mods/<mod>/                       mod ごとに1つのプラグイン
   ├─ .claude-plugin/plugin.json
   ├─ hooks/                          hooks.json とフックのモジュール
   ├─ types/index.d.ts                $.state の型（使う mod のみ）
   ├─ tests/                          *.test.ts
   └─ README.md
```

手元のクローンをマーケットプレイスとして追加すると、プラグインはクローンしたフォルダから直接読み込まれます。編集したら `/reload-plugins` で反映できます。

```bash
claude plugin marketplace add <このリポジトリのパス>
claude plugin install <mod>@nextscape-mods
```

確認に使うコマンド:

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
4. 版は mod ごとに `plugin.json` の `version` で管理する。タグは `<mod>-v<版>` とする（例 `effort-router-v0.5.0`）。

## ライセンス

[MIT](LICENSE)
