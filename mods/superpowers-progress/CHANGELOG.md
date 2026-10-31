# superpowers-progress の変更履歴

## 0.1.0 — 2026-10-31

最初の版です。

- 追加: 会話の横のペインに、計画の見出し、今のタスク、進捗バー、完了数と残り数を出す。
- 追加: Superpowers の subagent-driven-development（SDD）の計画ファイルと台帳（`.superpowers/sdd/<計画>/progress.md`）から進捗を読む。SDD が作業フォルダを消したあとも、最後に読んだ進捗を出し続ける。
- 追加: 今のタスクの段階（実装 → レビュー → 修正 R/5 → 再レビュー、全タスクのあとは最終レビュー・最終修正）を、SDD がサブエージェントを呼ぶときの書き出しから見分けて出す。
- 追加: 呼ばれた Superpowers のスキルから、ワークフローの現在地（設計 › 計画 › 実装 › 仕上げ）を出す。
- 追加: 台帳の判断（Ruling）・保留（parked）・後回し（deferred）を数え、クリックで中身を開く。
- 追加: TaskCreate・TaskUpdate・TodoWrite で作ったタスクも表示する。台帳と両方あるときは新しく更新されたほうを出す。
- 追加: `/superpowers-progress` でペインを開き直す。
