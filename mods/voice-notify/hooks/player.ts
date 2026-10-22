// How a wav is played on each OS: through a small script that plays one clip
// at a time across sessions (scripts/windows/play.ps1, scripts/posix/play.sh).
// register.ts runs it. $.audio.play is not used: it plays nothing outside
// macOS (its doc in the types).

import { psArgv, winPath } from './os'
import type { Os } from './os'

export const LINUX_PLAYERS: readonly string[] = ['pw-play', 'paplay', 'aplay']

// The wav goes last on every OS. Null on Linux when no player was found.
export function playArgv(os: Os, pluginRoot: string, root: string, linuxPlayer: string | null, wav: string): string[] | null {
  if (os === 'windows') return psArgv(pluginRoot, 'play.ps1', [winPath(wav)])
  const player = os === 'macos' ? 'afplay' : linuxPlayer
  if (!player) return null
  return ['sh', `${pluginRoot}/scripts/posix/play.sh`, `${root}/state/playback.lock`, player, wav]
}

export function probeArgv(name: string): string[] {
  return ['sh', '-c', `command -v ${name}`]
}
