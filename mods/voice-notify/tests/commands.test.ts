import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { jobsStamp, phraseJobs } from '../hooks/phrases'
import { PHRASE_CFG, ROOT, world } from './world'
import type { World, WorldOptions } from './world'

function setup(on: On, opts: WorldOptions = {}): World {
  return world(on, { config: PHRASE_CFG, ...opts })
}

async function settle(w: World) {
  for (let i = 0; i < 10; i++) await w.clock.settle()
}

async function run($: Engine, command: string, args = ''): Promise<string> {
  const r = await $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as never)
  return (r as { text?: string }).text ?? ''
}

const synths = (w: World) => w.runs.filter(a => /^curl(\.exe)?$/.test(a[0]!) && a[1] !== '--version')

describe('voice-notify commands', () => {
  test('the session start registers both commands and makes the missing phrases', async ($, on) => {
    const w = setup(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT } as never)
    await settle(w)
    expect(w.commands).toEqual(['voice-notify'])
    expect(synths(w)).toHaveLength(14)
    expect(w.files.get(`${ROOT}/state/phrases-stamp`)).toBe(jobsStamp(phraseJobs(PHRASE_CFG, ROOT), PHRASE_CFG))
  })

  test('the session start leaves the phrases to another session that is generating them', async ($, on) => {
    const w = setup(on, { files: { [`${ROOT}/state/phrases-progress`]: '{"done":3,"total":14}' } })
    w.mtimes.set(`${ROOT}/state/phrases-progress`, w.clock.now())
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT } as never)
    await settle(w)
    expect(synths(w)).toHaveLength(0)
  })

  test('voice toggles mute, announcing before it mutes and after it unmutes', async ($, on) => {
    const w = setup(on, { files: { [`${ROOT}/phrases/metan/mute/01.wav`]: 'w', [`${ROOT}/phrases/metan/unmute/01.wav`]: 'w' } })
    expect(await run($, 'voice-notify', 'off')).toBe('音声通知: 停止しました')
    expect(w.files.has(`${ROOT}/state/mute`)).toBe(true)
    expect(await run($, 'voice-notify')).toBe('音声通知: 再開しました')
    expect(w.files.has(`${ROOT}/state/mute`)).toBe(false)
    expect(w.played.map(p => p.split('/').slice(-2, -1)[0])).toEqual(['mute', 'unmute'])
    expect(await run($, 'voice-notify', 'status')).toBe('手動ミュート: OFF\nマイク使用中の自動ミュート: 無効\n話者: 最終 めたん / 中間 ずんだもん / 話速: 1.3')
    expect(await run($, 'voice-notify', 'loud')).toMatch(/^知らない引数です: loud。使い方: \/voice-notify \[on\|off\|status\]/)
  })

  test('setup with an unknown argument does nothing', async ($, on) => {
    const w = setup(on)
    expect(await run($, 'voice-notify', 'setup please')).toMatch(/^知らない引数です: setup please。使い方: /)
    expect(w.runs).toEqual([])
  })

  test('setup stops with the install hint when no engine is found', async ($, on) => {
    setup(on, { engine: false, os: 'linux', env: { HOME: '/home/u' } })
    const out = await run($, 'voice-notify', 'setup')
    expect(out).toMatch(/NG   VOICEVOX が見つかりません/)
    expect(out).toMatch(/enginePath/)
  })

  test('setup uses an engine already answering, starts the phrases, and removes the 0.2.0 leftovers', async ($, on) => {
    const w = setup(on, {
      files: { [`${ROOT}/state/turns/sess`]: 'x', [`${ROOT}/state/summaries/s.json`]: '{}', [`${ROOT}/bin/plugin-root.txt`]: 'C:/old' },
    })
    const out = await run($, 'voice-notify', 'setup')
    await settle(w)
    expect(out).toMatch(/OK   0\.2\.0 の残りを消しました（3 件）/)
    expect(out).toMatch(/OK   場所は不明（port 50021 で応答あり）/)
    expect(out).toMatch(/OK   すでに起動済み \(port 50021\)/)
    expect(out).toMatch(/裏で生成を始めました/)
    expect(out).toMatch(/導入しました。音声通知は、このセッションからすぐ有効です。/)
    expect(w.files.has(`${ROOT}/state/phrases-stamp`)).toBe(true)
    expect([...w.files.keys()].some(k => /state\/(turns|summaries)\/|plugin-root/.test(k))).toBe(false)
  })

  test('setup force remakes every phrase; a failed run leaves no stamp', async ($, on) => {
    const w = setup(on, { run: a => (a[0] === 'curl.exe' && a[1] === '-s' ? { exitCode: 22, stderr: 'HTTP 500' } : undefined) })
    await run($, 'voice-notify', 'setup force')
    await settle(w)
    expect(synths(w)).toHaveLength(14)
    expect(w.files.has(`${ROOT}/state/phrases-stamp`)).toBe(false)
    expect(w.files.get(`${ROOT}/notify.log`)).toMatch(/WARN phrases +生成 0 件 \/ 既存流用 0 件 \/ 失敗 14 件/)
  })

  test('doctor only reports: nothing is removed or synthesized', async ($, on) => {
    const w = setup(on, { os: 'linux', linuxPlayers: ['paplay'], env: { HOME: '/home/u' }, files: { [`${ROOT}/state/agents/a1`]: 'x' } })
    const out = await run($, 'voice-notify', 'doctor')
    expect(out).toMatch(/OK   Linux \/ 再生: paplay/)
    expect(out).toMatch(/OK   ENGINE 応答あり \(port 50021\)/)
    expect(out).toMatch(/注意 定型フレーズが足りない: 14\/14 件/)
    expect(out).toMatch(/注意 0\.2\.0 の残りがある（1 件）/)
    expect(w.files.has(`${ROOT}/state/agents/a1`)).toBe(true)
    expect(w.runs.some(a => a[0] === 'rm')).toBe(false)
    expect(synths(w)).toHaveLength(0)
  })

  test('a broken config.json: setup says so, remove still runs', async ($, on) => {
    setup(on, { config: '{"speaker":' })
    expect(await run($, 'voice-notify', 'setup')).toMatch(/NG   config\.json を読めません/)
    expect(await run($, 'voice-notify', 'remove')).toMatch(/^voice-notify を撤去します（ホームは残します）/)
  })
})
