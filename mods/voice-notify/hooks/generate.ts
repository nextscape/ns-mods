// Making the fixed phrases: what is there, what is missing, and making it,
// once per machine at a time.

import type { EngineInterface } from 'claude-code'

import { engineVersion, synthesize } from './engine'
import { context, removeFiles, writeLog } from './io'
import { jobsStamp, phraseBusy, phraseJobs } from './phrases'
import type { PhraseJob, PhraseState } from './phrases'
import type { Ctx, Runtime } from './runtime'
import { convertReading } from './text'
import { synthParams } from './voicevox'

const progressPath = (root: string) => `${root}/state/phrases-progress`
const stampPath = (root: string) => `${root}/state/phrases-stamp`

async function readProgress($: EngineInterface, root: string): Promise<{ done: number; total: number; at: number } | null> {
  const path = progressPath(root)
  try {
    const p = JSON.parse(await $.fs.read(path)) as { done: number; total: number }
    return { done: p.done, total: p.total, at: (await $.fs.stat(path)).mtimeMs }
  } catch {
    return null
  }
}

export async function phraseState($: EngineInterface, ctx: Ctx): Promise<PhraseState> {
  const jobs = phraseJobs(ctx.cfg, ctx.root)
  let missing = 0
  for (const j of jobs) if (!(await $.fs.exists(j.path))) missing++
  const stamp = await $.fs.read(stampPath(ctx.root)).catch(() => '')
  const p = await readProgress($, ctx.root)
  const busy = ctx.rt.generating || phraseBusy(p, await $.clock.now())
  return {
    total: jobs.length,
    missing,
    current: stamp.trim() === jobsStamp(jobs, ctx.cfg),
    busy,
    progress: p && p.done < p.total ? { done: p.done, total: p.total } : null,
  }
}

// What `force` deletes first: every wav under the folders of the voices in
// use, at any depth. Playing picks from all the wav files in a folder, so an
// old NN.wav would keep saying a phrase that is gone: one left after the
// wording shrank, or a whole folder config.json emptied, which no job names.
async function phraseWavs($: EngineInterface, root: string, jobs: readonly PhraseJob[]): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries: Awaited<ReturnType<EngineInterface['fs']['list']>>
    try {
      entries = await $.fs.list(dir)
    } catch {
      // Not made yet.
      return
    }
    for (const f of entries) {
      if (f.kind === 'dir') await walk(`${dir}/${f.name}`)
      else if (f.kind === 'file' && f.name.endsWith('.wav')) out.push(`${dir}/${f.name}`)
    }
  }
  for (const speaker of new Set(jobs.map(j => j.speaker))) await walk(`${root}/phrases/${speaker}`)
  return out
}

// Makes what is missing (all of it with `force`), then records which settings
// they were made with (the stamp).
export async function generatePhrases($: EngineInterface, ctx: Ctx, force: boolean): Promise<void> {
  if (ctx.rt.generating) return
  ctx.rt.generating = true
  try {
    const jobs = phraseJobs(ctx.cfg, ctx.root)
    const stamp = stampPath(ctx.root)
    // Said before anything is deleted or made: until the first phrase is done
    // (seconds, or minutes on a slow engine) another session starting up would
    // find phrases missing and nobody making them, and make them too.
    await $.fs.write(progressPath(ctx.root), JSON.stringify({ done: 0, total: jobs.length }))
    if (force) await removeFiles($, ctx.os, [...(await phraseWavs($, ctx.root, jobs)), stamp])
    // Phrases kept from before are known to match only when the stamp says
    // so (0.2.0's lack the lead silence). Otherwise no stamp is written, and
    // doctor goes on asking for `setup force`.
    const keptCurrent = force || (await $.fs.read(stamp).catch(() => '')).trim() === jobsStamp(jobs, ctx.cfg)
    let made = 0
    let kept = 0
    let failed = 0
    for (const [i, job] of jobs.entries()) {
      if (!force && (await $.fs.exists(job.path))) kept++
      else {
        // phraseJobs names only the voices in use, each one in `speakers`.
        const voice = { name: job.speaker, id: ctx.cfg.speakers[job.speaker]!.id }
        const r = await synthesize($, synthParams(ctx.cfg, voice, ctx.root, ctx.os), convertReading(job.text, ctx.cfg.speech), job.path)
        if ('error' in r) failed++
        else made++
      }
      await $.fs.write(progressPath(ctx.root), JSON.stringify({ done: i + 1, total: jobs.length }))
    }
    if (failed === 0 && (kept === 0 || keptCurrent)) await $.fs.write(stamp, jobsStamp(jobs, ctx.cfg))
    await writeLog($, ctx, failed ? 'WARN' : 'INFO', 'phrases', `生成 ${made} 件 / 既存流用 ${kept} 件 / 失敗 ${failed} 件`)
  } finally {
    ctx.rt.generating = false
  }
}

// From session.start: makes the rest only when some are missing, no other
// session is making them and the engine answers. Phrases that are only out of
// date (the settings changed) are not remade; doctor asks for `setup force`.
export async function resumePhrases($: EngineInterface, rt: Runtime): Promise<void> {
  const ctx = await context($, rt)
  if (!ctx) return
  const st = await phraseState($, ctx)
  if (st.missing === 0 || st.busy) return
  if (!(await engineVersion($, ctx.cfg.enginePort))) return
  await generatePhrases($, ctx, false)
}
