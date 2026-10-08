# voice-notify の変更履歴

## 0.3.1 — 2026-10-08

- 修正: 0.2.0 のフレーズが残る環境で足りない分だけを作ると、古いフレーズを今の設定で作ったものとして記録し、`doctor` が `setup force` を案内しなかった。0.2.0 のフレーズには先頭の無音が無いので、鳴らし始めが欠けたままになっていた。流用したフレーズが今の設定のものと分からないときは記録を残さないようにした。該当する環境では `/voice-notify setup force` で作り直す。

## 0.3.0 — 2026-10-07

- 変更: PowerShell の hook（`notify.ps1` など）を廃止し、判定・合成・再生をすべて mod（TypeScript）に移した。設定（`~/.claude/voice-notify/config.json`）はそのまま使える。
- 追加: macOS と Linux に対応した（試験的。自動テストのみで、実機では確かめていない）。再生は macOS が `afplay`、Linux が `pw-play` / `paplay` / `aplay`。ログオン時の ENGINE 起動は launchd / systemd のユーザーサービスで登録する。ENGINE がすでに応答していれば（Docker など）、それを使い、ログオン時の起動は登録しない。
- 変更: コマンドを `/voice-notify` の1つにまとめた（mod のコマンド名に `:` を使えないため）。`/voice-notify:voice` は `/voice-notify [on|off|status]`、`/voice-notify:setup` は `/voice-notify setup`（`force` は `/voice-notify setup force`）、`doctor` と `remove` は `/voice-notify doctor`・`/voice-notify remove`。
- 修正: 許可待ちで「〈ツール名〉の許可待ちです」を読むようにした（0.2.0 は通知の入力にツール名が無く、読めていなかった）。
- 修正: サブエージェントの完了を、エンジンが知っている agent かどうかで判定するようにした（0.2.0 は開始の記録が取れず、本物の完了も「開始を見ていない停止のため無視」になることがあった）。
- 変更: 先頭の無音（`playback.leadSilenceMs`）を合成の時点で入れるようにした。0.2.0 で作った定型フレーズには無音が入っていないので、`/voice-notify setup force` で作り直す（`doctor` が案内する）。
- 変更: 定型フレーズを、どの設定（文言・話者・話速・読み替え・先頭の無音）で作ったかを記録し、設定と合わなければ `doctor` が作り直しを案内するようにした。
- 変更: Windows のタスクとホットキーは、ホームの `bin/` に置いたスクリプトを直接呼ぶようにした（プラグインの置き場所を探す `launch.ps1` を廃止）。
- 変更: `doctor` は報告だけにした。0.2.0 の残り（`state/turns`・`agents`・`summaries`、`bin/launch.ps1`・`plugin-root.txt`）は `setup` が消す。
- 変更: 使わなくなった設定キー（`debugPayload`、`subagent.labels`・`maxRemainSpoken`・`remainWording`、`phrases.subagent`）を既定の設定から外した。残っていても無視される。環境変数 `VOICE_NOTIFY_DRYRUN` も廃止した。
- 変更: 対象は CLI だけ（デスクトップアプリの Code タブや VS Code 拡張では鳴らない。mod から外部コマンドを起動できるのが CLI だけのため）。

### 0.2.0 から移るとき

1. `/plugin update voice-notify` で 0.3.0 にし、新しいセッションを開く。
2. `/voice-notify setup` を実行する（0.2.0 の状態ファイルを消し、Windows のタスクとホットキーを `bin/` の新しいスクリプトに向け直す）。
3. `/voice-notify doctor` で確かめる。定型フレーズの作り直しを案内されたら `/voice-notify setup force`。

## 0.2.0 — 2026-10-07

- 追加: ホットキーを `config.json` の `hotKey` で変えられるようにした（既定 `CTRL+ALT+M`）。
- 変更: `/voice-notify:setup` の引数を PowerShell 側で受けるようにした。知らない引数では何も導入せず、使い方を表示する（これまでは打ち間違いでも導入が走っていた）。引数の大文字・小文字は問わない。
- 修正: `config.json` が壊れていても、`/voice-notify:setup doctor` と `remove` が動くようにした。診断は「config.json を読めない」と知らせ、導入は止まる。
- 修正: ホームの初期化で `state/summaries/` を作るようにした（要約 mod はフォルダを作れないため）。
- 修正: `setup remove` が、無いタスクやショートカットも「削除」と表示していた。起動中の ENGINE を止めないことも表示するようにした。
- 修正: 診断と案内に出す winget のコマンドを `--id … -e` 付きにそろえた。
- 文書: README に、データと費用（Haiku に送るもの、手元に残るもの）、ホットキーとタスクの実体、マイク判定の方法、未記載だった設定キーを足した。旧 claude-voice からの移行の節を外した。

## 0.1.1 — 2026-10-07

このリポジトリ（ns-mods）で公開した最初の版です。
