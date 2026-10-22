// The VOICEVOX ENGINE: whether it answers, synthesizing, the cache, and
// finding and starting it (setup).

import type { EngineInterface } from 'claude-code'

import type { Config } from './config'
import { voiceFor } from './decide'
import type { Role } from './decide'
import { moveFile, removeFiles, run } from './io'
import { slashPath } from './os'
import type { Os } from './os'
import type { Ctx } from './runtime'
import { convertReading } from './text'
import {
  audioQueryUrl,
  cachePath,
  cacheToDrop,
  engineCandidates,
  parseVersion,
  startArgv,
  synthArgv,
  synthParams,
  tuneQuery,
  versionUrl,
} from './voicevox'
import type { FoundEngine, SynthParams } from './voicevox'

export type Synth = { path: string; cached: boolean } | { error: string }

// The engine's version, or null when it does not answer.
export async function engineVersion($: EngineInterface, port: number): Promise<string | null> {
  try {
    const r = await $.http.fetch(versionUrl(port))
    return r.ok ? parseVersion(r.text) : null
  } catch {
    return null
  }
}

// Into the cache unless `out` is given; a clip already cached is used as is.
export async function synthesize($: EngineInterface, p: SynthParams, text: string, out?: string): Promise<Synth> {
  const path = out ?? cachePath(p, text)
  if (!out && (await $.fs.exists(path))) return { path, cached: true }
  let query: Record<string, unknown>
  try {
    const r = await $.http.fetch(audioQueryUrl(p, text), { method: 'POST' })
    if (!r.ok) return { error: `audio_query ${r.status}` }
    query = JSON.parse(r.text) as Record<string, unknown>
  } catch (err) {
    return { error: `audio_query: ${String(err)}` }
  }
  // curl does not make the folder (see synthArgv); $.fs.write makes the
  // folders on its way.
  const dir = path.slice(0, path.lastIndexOf('/'))
  if (!(await $.fs.exists(dir))) await $.fs.write(`${dir}/.keep`, '')
  // The clip takes its real name only once whole, so one cut short (a time
  // out, the engine gone) is never found later as a cached clip or a phrase,
  // and another session never plays it half written. Each call writes its own
  // part file, so two making the same clip at once do not share one.
  const part = `${path}.${Math.random().toString(36).slice(2, 10)}.part`
  const r = await run($, synthArgv(p, part), { stdin: JSON.stringify(tuneQuery(query, p)), timeoutMs: 130_000 })
  if (r.exitCode !== 0) {
    await removeFiles($, p.os, [part])
    return { error: `synthesis: curl ${r.exitCode} ${r.stderr.trim()}` }
  }
  const moved = await moveFile($, p.os, part, path)
  if (moved.exitCode !== 0) {
    await removeFiles($, p.os, [part])
    return { error: `synthesis: move ${moved.exitCode} ${moved.stderr.trim()}` }
  }
  return { path, cached: false }
}

export async function synthFor($: EngineInterface, ctx: Ctx, role: Role, text: string): Promise<Synth> {
  return synthesize($, synthParams(ctx.cfg, voiceFor(ctx.cfg, role), ctx.root, ctx.os), convertReading(text, ctx.cfg.speech))
}

export async function pruneCache($: EngineInterface, ctx: Ctx): Promise<void> {
  try {
    await removeFiles($, ctx.os, cacheToDrop(await $.fs.list(`${ctx.root}/cache`), ctx.root, ctx.cfg.cacheMaxFiles))
  } catch {
    // No cache yet.
  }
}

// enginePath, then the usual places, then an engine that only answers
// (Docker, or one started by hand).
export async function findEngine($: EngineInterface, cfg: Config, os: Os): Promise<FoundEngine | null> {
  const running = (await engineVersion($, cfg.enginePort)) !== null
  if (cfg.enginePath) {
    const path = slashPath(cfg.enginePath)
    if (await $.fs.exists(path)) return { path, running }
  }
  const local = await $.env.get('LOCALAPPDATA')
  let winget: string[] = []
  if (os === 'windows' && local) {
    try {
      winget = (await $.fs.list(`${slashPath(local)}/Microsoft/WinGet/Packages`))
        .filter(d => d.kind === 'dir' && d.name.startsWith('HiroshibaKazuyuki.VOICEVOX'))
        .map(d => d.name)
    } catch {
      winget = []
    }
  }
  const env = { LOCALAPPDATA: local, ProgramFiles: await $.env.get('ProgramFiles'), HOME: await $.env.get('HOME') }
  for (const c of engineCandidates(os, env, winget)) if (await $.fs.exists(c)) return { path: c, running }
  return running ? { path: null, running } : null
}

// On Windows start-engine.ps1 waits for the engine and answers by its exit
// code. Elsewhere the engine starts detached and this waits for it to answer.
export async function startEngine($: EngineInterface, cfg: Config, os: Os, exe: string): Promise<boolean> {
  const r = await run($, startArgv(os, $.plugin.root, exe), { timeoutMs: 90_000 })
  if (os === 'windows') return r.exitCode === 0
  // The first start loads the models, which takes some ten seconds.
  for (let i = 0; i < 60; i++) {
    if (await engineVersion($, cfg.enginePort)) return true
    await $.clock.sleep(1000)
  }
  return false
}
