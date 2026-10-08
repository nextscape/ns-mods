import type { EngineInterface, Register, TurnCompleteInput } from 'claude-code'

import {
  agentReportFallback,
  agentText,
  choosePhrase,
  enginePort,
  mergeConfig,
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
import { Gate, capture } from './gate'
import { MIC_QUERY, micInUseFrom, osFrom, removeArgv } from './os'
import type { Os } from './os'
import { jobsStamp, phraseBusy, phraseJobs } from './phrases'
import type { PhraseState } from './phrases'
import { LINUX_PLAYERS, playArgv, probeArgv } from './player'
import { LAUNCHD_LABEL, SYSTEMD_UNIT, fillTemplate, fromScript, installScriptArgv, plistPath, systemdValue, unitPath, windowsInstallArgs, xml } from './autostart'
import { HINT, INSTALL_HINT, LEGACY_BIN, LEGACY_STATE_DIRS, doctorReport, ng, ok, parseCommand, step, unknownArg, voiceStatus, warn } from './setup'
import type { SetupAction, VoiceAction } from './setup'
import { appendLog, logLine, phraseMemo } from './store'
import type { Level } from './store'
import { cleanSummary, clearSpeech, convertReading } from './text'
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
let defaults: { text: string; cfg: VoiceConfig } | null = null
// このセッションがフレーズを生成している最中か
let generating = false

// notify.log は読んで書き直すしかない（$.fs に追記が無い）。同時に来た行はまとめて1回で書く
const pendingLog: Array<{ root: string; line: string }> = []
const logGate = new Gate()
// 同じセッションの再生は1つずつ（セッションをまたぐ排他は再生スクリプトの中で取る）
const playGate = new Gate()
// サブエージェントの報告が同時に来たとき、連発抑制の「見て、記録する」をすり抜けないよう1つずつ通す
const debounceGate = new Gate()

// 出来事を止めうる hook（gating）は、例外を出しても出来事をそのまま通す（.catch）
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({
      name: 'voice-notify',
      description: '音声通知のミュート切替（on / off / status）と、導入・診断・撤去（setup [force] / doctor / remove）',
      argumentHint: '[on|off|status|setup|doctor|remove]',
    })
    // 前回の生成が途中で終わっていたら続きを作る
    void background($, 'phrases', resumePhrases($))
    return r
  })

  on('command.run', { command: 'voice-notify' }, async ($, e) => ({ text: await runCommand($, e.args) }))

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
      void background($, e.agentId ? 'agentstop' : 'stop', e.agentId ? onAgentTurn($, e) : onMainTurn($, e))
    }
    return next(e)
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    void background($, 'permission', onPermission($, e.tool_name))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    void background($, 'notification', onNotice($, e.notification_type, working.size > 0))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.TaskCompleted', async ($, e, next) => {
    void background($, 'task', onTask($))
    return next(e)
  }).catch(($, e, next) => next(e))
}

// 裏で流す処理（hook は待たない）。失敗はホームの notify.log に ERR で残す。
// それもできない（モジュールが外れた後など）ときはデバッグログに、それもできなければあきらめる
async function background($: EngineInterface, event: string, work: Promise<unknown>): Promise<void> {
  try {
    await work
  } catch (err) {
    await logFailure($, event, err)
  }
}

async function logFailure($: EngineInterface, event: string, err: unknown): Promise<void> {
  try {
    const root = await homeRoot($)
    if (root) {
      await writeLog($, root, 'ERR', event, String(err))
      return
    }
  } catch {
    // ホームが分からない
  }
  try {
    $.ui.log(`voice-notify: ${event}: ${String(err)}`, { to: 'debug' })
  } catch {
    // 知らせる先が無い
  }
}

type RunInit = Parameters<EngineInterface['process']['run']>[1]
type RunResult = { exitCode: number; stdout: string; stderr: string }

// 外部コマンド。$.process.run はコマンドを起動できない（入っていない）と reject するので、
// 終了コードの失敗（-1）と同じに扱う。doctor が「見つからない」と言えるように、例外で止めない
async function run($: EngineInterface, argv: readonly string[], init?: RunInit): Promise<RunResult> {
  try {
    return await $.process.run(argv, init)
  } catch (err) {
    return { exitCode: -1, stdout: '', stderr: String(err) }
  }
}

// ================================================================ 前提（ホーム・設定・OS）

async function detectOs($: EngineInterface): Promise<Os> {
  if (knownOs) return knownOs
  const env = await $.env.get('OS')
  let uname = ''
  if (env !== 'Windows_NT') {
    try {
      uname = (await run($, ['uname', '-s'])).stdout
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

// 同梱の既定の設定。モジュールの中で1回だけ読む（プラグインの更新で読み込み直されるので、古くならない）
async function shippedDefaults($: EngineInterface): Promise<{ text: string; cfg: VoiceConfig }> {
  if (!defaults) {
    const text = await $.fs.read(`${$.plugin.root}/config.default.json`)
    defaults = { text, cfg: parseConfig(text) }
  }
  return defaults
}

// まず読む。無いときだけ同梱の既定をコピーする（あるのに読めないときは上書きしない）。
// 読めたら既定に重ねる（利用者の config.json に無いキーは既定値で動く）
async function loadConfig($: EngineInterface, root: string): Promise<{ cfg: VoiceConfig } | { error: string }> {
  const path = `${root}/config.json`
  try {
    const base = await shippedDefaults($)
    let text: string
    try {
      text = await $.fs.read(path)
    } catch (err) {
      if (await $.fs.exists(path)) return { error: String(err) }
      await $.fs.write(path, base.text)
      text = base.text
    }
    return { cfg: mergeConfig(base.cfg, parseConfig(text)) as VoiceConfig }
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

// 消せたか（消すものが無ければ true）
async function removeFiles($: EngineInterface, os: Os, paths: readonly string[]): Promise<boolean> {
  const cmd = removeArgv(os, $.plugin.root, paths)
  return !cmd || (await run($, cmd.argv, cmd.stdin ? { stdin: cmd.stdin } : undefined)).exitCode === 0
}

// 書けなくても例外は出さない（ログのために読み上げを止めない）
async function writeLog($: EngineInterface, root: string, level: Level, event: string, msg: string): Promise<void> {
  try {
    pendingLog.push({ root, line: logLine(new Date(await $.clock.now()), level, event, msg) })
  } catch {
    return
  }
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
    try {
      $.ui.log(`voice-notify: notify.log に書けない (${String(err)})`, { to: 'debug' })
    } catch {
      // モジュールが外れた後は、知らせる先も無い
    }
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
  // 書き込み先のフォルダを先に作る（$.fs.write は途中のフォルダも作る）
  const dir = path.slice(0, path.lastIndexOf('/'))
  if (!(await $.fs.exists(dir))) await $.fs.write(`${dir}/.keep`, '')
  const r = await run($, synthArgv(p, path), { stdin: JSON.stringify(tuneQuery(query, p)), timeoutMs: 130_000 })
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

// 見つかったものだけを覚える。「無い」は覚えない（あとから入れたら、セッションを開き直さずに鳴る。
// 探し直しが走るのは鳴らせない環境だけなので、無駄は小さい）
async function findLinuxPlayer($: EngineInterface): Promise<string | null> {
  if (linuxPlayer) return linuxPlayer
  for (const name of LINUX_PLAYERS) {
    const r = await run($, probeArgv(name))
    if (r.exitCode === 0 && r.stdout.trim()) return (linuxPlayer = name)
  }
  return null
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
    const r = await run($, argv, { timeoutMs: 120_000 })
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
    const r = await run($, [...MIC_QUERY])
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
  await writeLog($, ctx.root, 'WARN', event, `定型フレーズが無い (${names.join(' / ')})。${HINT.setup} を実行のこと`)
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

// ================================================================ イベントごとの流れ（失敗は background がログに残す）

async function onMainTurn($: EngineInterface, e: TurnCompleteInput): Promise<void> {
  // API エラーで終わったターンと、応答を拒否されたターンは、どちらも「うまくいかなかった」と知らせる
  const failed = e.reason === 'error' || e.reason === 'refusal'
  const event = failed ? 'failure' : 'stop'
  const ctx = await begin($, event)
  if (!ctx) return
  if (failed) {
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
  // 要約と合成は、定型フレーズを鳴らしている間に進める。始めた時点で結果を受け止めておく
  const body = capture(prepareBody($, ctx, plan.role, e.answer))
  await speakPhrase($, ctx, plan.role, plan.phrases, event)
  const b = await body
  if (!b.ok) throw b.error
  if (!b.value) return
  await writeLog($, ctx.root, 'INFO', event, `読み上げ: ${b.value.text}`)
  await playSynth($, ctx, event, b.value.r)
}

async function onAgentTurn($: EngineInterface, e: TurnCompleteInput): Promise<void> {
  const event = 'agentstop'
  if (e.reason !== 'answer') return
  const ctx = await context($)
  if (!ctx) return
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
  // ENGINE が応答しなければ合成できない。要約（Haiku）は呼ばず、作ってある代わりのフレーズで知らせる
  if (!(await engineVersion($, enginePort(ctx.cfg)))) {
    await writeLog($, ctx.root, 'WARN', event, `VOICEVOX ENGINE に接続できない (port ${enginePort(ctx.cfg)})。定型フレーズのみ再生`)
    await speakPhrase($, ctx, 'interim', ['agent/_default'], event)
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
  const text = permissionText(ctx.cfg, toolName)
  // 合成は定型フレーズと並行して進める。始めた時点で結果を受け止めておく
  const r = capture(synthFor($, ctx, 'final', text))
  await speakPhrase($, ctx, 'final', ['permission'], event)
  const s = await r
  if (!s.ok) throw s.error
  await writeLog($, ctx.root, 'INFO', event, `読み上げ: ${text}`)
  await playSynth($, ctx, event, s.value)
}

async function onNotice($: EngineInterface, notificationType: string, mainBusy: boolean): Promise<void> {
  const kind = noticeKind(notificationType)
  if (!kind) return
  const ctx = await begin($, kind)
  if (!ctx) return
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
}

async function onTask($: EngineInterface): Promise<void> {
  const ctx = await begin($, 'task')
  if (ctx) await speakPhrase($, ctx, 'final', ['task'], 'task')
}

// ================================================================ ENGINE の場所と起動（setup）

// enginePath → 決まった場所 → 応答だけある（Docker や手で起動した ENGINE）の順
async function findEngine($: EngineInterface, cfg: VoiceConfig, os: Os): Promise<FoundEngine | null> {
  const running = (await engineVersion($, enginePort(cfg))) !== null
  if (cfg.enginePath) {
    const path = cfg.enginePath.replace(/\\/g, '/')
    if (await $.fs.exists(path)) return { path, running }
  }
  const local = await $.env.get('LOCALAPPDATA')
  let winget: string[] = []
  if (os === 'windows' && local) {
    try {
      winget = (await $.fs.list(`${local.replace(/\\/g, '/')}/Microsoft/WinGet/Packages`))
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

// Windows の start-engine.ps1 は起動を待って終了コードで答える。それ以外は切り離して起動し、ここで応答を待つ
async function startEngine($: EngineInterface, cfg: VoiceConfig, os: Os, exe: string): Promise<boolean> {
  const r = await run($, startArgv(os, $.plugin.root, exe), { timeoutMs: 90_000 })
  if (os === 'windows') return r.exitCode === 0
  // 初回はモデル読み込みで十数秒かかる
  for (let i = 0; i < 60; i++) {
    if (await engineVersion($, enginePort(cfg))) return true
    await $.clock.sleep(1000)
  }
  return false
}

// ================================================================ 定型フレーズの生成

async function readProgress($: EngineInterface, root: string): Promise<{ done: number; total: number; at: number } | null> {
  const path = `${root}/state/phrases-progress`
  try {
    const p = JSON.parse(await $.fs.read(path)) as { done: number; total: number }
    return { done: p.done, total: p.total, at: (await $.fs.stat(path)).mtimeMs }
  } catch {
    return null
  }
}

async function phraseState($: EngineInterface, ctx: Ctx): Promise<PhraseState> {
  const jobs = phraseJobs(ctx.cfg, ctx.root)
  let missing = 0
  for (const j of jobs) if (!(await $.fs.exists(j.path))) missing++
  let current = false
  try {
    current = (await $.fs.read(`${ctx.root}/state/phrases-stamp`)).trim() === jobsStamp(jobs, ctx.cfg)
  } catch {
    current = false
  }
  const p = await readProgress($, ctx.root)
  const busy = generating || phraseBusy(p, await $.clock.now())
  return { total: jobs.length, missing, current, busy, progress: p && p.done < p.total ? { done: p.done, total: p.total } : null }
}

// force の前に消すもの：job のフォルダにある wav すべて。文言を減らしたあとの古い NN.wav が残ると、
// 再生はフォルダの wav をすべて候補にするので、消したはずの文言が鳴り続ける
async function phraseFolderWavs($: EngineInterface, jobs: readonly { path: string }[]): Promise<string[]> {
  const out: string[] = []
  for (const dir of new Set(jobs.map(j => j.path.slice(0, j.path.lastIndexOf('/'))))) {
    try {
      for (const f of await $.fs.list(dir)) if (f.kind === 'file' && f.name.endsWith('.wav')) out.push(`${dir}/${f.name}`)
    } catch {
      // まだ無い
    }
  }
  return out
}

// 足りないもの（force ならすべて）を作る。作り終えたら、どの設定で作ったか（stamp）を残す
async function generatePhrases($: EngineInterface, ctx: Ctx, force: boolean): Promise<void> {
  if (generating) return
  generating = true
  try {
    const jobs = phraseJobs(ctx.cfg, ctx.root)
    const stamp = `${ctx.root}/state/phrases-stamp`
    if (force) await removeFiles($, ctx.os, [...(await phraseFolderWavs($, jobs)), stamp])
    const speakers = ctx.cfg.speakers ?? {}
    let made = 0
    let kept = 0
    let failed = 0
    for (const [i, job] of jobs.entries()) {
      if (!force && (await $.fs.exists(job.path))) kept++
      else {
        const voice = { name: job.speaker, id: speakers[job.speaker]?.id ?? voiceFor(ctx.cfg, 'final').id }
        const r = await synthesize($, synthParams(ctx.cfg, voice, ctx.root, ctx.os), convertReading(job.text, ctx.cfg.speech ?? {}), job.path)
        if ('error' in r) failed++
        else made++
      }
      await $.fs.write(`${ctx.root}/state/phrases-progress`, JSON.stringify({ done: i + 1, total: jobs.length }))
    }
    if (failed === 0) await $.fs.write(stamp, jobsStamp(jobs, ctx.cfg))
    await writeLog($, ctx.root, failed ? 'WARN' : 'INFO', 'phrases', `生成 ${made} 件 / 既存流用 ${kept} 件 / 失敗 ${failed} 件`)
  } finally {
    generating = false
  }
}

// session.start から。足りず、ほかのセッションが作っておらず、ENGINE が応答するときだけ続きを作る。
// 中身が古いだけ（設定を変えた）のときは作り直さない（doctor が force を案内する）
async function resumePhrases($: EngineInterface): Promise<void> {
  const ctx = await context($)
  if (!ctx) return
  const st = await phraseState($, ctx)
  if (st.missing === 0 || st.busy) return
  if (!(await engineVersion($, enginePort(ctx.cfg)))) return
  await generatePhrases($, ctx, false)
}

// ================================================================ コマンド

async function legacyFiles($: EngineInterface, root: string): Promise<string[]> {
  const out: string[] = []
  for (const d of LEGACY_STATE_DIRS) {
    try {
      for (const f of await $.fs.list(`${root}/state/${d}`)) if (f.kind === 'file') out.push(`${root}/state/${d}/${f.name}`)
    } catch {
      // 無い
    }
  }
  for (const f of LEGACY_BIN) if (await $.fs.exists(`${root}/bin/${f}`)) out.push(`${root}/bin/${f}`)
  return out
}

async function runCommand($: EngineInterface, args: string): Promise<string> {
  const cmd = parseCommand(args)
  if (!cmd) return unknownArg(args)
  return cmd.kind === 'voice' ? runVoice($, cmd.action) : runSetup($, cmd.action)
}

async function runVoice($: EngineInterface, action: VoiceAction): Promise<string> {
  const ctx = await context($)
  if (!ctx) return `config.json を読めません。${HINT.doctor} で確かめてください。`
  const muted = await isMuted($, ctx.root)
  if (action === 'status') return voiceStatus(ctx.cfg, ctx.os, muted)
  const mute = action === 'toggle' ? !muted : action === 'mute'
  if (mute) {
    await speakPhrase($, ctx, 'final', ['mute'], 'voice') // 止める前に知らせる
    await $.fs.write(`${ctx.root}/state/mute`, new Date(await $.clock.now()).toISOString())
  } else {
    await removeFiles($, ctx.os, [`${ctx.root}/state/mute`])
    await speakPhrase($, ctx, 'final', ['unmute'], 'voice')
  }
  await writeLog($, ctx.root, 'INFO', 'voice', '手動ミュートを切り替え')
  return mute ? '音声通知: 停止しました' : '音声通知: 再開しました'
}

async function runSetup($: EngineInterface, action: SetupAction): Promise<string> {
  const root = await homeRoot($)
  if (!root) return ng('ホームが決まりません（USERPROFILE も HOME もありません）')
  // 撤去は config.json が壊れていてもできるようにする
  if (action === 'remove') return (await removeAutostartAndHotkey($, root, await detectOs($))).join('\n')
  const ctx = await context($)
  if (!ctx) return [step('設定（config.json）'), ng(`config.json を読めません（JSON の書き間違い）。直してから、もう一度実行してください: ${root}/config.json`)].join('\n')
  return (action === 'doctor' ? await doctor($, ctx) : await install($, ctx, action === 'force')).join('\n')
}

async function install($: EngineInterface, ctx: Ctx, force: boolean): Promise<string[]> {
  const port = enginePort(ctx.cfg)
  const out = ['voice-notify を導入します', `ホーム: ${ctx.root}`, step('1. ホーム'), ok(`config.json: ${ctx.root}/config.json`)]
  const legacy = await legacyFiles($, ctx.root)
  if (legacy.length) {
    out.push((await removeFiles($, ctx.os, legacy)) ? ok(`0.2.0 の残りを消しました（${legacy.length} 件）`) : warn(`0.2.0 の残りを消せないものがありました（${legacy.length} 件のうち）。${ctx.root}/state と bin を確かめてください`))
  }
  out.push(step('2. VOICEVOX'))
  const engine = await findEngine($, ctx.cfg, ctx.os)
  if (!engine) {
    out.push(ng(`VOICEVOX が見つかりません。次の方法で導入してから、もう一度 ${HINT.setup} を実行してください。`), `   ${INSTALL_HINT[ctx.os]}`)
    if (ctx.os !== 'linux') out.push('   別の場所に入れた場合は、config.json の enginePath に ENGINE（vv-engine の run）の絶対パスを書いてください。')
    return out
  }
  out.push(ok(engine.path ?? `場所は不明（port ${port} で応答あり）`))
  out.push(step('3. ENGINE の起動'))
  if (engine.running) out.push(ok(`すでに起動済み (port ${port})`))
  else if (engine.path && (await startEngine($, ctx.cfg, ctx.os, engine.path))) out.push(ok('起動しました'))
  else {
    out.push(ng('ENGINE が起動しませんでした（60秒待っても応答なし）'))
    return out
  }
  out.push(step('4. 定型フレーズ'))
  const st = await phraseState($, ctx)
  if (!force && st.current && st.missing === 0) out.push(ok(`生成済み（作り直すときは ${HINT.force}）`))
  else if (st.busy) out.push(ok(`別のセッションが生成中です（${st.progress?.done ?? 0}/${st.total}）`))
  else {
    void background($, 'phrases', generatePhrases($, ctx, force))
    out.push(ok(`裏で生成を始めました（初回は数分）。進み具合は ${HINT.doctor} の「定型フレーズ」で確認できます`))
  }
  out.push(...(await installAutostartAndHotkey($, ctx, engine)))
  out.push('', '導入しました。音声通知は、このセッションからすぐ有効です。', `  診断: ${HINT.doctor}`, `  撤去: ${HINT.remove}`)
  return out
}

// 報告だけ。何も変えない
async function doctor($: EngineInterface, ctx: Ctx): Promise<string[]> {
  const port = enginePort(ctx.cfg)
  const curl = await run($, [ctx.os === 'windows' ? 'curl.exe' : 'curl', '--version'])
  let errors: string[] = []
  try {
    errors = (await $.fs.read(`${ctx.root}/notify.log`)).trimEnd().split('\n').slice(-200).filter(l => / ERR {2}/.test(l))
  } catch {
    errors = []
  }
  return doctorReport({
    pluginRoot: $.plugin.root,
    root: ctx.root,
    os: ctx.os,
    player: ctx.os === 'linux' ? await findLinuxPlayer($) : null,
    curl: curl.exitCode === 0 ? (curl.stdout.split('\n')[0] ?? '').trim() : null,
    engine: await findEngine($, ctx.cfg, ctx.os),
    port,
    version: await engineVersion($, port),
    phrases: await phraseState($, ctx),
    autostart: await autostartStatus($, ctx),
    muted: await isMuted($, ctx.root),
    legacy: (await legacyFiles($, ctx.root)).length,
    errors,
  })
}

// ================================================================ ログオン時の ENGINE 起動とホットキー

// Windows のタスクとホットキーは install.ps1 が扱う（ScheduledTask・WScript.Shell は PowerShell からしか触れない）
async function installScript($: EngineInterface, args: readonly string[]): Promise<string[]> {
  const r = await run($, installScriptArgv($.plugin.root, args), { timeoutMs: 60_000 })
  return r.exitCode === 0 ? fromScript(r.stdout) : [ng(`install.ps1 が失敗: ${r.stderr.trim() || r.exitCode}`)]
}

async function homeDir($: EngineInterface): Promise<string> {
  return ((await $.env.get('HOME')) ?? '').replace(/\/+$/, '')
}

async function guiDomain($: EngineInterface): Promise<string> {
  return `gui/${(await run($, ['id', '-u'])).stdout.trim()}`
}

async function installAutostartAndHotkey($: EngineInterface, ctx: Ctx, engine: FoundEngine): Promise<string[]> {
  const out = [step('5. ログオン時の ENGINE 起動とホットキー')]
  if (ctx.os === 'windows') return [...out, ...(await installScript($, windowsInstallArgs(ctx.root, ctx.cfg.hotKey ?? 'CTRL+ALT+M', engine.path)))]
  if (!engine.path) return [...out, ok('外部の ENGINE（Docker など）を使うので、ログオン時の起動は登録しません')]
  const home = await homeDir($)
  const values = { LABEL: LAUNCHD_LABEL, RUN: engine.path, DIR: engine.path.slice(0, engine.path.lastIndexOf('/')) }
  if (ctx.os === 'macos') {
    const plist = plistPath(home)
    await $.fs.write(plist, fillTemplate(await $.fs.read(`${$.plugin.root}/scripts/macos/voice-notify-engine.plist`), values, xml))
    const domain = await guiDomain($)
    await run($, ['launchctl', 'bootout', `${domain}/${LAUNCHD_LABEL}`]) // 前の登録が無ければ失敗するが、構わない
    const r = await run($, ['launchctl', 'bootstrap', domain, plist])
    out.push(r.exitCode === 0 ? ok(`launchd: ${plist}`) : ng(`launchctl bootstrap が失敗: ${r.stderr.trim()}`))
  } else {
    const unit = unitPath(home)
    await $.fs.write(unit, fillTemplate(await $.fs.read(`${$.plugin.root}/scripts/linux/voice-notify-engine.service`), values, systemdValue))
    await run($, ['systemctl', '--user', 'daemon-reload'])
    const r = await run($, ['systemctl', '--user', 'enable', '--now', SYSTEMD_UNIT])
    out.push(r.exitCode === 0 ? ok(`systemd: ${unit}`) : ng(`systemctl --user enable が失敗: ${r.stderr.trim()}`))
  }
  out.push(ok(`ホットキーは Windows だけです。ミュートは ${HINT.voice} を使ってください`))
  return out
}

async function removeAutostartAndHotkey($: EngineInterface, root: string, os: Os): Promise<string[]> {
  const out = ['voice-notify を撤去します（ホームは残します）']
  if (os === 'windows') return [...out, ...(await installScript($, ['-Action', 'remove', '-VHome', root.replace(/\//g, '\\')]))]
  const home = await homeDir($)
  if (os === 'macos') {
    await run($, ['launchctl', 'bootout', `${await guiDomain($)}/${LAUNCHD_LABEL}`])
    await removeFiles($, os, [plistPath(home)])
    out.push(ok('launchd の登録を外しました'))
  } else {
    await run($, ['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT])
    await removeFiles($, os, [unitPath(home)])
    await run($, ['systemctl', '--user', 'daemon-reload'])
    out.push(ok('systemd の登録を外しました'))
  }
  return out
}

async function autostartStatus($: EngineInterface, ctx: Ctx): Promise<string[]> {
  const out = [step('常駐まわり')]
  if (ctx.os === 'windows') return [...out, ...(await installScript($, ['-Action', 'status', '-VHome', ctx.root.replace(/\//g, '\\')]))]
  const home = await homeDir($)
  if (ctx.os === 'macos') {
    const plist = plistPath(home)
    out.push((await $.fs.exists(plist)) ? ok(`ログオン時起動（launchd）: ${plist}`) : warn('ログオン時起動（launchd）なし'))
  } else {
    const r = await run($, ['systemctl', '--user', 'is-enabled', SYSTEMD_UNIT])
    out.push(r.exitCode === 0 ? ok(`ログオン時起動（systemd）: ${r.stdout.trim()}`) : warn('ログオン時起動（systemd）なし'))
  }
  return out
}
