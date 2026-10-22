import { describe, expect, test } from 'claude-code/testing'

import { appendLog, isErrorLine, logBody, logLine, phraseMemo } from '../hooks/store'

describe('store', () => {
  test('logLine keeps the 0.2.0 format', () => {
    expect(logLine(new Date(2026, 9, 7, 21, 3, 4), 'INFO', 'stop', '発火')).toBe('2026-10-07 21:03:04  INFO stop        発火')
    expect(logLine(new Date(2026, 9, 7, 1, 2, 3), 'ERR', 'agentstop', 'x')).toBe('2026-10-07 01:02:03  ERR  agentstop   x')
  })

  test('a log line is read back without its time stamp, and told an error or not', () => {
    const err = logLine(new Date(2026, 9, 7, 1, 2, 3), 'ERR', 'play', '再生失敗')
    expect(logBody(err)).toBe('ERR  play        再生失敗')
    expect(isErrorLine(err)).toBe(true)
    expect(isErrorLine(logLine(new Date(2026, 9, 7, 1, 2, 3), 'INFO', 'stop', 'ERR  と書いた本文'))).toBe(false)
  })

  test('appendLog adds the lines and trims past 200KB to the last 500 lines', () => {
    expect(appendLog('', ['a', 'b'])).toBe('a\nb\n')
    expect(appendLog('a\n', ['b'])).toBe('a\nb\n')
    const big = appendLog(`${'x'.repeat(500)}\n`.repeat(500), ['c']).trimEnd().split('\n')
    expect(big.length).toBe(500)
    expect(big.at(-1)).toBe('c')
  })

  test('phraseMemo names the last-pick file per phrase folder', () => {
    expect(phraseMemo('C:/vn', 'stop/brief/done')).toBe('C:/vn/state/last_phrase_stop_brief_done')
    expect(phraseMemo('C:/vn', 'stop\\brief\\done')).toBe('C:/vn/state/last_phrase_stop_brief_done')
  })
})
