// The fixed phrases to make, and whether they need making again, as pure
// functions. generate.ts makes them.

import type { Config } from './config'
import { voiceFor } from './decide'
import { hash16 } from './voicevox'

export type PhraseJob = { speaker: string; path: string; text: string }
export type PhraseState = { total: number; missing: number; current: boolean; busy: boolean; progress: { done: number; total: number } | null }

// A progress record newer than this means another session is making them.
const BUSY_MS = 120_000

// A phrase list is an array (<dir>/NN.wav) or an object of subfolders (the
// layout 0.2.0's gen-phrases.ps1 made).
function walk(node: unknown, dir: string, speaker: string, out: PhraseJob[]): void {
  if (Array.isArray(node)) {
    node.forEach((text, i) => out.push({ speaker, path: `${dir}/${String(i + 1).padStart(2, '0')}.wav`, text: String(text) }))
    return
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walk(v, `${dir}/${k}`, speaker, out)
  }
}

export function phraseJobs(cfg: Config, root: string): PhraseJob[] {
  const out: PhraseJob[] = []
  // Only the voices in use (final and interim): `speakers` lays over the
  // shipped ones, so it lists speakers nobody uses too.
  for (const speaker of new Set([voiceFor(cfg, 'final').name, voiceFor(cfg, 'interim').name])) {
    walk(cfg.phrases, `${root}/phrases/${speaker}`, speaker, out)
    // A subagent done with neither a description nor a report. 0.2.0 had the
    // file agent/_default.wav; playing picks from a folder, so it takes the
    // same shape as every other phrase (NN.wav in a folder).
    out.push({ speaker, path: `${root}/phrases/${speaker}/agent/_default/01.wav`, text: `${cfg.subagent.defaultLabel}が完了しました。` })
  }
  return out
}

// Which settings the phrases were made with: a change to the wording, the
// voices, the speed, the readings or the lead silence changes it.
export function jobsStamp(jobs: readonly PhraseJob[], cfg: Config): string {
  const sp = cfg.speech
  const voice = JSON.stringify([
    cfg.speakers, cfg.speedScale, cfg.pitchScale, cfg.intonationScale, cfg.playback.leadSilenceMs,
    sp.readings, sp.lowercaseMinLength, sp.keepUppercase,
  ])
  return hash16(`${voice}\n${jobs.map(j => `${j.path}\t${j.text}`).join('\n')}`)
}

export function phraseBusy(progress: { done: number; total: number; at: number } | null, now: number): boolean {
  return !!progress && progress.done < progress.total && now - progress.at < BUSY_MS
}
