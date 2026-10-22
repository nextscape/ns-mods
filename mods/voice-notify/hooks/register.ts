import type { Register } from 'claude-code'

import { runCommand } from './commands'
import { onAgentTurn, onMainTurn, onNotice, onPermission, onTask } from './events'
import { resumePhrases } from './generate'
import { background } from './io'
import { createRuntime } from './runtime'
import { COMMAND } from './setup'

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

  on('turn.start', async ($, e, next) => {
    rt.working.add(e.turnId)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    rt.working.delete(e.turnId)
    if (rt.compacting === 0 && !e.isAborted) {
      void background($, rt, e.agentId ? 'agentstop' : 'stop', e.agentId ? onAgentTurn($, rt, e) : onMainTurn($, rt, e))
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
