# voice-notify — Claude Code の音声通知

> **English summary**: voice-notify speaks Claude Code events aloud on Windows using VOICEVOX
> (turn finished, waiting for permission, subagent reports, errors). Long turns are summarized
> into one spoken sentence by Claude Haiku via an in-session mod (`$.model.complete`) —
> no extra API key, and nothing is added to your conversation context. Windows 10/11 and VOICEVOX are required.
> Install: `/plugin marketplace add nextscape/ns-mods`, `/plugin install voice-notify@nextscape-mods`, then run `/voice-notify:setup`.

Claude Code のターン完了・許可待ち・サブエージェントの報告・エラーなどを、VOICEVOX の声で知らせます。
作業時間の長いターンは、応答を **Claude Haiku** で1文に要約して読み上げます。

- 要約は Claude Code の中で動く mod が行います。**API キーは不要**で、要約のやり取りは**会話に入りません**
- 鳴らす・黙るの判断（短いターンは完了だけ告げる、会議中は黙る等）はすべてローカルで行います

## 前提

| 項目 | 内容 |
|---|---|
| OS | Windows 10 / 11（Windows PowerShell 5.1 で動きます） |
| 音声合成 | [VOICEVOX](https://voicevox.hiroshiba.jp/)（ENGINE を使います。GUI は不要） |
| Claude Code | 2.1.291 で確認（要約 mod の API は新しいため、版によっては要約だけ動かないことがあります） |
| 権限 | 管理者権限は不要。すべてユーザー領域に収まります |

## 導入

1. マーケットプレイスを追加し、プラグインを入れる

   ```
   /plugin marketplace add nextscape/ns-mods
   /plugin install voice-notify@nextscape-mods
   ```

2. 初期設定を行う（VOICEVOX が無ければ導入コマンドを案内して止まります）

   ```
   /voice-notify:setup
   ```

   | # | 内容 |
   |---|---|
   | 1 | ホーム（`~/.claude/voice-notify/`）の用意。`config.json` が無ければ既定をコピー |
   | 2 | VOICEVOX の確認（無ければ `winget install --id HiroshibaKazuyuki.VOICEVOX.CPU -e` を案内） |
   | 3 | VOICEVOX ENGINE の起動 |
   | 4 | 定型フレーズの生成（裏で実行。初回は数分。進み具合は `/voice-notify:setup doctor` で確認） |
   | 5 | ログオン時に ENGINE を起動するタスクの登録 |
   | 6 | ミュート切替のホットキー（既定 `Ctrl+Alt+M`。どのウィンドウからでも効く） |

3. **新しいセッションを開く**と、音声通知と要約が有効になります

## 使い方

| コマンド | 動作 |
|---|---|
| `/voice-notify:voice` | ミュートの切替 |
| `/voice-notify:voice on` / `off` / `status` | 再開 / 停止 / 状態表示 |
| `/voice-notify:setup doctor` | 診断（鳴らないときの切り分け） |
| `/voice-notify:setup remove` | タスクとホットキーの撤去（ホームは残す） |
| `/voice-notify:setup force` | 定型フレーズを作り直す（話者・話速を変えたとき） |

マイクを使っている間（会議・通話中）は自動で黙ります（`mute.whenMicInUse`）。

## 何を読み上げるか

| イベント | 読み上げ |
|---|---|
| ターン完了（Stop） | 定型フレーズ（完了・確認待ち・失敗を判定して選ぶ）＋応答の要約。作業が30秒以下のターンは定型フレーズだけ |
| サブエージェント完了 | 「〈説明〉が完了しました。〈報告の要約〉」を別の声で |
| 許可待ち | 「〈ツール名〉の許可待ちです。」 |
| 入力待ち・API エラー・タスク完了など | 定型フレーズ |

サブエージェントが動いている間の途中経過は、最終報告と声を分け、短く読みます。

## 設定

設定は **`~/.claude/voice-notify/config.json`** を直接編集します（環境変数 `VOICE_NOTIFY_HOME` に**絶対パス**を指定すると場所を変えられます）。
プラグインを更新・アンインストールしても、このフォルダは消えません。

| 変えたいもの | キー |
|---|---|
| 話者・話速・抑揚 | `speaker` / `speakerInterim` / `speedScale` / `pitchScale` / `intonationScale`（変えたら `/voice-notify:setup force` でフレーズを作り直す） |
| 要約をやめる | `speech.summarize` を `false` |
| 要約の文体 | `speech.summaryPrompt`（行の配列。良い例・悪い例を並べると効く。`{maxChars}` は上限の文字数に置換） |
| 要約の長さ・待ち時間 | `speech.summaryMaxChars` / `speech.interimMaxChars` / `speech.summaryTimeoutSec` |
| 本文を読まない短いターンの長さ | `speech.briefMaxSeconds`（既定30秒） |
| 英単語の読み | `speech.readings`（辞書） |
| 会議中に黙る | `mute.whenMicInUse` |

## 仕組み

```
Claude Code
 ├─ 要約 mod（hooks/register.ts）  turn.complete → $.model.complete(haiku) → ~/.claude/voice-notify/state/summaries/*.json
 └─ command hook（hooks/hooks.json） Stop / SubagentStop / Notification … → scripts/notify.ps1
                                        → 定型フレーズを再生 → 要約（無ければ本文の1文）を VOICEVOX で合成して再生
```

- **要約は会話に入らない**: `$.model.complete` は履歴もツールも持たない単発の呼び出しです
- **どの応答の要約かを中身で確かめる**: 要約ファイルに本文の文字数と先頭を書き、notify は自分の本文と一致したときだけ使います
- **待つ時間は notify だけが決める**: 要約が出来ていれば定型フレーズと並行して合成し、作成中なら最大 `summaryTimeoutSec` 待ちます。
  失敗・時間切れ・不一致のときは本文の1文を読みます
- **版に依存しない起動**: ホットキーとログオン時のタスクは `~/.claude/voice-notify/bin/launch.ps1` を呼び、
  launch.ps1 がキャッシュから最新の版を探します（プラグインは更新のたびに版のフォルダが変わるため）

## ファイルの置き場所

| 場所 | 中身 | 更新・撤去で |
|---|---|---|
| プラグイン（`${CLAUDE_PLUGIN_ROOT}`） | `scripts/`、`hooks/`、`commands/`、`config.default.json` | 置き換わる |
| ホーム（`~/.claude/voice-notify/`） | `config.json`、`phrases/`、`cache/`、`state/`、`notify.log`、`bin/launch.ps1` | 残る |

## 撤去

```
/voice-notify:setup remove
/plugin uninstall voice-notify
```

設定とフレーズを消すときは `~/.claude/voice-notify/` を削除してください。

## 鳴らないとき

1. `/voice-notify:setup doctor` を実行し、NG の行に従う
2. `~/.claude/voice-notify/notify.log` を見る（hook が呼ばれたか、なぜ黙ったか・何を読んだかが残ります）
3. 要約が出ず本文の1文を読む場合: 導入後に新しいセッションを開いたか、Claude Code の版を確認する（ログに「要約なし（mod 未読み込み…）」）

## 旧 claude-voice からの移行

旧 claude-voice（`settings.json` に hook を直接書く方式）が残っていると、二重に鳴ります。
`/voice-notify:setup doctor` が名残を警告します。旧 claude-voice の `setup.ps1 -Remove` で外し、
必要なら旧フォルダの `config.json` と `phrases/` を `~/.claude/voice-notify/` へコピーしてください。

## 開発

```
claude plugin test     mods/voice-notify          # 要約 mod のテスト（tests/*.test.ts）
claude plugin validate mods/voice-notify          # ロード時の検査
powershell -NoProfile -ExecutionPolicy Bypass -File mods/voice-notify/tests/test-summary-handoff.ps1   # PowerShell 側のテスト（tests/test-*.ps1）
```

- PowerShell のテストはホームを一時フォルダにして動き、利用者の `~/.claude/voice-notify/` には触れません
- `.ps1` は **UTF-8（BOM 付き）** で保存してください（BOM が無いと Windows PowerShell 5.1 が誤読します）
- mod の `$` は、ファイル最上位で宣言した function にだけ渡せます（ロード時の検査の規則）

## クレジット表記

本プラグインが生成する音声は **VOICEVOX** を使用しています。
生成した音声を含む成果物を公開・配布する場合は、使用した話者に応じて以下のクレジット表記が必要です。

| 話者 | クレジット表記 |
|---|---|
| ずんだもん | `VOICEVOX:ずんだもん` |
| 四国めたん | `VOICEVOX:四国めたん` |

- 商用・非商用いずれも利用可能（クレジット表記が条件）
- 音源利用規約: https://zunko.jp/con_ongen_kiyaku.html
- VOICEVOX ソフトウェア利用規約: https://voicevox.hiroshiba.jp/term/

ローカル PC での作業通知としての利用は公開・配布に当たりませんが、生成した音声を外部に出す場合は上記に従ってください。

## ライセンス

MIT（リポジトリの [LICENSE](../../LICENSE)）
