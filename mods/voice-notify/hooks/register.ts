import type { EngineInterface, Register, TurnCompleteInput } from 'claude-code'

import { HEAD_CHARS, cleanSummary, decide, isRunningAgent, parseConfig, summaryFileName, voiceHome } from './decide'
import type { SpeechConfig, Summarize, SummaryRecord, VoiceConfig } from './decide'

// voice-notify の要約 mod。ターンの終わり（turn.complete）に応答本文を Haiku に要約させ、
// <root>/state/summaries/<session>[__<agent>].json に置く。読み上げは notify.ps1（Stop / SubagentStop hook）。
//
// - 要約は $.model.complete（履歴なし・ツールなしの単発呼び出し）なので、セッションの会話にもキャッシュにも入らない
// - 要約するときだけ書く。turn.complete は Stop hook より先に来る（2026-10-06 実測で 0.5〜1 秒）ので、
//   pending を書いてから next(e) を呼べば、notify は hook の時点で1回読むだけでよい
// - len / head（本文の文字数と先頭）で「どの応答の要約か」を示す。notify は自分の本文と突き合わせる
// - Haiku の応答は待たない（ターンの終了を遅らせない）。結果は同じファイルに上書きする。
//   締め切りは notify だけが持つ（遅れて書かれた要約は len / head が合わないので使われない）
// - $ は最上位の function にだけ渡す（mod のロード時検査の規則）

type Base = Pick<SummaryRecord, 'v' | 'turnId' | 'at' | 'kind' | 'len' | 'head'>

let warnedConfig = false

export const register: Register = on => {
  on('turn.complete', async ($, e, next) => {
    await begin($, e)
    return next(e)
  })
}

async function begin($: EngineInterface, e: TurnCompleteInput) {
  try {
    const root = voiceHome(await $.env.get('VOICE_NOTIFY_HOME'), await $.env.get('USERPROFILE'), await $.env.get('HOME'))
    if (!root) return
    const cfg = await loadConfig($, root)
    if (!cfg) return
    const speech = cfg.speech ?? {}
    const sessionId = await $.session.id()
    const path = `${root}/state/summaries/${summaryFileName(sessionId, e.agentId)}`
    const at = await $.clock.now()
    const d = decide({
      speech,
      muted: await $.fs.exists(`${root}/state/mute`),
      agentId: e.agentId,
      answer: e.answer,
      durationMs: e.durationMs,
      isAborted: e.isAborted,
      reason: e.reason,
      runningAgents: e.agentId ? 0 : await countRunningAgents($, root, sessionId, at),
    })
    if (d.skip !== null) return
    const base: Base = { v: 1, turnId: e.turnId, at, kind: d.kind, len: e.answer.length, head: e.answer.slice(0, HEAD_CHARS) }
    await save($, path, { ...base, status: 'pending' })
    void summarize($, path, base, d, speech, e.answer)
  } catch (err) {
    $.ui.log(`voice-notify: ${String(err)}`, { to: 'debug' })
  }
}

async function summarize($: EngineInterface, path: string, base: Base, d: Summarize, speech: SpeechConfig, answer: string) {
  try {
    const r = await $.model.complete({
      model: speech.summaryModel || 'haiku',
      system: d.system,
      prompt: answer,
      effort: 'low',
      maxTokens: 300,
    })
    const ms = (await $.clock.now()) - base.at
    if (!r.isAnswered) {
      const status = r.reason === 'api-error' && r.status != null ? ` ${r.status}` : ''
      await save($, path, { ...base, status: 'error', reason: `${r.reason}${status}`, ms })
      return
    }
    const c = cleanSummary(r.text, d.maxChars)
    if ('error' in c) await save($, path, { ...base, status: 'error', reason: c.error, ms })
    else await save($, path, { ...base, status: 'done', text: c.text, ms })
  } catch (err) {
    await fail($, path, { ...base, status: 'error', reason: String(err) })
  }
}

async function fail($: EngineInterface, path: string, rec: SummaryRecord) {
  try {
    await save($, path, rec)
  } catch (err) {
    $.ui.log(`voice-notify: ${String(err)}`, { to: 'debug' })
  }
}

async function save($: EngineInterface, path: string, rec: SummaryRecord) {
  await $.fs.write(path, JSON.stringify(rec))
}

async function loadConfig($: EngineInterface, root: string): Promise<VoiceConfig | null> {
  try {
    return parseConfig(await $.fs.read(`${root}/config.json`))
  } catch (err) {
    if (!warnedConfig) {
      warnedConfig = true
      $.ui.log(`voice-notify: ${root}/config.json を読めないので要約しない (${String(err)})`, { to: 'debug' })
    }
    return null
  }
}

// notify.ps1 の agentstart が state/agents/<agent_id> に session_id を書き、agentstop が消す
async function countRunningAgents($: EngineInterface, root: string, sessionId: string, now: number) {
  const dir = `${root}/state/agents`
  let entries
  try {
    entries = await $.fs.list(dir)
  } catch {
    return 0
  }
  let n = 0
  for (const f of entries) {
    if (f.kind !== 'file') continue
    try {
      if (isRunningAgent(await $.fs.read(`${dir}/${f.name}`), f.mtimeMs, now, sessionId)) n++
    } catch {
      // 読む間に agentstop が消した
    }
  }
  return n
}
