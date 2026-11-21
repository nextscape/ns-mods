import { describe, expect, test } from 'claude-code/testing'

import type { Config } from '../hooks/config'
import {
  NO_FLIGHT,
  agentReportFallback,
  agentText,
  choosePhrase,
  noticeKind,
  permissionText,
  pickFor,
  inFlight,
  isOwnTurn,
  originOf,
  planStop,
  planSummary,
  summaryInput,
  trackFlight,
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
    expect(planStop({ cfg: C, answer: DONE, durationMs: 60_000, running: 0, pending: 0, ended: 0, tools: 3, engineAlive: true })).toEqual({
      role: 'final', case: 'done', pcase: 'done', brief: false, phrases: ['stop/done', 'stop'], read: true, silent: false,
    })
  })

  test('planStop: a short turn only plays the brief phrase, keeping ask and trouble apart', () => {
    expect(planStop({ cfg: C, answer: ASK, durationMs: 10_000, running: 0, pending: 0, ended: 0, tools: 3, engineAlive: true })).toEqual({
      role: 'final', case: 'ask', pcase: 'ask', brief: true, phrases: ['stop/brief/ask', 'stop/ask', 'stop'], read: false, silent: false,
    })
  })

  test('planStop: with subagents still running, done becomes interim in the interim voice', () => {
    expect(planStop({ cfg: C, answer: DONE, durationMs: 60_000, running: 2, pending: 0, ended: 0, tools: 3, engineAlive: true })).toEqual({
      role: 'interim', case: 'done', pcase: 'interim', brief: false, phrases: ['stop/interim', 'stop/done', 'stop'], read: true, silent: false,
    })
    // ask needs an answer even mid-way, so it stays ask.
    expect(planStop({ cfg: C, answer: ASK, durationMs: 60_000, running: 1, pending: 0, ended: 0, tools: 3, engineAlive: true }).pcase).toBe('ask')
  })

  test('planStop: no readable body or no engine is solo, which never reads', () => {
    expect(planStop({ cfg: C, answer: '', durationMs: 60_000, running: 0, pending: 0, ended: 0, tools: 3, engineAlive: true })).toEqual({
      role: 'final', case: 'solo', pcase: 'solo', brief: false, phrases: ['stop/solo', 'stop'], read: false, silent: false,
    })
    expect(planStop({ cfg: C, answer: DONE, durationMs: 60_000, running: 0, pending: 0, ended: 0, tools: 3, engineAlive: false }).case).toBe('solo')
    // A solo interim report has no body to follow, so it takes the short interim.
    expect(planStop({ cfg: C, answer: '', durationMs: 60_000, running: 1, pending: 0, ended: 0, tools: 3, engineAlive: true }).phrases).toEqual([
      'stop/brief/interim', 'stop/interim', 'stop/solo', 'stop',
    ])
  })

  test('planStop: background work or a one-shot wakeup still in flight makes the turn interim', () => {
    expect(planStop({ cfg: C, answer: DONE, durationMs: 60_000, running: 0, pending: 1, ended: 0, tools: 3, engineAlive: true })).toMatchObject({
      role: 'interim', pcase: 'interim', read: true,
    })
  })

  test('inFlight lists what a Stop says is in flight by id, without recurring wakeups', () => {
    expect(inFlight([], [])).toEqual([])
    expect(inFlight(undefined, undefined)).toEqual([])
    expect(inFlight([{ id: 'b1' }, { id: 'b2' }], [{ id: 'c1', recurring: false }])).toEqual(['b1', 'b2', 'cron:c1'])
    // A recurring wakeup (/loop) does not keep every turn interim.
    expect(inFlight([], [{ id: 'c2', recurring: true }])).toEqual([])
  })

  test('trackFlight: work a turn starts is waited on; what the person moved on from is not', () => {
    // A build started in this turn.
    expect(trackFlight(NO_FLIGHT, ['b1'], true)).toEqual({ flight: { ids: ['b1'], settled: [] }, pending: 1, ended: 0 })
    // A dev server from before the person's next request, and a build started in it.
    expect(trackFlight({ ids: ['d1'], settled: [] }, ['d1', 'b1'], true)).toEqual({
      flight: { ids: ['d1', 'b1'], settled: ['d1'] }, pending: 1, ended: 0,
    })
    // Settled work stays settled when a notice starts the turn; the build that ended is counted.
    expect(trackFlight({ ids: ['d1', 'b1'], settled: ['d1'] }, ['d1'], false)).toEqual({
      flight: { ids: ['d1'], settled: ['d1'] }, pending: 0, ended: 1,
    })
  })

  test('trackFlight: a turn a notice started still waits on the rest', () => {
    // One of two builds ended and woke the session.
    expect(trackFlight({ ids: ['b1', 'b2'], settled: [] }, ['b2'], false)).toMatchObject({ pending: 1, ended: 1 })
    // Read twice in one turn (a Stop hook sent it on), it reads the same.
    const before = { ids: ['b1'], settled: [] }
    expect(trackFlight(before, ['b1', 'b2'], true)).toEqual(trackFlight(before, ['b1', 'b2'], true))
    expect(trackFlight(before, ['b1', 'b2'], true).pending).toBe(1)
  })

  test('isOwnTurn: the engine names who started the turn; with no origin, the frame tells', () => {
    expect(isOwnTurn('お願いします', { kind: 'composer' })).toBe(true)
    expect(isOwnTurn('お願いします', { kind: 'bridge' })).toBe(true)
    expect(isOwnTurn('<task-notification>x</task-notification>', { kind: 'task-notification' })).toBe(false)
    // A wakeup comes back to work that is waited on: it settles nothing.
    expect(isOwnTurn('ビルドを確認する', { kind: 'scheduled-trigger' })).toBe(false)
    expect(isOwnTurn('続きです', { kind: 'peer' })).toBe(false)
    expect(isOwnTurn('x', { kind: 'plugin' })).toBe(false)
    expect(isOwnTurn('x', { kind: 'plugin', asUser: true })).toBe(true)
    expect(isOwnTurn('お願いします', undefined)).toBe(true)
    expect(isOwnTurn('お願いします', { kind: 'unclassified' })).toBe(true)
    expect(isOwnTurn('<task-notification>x</task-notification>', undefined)).toBe(false)
    expect(isOwnTurn('Another Claude session sent a message:\n<agent-message from="a">x</agent-message>', undefined)).toBe(false)
    expect(isOwnTurn('The lab plugin sent a message:\nx', { kind: 'unclassified' })).toBe(false)
    // A continuation has no prompt.
    expect(isOwnTurn('', undefined)).toBe(false)
  })

  test('originOf finds the turn’s prompt among those submitted, the latest first', () => {
    const submitted = [
      { text: '先の依頼', origin: 'a' },
      { text: 'お願いします', origin: 'b' },
      { text: 'お願いします', origin: 'c' },
    ]
    expect(originOf('お願いします', submitted)).toBe('c')
    expect(originOf('The lab plugin sent a message:\n先の依頼', submitted)).toBe('a')
    expect(originOf('知らない文', submitted)).toBeUndefined()
    expect(originOf('', [{ text: '', origin: 'a' }])).toBeUndefined()
  })

  test('planStop: a short reply that called no tool is silent; ask and trouble still speak', () => {
    const quick = { cfg: C, durationMs: 10_000, running: 0, pending: 0, ended: 0, engineAlive: true }
    expect(planStop({ ...quick, answer: DONE, tools: 0 }).silent).toBe(true)
    expect(planStop({ ...quick, answer: DONE, tools: 0, pending: 1 }).silent).toBe(true)
    expect(planStop({ ...quick, answer: ASK, tools: 0 }).silent).toBe(false)
    expect(planStop({ ...quick, answer: DONE, tools: 1 }).silent).toBe(false)
    // A turn whose start was not seen keeps the brief phrase.
    expect(planStop({ ...quick, answer: DONE, tools: null }).silent).toBe(false)
    expect(planStop({ ...quick, answer: DONE, tools: 0, durationMs: 60_000 }).silent).toBe(false)
  })

  test('planStop: the turn that reports background work has ended speaks, tool or no tool', () => {
    // The person heard "still working" when that work began: its end is news.
    const quick = { cfg: C, answer: 'ビルドが完了しました。', durationMs: 5_000, running: 0, pending: 0, tools: 0, engineAlive: true }
    expect(planStop({ ...quick, ended: 1 })).toMatchObject({ role: 'final', silent: false, phrases: ['stop/brief/done', 'stop/done', 'stop'] })
    expect(planStop({ ...quick, ended: 0 }).silent).toBe(true)
  })

  test('planStop: a short reply that called no tool is silent with no readable body or no engine too', () => {
    const quick = { cfg: C, durationMs: 10_000, running: 0, pending: 0, ended: 0, tools: 0 }
    // Under 4 characters there is no sentence to read: solo.
    expect(planStop({ ...quick, answer: 'はい', engineAlive: true })).toMatchObject({ case: 'solo', silent: true })
    expect(planStop({ ...quick, answer: DONE, engineAlive: false })).toMatchObject({ case: 'solo', silent: true })
    // A question still speaks with the engine down.
    expect(planStop({ ...quick, answer: ASK, engineAlive: false }).silent).toBe(false)
    expect(planStop({ ...quick, answer: DONE, engineAlive: false, tools: 2 }).silent).toBe(false)
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
