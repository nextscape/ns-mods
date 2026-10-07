import { describe, expect, test } from 'claude-code/testing'

import { DEFAULTS, mentionsEffortRouter, parseSettings } from '../hooks/settings'
import { TEXT, describeBuild, describeSettings, formatGateLog, formatMainLog, formatSubLog, statusLine } from '../hooks/ui'

describe('settings', () => {
  test('stored values are validated and the rest defaulted', () => {
    expect(parseSettings({ floor: 'high', top: 'fable', gate: 'bogus' })).toEqual({ ...DEFAULTS, floor: 'high', top: 'fable' })
  })

  test('effort-router counts as installed only when loaded as a plugin', () => {
    const dirs = JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: 'C:/Users/u/.claude/mods/effort-router' } })
    const plugin = JSON.stringify({ enabledPlugins: { 'effort-router@local': true } })
    const permission = JSON.stringify({ permissions: { allow: ['Read(C:/Users/u/mods/effort-router/**)'] } })
    expect(mentionsEffortRouter(dirs)).toBe(true)
    expect(mentionsEffortRouter(plugin)).toBe(true)
    expect(mentionsEffortRouter(permission)).toBe(false)
    expect(mentionsEffortRouter('{ not json')).toBe(false)
  })

  test('a plugin turned off in enabledPlugins does not count', () => {
    expect(mentionsEffortRouter(JSON.stringify({ enabledPlugins: { 'effort-router@local': false } }))).toBe(false)
    expect(mentionsEffortRouter({ enabledPlugins: { 'effort-router@inline': true } })).toBe(true)
  })

  test('CLAUDE_CODE_PLUGIN_DIRS lists split on ; (Windows) and : (POSIX), keeping drive letters', () => {
    const dirs = (value: string) => ({ env: { CLAUDE_CODE_PLUGIN_DIRS: value } })
    expect(mentionsEffortRouter(dirs('C:\\Users\\t\\effort-router; D:/mods/quality-router'))).toBe(true)
    expect(mentionsEffortRouter(dirs('D:/mods/quality-router;C:\\Users\\t\\effort-router\\'))).toBe(true)
    expect(mentionsEffortRouter(dirs('/home/u/effort-router:/home/u/quality-router'))).toBe(true)
    expect(mentionsEffortRouter(dirs('/home/u/quality-router:/home/u/effort-router'))).toBe(true)
    expect(mentionsEffortRouter(dirs('C:/mods/effort-router-old;C:/mods/quality-router'))).toBe(false)
  })
})

describe('ui', () => {
  const base = { settings: DEFAULTS, paused: false, sub: 2 }

  test('the status line names the level, why, the sub count and the gate', () => {
    expect(statusLine({ ...base, main: { level: 'xhigh', judged: 'medium', skill: 'superpowers:brainstorming' } })).toBe(
      'main xhigh (judged medium, skill: brainstorming) · sub 2 · gate on',
    )
    expect(statusLine({ ...base, main: { level: 'high', offModel: 'claude-sonnet-5-5' } })).toBe('main sonnet! high · sub 2 · gate on')
    expect(statusLine({ ...base, main: { level: 'max', bump: true } })).toBe('main max +1 · sub 2 · gate on')
    expect(statusLine({ ...base, main: {} })).toBe('main waiting · sub 2 · gate on')
    expect(statusLine({ ...base, paused: true, main: {} })).toBe('main paused (effort-router) · sub 2 · gate on')
    expect(statusLine({ ...base, paused: true, main: { offModel: 'claude-sonnet-5-5' } })).toBe(
      'main sonnet! paused (effort-router) · sub 2 · gate on',
    )
    expect(statusLine({ ...base, settings: { ...DEFAULTS, mode: 'off' }, main: {} })).toBe('off · gate on')
  })

  test('a known version leads the status line; an unknown one adds nothing', () => {
    expect(statusLine({ ...base, version: '0.2.1', main: { level: 'high' } })).toBe('v0.2.1 · main high · sub 2 · gate on')
    expect(statusLine({ ...base, version: '0.2.1', settings: { ...DEFAULTS, mode: 'off' }, main: {} })).toBe('v0.2.1 · off · gate on')
    expect(statusLine({ ...base, version: null, main: { level: 'high' } })).toBe('main high · sub 2 · gate on')
  })

  test('/qr and /qr version name the version and where the mod was loaded from', () => {
    const build = { version: '0.2.1', root: 'C:/mods/quality-router' }
    expect(describeBuild(build)).toBe('quality-router v0.2.1（読み込み元: C:/mods/quality-router）')
    expect(describeBuild({ version: null, root: null })).toBe('quality-router v?（読み込み元: 不明）')
    const text = describeSettings(DEFAULTS, false, null, undefined, build)
    expect(text.split('\n')[0]).toBe('quality-router v0.2.1 の設定')
    expect(text.split('\n').at(-1)).toBe('- 読み込み元: C:/mods/quality-router')
    expect(describeSettings(DEFAULTS, false, null).split('\n')[0]).toBe('quality-router の設定')
    expect(TEXT.unknown('x')).toContain('| version')
  })

  test('Japanese text explains settings and refusals', () => {
    expect(describeSettings(DEFAULTS, false, null)).toContain('- 本体の段階: floor medium / ceiling max')
    expect(TEXT.unknown('floor huge')).toContain('「floor huge」は使えません。')
    expect(TEXT.denied(2)).toBe('Workflow を差し戻しました（2件）')
  })

  test('/qr text includes the latest judgment when given one', () => {
    expect(describeSettings(DEFAULTS, false, null, { level: 'high', judged: 'medium' })).toContain('- 直近の判定: high（judged medium）')
    expect(describeSettings(DEFAULTS, false, null, { level: 'max', judged: 'max', bump: true })).toContain('- 直近の判定: max（+1）')
    expect(describeSettings(DEFAULTS, false, null, {})).toContain('- 直近の判定: まだありません')
    expect(describeSettings(DEFAULTS, false, null)).not.toContain('直近の判定')
  })

  test('the main log reads prev -> level with the raw judgment', () => {
    const text = formatMainLog([
      { at: 0, head: '依頼', prev: 'xhigh', judged: 'medium', level: 'high', why: 'auto', bound: null, skill: null, bump: false, model: 'claude-opus-5-5', guarded: false, durationMs: 1000 },
    ])
    expect(text).toContain('main: 1 turns logged')
    expect(text).toContain('xhigh -> high (judged medium)')
  })

  test('the main log names the bound, the skill floor, the bump and the model', () => {
    const one = { at: 0, head: '依頼', prev: null, judged: 'medium', why: 'auto', durationMs: 1000 } as const
    const text = formatMainLog([
      { ...one, level: 'xhigh', bound: 'skill', skill: 'superpowers:brainstorming', bump: true, model: 'claude-opus-5-5', guarded: true },
      { ...one, prev: 'xhigh', level: 'high', bound: 'ceiling', skill: null, bump: false, model: null, guarded: false },
    ])
    expect(text).toContain('  - -> xhigh (judged medium) by skill [skill brainstorming] +1\tauto\tclaude-opus-5-5 (guarded)\t依頼')
    expect(text).toContain('  xhigh -> high (judged medium) by ceiling\tauto\t-\t依頼')
    expect(formatMainLog([])).toBe('main: まだ記録がありません。')
  })

  test('the sub log reads role/why -> model effort, with the type and the description', () => {
    const text = formatSubLog([
      { at: 0, description: 'list hooks', type: 'general-purpose', role: 'chore/light', why: 'auto', model: 'sonnet', effort: 'medium', agentId: 'a1' },
      { at: 1, description: 'review diff', type: 'claude', role: 'unsure', why: 'unsure', model: null, effort: null, agentId: null },
    ])
    expect(text).toBe(
      ['sub: 2 spawns logged', '  chore/light/auto -> sonnet medium\tgeneral-purpose\tlist hooks', '  unsure/unsure -> - -\tclaude\treview diff'].join('\n'),
    )
    expect(formatSubLog([])).toBe('sub: まだ記録がありません。')
  })

  test('the gate log reads the verdict, its count, the source and the calls', () => {
    const text = formatGateLog([
      { at: 0, source: 'script', verdict: 'deny', count: 2, calls: 3 },
      { at: 1, source: 'name', verdict: 'unchecked', count: 0, calls: 0 },
    ])
    expect(text).toBe(['gate: 2 checks logged', '  deny (2) script calls=3', '  unchecked (0) name calls=0'].join('\n'))
    expect(formatGateLog([])).toBe('gate: まだ記録がありません。')
  })

  test('each log shows its last ten entries and counts them all', () => {
    const list = Array.from({ length: 12 }, (_, i) => ({ at: i, source: 'script', verdict: 'pass', count: 0, calls: i }) as const)
    const text = formatGateLog([...list])
    expect(text).toContain('gate: 12 checks logged')
    expect(text).not.toContain('calls=1\n')
    expect(text).toContain('calls=2\n')
    expect(text.split('\n').length).toBe(11)
  })
})
