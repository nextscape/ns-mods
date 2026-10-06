import { describe, expect, test } from 'claude-code/testing'

import {
  AGENT_STALE_MS,
  DEFAULT_PROMPT,
  buildPrompt,
  cleanSummary,
  decide,
  isRunningAgent,
  parseConfig,
  summaryFileName,
  voiceHome,
} from '../hooks/decide'
import type { DecideInput, SpeechConfig } from '../hooks/decide'

const SPEECH: SpeechConfig = {
  summarize: true,
  summarizeEvents: ['stop', 'agentstop'],
  summaryMinChars: 80,
  summaryMaxChars: 60,
  interimMaxChars: 30,
  interimPrompt: ['途中経過なので{maxChars}文字以内の1文で。'],
  summaryPrompt: ['報告を{maxChars}文字以内で。'],
  briefMaxSeconds: 30,
}
const LONG = 'あ'.repeat(80)
const input = (over: Partial<DecideInput> = {}): DecideInput => ({
  speech: SPEECH,
  muted: false,
  agentId: undefined,
  answer: LONG,
  durationMs: 60_000,
  isAborted: false,
  reason: 'answer',
  runningAgents: 0,
  ...over,
})

describe('decide', () => {
  test('a long main turn is summarized as final', () => {
    expect(decide(input())).toEqual({ skip: null, kind: 'final', maxChars: 60, system: '報告を60文字以内で。' })
  })
  test('summarize false or missing disables it', () => {
    expect(decide(input({ speech: { ...SPEECH, summarize: false } }))).toEqual({ skip: 'disabled' })
    expect(decide(input({ speech: { ...SPEECH, summarize: undefined } }))).toEqual({ skip: 'disabled' })
  })
  test('an event outside summarizeEvents is skipped', () => {
    expect(decide(input({ agentId: 'a1', speech: { ...SPEECH, summarizeEvents: ['stop'] } }))).toEqual({ skip: 'event' })
  })
  test('muted is skipped', () => {
    expect(decide(input({ muted: true }))).toEqual({ skip: 'muted' })
  })
  test('an aborted or non-answer turn is skipped', () => {
    expect(decide(input({ isAborted: true, reason: 'aborted' }))).toEqual({ skip: 'aborted' })
    expect(decide(input({ reason: 'error' }))).toEqual({ skip: 'aborted' })
  })
  test('a main turn up to briefMaxSeconds is brief; a subagent never is', () => {
    expect(decide(input({ durationMs: 30_000 }))).toEqual({ skip: 'brief' })
    expect(decide(input({ durationMs: 30_001 })).skip).toBe(null)
    expect(decide(input({ agentId: 'a1', durationMs: 1_000 })).skip).toBe(null)
  })
  test('a subagent is interim with the interim limit as both cap and floor', () => {
    const d = decide(input({ agentId: 'a1', answer: 'い'.repeat(30) }))
    expect(d).toEqual({ skip: null, kind: 'interim', maxChars: 30, system: '報告を30文字以内で。\n途中経過なので30文字以内の1文で。' })
    expect(decide(input({ agentId: 'a1', answer: 'い'.repeat(29) }))).toEqual({ skip: 'short' })
  })
  test('a main turn with running subagents is interim', () => {
    const d = decide(input({ runningAgents: 1 }))
    expect(d.skip === null && d.kind).toBe('interim')
  })
  test('a final answer shorter than summaryMinChars is skipped', () => {
    expect(decide(input({ answer: 'あ'.repeat(79) }))).toEqual({ skip: 'short' })
  })
})

describe('buildPrompt', () => {
  test('falls back to the default prompt and replaces every {maxChars}', () => {
    expect(buildPrompt({}, 'final', 60)).toBe(DEFAULT_PROMPT)
    expect(buildPrompt({ summaryPrompt: ['{maxChars}と{maxChars}'] }, 'final', 5)).toBe('5と5')
  })
  test('adds interimPrompt only for interim', () => {
    expect(buildPrompt(SPEECH, 'final', 60)).toBe('報告を60文字以内で。')
  })
})

describe('cleanSummary', () => {
  test('keeps the first non-empty line and drops a label prefix', () => {
    expect(cleanSummary('\n要約： 切り替えが完了しました。\n要約文：別の行', 60)).toEqual({ text: '切り替えが完了しました。' })
  })
  test('drops a label that sits on its own line', () => {
    expect(cleanSummary('要約：\n本文です。', 60)).toEqual({ text: '本文です。' })
  })
  test('collapses whitespace', () => {
    expect(cleanSummary('  A   B  ', 60)).toEqual({ text: 'A B' })
  })
  test('empty is an error', () => {
    expect(cleanSummary(' \n ', 60)).toEqual({ error: 'empty-reply' })
  })
  test('longer than three times the cap is an error', () => {
    expect(cleanSummary('あ'.repeat(31), 10)).toEqual({ error: 'too-long (31)' })
    expect(cleanSummary('あ'.repeat(30), 10)).toEqual({ text: 'あ'.repeat(30) })
  })
})

describe('summaryFileName', () => {
  test('main and subagent files are distinct and path-safe', () => {
    expect(summaryFileName('s-1')).toBe('s-1.json')
    expect(summaryFileName('s-1', 'a1')).toBe('s-1__a1.json')
    expect(summaryFileName('s/1:x', 'a.b')).toBe('s_1_x__a_b.json')
  })
})

describe('voiceHome', () => {
  test('VOICE_NOTIFY_HOME wins and is normalized', () => {
    expect(voiceHome('C:\\vn\\ ', 'C:\\Users\\u', undefined)).toBe('C:/vn')
  })
  test('otherwise ~/.claude/voice-notify from USERPROFILE, then HOME', () => {
    expect(voiceHome(undefined, 'C:\\Users\\u', '/h')).toBe('C:/Users/u/.claude/voice-notify')
    expect(voiceHome('  ', undefined, '/h/')).toBe('/h/.claude/voice-notify')
  })
  test('no home at all is null', () => {
    expect(voiceHome(undefined, undefined, undefined)).toBe(null)
  })
})

describe('parseConfig', () => {
  test('accepts a BOM and rejects broken JSON', () => {
    expect(parseConfig('\uFEFF{"speech":{"summarize":true}}')).toEqual({ speech: { summarize: true } })
    expect(() => parseConfig('{')).toThrow()
  })
})

describe('isRunningAgent', () => {
  const now = 10 * AGENT_STALE_MS
  test('matches the session id ignoring BOM and CRLF', () => {
    expect(isRunningAgent('\uFEFFsess-1\r\n', now, now, 'sess-1')).toBe(true)
    expect(isRunningAgent('sess-2\r\n', now, now, 'sess-1')).toBe(false)
  })
  test('ignores a record older than an hour', () => {
    expect(isRunningAgent('sess-1', now - AGENT_STALE_MS - 1, now, 'sess-1')).toBe(false)
  })
})
