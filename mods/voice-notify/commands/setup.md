---
description: voice-notify の初期設定・診断・撤去（VOICEVOX、ENGINE の自動起動、定型フレーズ、ホットキー）
argument-hint: "[doctor|remove|force]  省略時は導入。force はフレーズを作り直す"
allowed-tools: Bash(powershell:*)
---

実行結果:

!`powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/setup.ps1" $ARGUMENTS`

上の実行結果を日本語で短く要約してください。次の点は必ず伝えてください。

- NG や注意の行があれば、その対処を1行ずつ示す。
- 「VOICEVOX が見つかりません」で止まったときは、結果にある winget のコマンドをそのまま示し、導入後にもう一度 `/voice-notify:setup` を実行するよう伝える。
- 「知らない引数です」のときは、何も導入していないことと、使える引数（doctor / remove / force）を伝える。
- 導入が終わったときは、新しいセッションを開くと音声通知と要約が有効になることを伝える。

結果に書かれていないことを推測で補わないでください。
