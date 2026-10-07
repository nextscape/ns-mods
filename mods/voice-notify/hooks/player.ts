// 再生コマンドの形。OS ごとの再生を、排他つきの小さなスクリプト（scripts/windows/play.ps1・scripts/posix/play.sh）経由で呼ぶ。
// 実行は register.ts。$.audio.play は macOS 以外では鳴らない（型定義の説明）ので使わない。

import type { Os } from './os'

export const LINUX_PLAYERS: readonly string[] = ['pw-play', 'paplay', 'aplay']

const win = (p: string) => p.replace(/\//g, '\\')

// どれも wav を最後に渡す。Linux でプレイヤーが見つかっていなければ null
export function playArgv(os: Os, pluginRoot: string, root: string, linuxPlayer: string | null, wav: string): string[] | null {
  if (os === 'windows') {
    return ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', win(`${pluginRoot}/scripts/windows/play.ps1`), win(wav)]
  }
  const player = os === 'macos' ? 'afplay' : linuxPlayer
  if (!player) return null
  return ['sh', `${pluginRoot}/scripts/posix/play.sh`, `${root}/state/playback.lock`, player, wav]
}

export function probeArgv(name: string): string[] {
  return ['sh', '-c', `command -v ${name}`]
}
