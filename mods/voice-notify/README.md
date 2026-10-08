# voice-notify — Claude Code の音声通知

> **English summary**: voice-notify speaks Claude Code events aloud using VOICEVOX
> (turn finished, waiting for permission, subagent reports, errors). Long turns are summarized
> into one spoken sentence by Claude Haiku inside the mod (`$.model.complete`): no separate API key,
> nothing added to your conversation, but the call does use your plan or API key, and the full reply text is sent to Haiku.
> Runs on Windows; macOS and Linux are experimental (covered by automated tests only). VOICEVOX and the Claude Code CLI are required.
> Install: `/plugin install voice-notify --marketplace nextscape/ns-mods`, open a new session, then run `/voice-notify setup`.
> Voices: VOICEVOX:四国めたん, VOICEVOX:ずんだもん.

Claude Code のターン完了・許可待ち・サブエージェントの報告・エラーなどを、VOICEVOX の声で知らせます。
作業時間の長いターンは、応答を Claude Haiku で1文に要約して読み上げます。

- 要約は Claude Code の中で動く mod が行います。別の API キーは要りません。要約のやり取りは会話に入りません。
- 要約は利用者のプランまたは API キーを使い、応答の本文を Haiku に送ります。詳しくは[データと費用](#データと費用)を見てください。
- 鳴らす・黙るの判断（短いターンは完了だけ告げる、マイク使用中は黙る、など）は、すべてローカルで行います。

音声：VOICEVOX:四国めたん、VOICEVOX:ずんだもん（[クレジット表記](#クレジット表記)）

## 前提

| 項目 | 内容 |
|---|---|
| OS | Windows 10 / 11、macOS、Linux。**macOS・Linux は試験的な対応です**（自動テストのみで、実機では確かめていません） |
| 音声合成 | [VOICEVOX](https://voicevox.hiroshiba.jp/)。同梱の ENGINE を使います。GUI は起動しません |
| Claude Code | **CLI（ターミナル）だけ**。2.1.292 で動作を確認。デスクトップアプリの Code タブや VS Code 拡張では鳴りません（mod から外部コマンドを起動できるのが CLI だけのため） |
| 再生 | Windows は標準の機能（SoundPlayer）。macOS は `afplay`。Linux は `pw-play`・`paplay`・`aplay` のどれか |
| curl | 合成に使います。Windows 10 以降と macOS には標準で入っています |
| 権限 | 管理者権限は不要です。すべてユーザー領域に収まります |

## 導入

1. プラグインを入れて、新しいセッションを開く

   ```
   /plugin install voice-notify --marketplace nextscape/ns-mods
   ```

2. VOICEVOX を入れる

   | OS | 方法 |
   |---|---|
   | Windows | `winget install --id HiroshibaKazuyuki.VOICEVOX.CPU -e` |
   | macOS | [公式サイト](https://voicevox.hiroshiba.jp/)の dmg を入れ、アプリケーションフォルダに置く |
   | Linux | 公式サイトの tar.gz を展開する。3 の `/voice-notify setup` を一度実行すると `~/.claude/voice-notify/config.json` ができるので、その `enginePath` に `vv-engine/run` の絶対パスを書き、もう一度 `/voice-notify setup` を実行する |

   ENGINE がすでに `127.0.0.1:50021` で応答していれば、それを使います（Docker の `voicevox/voicevox_engine` など）。

3. 初期設定を行う

   ```
   /voice-notify setup
   ```

   | # | 内容 |
   |---|---|
   | 1 | ホーム（`~/.claude/voice-notify/`）の用意。`config.json` が無ければ既定をコピー。0.2.0 の残りを消す |
   | 2 | VOICEVOX の確認。見つからなければ、OS ごとの入れ方を案内して止まります |
   | 3 | VOICEVOX ENGINE の起動 |
   | 4 | 定型フレーズの生成（裏で実行。初回は数分。進み具合は `/voice-notify doctor` で確認） |
   | 5 | ログオン時に ENGINE を起動する登録（Windows はタスク、macOS は launchd、Linux は systemd のユーザーサービス。ENGINE の場所が分からない（Docker など）ときは登録しない）。ミュート切替のホットキーの登録（Windows だけ。既定 `Ctrl+Alt+M`） |

   音声通知は、setup を実行したセッションからすぐ有効です。

### 0.2.0 から移るとき

1. `/plugin update voice-notify` で 0.3.0 にし、新しいセッションを開く。
2. `/voice-notify setup` を実行する（0.2.0 の状態ファイルを消し、Windows のタスクとホットキーを新しいスクリプトに向け直す）。
3. `/voice-notify doctor` で確かめる。定型フレーズの作り直しを案内されたら `/voice-notify setup force`（0.2.0 のフレーズには、鳴らし始めが欠けないための無音が入っていないため）。

コマンドの名前が変わりました（mod のコマンド名に `:` を使えないため）。

| 0.2.0 | 0.3.0 |
|---|---|
| `/voice-notify:voice`・`on`・`off`・`status` | `/voice-notify`・`/voice-notify on`・`off`・`status` |
| `/voice-notify:setup` | `/voice-notify setup` |
| `/voice-notify:setup force` | `/voice-notify setup force` |
| `/voice-notify:setup doctor` | `/voice-notify doctor` |
| `/voice-notify:setup remove` | `/voice-notify remove` |

## 使い方

| コマンド | 動作 |
|---|---|
| `/voice-notify` | ミュートの切替 |
| `/voice-notify on` / `off` / `status` | 再開 / 停止 / 状態表示 |
| `Ctrl+Alt+M`（Windows だけ。どのウィンドウからでも） | ミュートの切替 |
| `/voice-notify doctor` | 診断（鳴らないときの切り分け）。何も変えません |
| `/voice-notify setup force` | 定型フレーズを作り直す（話者・話速・文言・読み替え・先頭の無音を変えたとき） |
| `/voice-notify remove` | ログオン時の起動とホットキーの撤去（ホームは残す） |

`/voice-notify` に知らない引数を付けたときは、何もせずに使い方を表示します。

マイクを使っているアプリがあると、自動で黙ります（Windows だけ。`mute.whenMicInUse`）。

## 何を読むか

| イベント | 読み上げ |
|---|---|
| ターン完了 | 定型フレーズ（完了・確認待ち・失敗を判定して選ぶ）＋応答の要約。作業が30秒以下のターンは定型フレーズだけ |
| サブエージェント完了 | 「〈説明〉が完了しました。〈報告の要約〉」を別の声で |
| 許可待ち | 「〈ツール名〉の許可待ちです。」（ツール名は `notification.toolLabels` で言い換え。Bash は「コマンド実行」） |
| 入力待ち・API エラー・タスク完了・利用枠の自動再開など | 定型フレーズ |

- サブエージェントが動いている間の途中経過は、最終報告と声を分け、短く読みます。8秒以内に続いた途中経過は読みません（`subagent.debounceSeconds`）。
- 要約が使えないとき（無効、失敗、時間切れ）は、応答の本文から1文を選んで読みます。コードブロック・表・URL は読みません。
- ENGINE が応答しないときは、黙らずに短い定型フレーズだけを鳴らします。
- 入力待ちは、サブエージェントが動いている間と、メインが作業中の間は読みません。
- `/compact` の最中のターンと、利用者が中断したターンは読みません。

## 設定

設定は **`~/.claude/voice-notify/config.json`** を直接編集します。環境変数 `VOICE_NOTIFY_HOME` に**絶対パス**を指定すると、置き場所を変えられます。
プラグインを更新・アンインストールしても、このフォルダは消えません。
JSON を書き間違えると通知が止まります。`/voice-notify doctor` が「config.json を読めない」と知らせます。
`config.json` に書いていないキーは、同梱の既定値（`config.default.json`）で動きます。オブジェクトはキーごとに重なり、配列と値は `config.json` のものが使われます。そのため、`phrases` の区分（`stop.brief` など）を消しても既定の文言に戻ります。黙らせたい区分は、空の配列（`[]`）にしてください。

| 変えたいもの | キー |
|---|---|
| 話者・話速・抑揚 | `speaker` / `speakerInterim` / `speedScale` / `pitchScale` / `intonationScale`（変えたら `/voice-notify setup force` でフレーズを作り直す） |
| 使える話者 | `speakers`（名前ごとに VOICEVOX の話者 `id`、表示名 `label`、クレジット `credit`） |
| 定型フレーズの文言 | `phrases`（変えたら `/voice-notify setup force`） |
| 要約をやめる | `speech.summarize` を `false` |
| 要約するイベント | `speech.summarizeEvents`（既定は `stop` と `agentstop`） |
| 要約の文体 | `speech.summaryPrompt` / `speech.interimPrompt`（行の配列。良い例・悪い例を並べると効く。`{maxChars}` は上限の文字数に置き換わる） |
| 要約の長さ・待ち時間 | `speech.summaryMaxChars` / `speech.interimMaxChars` / `speech.summaryTimeoutSec` |
| 要約しない短い応答 | `speech.summaryMinChars`（既定80文字。これより短い応答はそのまま読む） |
| 本文を読まない短いターン | `speech.briefMaxSeconds`（既定30秒） |
| 英単語の読み | `speech.readings`（辞書）・`speech.lowercaseMinLength`・`speech.keepUppercase`（変えたら `/voice-notify setup force`） |
| マイク使用中に黙る | `mute.whenMicInUse`（Windows だけ） |
| サブエージェントの途中経過の間隔 | `subagent.debounceSeconds`（既定8秒） |
| 許可待ちで読むツール名 | `notification.toolLabels` |
| 鳴らし始めの無音 | `playback.leadSilenceMs`（既定600。出力先がディスプレイの音声で頭が欠けるときに増やす。変えたら `/voice-notify setup force`） |
| ホットキー | `hotKey`（Windows だけ。既定 `CTRL+ALT+M`。変えたら `/voice-notify setup` をもう一度実行する） |
| VOICEVOX の場所 | `enginePath`（自動で見つからないときに ENGINE の `vv-engine/run`（Windows は `run.exe`）の絶対パスを書く） |
| ENGINE のポート | `enginePort`（既定 50021） |
| 合成した音声のキャッシュ件数 | `cacheMaxFiles`（既定200） |

## データと費用

| 項目 | 内容 |
|---|---|
| 要約を作るとき | メインのターンは、作業が30秒を超え、応答が80文字以上のとき。サブエージェントの報告は、30文字以上のとき。手動ミュート中と `speech.summarize` が `false` のときは作りません |
| Haiku に送るもの | 応答の本文の全文と、要約の指示文（`speech.summaryPrompt`）。会話履歴やファイルは送りません |
| 費用 | mod のモデル呼び出しは、利用者のプランまたは API キーを使います（[公式ドキュメント](https://code.claude.com/docs/en/plugins/mods/api.md#call-a-model)）。1回あたり出力は最大300トークンです |
| 外に出ないもの | 音声合成は手元の VOICEVOX ENGINE（`127.0.0.1:50021`）で行い、ネットワークには出ません。マイク使用中の判定もローカルで行います |
| 手元に残るもの | `notify.log` に、読み上げた文と要約が残ります（約200KB を超えると古い行を捨てます。mod には追記の手段が無く読んで書き直すので、別のセッションとほぼ同時に書くと、まれに1行欠けます）。`cache/` に合成した音声が最大200件、`state/` にミュートや直前のフレーズなどの小さな記録が残ります |
| 消し方 | `~/.claude/voice-notify/` の `notify.log`、`cache/`、`state/` は消してかまいません。次の通知で作り直します（`state/` を消すと手動ミュートも解除されます） |

## 仕組み

```
Claude Code（CLI）
 └─ mod（hooks/register.ts）
     ├─ turn.complete（メイン）        → 判定 → 定型フレーズを再生 → 要約（Haiku）か本文の1文 → VOICEVOX で合成 → 再生
     ├─ turn.complete（サブエージェント） → 「〈説明〉が完了しました。〈報告の要約〉」
     ├─ classic.PermissionRequest / Notification / TaskCompleted → 許可待ち・入力待ち・タスク完了など
     └─ /voice-notify                   → ミュート・導入・診断・撤去
```

- 何を読むかの判定は純粋関数（`hooks/decide.ts`・`text.ts`）で、I/O は `hooks/register.ts` だけが行います。hook は読み上げを待たずに返すので、ターンは遅れません。
- 要約は会話に入りません。`$.model.complete` は、履歴もツールも持たない単発の呼び出しです。定型フレーズを鳴らしている間に、要約と合成を進めます。
- 合成は、`audio_query` を HTTP で受け取り、`synthesis` は curl で WAV をファイルに落とします（mod の HTTP は文字列しか受け取れないため）。合成した音声は `cache/` に残し、同じ文はもう一度合成しません。
- 再生は OS ごとの小さなスクリプト（`scripts/windows/play.ps1`・`scripts/posix/play.sh`）が行い、別のセッションの音と重ならないよう1つずつ鳴らします。
- マイク使用中の判定は、Windows のプライバシー設定の記録（レジストリの `CapabilityAccessManager\ConsentStore\microphone`）で行います。会議アプリに限らず、マイクを使っているアプリがあれば黙ります。
- ホットキーは、スタートメニューに置くショートカット（`voice-notify ミュート切替.lnk`）のショートカットキーです。常駐プロセスはありません。押すたびに PowerShell が起動するので、切り替わるまで1秒ほどかかります。ほかのアプリと同じキーだと、どちらかが効きません。
- Windows のタスクとホットキーは、setup がホームの `bin/` にコピーしたスクリプトを呼びます。プラグインを更新して場所が変わっても動きます。`doctor` は、`bin/` のスクリプトが今の版と違えば、setup のやり直しを案内します。

## ファイルの置き場所

| 場所 | 中身 | 更新・撤去で |
|---|---|---|
| プラグイン | `hooks/`、`scripts/`、`config.default.json` | 置き換わる |
| ホーム（`~/.claude/voice-notify/`） | `config.json`、`phrases/`、`cache/`、`state/`、`notify.log`、`bin/` | 残る |
| Windows：スタートメニュー | `voice-notify ミュート切替.lnk`（ホットキー） | `remove` で消える |
| Windows：タスクスケジューラ | `VOICEVOX ENGINE (voice-notify)` | `remove` で消える |
| macOS | `~/Library/LaunchAgents/jp.nextscape.voice-notify.engine.plist` | `remove` で消える |
| Linux | `~/.config/systemd/user/voice-notify-engine.service` | `remove` で消える |

## 撤去

```
/voice-notify remove
/plugin uninstall voice-notify
```

- `remove` は、ログオン時の起動とホットキーを外します。起動中の VOICEVOX ENGINE は止めません（次のログオンからは起動しません）。Windows ではタスクマネージャーで `run.exe` を終了してください。
- 設定・フレーズ・ログも消すときは、`~/.claude/voice-notify/` を削除してください。
- VOICEVOX 本体は残ります。Windows で不要なら `winget uninstall --id HiroshibaKazuyuki.VOICEVOX.CPU -e` で外します。

## 鳴らないとき

1. `/voice-notify doctor` を実行し、NG・注意の行に従う。
2. `~/.claude/voice-notify/notify.log` を見る。何が起きたか、なぜ黙ったか（「マイク使用中 (アプリ名)」など）、何を読んだかが残ります。
3. デスクトップアプリや VS Code で使っている場合は鳴りません（CLI だけの対応です）。
4. Windows で音が出ない場合は、既定の出力先（タスクバーのスピーカーアイコン）が聞いている機器になっているかを確かめる。
5. Linux で「再生コマンドが見つからない」と出る場合は、`pw-play`（PipeWire）・`paplay`（PulseAudio）・`aplay`（ALSA）のどれかを入れる。

## 開発

```
claude plugin test     mods/voice-notify          # tests/*.test.ts
claude plugin validate mods/voice-notify          # ロード時の検査
npx -y -p typescript tsc -p mods/voice-notify --noEmit   # 型（tsconfig.json は mod を読み込むとエンジンが置く）
```

- mod の `$` は、hooks モジュール（`hooks/register.ts`）の中で宣言した関数にしか渡せません（ロード時の検査の規則）。ほかのファイルは純粋関数だけにして、直接テストします。`$` を使う振る舞いは、`tests/world.ts` の偽環境でイベントやコマンドを起こしてテストします。
- `.ps1` は **UTF-8（BOM 付き）** で保存してください。BOM が無いと、Windows PowerShell 5.1 が誤読します。
- 環境変数 `VOICE_NOTIFY_SUPPRESS=1` で通知をすべて止められます。

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

`/voice-notify status` と `/voice-notify doctor` も、使っている話者のクレジット（`speakers.*.credit`）を表示します。話者を足すときは `credit` も書いてください（無いと `VOICEVOX` とだけ表示します）。

生成した音声を動画などに使って公開する場合は、その説明欄などに上記のクレジットを書いてください。

## ライセンス

MIT（リポジトリの [LICENSE](../../LICENSE)）
