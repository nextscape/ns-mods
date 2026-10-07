import type { EngineInterface, Register, TurnCompleteInput } from 'claude-code'

import {
  agentReportFallback,
  agentText,
  choosePhrase,
  enginePort,
  noticeKind,
  parseConfig,
  permissionText,
  pickFor,
  planStop,
  planSummary,
  voiceFor,
  voiceHome,
} from './decide'
import type { Role, VoiceConfig } from './decide'
import { Gate } from './gate'
import { MIC_QUERY, micInUseFrom, osFrom, removeArgv } from './os'
import type { Os } from './os'
import { LINUX_PLAYERS, playArgv, probeArgv } from './player'
import { appendLog, logLine, phraseMemo } from './store'
import type { Level } from './store'
import { cleanSummary, clearSpeech, convertReading } from './text'
import { audioQueryUrl, cachePath, cacheToDrop, parseVersion, synthArgv, synthParams, tuneQuery, versionUrl } from './voicevox'
import type { SynthParams } from './voicevox'

// voice-notify の hooks モジュール。Claude Code の出来事を VOICEVOX の声で知らせる。
//
// - $ を使う処理（ファイル・プロセス・HTTP・モデル）はすべてこのファイルに置く。mod のロード時検査は、
//   $ を import した先の関数に渡すことを許さない。判定と形の組み立ては純粋関数のファイル（decide / text / os / player / store / voicevox）
// - 読み上げは待たずに裏で流し、どの hook も next(e) をすぐ返す（ターンを遅らせない）
// - 何が起きたかは <ホーム>/notify.log に理由付きで残す（0.2.0 と同じ書式）

type Ctx = { root: string; cfg: VoiceConfig; os: Os }
type Synth = { path: string; cached: boolean } | { error: string }

// 作業中のターン（idle の抑止に使う）と、本体の会話の /compact の最中かどうか
const working = new Set<string>()
let compacting = 0

let knownOs: Os | null = null
let linuxPlayer: string | null | undefined
let warnedConfig = false
let warnedNoPlayer = false

// notify.log は読んで書き直すしかない（$.fs に追記が無い）。同時に来た行はまとめて1回で書く
const pendingLog: Array<{ root: string; line: string }> = []
const logGate = new Gate()
// 同じセッションの再生は1つずつ（セッションをまたぐ排他は再生スクリプトの中で取る）
const playGate = new Gate()
// サブエージェントの報告が同時に来たとき、連発抑制の「見て、記録する」をすり抜けないよう1つずつ通す
const debounceGate = new Gate()

// 出来事を止めうる hook（gating）は、例外を出しても出来事をそのまま通す（.catch）
export const register: Register = on => {
  on('session.compact', async ($, e, next) => {
    // 先読み（precompute）は会話を変えないので数えない。サブエージェントの圧縮も本体のターンとは別
    const counts = e.trigger !== 'precompute' && e.agentId === undefined
    if (counts) compacting++
    try {
      return await next(e)
    } finally {
      if (counts) compacting--
    }
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    working.add(e.turnId)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    working.delete(e.turnId)
    if (compacting === 0 && !e.isAborted) {
      if (e.agentId) void onAgentTurn($, e)
      else void onMainTurn($, e)
    }
    return next(e)
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    void onPermission($, e.tool_name)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    void onNotice($, e.notification_type, working.size > 0)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.TaskCompleted', async ($, e, next) => {
    void onTask($)
    return next(e)
  }).catch(($, e, next) => next(e))
}

// ================================================================ 前提（ホーム・設定・OS）

async function detectOs($: EngineInterface): Promise<Os> {
  if (knownOs) return knownOs
  const env = await $.env.get('OS')
  let uname = ''
  if (env !== 'Windows_NT') {
    try {
      uname = (await $.process.run(['uname', '-s'])).stdout
    } catch {
      uname = '' // uname が無い環境は Linux とみなす
    }
  }
  knownOs = osFrom(env, uname)
  return knownOs
}

async function homeRoot($: EngineInterface): Promise<string | null> {
  return voiceHome(await $.env.get('VOICE_NOTIFY_HOME'), await $.env.get('USERPROFILE'), await $.env.get('HOME'))
}

// まず読む。無いときだけ同梱の既定をコピーする（あるのに読めないときは上書きしない）
async function loadConfig($: EngineInterface, root: string): Promise<{ cfg: VoiceConfig } | { error: string }> {
  const path = `${root}/config.json`
  let text: string
  try {
    text = await $.fs.read(path)
  } catch (err) {
    if (await $.fs.exists(path)) return { error: String(err) }
    try {
      text = await $.fs.read(`${$.plugin.root}/config.default.json`)
      await $.fs.write(path, text)
    } catch (copyErr) {
      return { error: String(copyErr) }
    }
  }
  try {
    return { cfg: parseConfig(text) }
  } catch (err) {
    return { error: String(err) }
  }
}

// イベントごとの前提。設定が壊れていれば、一度だけログに残して null
async function context($: EngineInterface): Promise<Ctx | null> {
  const root = await homeRoot($)
  if (!root) return null
  const loaded = await loadConfig($, root)
  if ('error' in loaded) {
    if (!warnedConfig) {
      warnedConfig = true
      await writeLog($, root, 'ERR', 'config', `config.json を読めないので鳴らさない: ${loaded.error}`)
    }
    return null
  }
  warnedConfig = false
  return { root, cfg: loaded.cfg, os: await detectOs($) }
}

// ================================================================ ホームのファイル

async function removeFiles($: EngineInterface, os: Os, paths: readonly string[]): Promise<void> {
  const argv = removeArgv(os, paths)
  if (argv) await $.process.run(argv)
}

async function writeLog($: EngineInterface, root: string, level: Level, event: string, msg: string): Promise<void> {
  pendingLog.push({ root, line: logLine(new Date(await $.clock.now()), level, event, msg) })
  const release = await logGate.enter()
  try {
    // 先に通った呼び出しが、この行もまとめて書いていれば何もしない
    const batch = pendingLog.splice(0)
    for (const r of new Set(batch.map(b => b.root))) {
      const path = `${r}/notify.log`
      let old = ''
      try {
        old = await $.fs.read(path)
      } catch {
        old = ''
      }
      await $.fs.write(path, appendLog(old, batch.filter(b => b.root === r).map(b => b.line)))
    }
  } catch (err) {
    $.ui.log(`voice-notify: notify.log に書けない (${String(err)})`, { to: 'debug' })
  } finally {
    release()
  }
}

async function isMuted($: EngineInterface, root: string): Promise<boolean> {
  return $.fs.exists(`${root}/state/mute`)
}

// name は phrases/<speaker>/ の下のフォルダ（'stop/brief/done' など）。直前と同じものは避ける
async function pickPhrase($: EngineInterface, root: string, speaker: string, name: string): Promise<string | null> {
  const dir = `${root}/phrases/${speaker}/${name}`
  let files: string[]
  try {
    files = (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.wav')).map(f => f.name)
  } catch {
    return null
  }
  const memo = phraseMemo(root, name)
  let prev: string | null = null
  try {
    prev = (await $.fs.read(memo)).replace(/^﻿/, '').trim()
  } catch {
    prev = null
  }
  const pick = choosePhrase(files, prev, Math.random())
  if (!pick) return null
  try {
    await $.fs.write(memo, pick)
  } catch {
    // 覚えられなくても鳴らす
  }
  return `${dir}/${pick}`
}

// ================================================================ ENGINE

async function engineVersion($: EngineInterface, port: number): Promise<string | null> {
  try {
    const r = await $.http.fetch(versionUrl(port))
    return r.ok ? parseVersion(r.text) : null
  } catch {
    return null
  }
}

// out を渡さなければキャッシュ。あればそれを返す
async function synthesize($: EngineInterface, p: SynthParams, text: string, out?: string): Promise<Synth> {
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
  const r = await $.process.run(synthArgv(p, path), { stdin: JSON.stringify(tuneQuery(query, p)), timeoutMs: 130_000 })
  if (r.exitCode !== 0) return { error: `synthesis: curl ${r.exitCode} ${r.stderr.trim()}` }
  return { path, cached: false }
}

async function pruneCache($: EngineInterface, ctx: Ctx): Promise<void> {
  try {
    await removeFiles($, ctx.os, cacheToDrop(await $.fs.list(`${ctx.root}/cache`), ctx.root, ctx.cfg.cacheMaxFiles ?? 200))
  } catch {
    // キャッシュがまだ無い
  }
}

// ================================================================ 再生

async function findLinuxPlayer($: EngineInterface): Promise<string | null> {
  if (linuxPlayer !== undefined) return linuxPlayer
  for (const name of LINUX_PLAYERS) {
    const r = await $.process.run(probeArgv(name))
    if (r.exitCode === 0 && r.stdout.trim()) return (linuxPlayer = name)
  }
  return (linuxPlayer = null)
}

const fileName = (p: string) => p.slice(p.replace(/\\/g, '/').lastIndexOf('/') + 1)

async function play($: EngineInterface, ctx: Ctx, wav: string): Promise<boolean> {
  const argv = playArgv(ctx.os, $.plugin.root, ctx.root, ctx.os === 'linux' ? await findLinuxPlayer($) : null, wav)
  if (!argv) {
    if (!warnedNoPlayer) {
      warnedNoPlayer = true
      await writeLog($, ctx.root, 'ERR', 'play', `再生コマンドが見つからない（${LINUX_PLAYERS.join(' / ')} のどれかを入れる）`)
    }
    return false
  }
  const release = await playGate.enter()
  try {
    const r = await $.process.run(argv, { timeoutMs: 120_000 })
    if (r.exitCode === 0) return true
    await writeLog($, ctx.root, 'ERR', 'play', `再生失敗 ${fileName(wav)}: ${r.stderr.trim() || `exit ${r.exitCode}`}`)
    return false
  } catch (err) {
    await writeLog($, ctx.root, 'ERR', 'play', `再生失敗 ${fileName(wav)}: ${String(err)}`)
    return false
  } finally {
    release()
  }
}

// ================================================================ 読み上げの部品

async function silence($: EngineInterface, ctx: Ctx): Promise<string | null> {
  if ((await $.env.get('VOICE_NOTIFY_SUPPRESS')) === '1') return 'VOICE_NOTIFY_SUPPRESS'
  if (await isMuted($, ctx.root)) return '手動ミュート'
  if (ctx.os === 'windows' && ctx.cfg.mute?.whenMicInUse) {
    const r = await $.process.run([...MIC_QUERY])
    const app = r.exitCode === 0 ? micInUseFrom(r.stdout) : null
    if (app) return `マイク使用中 (${app})`
  }
  return null
}

// 鳴らすかどうかの前置き。黙るなら理由をログに残して null
async function begin($: EngineInterface, event: string): Promise<Ctx | null> {
  const ctx = await context($)
  if (!ctx) return null
  await writeLog($, ctx.root, 'INFO', event, '発火')
  const why = await silence($, ctx)
  if (!why) return ctx
  await writeLog($, ctx.root, 'INFO', event, `無音化: ${why}`)
  return null
}

// 定型フレーズ。names を順に試し、最初に見つかったフォルダから選ぶ
async function speakPhrase($: EngineInterface, ctx: Ctx, role: Role, names: readonly string[], event: string): Promise<boolean> {
  const voice = voiceFor(ctx.cfg, role)
  for (const name of names) {
    const wav = await pickPhrase($, ctx.root, voice.name, name)
    if (wav) return play($, ctx, wav)
  }
  await writeLog($, ctx.root, 'WARN', event, `定型フレーズが無い (${names.join(' / ')})。/voice-notify:setup を実行のこと`)
  return false
}

async function synthFor($: EngineInterface, ctx: Ctx, role: Role, text: string): Promise<Synth> {
  return synthesize($, synthParams(ctx.cfg, voiceFor(ctx.cfg, role), ctx.root, ctx.os), convertReading(text, ctx.cfg.speech ?? {}))
}

// 合成の失敗は、ENGINE の不通かそれ以外かを分けて残す
async function playSynth($: EngineInterface, ctx: Ctx, event: string, r: Synth): Promise<void> {
  if ('error' in r) {
    const port = enginePort(ctx.cfg)
    const alive = await engineVersion($, port)
    await writeLog($, ctx.root, 'ERR', event, alive ? `合成失敗: ${r.error}` : `VOICEVOX ENGINE に接続できない (port ${port})。定型フレーズのみ再生: ${r.error}`)
    return
  }
  await play($, ctx, r.path)
  // 件数が増えるのは新しく作ったときだけ
  if (!r.cached) await pruneCache($, ctx)
}

// 要約（Haiku）。使えなければ null。待つのは summaryTimeoutSec まで
async function summarize($: EngineInterface, ctx: Ctx, event: 'stop' | 'agentstop', role: Role, answer: string): Promise<string | null> {
  const sp = ctx.cfg.speech ?? {}
  const plan = planSummary(sp, event, role, answer)
  if (plan.skip !== null) return null
  const started = await $.clock.now()
  const limit = (sp.summaryTimeoutSec ?? 15) * 1000
  const r = await $.model.complete({
    model: sp.summaryModel || 'haiku',
    system: plan.system,
    prompt: answer,
    effort: 'low',
    maxTokens: 300,
    timeoutMs: limit,
  })
  const ms = (await $.clock.now()) - started
  if (!r.isAnswered) {
    const why = r.reason === 'aborted' ? `${limit / 1000}秒でタイムアウト` : r.reason
    await writeLog($, ctx.root, 'WARN', event, `要約失敗、1文目を読む: ${why}`)
    return null
  }
  const c = cleanSummary(r.text, plan.maxChars)
  if ('error' in c) {
    await writeLog($, ctx.root, 'WARN', event, `要約失敗、1文目を読む: ${c.error}`)
    return null
  }
  const text = clearSpeech(c.text)
  await writeLog($, ctx.root, 'INFO', event, `要約 ${(ms / 1000).toFixed(1)}秒: ${text}`)
  return text
}

// 要約（無ければ抜き出し）→ 合成。定型フレーズを鳴らしている間に進める
async function prepareBody($: EngineInterface, ctx: Ctx, role: Role, answer: string): Promise<{ text: string; r: Synth } | null> {
  const text = (await summarize($, ctx, 'stop', role, answer)) ?? pickFor(ctx.cfg, answer)
  if (!text) return null
  return { text, r: await synthFor($, ctx, role, text) }
}

async function runningAgents($: EngineInterface): Promise<number> {
  try {
    return (await $.agent.list()).filter(a => a.status === 'running' || a.status === 'pending').length
  } catch {
    return 0
  }
}

// ================================================================ イベントごとの流れ（例外は外に出さずログに残す）

async function onMainTurn($: EngineInterface, e: TurnCompleteInput): Promise<void> {
  const event = e.reason === 'error' ? 'failure' : 'stop'
  const ctx = await begin($, event)
  if (!ctx) return
  try {
    if (e.reason === 'error') {
      await speakPhrase($, ctx, 'final', ['failure'], event)
      return
    }
    const running = await runningAgents($)
    const alive = (await engineVersion($, enginePort(ctx.cfg))) !== null
    const plan = planStop({ cfg: ctx.cfg, answer: e.answer, durationMs: e.durationMs, running, engineAlive: alive })
    const kase = plan.pcase !== plan.case ? `${plan.case}→${plan.pcase}` : plan.case
    const role = plan.role === 'interim' ? `中間・実行中${running}件` : '最終'
    await writeLog($, ctx.root, 'INFO', event,
      `本文 ${e.answer.length}字 / 作業 ${(e.durationMs / 1000).toFixed(1)}秒 / ケース ${kase}${plan.brief ? ' (brief)' : ''} / ${role} [${voiceFor(ctx.cfg, plan.role).name}]`)
    if (!plan.read) {
      await speakPhrase($, ctx, plan.role, plan.phrases, event)
      return
    }
    const body = prepareBody($, ctx, plan.role, e.answer)
    await speakPhrase($, ctx, plan.role, plan.phrases, event)
    const b = await body
    if (!b) return
    await writeLog($, ctx.root, 'INFO', event, `読み上げ: ${b.text}`)
    await playSynth($, ctx, event, b.r)
  } catch (err) {
    await writeLog($, ctx.root, 'ERR', event, String(err))
  }
}

async function onAgentTurn($: EngineInterface, e: TurnCompleteInput): Promise<void> {
  const event = 'agentstop'
  if (e.reason !== 'answer') return
  const ctx = await context($)
  if (!ctx) return
  try {
    const agent = (await $.agent.list()).find(a => a.id === e.agentId)
    // /compact は開始の無い停止を出す。エンジンが知らない agent は本物のサブエージェントではない
    if (!agent) {
      await writeLog($, ctx.root, 'INFO', event, `開始を見ていない停止のため無視 (id=${e.agentId})`)
      return
    }
    await writeLog($, ctx.root, 'INFO', event, '発火')
    const why = await silence($, ctx)
    if (why) {
      await writeLog($, ctx.root, 'INFO', event, `無音化: ${why}`)
      return
    }
    const deb = (ctx.cfg.subagent?.debounceSeconds ?? 8) * 1000
    const since = await claimSpeech($, ctx.root, deb)
    if (since !== null) {
      await writeLog($, ctx.root, 'INFO', event, `連発抑制のため無音 (${(since / 1000).toFixed(1)}秒 < ${deb / 1000}秒)`)
      return
    }
    const report = (await summarize($, ctx, 'agentstop', 'interim', e.answer)) ?? agentReportFallback(pickFor(ctx.cfg, e.answer), ctx.cfg.speech ?? {})
    const text = agentText(agent.description || null, report)
    if (!text) {
      await writeLog($, ctx.root, 'WARN', event, '説明も報告も取れないので定型フレーズにフォールバック')
      await speakPhrase($, ctx, 'interim', ['agent/_default'], event)
      return
    }
    await writeLog($, ctx.root, 'INFO', event, `読み上げ [${voiceFor(ctx.cfg, 'interim').name}]: ${text}`)
    await playSynth($, ctx, event, await synthFor($, ctx, 'interim', text))
  } catch (err) {
    await writeLog($, ctx.root, 'ERR', event, String(err))
  }
}

// 連発抑制。直前の読み上げから deb ミリ秒たっていれば今の時刻を記録して null、たっていなければ経過ミリ秒。
// last_spoken はセッションをまたいで共有する（別のセッションの報告とも重ねない）
async function claimSpeech($: EngineInterface, root: string, deb: number): Promise<number | null> {
  const path = `${root}/state/last_spoken`
  const release = await debounceGate.enter()
  try {
    const now = await $.clock.now()
    let since: number | null = null
    try {
      since = Math.max(0, now - (await $.fs.stat(path)).mtimeMs)
    } catch {
      since = null
    }
    if (since !== null && since < deb) return since
    await $.fs.write(path, new Date(now).toISOString())
    return null
  } finally {
    release()
  }
}

async function onPermission($: EngineInterface, toolName: string): Promise<void> {
  const event = 'permission'
  const ctx = await begin($, event)
  if (!ctx) return
  try {
    const text = permissionText(ctx.cfg, toolName)
    const r = synthFor($, ctx, 'final', text)
    await speakPhrase($, ctx, 'final', ['permission'], event)
    await writeLog($, ctx.root, 'INFO', event, `読み上げ: ${text}`)
    await playSynth($, ctx, event, await r)
  } catch (err) {
    await writeLog($, ctx.root, 'ERR', event, String(err))
  }
}

async function onNotice($: EngineInterface, notificationType: string, mainBusy: boolean): Promise<void> {
  const kind = noticeKind(notificationType)
  if (!kind) return
  const ctx = await begin($, kind)
  if (!ctx) return
  try {
    if (kind === 'idle') {
      // idle_prompt はサブエージェントを見ていない。待っているのは利用者の入力ではない
      const running = await runningAgents($)
      if (running > 0) {
        await writeLog($, ctx.root, 'INFO', kind, `サブエージェント実行中 (${running}件) のため無音`)
        return
      }
      if (mainBusy) {
        await writeLog($, ctx.root, 'INFO', kind, 'メインが作業中のため無音')
        return
      }
    }
    await speakPhrase($, ctx, 'final', [kind], kind)
  } catch (err) {
    await writeLog($, ctx.root, 'ERR', kind, String(err))
  }
}

async function onTask($: EngineInterface): Promise<void> {
  const ctx = await begin($, 'task')
  if (ctx) await speakPhrase($, ctx, 'final', ['task'], 'task')
}
