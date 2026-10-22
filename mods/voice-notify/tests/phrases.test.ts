import { describe, expect, test } from 'claude-code/testing'

import { jobsStamp, phraseBusy, phraseJobs } from '../hooks/phrases'
import { PHRASE_CFG, ROOT } from './world'

describe('phrases', () => {
  test('phraseJobs walks the phrase tree per voice, numbering two digits, plus the agent fallback', () => {
    const jobs = phraseJobs(PHRASE_CFG, ROOT).filter(j => j.speaker === 'metan')
    expect(jobs.map(j => [j.path.replace(`${ROOT}/phrases/metan/`, ''), j.text])).toEqual([
      ['stop/done/01.wav', '完了しました。'],
      ['stop/done/02.wav', 'できました。'],
      ['stop/brief/done/01.wav', '終わりました。'],
      ['idle/01.wav', '入力をお待ちしています。'],
      ['mute/01.wav', '停止します。'],
      ['unmute/01.wav', '再開します。'],
      ['agent/_default/01.wav', 'エージェントが完了しました。'],
    ])
    expect(phraseJobs(PHRASE_CFG, ROOT).filter(j => j.speaker === 'zundamon')).toHaveLength(7)
  })

  test('phrases are made only for the voices in use', () => {
    const cfg = { ...PHRASE_CFG, speakers: { ...PHRASE_CFG.speakers, tsumugi: { id: 8 } } }
    expect([...new Set(phraseJobs(cfg, ROOT).map(j => j.speaker))]).toEqual(['metan', 'zundamon'])
    const solo = { ...cfg, speakerInterim: '' }
    expect([...new Set(phraseJobs(solo, ROOT).map(j => j.speaker))]).toEqual(['metan'])
  })

  test('every phrase is a NN.wav inside the folder the player looks in', () => {
    // Playing picks from phrases/<speaker>/<name>/ (speak.ts's pickPhrase).
    for (const j of phraseJobs(PHRASE_CFG, ROOT)) expect(j.path).toMatch(/\/phrases\/[^/]+\/.+\/\d{2}\.wav$/)
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
