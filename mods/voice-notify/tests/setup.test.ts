import { describe, expect, test } from 'claude-code/testing'

import { USAGE, creditLine, doctorReport, hasKanaReading, parseCommand, voiceStatus } from '../hooks/setup'
import type { DoctorFacts } from '../hooks/setup'
import { DEFAULT_CONFIG } from './world'

const FACTS: DoctorFacts = {
  pluginRoot: 'C:/p',
  root: 'C:/vn',
  os: 'linux',
  player: 'paplay',
  curl: 'curl 8.0.0',
  engine: { path: null, running: true },
  port: 50021,
  version: '0.25.2',
  phrases: { total: 14, missing: 14, current: false, busy: false, progress: null },
  autostart: ['\n== 常駐まわり', '   OK   ログオン時起動（systemd）: enabled'],
  muted: false,
  legacy: 1,
  errors: [],
  credit: 'VOICEVOX:四国めたん',
}

describe('setup', () => {
  test('parseCommand: mute control by default, setup / doctor / remove as subcommands', () => {
    expect(parseCommand('')).toEqual({ kind: 'voice', action: 'toggle' })
    expect(parseCommand(' On ')).toEqual({ kind: 'voice', action: 'unmute' })
    expect(parseCommand('off')).toEqual({ kind: 'voice', action: 'mute' })
    expect(parseCommand('status')).toEqual({ kind: 'voice', action: 'status' })
    expect(parseCommand('setup')).toEqual({ kind: 'setup', action: 'install' })
    expect(parseCommand('setup  force')).toEqual({ kind: 'setup', action: 'force' })
    expect(parseCommand('doctor')).toEqual({ kind: 'setup', action: 'doctor' })
    expect(parseCommand('remove')).toEqual({ kind: 'setup', action: 'remove' })
    expect(parseCommand('setup please')).toBeNull()
    expect(parseCommand('loud')).toBeNull()
    expect(USAGE).toBe('使い方: /voice-notify [on|off|status]（省略時は切替） / /voice-notify setup [force] / /voice-notify doctor / /voice-notify remove')
  })

  test('voiceStatus is four lines, the last the credit; mic muting is only on Windows', () => {
    expect(voiceStatus(DEFAULT_CONFIG, 'windows', false)).toBe('手動ミュート: OFF\nマイク使用中の自動ミュート: 無効\n話者: 最終 めたん / 中間 ずんだもん / 話速: 1.3\nクレジット: VOICEVOX')
    expect(voiceStatus({ ...DEFAULT_CONFIG, mute: { whenMicInUse: true } }, 'windows', true).split('\n').slice(0, 2)).toEqual([
      '手動ミュート: ON', 'マイク使用中の自動ミュート: 有効',
    ])
    expect(voiceStatus({ ...DEFAULT_CONFIG, mute: { whenMicInUse: true } }, 'linux', false).split('\n')[1]).toBe('マイク使用中の自動ミュート: 無効')
  })

  test('creditLine names the credit of each speaker in use, once each; a speaker without one is plain VOICEVOX', () => {
    const speakers = { metan: { id: 2, credit: 'VOICEVOX:四国めたん' }, zundamon: { id: 3, credit: 'VOICEVOX:ずんだもん' }, x: { id: 9, credit: 'VOICEVOX:X' } }
    expect(creditLine({ speaker: 'metan', speakerInterim: 'zundamon', speakers })).toBe('VOICEVOX:四国めたん、VOICEVOX:ずんだもん')
    expect(creditLine({ speaker: 'metan', speakerInterim: 'metan', speakers })).toBe('VOICEVOX:四国めたん')
    expect(creditLine({ speaker: 'metan', speakerInterim: 'zundamon', speakers: { metan: { id: 2 }, zundamon: { id: 3 } } })).toBe('VOICEVOX')
  })

  test('creditLine names the credit of each speaker in use, once each; a speaker without one is plain VOICEVOX', () => {
    const speakers = { metan: { id: 2, credit: 'VOICEVOX:四国めたん' }, zundamon: { id: 3, credit: 'VOICEVOX:ずんだもん' }, x: { id: 9, credit: 'VOICEVOX:X' } }
    expect(creditLine({ speaker: 'metan', speakerInterim: 'zundamon', speakers })).toBe('VOICEVOX:四国めたん、VOICEVOX:ずんだもん')
    expect(creditLine({ speaker: 'metan', speakerInterim: 'metan', speakers })).toBe('VOICEVOX:四国めたん')
    expect(creditLine({ speaker: 'metan', speakerInterim: 'zundamon', speakers: { metan: { id: 2 }, zundamon: { id: 3 } } })).toBe('VOICEVOX')
  })

  test('hasKanaReading from ENGINE 0.24', () => {
    expect(hasKanaReading('0.25.2')).toBe(true)
    expect(hasKanaReading('0.24.0')).toBe(true)
    expect(hasKanaReading('0.23.1')).toBe(false)
    expect(hasKanaReading('1.0.0')).toBe(true)
  })

  test('doctorReport lays the facts out in the 0.2.0 format', () => {
    const out = doctorReport(FACTS).join('\n')
    expect(out).toMatch(/^voice-notify 診断\nプラグイン: C:\/p\nホーム:     C:\/vn\n\n== 設定（config\.json）\n   OK   C:\/vn\/config\.json/)
    expect(out).toMatch(/OK   Linux \/ 再生: paplay/)
    expect(out).toMatch(/OK   curl: curl 8\.0\.0/)
    expect(out).toMatch(/注意 場所は不明（応答はある）/)
    expect(out).toMatch(/OK   ENGINE 応答あり \(port 50021\)\n   OK   ENGINE 0\.25\.2（英単語のカタカナ読みあり）/)
    expect(out).toMatch(/注意 定型フレーズが足りない: 14\/14 件。\/voice-notify setup を実行する/)
    expect(out).toMatch(/OK   ログオン時起動（systemd）: enabled/)
    expect(out).toMatch(/注意 0\.2\.0 の残りがある（1 件）。\/voice-notify setup で消える/)
    expect(out).toMatch(/OK   直近200行にエラーなし\n\n== クレジット\n   OK   VOICEVOX:四国めたん$/)
  })

  test('doctorReport names what is missing', () => {
    const out = doctorReport({
      ...FACTS, os: 'linux', player: null, curl: null, engine: null, version: null,
      phrases: { total: 14, missing: 0, current: false, busy: false, progress: null }, legacy: 0, muted: true, errors: ['2026-10-07 21:00:00  ERR  play        再生失敗 a.wav: x'],
    }).join('\n')
    expect(out).toMatch(/NG   Linux \/ 再生コマンドが見つからない/)
    expect(out).toMatch(/NG   curl が見つからない/)
    expect(out).toMatch(/NG   見つからない。公式サイトの tar\.gz を展開し/)
    expect(out).toMatch(/NG   ENGINE が応答しない \(port 50021\)/)
    expect(out).toMatch(/注意 定型フレーズが今の設定（文言・話者・話速・読み替え・先頭の無音）と合わない。\/voice-notify setup force で作り直す/)
    expect(out).toMatch(/OK   手動ミュート中（\/voice-notify on で解除）/)
    expect(out).toMatch(/注意 直近200行にエラー 1 件。最後: ERR  play        再生失敗 a\.wav: x/)
    expect(out).not.toMatch(/0\.2\.0 の残り/)
  })
})
