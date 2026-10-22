// What the mod remembers while a session runs, made afresh by each register()
// call (a reload starts it over), and what each event works with (Ctx).

import type { Config } from './config'
import { Gate } from './gate'
import type { Os } from './os'

export type Runtime = {
  // Turns at work (idle notices wait while any runs), and main-conversation
  // /compact runs in progress (their turn ends are not read).
  working: Set<string>
  compacting: number
  os: Os | null
  // The Linux player found; one not found is not remembered, so a player
  // installed later plays without reopening the session.
  linuxPlayer: string | null
  // Said once until it changes: a broken config.json, no player.
  warnedConfig: boolean
  warnedNoPlayer: boolean
  // This session is making the phrases.
  generating: boolean
  // notify.log can only be read and written back whole ($.fs cannot append):
  // lines that arrive together are written in one go.
  pendingLog: Array<{ root: string; line: string }>
  logGate: Gate
  // Clips play one at a time in a session (play.ps1 / play.sh keep sessions apart).
  playGate: Gate
  // Subagent reports arriving together pass the debounce's look-then-record
  // one at a time.
  debounceGate: Gate
}

export function createRuntime(): Runtime {
  return {
    working: new Set(),
    compacting: 0,
    os: null,
    linuxPlayer: null,
    warnedConfig: false,
    warnedNoPlayer: false,
    generating: false,
    pendingLog: [],
    logGate: new Gate(),
    playGate: new Gate(),
    debounceGate: new Gate(),
  }
}

// What an event that may speak works with: the home, its settings, the OS.
export type Ctx = { rt: Runtime; root: string; cfg: Config; os: Os }

// Enough to write to notify.log.
export type LogTo = Pick<Ctx, 'rt' | 'root'>
