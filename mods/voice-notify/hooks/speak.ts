// Speaking: playing a clip, picking a phrase, staying silent and why, the
// Haiku summary, and the subagent debounce.

import type { EngineInterface } from 'claude-code'

import { choosePhrase, pickFor, planSummary, summaryInput, voiceFor } from './decide'
import type { Role } from './decide'
import { engineVersion, pruneCache, synthFor } from './engine'
import type { Synth } from './engine'
import { context, isMuted, run, writeLog } from './io'
import { MIC_QUERY, micInUseFrom } from './os'
import { LINUX_PLAYERS, playArgv, probeArgv } from './player'
import type { Ctx, Runtime } from './runtime'
import { HINT } from './setup'
import { phraseMemo } from './store'
import { cleanSummary, clearSpeech } from './text'

// Only a player found is remembered (see Runtime.linuxPlayer). Looking again
// costs only where nothing can play anyway.
export async function findLinuxPlayer($: EngineInterface, rt: Runtime): Promise<string | null> {
  if (rt.linuxPlayer) return rt.linuxPlayer
  for (const name of LINUX_PLAYERS) {
    const r = await run($, probeArgv(name))
    if (r.exitCode === 0 && r.stdout.trim()) return (rt.linuxPlayer = name)
  }
  return null
}

const fileName = (p: string) => p.slice(p.replace(/\\/g, '/').lastIndexOf('/') + 1)

export async function play($: EngineInterface, ctx: Ctx, wav: string): Promise<boolean> {
  const argv = playArgv(ctx.os, $.plugin.root, ctx.root, ctx.os === 'linux' ? await findLinuxPlayer($, ctx.rt) : null, wav)
  if (!argv) {
    if (!ctx.rt.warnedNoPlayer) {
      ctx.rt.warnedNoPlayer = true
      await writeLog($, ctx, 'ERR', 'play', `再生コマンドが見つからない（${LINUX_PLAYERS.join(' / ')} のどれかを入れる）`)
    }
    return false
  }
  const release = await ctx.rt.playGate.enter()
  try {
    const r = await run($, argv, { timeoutMs: 120_000 })
    if (r.exitCode === 0) return true
    await writeLog($, ctx, 'ERR', 'play', `再生失敗 ${fileName(wav)}: ${r.stderr.trim() || `exit ${r.exitCode}`}`)
    return false
  } finally {
    release()
  }
}

// `name` is a folder under phrases/<speaker>/ ('stop/brief/done' and so on).
// The pick avoids the one played last.
async function pickPhrase($: EngineInterface, root: string, speaker: string, name: string): Promise<string | null> {
  const dir = `${root}/phrases/${speaker}/${name}`
  let files: string[]
  try {
    files = (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.wav')).map(f => f.name)
  } catch {
    return null
  }
  const memo = phraseMemo(root, name)
  const prev = await $.fs.read(memo).then(t => t.replace(/^﻿/, '').trim(), () => null)
  const pick = choosePhrase(files, prev, Math.random())
  if (!pick) return null
  // Played even when the pick cannot be remembered.
  await $.fs.write(memo, pick).catch(() => undefined)
  return `${dir}/${pick}`
}

// Why to stay silent, or null to speak.
async function silence($: EngineInterface, ctx: Ctx): Promise<string | null> {
  if ((await $.env.get('VOICE_NOTIFY_SUPPRESS')) === '1') return 'VOICE_NOTIFY_SUPPRESS'
  if (await isMuted($, ctx.root)) return '手動ミュート'
  if (ctx.os === 'windows' && ctx.cfg.mute.whenMicInUse) {
    const r = await run($, [...MIC_QUERY])
    const app = r.exitCode === 0 ? micInUseFrom(r.stdout) : null
    if (app) return `マイク使用中 (${app})`
  }
  return null
}

// Whether to speak at all: null (with the reason logged) to stay silent.
export async function begin($: EngineInterface, rt: Runtime, event: string): Promise<Ctx | null> {
  const ctx = await context($, rt)
  if (!ctx) return null
  await writeLog($, ctx, 'INFO', event, '発火')
  return (await quiet($, ctx, event)) ? null : ctx
}

// Logs the reason and answers true when the event stays silent.
export async function quiet($: EngineInterface, ctx: Ctx, event: string): Promise<boolean> {
  const why = await silence($, ctx)
  if (why) await writeLog($, ctx, 'INFO', event, `無音化: ${why}`)
  return why !== null
}

// A fixed phrase: the first of `names` with a phrase in its folder.
export async function speakPhrase($: EngineInterface, ctx: Ctx, role: Role, names: readonly string[], event: string): Promise<boolean> {
  const voice = voiceFor(ctx.cfg, role)
  for (const name of names) {
    const wav = await pickPhrase($, ctx.root, voice.name, name)
    if (wav) return play($, ctx, wav)
  }
  await writeLog($, ctx, 'WARN', event, `定型フレーズが無い (${names.join(' / ')})。${HINT.setup} を実行のこと`)
  return false
}

// Plays a synthesized clip; a failed synthesis is logged as the engine not
// answering or as anything else.
export async function playSynth($: EngineInterface, ctx: Ctx, event: string, r: Synth): Promise<void> {
  if ('error' in r) {
    const port = ctx.cfg.enginePort
    const alive = await engineVersion($, port)
    await writeLog($, ctx, 'ERR', event, alive ? `合成失敗: ${r.error}` : `VOICEVOX ENGINE に接続できない (port ${port})。定型フレーズのみ再生: ${r.error}`)
    return
  }
  await play($, ctx, r.path)
  // Only a new clip adds to the cache.
  if (!r.cached) await pruneCache($, ctx)
}

// The Haiku summary, or null when there is none (off, too short, failed, or
// past summaryTimeoutSec); the caller then reads a sentence of the answer.
export async function summarize($: EngineInterface, ctx: Ctx, event: 'stop' | 'agentstop', role: Role, answer: string): Promise<string | null> {
  const sp = ctx.cfg.speech
  const plan = planSummary(sp, event, role, answer)
  if (plan.skip !== null) return null
  const started = await $.clock.now()
  const limit = sp.summaryTimeoutSec * 1000
  let r: Awaited<ReturnType<EngineInterface['model']['complete']>>
  try {
    r = await $.model.complete({
      model: sp.summaryModel || 'haiku',
      system: plan.system,
      prompt: summaryInput(answer),
      effort: 'low',
      maxTokens: 300,
      timeoutMs: limit,
    })
  } catch (err) {
    // A request the engine will not send (a misspelt summaryModel, say).
    await writeLog($, ctx, 'WARN', event, `要約失敗、1文目を読む: ${String(err)}`)
    return null
  }
  const ms = (await $.clock.now()) - started
  if (!r.isAnswered) {
    const why = r.reason === 'aborted' ? `${limit / 1000}秒でタイムアウト` : r.reason
    await writeLog($, ctx, 'WARN', event, `要約失敗、1文目を読む: ${why}`)
    return null
  }
  const c = cleanSummary(r.text, plan.maxChars)
  if ('error' in c) {
    await writeLog($, ctx, 'WARN', event, `要約失敗、1文目を読む: ${c.error}`)
    return null
  }
  const text = clearSpeech(c.text)
  await writeLog($, ctx, 'INFO', event, `要約 ${(ms / 1000).toFixed(1)}秒: ${text}`)
  return text
}

// The summary (else a sentence of the answer), synthesized: run while the
// leading phrase plays.
export async function prepareBody($: EngineInterface, ctx: Ctx, role: Role, answer: string): Promise<{ text: string; r: Synth } | null> {
  const text = (await summarize($, ctx, 'stop', role, answer)) ?? pickFor(ctx.cfg, answer)
  if (!text) return null
  return { text, r: await synthFor($, ctx, role, text) }
}

export async function runningAgents($: EngineInterface): Promise<number> {
  try {
    return (await $.agent.list()).filter(a => a.status === 'running' || a.status === 'pending').length
  } catch {
    return 0
  }
}

// The subagent debounce: null (and now recorded) when `deb` ms have passed
// since the last report was read, else the ms that have. state/last_spoken is
// shared across sessions, so reports of other sessions do not pile up either.
export async function claimSpeech($: EngineInterface, ctx: Ctx, deb: number): Promise<number | null> {
  const path = `${ctx.root}/state/last_spoken`
  const release = await ctx.rt.debounceGate.enter()
  try {
    const now = await $.clock.now()
    const since = await $.fs.stat(path).then(s => Math.max(0, now - s.mtimeMs), () => null)
    if (since !== null && since < deb) return since
    await $.fs.write(path, new Date(now).toISOString())
    return null
  } finally {
    release()
  }
}
