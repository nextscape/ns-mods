import { describe, expect, test } from 'claude-code/testing'

import { jobsStamp, phraseBusy, phraseJobs } from '../hooks/phrases'
import { PHRASE_CFG, ROOT } from './world'

describe('phrases', () => {
  test('phraseJobs walks the phrase tree per speaker, numbering two digits, plus the agent fallback', () => {
    const jobs = phraseJobs(PHRASE_CFG, ROOT).filter(j => j.speaker === 'metan')
    expect(jobs.map(j => [j.path.replace(`${ROOT}/phrases/metan/`, ''), j.text])).toEqual([
      ['idle/01.wav', '入力をお待ちしています。'],
      ['stop/done/01.wav', '完了しました。'],
      ['stop/done/02.wav', 'できました。'],
      ['stop/brief/done/01.wav', '終わりました。'],
      ['mute/01.wav', '停止します。'],
      ['unmute/01.wav', '再開します。'],
      ['agent/_default.wav', 'エージェントが完了しました。'],
    ])
    expect(phraseJobs(PHRASE_CFG, ROOT).filter(j => j.speaker === 'zundamon')).toHaveLength(7)
  })

  test('jobsStamp changes with the text, the voice, the readings and the lead silence', () => {
    const jobs = phraseJobs(PHRASE_CFG, ROOT)
    const a = jobsStamp(jobs, PHRASE_CFG)
    expect(jobsStamp(jobs, PHRASE_CFG)).toBe(a)
    expect(jobsStamp(jobs, { ...PHRASE_CFG, speedScale: 1.1 })).not.toBe(a)
    expect(jobsStamp(jobs, { ...PHRASE_CFG, playback: { leadSilenceMs: 300 } })).not.toBe(a)
    expect(jobsStamp(jobs, { ...PHRASE_CFG, speech: { ...PHRASE_CFG.speech, readings: { FIX: 'フィクス' } } })).not.toBe(a)
    expect(jobsStamp(jobs.slice(1), PHRASE_CFG)).not.toBe(a)
  })

  test('phraseBusy: an unfinished progress written within two minutes means another session is generating', () => {
    expect(phraseBusy({ done: 3, total: 14, at: 1_000 }, 1_000 + 119_000)).toBe(true)
    expect(phraseBusy({ done: 3, total: 14, at: 1_000 }, 1_000 + 121_000)).toBe(false)
    expect(phraseBusy({ done: 14, total: 14, at: 1_000 }, 1_000)).toBe(false)
    expect(phraseBusy(null, 1_000)).toBe(false)
  })
})
