import { describe, expect, test } from 'claude-code/testing'

import { voiceFor } from '../hooks/decide'
import {
  audioQueryUrl,
  cachePath,
  cacheToDrop,
  engineCandidates,
  hash16,
  parseVersion,
  startArgv,
  synthArgv,
  synthParams,
  tuneQuery,
} from '../hooks/voicevox'
import { AUDIO_QUERY, DEFAULT_CONFIG, ROOT } from './world'

const P = synthParams(DEFAULT_CONFIG, voiceFor(DEFAULT_CONFIG, 'final'), ROOT, 'windows')

describe('voicevox', () => {
  test('synthParams reads the config with defaults', () => {
    expect(P).toEqual({ root: ROOT, os: 'windows', port: 50021, speakerId: 2, speed: 1.3, pitch: 0, intonation: 1, leadMs: 600 })
    expect(synthParams({}, { name: 'metan', id: 2 }, ROOT, 'linux')).toEqual({
      root: ROOT, os: 'linux', port: 50021, speakerId: 2, speed: 1, pitch: 0, intonation: 1, leadMs: 600,
    })
  })

  test('tuneQuery sets the voice and adds the lead silence to prePhonemeLength', () => {
    expect(tuneQuery(AUDIO_QUERY, P)).toEqual({ ...AUDIO_QUERY, speedScale: 1.3, pitchScale: 0, intonationScale: 1, prePhonemeLength: 0.7 })
    expect(tuneQuery({ ...AUDIO_QUERY, prePhonemeLength: undefined }, { ...P, leadMs: 0 }).prePhonemeLength).toBe(0.1)
  })

  test('hash16 is 16 hex chars and differs by input', () => {
    expect(hash16('a')).toMatch(/^[0-9a-f]{16}$/)
    expect(hash16('a')).not.toBe(hash16('b'))
    expect(hash16('a')).toBe(hash16('a'))
  })

  test('cachePath depends on the text and every voice setting', () => {
    const a = cachePath(P, 'テスト')
    expect(a).toMatch(new RegExp(`^${ROOT}/cache/[0-9a-f]{16}\\.wav$`))
    expect(cachePath(P, 'テスト')).toBe(a)
    expect(cachePath({ ...P, leadMs: 300 }, 'テスト')).not.toBe(a)
    expect(cachePath({ ...P, speakerId: 3 }, 'テスト')).not.toBe(a)
    expect(cachePath(P, 'テスト2')).not.toBe(a)
  })

  test('audioQueryUrl encodes the text; synthArgv reads the query from stdin and writes the wav', () => {
    expect(audioQueryUrl(P, 'テスト です')).toBe(`http://127.0.0.1:50021/audio_query?text=${encodeURIComponent('テスト です')}&speaker=2`)
    expect(synthArgv(P, `${ROOT}/cache/x.wav`)).toEqual([
      'curl.exe', '-s', '-f', '--create-dirs', '-m', '120', '-H', 'Content-Type: application/json', '--data-binary', '@-',
      '-o', `${ROOT}/cache/x.wav`, 'http://127.0.0.1:50021/synthesis?speaker=2',
    ])
    expect(synthArgv({ ...P, os: 'linux' }, '/h/x.wav')[0]).toBe('curl')
  })

  test('parseVersion reads the JSON string /version answers', () => {
    expect(parseVersion('"0.25.2"')).toBe('0.25.2')
    expect(parseVersion('not json')).toBeNull()
    expect(parseVersion('{"a":1}')).toBeNull()
  })

  test('cacheToDrop keeps the newest wav files up to the cap', () => {
    const entries = [
      { name: 'a.wav', kind: 'file' as const, mtimeMs: 1 },
      { name: 'b.wav', kind: 'file' as const, mtimeMs: 3 },
      { name: 'c.wav', kind: 'file' as const, mtimeMs: 2 },
      { name: 'note.txt', kind: 'file' as const, mtimeMs: 0 },
    ]
    expect(cacheToDrop(entries, ROOT, 2)).toEqual([`${ROOT}/cache/a.wav`])
    expect(cacheToDrop(entries, ROOT, 5)).toEqual([])
  })

  test('engineCandidates per OS', () => {
    expect(engineCandidates('windows', { LOCALAPPDATA: 'C:\\L', ProgramFiles: 'C:/P' }, ['HiroshibaKazuyuki.VOICEVOX.CPU_x'])).toEqual([
      'C:/L/Microsoft/WinGet/Packages/HiroshibaKazuyuki.VOICEVOX.CPU_x/VOICEVOX/vv-engine/run.exe',
      'C:/L/Programs/VOICEVOX/vv-engine/run.exe',
      'C:/P/VOICEVOX/vv-engine/run.exe',
    ])
    expect(engineCandidates('macos', { HOME: '/Users/u' }, [])).toEqual([
      '/Applications/VOICEVOX.app/Contents/Resources/vv-engine/run',
      '/Users/u/Applications/VOICEVOX.app/Contents/Resources/vv-engine/run',
      '/Applications/VOICEVOX.app/Contents/MacOS/vv-engine/run',
      '/Users/u/Applications/VOICEVOX.app/Contents/MacOS/vv-engine/run',
    ])
    expect(engineCandidates('linux', { HOME: '/home/u' }, [])).toEqual([
      '/home/u/.voicevox/vv-engine/run',
      '/home/u/VOICEVOX/vv-engine/run',
      '/opt/voicevox/vv-engine/run',
      '/home/u/.local/share/voicevox/vv-engine/run',
    ])
    // 場所の手がかりが無ければ、その候補は出さない
    expect(engineCandidates('windows', {}, [])).toEqual([])
    expect(engineCandidates('linux', {}, [])).toEqual(['/opt/voicevox/vv-engine/run'])
  })

  test('startArgv runs start-engine.ps1 on Windows and detaches with nohup elsewhere', () => {
    expect(startArgv('windows', 'C:/p', 'C:/v/run.exe')).toEqual([
      'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\p\\scripts\\windows\\start-engine.ps1',
      '-EnginePath', 'C:\\v\\run.exe', '-Quiet',
    ])
    expect(startArgv('linux', '/p', '/home/u/VOICEVOX/vv-engine/run')).toEqual([
      'sh', '-c', 'cd "$(dirname "$1")" && nohup "$1" >/dev/null 2>&1 &', 'sh', '/home/u/VOICEVOX/vv-engine/run',
    ])
  })
})
