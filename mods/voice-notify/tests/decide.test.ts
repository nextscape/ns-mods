import { describe, expect, test } from 'claude-code/testing'

import type { Config } from '../hooks/config'
import {
  agentReportFallback,
  agentText,
  choosePhrase,
  noticeKind,
  permissionText,
  pickFor,
  planStop,
  planSummary,
  summaryInput,
  voiceFor,
} from '../hooks/decide'
import { CFG } from './world'

const C: Config = {
  ...CFG,
  speech: { ...CFG.speech, interimPrompt: ['途中なので{maxChars}文字で。'], summaryPrompt: ['{maxChars}文字以内で。'] },
}
const DONE = '修正しました。テストも通っています。'
const ASK = 'この方針で進めてよろしいですか。'

describe('decide', () => {
  test('voiceFor: interim uses speakerInterim, falling back to the final speaker', () => {
    expect(voiceFor(C, 'final')).toEqual({ name: 'metan', id: 2 })
    expect(voiceFor(C, 'interim')).toEqual({ name: 'zundamon', id: 3 })
    expect(voiceFor({ ...C, speakerInterim: 'nobody' }, 'interim')).toEqual({ name: 'metan', id: 2 })
    expect(voiceFor({ ...C, speakerInterim: '' }, 'interim')).toEqual({ name: 'metan', id: 2 })
  })

  test('pickFor reads its sentence limits from the config', () => {
    expect(pickFor(C, DONE)).toBe(DONE)
    expect(pickFor({ ...C, speech: { ...C.speech, shortSentenceChars: 3 } }, DONE)).toBe('修正しました。')
  })

  test('planStop: a long turn reads its body after the case phrase', () => {
    expect(planStop({ cfg: C, answer: DONE, durationMs: 60_000, running: 0, engineAlive: true })).toEqual({
      role: 'final', case: 'done', pcase: 'done', brief: false, phrases: ['stop/done', 'stop'], read: true,
    })
  })

  test('planStop: a short turn only plays the brief phrase, keeping ask and trouble apart', () => {
    expect(planStop({ cfg: C, answer: ASK, durationMs: 10_000, running: 0, engineAlive: true })).toEqual({
      role: 'final', case: 'ask', pcase: 'ask', brief: true, phrases: ['stop/brief/ask', 'stop/ask', 'stop'], read: false,
    })
  })

  test('planStop: with subagents still running, done becomes interim in the interim voice', () => {
    expect(planStop({ cfg: C, answer: DONE, durationMs: 60_000, running: 2, engineAlive: true })).toEqual({
      role: 'interim', case: 'done', pcase: 'interim', brief: false, phrases: ['stop/interim', 'stop/done', 'stop'], read: true,
    })
    // ask needs an answer even mid-way, so it stays ask.
    expect(planStop({ cfg: C, answer: ASK, durationMs: 60_000, running: 1, engineAlive: true }).pcase).toBe('ask')
  })

  test('planStop: no readable body or no engine is solo, which never reads', () => {
    expect(planStop({ cfg: C, answer: '', durationMs: 60_000, running: 0, engineAlive: true })).toEqual({
      role: 'final', case: 'solo', pcase: 'solo', brief: false, phrases: ['stop/solo', 'stop'], read: false,
    })
    expect(planStop({ cfg: C, answer: DONE, durationMs: 60_000, running: 0, engineAlive: false }).case).toBe('solo')
    // A solo interim report has no body to follow, so it takes the short interim.
    expect(planStop({ cfg: C, answer: '', durationMs: 60_000, running: 1, engineAlive: true }).phrases).toEqual([
      'stop/brief/interim', 'stop/interim', 'stop/solo', 'stop',
    ])
  })

  test('planSummary: disabled, other events and short answers are skipped; interim is capped', () => {
    const long = 'あ'.repeat(100)
    expect(planSummary({ ...C.speech, summarize: false }, 'stop', 'final', long)).toEqual({ skip: 'disabled' })
    expect(planSummary({ ...C.speech, summarizeEvents: ['stop'] }, 'agentstop', 'interim', long)).toEqual({ skip: 'event' })
    expect(planSummary(C.speech, 'stop', 'final', 'あ'.repeat(79))).toEqual({ skip: 'short' })
    expect(planSummary(C.speech, 'stop', 'final', long)).toEqual({ skip: null, maxChars: 60, system: '60文字以内で。' })
    expect(planSummary(C.speech, 'agentstop', 'interim', 'あ'.repeat(29))).toEqual({ skip: 'short' })
    expect(planSummary(C.speech, 'agentstop', 'interim', 'あ'.repeat(30))).toEqual({
      skip: null, maxChars: 30, system: '30文字以内で。\n途中なので30文字で。',
    })
  })

  test('summaryInput keeps a short answer whole and a long one by its head and tail', () => {
    expect(summaryInput(DONE)).toBe(DONE)
    const long = `頭${'あ'.repeat(5000)}尾`
    const sent = summaryInput(long)
    expect(sent.length).toBeLessThan(4100)
    expect(sent.startsWith('頭')).toBe(true)
    expect(sent.endsWith('尾')).toBe(true)
    expect(sent).toContain('（中略）')
  })

  test('agentText: description and report, without repeating a report that already says done', () => {
    expect(agentText('調査', '原因はパスでした。')).toBe('調査が完了しました。原因はパスでした。')
    expect(agentText('調査', '調査が完了しました。原因はパスでした。')).toBe('調査。調査が完了しました。原因はパスでした。')
    expect(agentText('調査', null)).toBe('調査が完了しました。')
    expect(agentText(null, '原因はパスでした。')).toBe('原因はパスでした。')
    expect(agentText(null, null)).toBeNull()
  })

  test('agentReportFallback: a picked sentence longer than the cap is dropped', () => {
    expect(agentReportFallback('短い報告です。', C.speech)).toBe('短い報告です。')
    // The cap is interimMaxChars + 1 = 31.
    expect(agentReportFallback('あ'.repeat(31), C.speech)).toBe('あ'.repeat(31))
    expect(agentReportFallback('あ'.repeat(32), C.speech)).toBeNull()
    expect(agentReportFallback(null, C.speech)).toBeNull()
    // With the interim cap off, the summary's bounds hold: max(60, 80) + 1.
    const noInterim = { ...C.speech, interimMaxChars: 0 }
    expect(agentReportFallback('あ'.repeat(81), noInterim)).toBe('あ'.repeat(81))
    expect(agentReportFallback('あ'.repeat(82), noInterim)).toBeNull()
  })

  test('permissionText and noticeKind', () => {
    expect(permissionText(C, 'Bash')).toBe('コマンド実行の許可待ちです。')
    expect(permissionText(C, 'mcp__x__y')).toBe('mcp__x__yの許可待ちです。')
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
})
