// What each event says. Each runs in the background; a failure is logged by
// io.ts's background().

import type { EngineInterface, TurnCompleteInput } from 'claude-code'

import { agentReportFallback, agentText, noticeKind, permissionText, pickFor, planStop, voiceFor } from './decide'
import { engineVersion, synthFor } from './engine'
import { capture } from './gate'
import { context, writeLog } from './io'
import type { Runtime } from './runtime'
import { begin, claimSpeech, playSynth, prepareBody, quiet, runningAgents, speakPhrase, summarize } from './speak'

// The main conversation's turn ended.
export async function onMainTurn($: EngineInterface, rt: Runtime, e: TurnCompleteInput): Promise<void> {
  // A turn that ended in an API error or a refusal says it did not go well.
  const failed = e.reason === 'error' || e.reason === 'refusal'
  const event = failed ? 'failure' : 'stop'
  const ctx = await begin($, rt, event)
  if (!ctx) return
  if (failed) {
    await speakPhrase($, ctx, 'final', ['failure'], event)
    return
  }
  const running = await runningAgents($)
  const alive = (await engineVersion($, ctx.cfg.enginePort)) !== null
  const plan = planStop({ cfg: ctx.cfg, answer: e.answer, durationMs: e.durationMs, running, engineAlive: alive })
  const kase = plan.pcase !== plan.case ? `${plan.case}→${plan.pcase}` : plan.case
  const role = plan.role === 'interim' ? `中間・実行中${running}件` : '最終'
  await writeLog($, ctx, 'INFO', event,
    `本文 ${e.answer.length}字 / 作業 ${(e.durationMs / 1000).toFixed(1)}秒 / ケース ${kase}${plan.brief ? ' (brief)' : ''} / ${role} [${voiceFor(ctx.cfg, plan.role).name}]`)
  if (!plan.read) {
    await speakPhrase($, ctx, plan.role, plan.phrases, event)
    return
  }
  // The summary and its synthesis run while the phrase plays; their outcome
  // is held from the start (see capture).
  const body = capture(prepareBody($, ctx, plan.role, e.answer))
  await speakPhrase($, ctx, plan.role, plan.phrases, event)
  const b = await body
  if (!b.ok) throw b.error
  if (!b.value) return
  await writeLog($, ctx, 'INFO', event, `読み上げ: ${b.value.text}`)
  await playSynth($, ctx, event, b.value.r)
}

// A subagent's turn ended: "<description>が完了しました。<report>" in the
// interim voice.
export async function onAgentTurn($: EngineInterface, rt: Runtime, e: TurnCompleteInput): Promise<void> {
  const event = 'agentstop'
  if (e.reason !== 'answer') return
  const ctx = await context($, rt)
  if (!ctx) return
  const agent = (await $.agent.list()).find(a => a.id === e.agentId)
  // /compact ends a turn that never started; an agent the engine does not
  // know is no real subagent.
  if (!agent) {
    await writeLog($, ctx, 'INFO', event, `開始を見ていない停止のため無視 (id=${e.agentId})`)
    return
  }
  await writeLog($, ctx, 'INFO', event, '発火')
  if (await quiet($, ctx, event)) return
  const deb = ctx.cfg.subagent.debounceSeconds * 1000
  const since = await claimSpeech($, ctx, deb)
  if (since !== null) {
    await writeLog($, ctx, 'INFO', event, `連発抑制のため無音 (${(since / 1000).toFixed(1)}秒 < ${deb / 1000}秒)`)
    return
  }
  // With no engine there is nothing to synthesize: no Haiku call, just the
  // phrase made beforehand.
  if (!(await engineVersion($, ctx.cfg.enginePort))) {
    await writeLog($, ctx, 'WARN', event, `VOICEVOX ENGINE に接続できない (port ${ctx.cfg.enginePort})。定型フレーズのみ再生`)
    await speakPhrase($, ctx, 'interim', ['agent/_default'], event)
    return
  }
  const report = (await summarize($, ctx, 'agentstop', 'interim', e.answer)) ?? agentReportFallback(pickFor(ctx.cfg, e.answer), ctx.cfg.speech)
  const text = agentText(agent.description || null, report)
  if (!text) {
    await writeLog($, ctx, 'WARN', event, '説明も報告も取れないので定型フレーズにフォールバック')
    await speakPhrase($, ctx, 'interim', ['agent/_default'], event)
    return
  }
  await writeLog($, ctx, 'INFO', event, `読み上げ [${voiceFor(ctx.cfg, 'interim').name}]: ${text}`)
  await playSynth($, ctx, event, await synthFor($, ctx, 'interim', text))
}

// A tool waits for the person's permission: "<tool>の許可待ちです。"
export async function onPermission($: EngineInterface, rt: Runtime, toolName: string): Promise<void> {
  const event = 'permission'
  const ctx = await begin($, rt, event)
  if (!ctx) return
  const text = permissionText(ctx.cfg, toolName)
  // Synthesized while the phrase plays, its outcome held from the start.
  const r = capture(synthFor($, ctx, 'final', text))
  await speakPhrase($, ctx, 'final', ['permission'], event)
  const s = await r
  if (!s.ok) throw s.error
  await writeLog($, ctx, 'INFO', event, `読み上げ: ${text}`)
  await playSynth($, ctx, event, s.value)
}

// `mainBusy`: a turn was at work when the notice came.
export async function onNotice($: EngineInterface, rt: Runtime, notificationType: string, mainBusy: boolean): Promise<void> {
  const kind = noticeKind(notificationType)
  if (!kind) return
  const ctx = await begin($, rt, kind)
  if (!ctx) return
  if (kind === 'idle') {
    // idle_prompt does not look at subagents: what waits is not the person.
    const running = await runningAgents($)
    if (running > 0) {
      await writeLog($, ctx, 'INFO', kind, `サブエージェント実行中 (${running}件) のため無音`)
      return
    }
    if (mainBusy) {
      await writeLog($, ctx, 'INFO', kind, 'メインが作業中のため無音')
      return
    }
  }
  await speakPhrase($, ctx, 'final', [kind], kind)
}

// A task was completed. That includes a task-list item marked done (the
// hooks reference), many times in one turn: while a turn works, the turn's
// own end speaks instead.
export async function onTask($: EngineInterface, rt: Runtime, mainBusy: boolean): Promise<void> {
  const ctx = await begin($, rt, 'task')
  if (!ctx) return
  if (mainBusy) {
    await writeLog($, ctx, 'INFO', 'task', 'メインが作業中のため無音')
    return
  }
  await speakPhrase($, ctx, 'final', ['task'], 'task')
}
