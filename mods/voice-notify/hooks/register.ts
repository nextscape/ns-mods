import type { Register } from 'claude-code'

import { runCommand } from './commands'
import { onAgentTurn, onMainTurn, onNotice, onPermission, onTask } from './events'
import { resumePhrases } from './generate'
import { background } from './io'
import { inFlight, isOwnTurn, originOf, trackFlight } from './decide'
import { createRuntime, mainTurn } from './runtime'
import { COMMAND } from './setup'

// Prompts kept for the next turn to find its own among (originOf).
const SUBMITTED = 10

// voice-notify: says what happens in Claude Code in a VOICEVOX voice.
//
// - Every hook returns next(e) at once and speaks in the background, so no
//   turn waits for it.
// - What is said comes from pure functions (config, decide, text, phrases,
//   voicevox, os, player, setup, autostart, store), unit-tested directly; the
//   I/O sits in io, engine, speak, events, generate and commands.
// - What happened, and why it stayed silent, goes to <home>/notify.log
//   (the format 0.2.0 wrote).
//
// A hook that could stop an event (gating) lets the event through when it
// throws (.catch).
export const register: Register = on => {
  const rt = createRuntime()

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({
      name: COMMAND,
      description: '音声通知のミュート切替（on / off / status）と、導入・診断・撤去（setup [force] / doctor / remove）',
      argumentHint: '[on|off|status|setup|doctor|remove]',
      // An `off` typed while a turn works takes effect before the turn's end
      // is read.
      immediate: true,
    })
    // Finishes phrases a previous run left half made.
    void background($, rt, 'phrases', resumePhrases($, rt))
    return r
  })

  on('command.run', { command: COMMAND }, async ($, e) => ({ text: await runCommand($, rt, e.args) }))

  on('session.compact', async ($, e, next) => {
    // A precompute does not change the conversation, and a subagent's compact
    // is not the main conversation's turn: neither counts.
    const counts = e.trigger !== 'precompute' && e.agentId === undefined
    if (counts) rt.compacting++
    try {
      return await next(e)
    } finally {
      if (counts) rt.compacting--
    }
  }).catch(($, e, next) => next(e))

  // Where each prompt came from, for the turn it starts (originOf). Noted
  // before `next`: a prompt submitted while idle starts its turn within it.
  on('prompt.submit', async ($, e, next) => {
    rt.submitted = [...rt.submitted, { text: e.text, origin: e.origin }].slice(-SUBMITTED)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    rt.working.add(e.turnId)
    // A subagent's run starts here too, naming its agentId (which older
    // engines' types leave out): the main turn it runs inside keeps its record.
    if ((e as { agentId?: string }).agentId !== undefined) return next(e)
    // A Stop may come after its turn's end, so a turn is let go at the next
    // one's start.
    rt.turns.clear()
    rt.turns.set(e.turnId, mainTurn(isOwnTurn(e.text, originOf(e.text, rt.submitted)), rt.flight))
    // This turn's prompt was among those submitted; the rest were delivered
    // into the turn before. A continuation ("") starts with none of them.
    if (e.text !== '') rt.submitted = []
    rt.current = e.turnId
    return next(e)
  })

  // A short reply that called no tool stays silent (decide.ts planStop).
  on('tool.call', async ($, e, next) => {
    const turn = e.agentId === undefined && rt.current ? rt.turns.get(rt.current) : undefined
    if (turn) turn.tools++
    return next(e)
  }).catch(($, e, next) => next(e))

  // What is still in flight when the main turn stops: a turn that only waits
  // on it is not done. Read against the flight when the turn began, so a
  // second Stop of the same turn (a Stop hook sent it on) reads the same.
  on('classic.Stop', async ($, e, next) => {
    const turn = e.agent_id === undefined && rt.current ? rt.turns.get(rt.current) : undefined
    if (turn) {
      const now = trackFlight(turn.before, inFlight(e.background_tasks, e.session_crons), turn.own)
      rt.flight = now.flight
      turn.pending = now.pending
      turn.ended = now.ended
      turn.stop()
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    rt.working.delete(e.turnId)
    const turn = e.agentId ? null : (rt.turns.get(e.turnId) ?? null)
    if (rt.compacting === 0 && !e.isAborted) {
      void background($, rt, e.agentId ? 'agentstop' : 'stop', e.agentId ? onAgentTurn($, rt, e) : onMainTurn($, rt, e, turn))
    }
    return next(e)
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    void background($, rt, 'permission', onPermission($, rt, e.tool_name))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    void background($, rt, 'notification', onNotice($, rt, e.notification_type, rt.working.size > 0))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.TaskCompleted', async ($, e, next) => {
    void background($, rt, 'task', onTask($, rt, rt.working.size > 0))
    return next(e)
  }).catch(($, e, next) => next(e))
}
