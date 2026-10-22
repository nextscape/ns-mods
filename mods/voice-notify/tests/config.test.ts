import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG, configErrors, mergeConfig, parseConfig, resolveConfig, voiceHome } from '../hooks/config'

describe('config', () => {
  test('parseConfig refuses anything but an object, and reads past a BOM', () => {
    expect(() => parseConfig('null')).toThrow(/オブジェクト/)
    expect(() => parseConfig('[]')).toThrow(/オブジェクト/)
    expect(() => parseConfig('"x"')).toThrow(/オブジェクト/)
    expect(parseConfig('\uFEFF{"speaker":"metan"}')).toEqual({ speaker: 'metan' })
  })

  test('mergeConfig: objects merge key by key; arrays and values from the user win; unknown user keys stay', () => {
    const defaults = { speaker: 'metan', speech: { summarize: true, readings: { FIX: 'フィックス' }, summaryPrompt: ['a', 'b'] }, playback: { leadSilenceMs: 600 } }
    const user = { speech: { summarize: false, summaryPrompt: ['c'] }, extra: 1 }
    expect(mergeConfig(defaults, user)).toEqual({
      speaker: 'metan',
      speech: { summarize: false, readings: { FIX: 'フィックス' }, summaryPrompt: ['c'] },
      playback: { leadSilenceMs: 600 },
      extra: 1,
    })
    // null is no "delete": it is the user's value, as any other.
    expect(mergeConfig({ a: { b: 1 } }, { a: null })).toEqual({ a: null })
  })

  test('resolveConfig: an empty config.json runs at the defaults; what it sets wins', () => {
    expect(resolveConfig({})).toEqual(DEFAULT_CONFIG)
    const cfg = resolveConfig({ speedScale: 1.1, speech: { summarize: false } })
    expect(cfg.speedScale).toBe(1.1)
    expect(cfg.speech.summarize).toBe(false)
    expect(cfg.speech.summaryMaxChars).toBe(DEFAULT_CONFIG.speech.summaryMaxChars)
  })

  test('configErrors: each key keeps its default kind; the voices name defined speakers', () => {
    expect(configErrors(mergeConfig(DEFAULT_CONFIG, {}))).toEqual([])
    const errors = configErrors(mergeConfig(DEFAULT_CONFIG, {
      speedScale: '1.2',
      speech: { summaryPrompt: 'one line', summarize: 'yes' },
      mute: null,
      enginePath: 5,
      speakers: { tsumugi: { label: 'x' } },
      speaker: 'sora',
    }))
    expect(errors).toEqual([
      'speedScale は数値にする',
      'speech.summarize は true か false にする',
      'speech.summaryPrompt は配列にする',
      'mute はオブジェクトにする',
      'enginePath は文字列にする',
      'speakers.tsumugi.id は数値にする',
      'speaker の「sora」が speakers に無い',
    ])
    expect(() => resolveConfig({ speedScale: '1.2' })).toThrow(/speedScale は数値にする/)
  })

  test('configErrors: phrases may be reshaped freely (an empty array silences a folder of folders)', () => {
    expect(configErrors(mergeConfig(DEFAULT_CONFIG, { phrases: { stop: [] } }))).toEqual([])
  })

  test('voiceHome: VOICE_NOTIFY_HOME, else the user folder', () => {
    expect(voiceHome('D:\\v\\', undefined, undefined)).toBe('D:/v')
    expect(voiceHome(undefined, 'C:\\Users\\u', undefined)).toBe('C:/Users/u/.claude/voice-notify')
    expect(voiceHome(undefined, undefined, '/home/u')).toBe('/home/u/.claude/voice-notify')
    expect(voiceHome(undefined, undefined, undefined)).toBeNull()
  })
})
