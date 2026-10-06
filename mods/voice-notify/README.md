# voice-notify — Claude Code の音声通知

> **English summary**: voice-notify speaks Claude Code events aloud on Windows using VOICEVOX
> (turn finished, waiting for permission, subagent reports, errors). Long turns are summarized
> into one spoken sentence by Claude Haiku via an in-session mod (`$.model.complete`): no separate API key,
> nothing added to your conversation, but the call does use your plan or API key, and the full reply text is sent to Haiku.
> Windows 10/11 and VOICEVOX are required.
> Install: `/plugin install voice-notify --marketplace nextscape/ns-mods`, then run `/voice-notify:setup`.

Claude Code のターン完了・許可待ち・サブエージェントの報告・エラーなどを、VOICEVOX の声で知らせます。
作業時間の長いターンは、応答を Claude Haiku で1文に要約して読み上げます。

- 要約は Claude Code の中で動く mod が行います。別の API キーは要りません。要約のやり取りは会話に入りません。
- 要約は利用者のプランまたは API キーを使い、応答の本文を Haiku に送ります。詳しくは[データと費用](#データと費用)を見てください。
- 鳴らす・黙るの判断（短いターンは完了だけ告げる、マイク使用中は黙る、など）は、すべてローカルで行います。

## 前提

| 項目 | 内容 |
|---|---|
| OS | Windows 10 / 11（Windows PowerShell 5.1 で動きます） |
| 音声合成 | [VOICEVOX](https://voicevox.hiroshiba.jp/)。同梱の ENGINE を使います。GUI は起動しません |
| Claude Code | 2.1.287 以降（mod が既定で有効になる版）。2.1.291 で動作を確認。要約以外の読み上げは mod を使わないので、要約が動かない版でも鳴ります |
| 権限 | 管理者権限は不要です。すべてユーザー領域に収まります |

## 導入

1. プラグインを入れる

   ```
   /plugin install voice-notify --marketplace nextscape/ns-mods
   ```

2. 初期設定を行う

   ```
   /voice-notify:setup
   ```

   | # | 内容 |
   |---|---|
   | 1 | ホーム（`~/.claude/voice-notify/`）の用意。`config.json` が無ければ既定をコピー |
   | 2 | VOICEVOX の確認。無ければ `winget install --id HiroshibaKazuyuki.VOICEVOX.CPU -e` を案内して止まります。導入後にもう一度 `/voice-notify:setup` を実行してください |
   | 3 | VOICEVOX ENGINE の起動 |
   | 4 | 定型フレーズの生成（裏で実行。初回は数分。進み具合は `/voice-notify:setup doctor` で確認） |
   | 5 | ログオン時に ENGINE を起動するタスクの登録 |
   | 6 | ミュート切替のホットキーの登録（既定 `Ctrl+Alt+M`） |

3. **新しいセッションを開く**と、音声通知と要約が有効になります。

## 使い方

| コマンド | 動作 |
|---|---|
| `/voice-notify:voice` | ミュートの切替 |
| `/voice-notify:voice on` / `off` / `status` | 再開 / 停止 / 状態表示 |
| `Ctrl+Alt+M`（どのウィンドウからでも） | ミュートの切替 |
| `/voice-notify:setup doctor` | 診断（鳴らないときの切り分け） |
| `/voice-notify:setup force` | 定型フレーズを作り直す（話者・話速を変えたとき） |
| `/voice-notify:setup remove` | タスクとホットキーの撤去（ホームは残す） |

`/voice-notify:setup` に知らない引数を付けたときは、何も導入せずに使い方を表示します。

マイクを使っているアプリがあると、自動で黙ります（`mute.whenMicInUse`）。

## 何を読み上げるか

| イベント | 読み上げ |
|---|---|
| ターン完了（Stop） | 定型フレーズ（完了・確認待ち・失敗を判定して選ぶ）＋応答の要約。作業が30秒以下のターンは定型フレーズだけ |
| サブエージェント完了 | 「〈説明〉が完了しました。〈報告の要約〉」を別の声で |
| 許可待ち | 「〈ツール名〉の許可待ちです。」（ツール名は `notification.toolLabels` で言い換え。Bash は「コマンド実行」） |
| 入力待ち・API エラー・タスク完了・利用枠の自動再開など | 定型フレーズ |

- サブエージェントが動いている間の途中経過は、最終報告と声を分け、短く読みます。8秒以内に続いた途中経過は読みません（`subagent.debounceSeconds`）。
- 要約が使えないとき（無効、失敗、時間切れ）は、応答の本文から1文を選んで読みます。コードブロック・表・URL は読みません。
- 次のときは、30秒以下でも定型フレーズだけにならず、本文を読むことがあります。ターンの開始を記録できなかったとき（作業時間が分からない）です。本文が取れなかったときは、本文なしの定型フレーズだけを読みます。
- `/compact` のように、利用者のプロンプトから始まっていない停止は読みません。

## 設定

設定は **`~/.claude/voice-notify/config.json`** を直接編集します。環境変数 `VOICE_NOTIFY_HOME` に**絶対パス**を指定すると、置き場所を変えられます。
プラグインを更新・アンインストールしても、このフォルダは消えません。
JSON を書き間違えると通知が止まります。`/voice-notify:setup doctor` が「config.json を読めない」と知らせます。

| 変えたいもの | キー |
|---|---|
| 話者・話速・抑揚 | `speaker` / `speakerInterim` / `speedScale` / `pitchScale` / `intonationScale`（変えたら `/voice-notify:setup force` でフレーズを作り直す） |
| 使える話者 | `speakers`（名前ごとに VOICEVOX の話者 `id`、表示名 `label`、クレジット `credit`） |
| 定型フレーズの文言 | `phrases`（変えたら `/voice-notify:setup force`） |
| 要約をやめる | `speech.summarize` を `false` |
| 要約するイベント | `speech.summarizeEvents`（既定は `stop` と `agentstop`） |
| 要約の文体 | `speech.summaryPrompt` / `speech.interimPrompt`（行の配列。良い例・悪い例を並べると効く。`{maxChars}` は上限の文字数に置き換わる） |
| 要約の長さ・待ち時間 | `speech.summaryMaxChars` / `speech.interimMaxChars` / `speech.summaryTimeoutSec` |
| 要約しない短い応答 | `speech.summaryMinChars`（既定80文字。これより短い応答はそのまま読む） |
| 本文を読まない短いターン | `speech.briefMaxSeconds`（既定30秒） |
| 英単語の読み | `speech.readings`（辞書） |
| マイク使用中に黙る | `mute.whenMicInUse` |
| サブエージェントの途中経過の間隔 | `subagent.debounceSeconds`（既定8秒） |
| 許可待ちで読むツール名 | `notification.toolLabels` |
| ホットキー | `hotKey`（既定 `CTRL+ALT+M`。変えたら `/voice-notify:setup` をもう一度実行する） |
| VOICEVOX の場所 | `enginePath`（自動で見つからないときに `run.exe` の絶対パスを書く） |
| ENGINE のポート | `enginePort`（既定 50021） |
| 合成した音声のキャッシュ件数 | `cacheMaxFiles`（既定200） |
| 調査用に hook の入力を保存する | `debugPayload`（既定 `false`。`true` にすると応答の全文が `payloads/` に残る） |

## データと費用

| 項目 | 内容 |
|---|---|
| 要約を作るとき | メインのターンは、作業が30秒を超え、応答が80文字以上のとき。サブエージェントの報告は、30文字以上のとき。手動ミュート中と `speech.summarize` が `false` のときは作りません |
| Haiku に送るもの | 応答の本文の全文と、要約の指示文（`speech.summaryPrompt`）。会話履歴やファイルは送りません |
| 費用 | mod のモデル呼び出しは、利用者のプランまたは API キーを使います（[公式ドキュメント](https://code.claude.com/docs/en/plugins/mods/api.md#call-a-model)）。1回あたり出力は最大300トークンです |
| 外に出ないもの | 音声合成は手元の VOICEVOX ENGINE（`127.0.0.1:50021`）で行い、ネットワークには出ません。マイク使用中の判定もローカルで行います |
| 手元に残るもの | `notify.log` に、読み上げた文と要約が残ります（約200KB を超えると古い行を捨てます）。`cache/` に合成した音声が最大200件、`state/summaries/` に直近の要約が残ります。`debugPayload` が `true` なら、`payloads/` に応答の全文が残ります |
| 消し方 | `~/.claude/voice-notify/` の `notify.log`、`cache/`、`state/`、`payloads/` は消してかまいません。次の通知で作り直します（`state/` を消すと手動ミュートも解除されます） |

## 仕組み

```
Claude Code
 ├─ 要約 mod（hooks/register.ts）  turn.complete → $.model.complete(haiku) → ~/.claude/voice-notify/state/summaries/*.json
 └─ command hook（hooks/hooks.json） Stop / SubagentStop / Notification … → scripts/notify.ps1
                                        → 定型フレーズを再生 → 要約（無ければ本文の1文）を VOICEVOX で合成して再生
```

- 要約は会話に入りません。`$.model.complete` は、履歴もツールも持たない単発の呼び出しです。
- 要約ファイルには、本文の文字数と先頭を書きます。notify は自分の本文と一致したときだけ使い、どの応答の要約かを時刻で推測しません。
- 待つ時間は notify だけが決めます。要約が出来ていれば定型フレーズと並行して合成し、作成中なら最大 `summaryTimeoutSec` 秒待ちます。失敗・時間切れ・不一致のときは本文の1文を読みます。
- マイク使用中の判定は、Windows のプライバシー設定の記録（レジストリの `CapabilityAccessManager\ConsentStore\microphone`）で行います。会議アプリに限らず、マイクを使っているアプリがあれば黙ります。
- ホットキーは、スタートメニューに置くショートカット（`voice-notify ミュート切替.lnk`）のショートカットキーです。常駐プロセスはありません。押すたびに PowerShell が起動するので、切り替わるまで1秒ほどかかります。ほかのアプリと同じキーだと、どちらかが効きません。
- ログオン時のタスクは、タスクスケジューラの `VOICEVOX ENGINE (voice-notify)` です。
- ホットキーとタスクは `~/.claude/voice-notify/bin/launch.ps1` を呼びます。プラグインは更新のたびに版のフォルダが変わるので、launch.ps1 がその時点の版を探して起動します。

## ファイルの置き場所

| 場所 | 中身 | 更新・撤去で |
|---|---|---|
| プラグイン（`${CLAUDE_PLUGIN_ROOT}`） | `scripts/`、`hooks/`、`commands/`、`config.default.json` | 置き換わる |
| ホーム（`~/.claude/voice-notify/`） | `config.json`、`phrases/`、`cache/`、`state/`、`notify.log`、`bin/` | 残る |
| スタートメニュー | `voice-notify ミュート切替.lnk`（ホットキー） | `setup remove` で消える |
| タスクスケジューラ | `VOICEVOX ENGINE (voice-notify)` | `setup remove` で消える |

## 撤去

```
/voice-notify:setup remove
/plugin uninstall voice-notify
```

- `setup remove` は、タスクとホットキーを消します。起動中の VOICEVOX ENGINE は止めません（次のログオンからは起動しません）。止めるときはタスクマネージャーで `run.exe` を終了してください。
- 設定・フレーズ・ログも消すときは、`~/.claude/voice-notify/` を削除してください。
- VOICEVOX 本体は残ります。不要なら `winget uninstall --id HiroshibaKazuyuki.VOICEVOX.CPU -e` で外します。

## 鳴らないとき

1. `/voice-notify:setup doctor` を実行し、NG の行に従う。
2. `~/.claude/voice-notify/notify.log` を見る。hook が呼ばれたか、なぜ黙ったか（「マイク使用中 (アプリ名)」など）、何を読んだかが残ります。
3. 要約が出ず本文の1文を読む場合は、導入後に新しいセッションを開いたか、Claude Code の版を確認する。ログには「要約なし（mod 未読み込み…）」と出ます。
4. ホットキーが効かない場合は、`notify.log` に「voice-notify のプラグインが見つからない」と出ていないか確認し、`/voice-notify:setup` をもう一度実行する。

`/voice-notify:setup doctor` は、以前の版（claude-voice）の登録が残っていると、二重に鳴る原因として警告します。

## 開発

```
claude plugin test     mods/voice-notify          # 要約 mod のテスト（tests/*.test.ts）
claude plugin validate mods/voice-notify          # ロード時の検査
powershell -NoProfile -ExecutionPolicy Bypass -File mods/voice-notify/tests/test-summary-handoff.ps1   # PowerShell 側のテスト（tests/test-*.ps1 を1本ずつ）
```

- PowerShell のテストはホームを一時フォルダにして動き、利用者の `~/.claude/voice-notify/` には触れません。
- `.ps1` は **UTF-8（BOM 付き）** で保存してください。BOM が無いと、Windows PowerShell 5.1 が誤読します。
- mod の `$` は、ファイルの最上位で宣言した function にだけ渡せます（ロード時の検査の規則）。
- 環境変数 `VOICE_NOTIFY_SUPPRESS=1` で通知をすべて止められます。`VOICE_NOTIFY_DRYRUN=1` では、音を鳴らさず、何を読むはずだったかだけを `notify.log` に残します。

変更履歴は [CHANGELOG.md](CHANGELOG.md) を見てください。

## クレジット表記

本プラグインが生成する音声は **VOICEVOX** を使用しています。
生成した音声を含む成果物を公開・配布する場合は、使用した話者に応じて以下のクレジット表記が必要です。

| 話者 | クレジット表記 |
|---|---|
| ずんだもん | `VOICEVOX:ずんだもん` |
| 四国めたん | `VOICEVOX:四国めたん` |

- 商用・非商用いずれも利用可能です（クレジット表記が条件）。
- 音源利用規約: https://zunko.jp/con_ongen_kiyaku.html
- VOICEVOX ソフトウェア利用規約: https://voicevox.hiroshiba.jp/term/

手元の PC で作業通知として聞くだけなら、公開・配布には当たらないと考えています（当社の解釈です。最終的には各規約を確認してください）。生成した音声を外部に出す場合は、上記に従ってください。

## ライセンス

MIT（リポジトリの [LICENSE](../../LICENSE)）
