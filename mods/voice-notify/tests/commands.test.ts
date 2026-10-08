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

  test('filling in beside phrases of unknown settings (0.2.0, no stamp) leaves no stamp, so doctor asks for force', async ($, on) => {
    // 0.2.0 のフレーズは先頭の無音が無い。stamp を書くと doctor が作り直しを案内せず、頭が欠けたまま鳴る
    const jobs = phraseJobs(PHRASE_CFG, ROOT)
    const w = setup(on, { files: Object.fromEntries(jobs.slice(1).map(j => [j.path, 'RIFF'])) })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT } as never)
    await settle(w)
    expect(synths(w)).toHaveLength(1)
    expect(w.files.has(`${ROOT}/state/phrases-stamp`)).toBe(false)
    expect(await run($, 'voice-notify', 'doctor')).toMatch(/setup force で作り直す/)
  })

  test('filling in beside phrases made with the current settings keeps the stamp', async ($, on) => {
    const jobs = phraseJobs(PHRASE_CFG, ROOT)
    const stamp = jobsStamp(jobs, PHRASE_CFG)
    const w = setup(on, { files: { ...Object.fromEntries(jobs.slice(1).map(j => [j.path, 'RIFF'])), [`${ROOT}/state/phrases-stamp`]: stamp } })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT } as never)
    await settle(w)
    expect(synths(w)).toHaveLength(1)
    expect(w.files.get(`${ROOT}/state/phrases-stamp`)).toBe(stamp)
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
    expect(await run($, 'voice-notify', 'status')).toBe('手動ミュート: OFF\nマイク使用中の自動ミュート: 無効\n話者: 最終 めたん / 中間 ずんだもん / 話速: 1.3\nクレジット: VOICEVOX')
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

  test('setup force removes every wav in the phrase folders, stale ones too, before remaking', async ($, on) => {
    // 文言を6件から2件に減らしたあとの force。03〜06.wav が残ると、消した文言が鳴り続ける
    const stale: Record<string, string> = {}
    for (const n of ['01', '02', '03', '04', '05', '06']) stale[`${ROOT}/phrases/metan/stop/done/${n}.wav`] = 'old'
    const w = setup(on, { files: { ...stale, [`${ROOT}/phrases/metan/stop/done/.keep`]: '' } })
    await run($, 'voice-notify', 'setup force')
    await settle(w)
    const left = [...w.files.keys()].filter(k => k.startsWith(`${ROOT}/phrases/metan/stop/done/`) && k.endsWith('.wav')).sort()
    expect(left).toEqual([`${ROOT}/phrases/metan/stop/done/01.wav`, `${ROOT}/phrases/metan/stop/done/02.wav`])
    expect(w.files.get(`${ROOT}/phrases/metan/stop/done/01.wav`)).toBe('RIFF-fake-wav')
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

  test('Windows: setup hands install.ps1 the engine it found; an engine that only answers gets no task', async ($, on) => {
    const w = setup(on, {
      env: { ProgramFiles: 'C:/P' },
      files: { 'C:/P/VOICEVOX/vv-engine/run.exe': 'x' },
      run: a => (a.includes('install') ? { stdout: 'OK スケジュールタスク\nOK ホットキー CTRL+ALT+M\n' } : undefined),
    })
    const out = await run($, 'voice-notify', 'setup')
    const ps = w.runs.find(a => a.includes('install'))!
    expect(ps.slice(7)).toEqual(['-Action', 'install', '-VHome', 'C:\\vn', '-HotKey', 'CTRL+ALT+M', '-EnginePath', 'C:\\P\\VOICEVOX\\vv-engine\\run.exe'])
    expect(out).toMatch(/   OK   スケジュールタスク\n   OK   ホットキー CTRL\+ALT\+M/)
    w.files.delete('C:/P/VOICEVOX/vv-engine/run.exe')
    await run($, 'voice-notify', 'setup')
    expect(w.runs.filter(a => a.includes('install')).at(-1)).not.toContain('-EnginePath')
  })

  test('macOS: setup writes the plist and bootstraps it; remove boots it out', async ($, on) => {
    const app = '/Applications/VOICEVOX.app/Contents/Resources/vv-engine/run'
    const w = setup(on, { os: 'macos', env: { HOME: '/Users/u' }, files: { [app]: 'x' }, run: a => (a[0] === 'id' ? { stdout: '501\n' } : undefined) })
    const out = await run($, 'voice-notify', 'setup')
    const plist = '/Users/u/Library/LaunchAgents/jp.nextscape.voice-notify.engine.plist'
    expect(w.files.get(plist)).toBe(`<string>jp.nextscape.voice-notify.engine</string><string>${app}</string><string>/Applications/VOICEVOX.app/Contents/Resources/vv-engine</string>`)
    expect(w.runs).toContainEqual(['launchctl', 'bootstrap', 'gui/501', plist])
    expect(out).toMatch(/OK   launchd: /)
    expect(out).toMatch(/ホットキーは Windows だけです/)
    await run($, 'voice-notify', 'remove')
    expect(w.runs).toContainEqual(['launchctl', 'bootout', 'gui/501/jp.nextscape.voice-notify.engine'])
    expect(w.files.has(plist)).toBe(false)
  })

  test('Linux: setup writes the unit and enables it; doctor reads it; remove disables and deletes it', async ($, on) => {
    const exe = '/home/u/VOICEVOX/vv-engine/run'
    const w = setup(on, { os: 'linux', env: { HOME: '/home/u' }, files: { [exe]: 'x' }, run: a => (a[2] === 'is-enabled' ? { stdout: 'enabled\n' } : undefined) })
    await run($, 'voice-notify', 'setup')
    const unit = '/home/u/.config/systemd/user/voice-notify-engine.service'
    expect(w.files.get(unit)).toBe(`WorkingDirectory=/home/u/VOICEVOX/vv-engine\nExecStart="${exe}"\n`)
    expect(w.runs).toContainEqual(['systemctl', '--user', 'enable', '--now', 'voice-notify-engine.service'])
    expect(await run($, 'voice-notify', 'doctor')).toMatch(/OK   ログオン時起動（systemd）: enabled/)
    await run($, 'voice-notify', 'remove')
    expect(w.runs).toContainEqual(['systemctl', '--user', 'disable', '--now', 'voice-notify-engine.service'])
    expect(w.files.has(unit)).toBe(false)
  })

  test('an engine that only answers (Docker) registers nothing on Linux', async ($, on) => {
    const w = setup(on, { os: 'linux', env: { HOME: '/home/u' } })
    expect(await run($, 'voice-notify', 'setup')).toMatch(/外部の ENGINE（Docker など）を使うので、ログオン時の起動は登録しません/)
    expect(w.runs.some(a => a[0] === 'systemctl')).toBe(false)
  })

  test('doctor reports a missing curl instead of failing', async ($, on) => {
    setup(on, { missing: ['curl.exe'] })
    expect(await run($, 'voice-notify', 'doctor')).toMatch(/NG   curl が見つからない/)
  })

  test('a Linux without systemd: setup and doctor say so instead of failing', async ($, on) => {
    const exe = '/home/u/VOICEVOX/vv-engine/run'
    setup(on, { os: 'linux', env: { HOME: '/home/u' }, files: { [exe]: 'x' }, missing: ['systemctl'] })
    expect(await run($, 'voice-notify', 'setup')).toMatch(/NG   systemctl --user enable が失敗/)
    expect(await run($, 'voice-notify', 'doctor')).toMatch(/注意 ログオン時起動（systemd）なし/)
    expect(await run($, 'voice-notify', 'remove')).toMatch(/^voice-notify を撤去します/)
  })

  test('a broken config.json: setup says so, remove still runs', async ($, on) => {
    setup(on, { config: '{"speaker":' })
    expect(await run($, 'voice-notify', 'setup')).toMatch(/NG   config\.json を読めません/)
    expect(await run($, 'voice-notify', 'remove')).toMatch(/^voice-notify を撤去します（ホームは残します）/)
  })
})
