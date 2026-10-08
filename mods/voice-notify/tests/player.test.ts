import { describe, expect, test } from 'claude-code/testing'

import { LINUX_PLAYERS, playArgv, probeArgv } from '../hooks/player'

describe('player', () => {
  test('playArgv: a script per OS with the wav last', () => {
    expect(playArgv('windows', 'C:/p', 'C:/vn', null, 'C:/vn/a b.wav')).toEqual([
      'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\p\\scripts\\windows\\play.ps1', 'C:\\vn\\a b.wav',
    ])
    expect(playArgv('macos', '/p', '/h', null, '/h/a.wav')).toEqual(['sh', '/p/scripts/posix/play.sh', '/h/state/playback.lock', 'afplay', '/h/a.wav'])
    expect(playArgv('linux', '/p', '/h', 'paplay', '/h/a.wav')).toEqual(['sh', '/p/scripts/posix/play.sh', '/h/state/playback.lock', 'paplay', '/h/a.wav'])
    expect(playArgv('linux', '/p', '/h', null, '/h/a.wav')).toBeNull()
  })

  test('Linux players are tried in order, each by command -v', () => {
    expect(LINUX_PLAYERS).toEqual(['pw-play', 'paplay', 'aplay'])
    expect(probeArgv('paplay')).toEqual(['sh', '-c', 'command -v paplay'])
  })
})
