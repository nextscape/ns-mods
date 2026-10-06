---
description: voice-notify の初期設定・診断・撤去（VOICEVOX、ENGINE の自動起動、定型フレーズ、ホットキー）
argument-hint: "[doctor|remove]  省略時は導入"
allowed-tools: Bash(powershell:*)
---

実行結果:

!`powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/setup.ps1" $(case "$ARGUMENTS" in doctor) echo -Doctor;; remove) echo -Remove;; esac)`

上の実行結果を日本語で短く要約してください。NG や注意があれば、対処を1行ずつ示してください。
