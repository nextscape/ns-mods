import { describe, expect, test } from 'claude-code/testing'

import {
  agentReportFallback,
  agentText,
  choosePhrase,
  enginePort,
  mergeConfig,
  noticeKind,
  parseConfig,
  permissionText,
  pickFor,
  planStop,
  planSummary,
  voiceFor,
  voiceHome,
} from '../hooks/decide'
import type { VoiceConfig } from '../hooks/decide'

const CFG: VoiceConfig = {
  speaker: 'metan',
  speakerInterim: 'zundamon',
  speakers: { metan: { id: 2, label: 'めたん' }, zundamon: { id: 3, label: 'ずんだもん' } },
  speech: {
    summarize: true,
    summarizeEvents: ['stop', 'agentstop'],
    summaryMinChars: 80,
    summaryMaxChars: 60,
    interimMaxChars: 30,
    interimPrompt: ['途中なので{maxChars}文字で。'],
    summaryPrompt: ['{maxChars}文字以内で。'],
    briefMaxSeconds: 30,
  },
  notification: { toolLabels: { Bash: 'コマンド実行' } },
}
const DONE = '修正しました。テストも通っています。'
const ASK = 'この方針で進めてよろしいですか。'

describe('decide', () => {
  test('voiceFor: interim uses speakerInterim, falling back to the final speaker', () => {
    expect(voiceFor(CFG, 'final')).toEqual({ name: 'metan', id: 2 })
    expect(voiceFor(CFG, 'interim')).toEqual({ name: 'zundamon', id: 3 })
    expect(voiceFor({ ...CFG, speakerInterim: 'nobody' }, 'interim')).toEqual({ name: 'metan', id: 2 })
  })

  test('enginePort and pickFor read the config with defaults', () => {
    expect(enginePort({})).toBe(50021)
    expect(enginePort({ enginePort: 50121 })).toBe(50121)
    expect(pickFor({}, DONE)).toBe(DONE)
    expect(pickFor({ speech: { shortSentenceChars: 3 } }, DONE)).toBe('修正しました。')
  })

  test('planStop: a long turn reads its body after the case phrase', () => {
    expect(planStop({ cfg: CFG, answer: DONE, durationMs: 60_000, running: 0, engineAlive: true })).toEqual({
      role: 'final', case: 'done', pcase: 'done', brief: false, phrases: ['stop/done', 'stop'], read: true,
    })
  })

  test('planStop: a short turn only plays the brief phrase, keeping ask and trouble apart', () => {
    expect(planStop({ cfg: CFG, answer: ASK, durationMs: 10_000, running: 0, engineAlive: true })).toEqual({
      role: 'final', case: 'ask', pcase: 'ask', brief: true, phrases: ['stop/brief/ask', 'stop/ask', 'stop'], read: false,
    })
  })

  test('planStop: with subagents still running, done becomes interim in the interim voice', () => {
    expect(planStop({ cfg: CFG, answer: DONE, durationMs: 60_000, running: 2, engineAlive: true })).toEqual({
      role: 'interim', case: 'done', pcase: 'interim', brief: false, phrases: ['stop/interim', 'stop/done', 'stop'], read: true,
    })
    // ask は途中でも対応が要るので interim に変えない
    expect(planStop({ cfg: CFG, answer: ASK, durationMs: 60_000, running: 1, engineAlive: true }).pcase).toBe('ask')
  })

  test('planStop: no readable body or no engine is solo, which never reads', () => {
    expect(planStop({ cfg: CFG, answer: '', durationMs: 60_000, running: 0, engineAlive: true })).toEqual({
      role: 'final', case: 'solo', pcase: 'solo', brief: false, phrases: ['stop/solo', 'stop'], read: false,
    })
    expect(planStop({ cfg: CFG, answer: DONE, durationMs: 60_000, running: 0, engineAlive: false }).case).toBe('solo')
    // solo で中間報告なら、本文が続かないので短いほうの interim
    expect(planStop({ cfg: CFG, answer: '', durationMs: 60_000, running: 1, engineAlive: true }).phrases).toEqual([
      'stop/brief/interim', 'stop/interim', 'stop/solo', 'stop',
    ])
  })

  test('planSummary: disabled, other events and short answers are skipped; interim is capped', () => {
    const long = 'あ'.repeat(100)
    expect(planSummary({ ...CFG.speech, summarize: false }, 'stop', 'final', long)).toEqual({ skip: 'disabled' })
    expect(planSummary({ ...CFG.speech, summarizeEvents: ['stop'] }, 'agentstop', 'interim', long)).toEqual({ skip: 'event' })
    expect(planSummary(CFG.speech!, 'stop', 'final', 'あ'.repeat(79))).toEqual({ skip: 'short' })
    expect(planSummary(CFG.speech!, 'stop', 'final', long)).toEqual({ skip: null, maxChars: 60, system: '60文字以内で。' })
    expect(planSummary(CFG.speech!, 'agentstop', 'interim', 'あ'.repeat(29))).toEqual({ skip: 'short' })
    expect(planSummary(CFG.speech!, 'agentstop', 'interim', 'あ'.repeat(30))).toEqual({
      skip: null, maxChars: 30, system: '30文字以内で。\n途中なので30文字で。',
    })
  })

  test('agentText: description and report, without repeating a report that already says done', () => {
    expect(agentText('調査', '原因はパスでした。')).toBe('調査が完了しました。原因はパスでした。')
    expect(agentText('調査', '調査が完了しました。原因はパスでした。')).toBe('調査。調査が完了しました。原因はパスでした。')
    expect(agentText('調査', null)).toBe('調査が完了しました。')
    expect(agentText(null, '原因はパスでした。')).toBe('原因はパスでした。')
    expect(agentText(null, null)).toBeNull()
  })

  test('agentReportFallback: a picked sentence longer than the cap is dropped', () => {
    expect(agentReportFallback('短い報告です。', CFG.speech!)).toBe('短い報告です。')
    // 上限は max(interimMaxChars, interimMaxChars) + 1 = 31
    expect(agentReportFallback('あ'.repeat(31), CFG.speech!)).toBe('あ'.repeat(31))
    expect(agentReportFallback('あ'.repeat(32), CFG.speech!)).toBeNull()
    expect(agentReportFallback(null, CFG.speech!)).toBeNull()
  })

  test('permissionText and noticeKind', () => {
    expect(permissionText(CFG, 'Bash')).toBe('コマンド実行の許可待ちです。')
    expect(permissionText(CFG, 'mcp__x__y')).toBe('mcp__x__yの許可待ちです。')
    expect(noticeKind('idle_prompt')).toBe('idle')
    expect(noticeKind('elicitation_dialog')).toBe('permission')
    expect(noticeKind('agent_needs_input')).toBe('permission')
    expect(noticeKind('quota_auto_resume_fired')).toBe('notification')
    expect(noticeKind('permission_prompt')).toBeNull()
    expect(noticeKind('something_new')).toBeNull()
  })

  test('choosePhrase avoids the previous pick unless it is the only one', () => {
    expect(choosePhrase(['01.wav', '02.wav'], '01.wav', 0)).toBe('02.wav')
    expect(choosePhrase(['01.wav'], '01.wav', 0.9)).toBe('01.wav')
    expect(choosePhrase(['01.wav', '02.wav', '03.wav'], null, 0.99)).toBe('03.wav')
    expect(choosePhrase([], null, 0)).toBeNull()
  })

  test('parseConfig refuses anything but an object', () => {
    expect(() => parseConfig('null')).toThrow(/オブジェクト/)
    expect(() => parseConfig('[]')).toThrow(/オブジェクト/)
    expect(() => parseConfig('"x"')).toThrow(/オブジェクト/)
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
    // null は「消す」ではなく、値として利用者のものを使う
    expect(mergeConfig({ a: { b: 1 } }, { a: null })).toEqual({ a: null })
  })

  test('voiceHome and parseConfig are unchanged from 0.2.0', () => {
    expect(voiceHome('D:\\v\\', undefined, undefined)).toBe('D:/v')
    expect(voiceHome(undefined, 'C:\\Users\\u', undefined)).toBe('C:/Users/u/.claude/voice-notify')
    expect(voiceHome(undefined, undefined, '/home/u')).toBe('/home/u/.claude/voice-notify')
    expect(voiceHome(undefined, undefined, undefined)).toBeNull()
    expect(parseConfig('\uFEFF{"speaker":"metan"}')).toEqual({ speaker: 'metan' })
  })
})
