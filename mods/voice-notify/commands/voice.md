---
description: voice-notify（Claude Code の音声通知）をミュート/解除する
argument-hint: "[on|off|status]  省略時は切替"
allowed-tools: Bash(powershell:*)
---

実行結果:

!`powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/voice.ps1" $ARGUMENTS`

上の実行結果を、日本語でそのまま短く報告してください（status のように複数行のときは行ごとに）。補足や提案は不要です。
「知らない引数です」のときは、使える引数（on / off / status。省略時は切替）だけを伝えてください。
